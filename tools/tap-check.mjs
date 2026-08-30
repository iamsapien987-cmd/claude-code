/**
 * Tap behaviour, checked against the built page in a real browser engine.
 *
 * This exists because the first version of the tap handler tested a fixed
 * band across the middle of the screen and put the candle out almost wherever
 * you touched - including on the tap you make to bring the hidden controls
 * back. That is not something the physics tests can catch, and it was only
 * found by someone using the app.
 */
import path from 'node:path';
import { launchChromium } from './browser.mjs';

const file = 'file://' + path.resolve(import.meta.dirname, '..', 'dist', 'candle.html');
const browser = await launchChromium();
// hasTouch, because this is a phone app and a tap is not a mouse click:
// a real tap sends pointerdown with no pointermove before it.
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(file);
await page.waitForTimeout(3000);

const lit = () => page.evaluate(() => window.__candle.state.lit);
const uiHidden = () => page.evaluate(() => document.getElementById('ui').classList.contains('dim'));
const relight = () => page.evaluate(() => window.__candle.light());
const idle = async () => {
  // The interface fades after ~4.2 s of stillness.
  await page.waitForTimeout(5200);
};
const tap = async (x, y) => {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(250);
};
/** Where the flame is right now, in CSS pixels. */
const flamePoint = () => page.evaluate(() => {
  const r = window.__candle.renderer;
  const d = r.dpr;
  const wick = r.wax.wickTop;
  const top = r.py(wick + r.lastFlameHeight) / d;
  const bottom = r.py(wick) / d;
  return { x: r.cx / d, y: (top + bottom) / 2 };
});

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// 1. A tap while the controls are hidden must only wake them.
await relight();
await idle();
check('controls hide when idle', await uiHidden());
const f1 = await flamePoint();
await tap(f1.x, f1.y);
check('tap on flame while hidden only wakes, does not snuff', await lit() === true);
check('...and the controls came back', await uiHidden() === false);

// 2. With the controls visible, taps away from the flame do nothing.
for (const [name, x, y] of [
  ['top-left corner', 20, 60],
  ['mid-left', 20, 420],
  ['above the flame', 195, 90],
  ['over the candle body', 195, 700],
]) {
  await page.evaluate(() => window.__candle.light());
  await tap(x, y);
  check(`tap at ${name} leaves the candle lit`, await lit() === true);
}

// 3. A tap on the flame itself does snuff it.
await relight();
await page.waitForTimeout(300);
const f2 = await flamePoint();
await tap(f2.x, f2.y);
check('tap on the flame snuffs it', await lit() === false, `at (${f2.x.toFixed(0)}, ${f2.y.toFixed(0)})`);

await browser.close();
if (errors.length) { console.log('PAGE ERRORS:'); errors.slice(0, 5).forEach((e) => console.log('  ', e)); }
const failed = results.filter((r) => !r.pass).length;
console.log(failed || errors.length ? `FAIL — ${failed} check(s)` : 'PASS');
process.exit(failed || errors.length ? 1 : 0);
