/**
 * Physical constants for the candle simulation.
 *
 * Everything here is in SI units and sourced from real measurements of
 * paraffin-wax candles. The renderer converts metres to pixels exactly once
 * (see `renderer.js`), so the simulation itself never thinks in pixels.
 *
 * References for the values used:
 *  - Hamins, Bundy & Dillon, "Characterization of Candle Flames",
 *    Journal of Fire Protection Engineering 15 (2005): a standard 2 cm candle
 *    burns ~0.105 g/min and releases ~80 W, flame height ~40 mm.
 *  - Faraday, "The Chemical History of a Candle" (1861) for the melt-pool /
 *    capillary description that the wax model follows.
 *  - Flicker frequency correlation f ~ 1.5 / sqrt(D) Hz for buoyant diffusion
 *    flames (Cetegen & Ahmed, Combustion and Flame 93 (1993)), which puts a
 *    ~10 mm candle at 12-15 Hz.
 */

// ---------------------------------------------------------------- environment
export const G = 9.81;                 // m/s^2, gravitational acceleration
export const T_AMBIENT = 293.15;       // K, room temperature (20 C)
export const RHO_AIR = 1.204;          // kg/m^3, air density at T_AMBIENT
// Molecular transport in air near room temperature. These matter: a candle
// burns as a *diffusion* flame, so the rate at which oxygen can diffuse into
// the reaction zone is what holds the flame steady between puffs.
export const D_MASS = 2.0e-5;          // m^2/s, O2 and fuel vapour in air
export const ALPHA_THERMAL = 2.2e-5;   // m^2/s, thermal diffusivity of air
export const D_SOOT = 4.0e-6;          // m^2/s, soot particles are far slower

// ---------------------------------------------------------------------- flame
// Adiabatic flame temperature of paraffin in air is ~2000 K, but the luminous
// soot shell that we actually see radiates between roughly 1100 K (dim tip)
// and 1700 K (bright body). The blue base is chemiluminescence, not a
// blackbody, so it is added separately by the renderer.
export const T_FLAME_PEAK = 1700;      // K, hottest luminous soot
export const T_ADIABATIC = 2230;       // K, adiabatic flame temperature of paraffin in air
export const STOICH_RATIO = 3.45;      // kg of O2 consumed per kg of paraffin
export const Y_O2_AIR = 0.232;         // mass fraction of oxygen in air
/**
 * Stoichiometric mixture fraction: the proportion of fuel in a fuel-air mix
 * that burns with nothing left over. For paraffin it is about 0.063 - fuel
 * and air burn cleanly at roughly one part fuel to fifteen parts air.
 *
 * This small number is the single most important fact about the shape of a
 * candle flame. The flame sits where the mixture fraction has fallen to
 * Z_st, and because that is so dilute, the sheet stands far out from the
 * wick in air that has been heavily diluted by diffusion. It is why a
 * diffusion flame is many times wider than the wick that feeds it, and why
 * it closes over into a teardrop rather than running on as a column.
 */
export const Z_STOICH = Y_O2_AIR / (Y_O2_AIR + STOICH_RATIO);
export const T_SOOT_IGNITION = 1000;   // K, soot inception, where particles form
/**
 * Where soot stops being *visible*, which is a different number entirely.
 * Particles keep radiating as they cool past inception, and the dull red
 * outer envelope and tip of a candle flame are soot down around 800 K.
 * Using the inception temperature as the emission cutoff cropped that whole
 * envelope away and left only a thin bright core.
 */
export const T_SOOT_GLOW_FLOOR = 820;
export const FLAME_DIAMETER = 0.010;   // m, luminous zone width
export const FLAME_HEIGHT = 0.040;     // m, typical steady flame height
export const FLICKER_HZ = 1.5 / Math.sqrt(FLAME_DIAMETER); // ~15 Hz

// Luminous output. The candela was originally defined as the luminous
// intensity of one standard candle, which is where the 1.0 comes from.
export const LUMINOUS_INTENSITY = 1.0; // cd at full intensity
export const T_COLOR_ROOM = 1850;      // K, correlated colour temp of the cast light

// ------------------------------------------------------------------------ wax
export const RHO_WAX = 900;            // kg/m^3, solid paraffin
export const T_WAX_MELT = 330;         // K (57 C), paraffin melting point
export const T_WAX_POOL = 345;         // K, steady temperature of the melt pool
export const HEAT_OF_COMBUSTION = 46.1e6; // J/kg, paraffin
export const MASS_BURN_RATE = 0.105 / 60 / 1000; // kg/s (0.105 g/min)
export const HEAT_RELEASE = MASS_BURN_RATE * HEAT_OF_COMBUSTION; // ~81 W

// Only a few percent of the flame's heat conducts back down into the wax;
// the rest radiates and convects away. This fraction sets the melt pool depth.
export const MELT_FEEDBACK_FRACTION = 0.03;
export const HEAT_OF_FUSION_WAX = 200e3; // J/kg
export const WAX_CONDUCTIVITY = 0.25;    // W/(m K), solid paraffin

// ---------------------------------------------------------------- candle body
// A slimmer pillar, 28 mm across. Two reasons, both of which matter: the
// flame reads at the right scale against it (a real candle's flame is roughly
// a quarter of the candle's width), and a narrower column loses height far
// faster for the same mass burnt - about 11 mm an hour rather than 4 - so the
// melting is actually something you can watch happen.
export const CANDLE_RADIUS = 0.014;    // m
export const CANDLE_HEIGHT_0 = 0.130;  // m, starting height
export const WICK_RADIUS = 0.0008;     // m
export const WICK_EXPOSED = 0.006;     // m of wick standing above the wax

// ---------------------------------------------------------- molten wax rheology
// Molten paraffin is close to Newtonian just above its melting point. The
// viscosity climbs steeply as it cools, which is exactly why a drip slows
// down as it runs and then freezes in place partway down the side.
export const MU_WAX_REF = 4.0e-3;      // Pa s at T_WAX_POOL
export const MU_ARRHENIUS_E_OVER_R = 6000; // K, activation temperature
export const WAX_COOLING_TAU = 2.2;    // s, Newtonian cooling time of a drip

// ------------------------------------------------------------------------ air
// Blowing on a candle produces a jet of order 1-5 m/s at the flame. A flame
// is extinguished when the strain it experiences outruns the chemistry, i.e.
// when the Damkohler number falls below unity.
export const BLOW_VELOCITY_MAX = 6.0;  // m/s
export const EXTINCTION_STRAIN = 165;  // 1/s, critical strain rate
export const DRAFT_SIGMA = 0.045;      // m/s, RMS of the ambient room draft
export const DRAFT_TAU = 1.7;          // s, correlation time of that draft
