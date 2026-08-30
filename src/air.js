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

    if (this.nativeMic) this.sampleNativeMic();
    else if (this.analyser) this.sampleMic();
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

  /**
   * Capture through the native shell, which does not use the WebView's media
   * stack at all.
   *
   * This is tried first when the shell offers it. getUserMedia has failed on
   * a real device with every WebView-side cause ruled out - permission held,
   * secure context, a device enumerated, no activity pause, and a bare
   * { audio: true } refused - so on Android the browser path is now the
   * fallback rather than the other way round. In a plain browser there is no
   * shell and nothing changes.
   */
  enableNativeMic() {
    const host = window.CandleHost;
    if (!host || typeof host.startMic !== 'function') return false;
    this.micMode = 'native';
    this.micAttempts += 1;
    let ok = false;
    try {
      ok = host.startMic() === true;
    } catch (e) {
      this.micError = 'native capture threw';
      return false;
    }
    if (!ok) {
      this.micError = 'native capture refused';
      return false;
    }
    this.nativeMic = true;
    this.micReady = true;
    this.micError = null;
    this.quiet = undefined;
    return true;
  }

  async enableMic() {
    if (this.analyser || this.nativeMic) return true;
    this.micAttempts = 0;

    // The OS permission comes first, before *either* capture path.
    //
    // It is acquired here rather than inside getUserMedia because asking from
    // in there pauses the activity, which suspends the WebView and tears the
    // media stack down under the in-flight request; that came back as
    // NotReadableError on a real device.
    //
    // It also has to precede the native path, which is what went wrong on a
    // fresh install. startMic returns false when the permission is not held,
    // so on the very first tap the native attempt was refused before the user
    // had been asked - and the code fell through to the WebView ladder, which
    // asked for permission and then failed the way it always does on that
    // device. Every later tap worked, because by then the permission was
    // held and the native path was reached. One failure per install, which is
    // exactly the first impression the app cannot afford.
    const permitted = await this.ensureHostPermission();
    if (!permitted) {
      this.micError = 'permission refused';
      return false;
    }

    if (this.enableNativeMic()) return true;

    // How many audio inputs does the WebView believe exist? If this is zero
    // the problem is upstream of anything this app is asking for.
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.inputCount = devices.filter((d) => d.kind === 'audioinput').length;
    } catch (e) {
      this.inputCount = -1;
    }

    // Ask for the ideal capture first, then fall back.
    //
    // Turning off echo cancellation, noise suppression and gain control is
    // what makes a blown breath detectable - noise suppression is designed to
    // remove exactly that. But many Android devices cannot disable them: there
    // is no raw path through the audio driver, and asking for one fails to
    // open the device at all. That comes back as NotReadableError, which reads
    // like a hardware fault and is really an unsatisfiable request.
    //
    // A working microphone with processing applied still detects a puff; it is
    // attenuated, not gone. So a plain request is tried next, and a
    // deliberately un-processed voice-style capture after that.
    const ATTEMPTS = [
      { label: 'raw', wait: 0, constraints: { audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false } } },
      { label: 'raw retry', wait: 400, constraints: { audio: {
        echoCancellation: false, noiseSuppression: false, autoGainControl: false } } },
      { label: 'plain', wait: 300, constraints: { audio: true } },
      { label: 'plain retry', wait: 900, constraints: { audio: true } },
    ];
    for (const step of ATTEMPTS) {
      if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
      try {
        this.micAttempts += 1;
        this.micMode = step.label;
        const stream = await navigator.mediaDevices.getUserMedia(step.constraints);
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
        // Processing left on costs sensitivity, so the threshold is relaxed
        // to compensate rather than the feature being quietly useless.
        this.processed = step.label.startsWith('plain');
        this.micReady = true;
        this.micError = null;
        return true;
      } catch (err) {
        this.micError = (err && err.name) || 'unavailable';
        // Only a device that would not open is worth another shape of
        // request. Anything else is final.
        if (this.micError !== 'NotReadableError' && this.micError !== 'OverconstrainedError') {
          return false;
        }
      }
    }
    return false;
  }

  disableMic() {
    if (this.nativeMic) {
      try { window.CandleHost.stopMic(); } catch (e) { /* already gone */ }
      this.nativeMic = false;
    }
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.analyser = null;
    this.micReady = false;
    this.blow = 0;
  }

  /** Read the two band energies the native capture publishes. */
  sampleNativeMic() {
    let parts;
    try {
      parts = window.CandleHost.micLevels().split(',');
    } catch (e) {
      return;
    }
    const low = parseFloat(parts[0]);
    const high = parseFloat(parts[1]);
    if (!(low >= 0) || !(high >= 0)) return;
    this.applyBlow(low, high);
  }

  /**
   * Decide how hard you are blowing, from the energy in the two bands.
   *
   * The threshold adapts to the room rather than being a constant. Native
   * capture reports a plain RMS whose scale depends on the sensitivity of the
   * phone's microphone and on which audio source the ladder settled on, and
   * neither of those can be measured from here - guessing a fixed number
   * would be the same mistake that cost three attempts at this already.
   * Tracking the quiet level and asking for a large multiple of it works
   * whatever that scale turns out to be.
   */
  applyBlow(low, high) {
    if (this.quiet === undefined) this.quiet = low;
    // Settle onto a new quiet level quickly, drift up from it very slowly.
    // The asymmetry is the whole point: a puff lasts under a second and must
    // not drag its own reference up with it, while a fan or traffic outside
    // should become the new normal over about twenty seconds rather than
    // holding the candle out indefinitely.
    this.quiet += (low - this.quiet) * (low < this.quiet ? 0.08 : 0.0008);
    const floor = Math.max(this.quiet * 3.5, 0.004);
    const span = Math.max(this.quiet * 14, 0.05);
    const level = Math.max(0, (low - floor) / span);
    // A puff is loud low down and comparatively quiet up top.
    const ratio = low / (high + 1e-9);
    const isBreath = ratio > 2.2 ? 1 : Math.max(0, (ratio - 1.1) / 1.1);
    const target = Math.min(1, level * isBreath);
    // Rise fast, fall slowly: a flame keeps moving after the puff stops.
    this.blow += (target - this.blow) * (target > this.blow ? 0.55 : 0.10);
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
    // A stream with noise suppression and gain control left on delivers far
    // less of a breath than a raw one, so the floor moves with it.
    const floor = this.processed ? 0.0007 : 0.0016;
    const gain = this.processed ? 420 : 240;
    const level = Math.max(0, (low - floor) * gain);
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
  lines.push(`last mode: ${air.micMode || 'none'}`);
  lines.push(`audio inputs: ${air.inputCount === undefined ? 'unknown' : air.inputCount}`);
  lines.push(`native shell: ${host ? 'yes' : 'no'}`);
  lines.push(`capture: ${air.nativeMic ? 'native' : (air.analyser ? 'webview' : 'none')}`);
  if (host && typeof host.micReport === 'function') {
    try {
      const report = host.micReport();
      if (report) lines.push(report);
    } catch (e) {
      lines.push('native report: unavailable');
    }
  }
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
