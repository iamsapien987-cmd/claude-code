/**
 * The candle body: burning, melting, the melt pool, and wax drips.
 *
 * The mechanism, following Faraday's 1861 lectures, is a capillary engine.
 * The flame does not burn the candle from the top down. It melts a shallow
 * pool of wax around the wick; the wick draws that liquid up by capillary
 * action; the liquid vaporises at the flame and burns. So:
 *
 *  - Mass leaves the candle only through the wick, at a measured 0.105 g/min.
 *  - The pool surface is liquid, so gravity keeps it level and flat.
 *  - The outer rim stays below the melting point and remains solid, which is
 *    why a burning candle hollows out into a crater with a standing wall.
 *  - When the rim finally gets hot enough to give way, the pool overflows and
 *    runs down the outside as a drip, cooling and thickening until it sets.
 *
 * Height therefore falls at dh/dt = mdot / (rho * A), which for a 44 mm pillar
 * works out to a few millimetres per hour - real, but far too slow to watch.
 * `timeScale` compresses that without changing any of the physics.
 */

import {
  RHO_WAX, T_WAX_MELT, T_WAX_POOL, T_AMBIENT, MASS_BURN_RATE,
  CANDLE_RADIUS, CANDLE_HEIGHT_0, WICK_EXPOSED, HEAT_RELEASE,
  MELT_FEEDBACK_FRACTION, HEAT_OF_FUSION_WAX,
  MU_WAX_REF, MU_ARRHENIUS_E_OVER_R, WAX_COOLING_TAU, G,
} from './constants.js';

/** Thermal conductivity of *liquid* paraffin, W/(m K). */
const K_WAX_LIQUID = 0.15;
/** Drips per second of candle time from a fully molten rim. */
const DRIP_RATE = 0.006;
/**
 * Thickness of the wetting film a drip leaves behind it. A running drip is
 * pinned by its contact line and is freezing against wax that sits below the
 * melting point, so it behaves like a very thin film rather than a free bead -
 * which is why real drips crawl at centimetres per second, not metres.
 */
const DRIP_FILM = 1.6e-4;

/** Radial samples across the candle's top face. */
const PROFILE_N = 41;

/** Arrhenius viscosity of molten paraffin. Cold wax is thick wax. */
export function waxViscosity(T) {
  return MU_WAX_REF * Math.exp(
    MU_ARRHENIUS_E_OVER_R * (1 / Math.max(T, 250) - 1 / T_WAX_POOL)
  );
}

export class WaxBody {
  constructor() {
    this.reset();
    // Real time per simulated second. A candle burning at true speed loses
    // about 5 mm an hour, so watching it melt needs the clock sped up.
    this.timeScale = 90;
  }

  reset() {
    this.height = CANDLE_HEIGHT_0;   // m, height of the untouched outer wall
    this.burnedMass = 0;             // kg consumed so far
    this.wickExposed = WICK_EXPOSED; // m of wick standing proud of the pool
    this.wickCarbon = 0;             // 0..1, how much the wick tip has charred
    this.elapsed = 0;                // s of candle time

    // Radial height profile of the top face, measured downward from
    // `this.height`. Index 0 is the left edge, PROFILE_N-1 the right edge.
    this.profile = new Float32Array(PROFILE_N);
    this.nodeT = new Float32Array(PROFILE_N).fill(T_AMBIENT);
    this.poolDepth = 0;              // m, depth of liquid at the centre

    this.drips = [];                 // live, still-running drips
    this.frozen = [];                // set solid on the outside of the candle
  }

  /** Signed radius of profile node i, in metres. Negative is left of centre. */
  nodeRadius(i) {
    return CANDLE_RADIUS * (2 * i / (PROFILE_N - 1) - 1);
  }

  /** Absolute height of profile node i, in metres from the candle's base. */
  nodeHeight(i) {
    return this.height - this.profile[i];
  }

  /** The lowest point of the melt pool - where the wick sits. */
  centreHeight() {
    return this.nodeHeight((PROFILE_N - 1) >> 1);
  }

  /**
   * @param {number} dt         real seconds elapsed
   * @param {number} intensity  0..1 from the dial
   * @param {boolean} lit
   */
  update(dt, intensity, lit) {
    const t = dt * this.timeScale;
    this.elapsed += lit ? t : 0;

    this.updateThermal(t, intensity, lit);
    if (lit) this.consume(t, intensity);
    this.levelPool(t);
    this.updateDrips(dt);
    this.updateWick(t, intensity, lit);
  }

  /**
   * Heat flux from the flame down onto the wax face, and the resulting
   * temperature of each radial node. Only a few percent of the flame's ~80 W
   * makes it back into the wax; the rest radiates and convects away. The flux
   * falls off with distance from the wick, which is what sets the pool radius.
   */
  updateThermal(t, intensity, lit) {
    const power = lit ? HEAT_RELEASE * intensity * MELT_FEEDBACK_FRACTION : 0;
    // Characteristic radius over which the flame heats the face.
    // Characteristic radius over which the flame heats the face. It has to
    // stay well inside the candle's own radius, or the whole top melts at
    // once and there is never a solid rim to form a crater against.
    const rq = 0.0022 + 0.0042 * intensity;
    let liquidNodes = 0;

    for (let i = 0; i < PROFILE_N; i++) {
      const r = Math.abs(this.nodeRadius(i));
      const shape = Math.exp(-(r * r) / (rq * rq));
      // Nodes that sit deeper in the crater are shaded from the flame less
      // and are surrounded by hot wax, so they run warmer.
      const recess = 1 + 2.2 * (this.profile[i] / (this.poolDepth + 0.004));
      const flux = power * shape * Math.min(2.2, recess);
      // Equilibrium between that flux and loss to the surroundings.
      const Teq = T_AMBIENT + flux * 2600;
      const tau = 8.0; // s, thermal time constant of the wax face
      this.nodeT[i] += (Math.min(Teq, T_WAX_POOL + 12) - this.nodeT[i]) * Math.min(1, t / tau);
      if (this.nodeT[i] >= T_WAX_MELT) liquidNodes++;
    }
    this.poolRadius = CANDLE_RADIUS * (liquidNodes / PROFILE_N);
  }

  /**
   * Burn wax. Mass leaves through the wick, and the volume it leaves behind
   * is removed from the liquid part of the face.
   */
  consume(t, intensity) {
    const mdot = MASS_BURN_RATE * intensity;
    const dm = mdot * t;
    this.burnedMass += dm;

    // Which nodes are molten and can therefore give up mass? The profile
    // spans a full diameter, so each radius appears twice; integrating the
    // annulus 2*pi*r*dr over the whole strip and halving gives the disc area.
    let liquidArea = 0;
    const dr = (2 * CANDLE_RADIUS) / (PROFILE_N - 1);
    for (let i = 0; i < PROFILE_N; i++) {
      if (this.nodeT[i] >= T_WAX_MELT) {
        liquidArea += dr * (2 * Math.PI * Math.abs(this.nodeRadius(i)) + dr) * 0.5;
      }
    }
    if (liquidArea <= 0) {
      // Nothing molten yet: the wick alone is burning, so erode just the centre.
      const c = (PROFILE_N - 1) >> 1;
      this.profile[c] += dm / (RHO_WAX * Math.PI * 0.002 * 0.002);
      return;
    }

    // Volume removed, spread over the molten face.
    const dV = dm / RHO_WAX;
    const drop = dV / liquidArea;
    for (let i = 0; i < PROFILE_N; i++) {
      if (this.nodeT[i] >= T_WAX_MELT) this.profile[i] += drop;
    }

    // Depth of the liquid layer, from the quasi-steady Stefan balance at the
    // melt front: the flux arriving at the surface conducts down through the
    // liquid and supplies the latent heat of the front as it descends.
    //
    //     q = k (T_pool - T_melt) / delta  +  rho * L * dh/dt
    //
    // which rearranges to give the equilibrium layer thickness. It comes out
    // at one to two millimetres, matching a real candle's shallow pool.
    const area = Math.PI * CANDLE_RADIUS * CANDLE_RADIUS;
    const q = (HEAT_RELEASE * MELT_FEEDBACK_FRACTION * intensity) / area;
    const latent = RHO_WAX * HEAT_OF_FUSION_WAX * (mdot / (RHO_WAX * area));
    const driving = Math.max(1, q - latent);
    const eq = (K_WAX_LIQUID * (T_WAX_POOL - T_WAX_MELT)) / driving;
    this.poolDepth += (Math.min(0.006, eq) - this.poolDepth) * Math.min(1, t / 20);
  }

  /**
   * Liquid wax obeys gravity, so the molten part of the face relaxes to a
   * level surface. Solid wax does not move at all. This is what carves the
   * flat-bottomed crater with a standing rim.
   */
  levelPool(t) {
    let sum = 0, n = 0;
    for (let i = 0; i < PROFILE_N; i++) {
      if (this.nodeT[i] >= T_WAX_MELT) { sum += this.profile[i]; n++; }
    }
    if (n === 0) return;
    const level = sum / n;
    const rate = Math.min(1, t * 1.5); // liquid levels quickly
    for (let i = 0; i < PROFILE_N; i++) {
      if (this.nodeT[i] >= T_WAX_MELT) {
        this.profile[i] += (level - this.profile[i]) * rate;
      }
    }

    // Once the melt front reaches the outer wall there is no solid rim left to
    // contain the pool, and wax runs over the edge. How readily depends on how
    // far past melting the rim has been driven.
    for (const edge of [0, PROFILE_N - 1]) {
      const superheat = this.nodeT[edge] - T_WAX_MELT;
      if (superheat <= 0) continue;
      const rate = DRIP_RATE * Math.min(1, superheat / 12);
      if (Math.random() < rate * t) this.spawnDrip(edge === 0 ? -1 : 1);
    }
  }

  /** A blob of molten wax goes over the rim. */
  spawnDrip(side) {
    if (this.drips.length > 14) return;
    const top = this.height - this.profile[side < 0 ? 0 : PROFILE_N - 1];
    this.drips.push({
      // Azimuth around the candle, in radians from the face nearest the
      // viewer. The renderer projects this onto the cylinder, so a drip is
      // placed on the surface rather than floated over it. Biased towards the
      // silhouette, which is where the rim gives way first.
      theta: side * (0.55 + 0.45 * Math.random()) * (Math.PI / 2),
      y: top,
      startY: top,                            // where it went over the rim
      vy: 0,
      T: T_WAX_POOL,
      mass: 2e-5 + Math.random() * 6e-5,      // kg, roughly 20-80 mg
      radius: 0,
      frozen: false,
    });
  }

  /**
   * Drips run down the outside of the candle. A rivulet on a wall reaches a
   * terminal velocity where gravity balances viscous shear,
   *
   *     v = rho g delta^2 / (3 mu)
   *
   * with film thickness delta. Because mu climbs steeply as the drip cools,
   * the drip visibly decelerates on the way down and then sets solid - which
   * is exactly what a real candle's drips do.
   */
  updateDrips(dt) {
    const t = dt * this.timeScale;
    const baseline = 0;
    for (const d of this.drips) {
      // Newtonian cooling towards room temperature.
      d.T = T_AMBIENT + (d.T - T_AMBIENT) * Math.exp(-t / WAX_COOLING_TAU);
      // A bigger drip is a thicker film and runs faster.
      d.radius = Math.cbrt((3 * d.mass) / (4 * Math.PI * RHO_WAX));
      const delta = DRIP_FILM * (0.7 + 0.6 * (d.radius / 2e-3));
      const mu = waxViscosity(d.T);
      const vTerm = (RHO_WAX * G * delta * delta) / (3 * mu);
      d.vy += ((-vTerm) - d.vy) * Math.min(1, t * 6);
      d.y += d.vy * t;

      if (d.T <= T_WAX_MELT || Math.abs(d.vy) < 2e-5) {
        d.frozen = true;
      }
      if (d.y <= baseline) { d.y = baseline; d.frozen = true; }
    }
    // Move set drips onto the static list so they stop being integrated.
    for (let i = this.drips.length - 1; i >= 0; i--) {
      if (this.drips[i].frozen) this.frozen.push(...this.drips.splice(i, 1));
    }
    // A drip is reclaimed once the melt line descends past it.
    const top = this.height - this.profile[0];
    for (let i = this.frozen.length - 1; i >= 0; i--) {
      if (this.frozen[i].y > top) this.frozen.splice(i, 1);
    }
    if (this.frozen.length > 60) this.frozen.splice(0, this.frozen.length - 60);
  }

  /**
   * The wick. It chars as it burns and curls over into the oxygen-rich outer
   * edge of the flame, where the carbon is consumed - which is how a candle
   * self-trims. If it grows too long it mushrooms and the flame starts to
   * smoke, so the length settles into an equilibrium.
   */
  updateWick(t, intensity, lit) {
    const pool = this.centreHeight();
    const target = 0.004 + 0.004 * (1 - intensity);
    if (lit) {
      this.wickExposed += (target - this.wickExposed) * Math.min(1, t / 25);
      this.wickCarbon = Math.min(1, this.wickCarbon + t * 0.02);
    }
    this.wickTop = pool + this.wickExposed;
  }

  /** Fraction of the original candle left, for the UI. */
  remaining() {
    return Math.max(0, this.centreHeight() / CANDLE_HEIGHT_0);
  }
}

export { PROFILE_N };
