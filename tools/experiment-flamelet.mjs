/**
 * Does a flame-sheet model with a realistically small wick give a candle?
 *
 * The prediction: an axisymmetric diffusion flame stands off from its source
 * at about sqrt(1/Z_st) ~ 4 times the source radius, because the sheet sits
 * where the fuel has been diluted roughly sixteen to one. A real candle's
 * 1.25 mm wick radius therefore gives a 5 mm flame radius - a 10 mm flame.
 *
 * The finite-rate model in fluid.js achieves a stand-off of about 1, because
 * oxygen is present everywhere and the fuel burns the moment it is warm
 * enough rather than waiting to reach stoichiometric. This checks whether the
 * flamelet gets the stand-off right when the wick is small enough that the
 * flame can also close over into a tip.
 */
import { FlameField } from '../src/fluid.js';
import { AirModel } from '../src/air.js';
import { T_AMBIENT, T_ADIABATIC, Z_STOICH, T_SOOT_IGNITION } from '../src/constants.js';

class Flamelet extends FlameField {
  constructor(nx, ny, h) {
    super(nx, ny, h);
    this.wickRadiusCells = 2.0;   // ~1.2 mm, a real candle wick
    this.relaxRate = 220;
  }

  /** The wick surface is saturated fuel vapour: Z pinned near 1, and nowhere else. */
  injectFuel(strength, dt) {
    const { nx, fuel, T, v } = this;
    const cx = nx / 2;
    const radius = this.wickRadiusCells * (0.6 + 0.7 * strength);
    const j1 = Math.max(2, Math.round(radius * 1.8));
    const r2 = radius * radius;
    for (let j = 1; j <= j1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const d2 = (i - cx) * (i - cx);
        if (d2 > r2) continue;
        const f = (1 - d2 / r2) * (1 - (j - 1) / (j1 + 1));
        const k = i + j * nx;
        if (fuel[k] < f) fuel[k] = f;                  // Z, pinned
        T[k] = Math.max(T[k], T_AMBIENT + 820 * f);
        v[k] += 0.06 * f * dt * 60;
      }
    }
  }

  /** Burke-Schumann: temperature is a function of mixture fraction alone. */
  react(dt) {
    const { nx, ny, T, fuel: Z, soot, rate } = this;
    const dTmax = T_ADIABATIC - T_AMBIENT;
    const relax = Math.min(1, this.relaxRate * dt);
    for (let j = 1; j < ny - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = i + j * nx;
        const z = Z[k];
        const before = T[k];
        let Teq = T_AMBIENT;
        if (z > 1e-5) {
          Teq = T_AMBIENT + dTmax *
            (z <= Z_STOICH ? z / Z_STOICH : (1 - z) / (1 - Z_STOICH));
        }
        if (Teq > T[k]) T[k] += (Teq - T[k]) * relax;

        const near = (z - Z_STOICH) / (0.9 * Z_STOICH);
        rate[k] = Math.exp(-near * near) *
          (Math.abs(Z[k + 1] - Z[k - 1]) + Math.abs(Z[k + nx] - Z[k - nx]));

        if (T[k] > T_SOOT_IGNITION && z > Z_STOICH) {
          const rich = Math.min(1, (z - Z_STOICH) / (0.20 - Z_STOICH));
          soot[k] += (this.sootMax * rich - soot[k]) * this.sootYield * 0.02 * dt;
        } else {
          soot[k] *= Math.max(0, 1 - this.sootOxidation * dt);
        }

        const dT = T[k] - T_AMBIENT;
        if (dT > 0) {
          const rad = this.radiativeCooling * dT * dT * dT;
          T[k] = T_AMBIENT + dT * Math.max(0, 1 - (this.coolingRate + rad) * dt);
        }
        const growth = (T[k] - before) / (before * dt);
        this.expand[k] = Math.max(-260, Math.min(260, growth * this.expansionGain));
      }
    }
  }
}

const DT = 1 / 480;
console.log('wick   I     lum w   lum h   closes    peak K   stand-off');
for (const wick of [1.5, 2.0, 3.0]) {
  for (const I of [0.5, 1.0]) {
    const f = new Flamelet(40, 130, 0.024 / 40);
    f.wickRadiusCells = wick;
    const air = new AirModel();
    for (let n = 0; n < 480 * 5; n++) {
      air.update(DT); f.windX = air.windX(); f.windY = air.windY();
      f.injectFuel(I, DT); f.step(DT);
    }
    // Luminous extent: hot and sooty.
    let w = 0, hTop = 0;
    for (let j = 1; j < f.ny - 1; j++) {
      let row = 0;
      for (let i = 1; i < f.nx - 1; i++) {
        const k = i + j * f.nx;
        if (f.T[k] > T_SOOT_IGNITION && f.soot[k] > 0.02) { row++; hTop = j; }
      }
      if (row > w) w = row;
    }
    // Where the mixture fraction on the axis falls to stoichiometric: the tip.
    let close = -1;
    for (let j = 1; j < f.ny - 1; j++) {
      if (f.fuel[20 + j * f.nx] < Z_STOICH) { close = j * f.h * 1000; break; }
    }
    let peak = 0;
    for (let k = 0; k < f.T.length; k++) if (f.T[k] > peak) peak = f.T[k];
    const wickMm = wick * (0.6 + 0.7 * I) * f.h * 1000;
    console.log(
      `${wick.toFixed(1).padStart(4)}  ${I.toFixed(1)}  ${(w * f.h * 1000).toFixed(1).padStart(6)}  ` +
      `${(hTop * f.h * 1000).toFixed(0).padStart(6)}  ${(close < 0 ? '>78' : close.toFixed(0)).padStart(6)}  ` +
      `${peak.toFixed(0).padStart(8)}   ${(w * f.h * 500 / wickMm).toFixed(1)}x`);
  }
}
