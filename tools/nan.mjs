import { chromium } from 'playwright';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = '/home/user/claude-code';
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
await p.waitForTimeout(800);
console.log(await p.evaluate(() => {
  const c = window.__candle, f = c.field, log = [];
  const nan = () => { let n = 0; for (let k = 0; k < f.T.length; k++) if (Number.isNaN(f.T[k])) n++; return n; };
  f.reset(); f.windX = 0; f.windY = 0;
  for (let i = 0; i < 200; i++) { f.injectFuel(24, 2.0, 0.7, 1 / 480); f.step(1 / 480); }
  log.push('primed nanT=' + nan());
  c.air.update(1 / 60); log.push('air ' + nan() + ' windX=' + c.air.windX());
  f.windX = c.air.windX(); f.windY = c.air.windY();
  f.injectFuel(24, 2.0, 0.7, 1 / 480); log.push('inject ' + nan());
  f.step(1 / 480); log.push('step ' + nan());
  c.wax.update(1 / 60, 0.7, true); log.push('wax ' + nan() + ' wickTop=' + c.wax.wickTop);
  c.renderer.draw(c.state); log.push('draw ' + nan());
  return log;
}));
await b.close(); s.close();
