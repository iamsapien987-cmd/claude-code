/**
 * The crackle's response to the flame.
 *
 * This is testable at all because the mapping is a pure function: the Web
 * Audio part takes numbers it is given, and the judgement about what those
 * numbers should be lives somewhere a test can reach without a browser.
 *
 * What is being pinned is the complaint that prompted it - the candle could
 * gutter, or be blown at, in complete silence, because the sound was driven by
 * the dial rather than by the simulation.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { crackleDrive } from '../src/audio.js';

const steady = (vigour) => crackleDrive({ vigour, flutter: 0, blow: 0, lit: true });

test('an unlit candle is silent', () => {
  const d = crackleDrive({ vigour: 0.9, flutter: 1, blow: 1, lit: false });
  assert.equal(d.rate, 0);
  assert.equal(d.gain, 0);
});

test('a bigger flame is busier and louder', () => {
  const low = steady(0.2), high = steady(1.0);
  assert.ok(high.rate > low.rate * 1.5, `${low.rate} -> ${high.rate}`);
  assert.ok(high.gain > low.gain);
  // Still a candle, not a bonfire: a few ticks a second, not tens.
  assert.ok(high.rate < 12, `${high.rate} ticks/s is not a candle`);
});

test('a guttering flame spits, a steady one does not', () => {
  const calm = steady(0.6);
  const gutter = crackleDrive({ vigour: 0.6, flutter: 1, blow: 0, lit: true });
  assert.ok(gutter.rate > calm.rate * 2,
    `guttering should be audible: ${calm.rate.toFixed(1)} -> ${gutter.rate.toFixed(1)}`);
  assert.ok(gutter.strength > calm.strength);
});

test('blowing at it is heard', () => {
  const calm = steady(0.6);
  const blown = crackleDrive({ vigour: 0.6, flutter: 0, blow: 1, lit: true });
  assert.ok(blown.rate > calm.rate * 2.5,
    `${calm.rate.toFixed(1)} -> ${blown.rate.toFixed(1)}`);
});

test('at rest it stays in the range the dial used to produce', () => {
  // The point of the change was responsiveness, not a new sound. A resting
  // flame should land close to the old `0.10 + level * 0.55`.
  for (const [vigour, level] of [[0.31, 0.25], [0.61, 0.70], [0.97, 1.0]]) {
    const gain = steady(vigour).gain;
    const old = 0.10 + level * 0.55;
    assert.ok(Math.abs(gain - old) < 0.08,
      `vigour ${vigour}: gain ${gain.toFixed(3)} vs old ${old.toFixed(3)}`);
  }
});

test('nonsense inputs cannot produce nonsense output', () => {
  for (const bad of [NaN, -5, 1e9, undefined]) {
    const d = crackleDrive({ vigour: bad, flutter: bad, blow: bad, lit: true });
    for (const [k, v] of Object.entries(d)) {
      assert.ok(Number.isFinite(v), `${k} became ${v} for input ${bad}`);
      assert.ok(v >= 0 && v < 30, `${k} = ${v} is out of range for input ${bad}`);
    }
  }
});

// ------------------------------------------------------------------- rain

import { rainDrive } from '../src/rain.js';

test('heavier rain moves every layer together, not just the volume', () => {
  const drizzle = rainDrive(0.1), downpour = rainDrive(1);
  assert.ok(downpour.dropRate > drizzle.dropRate * 2, 'more drops land');
  assert.ok(downpour.bedGain > drizzle.bedGain, 'the hiss builds');
  assert.ok(downpour.bodyGain > drizzle.bodyGain, 'the roof drums harder');
  assert.ok(downpour.bedCutoff > drizzle.bedCutoff * 1.5,
    'and gains top end rather than only getting louder');
});

test('rain stays inside the budget that was measured as free', () => {
  // 160 drop-chains a second cost nothing measurable next to the solver, on a
  // desktop. This keeps a wide margin, because the target is a phone.
  assert.ok(rainDrive(1).dropRate < 60, `${rainDrive(1).dropRate}/s is too many`);
  assert.ok(rainDrive(0).dropRate > 2, 'drizzle should still be audible');
});

test('rain never gets loud enough to drown the candle', () => {
  // The candle is the point; the room is behind it.
  const loud = rainDrive(1);
  assert.ok(loud.bedGain + loud.bodyGain < 0.3,
    `${(loud.bedGain + loud.bodyGain).toFixed(3)} is too much next to a 0.65 crackle`);
});

test('rain clamps like everything else', () => {
  for (const bad of [NaN, undefined, -3, 99]) {
    for (const [k, v] of Object.entries(rainDrive(bad))) {
      assert.ok(Number.isFinite(v) && v >= 0, `${k} = ${v} for input ${bad}`);
    }
  }
});
