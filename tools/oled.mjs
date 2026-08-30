/**
 * OLED audit.
 *
 * On an OLED panel a black pixel is switched off: it emits nothing and costs
 * nothing. So for a candle in a dark room the correct picture is not "mostly
 * dark" but *actually black* everywhere the flame is not lighting something.
 * Anything else is the screen glowing on its own account, which both breaks
 * the illusion in a dark room and burns battery.
 *
 * Reports how much of the frame is truly off, and an estimate of relative
 * panel power. OLED draw goes roughly as the sum of per-channel luminance,
 * with blue the most expensive and green the least, so the weights are the
 * usual approximation for emission cost rather than perceived brightness.
 */
import { launchChromium } from './browser.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const t = url === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, url);
  fs.readFile(t, (e, b) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(t)] || 'application/octet-stream' });
    res.end(b);
  });
});
await new Promise((r) => server.listen(0, r));

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`http://127.0.0.1:${server.address().port}/?i=${process.env.I || 0.6}`);
await page.waitForTimeout(4500);
await page.evaluate(() => window.__candle.setIntensity(Number(new URL(location.href).searchParams.get('i') || 0.6)));
await page.waitForTimeout(1500);
// Let the interface fade, so we are auditing the scene and not the controls.
await page.waitForTimeout(4500);

const raw = await page.evaluate(() => {
  const c = document.getElementById('stage');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, c.height).data;
  return { w: c.width, h: c.height, data: Array.from(d) };
});

const { w, h, data } = raw;
let off = 0, nearOff = 0, sumPower = 0, maxL = 0;
const corners = [];
for (let i = 0; i < data.length; i += 4) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  if (r === 0 && g === 0 && b === 0) off++;
  else if (r <= 2 && g <= 2 && b <= 2) nearOff++;
  // Relative emission cost per subpixel.
  sumPower += 0.30 * r + 0.22 * g + 0.48 * b;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (l > maxL) maxL = l;
}
const px = w * h;
const at = (x, y) => {
  const i = (y * w + x) * 4;
  return `(${data[i]},${data[i + 1]},${data[i + 2]})`;
};
console.log(`frame ${w}x${h}`);
console.log(`pixels fully off      ${(100 * off / px).toFixed(1)}%`);
console.log(`pixels <=2/255        ${(100 * (off + nearOff) / px).toFixed(1)}%`);
console.log(`mean emission cost    ${(sumPower / px).toFixed(1)} / 255`);
console.log(`peak luminance        ${maxL.toFixed(0)} / 255`);
console.log(`corners  TL ${at(2, 2)}  TR ${at(w - 3, 2)}  BL ${at(2, h - 3)}  BR ${at(w - 3, h - 3)}`);
console.log(`edges    top-mid ${at(w >> 1, 2)}  left-mid ${at(2, h >> 1)}  right-mid ${at(w - 3, h >> 1)}`);

await browser.close();
server.close();

// Fail rather than merely report. The whole point is that the frame has
// regions that are genuinely off, and a stray full-screen gradient added
// later would quietly undo that without changing how the app looks on a
// backlit display.
const isBlack = (x, y) => {
  const i = (y * w + x) * 4;
  return data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0;
};
const probes = [
  ['top-left', 2, 2], ['top-right', w - 3, 2],
  ['bottom-left', 2, h - 3], ['bottom-right', w - 3, h - 3],
  ['top-middle', w >> 1, 2], ['left-middle', 2, h >> 1], ['right-middle', w - 3, h >> 1],
];
const lit = probes.filter(([, x, y]) => !isBlack(x, y));
const offFraction = off / px;
const problems = [];
if (lit.length) problems.push(`lit where it should be off: ${lit.map(([n]) => n).join(', ')}`);
if (offFraction < 0.35) problems.push(`only ${(100 * offFraction).toFixed(1)}% of the frame is off`);
if (problems.length) {
  console.log('FAIL — ' + problems.join('; '));
  process.exit(1);
}
console.log('PASS — the panel is off wherever the flame is not lighting anything');
