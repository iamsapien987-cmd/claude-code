import { FlameField } from '../src/fluid.js';

function run({ nx, ny, width, fuel, cool, rad, vort, inj, secs = 5 }) {
  const h = width / nx;
  const f = new FlameField(nx, ny, h);
  f.coolingRate = cool; f.radiativeCooling = rad; f.vorticityEps = vort;
  const dt = 1 / 480;
  const series = [];
  const heights = [];
  let maxT = 0, maxV = 0;
  const origInject = f.injectFuel.bind(f);
  for (let n = 0; n < 480 * secs; n++) {
    // scale the fuel injection knob
    const save = f.fuel.slice();
    origInject(1.0, dt);
    for (let k = 0; k < f.fuel.length; k++) f.fuel[k] = save[k] + (f.fuel[k] - save[k]) * fuel;
    f.step(dt);
    if (n > 480 * 2) {
      series.push(f.emission());
      heights.push(f.flameHeight() * 1000);
      for (let k = 0; k < nx * ny; k++) {
        if (f.T[k] > maxT) maxT = f.T[k];
        if (Math.abs(f.v[k]) > maxV) maxV = Math.abs(f.v[k]);
      }
    }
  }
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const rms = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length);
  // Puffing frequency is conventionally measured from the flame-height signal.
  const sig = heights, N = sig.length, fs = 480;
  const sigMean = hArr => hArr.reduce((a, b) => a + b, 0) / hArr.length;
  const smean = sigMean(sig);
  let best = { f: 0, mag: 0 };
  for (let bin = 1; bin < 400; bin++) {
    const freq = bin * fs / N;
    if (freq < 3 || freq > 45) continue;
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const a = -2 * Math.PI * bin * n / N, s = sig[n] - smean;
      re += s * Math.cos(a); im += s * Math.sin(a);
    }
    const mag = Math.hypot(re, im);
    if (mag > best.mag) best = { f: freq, mag };
  }
  const hMean = heights.reduce((a, b) => a + b, 0) / heights.length;
  const hRms = Math.sqrt(heights.reduce((a, b) => a + (b - hMean) ** 2, 0) / heights.length);
  return { T: maxT, V: maxV, H: hMean, Hsd: hRms, Hz: best.f, depth: 100 * rms / mean };
}

const base = { nx: 40, ny: 100, width: 0.024, fuel: 1, cool: 7, rad: 9e-11, vort: 1.15, inj: 2.0 };
const trials = [
  ['base 3.5cm',          {}],
  ['less fuel',           { fuel: 0.6 }],
  ['less fuel + cool',    { fuel: 0.6, cool: 11 }],
  ['much less fuel',      { fuel: 0.4, cool: 11 }],
  ['tight wick',          { fuel: 0.5, cool: 11, inj: 1.5 }],
  ['tight + more rad',    { fuel: 0.5, cool: 11, rad: 1.6e-10, inj: 1.5 }],
  ['narrow domain 2.5cm', { fuel: 0.5, cool: 11, rad: 1.6e-10, inj: 1.5, width: 0.025 }],
];
console.log('case'.padEnd(22), 'Tmax'.padStart(6), 'Vmax'.padStart(6), 'H mm'.padStart(7), 'sd'.padStart(6), 'Hz'.padStart(6), 'flick%'.padStart(7));
for (const [name, over] of trials) {
  const r = run({ ...base, ...over });
  console.log(name.padEnd(22), r.T.toFixed(0).padStart(6), r.V.toFixed(2).padStart(6),
    r.H.toFixed(1).padStart(7), r.Hsd.toFixed(1).padStart(6),
    r.Hz.toFixed(1).padStart(6), r.depth.toFixed(0).padStart(7));
}
