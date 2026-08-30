/**
 * Mapping simulation state to flame colour.
 *
 * Kept separate from the renderer so it can be exercised headlessly (see
 * tools/flamepic.mjs) - the look of the flame is the thing most worth
 * iterating on, and doing that through a browser screenshot each time is
 * needlessly slow.
 *
 * A candle flame has two distinct emitters stacked on top of each other:
 *
 *  - Soot incandescence. Carbon particles formed on the fuel-rich side of
 *    the flame sheet glow as near-blackbodies at 1100-1700 K. This is almost
 *    all of the visible light and all of the yellow.
 *  - Chemiluminescence. At the base, where oxygen is plentiful and there is
 *    not yet any soot, excited CH and C2 radicals emit in narrow bands around
 *    430 and 516 nm. That light is blue and does not lie on the blackbody
 *    locus at all, so it cannot come from the same lookup.
 *
 * How much of the soot's light reaches the eye depends on how much soot is
 * in the way, which is the Beer-Lambert optical depth: 1 - exp(-k * c).
 */

import { buildTemperatureLUT, lutIndex } from './blackbody.js';
import { T_SOOT_GLOW_FLOOR } from './constants.js';
import { AbelProjector } from './abel.js';

export const LUT = buildTemperatureLUT();

/** Soot column density that makes the flame optically thick. */
export const SOOT_OPACITY = 26;
/** Temperature span, above the soot glow point, that saturates the emission. */
export const GLOW_SPAN = 700;
/**
 * How strongly the blue reaction zone shows through. The blue base of a
 * candle is real but small - a few millimetres at the very bottom - and it
 * is easy to overdo to the point where the whole flame turns lilac.
 */
export const BLUE_GAIN = 34;

/**
 * Fraction of the peak reaction rate below which the blue zone is not drawn.
 * Without it the whole flame sheet outlines itself in blue from wick to tip,
 * because there is a reaction everywhere along it. On a real candle only the
 * base looks blue: that is where air entrained from below meets fuel before
 * any soot has formed to sit in front of it.
 */
export const BLUE_THRESHOLD = 0.42;

/**
 * Exposure applied after projection, then a Reinhard roll-off.
 *
 * Emission along a ray is an unbounded quantity and a flame covers a huge
 * dynamic range: the core is orders of magnitude brighter than the tip. Both
 * a camera and the eye compress that, and the compression is why a flame
 * photograph has a white-hot centre fading through yellow to a dim red edge
 * rather than a flat orange shape. Clipping instead of rolling off would
 * posterise the core into a hard-edged blob.
 */
export const EXPOSURE = 2.6;

/** Reinhard tone map on a 0-255 scale, with exposure applied first. */
export function toneMap(v) {
  const x = (v / 255) * EXPOSURE;
  return 255 * (x / (1 + x));
}

/**
 * Emitted colour of one cell, written into `out` as three 0-255 values.
 * `out` is reused by the caller to avoid allocating per pixel.
 */
export function flamePixel(T, soot, rate, out) {
  let r = 0, g = 0, b = 0;

  if (T > T_SOOT_GLOW_FLOOR && soot > 0) {
    // Beer-Lambert: an optically thick region radiates as a blackbody, a thin
    // one in proportion to how much soot it holds.
    const tau = 1 - Math.exp(-SOOT_OPACITY * soot);
    const bright = Math.min(1, Math.pow((T - T_SOOT_GLOW_FLOOR) / GLOW_SPAN, 1.25));
    const e = tau * bright;
    if (e > 0.002) {
      const li = lutIndex(T) * 3;
      r = LUT[li] * e;
      g = LUT[li + 1] * e;
      b = LUT[li + 2] * e;
    }
  }

  // The blue zone is only visible where soot has not yet formed to hide it.
  if (rate > 1e-6) {
    const strength = (Math.min(1, rate * BLUE_GAIN) - BLUE_THRESHOLD) / (1 - BLUE_THRESHOLD);
    const blue = Math.max(0, strength) * Math.exp(-soot * 60);
    r += blue * 26;
    g += blue * 88;
    b += blue * 200;
  }

  out[0] = r > 255 ? 255 : r;
  out[1] = g > 255 ? 255 : g;
  out[2] = b > 255 ? 255 : b;
  return out;
}

export class FlameRasteriser {
  constructor(nx, ny) {
    this.nx = nx;
    this.ny = ny;
    this.half = nx >> 1;
    this.abel = new AbelProjector(this.half);
    this.radial = [new Float32Array(this.half), new Float32Array(this.half), new Float32Array(this.half)];
    this.proj = [new Float32Array(this.half), new Float32Array(this.half), new Float32Array(this.half)];
    this.px = [0, 0, 0];
  }

  /**
   * @param {object} field  the FlameField
   * @param {Uint8ClampedArray} data  RGBA output, nx*ny*4, row 0 at the top
   */
  raster(field, data) {
    const { nx, ny, half, radial, proj, px } = this;
    const cx = half;
    for (let j = 0; j < ny; j++) {
      // Collapse the slice to a radial emission profile. Both halves of the
      // row sample the same radii, so averaging them halves the noise.
      for (let r = 0; r < half; r++) {
        const iL = cx - 1 - r;
        const iR = cx + r;
        let R = 0, G = 0, B = 0;
        if (iL >= 0) {
          const k = iL + j * nx;
          flamePixel(field.T[k], field.soot[k], field.rate[k], px);
          R += px[0]; G += px[1]; B += px[2];
        }
        if (iR < nx) {
          const k = iR + j * nx;
          flamePixel(field.T[k], field.soot[k], field.rate[k], px);
          R += px[0]; G += px[1]; B += px[2];
        }
        radial[0][r] = R * 0.5;
        radial[1][r] = G * 0.5;
        radial[2][r] = B * 0.5;
      }
      for (let c = 0; c < 3; c++) this.abel.project(radial[c], proj[c]);

      const row = (ny - 1 - j) * nx * 4;   // grid j=0 is the wick, image y=0 is the top
      for (let r = 0; r < half; r++) {
        const R = toneMap(proj[0][r]), G = toneMap(proj[1][r]), B = toneMap(proj[2][r]);
        for (const i of [cx - 1 - r, cx + r]) {
          if (i < 0 || i >= nx) continue;
          const o = row + i * 4;
          data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = 255;
        }
      }
    }
  }
}
