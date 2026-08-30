import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const s = http.createServer((q, r) => {
  const t = q.url === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, q.url.split('?')[0]);
  fs.readFile(t, (e, b) => { if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': T[path.extname(t)] || 'application/octet-stream' }); r.end(b); });
});
await new Promise((r) => s.listen(0, r));
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e));
await p.goto('http://127.0.0.1:' + s.address().port + '/');
await p.waitForTimeout(3000);
console.log(await p.evaluate(() => {
  const c = window.__candle, f = c.field;
  const em = [];
  for (let i = 0; i < 60; i++) em.push(f.emission());
  let maxT = 0, maxSoot = 0, hot = 0, topJ = 0;
  for (let j = 1; j < f.ny - 1; j++) for (let i = 1; i < f.nx - 1; i++) {
    const k = i + j * f.nx;
    if (f.T[k] > maxT) maxT = f.T[k];
    if (f.soot[k] > maxSoot) maxSoot = f.soot[k];
    if (f.T[k] > 1000) { hot++; topJ = Math.max(topJ, j); }
  }
  const probe = [0, 1, 5, 20, 50, 111].map((j) => +f.T[24 + j * f.nx].toFixed(1));
  const fuelProbe = [1, 3, 5, 10].map((j) => +f.fuel[24 + j * f.nx].toFixed(4));
  return { probeT: probe, probeFuel: fuelProbe, wickTop: c.wax.wickTop,
    nx: f.nx, ny: f.ny, h: f.h, Tlen: f.T.length, lit: c.state.lit,
    emission: Math.round(f.emission()), smoothed: Math.round(c.renderer.smoothed),
    maxT: Math.round(maxT), maxSoot: +maxSoot.toFixed(3), hotCells: hot,
    flameTopMm: +(topJ * f.h * 1000).toFixed(1), intensity: c.state.intensity };
}));
await b.close(); s.close();
