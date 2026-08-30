import { launchChromium } from './browser.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const s = http.createServer((q, r) => {
  const t = q.url === '/' ? path.join(ROOT, 'index.html') : path.join(ROOT, q.url.split('?')[0]);
  fs.readFile(t, (e, b) => { if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': T[path.extname(t)] || 'application/octet-stream' }); r.end(b); });
});
await new Promise((r) => s.listen(0, r));
const b = await launchChromium();
const p = await b.newPage({ viewport: { width: 390, height: 844 } });
p.on('pageerror', (e) => console.log('PAGEERROR', e));
await p.addInitScript(() => {
  window.__fps = { frames: 0, t0: performance.now() };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { window.__fps.frames++; cb(t); });
  // Count how many substeps and how much fuel actually reach the solver.
  window.__acc = { steps: 0, injects: 0, fuelSum: 0, frames: 0 };
});
await p.goto('http://127.0.0.1:' + s.address().port + '/');
await p.waitForTimeout(300);
await p.evaluate(() => {
  const f = window.__candle.field;
  const origStep = f.step.bind(f);
  f.step = (dt) => { window.__acc.steps++; return origStep(dt); };
  const origInj = f.injectFuel.bind(f);
  f.injectFuel = (cx, r, st, dt) => { window.__acc.injects++; window.__acc.fuelSum += st; return origInj(cx, r, st, dt); };
});
console.log('t(s)  height  emission  peakT  fps  substeps/frame');
for (let i = 0; i < 8; i++) {
  await p.waitForTimeout(1000);
  console.log(await p.evaluate((i) => {
    const c = window.__candle, f = c.field;
    let peak = 0; for (let k = 0; k < f.T.length; k++) if (f.T[k] > peak) peak = f.T[k];
    const el = (performance.now() - window.__fps.t0) / 1000;
    const fps = window.__fps.frames / el;
    const a = window.__acc;
    const line = `${(i + 1).toString().padStart(4)}  ${(f.flameHeight() * 1000).toFixed(1).padStart(6)}  ` +
      `${f.emission().toFixed(0).padStart(8)}  ${peak.toFixed(0).padStart(5)}  ${fps.toFixed(1).padStart(5)}` +
      `   steps=${a.steps} inj=${a.injects} meanFuel=${(a.fuelSum / Math.max(1, a.injects)).toFixed(2)}` +
      ` lit=${window.__candle.state.lit} windX=${f.windX.toFixed(3)}`;
    window.__acc = { steps: 0, injects: 0, fuelSum: 0, frames: 0 };
    return line;
  }, i));
}
await b.close(); s.close();
