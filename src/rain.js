/**
 * Rain on a roof, synthesised.
 *
 * Same principle as the wick crackle and for the same reasons: no audio files,
 * so nothing to license, nothing to add to a 2.2 MB app, and - the one that
 * actually matters - no loop for the ear to catch. A rain recording betrays
 * its loop point within a minute or two, and this is meant to run for hours.
 *
 * Three layers, because that is what rain on a roof is made of:
 *
 *   1. A hiss. Thousands of drops too small and too many to hear separately,
 *      which is broadband noise rolled off at the top.
 *   2. A body. The roof itself, resonating low - the drumming rather than the
 *      hiss. A narrow band a few hundred Hz up.
 *   3. Individual taps. The drops big enough to hear land one at a time,
 *      arriving as a Poisson process exactly like the wick's ticks.
 *
 * Heavier rain does not simply mean louder: as it gets heavier the hiss gains
 * top end, the roof drums harder, and the discrete taps arrive faster until
 * they blur into the hiss. All three move together on one control.
 *
 * Measured before it was built: 160 drop-chains a second cost nothing
 * measurable next to the fluid solver, holding 59.9 fps with live nodes
 * bounded, so this creates a small graph per drop rather than needing an
 * AudioWorklet. The ceiling here is 50/s, well inside that.
 */
import { layerOn, layerOff, noiseBuffer, clamp01 } from './audio.js';

/**
 * How heavy the rain is, as numbers the audio graph can use.
 *
 * Pure, so the judgement in it can be tested without a browser - the same
 * split as `crackleDrive`.
 *
 * @param {number} strength 0 (drizzle) .. 1 (downpour)
 */
export function rainDrive(strength) {
  const s = clamp01(strength);
  return {
    // Drops you can pick out individually. Heavier rain blurs them together,
    // so this rises but the hiss rises faster.
    dropRate: 7 + s * 43,
    dropPeak: 0.05 + s * 0.09,
    // The hiss, and how much top end it has. Drizzle is thin and papery;
    // a downpour is full.
    bedGain: 0.020 + s * 0.075,
    bedCutoff: 1100 + s * 3400,
    // The roof drumming underneath it.
    bodyGain: 0.012 + s * 0.060,
  };
}

const ROOF_HZ = 420;      // where a roof answers back
const HORIZON = 0.35;     // seconds of taps scheduled ahead

export class Rain {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.timer = 0;
    this.strength = 0.5;
    this.drive = rainDrive(0.5);
    // Slow wander, so the rain swells and eases instead of sitting still.
    this.gust = 0;
  }

  start() {
    const ctx = layerOn('rain');
    if (!ctx) return;
    this.ctx = ctx;
    if (!this.master) {
      this.noise = noiseBuffer(ctx);
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(ctx.destination);

      // 1. The hiss.
      this.bedSrc = ctx.createBufferSource();
      this.bedSrc.buffer = this.noise;
      this.bedSrc.loop = true;
      this.bedLp = ctx.createBiquadFilter();
      this.bedLp.type = 'lowpass';
      this.bedLp.frequency.value = this.drive.bedCutoff;
      this.bedLp.Q.value = 0.5;
      this.bedGain = ctx.createGain();
      this.bedGain.gain.value = 0;
      this.bedSrc.connect(this.bedLp).connect(this.bedGain).connect(this.master);
      this.bedSrc.start();

      // 2. The roof.
      this.bodySrc = ctx.createBufferSource();
      this.bodySrc.buffer = this.noise;
      this.bodySrc.loop = true;
      // Offset so the two loops never line up and read as one sound.
      this.bodyBp = ctx.createBiquadFilter();
      this.bodyBp.type = 'bandpass';
      this.bodyBp.frequency.value = ROOF_HZ;
      this.bodyBp.Q.value = 0.9;
      this.bodyGain = ctx.createGain();
      this.bodyGain.gain.value = 0;
      this.bodySrc.connect(this.bodyBp).connect(this.bodyGain).connect(this.master);
      this.bodySrc.start(ctx.currentTime, 0.7);
    }
    if (this.on) return;
    this.on = true;
    this.master.gain.setTargetAtTime(1, ctx.currentTime, 0.8);   // fade in, not a switch
    this.apply();
    this.schedule();
  }

  stop() {
    if (!this.ctx || !this.on) return;
    this.on = false;
    clearTimeout(this.timer);
    this.timer = 0;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.6);
    setTimeout(() => { if (!this.on) layerOff('rain'); }, 1400);
  }

  setStrength(strength) {
    this.strength = clamp01(strength);
    this.drive = rainDrive(this.strength);
    if (this.ctx && this.on) this.apply();
  }

  /** Push the current settings at the graph, gently enough not to click. */
  apply() {
    const t = this.ctx.currentTime;
    const swell = 1 + this.gust * 0.35;
    this.bedGain.gain.setTargetAtTime(this.drive.bedGain * swell, t, 0.5);
    this.bodyGain.gain.setTargetAtTime(this.drive.bodyGain * swell, t, 0.5);
    this.bedLp.frequency.setTargetAtTime(this.drive.bedCutoff * (1 + this.gust * 0.2), t, 0.5);
  }

  /** One tap: a short, sharp, band-limited burst. */
  tap(when) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // Drop size sets pitch, and the spread is wide because rain is not graded.
    bp.frequency.value = 1100 + Math.random() * 3100;
    bp.Q.value = 2.5 + Math.random() * 5;
    const g = ctx.createGain();
    const peak = this.drive.dropPeak * (0.35 + Math.random());
    const dur = 0.004 + Math.random() * 0.013;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.0008);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(when);
    src.stop(when + dur + 0.01);
  }

  schedule() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx;
    // Wander the gust, so the rain breathes. Pulled back towards zero like the
    // room draft in air.js, for the same reason: a random walk that is never
    // reined in eventually wanders somewhere silly.
    this.gust = this.gust * 0.93 + (Math.random() * 2 - 1) * 0.12;
    this.apply();

    let t = Math.max(ctx.currentTime, this.nextAt || ctx.currentTime);
    const rate = this.drive.dropRate * (1 + this.gust * 0.3);
    while (t < ctx.currentTime + HORIZON) {
      if (rate <= 0) { t = ctx.currentTime + HORIZON; break; }
      t += -Math.log(1 - Math.random()) / rate;
      if (t > ctx.currentTime) this.tap(t);
    }
    this.nextAt = t;
    this.timer = setTimeout(() => this.schedule(), 200);
  }
}
