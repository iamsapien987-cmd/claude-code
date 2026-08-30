import { FlameField } from '../src/fluid.js';
import { T_AMBIENT } from '../src/constants.js';

const nx = 40, ny = 100, h = 0.024 / nx; // 2.4 cm wide domain
const f = new FlameField(nx, ny, h);
const dt = 1 / 480;                       // 8 substeps at 60 fps
const series = [];
let maxT = 0, maxV = 0;

for (let n = 0; n < 480 * 6; n++) {       // 6 seconds
  f.injectFuel(1.0, dt);
  f.step(dt);
  if (n > 480 * 2) {                      // let it settle first
    series.push(f.emission());
    for (let k = 0; k < nx * ny; k++) {
      if (f.T[k] > maxT) maxT = f.T[k];
      if (Math.abs(f.v[k]) > maxV) maxV = Math.abs(f.v[k]);
    }
  }
}

const mean = series.reduce((a, b) => a + b, 0) / series.length;
const rms = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length);

// Dominant flicker frequency via a small DFT of the emission signal.
const N = series.length, fs = 480;
let best = { f: 0, mag: 0 };
for (let bin = 1; bin < 200; bin++) {
  const freq = bin * fs / N;
  if (freq < 2 || freq > 40) continue;
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) {
    const a = -2 * Math.PI * bin * n / N;
    const s = series[n] - mean;
    re += s * Math.cos(a); im += s * Math.sin(a);
  }
  const mag = Math.hypot(re, im);
  if (mag > best.mag) best = { f: freq, mag };
}

console.log('peak temperature      ', maxT.toFixed(0), 'K   (soot glows 1100-1700 K)');
console.log('peak gas velocity     ', maxV.toFixed(2), 'm/s (real candle ~1-3 m/s)');
console.log('luminous flame height ', (f.flameHeight() * 1000).toFixed(1), 'mm  (real ~40 mm)');
console.log('flicker frequency     ', best.f.toFixed(1), 'Hz  (real 10-15 Hz)');
console.log('flicker depth         ', (100 * rms / mean).toFixed(1), '% RMS');
