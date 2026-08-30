/**
 * Forward Abel projection: turning an axisymmetric radial slice into the
 * image a camera would actually record.
 *
 * The solver works on a two-dimensional slice through the flame's axis, so
 * `T` and `soot` at column i are values *at that radius*. A photograph is not
 * a slice. Light reaching one pixel has travelled a chord straight through
 * the whole three-dimensional flame, picking up emission from every radius
 * the chord crosses. For an axisymmetric source that line integral is the
 * forward Abel transform,
 *
 *     P(x) = 2 * integral from r=|x| to R of  eps(r) * r / sqrt(r^2 - x^2) dr
 *
 * Flame diagnostics run this backwards - Abel inversion - to recover a radial
 * emission profile from a photograph of a flame. Running it forwards is how
 * we get from the simulated profile to something that looks photographed.
 *
 * Two things fall out of it for free, and both are visible in any real
 * photograph of a candle:
 *
 *  - the flame appears wider than the slice, because off-axis chords still
 *    cut through emitting material;
 *  - limb brightening, the bright rim just inside the flame's edge, where the
 *    chord runs a long way tangentially through the luminous shell.
 *
 * The weights depend only on geometry, so they are built once.
 */

/** Precomputed chord weights for one half-width of `n` radial samples. */
export class AbelProjector {
  /**
   * @param {number} n          radial samples from the axis to the edge
   * @param {number} refRadius  radius, in cells, used to normalise the result
   */
  constructor(n, refRadius = 3) {
    this.n = n;
    // For each projected offset x, the radii it crosses and their weights.
    this.offsets = [];
    for (let x = 0; x < n; x++) {
      const idx = [];
      const w = [];
      for (let r = x; r < n; r++) {
        // Analytic integral of r / sqrt(r^2 - x^2) across the cell [r, r+1],
        // which stays finite at the r = x singularity where a naive
        // midpoint sample would blow up.
        const lo = Math.max(r, x);
        const hi = r + 1;
        const a = Math.sqrt(Math.max(0, hi * hi - x * x));
        const b = Math.sqrt(Math.max(0, lo * lo - x * x));
        const weight = 2 * (a - b);
        if (weight > 1e-6) { idx.push(r); w.push(weight); }
      }
      this.offsets.push({ idx: Int32Array.from(idx), w: Float32Array.from(w) });
    }
    // The transform has units of emission times length, so it needs a
    // reference path to divide by. Using the whole domain width would make
    // brightness depend on how much empty air happened to be simulated. The
    // meaningful scale is the chord straight through the flame's luminous
    // core, about 4 mm, which keeps projected brightness on the same footing
    // as the slice it came from.
    const ref = 2 * refRadius;
    for (const o of this.offsets) for (let k = 0; k < o.w.length; k++) o.w[k] /= ref;
  }

  /**
   * Project one radial profile into one image row.
   * @param {Float32Array} radial  emission per radius, length >= n
   * @param {Float32Array} out     projected values, length n
   */
  project(radial, out) {
    for (let x = 0; x < this.n; x++) {
      const { idx, w } = this.offsets[x];
      let sum = 0;
      for (let k = 0; k < idx.length; k++) sum += radial[idx[k]] * w[k];
      out[x] = sum;
    }
  }
}
