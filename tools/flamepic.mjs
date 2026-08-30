/**
 * Headless flame image: runs the solver, maps it through the exact rasteriser
 * the app uses, and writes a PPM. Judging the flame's shape and colour this
 * way is far quicker than launching a browser for every tweak.
 *
 * Usage: node tools/flamepic.mjs <intensity> <seconds> <out.ppm> [key=value ...]
 */
import { FlameField } from '../src/fluid.js';
import { FlameRasteriser } from '../src/flamecolor.js';
import fs from 'node:fs';

const I = Number(process.argv[2] ?? 0.7);
const secs = Number(process.argv[3] ?? 6);
const out = process.argv[4] ?? 'shots/flame.ppm';
const UP = 6;

const f = new FlameField(40, 100, 0.024 / 40);
for (const arg of process.argv.slice(5)) {
  const [k, v] = arg.split('=');
  if (v !== undefined) f[k] = Number(v);
}

const dt = 1 / 480;
for (let n = 0; n < 480 * secs; n++) { f.injectFuel(I, dt); f.step(dt); }

const raster = new FlameRasteriser(f.nx, f.ny);
const rgba = new Uint8ClampedArray(f.nx * f.ny * 4);
raster.raster(f, rgba);

const W = f.nx * UP, H = f.ny * UP;
const buf = Buffer.alloc(W * H * 3);
for (let y = 0; y < f.ny; y++) {
  for (let x = 0; x < f.nx; x++) {
    const o = (x + y * f.nx) * 4;
    for (let dy = 0; dy < UP; dy++) {
      for (let dx = 0; dx < UP; dx++) {
        const t = ((y * UP + dy) * W + x * UP + dx) * 3;
        buf[t] = rgba[o]; buf[t + 1] = rgba[o + 1]; buf[t + 2] = rgba[o + 2];
      }
    }
  }
}
fs.mkdirSync('shots', { recursive: true });
fs.writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), buf]));

let maxR = 0, maxG = 0, maxB = 0;
for (let k = 0; k < rgba.length; k += 4) {
  if (rgba[k] > maxR) maxR = rgba[k];
  if (rgba[k + 1] > maxG) maxG = rgba[k + 1];
  if (rgba[k + 2] > maxB) maxB = rgba[k + 2];
}
let maxSoot = 0, maxT = 0;
for (let k = 0; k < f.T.length; k++) {
  if (f.soot[k] > maxSoot) maxSoot = f.soot[k];
  if (f.T[k] > maxT) maxT = f.T[k];
}
console.log(`I=${I} maxT=${maxT.toFixed(0)}K maxSoot=${maxSoot.toFixed(3)} h=${(f.flameHeight() * 1000).toFixed(1)}mm peakRGB=(${maxR},${maxG},${maxB}) -> ${out}`);
