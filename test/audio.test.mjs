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
