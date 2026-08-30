/**
 * Rendering. Everything drawn here is driven by the simulation state; there
 * are no keyframes and no hand-authored flame shape anywhere in this file.
 *
 * The layer order mirrors how the light physically arrives at your eye:
 *
 *   1. the light the flame throws into the room, falling off as 1/r^2
 *   2. the surface the candle stands on, lit by that light
 *   3. the wax body, lit from above and glowing from within where the flame
 *      heats it (paraffin is translucent - Beer-Lambert through ~6 mm)
 *   4. the molten pool and the charred wick
 *   5. the flame itself, as blackbody emission from soot plus the blue
 *      chemiluminescent reaction zone at its base
 *   6. bloom, which is what the eye and the camera both do with a source
 *      this much brighter than its surroundings
 */

import { blackbodyRGB, encodeSrgb } from './blackbody.js';
import { FlameRasteriser } from './flamecolor.js';
import {
  CANDLE_RADIUS, T_SOOT_IGNITION, T_COLOR_ROOM,
  LUMINOUS_INTENSITY, FLAME_HEIGHT,
} from './constants.js';
import { PROFILE_N } from './wax.js';

const ROOM_RGB = blackbodyRGB(T_COLOR_ROOM).map((c) => Math.round(255 * encodeSrgb(c)));

/** Diffuse reflectance of unlit paraffin: a warm off-white, not a neutral one. */
const WAX_ALBEDO = [0.96, 0.91, 0.80];

/** Vertical squash of the top-face ellipse: we look slightly down on the candle. */
const TILT = 0.19;
/** Beer-Lambert attenuation length of light inside paraffin, metres. */
const WAX_SCATTER_LENGTH = 0.006;
/**
 * Emission from the solver that corresponds to a fully lit scene. Measured
 * from the solver itself with tools/calibrate.mjs rather than guessed.
 */
const EMISSION_REF = 20000;

/**
 * Converts illuminance in the model's units to screen alpha. Set so a candle
 * at full tilt lights its immediate surroundings strongly and falls to almost
 * nothing by the edge of the frame, which is roughly what one candle does to
 * a dark room.
 */
const ROOM_LIGHT_GAIN = 7.5e-4;

/**
 * How far the flame's glare extends, as a fraction of the smaller screen
 * dimension. Everything past it is left untouched and so stays exactly black.
 */
const GLARE_REACH = 0.62;

/**
 * Ramp a falloff to nothing well before its own outer edge.
 *
 * A gradient that only approaches zero leaves a floor of one or two counts
 * spread over a huge area, which is invisible on a backlit panel and plainly
 * visible as a dull glow on an OLED in a dark room - and it keeps those
 * pixels powered. Bringing the curve to zero at 85% of its radius leaves the
 * outer band genuinely untouched, while the ramp stays smooth enough not to
 * show an edge.
 */
function taper(s) {
  if (s <= 0.35) return 1;
  const t = 1 - (s - 0.35) / 0.5;
  return t <= 0 ? 0 : Math.pow(t, 2.2);
}

/**
 * Anything that would not survive quantisation to 8 bits is snapped to zero,
 * so it costs no light at all rather than one count across half the screen.
 */
function cutoff(a) {
  return a < 1 / 255 ? 0 : a;
}

export class Renderer {
  constructor(canvas, field, wax) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.field = field;
    this.wax = wax;

    // Flame is composited from a buffer at simulation resolution.
    this.flameBuf = document.createElement('canvas');
    this.flameBuf.width = field.nx;
    this.flameBuf.height = field.ny;
    this.flameCtx = this.flameBuf.getContext('2d');
    this.flameImg = this.flameCtx.createImageData(field.nx, field.ny);
    this.raster = new FlameRasteriser(field.nx, field.ny);

    // Half-resolution intermediate. Upscaling in two bilinear steps is much
    // smoother than one big jump, and gives the bloom pass something cheap
    // to blur.
    this.mid = document.createElement('canvas');
    this.midCtx = this.mid.getContext('2d');

    this.dpr = 1;
    this.smoothed = 0;                   // low-passed emission, drives the room light
    this.lastFlameHeight = FLAME_HEIGHT;  // metres, kept for tap hit testing
    this.resize();
  }

  /**
   * Perceived brightness of the scene, 0..~1.3.
   *
   * The solver's emission swings over roughly a 40:1 range between the
   * bottom and top of the dial, but perceived lightness is not proportional
   * to luminance. CIE L* is a cube root of relative luminance, and using
   * that here is what makes the dial feel linear under the hand while the
   * underlying radiometry stays honest.
   */
  luminance() {
    return Math.min(1.45, Math.cbrt(Math.max(0, this.smoothed) / EMISSION_REF));
  }

  resize() {
    const c = this.canvas;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * this.dpr);
    const h = Math.round(c.clientHeight * this.dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.w = w;
    this.h = h;

    // Metres of world visible vertically. The candle plus its flame is about
    // 17 cm, so showing ~34 cm frames it with room to breathe.
    this.viewHeight = 0.34;
    this.scale = h / this.viewHeight;            // pixels per metre
    this.baseY = h * 0.93;                       // where the candle stands
    this.cx = w / 2;

    this.mid.width = Math.max(64, Math.round(this.field.nx * 4));
    this.mid.height = Math.max(64, Math.round(this.field.ny * 4));
  }

  /**
   * Is this point, in CSS pixels, on the flame?
   *
   * Used for tap-to-snuff. The region is derived from where the flame
   * actually is rather than from a fixed fraction of the screen, so it
   * follows the flame as it grows with the dial and descends as the candle
   * burns down. Padded enough to be hittable with a thumb and no more.
   */
  flameHitTest(cssX, cssY) {
    const d = this.dpr;
    const wick = this.wax.wickTop || 0;
    const top = this.py(wick + this.lastFlameHeight) / d;
    const bottom = this.py(wick) / d;
    const cx = this.cx / d;
    const halfW = Math.max(26, (bottom - top) * 0.32);
    const pad = 14;
    return Math.abs(cssX - cx) < halfW + pad
      && cssY > top - pad
      && cssY < bottom + pad;
  }

  /** World metres (x from candle centre, y up from the base) to canvas pixels. */
  px(x) { return this.cx + x * this.scale; }
  py(y) { return this.baseY - y * this.scale; }

  draw(state) {
    const { ctx, w, h } = this;
    const emission = this.field.emission();
    // The room light must not strobe on single-frame noise, but it does have
    // to carry the flame's real flicker, so smooth it only lightly.
    this.smoothed += (emission - this.smoothed) * 0.35;
    // Kept for hit testing, so a tap can find the flame where it is now.
    this.lastFlameHeight = this.field.flameHeight();

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    this.drawRoomLight(state);
    this.drawGround(state);
    this.drawCandle(state);
    this.drawPoolAndWick(state);
    this.drawFlame(state);
    this.drawSmoke(state);
    this.drawVignette();
  }

  /**
   * Light thrown into the room. A candle is, by the historical definition of
   * the unit, about one candela; illuminance falls off as 1/r^2, so the
   * gradient stops are placed on that curve rather than eyeballed.
   */
  drawRoomLight(state) {
    const { ctx, w, h } = this;
    const wick = this.wax.wickTop || 0;
    const fx = this.px(0);
    const fy = this.py(wick + 0.018);

    const lum = this.luminance() * LUMINOUS_INTENSITY;
    if (lum <= 0.001) return;

    // Light has to *stop*. On an OLED panel a black pixel is switched off, so
    // any glow that trails away across the whole screen is the display
    // emitting light on its own account rather than the flame lighting
    // something. It is also unphysical: there is no wall and no dust in this
    // scene for a room-filling wash to scatter off. What is real, and what
    // this draws, is the glare close to a very bright small source - light
    // scattered by the air just around it and inside the eye looking at it.
    // Beyond `reach` nothing is drawn at all, so those pixels stay at exactly
    // zero and the panel keeps them off.
    const reach = Math.min(w, h) * GLARE_REACH;
    const g = ctx.createRadialGradient(fx, fy, 0, fx, fy, reach);
    const [r, gr, b] = ROOM_RGB;

    const L = FLAME_HEIGHT;
    const STOPS = 20;
    const span = reach / this.scale;
    for (let i = 0; i <= STOPS; i++) {
      const s = i / STOPS;
      const d = 0.012 + s * span;                      // metres from the flame
      // Extended source: 1/d close in, 1/d^2 far away, crossing over at the
      // flame's own height.
      const e = lum / (d * (d + L));
      // Taper the last part of the curve to nothing so the gradient reaches
      // true zero at `reach` instead of leaving a floor of one or two counts
      // spread across the whole panel.
      const a = i === STOPS ? 0 : cutoff(Math.min(0.62, e * ROOM_LIGHT_GAIN) * taper(s));
      g.addColorStop(s, `rgba(${r}, ${gr}, ${b}, ${a.toFixed(4)})`);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(fx, fy, reach, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  /** The surface the candle stands on, plus its contact shadow. */
  drawGround(state) {
    const { ctx, w } = this;
    const y = this.baseY;
    const lum = this.luminance();
    const rPx = CANDLE_RADIUS * this.scale;

    // Soft pool of light on the table.
    const reach = rPx * 9;
    const g = ctx.createRadialGradient(this.cx, y, rPx * 0.4, this.cx, y, reach);
    const [r, gr, b] = ROOM_RGB;
    // Same rule as the glare: this is light falling on a real surface, but it
    // still has to reach true zero rather than trailing off across the panel.
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      const falloff = 0.30 / (1 + 9 * s * s);
      const a = i === 10 ? 0 : cutoff(falloff * lum * taper(s));
      g.addColorStop(s, `rgba(${r}, ${gr}, ${b}, ${a.toFixed(4)})`);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.translate(0, y);
    ctx.scale(1, TILT * 1.6);
    ctx.translate(0, -y);
    ctx.fillStyle = g;
    // Bounded to the lit ellipse; outside it nothing is drawn, so it stays off.
    ctx.beginPath();
    ctx.arc(this.cx, y, reach, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';

    // Contact shadow directly under the candle.
    const sh = ctx.createRadialGradient(this.cx, y, 0, this.cx, y, rPx * 1.9);
    sh.addColorStop(0, 'rgba(0, 0, 0, 0.85)');
    sh.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.save();
    ctx.translate(0, y);
    ctx.scale(1, TILT);
    ctx.translate(0, -y);
    ctx.fillStyle = sh;
    ctx.fillRect(this.cx - rPx * 2, y - rPx * 2, rPx * 4, rPx * 4);
    ctx.restore();
  }

  /** Outline of the wax body, used both to fill and to clip. */
  bodyPath(ctx) {
    const wax = this.wax;
    const rPx = CANDLE_RADIUS * this.scale;
    const leftTop = this.py(wax.nodeHeight(0));
    const rightTop = this.py(wax.nodeHeight(PROFILE_N - 1));
    const base = this.baseY;

    ctx.beginPath();
    ctx.moveTo(this.cx - rPx, leftTop);
    ctx.lineTo(this.cx - rPx, base);
    // The bottom of the candle is an ellipse too, seen from the same angle.
    ctx.ellipse(this.cx, base, rPx, rPx * TILT, 0, Math.PI, 0, true);
    ctx.lineTo(this.cx + rPx, rightTop);
    ctx.ellipse(this.cx, rightTop, rPx, rPx * TILT, 0, 0, Math.PI, true);
    ctx.closePath();
  }

  drawCandle(state) {
    const { ctx } = this;
    const wax = this.wax;
    const rPx = CANDLE_RADIUS * this.scale;
    const topY = this.py(wax.nodeHeight(0));
    const lum = this.luminance();

    ctx.save();
    this.bodyPath(ctx);
    ctx.clip();

    // Cylinder shading. The body is lit from a point source directly above,
    // so brightness follows the surface normal turning away from the axis and
    // then falls off down the length of the candle.
    const g = ctx.createLinearGradient(this.cx - rPx, 0, this.cx + rPx, 0);
    const shade = (t) => {
      // t is -1..1 across the diameter; the surface normal's horizontal
      // component is t, so the Lambert term goes as sqrt(1 - t^2).
      const n = Math.sqrt(Math.max(0, 1 - t * t));
      const v = 0.10 + 0.62 * Math.pow(n, 0.85);
      return v;
    };
    // Unlit paraffin is a warm off-white, and the only light falling on it
    // comes from a 1850 K flame. Shading it with neutral greys made it read
    // as grey plastic; multiplying the wax's own albedo by the colour of the
    // light actually illuminating it is what makes it read as wax.
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      const v = shade(s * 2 - 1) * lum;
      const c = WAX_ALBEDO.map((a, ch) =>
        Math.round(255 * Math.min(1, v * a * (0.45 + 0.55 * ROOM_RGB[ch] / 255))));
      g.addColorStop(s, `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
    }
    ctx.fillStyle = g;
    this.bodyPath(ctx);
    ctx.fill();

    // Vertical falloff: the far end of the candle is further from the flame.
    const vg = ctx.createLinearGradient(0, topY, 0, this.baseY);
    vg.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vg.addColorStop(0.45, 'rgba(0, 0, 0, 0.35)');
    vg.addColorStop(1, 'rgba(0, 0, 0, 0.80)');
    ctx.fillStyle = vg;
    ctx.fillRect(this.cx - rPx, topY, rPx * 2, this.baseY - topY + 2);

    // Subsurface scattering. Paraffin is translucent, so light from the flame
    // enters the wax near the top and is attenuated with depth following
    // Beer-Lambert with an attenuation length of about 6 mm. This is the
    // warm internal glow that distinguishes real wax from painted plastic.
    const depth = WAX_SCATTER_LENGTH * this.scale;
    const sg = ctx.createLinearGradient(0, topY - depth * 0.5, 0, topY + depth * 5);
    for (let i = 0; i <= 6; i++) {
      const s = i / 6;
      const a = Math.exp(-s * 5 * 0.85) * 0.55 * lum;
      sg.addColorStop(s, `rgba(255, 168, 84, ${a.toFixed(3)})`);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = sg;
    ctx.fillRect(this.cx - rPx, topY - depth, rPx * 2, depth * 7);
    ctx.globalCompositeOperation = 'source-over';

    this.drawDrips(ctx, rPx, lum);
    ctx.restore();

    // A soft rim on the lit side so the silhouette does not read as a cutout.
    ctx.save();
    this.bodyPath(ctx);
    ctx.clip();
    const rim = ctx.createLinearGradient(this.cx - rPx, 0, this.cx - rPx * 0.55, 0);
    rim.addColorStop(0, `rgba(255, 190, 120, ${(0.22 * lum).toFixed(3)})`);
    rim.addColorStop(1, 'rgba(255, 190, 120, 0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rim;
    ctx.fillRect(this.cx - rPx, topY, rPx, this.baseY - topY);
    ctx.restore();
  }

  /** Live and set drips running down the outside of the candle. */
  drawDrips(ctx, rPx, lum) {
    const all = this.wax.frozen.concat(this.wax.drips);
    for (const d of all) {
      // Project the drip's azimuth onto the cylinder. A drip sits *on* the
      // surface, so its screen position is R sin(theta), and the surface
      // turns away from the viewer as |theta| grows.
      const st = Math.sin(d.theta);
      const ct = Math.abs(Math.cos(d.theta));
      const x = this.cx + rPx * st;
      const rad = Math.max(1.2, d.radius * this.scale);
      // Seen from the side, a drip near the silhouette is viewed edge-on and
      // so looks narrower than one facing the viewer.
      const wide = rad * Math.max(0.35, ct);

      const y = this.py(d.y);
      const top = this.py(d.startY);

      // Same Lambert term the body uses, so a drip on the turned-away part of
      // the cylinder is shaded like the wax it is sitting on instead of
      // glowing white against it.
      const shade = lum * (0.14 + 0.62 * Math.pow(ct, 0.85));
      const wax = (r, g, b, a = 1) =>
        `rgba(${Math.round(r * shade)}, ${Math.round(g * shade)}, ${Math.round(b * shade)}, ${a})`;

      // The trail it has left behind, standing slightly proud of the wall.
      if (top < y - 0.5) {
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, y);
        ctx.lineWidth = wide * 1.35;
        ctx.lineCap = 'round';
        ctx.strokeStyle = wax(228, 208, 174, 0.92);
        ctx.stroke();
      }

      // The bead at the leading edge. A running drip is drawn out into a
      // teardrop by its own motion; one that has set is round again.
      const speed = Math.min(1, Math.abs(d.vy) / 0.02);
      const tall = wide * (1.25 + speed * 1.6);
      const g = ctx.createRadialGradient(x - wide * 0.3, y - tall * 0.35, 0, x, y, tall * 1.3);
      g.addColorStop(0, wax(255, 247, 230, 0.98));
      g.addColorStop(0.5, wax(233, 212, 178));
      g.addColorStop(1, wax(146, 126, 98, 0.7));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, wide * 1.1, tall, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** The molten pool in the crater, and the charred wick standing in it. */
  drawPoolAndWick(state) {
    const { ctx } = this;
    const wax = this.wax;
    const rPx = CANDLE_RADIUS * this.scale;
    const lum = this.luminance();

    // The top face is a crater: a standing rim of wax that never got hot
    // enough to melt, and inside it a pool that has sunk as the wick burned
    // its way down. Both are ellipses because we are looking slightly down on
    // the candle, and the gap between them is the crater wall.
    const rimY = this.py(wax.nodeHeight(0));
    const poolY = this.py(wax.centreHeight());
    const poolR = Math.max(rPx * 0.18, wax.poolRadius * this.scale);

    // Rim: the solid ring of wax, lit from directly above by the flame.
    const rimShade = (t) => 0.16 + 0.70 * Math.pow(Math.sqrt(Math.max(0, 1 - t * t)), 0.8);
    const rg = ctx.createLinearGradient(this.cx - rPx, 0, this.cx + rPx, 0);
    for (let i = 0; i <= 8; i++) {
      const s = i / 8;
      const v = rimShade(s * 2 - 1) * lum;
      // Same rule as the body: the wax's own albedo times the colour of the
      // light falling on it. Neutral greys here read as a metal ring.
      const c = WAX_ALBEDO.map((a, ch) =>
        Math.round(255 * Math.min(1, v * a * (0.45 + 0.55 * ROOM_RGB[ch] / 255))));
      rg.addColorStop(s, `rgb(${c[0]}, ${c[1]}, ${c[2]})`);
    }
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.ellipse(this.cx, rimY, rPx, rPx * TILT, 0, 0, Math.PI * 2);
    ctx.fill();

    // Crater wall, from the rim down to the pool. The far side of the wall
    // faces the viewer and catches the flame; the near side is in shadow
    // behind the rim, so it is drawn darker.
    const depth = Math.max(0, poolY - rimY);
    if (depth > 0.5) {
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(this.cx, rimY, poolR, poolR * TILT, 0, 0, Math.PI * 2);
      ctx.ellipse(this.cx, poolY, poolR, poolR * TILT, 0, 0, Math.PI * 2);
      ctx.rect(this.cx - poolR, rimY, poolR * 2, depth);
      ctx.clip();
      const wg = ctx.createLinearGradient(0, rimY - poolR * TILT, 0, poolY + poolR * TILT);
      // The wall is lit by the flame sitting directly above it, so it runs
      // from shadowed just under the overhanging rim to warm at the pool.
      wg.addColorStop(0, `rgba(${Math.round(96 * lum)}, ${Math.round(72 * lum)}, ${Math.round(48 * lum)}, 1)`);
      wg.addColorStop(0.5, `rgba(${Math.round(206 * lum)}, ${Math.round(168 * lum)}, ${Math.round(120 * lum)}, 1)`);
      wg.addColorStop(1, `rgba(${Math.round(246 * lum)}, ${Math.round(206 * lum)}, ${Math.round(150 * lum)}, 1)`);
      ctx.fillStyle = wg;
      ctx.fillRect(this.cx - poolR - 1, rimY - poolR, poolR * 2 + 2, depth + poolR * 2);
      ctx.restore();
    }

    // The pool itself. Liquid wax is specular where the solid face is matt,
    // so it carries a sharp reflection of the flame sitting right above it.
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(this.cx, poolY, poolR, poolR * TILT, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = `rgba(${Math.round(216 * lum)}, ${Math.round(178 * lum)}, ${Math.round(130 * lum)}, 1)`;
    ctx.fillRect(this.cx - poolR, poolY - poolR, poolR * 2, poolR * 2);
    const pg = ctx.createRadialGradient(this.cx, poolY, 0, this.cx, poolY, poolR);
    pg.addColorStop(0, `rgba(255, 236, 200, ${(0.62 * lum).toFixed(3)})`);
    pg.addColorStop(0.45, `rgba(255, 190, 120, ${(0.26 * lum).toFixed(3)})`);
    pg.addColorStop(1, 'rgba(255, 170, 90, 0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = pg;
    ctx.fillRect(this.cx - poolR, poolY - poolR, poolR * 2, poolR * 2);
    ctx.restore();

    // A thin shadow just inside the rim, which is what actually reads as
    // depth rather than as a flat disc with a lighter disc painted on it.
    ctx.beginPath();
    ctx.ellipse(this.cx, rimY, poolR, poolR * TILT, 0, Math.PI, Math.PI * 2);
    ctx.lineWidth = Math.max(1, rPx * 0.05);
    ctx.strokeStyle = `rgba(${Math.round(64 * lum)}, ${Math.round(46 * lum)}, ${Math.round(30 * lum)}, 0.5)`;
    ctx.stroke();

    // The wick: charred and bent over towards the oxygen-rich outer edge of
    // the flame, which is how a candle trims itself.
    const wy = poolY;
    const tipY = this.py(wax.wickTop);
    const bend = (wax.wickCarbon * 0.55 + 0.15) * (wax.wickTop - wax.centreHeight()) * this.scale;
    ctx.beginPath();
    ctx.moveTo(this.cx, wy);
    ctx.quadraticCurveTo(this.cx + bend * 0.2, (wy + tipY) / 2, this.cx + bend, tipY);
    ctx.lineWidth = Math.max(1.2, 0.0016 * this.scale);
    ctx.lineCap = 'round';
    ctx.strokeStyle = state.lit ? 'rgba(24, 18, 14, 0.95)' : 'rgba(38, 32, 28, 0.95)';
    ctx.stroke();

    // The base of the wick glows: it sits inside the reaction zone.
    if (state.lit) {
      ctx.globalCompositeOperation = 'lighter';
      const eg = ctx.createRadialGradient(this.cx, wy, 0, this.cx, wy, rPx * 0.7);
      eg.addColorStop(0, `rgba(255, 150, 60, ${0.8 * lum})`);
      eg.addColorStop(1, 'rgba(255, 120, 40, 0)');
      ctx.fillStyle = eg;
      ctx.beginPath();
      ctx.arc(this.cx, wy, rPx * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /**
   * The flame. Soot incandescence is looked up from the precomputed Planck
   * ramp; the blue base is added separately from the reaction rate, because
   * it is chemiluminescence from excited CH and C2 rather than thermal
   * emission and so does not lie on the blackbody locus at all.
   */
  drawFlame(state) {
    const f = this.field;
    const img = this.flameImg;
    this.raster.raster(this.field, img.data);
    this.flameCtx.putImageData(img, 0, 0);

    // Two-stage upscale keeps the bilinear interpolation from showing its
    // diamond pattern, and the small intermediate is cheap to blur.
    const mc = this.midCtx;
    mc.clearRect(0, 0, this.mid.width, this.mid.height);
    mc.imageSmoothingEnabled = true;
    mc.imageSmoothingQuality = 'high';
    mc.filter = 'blur(1.6px)';
    mc.drawImage(this.flameBuf, 0, 0, this.mid.width, this.mid.height);
    mc.filter = 'none';

    const { ctx } = this;
    const wPx = f.nx * f.h * this.scale;
    const hPx = f.ny * f.h * this.scale;
    const x0 = this.cx - wPx / 2;
    const y0 = this.py(this.wax.wickTop) - hPx;

    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Bloom: the same image drawn larger and dimmer, twice, approximates the
    // veiling glare of a very bright small source.
    ctx.globalAlpha = 0.30;
    ctx.drawImage(this.mid, x0 - wPx * 0.45, y0 - hPx * 0.10, wPx * 1.9, hPx * 1.2);
    ctx.globalAlpha = 0.42;
    ctx.drawImage(this.mid, x0 - wPx * 0.14, y0 - hPx * 0.03, wPx * 1.28, hPx * 1.06);
    ctx.globalAlpha = 1;
    ctx.drawImage(this.mid, x0, y0, wPx, hPx);

    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * Smoke. Soot that escapes the reaction zone - which happens in quantity
   * only once the flame is out - rises, spreads by turbulent diffusion, and
   * fades. It is drawn from the same soot field the solver advects.
   */
  drawSmoke(state) {
    if (state.lit && state.blowStrength < 0.15) return;
    const f = this.field;
    const { ctx } = this;
    const wPx = f.nx * f.h * this.scale;
    const hPx = f.ny * f.h * this.scale;
    const x0 = this.cx - wPx / 2;
    const y0 = this.py(this.wax.wickTop) - hPx;
    const cw = f.nx, ch = f.ny;

    if (!this.smokeBuf) {
      this.smokeBuf = document.createElement('canvas');
      this.smokeBuf.width = cw; this.smokeBuf.height = ch;
      this.smokeCtx = this.smokeBuf.getContext('2d');
      this.smokeImg = this.smokeCtx.createImageData(cw, ch);
    }
    const d = this.smokeImg.data;
    let any = false;
    for (let j = 0; j < ch; j++) {
      const row = (ch - 1 - j) * cw * 4;
      for (let i = 0; i < cw; i++) {
        const k = i + j * cw;
        const a = Math.min(1, f.soot[k] * 0.9) * (f.T[k] < T_SOOT_IGNITION ? 1 : 0.15);
        const o = row + i * 4;
        d[o] = 190; d[o + 1] = 186; d[o + 2] = 180;
        d[o + 3] = a * 190;
        if (a > 0.01) any = true;
      }
    }
    if (!any) return;
    this.smokeCtx.putImageData(this.smokeImg, 0, 0);
    ctx.save();
    ctx.filter = 'blur(2px)';
    ctx.globalAlpha = 0.55;
    ctx.drawImage(this.smokeBuf, x0, y0, wPx, hPx);
    ctx.restore();
  }

  drawVignette() {
    const { ctx, w, h } = this;
    const g = ctx.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.25,
                                       w / 2, h * 0.55, Math.max(w, h) * 0.78);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}
