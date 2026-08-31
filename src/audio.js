/**
 * Wick crackle, synthesised rather than sampled.
 *
 * Sharp irregular ticks, as trapped moisture and impurities in the wick flash
 * to vapour. They arrive as a Poisson process - independent events at a
 * roughly constant average rate - so they are generated that way here instead
 * of being looped. A loop of any length eventually becomes recognisable,
 * which ruins the illusion faster than anything visual does.
 *
 * There was a steady low hiss under this as well, standing in for the
 * convective plume. It was removed on request: the ticks alone are what reads
 * as a candle, and a continuous bed of noise is the part that starts to sound
 * like an appliance in a quiet room.
 *
 * Synthesising it also keeps the app tiny: no audio assets to ship.
 */

export class Crackle {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.level = 0;
  }

  start() {
    if (this.ctx) { this.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // Two seconds of white noise, which every tick is carved out of.
    const n = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    this.on = true;
    this.schedule();
  }

  /** One tick: a very short band-passed noise burst with a fast decay. */
  pop(when, strength) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 2600;
    bp.Q.value = 1.4 + Math.random() * 5;
    const g = ctx.createGain();
    const peak = 0.06 + Math.random() * 0.22 * strength;
    const dur = 0.012 + Math.random() * 0.055;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.0016);
    g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(when);
    src.stop(when + dur + 0.02);
  }

  /**
   * Schedule the next batch of ticks. Poisson arrivals mean the gap between
   * events is exponentially distributed, so we just draw the gaps.
   */
  schedule() {
    if (!this.ctx || !this.on) return;
    const ctx = this.ctx;
    const horizon = 0.6;
    let t = Math.max(ctx.currentTime, this.nextAt || ctx.currentTime);
    const rate = 1.4 + this.level * 5.5;      // ticks per second
    while (t < ctx.currentTime + horizon) {
      t += -Math.log(1 - Math.random()) / rate;
      if (t > ctx.currentTime) this.pop(t, 0.4 + this.level);
    }
    this.nextAt = t;
    this.timer = setTimeout(() => this.schedule(), 400);
  }

  /** Track the flame: louder and busier as the dial goes up. */
  setLevel(level, lit) {
    this.level = level;
    if (!this.ctx) return;
    const target = lit ? 0.10 + level * 0.55 : 0;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, 0.25);
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  stop() {
    if (!this.ctx) return;
    this.on = false;
    clearTimeout(this.timer);
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    setTimeout(() => {
      if (this.on) return;
      this.ctx.close();
      this.ctx = null;
    }, 700);
  }
}
