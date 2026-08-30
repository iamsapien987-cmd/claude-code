/**
 * A buoyant reacting-flow solver on a staggered-free (collocated) grid.
 *
 * This is the heart of the app. A candle flame is a laminar buoyant diffusion
 * flame: fuel vapour rises off the wick, mixes with air, burns in a thin
 * sheet, and the hot products accelerate upward under buoyancy. The
 * shear between that rising column and the still room air rolls up into a
 * ring vortex that pinches the flame - and *that* pinching, shedding at
 * 10-15 Hz, is what we perceive as flicker. It is not random jitter, which
 * is why hand-animated flames never look right.
 *
 * Numerically this is Stam's stable-fluids scheme (SIGGRAPH 1999):
 * semi-Lagrangian advection plus a Jacobi pressure projection, with the
 * vorticity confinement of Fedkiw, Stam & Jensen (SIGGRAPH 2001) added back
 * to compensate for the vorticity that the first-order advection dissipates.
 *
 * All fields are in SI units. Cell size `h` is in metres.
 */

import {
  G, T_AMBIENT, T_SOOT_IGNITION, T_ADIABATIC, Z_STOICH,
  D_MASS, ALPHA_THERMAL, D_SOOT,
} from './constants.js';

/**
 * Radius of the fuel source in cells at mid dial. A wick plus the ring of
 * molten wax feeding it is a few millimetres across, which on this grid is
 * about five cells.
 */
export const WICK_CELLS = 2.5;

/**
 * Ceiling on the prescribed divergence, 1/s. The projection is solved with a
 * fixed number of Jacobi sweeps, so an unbounded source can outrun it and
 * blow the velocity field up.
 */
const EXPANSION_CLAMP = 260;

/** Bilinear sample of a scalar field at continuous grid coordinates. */
function sample(f, nx, ny, x, y) {
  if (x < 0.5) x = 0.5; else if (x > nx - 1.5) x = nx - 1.5;
  if (y < 0.5) y = 0.5; else if (y > ny - 1.5) y = ny - 1.5;
  const i0 = x | 0, j0 = y | 0;
  const i1 = i0 + 1, j1 = j0 + 1;
  const sx = x - i0, sy = y - j0;
  const a = f[i0 + j0 * nx], b = f[i1 + j0 * nx];
  const c = f[i0 + j1 * nx], d = f[i1 + j1 * nx];
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

export class FlameField {
  /**
   * @param {number} nx  cells across
   * @param {number} ny  cells up
   * @param {number} h   cell size in metres
   */
  constructor(nx, ny, h) {
    this.nx = nx;
    this.ny = ny;
    this.h = h;
    const n = nx * ny;

    this.u = new Float32Array(n);      // m/s, horizontal velocity
    this.v = new Float32Array(n);      // m/s, vertical velocity (+ is up)
    this.u0 = new Float32Array(n);
    this.v0 = new Float32Array(n);

    this.T = new Float32Array(n).fill(T_AMBIENT); // K
    this.T0 = new Float32Array(n);
    /**
     * Mixture fraction: 1 is pure fuel vapour, 0 is untouched room air.
     *
     * It is a conserved scalar - burning rearranges atoms but does not
     * create or destroy them - so it is simply advected and diffused, with
     * no source term anywhere except the wick. Everything else about the
     * flame is read off it.
     */
    this.Z = new Float32Array(n);
    this.Z0 = new Float32Array(n);
    this.soot = new Float32Array(n);   // soot volume fraction (arbitrary units)
    this.soot0 = new Float32Array(n);


    // Local reaction rate, kept for rendering: the blue base of a candle
    // flame is chemiluminescence from excited CH and C2 radicals in the
    // reaction zone, not incandescence, so it has to be drawn from the
    // reaction rate rather than from the temperature.
    this.rate = new Float32Array(n);

    /**
     * Rate of volumetric expansion, 1/s.
     *
     * Burning gas gets about five times hotter, and a gas that gets five
     * times hotter at constant pressure takes up five times the room. A
     * strictly incompressible projection has no way to express that, so the
     * plume necks down as buoyancy accelerates it instead of bulging out the
     * way a real flame does. Feeding the heat release in as a prescribed
     * divergence - the low-Mach formulation, div u = (1/T) DT/Dt - is what
     * gives the flame its width.
     */
    this.expand = new Float32Array(n);

    this.p = new Float32Array(n);
    this.div = new Float32Array(n);
    this.curl = new Float32Array(n);

    // Tunables with physical meaning.
    this.vorticityEps = 1.15;  // strength of vorticity confinement
    this.fuelSupply = 1.0;     // mixture fraction at the wick surface
    this.relaxRate = 150;      // 1/s, how fast T settles onto the flamelet
    this.sootYield = 9.0;      // 1/s, how fast soot approaches its loading
    this.sootMax = 0.32;       // saturated soot loading in a fully rich parcel
    this.sootOxidation = 26;   // 1/s, soot burnout on the lean side of the sheet
    this.coolingRate = 2.5;    // 1/s, loss beyond what diffusion already carries
    this.radiativeCooling = 3.0e-11; // 1/(K^3 s), Stefan-Boltzmann-like loss
    // Effective (eddy) diffusivity of the mixture fraction. The molecular
    // value is the floor; a sub-millimetre grid cannot resolve the fine
    // wrinkling of a real flame sheet, and raising the transport is the
    // standard way to stand in for the mixing happening below the grid. It
    // also sets flame height, since the flame closes over at the point where
    // enough air has mixed in to bring Z down to stoichiometric.
    this.wickCells = WICK_CELLS;
    this.dZ = D_MASS * 2;
    this.alphaThermal = ALPHA_THERMAL * 2;
    this.expansionGain = 1.0;  // scales the low-Mach expansion term
    this.jacobiIters = 8;

    // Externally driven bulk air motion (draft, blowing, device tilt).
    this.windX = 0;            // m/s
    this.windY = 0;            // m/s
  }

  idx(i, j) { return i + j * this.nx; }

  /**
   * Inject fuel vapour and pilot heat at the wick.
   *
   * Fuel leaves a wick slowly - it is wicked up as liquid and boils off at a
   * few millimetres per second. It is buoyancy, not any jet, that then
   * accelerates it to metres per second. Injecting it with a large upward
   * velocity produced a pencil-thin spike instead of a flame, because
   * continuity necks a fast stream down as it speeds up.
   *
   * The width matters just as much: the flame is as wide as the region where
   * fuel and air are meeting, so it is set by the wick and its pool of molten
   * wax, not by a single grid cell.
   *
   * @param {number} strength  0..1, how far the dial is turned up
   */
  injectFuel(strength, dt) {
    const { nx, Z, T, v } = this;
    const cx = nx / 2;
    // The dial is a wick length. A longer wick exposes more surface, wicks up
    // more molten wax and vaporises more of it, so it feeds a bigger flame -
    // which is exactly how you adjust a real oil lamp. So the dial sets the
    // size of the vaporising region, not an abstract "intensity".
    const radius = this.wickCells * (0.5 + 0.9 * strength);
    const j0 = 1;
    const j1 = Math.max(3, Math.round(radius * 1.6));
    const r2 = radius * radius;
    for (let j = j0; j <= j1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const dx = i - cx;
        const d2 = dx * dx;
        if (d2 > r2) continue;
        const falloff = (1 - d2 / r2) * (1 - (j - j0) / (j1 - j0 + 1));
        const k = i + j * nx;
        // The wick surface is saturated fuel vapour, so the mixture fraction
        // there is pinned near one rather than accumulated over time.
        const target = this.fuelSupply * falloff;
        if (Z[k] < target) Z[k] = target;
        // A lit wick glows at close to flame temperature whatever its
        // length, and that is what keeps re-igniting the incoming vapour.
        T[k] = Math.max(T[k], T_AMBIENT + 800 * falloff);
        // Vaporisation gives the gas only a gentle nudge upward; it is
        // buoyancy, not any jet, that accelerates it to metres per second.
        v[k] += 0.06 * falloff * dt * 60;
      }
    }
  }

  /** Buoyancy from the Boussinesq approximation: a = g (T - T_amb) / T_amb. */
  applyBuoyancy(dt) {
    const { nx, ny, T, v, u, soot } = this;
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = i + j * nx;
        const dT = T[k] - T_AMBIENT;
        // Soot is heavy relative to hot air and drags the plume slightly.
        v[k] += (G * (dT / T_AMBIENT) - 0.9 * soot[k]) * dt;
        u[k] += this.windX * dt * 3.0;
        v[k] += this.windY * dt * 3.0;
      }
    }
  }

  /**
   * Vorticity confinement. Semi-Lagrangian advection is stable but heavily
   * dissipative; without this the plume smooths into a featureless blob and
   * the flicker dies out. Here we measure the vorticity that survived and
   * push it back up along its own gradient.
   */
  applyVorticityConfinement(dt) {
    const { nx, ny, u, v, curl, h } = this;
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = i + j * nx;
        curl[k] = ((v[k + 1] - v[k - 1]) - (u[k + nx] - u[k - nx])) / (2 * h);
      }
    }
    const eps = this.vorticityEps;
    for (let j = 2; j < ny - 2; j++) {
      for (let i = 2; i < nx - 2; i++) {
        const k = i + j * nx;
        const gx = (Math.abs(curl[k + 1]) - Math.abs(curl[k - 1])) / (2 * h);
        const gy = (Math.abs(curl[k + nx]) - Math.abs(curl[k - nx])) / (2 * h);
        const len = Math.hypot(gx, gy) + 1e-8;
        const nxc = gx / len, nyc = gy / len;
        // N x omega, for the 2D case where omega points out of the plane.
        u[k] += eps * h * (nyc * curl[k]) * dt;
        v[k] -= eps * h * (nxc * curl[k]) * dt;
      }
    }
  }

  /**
   * Explicit molecular diffusion, as a five-point Laplacian.
   *
   * Advection alone leaves oxygen to reach the flame only by being carried
   * there, which starves the reaction zone between entrainment gusts and
   * makes the flame thrash between roaring and nearly out. Real oxygen also
   * diffuses, and including that is what gives a steady flame with a flicker
   * riding on top instead of a flame fighting for its life.
   *
   * The stability limit for this scheme in 2D is D*dt/h^2 <= 1/4; with air's
   * diffusivity of about 2e-5 m^2/s on a 0.7 mm grid at 2 ms per step we sit
   * near 0.08, comfortably inside it. `scratch` avoids allocating per call.
   */
  diffuse(f, D, dt, cylindrical = true) {
    const { nx, ny, h } = this;
    const cx = nx / 2;
    const k = (D * dt) / (h * h);
    if (k <= 0) return;
    // Split into as many passes as stability requires rather than silently
    // clamping, so an effective diffusivity above the single-pass limit is
    // still applied in full.
    const passes = Math.max(1, Math.ceil(k / 0.2));
    const a = k / passes;
    if (!this.scratch) this.scratch = new Float32Array(nx * ny);
    const s = this.scratch;
    for (let n = 0; n < passes; n++) {
      s.set(f);
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const c = i + j * nx;
          let lap = s[c - 1] + s[c + 1] + s[c - nx] + s[c + nx] - 4 * s[c];
          if (cylindrical) {
            // The grid is the (r, z) half plane of an axisymmetric flame, not
            // a flat slice, so the Laplacian carries an extra (1/r) d/dr term.
            // It is not a small correction: it is the difference between a
            // planar plume, which dilutes slowly, and a round one, which
            // spreads its fuel into ever more air as it rises. Without it the
            // mixture fraction never falls to stoichiometric and the flame
            // never closes over into a tip.
            const side = i < cx ? -1 : 1;
            const r = Math.max(0.5 * h, Math.abs(i + 0.5 - cx) * h);
            lap += side * h * (s[c + 1] - s[c - 1]) / (2 * r);
          }
          f[c] = s[c] + a * lap;
        }
      }
    }
  }

  /** Semi-Lagrangian advection of a scalar or velocity component. */
  advect(dst, src, dt) {
    const { nx, ny, u, v, h } = this;
    const scale = dt / h;
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = i + j * nx;
        const x = i - u[k] * scale;
        const y = j - v[k] * scale;
        dst[k] = sample(src, nx, ny, x, y);
      }
    }
  }

  /** Enforce incompressibility by projecting out the divergent part. */
  project() {
    const { nx, ny, u, v, p, div, h } = this;
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = i + j * nx;
        // Solving grad^2 p = div u - S makes the corrected field carry the
        // prescribed expansion S rather than being strictly divergence free.
        div[k] = -0.5 * h * ((u[k + 1] - u[k - 1]) + (v[k + nx] - v[k - nx]))
                 + h * h * this.expand[k];
        p[k] = 0;
      }
    }
    this.boundaryScalar(div);
    this.boundaryScalar(p);
    for (let it = 0; it < this.jacobiIters; it++) {
      for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
          const k = i + j * nx;
          p[k] = (div[k] + p[k - 1] + p[k + 1] + p[k - nx] + p[k + nx]) * 0.25;
        }
      }
      this.boundaryScalar(p);
    }
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = i + j * nx;
        u[k] -= 0.5 * (p[k + 1] - p[k - 1]) / h;
        v[k] -= 0.5 * (p[k + nx] - p[k - nx]) / h;
      }
    }
    this.boundaryVelocity();
  }

  /** Open sides and top, solid floor: Neumann everywhere except the floor. */
  boundaryScalar(f) {
    const { nx, ny } = this;
    for (let j = 0; j < ny; j++) {
      f[j * nx] = f[1 + j * nx];
      f[nx - 1 + j * nx] = f[nx - 2 + j * nx];
    }
    for (let i = 0; i < nx; i++) {
      f[i] = f[i + nx];
      f[i + (ny - 1) * nx] = f[i + (ny - 2) * nx];
    }
  }

  /**
   * The open boundaries are room air, which holds no fuel at all, so the
   * mixture fraction is pinned to zero there. Everything the flame breathes
   * is entrained across these edges.
   */
  boundaryAir(f) {
    const { nx, ny } = this;
    for (let j = 0; j < ny; j++) {
      f[j * nx] = 0;
      f[nx - 1 + j * nx] = 0;
    }
    for (let i = 0; i < nx; i++) {
      f[i] = f[i + nx];                       // wax surface: no flux
      f[i + (ny - 1) * nx] = 0;
    }
  }

  boundaryVelocity() {
    const { nx, ny, u, v } = this;
    for (let j = 0; j < ny; j++) {
      // Free-slip sides so room air can be entrained into the plume.
      u[j * nx] = u[1 + j * nx];
      v[j * nx] = v[1 + j * nx];
      u[nx - 1 + j * nx] = u[nx - 2 + j * nx];
      v[nx - 1 + j * nx] = v[nx - 2 + j * nx];
    }
    for (let i = 0; i < nx; i++) {
      // Floor is the wax surface: no flow through it.
      u[i] = 0;
      v[i] = 0;
      u[i + (ny - 1) * nx] = u[i + (ny - 2) * nx];
      v[i + (ny - 1) * nx] = Math.max(0, v[i + (ny - 2) * nx]); // outflow only
    }
  }

  /**
   * One-step combustion plus heat loss.
   *
   * Fuel burns wherever it is hot enough, releasing heat and soot. Soot then
   * oxidises again in the hottest part of the flame - which is why a healthy
   * candle produces almost no visible smoke, but a freshly blown-out one
   * produces a lot: the soot survives once the reaction zone is gone.
   */
  react(dt) {
    const { nx, ny, T, Z, soot, rate } = this;
    const dTmax = T_ADIABATIC - T_AMBIENT;
    const relax = Math.min(1, this.relaxRate * dt);
    let released = 0;

    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = i + j * nx;
        const z = Z[k];

        // --- the flamelet -------------------------------------------------
        // With chemistry this fast, temperature is a function of mixture
        // fraction alone. Fuel and air burn out completely where they meet
        // at Z = Z_st, which is the hottest point; move away in either
        // direction and the products are diluted, by excess air on one side
        // and by excess fuel vapour on the other, so the temperature falls
        // off linearly to ambient at both ends. This is the Burke-Schumann
        // solution, and its Z = Z_st surface is the closed teardrop that a
        // candle flame actually is.
        let Teq = T_AMBIENT;
        if (z > 1e-5) {
          const lean = z / Z_STOICH;
          Teq = T_AMBIENT + dTmax * (z <= Z_STOICH ? lean : (1 - z) / (1 - Z_STOICH));
        }

        const before = T[k];
        if (Teq > T[k]) {
          // Heating towards the flamelet temperature is combustion.
          T[k] += (Teq - T[k]) * relax;
          released += T[k] - before;
        }

        // Burning intensity, for the blue reaction zone. A flame sheet
        // consumes reactants at a rate set by how fast they are being
        // brought together, so this peaks where Z is near stoichiometric and
        // the mixture fraction gradient is steep.
        const near = (z - Z_STOICH) / (0.9 * Z_STOICH);
        const chi = Math.abs(Z[k + 1] - Z[k - 1]) + Math.abs(Z[k + nx] - Z[k - nx]);
        rate[k] = Math.exp(-near * near) * chi;

        // --- soot ------------------------------------------------------
        // Soot is formed by pyrolysis on the rich side of the sheet, where
        // fuel vapour is cooking without enough oxygen to burn cleanly, and
        // is consumed again as it crosses to the lean side. The rich side is
        // the whole interior of the flame, which is why the body of a candle
        // flame glows yellow rather than only its surface.
        if (T[k] > T_SOOT_IGNITION) {
          if (z > Z_STOICH) {
            // Soot inception saturates: only so much of the carbon in a given
            // parcel can end up as particles, so this relaxes towards an
            // equilibrium loading set by how rich the parcel is rather than
            // integrating upward without limit.
            const rich = Math.min(1, (z - Z_STOICH) / (0.22 - Z_STOICH));
            soot[k] += (this.sootMax * rich - soot[k]) * this.sootYield * dt;
          } else {
            // Past the tip and outside the sheet there is oxygen to spare.
            const leanness = 1 - z / Z_STOICH;
            soot[k] *= Math.max(0, 1 - this.sootOxidation * leanness * dt);
          }
        } else {
          soot[k] *= Math.max(0, 1 - 0.25 * dt);
        }

        // --- losses ----------------------------------------------------
        // Radiation is what makes a flame tip cooler than the adiabatic
        // value, and it scales steeply enough with temperature that it only
        // bites in the hottest part.
        const dT = T[k] - T_AMBIENT;
        if (dT > 0) {
          const rad = this.radiativeCooling * dT * dT * dT;
          T[k] = T_AMBIENT + dT * Math.max(0, 1 - (this.coolingRate + rad) * dt);
        }

        // Expansion from the net temperature change over this step. Cooling
        // contributes a contraction, which is equally real.
        const growth = (T[k] - before) / (before * dt);
        this.expand[k] = Math.max(-EXPANSION_CLAMP,
                                  Math.min(EXPANSION_CLAMP, growth * this.expansionGain));
      }
    }
    this.heatRelease = released;
  }

  /** Advance the whole system by dt seconds. */
  step(dt) {
    this.applyBuoyancy(dt);
    this.applyVorticityConfinement(dt);
    this.project();

    this.u0.set(this.u);
    this.v0.set(this.v);
    this.advect(this.u, this.u0, dt);
    this.advect(this.v, this.v0, dt);
    this.boundaryVelocity();
    this.project();

    this.T0.set(this.T);
    this.Z0.set(this.Z);
    this.soot0.set(this.soot);
    this.advect(this.T, this.T0, dt);
    this.advect(this.Z, this.Z0, dt);
    this.advect(this.soot, this.soot0, dt);
    this.diffuse(this.T, this.alphaThermal, dt);
    this.diffuse(this.Z, this.dZ, dt);
    this.diffuse(this.soot, D_SOOT, dt);

    this.boundaryScalar(this.T);
    this.boundaryScalar(this.soot);
    this.boundaryAir(this.Z);

    this.react(dt);
  }

  /** Total luminous emission, used to drive the room light and its flicker. */
  emission() {
    const { nx, ny, T, soot } = this;
    let sum = 0;
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = i + j * nx;
        const dT = T[k] - T_SOOT_IGNITION;
        if (dT > 0) sum += dT * Math.min(1, soot[k] * 4);
      }
    }
    return sum;
  }

  /**
   * Height of the *luminous* zone in metres.
   *
   * Not the same as the height of the hot gas: a column of hot combustion
   * products rises well above a candle flame and is completely invisible.
   * What you see is glowing soot, so that is what gets measured.
   */
  flameHeight() {
    const { nx, ny, T, soot, h } = this;
    for (let j = ny - 2; j >= 1; j--) {
      for (let i = 1; i < nx - 1; i++) {
        const k = i + j * nx;
        if (T[k] > T_SOOT_IGNITION && soot[k] > 0.02) return j * h;
      }
    }
    return 0;
  }

  reset() {
    this.u.fill(0); this.v.fill(0);
    this.T.fill(T_AMBIENT);
    this.Z.fill(0); this.soot.fill(0);
    this.rate.fill(0);
    this.expand.fill(0);
    this.p.fill(0);
  }
}
