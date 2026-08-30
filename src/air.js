/**
 * Air movement: the room's own draft, the phone's motion, and you blowing
 * on the microphone.
 *
 * Blowing a candle out is not about "enough wind". A flame is a balance
 * between the rate at which the chemistry can release heat and the rate at
 * which the flow carries that heat away - the ratio of the two is the
 * Damkohler number. Stretch the flame past a critical strain rate, roughly
 * 150-200 per second for a hydrocarbon diffusion flame, and the reaction
 * cannot keep up with its own losses, so it detaches from the wick and dies.
 * That is why a sharp puff works and steady breathing does not.
 */

import {
  DRAFT_SIGMA, DRAFT_TAU, BLOW_VELOCITY_MAX, EXTINCTION_STRAIN, FLAME_DIAMETER,
} from './constants.js';

export class AirModel {
  constructor() {
    this.draftX = 0;
    this.draftY = 0;
    this.tiltX = 0;
    this.blow = 0;          // 0..1, current blow strength from the mic
    this.strain = 0;        // 1/s, strain rate experienced by the flame
    this.extinguishFor = 0; // s, how long we have been past the critical strain
    this.micReady = false;
    this.micError = null;
    this.micAttempts = 0;
    this.enabled = true;
  }

  /**
   * The ambient draft is modelled as an Ornstein-Uhlenbeck process: a random
   * walk that is pulled back towards zero. That gives air motion which
   * wanders on a realistic timescale instead of jittering every frame, and it
   * is what makes an untouched flame lean and recover on its own.
   */
  update(dt) {
    // Guard the timestep: exp() of a positive exponent gives a > 1, and the
    // sqrt below would then take the root of a negative number.
    if (!(dt > 0)) return;
    const a = Math.exp(-dt / DRAFT_TAU);
    const noise = Math.sqrt(1 - a * a) * DRAFT_SIGMA;
    this.draftX = this.draftX * a + (Math.random() * 2 - 1) * noise * 1.7;
    this.draftY = this.draftY * a + (Math.random() * 2 - 1) * noise * 0.6;

    if (this.analyser) this.sampleMic();
    else this.blow *= Math.exp(-dt / 0.25);

    const u = Math.abs(this.windX()) ;
    // Strain rate seen by the flame is the velocity difference across it.
    this.strain = u / (FLAME_DIAMETER * 0.5);
    if (this.strain > EXTINCTION_STRAIN) this.extinguishFor += dt;
    else this.extinguishFor = Math.max(0, this.extinguishFor - dt * 2.5);
  }

  windX() {
    return this.draftX + this.tiltX + this.blow * BLOW_VELOCITY_MAX;
  }

  windY() {
    return this.draftY;
  }

  /** True once the flame has been over-strained long enough to detach. */
  shouldExtinguish() {
    return this.extinguishFor > 0.045;
  }

  /**
   * Blowing produces a broadband rush of air noise across the microphone
   * membrane, concentrated well below 500 Hz and quite unlike speech or
   * music, which have structure higher up. Comparing the two bands separates
   * a real puff from someone talking near the phone.
   */
  /**
   * Ask the native shell for the OS microphone permission, if there is one.
   *
   * Resolves true when the app may use the microphone. In a plain browser
   * there is no shell and this is a no-op: the browser's own prompt happens
   * inside getUserMedia as usual.
   */
  async ensureHostPermission() {
    const host = window.CandleHost;
    if (!host || typeof host.requestMicPermission !== 'function') return true;
    try {
      if (host.hasMicPermission()) return true;
    } catch (e) {
      return true;   // older shell without the check; let getUserMedia try
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        window.__candleMicPermission = null;
        resolve(ok);
      };
      window.__candleMicPermission = (granted) => done(granted === true || granted === 'true');
      // If the dialog is dismissed without an answer we would otherwise wait
      // forever, so give up rather than leaving the button stuck.
      setTimeout(() => done(false), 90000);
      try { host.requestMicPermission(); } catch (e) { done(false); }
    });
  }

  async enableMic() {
    if (this.analyser) return true;

    // The OS permission is acquired *before* getUserMedia, never during it.
    // Asking from inside the getUserMedia call pauses the activity, which
    // suspends the WebView and tears the media stack down under the in-flight
    // request; it came back as NotReadableError on a real device.
    const permitted = await this.ensureHostPermission();
    if (!permitted) {
      this.micError = 'permission refused';
      return false;
    }

    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,   // noise suppression removes exactly the
        autoGainControl: false,    // signal we are looking for
      },
    };

    // Backoff between attempts. A microphone that has just been released, or
    // an audio stack still coming up after the permission dialog, needs longer
    // than one short retry allowed for.
    const BACKOFF_MS = [350, 900, 1800];
    this.micAttempts = 0;

    for (let attempt = 0; attempt < BACKOFF_MS.length + 1; attempt++) {
      try {
        this.micAttempts = attempt + 1;
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const Ctx = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = this.audioCtx || new Ctx();
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
        const src = this.audioCtx.createMediaStreamSource(stream);
        const analyser = this.audioCtx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.35;
        src.connect(analyser);
        this.analyser = analyser;
        this.stream = stream;
        this.bins = new Float32Array(analyser.frequencyBinCount);
        this.micReady = true;
        this.micError = null;
        return true;
      } catch (err) {
        const name = (err && err.name) || 'unavailable';
        this.micError = name;
        // NotReadableError means the permission was fine but the hardware
        // would not start - usually because something else is holding the
        // microphone, or it has just been released and has not settled. One
        // retry after a short pause clears the transient case.
        // NotReadableError means the permission was fine but the device would
        // not open: something else is holding it, or it has not settled yet.
        // Anything else is final and retrying only delays the message.
        if (name === 'NotReadableError' && attempt < BACKOFF_MS.length) {
          await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
          continue;
        }
        return false;
      }
    }
    return false;
  }

  disableMic() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.analyser = null;
    this.micReady = false;
    this.blow = 0;
  }

  sampleMic() {
    const a = this.analyser;
    a.getFloatFrequencyData(this.bins);
    const nyquist = this.audioCtx.sampleRate / 2;
    const binHz = nyquist / this.bins.length;
    const lowMax = Math.floor(450 / binHz);
    const highMin = Math.floor(1200 / binHz);

    let low = 0, lowN = 0, high = 0, highN = 0;
    for (let i = 2; i < this.bins.length; i++) {
      const db = this.bins[i];
      const lin = db < -110 ? 0 : Math.pow(10, db / 20);
      if (i <= lowMax) { low += lin; lowN++; }
      else if (i >= highMin) { high += lin; highN++; }
    }
    low = lowN ? low / lowN : 0;
    high = highN ? high / highN : 0;

    // A puff is loud low down and comparatively quiet up top.
    const ratio = low / (high + 1e-6);
    const level = Math.max(0, (low - 0.0016) * 240);
    const isBreath = ratio > 2.2 ? 1 : Math.max(0, (ratio - 1.1) / 1.1);
    const target = Math.min(1, level * isBreath);
    // Rise fast, fall slowly: a flame keeps moving after the puff stops.
    this.blow += (target - this.blow) * (target > this.blow ? 0.55 : 0.10);
  }

  /** Tilting the phone drags the air across the flame. */
  attachTilt() {
    if (this._tiltBound) return;
    this._tiltBound = (e) => {
      const gamma = e.gamma || 0;               // left-right tilt, degrees
      this.tiltX = Math.max(-0.9, Math.min(0.9, gamma / 45)) * 0.32;
    };
    window.addEventListener('deviceorientation', this._tiltBound, true);
  }
}

/**
 * A plain-text account of why the microphone is not working.
 *
 * The toast tells you what to do; this tells you what actually happened, so a
 * failure on a device I cannot reach can be screenshotted and sent back
 * rather than guessed at. Reached by holding the microphone button.
 */
export function micDiagnostics(air) {
  const host = window.CandleHost;
  const lines = [];
  lines.push(`error: ${air.micError || 'none'}`);
  lines.push(`attempts: ${air.micAttempts || 0}`);
  lines.push(`native shell: ${host ? 'yes' : 'no'}`);
  if (host && typeof host.hasMicPermission === 'function') {
    try {
      lines.push(`OS permission: ${host.hasMicPermission() ? 'granted' : 'not granted'}`);
    } catch (e) {
      lines.push('OS permission: check failed');
    }
  }
  lines.push(`getUserMedia: ${navigator.mediaDevices ? 'available' : 'missing'}`);
  lines.push(`secure context: ${window.isSecureContext ? 'yes' : 'no'}`);
  return lines.join('\n');
}
