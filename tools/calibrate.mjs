/**
 * Time-averaged flame behaviour versus the intensity dial.
 *
 * Usage: node tools/calibrate.mjs [key=value ...]
 * Any FlameField property can be overridden, e.g.
 *   node tools/calibrate.mjs fuelBase=20 fuelRange=30 heatPerFuel=1300
 */
import { FlameField } from '../src/fluid.js';

const over = {};
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split('=');
  if (v !== undefined) over[k] = Number(v);
}
console.log(Object.keys(over).length ? Object.entries(over).map(([k, v]) => `${k}=${v}`).join(' ') : '(defaults)');
console.log('  I   height mm   hot mm   soot mm    emission   peak K   maxFuel');
console.log('                (target 7-10)');

for (const I of [0, 0.25, 0.5, 0.75, 1.0]) {
  const f = new FlameField(40, 130, 0.024 / 40);
  Object.assign(f, over);
  const dt = 1 / 480;
  const H = [], E = [], W = [], HW = [];
  let peak = 0, maxZ = 0;
  for (let n = 0; n < 480 * 6; n++) {
    f.injectFuel(I, dt);
    f.step(dt);
    if (n > 480 * 2) {
      H.push(f.flameHeight() * 1000);
      E.push(f.emission());
      let w = 0;
      for (let j = 1; j < f.ny - 1; j++) {
        let row = 0;
        for (let i = 1; i < f.nx - 1; i++) if (f.soot[i + j * f.nx] > 0.02 && f.T[i + j * f.nx] > 900) row++;
        if (row > w) w = row;
      }
      W.push(w * f.h * 1000);
      // Width of the *hot* zone. This is what actually sets how wide the
      // flame looks, and tuning against the soot proxy instead is what sent
      // the earlier parameter sweeps astray.
      let hw = 0;
      for (let j = 1; j < f.ny - 1; j++) {
        let row = 0;
        for (let i = 1; i < f.nx - 1; i++) if (f.T[i + j * f.nx] > 1200) row++;
        if (row > hw) hw = row;
      }
      HW.push(hw * f.h * 1000);
      for (let k = 0; k < f.T.length; k++) {
        if (f.T[k] > peak) peak = f.T[k];
        if (f.fuel[k] > maxZ) maxZ = f.fuel[k];
      }
    }
  }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(
    ` ${I.toFixed(2)}  ${avg(H).toFixed(1).padStart(8)}  ${avg(HW).toFixed(1).padStart(7)}  ${avg(W).toFixed(1).padStart(7)}  ` +
    `${avg(E).toFixed(0).padStart(10)}   ${peak.toFixed(0).padStart(6)}  ${maxZ.toFixed(3)}`
  );
}
