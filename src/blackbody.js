/**
 * Blackbody radiation -> sRGB.
 *
 * The colour of a candle flame is not a design choice, it is the incandescence
 * of soot particles at 1100-1700 K. Rather than hand-picking oranges we
 * integrate Planck's law against the CIE 1931 colour matching functions and
 * convert the result to sRGB. The gradient this produces (deep red tip ->
 * amber body -> near-white core) is the reason the flame reads as fire instead
 * of as a yellow shape.
 *
 * The colour matching functions use the multi-lobe Gaussian fits from
 * Wyman, Sloan & Shirley, "Simple Analytic Approximations to the CIE XYZ
 * Colour Matching Functions", JCGT 2 (2013). They are accurate to well under
 * a perceptual JND, which is far more than we need.
 */

const H = 6.62607015e-34;  // J s, Planck constant
const C = 2.99792458e8;    // m/s, speed of light
const KB = 1.380649e-23;   // J/K, Boltzmann constant

/** Piecewise Gaussian with different widths either side of the peak. */
function pieceGauss(x, mu, s1, s2) {
  const t = (x - mu) * (x < mu ? 1 / s1 : 1 / s2);
  return Math.exp(-0.5 * t * t);
}

function cieX(l) {
  return 1.056 * pieceGauss(l, 599.8, 37.9, 31.0)
       + 0.362 * pieceGauss(l, 442.0, 16.0, 26.7)
       - 0.065 * pieceGauss(l, 501.1, 20.4, 26.2);
}
function cieY(l) {
  return 0.821 * pieceGauss(l, 568.8, 46.9, 40.5)
       + 0.286 * pieceGauss(l, 530.9, 16.3, 31.1);
}
function cieZ(l) {
  return 1.217 * pieceGauss(l, 437.0, 11.8, 36.0)
       + 0.681 * pieceGauss(l, 459.0, 26.0, 13.8);
}

/** Planck spectral radiance at wavelength `lambdaNm` (nm) and temperature T (K). */
export function planck(lambdaNm, T) {
  const l = lambdaNm * 1e-9;
  const a = (2 * H * C * C) / Math.pow(l, 5);
  const b = Math.exp((H * C) / (l * KB * T)) - 1;
  return a / b;
}

/** Integrate Planck's law against the CIE observer. Returns unnormalised XYZ. */
export function blackbodyXYZ(T) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const p = planck(l, T);
    X += p * cieX(l);
    Y += p * cieY(l);
    Z += p * cieZ(l);
  }
  return [X * 5, Y * 5, Z * 5];
}

/** Linear-light sRGB primaries (sRGB / Rec.709, D65 white). */
export function xyzToLinearSrgb([X, Y, Z]) {
  return [
     3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
     0.0557 * X - 0.2040 * Y + 1.0570 * Z,
  ];
}

/** sRGB electro-optical transfer function (gamma encode). */
export function encodeSrgb(c) {
  const v = Math.max(0, Math.min(1, c));
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Chromaticity of a blackbody at T, normalised so the brightest channel is 1.
 * Intensity is kept separate from hue so the renderer can scale emission
 * without desaturating the colour.
 */
export function blackbodyRGB(T) {
  let rgb = xyzToLinearSrgb(blackbodyXYZ(T));
  // Desaturate out-of-gamut colours towards white rather than clipping a
  // channel to zero, which would swing the hue.
  const min = Math.min(rgb[0], rgb[1], rgb[2]);
  if (min < 0) rgb = rgb.map((c) => c - min);
  const max = Math.max(rgb[0], rgb[1], rgb[2]) || 1;
  return rgb.map((c) => c / max);
}

export const LUT_MIN_K = 800;
export const LUT_MAX_K = 2600;
const LUT_STEPS = 256;

/**
 * Precomputed 0..255 sRGB ramp across the temperature range a candle actually
 * occupies. Built once at load; the render loop only ever does a table lookup.
 */
export function buildTemperatureLUT() {
  const lut = new Uint8Array(LUT_STEPS * 3);
  for (let i = 0; i < LUT_STEPS; i++) {
    const T = LUT_MIN_K + (LUT_MAX_K - LUT_MIN_K) * (i / (LUT_STEPS - 1));
    const rgb = blackbodyRGB(T);
    lut[i * 3 + 0] = Math.round(255 * encodeSrgb(rgb[0]));
    lut[i * 3 + 1] = Math.round(255 * encodeSrgb(rgb[1]));
    lut[i * 3 + 2] = Math.round(255 * encodeSrgb(rgb[2]));
  }
  return lut;
}

/** Index into the LUT for a temperature in kelvin. */
export function lutIndex(T) {
  const t = (T - LUT_MIN_K) / (LUT_MAX_K - LUT_MIN_K);
  return Math.max(0, Math.min(LUT_STEPS - 1, Math.round(t * (LUT_STEPS - 1))));
}

/** CSS `rgb()` string for a blackbody at T. Used by the UI and glow layers. */
export function blackbodyCSS(T, scale = 1) {
  const rgb = blackbodyRGB(T);
  const c = rgb.map((v) => Math.round(255 * encodeSrgb(v * scale)));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}
