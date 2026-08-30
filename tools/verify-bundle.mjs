/**
 * Load dist/candle.html the way a phone would - straight off the filesystem,
 * no server - and check the simulation is actually running. Concatenating ES
 * modules into one script can break on scoping in ways that only show up at
 * runtime, so this has to load the built artefact, not the sources.
 */
import { chromium } from 'playwright';
import path from 'node:path';

const file = 'file://' + path.resolve(import.meta.dirname, '..', 'dist', 'candle.html');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(file);
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const c = window.__candle;
  if (!c) return { ok: false, why: 'app never started' };
  let peak = 0, nan = 0;
  for (let k = 0; k < c.field.T.length; k++) {
    if (c.field.T[k] > peak) peak = c.field.T[k];
    if (!Number.isFinite(c.field.T[k])) nan++;
  }
  return {
    ok: true,
    peakT: Math.round(peak),
    flameMm: +(c.field.flameHeight() * 1000).toFixed(1),
    candleMm: +(c.wax.centreHeight() * 1000).toFixed(1),
    nan,
    lit: c.state.lit,
  };
});

// The dial and a mode button must respond, or the bundle is a picture.
await page.evaluate(() => window.__candle.setIntensity(0.95));
await page.waitForTimeout(600);
// The interface fades out after a few seconds of stillness, by design, and
// goes pointer-events:none with it. Wake it the way a finger would.
await page.mouse.move(195, 500);
await page.waitForTimeout(200);
await page.click('#btnZen');
await page.waitForTimeout(300);
const zen = await page.evaluate(() => document.getElementById('btnZen').getAttribute('aria-pressed'));

await page.screenshot({ path: path.resolve(import.meta.dirname, '..', 'shots', 'bundle.png') });
await browser.close();

console.log('bundle:', JSON.stringify(state));
console.log('zen toggles:', zen === 'true');
const good = state.ok && state.nan === 0 && state.peakT > 1100 && state.flameMm > 5 && zen === 'true';
if (errors.length) { console.log('ERRORS:'); errors.slice(0, 6).forEach((e) => console.log('  ', e)); }
console.log(good && !errors.length ? 'PASS' : 'FAIL');
process.exit(good && !errors.length ? 0 : 1);
