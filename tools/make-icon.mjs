/**
 * Generate the launcher icon from the same colour pipeline the app uses.
 *
 * The icon is a flame, and its colours come out of Planck's law at candle
 * temperatures rather than being picked by eye, so the tab icon, the app icon
 * and the flame itself all agree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { blackbodyRGB, encodeSrgb } from '../src/blackbody.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const rgbAt = (T) => blackbodyRGB(T).map((c) => 255 * encodeSrgb(c));

/** Teardrop flame profile: half-width of the flame at height t (0 base, 1 tip). */
function halfWidth(t) {
  if (t <= 0 || t >= 1) return 0;
  // Wide and round low down, drawn to a point at the top - the silhouette a
  // buoyant diffusion flame actually has.
  return Math.pow(Math.sin(Math.PI * Math.pow(t, 0.62)), 1.35) * Math.pow(1 - t, 0.32);
}

/**
 * @param {number} size
 * @param {number} scale  how much of the canvas the flame fills. Adaptive
 *   icons crop to the middle 66%, so the foreground layer is drawn smaller to
 *   keep the flame inside that safe zone.
 */
function render(size, scale = 1) {
  const px = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const mid = size * 0.5;
  const baseY = mid + (size * 0.90 - mid) * scale;
  const topY = mid + (size * 0.13 - mid) * scale;
  const H = baseY - topY;
  const maxHalf = size * 0.215 * scale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y + x * 0) * 0; // placeholder to keep the loop shape obvious
      const t = (baseY - y) / H;              // 0 at the base, 1 at the tip
      const dx = Math.abs(x - cx);
      const hw = halfWidth(t) * maxHalf;

      let r = 0, g = 0, b = 0, a = 0;
      if (hw > 0.5) {
        // Distance from the flame's centreline, normalised across its width.
        const u = dx / hw;
        if (u < 1.35) {
          // Hotter in the core and towards the base, cooling to the tip -
          // the same temperature field the simulation produces.
          const T = 1950 - 700 * t - 380 * Math.min(1, u * u);
          const [cr, cg, cb] = rgbAt(Math.max(900, T));
          const body = Math.max(0, 1 - Math.pow(u, 2.6));
          const alpha = Math.min(1, body * 1.25);
          r = cr; g = cg; b = cb; a = alpha;
        }
      }
      // Glow around the flame, falling away smoothly.
      const gd = Math.hypot(x - cx, y - (topY + H * 0.30)) / (size * 0.5 * scale);
      const glow = Math.max(0, 1 - gd) ** 2.6 * 0.55;
      const [gr, gg, gb] = rgbAt(1850);
      const outR = r * a + gr * glow * (1 - a);
      const outG = g * a + gg * glow * (1 - a);
      const outB = b * a + gb * glow * (1 - a);
      const outA = Math.min(1, a + glow);

      const i = (y * size + x) * 4;
      px[i] = Math.round(Math.min(255, outR));
      px[i + 1] = Math.round(Math.min(255, outG));
      px[i + 2] = Math.round(Math.min(255, outB));
      px[i + 3] = Math.round(255 * outA);
    }
  }
  return px;
}

// Minimal PNG writer: one IDAT, filter 0 per row, stored deflate via zlib.
import zlib from 'node:zlib';
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  // Node's zlib has no crc32 export on all versions; use a small table.
  let table;
  function crc32(buf) {
    if (!table) {
      table = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
      }
    }
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const DENSITIES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [dpi, size] of Object.entries(DENSITIES)) {
  const dir = path.join(ROOT, 'android/app/src/main/res', `mipmap-${dpi}`);
  fs.mkdirSync(dir, { recursive: true });
  const legacy = png(size, render(size));
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), legacy);
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), legacy);
  // Adaptive foreground: 108dp canvas, flame kept inside the 66% safe zone.
  const fgSize = Math.round(size * 108 / 48);
  fs.writeFileSync(path.join(dir, 'ic_launcher_foreground.png'), png(fgSize, render(fgSize, 0.52)));
  console.log(`mipmap-${dpi}  legacy ${size}px, adaptive foreground ${fgSize}px`);
}
