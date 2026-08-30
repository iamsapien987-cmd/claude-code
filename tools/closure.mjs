/**
 * Flame length in this model is where the mixture fraction on the axis falls
 * to stoichiometric: that is the tip, the point at which the last of the fuel
 * finds enough air to burn. Reporting it directly makes the geometry easy to
 * tune against a real candle's ~35-40 mm.
 */
import { FlameField } from '../src/fluid.js';
import { Z_STOICH } from '../src/constants.js';

console.log('wick   dZ        closure at I=0.3 / 0.6 / 1.0 (mm)   width (mm)');
for (const wick of [2.5, 4, 6]) {
  for (const dZ of [4e-5, 1.2e-4, 3e-4, 8e-4]) {
    const out = [];
    let width = 0;
    for (const I of [0.3, 0.6, 1.0]) {
      const f = new FlameField(40, 130, 0.024 / 40);
      f.wickCells = wick; f.dZ = dZ;
      const dt = 1 / 480;
      for (let n = 0; n < 480 * 5; n++) { f.injectFuel(I, dt); f.step(dt); }
      const cx = 20;
      let close = -1;
      for (let j = 1; j < f.ny - 1; j++) {
        if (f.Z[cx + j * f.nx] < Z_STOICH) { close = j * f.h * 1000; break; }
      }
      out.push(close < 0 ? ' >60' : close.toFixed(0).padStart(4));
      if (I === 0.6) {
        for (let j = 1; j < f.ny - 1; j++) {
          let w = 0;
          for (let i = 1; i < f.nx - 1; i++) if (f.Z[i + j * f.nx] > Z_STOICH) w++;
          if (w > width) width = w;
        }
        width *= f.h * 1000;
      }
    }
    console.log(`${String(wick).padStart(4)}   ${dZ.toExponential(1).padStart(8)}   ${out.join('  ')}                ${width.toFixed(1)}`);
  }
}
