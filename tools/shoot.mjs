/**
 * Headless render check. Boots the app in Chromium at phone dimensions,
 * lets the simulation settle, and captures frames so the visuals can be
 * reviewed without a device in hand.
 */
import { launchChromium } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  const target = req.url === '/' ? path.join(ROOT, 'index.html') : file;
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

const outDir = path.join(ROOT, process.env.OUT || 'shots');
fs.mkdirSync(outDir, { recursive: true });

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const shots = JSON.parse(process.env.SHOTS || '[["default",0.7,900]]');
for (const [name, intensity, settle] of shots) {
  await page.evaluate((i) => window.__candle.setIntensity(i), intensity);
  await page.waitForTimeout(settle);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
}

const stats = await page.evaluate(() => {
  const c = window.__candle;
  return {
    flameHeightMm: +(c.field.flameHeight() * 1000).toFixed(1),
    peakT: Math.round(Math.max(...c.field.T)),
    candleMm: +(c.wax.centreHeight() * 1000).toFixed(1),
    poolMm: +(c.wax.poolRadius * 1000).toFixed(1),
    drips: c.wax.drips.length + c.wax.frozen.length,
    lit: c.state.lit,
  };
});
console.log('render stats:', JSON.stringify(stats));
if (errors.length) { console.log('PAGE ERRORS:'); errors.slice(0, 8).forEach((e) => console.log('  ', e)); }

await browser.close();
server.close();
