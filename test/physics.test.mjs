/**
 * Physics invariants.
 *
 * These are not unit tests of implementation details; they pin the handful of
 * facts that make this a candle rather than an orange animation. If a
 * refactor breaks one of them, the app stops being honest about what it is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FlameField } from '../src/fluid.js';
import { WaxBody, waxViscosity } from '../src/wax.js';
import { AirModel } from '../src/air.js';
import { AbelProjector } from '../src/abel.js';
import { blackbodyRGB, encodeSrgb, planck } from '../src/blackbody.js';
import {
  T_AMBIENT, T_WAX_MELT, T_ADIABATIC, HEAT_RELEASE, T_COLOR_ROOM,
} from '../src/constants.js';

const GRID = () => new FlameField(40, 130, 0.024 / 40);
const DT = 1 / 480;

/** Run the solver for `secs` of simulated time at a given dial setting. */
function burn(f, intensity, secs) {
  for (let n = 0; n < Math.round(480 * secs); n++) {
    f.injectFuel(intensity, DT);
    f.step(DT);
  }
  return f;
}

// ---------------------------------------------------------------- the wax
test('burns at the measured rate of a real candle', () => {
  const wax = new WaxBody();
  wax.timeScale = 1;
  for (let i = 0; i < 3600 * 60; i++) wax.update(1 / 60, 1, true);

  // Hamins, Bundy & Dillon (2005) measure ~0.105 g/min for a standard candle,
  // which is 6.3 g in an hour.
  assert.ok(Math.abs(wax.burnedMass * 1000 - 6.3) < 0.1,
    `burned ${(wax.burnedMass * 1000).toFixed(2)} g/h, expected ~6.3`);
  // And about 80 W of heat, which is the figure the melt model is driven by.
  assert.ok(Math.abs(HEAT_RELEASE - 80.7) < 1, `heat release ${HEAT_RELEASE}`);
});

test('burns away more wax the harder it burns', () => {
  const burned = [0.3, 0.6, 1.0].map((I) => {
    const wax = new WaxBody();
    wax.timeScale = 1;
    for (let i = 0; i < 3600 * 60; i++) wax.update(1 / 60, I, true);
    return wax.burnedMass;
  });
  assert.ok(burned[1] > burned[0] && burned[2] > burned[1],
    `mass burnt should rise with the dial: ${burned.map((b) => (b * 1000).toFixed(2))}`);
});

test('a low flame tunnels: it digs a narrow deep crater', () => {
  // Deliberately *not* asserting that a hotter flame leaves a lower centre.
  // A low flame melts only a narrow pool and bores straight down, while a
  // high one melts the whole face and sinks it evenly, so the centre can end
  // up lower on the low setting. That is tunnelling, and it is exactly what
  // happens to a real pillar candle burned too gently.
  const dig = (I) => {
    const wax = new WaxBody();
    wax.timeScale = 1;
    for (let i = 0; i < 3600 * 60; i++) wax.update(1 / 60, I, true);
    return { crater: wax.nodeHeight(0) - wax.centreHeight(), pool: wax.poolRadius };
  };
  const low = dig(0.3);
  const high = dig(1.0);
  assert.ok(low.pool < high.pool, 'a low flame should melt a narrower pool');
  assert.ok(low.crater > high.crater, 'a low flame should leave a deeper crater');
});

test('melt pool stays shallow and keeps a solid rim at low settings', () => {
  const wax = new WaxBody();
  wax.timeScale = 1;
  for (let i = 0; i < 1800 * 60; i++) wax.update(1 / 60, 0.4, true);
  // A real candle's pool is one to a few millimetres deep, never a reservoir.
  assert.ok(wax.poolDepth > 0.0005 && wax.poolDepth < 0.006,
    `pool depth ${(wax.poolDepth * 1000).toFixed(2)} mm`);
  // And the rim must survive, or there is no crater and it drips constantly.
  assert.ok(wax.nodeHeight(0) > wax.centreHeight(), 'rim should stand above the pool');
});

test('molten wax thickens as it cools, which is why drips set', () => {
  const hot = waxViscosity(345);
  const cool = waxViscosity(T_WAX_MELT);
  assert.ok(cool > hot * 1.5, `viscosity should climb on cooling: ${hot} -> ${cool}`);
});

// -------------------------------------------------------------- the flame
test('flame reaches soot-glow temperatures without exceeding adiabatic', () => {
  const f = burn(GRID(), 0.8, 5);
  let peak = 0;
  for (let k = 0; k < f.T.length; k++) if (f.T[k] > peak) peak = f.T[k];
  assert.ok(peak > 1100, `peak ${peak.toFixed(0)} K is too cool for glowing soot`);
  assert.ok(peak <= T_ADIABATIC + 1,
    `peak ${peak.toFixed(0)} K exceeds the adiabatic flame temperature`);
});

test('gas rises at the speed a real candle plume does', () => {
  const f = burn(GRID(), 0.8, 5);
  let vmax = 0;
  for (let k = 0; k < f.v.length; k++) if (Math.abs(f.v[k]) > vmax) vmax = Math.abs(f.v[k]);
  // Buoyancy alone puts a candle plume at roughly 1-3 m/s.
  assert.ok(vmax > 0.5 && vmax < 4, `peak gas velocity ${vmax.toFixed(2)} m/s`);
});

test('turning the dial up makes a bigger flame', () => {
  const heights = [0.3, 0.6, 0.9].map((I) => burn(GRID(), I, 5).flameHeight());
  assert.ok(heights[1] > heights[0], `${heights[1]} should exceed ${heights[0]}`);
  assert.ok(heights[2] > heights[1], `${heights[2]} should exceed ${heights[1]}`);
});

/**
 * Statistics of the flame's light output over a window, optionally driven by
 * a room draft.
 *
 * The window is long relative to the draft's 1.7 s correlation time, because
 * a short one contains only a handful of independent samples and the spread
 * of the estimate is then wider than the thing being estimated.
 */
function emissionStats(intensity, withDraft) {
  const f = GRID();
  const air = new AirModel();
  const step = () => {
    if (withDraft) { air.update(DT); f.windX = air.windX(); f.windY = air.windY(); }
    f.injectFuel(intensity, DT);
    f.step(DT);
  };
  for (let n = 0; n < 480 * 3; n++) step();
  const series = [];
  for (let n = 0; n < 480 * 5; n++) { step(); series.push(f.emission()); }
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const rms = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length);
  return {
    cv: rms / mean,
    low: Math.min(...series) / mean,
    high: Math.max(...series) / mean,
  };
}

test('flame dances in a real room, without ever going out', () => {
  // The app always runs the draft model, so this is the case that matters.
  //
  // Deliberately not asserting a band on the coefficient of variation. That
  // was the first shape of this test and it was a bad one: the depth of the
  // flicker varies from about 0.25 to 0.8 between runs depending on what the
  // draft happens to do, so any upper bound tight enough to mean something
  // sits inside the distribution and fails at random. It did exactly that on
  // CI after passing locally.
  //
  // What actually matters is not how big the swing is but that the flame
  // stays a flame: it moves, it never gutters out, and it never runs away.
  // Those hold with a wide margin.
  const s = emissionStats(0.7, true);
  assert.ok(s.cv > 0.02, `flicker ${(100 * s.cv).toFixed(1)}% is too steady to look alive`);
  assert.ok(s.low > 0.10, `dimmest moment falls to ${(100 * s.low).toFixed(0)}% of mean - nearly out`);
  assert.ok(s.high < 6, `brightest moment reaches ${s.high.toFixed(1)}x mean - running away`);
});

test('flame burns steadily in perfectly still air', () => {
  // Not a quirk to be fixed - it is the physics being self-consistent. The
  // solver, the grid and the wick are all exactly symmetric, so with no air
  // movement at all there is nothing to break that symmetry and the plume
  // sits still. A real candle under a cloche does the same. The room draft in
  // air.js is what makes a candle dance, and this pins that dependency down
  // so nobody later mistakes the draft for decoration and removes it.
  const s = emissionStats(0.7, false);
  assert.ok(s.cv < 0.01, `expected a still flame, got ${(100 * s.cv).toFixed(1)}%`);
});

test('solver never produces a NaN, including on a bad timestep', () => {
  // Regression test. The first requestAnimationFrame callback can carry a
  // timestamp from before a synchronous start-up ran, giving a negative dt.
  // That put sqrt() of a negative number into the draft model, and NaN in a
  // field like this is absorbing: it spreads on the next advection and the
  // flame never comes back. It presented as a silently black screen.
  const f = GRID();
  const air = new AirModel();
  for (const bad of [-0.016, 0, NaN]) {
    air.update(bad);
    f.windX = air.windX() || 0;
    f.injectFuel(0.7, DT);
    f.step(DT);
  }
  burn(f, 0.7, 4);

  for (const [name, arr] of [['T', f.T], ['u', f.u], ['v', f.v],
                             ['fuel', f.fuel], ['ox', f.ox], ['soot', f.soot]]) {
    for (let k = 0; k < arr.length; k++) {
      assert.ok(Number.isFinite(arr[k]), `${name}[${k}] is ${arr[k]}`);
    }
  }
  assert.ok(Number.isFinite(air.draftX), `draft went ${air.draftX}`);
});

test('field stays bounded and temperature never falls below ambient', () => {
  const f = burn(GRID(), 1.0, 6);
  for (let k = 0; k < f.T.length; k++) {
    assert.ok(f.T[k] >= T_AMBIENT - 1, `T[${k}] = ${f.T[k]} is below ambient`);
    assert.ok(f.soot[k] >= 0 && f.soot[k] < 10, `soot[${k}] = ${f.soot[k]}`);
    assert.ok(f.ox[k] >= -0.01 && f.ox[k] <= 1.01, `ox[${k}] = ${f.ox[k]}`);
  }
});

test('a hard enough puff puts the candle out, ordinary breathing does not', () => {
  const gentle = new AirModel();
  gentle.blow = 0.08;
  for (let i = 0; i < 60; i++) gentle.update(1 / 60);
  assert.ok(!gentle.shouldExtinguish(), 'a soft breath should not blow it out');

  const puff = new AirModel();
  for (let i = 0; i < 30; i++) { puff.blow = 1; puff.update(1 / 60); }
  assert.ok(puff.shouldExtinguish(), 'a real puff should blow it out');
});

// ---------------------------------------------------------------- colour
test('flame colour comes out of Planck\'s law, not a palette', () => {
  // 1850 K is the correlated colour temperature of candlelight; it should
  // land on a deep amber. This guards the whole Planck -> CIE -> sRGB chain.
  const rgb = blackbodyRGB(T_COLOR_ROOM).map((c) => Math.round(255 * encodeSrgb(c)));
  assert.equal(rgb[0], 255, 'red should be saturated at candle temperatures');
  assert.ok(rgb[1] > 100 && rgb[1] < 170, `green ${rgb[1]} out of range for 1850 K`);
  assert.ok(rgb[2] < 40, `blue ${rgb[2]} is too high for 1850 K`);
});

test('hotter blackbodies are bluer', () => {
  const cool = blackbodyRGB(1200);
  const hot = blackbodyRGB(2400);
  assert.ok(hot[2] > cool[2], 'blue should rise with temperature');
  assert.ok(planck(500, 2400) > planck(500, 1200), 'Planck radiance should rise with T');
});

// ------------------------------------------------------------- projection
test('Abel projection fills the centre and brightens the limb', () => {
  const n = 24;
  const p = new AbelProjector(n);
  const radial = new Float32Array(n);
  const out = new Float32Array(n);
  // A hollow luminous shell, which is what a flame sheet is.
  for (let r = 6; r < 10; r++) radial[r] = 1;
  p.project(radial, out);

  // Chords through the middle still cross the shell, so the centre is not
  // empty the way the raw slice is.
  assert.ok(out[0] > 0.05, `centre ${out[0]} should not be dark`);
  // And the chord that runs tangentially along the shell is the brightest:
  // limb brightening, which is visible in any photograph of a flame.
  const peak = out.indexOf(Math.max(...out));
  assert.ok(peak >= 5 && peak <= 7, `limb should peak at the shell edge, got ${peak}`);
  // Nothing is emitted beyond the shell.
  assert.ok(out[n - 1] === 0, 'no emission outside the shell');
});
