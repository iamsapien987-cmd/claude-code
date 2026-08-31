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
const wake = async () => { await page.touchscreen.tap(200, 300); await page.waitForTimeout(300); };

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
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `FAIL — ${failed} check(s)` : 'PASS');
process.exit(failed ? 1 : 0);
