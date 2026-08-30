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

/** The relight ring's centre and size in CSS pixels, or null if not shown. */
const relightBox = () => page.evaluate(() => {
  const b = document.getElementById('relight');
  if (b.hidden) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
});
/** Where the wick is right now, in CSS pixels. */
const wickPoint = () => page.evaluate(() => {
  const r = window.__candle.renderer;
  return { x: r.cx / r.dpr, y: r.py(r.wax.wickTop) / r.dpr };
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

// 3b. Snuffing low on the flame lands exactly where the relight ring is about
//     to appear. The click belonging to that same tap must not light it again
//     - it did, and only for taps below about y=400, which is why this is
//     pinned at a fixed offset from the wick rather than left to the flicker.
await relight();
await page.waitForTimeout(400);
const nearWick = await wickPoint();
await tap(nearWick.x, nearWick.y - 20);
check('snuffing low on the flame does not instantly relight it', await lit() === false,
  `tapped (${nearWick.x.toFixed(0)}, ${(nearWick.y - 20).toFixed(0)})`);

// 4. The dial responds to a vertical drag, and its pointer follows.
await relight();
await page.evaluate(() => window.__candle.setIntensity(0.5));
const dial = await page.locator('#dial').boundingBox();
const cx = dial.x + dial.width / 2;
const cy = dial.y + dial.height / 2;
const readDial = () => page.evaluate(() => ({
  v: window.__candle.state.intensity,
  angle: document.getElementById('dial').style.getPropertyValue('--angle'),
}));

const before = await readDial();
// Drag upward: brighter.
await page.touchscreen.tap(cx, cy);   // wake the interface
await page.waitForTimeout(200);
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx, cy - 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const up = await readDial();
check('dragging the dial up raises the flame', up.v > before.v + 0.2,
  `${before.v.toFixed(2)} -> ${up.v.toFixed(2)}`);
check('the pointer moves with it', up.angle !== before.angle, `${before.angle} -> ${up.angle}`);

// Drag downward: dimmer.
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx, cy + 60, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const down = await readDial();
check('dragging the dial down lowers the flame', down.v < up.v - 0.2,
  `${up.v.toFixed(2)} -> ${down.v.toFixed(2)}`);

// 5. Screen lock blocks input and hides everything; double-tap releases it.
await relight();
await page.click('#btnLock');
await page.waitForTimeout(400);
check('locking hides the interface', await uiHidden());
const f3 = await flamePoint();
await tap(f3.x, f3.y);
check('a tap while locked does nothing', await lit() === true);
await page.touchscreen.tap(200, 400);
await page.waitForTimeout(80);
await page.touchscreen.tap(200, 400);
await page.waitForTimeout(400);
check('double-tap unlocks', await page.evaluate(() => window.__candle.state.locked) === false);

// 6. A snuffed candle takes the screen to black, and only a deliberate double
//    tap brings it back - the user asked for the dark to stay.
await relight();
await page.waitForTimeout(300);
await page.evaluate(() => window.__candle.extinguish(null));
await idle();
check('the screen sleeps once the candle is out', await uiHidden());
await tap(120, 300);
check('a single tap does not wake a dark screen', await uiHidden() === true);
// Clear of the double-tap window, so the pair below is unambiguous.
await page.waitForTimeout(600);
await page.touchscreen.tap(120, 300);
await page.waitForTimeout(80);
await page.touchscreen.tap(120, 300);
await page.waitForTimeout(400);
check('a double tap wakes it', await uiHidden() === false);

// 7. The way to light it again is marked, sits on the wick, and works.
const ring = await relightBox();
const wick = await wickPoint();
check('the relight ring is showing', ring !== null);
if (ring) {
  check('...centred on the wick', Math.abs(ring.x - wick.x) < 8 && Math.abs(ring.y - wick.y) < 8,
    `ring (${ring.x.toFixed(0)}, ${ring.y.toFixed(0)}) vs wick (${wick.x.toFixed(0)}, ${wick.y.toFixed(0)})`);
  check('...with a touch target of at least 56px', ring.w >= 56 && ring.h >= 56,
    `${ring.w}x${ring.h}`);
  await tap(ring.x, ring.y);
  check('tapping the ring lights the candle', await lit() === true);
  check('...and the ring goes away', await relightBox() === null);
}

await browser.close();
if (errors.length) { console.log('PAGE ERRORS:'); errors.slice(0, 5).forEach((e) => console.log('  ', e)); }
const failed = results.filter((r) => !r.pass).length;
console.log(failed || errors.length ? `FAIL — ${failed} check(s)` : 'PASS');
process.exit(failed || errors.length ? 1 : 0);
