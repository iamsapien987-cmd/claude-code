/** Horizontal slices through the flame, to see what is actually narrow. */
import { FlameField } from '../src/fluid.js';
const f = new FlameField(40, 130, 0.024 / 40);
const dt = 1 / 480;
for (let n = 0; n < 480 * 6; n++) { f.injectFuel(0.6, dt); f.step(dt); }
const rows = [3, 8, 16, 26, 38];
const bar = (v, max, w = 22) => '#'.repeat(Math.round(Math.min(1, v / max) * w));
for (const j of rows) {
  const mm = (j * f.h * 1000).toFixed(1);
  let line = `--- y=${mm}mm ---\n`;
  for (const [name, arr, max] of [['T   ', f.T, 1800], ['fuel', f.fuel, 0.02],
                                   ['ox  ', f.ox, 1], ['soot', f.soot, 0.15], ['v   ', f.v, 2]]) {
    let s = '';
    for (let i = 10; i < 38; i++) {
      const val = name === 'T   ' ? Math.max(0, arr[i + j * f.nx] - 293) / 1500 : arr[i + j * f.nx] / max;
      s += val > 0.75 ? '#' : val > 0.45 ? '+' : val > 0.18 ? '.' : val > 0.03 ? ',' : ' ';
    }
    line += `  ${name} |${s}|\n`;
  }
  console.log(line);
}
