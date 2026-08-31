/**
 * What shape is the flame, actually?
 *
 * Nine recorded dead ends on flame width were all judged on numbers that did
 * not include the width. sweep.mjs reports height, flicker and temperature;
 * calibrate.mjs reports the dial response. Nothing measured how wide the
 * flame is, where it is widest, or whether it tapers - which is most of what
 * is wrong with it.
 *
 * Two things this exists to catch, both of which have already happened once:
 *
 *   - A flame that is wide because the whole column is hot rather than because
 *     it has an envelope. Eddy diffusivity scored 9.6 mm that way and looked
 *     like a cylinder. The width profile up the flame is what tells them
 *     apart: a candle tapers, a heated column does not.
 *   - A flame that is wide and produces no soot. Fast chemistry scores 4.2 mm
 *     and renders as nothing at all, because soot is what glows.
 *
 * Usage: node tools/shape.mjs [key=value ...]
 * Any FlameField property can be overridden, as in calibrate.mjs:
 *   node tools/shape.mjs burnRate=480 sootYield=440
 */
import { FlameField } from '../src/fluid.js';
import { T_SOOT_IGNITION, T_SOOT_GLOW_FLOOR } from '../src/constants.js';

const over = {};
let nx = 40, ny = 130, width = 0.024, secs = 6;
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split('=');
  if (v === undefined) continue;
  const n = Number(v);
  if (k === 'nx') nx = n;
  else if (k === 'ny') ny = n;
  else if (k === 'width') width = n;
  else if (k === 'secs') secs = n;
  else over[k] = n;
}

/** The soot threshold below which a cell contributes nothing you could see. */
const SOOT_VISIBLE = 0.02;

function run(intensity) {
  const h = width / nx;
  const f = new FlameField(nx, ny, h);
  Object.assign(f, over);
  const dt = 1 / 480;
  for (let n = 0; n < 480 * secs; n++) { f.injectFuel(intensity, dt); f.step(dt); }

  const rowWidth = (j, arr, thresh) => {
    let lo = -1, hi = -1;
    for (let i = 1; i < nx - 1; i++) {
      if (arr[i + j * nx] > thresh) { if (lo < 0) lo = i; hi = i; }
    }
    return lo < 0 ? 0 : (hi - lo + 1) * h * 1000;
  };

  let hotW = 0, hotAt = 0, sootW = 0, sootAt = 0, sootTop = 0, glowTop = 0;
  for (let j = 1; j < ny - 1; j++) {
    const a = rowWidth(j, f.T, T_SOOT_IGNITION);
    if (a > hotW) { hotW = a; hotAt = j; }
    const s = rowWidth(j, f.soot, SOOT_VISIBLE);
    if (s > sootW) { sootW = s; sootAt = j; }
    if (s > 0) sootTop = j;
    if (rowWidth(j, f.T, T_SOOT_GLOW_FLOOR) > 0) glowTop = j;
  }

  let sootMass = 0, maxT = 0, maxV = 0;
  for (let k = 0; k < nx * ny; k++) {
    sootMass += f.soot[k];
    if (f.T[k] > maxT) maxT = f.T[k];
    if (Math.abs(f.v[k]) > maxV) maxV = Math.abs(f.v[k]);
  }

  // Vertical speed low down, where residence time decides whether heat has
  // time to reach the fuel-rich core before it is carried away.
  const vAt = (mm) => {
    const j = Math.max(1, Math.round(mm / 1000 / h));
    let best = 0;
    for (let i = 1; i < nx - 1; i++) best = Math.max(best, Math.abs(f.v[i + j * nx]));
    return best;
  };

  // Where the luminous body sits, as a fraction of its own height. A candle
  // is widest between about a fifth and a half of the way up; a plume from a
  // point source is widest at the bottom and only narrows.
  const profile = [0.1, 0.3, 0.5, 0.7, 0.9]
    .map((fr) => rowWidth(Math.max(1, Math.round(sootTop * fr)), f.soot, SOOT_VISIBLE));

  return {
    hotW, hotAtMm: hotAt * h * 1000,
    sootW, sootAtMm: sootAt * h * 1000,
    sootTopMm: sootTop * h * 1000,
    peakFrac: sootTop ? sootAt / sootTop : 0,
    glowTopMm: glowTop * h * 1000, domainMm: ny * h * 1000,
    sootMass, maxT, maxV, v2: vAt(2), v5: vAt(5),
    flameMm: f.flameHeight() * 1000, profile,
  };
}

const keys = Object.keys(over);
console.log(`grid ${nx}x${ny}  domain ${(width * 1000).toFixed(0)}mm wide, ` +
  `${(ny * width / nx * 1000).toFixed(0)}mm tall` +
  (keys.length ? `  overrides: ${keys.map((k) => `${k}=${over[k]}`).join(' ')}` : ''));
console.log('');
console.log('dial   hotW  at     sootW  at    peak%  top/dom      soot   Tmax  Vmax   v@2  v@5   profile 10/30/50/70/90%');

// Low dial is the real test: the last attempt at this produced a decent flame
// at full intensity and no soot at all when turned down.
for (const intensity of [0.25, 0.7, 1.0]) {
  const r = run(intensity);
  console.log(
    intensity.toFixed(2).padStart(4),
    r.hotW.toFixed(1).padStart(6), (r.hotAtMm.toFixed(0) + 'mm').padStart(5),
    r.sootW.toFixed(1).padStart(7), (r.sootAtMm.toFixed(0) + 'mm').padStart(5),
    (100 * r.peakFrac).toFixed(0).padStart(5) + '%',
    (r.glowTopMm.toFixed(0) + '/' + r.domainMm.toFixed(0)).padStart(9),
    r.sootMass.toFixed(1).padStart(7),
    r.maxT.toFixed(0).padStart(6),
    r.maxV.toFixed(2).padStart(5),
    r.v2.toFixed(2).padStart(5), r.v5.toFixed(2).padStart(5),
    '  ' + r.profile.map((w) => w.toFixed(1)).join('/'));
}
