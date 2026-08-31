/**
 * The crackle, in a real browser engine.
 *
 * Two things the unit tests cannot see. First, whether the wiring actually
 * carries the simulation to the speaker - the mapping can be perfect and still
 * be handed the wrong number. Second, whether the audio graph leaks: every
 * tick builds a buffer source, a filter and a gain, several times a second,
 * for however long someone leaves the candle on a desk. A leak there would
 * only show up after an hour, which is exactly the kind of fault nobody finds
 * by hand.
 *
 * Node bookkeeping is done by wrapping createBufferSource and counting 'ended'
 * events, so "still alive" is measured rather than assumed.
 */
import path from 'node:path';
import { launchChromium } from './browser.mjs';

const file = 'file://' + path.resolve(import.meta.dirname, '..', 'dist', 'candle.html');
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.addInitScript(() => {
  window.__nodes = { created: 0, ended: 0 };
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const orig = Ctx.prototype.createBufferSource;
  Ctx.prototype.createBufferSource = function createBufferSource() {
    const n = orig.call(this);
    window.__nodes.created++;
    n.addEventListener('ended', () => { window.__nodes.ended++; });
    return n;
  };
});

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const created = () => page.evaluate(() => window.__nodes.created);
const live = () => page.evaluate(() => window.__nodes.created - window.__nodes.ended);
// Well away from the flame. Tapping the flame snuffs it, and the flame is not
// where it was: widening the vaporisation footprint made it taller and wider,
// and a wake tap that used to miss it started putting the candle out.
const wake = async () => { await page.touchscreen.tap(40, 120); await page.waitForTimeout(300); };

/** Ticks per second over a window, measured from real node creations. */
async function tickRate(seconds) {
  const before = await created();
  await page.waitForTimeout(seconds * 1000);
  return (await created() - before) / seconds;
}

await page.goto(file);
await page.waitForTimeout(3500);

await wake();
await page.click('#btnSound');
await page.waitForTimeout(2000);

// 1. The dial reaches the speaker, through the simulation rather than directly.
await page.evaluate(() => window.__candle.setIntensity(0.15));
await page.waitForTimeout(3000);
const lowRate = await tickRate(8);
await page.evaluate(() => window.__candle.setIntensity(1.0));
await page.waitForTimeout(3000);
const highRate = await tickRate(8);

check('the crackle is running at all', lowRate > 0.5, `${lowRate.toFixed(1)}/s`);
check('a bigger flame is busier', highRate > lowRate * 1.4,
  `${lowRate.toFixed(1)}/s -> ${highRate.toFixed(1)}/s`);
check('...and still sounds like a candle', highRate < 14, `${highRate.toFixed(1)}/s`);

// 2. Snuffing it stops the ticks, rather than leaving them running over a
//    dead candle - which is a fault this app has actually shipped before.
await page.evaluate(() => window.__candle.extinguish(null));
await page.waitForTimeout(1500);
const outRate = await tickRate(4);
check('a snuffed candle falls silent', outRate < 0.4, `${outRate.toFixed(2)}/s`);

// 3. The leak check. Sources are stopped explicitly, so live ones should stay
//    near the handful currently sounding however many have been through.
await page.evaluate(() => window.__candle.light());
await wake();
await page.evaluate(() => window.__candle.setIntensity(1.0));
await page.waitForTimeout(12000);
const total = await created();
const stillLive = await live();
check('the audio graph does not leak', stillLive < 25,
  `${stillLive} live of ${total} created`);

// 4. Turning it off releases everything.
await wake();
await page.click('#btnSound');
await page.waitForTimeout(2000);

// 5. Rain. Nobody can hear this in CI, so it is measured two ways: how many
//    drops actually land, and what the sound is made of.
await wake();
await page.click('#btnRain');
await page.waitForTimeout(2500);
await page.evaluate(() => window.__candle.rain.setStrength(0.15));
await page.waitForTimeout(1500);
const drizzle = await tickRate(6);
await page.evaluate(() => window.__candle.rain.setStrength(0.9));
await page.waitForTimeout(1500);
const downpour = await tickRate(6);
check('rain falls', drizzle > 3, `${drizzle.toFixed(1)}/s`);
check('a downpour is heavier than drizzle', downpour > drizzle * 1.8,
  `${drizzle.toFixed(1)}/s -> ${downpour.toFixed(1)}/s`);
check('...and stays inside the budget that was measured', downpour < 70,
  `${downpour.toFixed(1)}/s against 160/s measured as free`);

// What it is made of. Rain is broadband with the top rolled off - not a tone,
// not white noise. An analyser on the layer's own output says which.
const band = await page.evaluate(async () => {
  const r = window.__candle.rain;
  const an = r.ctx.createAnalyser();
  an.fftSize = 2048;
  r.master.connect(an);
  await new Promise((res) => setTimeout(res, 1500));
  const bins = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(bins);
  r.master.disconnect(an);
  const nyq = r.ctx.sampleRate / 2;
  const avg = (lo, hi) => {
    let sum = 0, n = 0;
    for (let i = 1; i < bins.length; i++) {
      const f = (i * nyq) / bins.length;
      if (f >= lo && f < hi && bins[i] > -140) { sum += 10 ** (bins[i] / 20); n++; }
    }
    return n ? sum / n : 0;
  };
  return { low: avg(150, 700), mid: avg(700, 3000), high: avg(3000, 8000), top: avg(13000, 20000) };
});
check('rain is broadband, not a tone',
  band.low > 0 && band.mid > 0 && band.high > 0,
  `low ${band.low.toExponential(1)} mid ${band.mid.toExponential(1)} high ${band.high.toExponential(1)}`);
check('...with the top rolled off, not white noise', band.top < band.mid * 0.5,
  `top ${band.top.toExponential(1)} vs mid ${band.mid.toExponential(1)}`);

await wake();
await page.click('#btnRain');
await page.waitForTimeout(2500);
const afterRain = await tickRate(4);
check('switching rain off stops it', afterRain < 0.5, `${afterRain.toFixed(2)}/s`);

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `FAIL — ${failed} check(s)` : 'PASS');
process.exit(failed ? 1 : 0);
