# Candle

A candle simulated from first principles: buoyant combustion, blackbody
radiation, and wax that actually melts.

<!-- The flame in this app is not drawn. It is solved. -->

There are a lot of candle apps. Almost all of them animate a flame-shaped path
with some randomised jitter, and they all look like animated flame-shaped
paths, because a flame's shape *is* its fluid dynamics — the flicker you
recognise is a ring vortex shedding off a buoyant plume at ten-odd hertz, not
noise added to a curve.

So this one runs the physics instead.

## What is actually simulated

**The flame** is a buoyant reacting flow on a grid: semi-Lagrangian advection
with a Jacobi pressure projection (Stam, *Stable Fluids*, 1999), vorticity
confinement to restore the small-scale motion that first-order advection
dissipates (Fedkiw, Stam & Jensen, 2001), Boussinesq buoyancy, and molecular
diffusion of heat and species at air's real diffusivities. Fuel and oxygen are
tracked separately, because a candle is a *diffusion* flame — the two arrive
separately and can only burn where they meet, which is what leaves a cool,
sooty, fuel-rich core inside a thin reaction sheet.

Two details matter more than they might sound:

- **Heat release makes gas expand**, roughly fivefold. A strictly
  incompressible projection cannot express that, and without it the plume
  necks down into a spike instead of bulging into a flame. Expansion is fed in
  as a prescribed divergence, the low-Mach formulation.
- **The grid is the (r, z) half-plane of an axisymmetric flame**, not a flat
  slice, so both the Laplacian and the divergence carry their cylindrical
  `1/r` terms. Leaving them out gives a planar plume, which dilutes far too
  slowly.

**The wax** burns at the measured rate of a real candle: 0.105 g/min, which
comes out as 6.30 g and 80.7 W per hour (Hamins, Bundy & Dillon, *Journal of
Fire Protection Engineering*, 2005). Height falls as `dh/dt = ṁ/(ρA)`. The
melt pool depth comes from a quasi-steady Stefan balance at the melt front and
lands at one to two millimetres. Liquid wax levels under gravity while solid
wax does not, which is what carves the crater with its standing rim — and when
the rim finally melts through, the pool runs over the edge as drips whose
Arrhenius viscosity climbs steeply as they cool, so they slow down and set
partway down the side.

**The light** is Planck's law integrated against the CIE 1931 observer, not a
palette. Candlelight at 1850 K comes out as `#ff8500` because that is what
1850 K looks like. Illuminance falls off as `I/(d(d+L))` — a candle flame is a
40 mm column, not a point, so it goes as `1/d` close in and `1/d²` far away.

**The picture** is a forward Abel projection. The solver works on a slice, but
a camera integrates emission along the whole chord through an axisymmetric
flame; running that transform forwards is what gives the flame its width and
its bright limb. Then Reinhard tone mapping, because a flame covers far more
dynamic range than a screen does.

## Built for OLED

Most Android phones this would run on have OLED screens, where a black pixel
is switched off rather than dark. That changes what "realistic" means: any
pixel that is not black is the display emitting light, and in a dark room a
faint glow spread across the whole panel reads immediately as a screen rather
than as a flame.

So light in this app **stops**. Both the glare around the flame and the pool of
light on the surface are tapered to zero well inside their own radius, and any
value that would not survive quantisation to 8 bits is snapped to zero rather
than left as one count across half the screen. Outside those regions nothing
is drawn at all, so the pixels stay off.

This is also the more physically honest rendering. The full-screen wash that
was there before represented light scattering off nothing — the scene has no
wall and no dust for it to bounce from.

Roughly 55-62% of the frame is genuinely off, depending on the dial, against
0% before. `tools/oled.mjs` measures it and fails if it regresses:

```bash
I=1.0 node tools/oled.mjs
```

The native shell also declines to drive the backlight anywhere near full. A
candle is about one candela — a few lux at arm's length — while a phone at
full brightness is hundreds of nits, and on OLED brightness scales every lit
pixel at once. The dial maps to 8-70% of panel brightness.

Screen burn-in is the other OLED concern for an app meant to be left running.
It is mitigated by the simulation rather than by a screensaver: the flame is
never still, and the candle measurably burns down, so the bright region drifts
down the screen over a session instead of sitting on one set of pixels.

## Running it

```bash
node tools/build.mjs        # -> dist/candle.html, one self-contained file
```

Open `dist/candle.html` in any browser, including on a phone. No server, no
network, no dependencies.

For the APK, see [docs/BUILD.md](docs/BUILD.md).

## The code

| File | What it holds |
| --- | --- |
| `src/constants.js` | Every physical constant, in SI, with its source |
| `src/fluid.js` | The reacting-flow solver |
| `src/wax.js` | Burning, melting, the pool, the crater, drips |
| `src/air.js` | Room draft, device tilt, blow-out |
| `src/blackbody.js` | Planck's law → CIE → sRGB |
| `src/abel.js` | Forward Abel projection |
| `src/flamecolor.js` | Simulation state → emitted colour |
| `src/renderer.js` | Everything that reaches the screen |
| `src/audio.js` | Synthesised wick crackle |
| `src/app.js` | Loop, dial, and the modes |

## Development

```bash
node --test "test/*.test.mjs"   # physics invariants
node tools/calibrate.mjs        # flame size and temperature across the dial
node tools/flamepic.mjs 0.7 6 shots/f.ppm   # flame shape, no browser needed
node tools/shoot.mjs            # the whole app at phone size
node tools/verify-bundle.mjs    # the built file, loaded as a phone would
```

`tools/calibrate.mjs` takes arbitrary overrides — `node tools/calibrate.mjs
fuelBase=4 expansionGain=6` — which is how the parameters were found.

### Two things worth knowing before changing anything

**The room draft is not decoration.** The solver, the grid and the wick are
all exactly symmetric, so in perfectly still air the flame is perfectly steady
and stays that way — as a real candle under a cloche does. The
Ornstein-Uhlenbeck draft in `air.js` is what breaks that symmetry and lets the
buoyancy instability grow. Remove it and the flame goes dead. There are tests
pinning both behaviours.

**`expansionGain` is not 1.** The physically exact value is, but a real flame
sheet is a tenth of a millimetre thick and the cells are six tenths, so the
reaction zone is badly unresolved and its expansion gets smeared across cells
and partly cancelled. About 40% survives. The gain is the sub-grid correction
that restores it, and it is the single parameter that controls how wide the
flame is.

## What it does beyond burning

A circular dial that is a wick length — turn it up and the wick delivers more
vapour, exactly as the wheel on an oil lamp works. Blow at the phone and the
flame goes out, when the strain rate you impose beats the rate the chemistry
can release heat (the Damköhler criterion — which is why a sharp puff works
and steady breathing does not). A 25-minute focus session. A reading light. A
solitude mode that takes the interface away and leaves the flame. Synthesised
wick crackle, generated as Poisson-distributed events rather than looped,
because any loop eventually becomes recognisable.

No account, no analytics, no network permission.

Two deliberate omissions. The focus timer **pauses** when you leave the app
rather than blowing the candle out — punishing someone for glancing at a
message doesn't build a habit, it builds resentment, and a phone call
shouldn't cost you the session. And solitude mode shows no text at all: being
handed someone else's chosen words to read is the opposite of what that mode
is for.
