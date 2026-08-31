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

// Number.isFinite rather than a NaN check: undefined and null are not NaN and
// would slide straight through comparisons, arriving as NaN in the arithmetic
// a line later. A test caught exactly that.
/**
 * One AudioContext for the whole app, shared by every sound layer.
 *
 * Not per-layer: a context carries its own audio thread, browsers cap how many
 * a page may hold, and this app is meant to sit on a desk for hours. Layers
 * register by name in a Set rather than by counting, so a double start or a
 * stop-then-start cannot leave the books wrong - which a refcount would.
 *
 * The context is suspended rather than closed when the last layer stops, so
 * toggling sound off and on again does not churn a new one each time.
 */
let sharedCtx = null;
const activeLayers = new Set();

export function audioContext() {
  if (sharedCtx) return sharedCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  sharedCtx = new Ctx();
  return sharedCtx;
}

export function layerOn(name) {
  const ctx = audioContext();
  if (!ctx) return null;
  activeLayers.add(name);
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function layerOff(name) {
  activeLayers.delete(name);
  if (sharedCtx && activeLayers.size === 0 && sharedCtx.state === 'running') {
    sharedCtx.suspend();
  }
}

/**
 * Two seconds of white noise, built once and shared.
 *
 * Every layer here is noise through a filter - the crackle's ticks, rain's
 * bed and its drops - so they can all read from the same buffer instead of
 * each allocating a few hundred kilobytes of their own.
 */
let noise = null;
export function noiseBuffer(ctx) {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  const n = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  noise = buf;
  return noise;
}

export const clamp01 = (x) => (Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0);

/**
 * How the flame drives the crackle.
 *
 * Pure on purpose: numbers in, numbers out, no Web Audio anywhere near it. The
 * part with judgement in it can then be tested under `node --test` with no
 * browser, which is the split that finally made the microphone work - measure
 * in one place, decide in another, test the decision.
 *
 * The scaling is measured rather than guessed. Sampled at 60 fps with the room
 * draft running, `renderer.luminance()` averages 0.449 / 0.886 / 1.406 across
 * the dial's low, middle and top, so dividing by 1.45 lands within a few
 * hundredths of the dial position the crackle used to be handed. That is the
 * point: at rest this should sound exactly as it did, and only the response to
 * a moving flame is new.
 *
 * @param {number} vigour   0..1, light output normalised — how big the flame is
 * @param {number} flutter  0..1, how fast that output is changing right now
 * @param {number} blow     0..1, breath detected at the microphone
 * @param {boolean} lit
 */
export function crackleDrive({ vigour, flutter, blow, lit }) {
  if (!lit) return { rate: 0, gain: 0, strength: 0 };
  const v = clamp01(vigour);
  // A disturbed flame spits. A gutter or a puff should multiply the tick rate,
  // not nudge it - the whole complaint was that the candle could gutter in
  // silence. Flutter is divided by 0.6 upstream, which is its measured 95th
  // percentile, so this reaches 1 only on the deepest gutters.
  const excite = clamp01(clamp01(flutter) * 0.7 + clamp01(blow));
  return {
    rate: 1.4 + v * 5.5 + excite * 9,
    gain: 0.10 + v * 0.55 + excite * 0.12,
    strength: 0.4 + v + excite * 0.8,
  };
}

export class Crackle {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.drive = { rate: 0, gain: 0, strength: 0 };
  }

  start() {
    const ctx = layerOn('crackle');
    if (!ctx) return;
    this.ctx = ctx;
    // Built once and kept. Stopping silences and unschedules; it does not tear
    // the graph down, so switching sound off and on again is instant.
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(ctx.destination);
    }
    this.noise = noiseBuffer(ctx);
    if (this.on) return;
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
    // Short horizon on purpose. Ticks already scheduled cannot be taken back,
    // so it sets how long the crackle takes to notice the flame moving. At the
    // old 0.6 s a gutter would have been heard well after it was seen.
    const horizon = 0.35;
    let t = Math.max(ctx.currentTime, this.nextAt || ctx.currentTime);
    const { rate, strength } = this.drive;
    while (t < ctx.currentTime + horizon) {
      if (rate <= 0) { t = ctx.currentTime + horizon; break; }
      t += -Math.log(1 - Math.random()) / rate;
      if (t > ctx.currentTime) this.pop(t, strength);
    }
    this.nextAt = t;
    this.timer = setTimeout(() => this.schedule(), 200);
  }

  /**
   * Track the flame itself, rather than the dial.
   *
   * This used to be handed `state.intensity` - the knob - so the candle could
   * flicker, gutter and recover without the sound changing at all. It now
   * takes what the simulation is actually doing.
   */
  setFlame(vigour, flutter, blow, lit) {
    this.drive = crackleDrive({ vigour, flutter, blow, lit });
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.drive.gain, this.ctx.currentTime, 0.25);
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  stop() {
    if (!this.ctx || !this.on) return;
    this.on = false;
    clearTimeout(this.timer);
    this.timer = 0;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.2);
    // Let the fade finish before releasing, or the tail is cut off.
    setTimeout(() => { if (!this.on) layerOff('crackle'); }, 700);
  }
}
