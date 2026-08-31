# Real Candle — project handover

**Read this before doing anything else. It replaces the conversation.**

Maintained alongside the code — updated in the same commit as the change it
describes, so its dates can be trusted. Written so a session that has never
seen the chat history can pick the work up without repeating it. The most valuable part is
[What has already been tried and failed](#what-has-already-been-tried-and-failed) —
those are measured dead ends, not guesses, and re-running them costs hours.

---

## 0. What it is *for* — read this before deciding what "better" means

Settled with the user on 2026-08-30, and it changes the priorities:

**This is an ambient companion for students and ASMR listeners** — something
alive on the corner of a desk that makes a long solitary session feel less
mechanical. It is not a candle novelty. The user's words: a companion and not a
distraction, beautiful and realistic and alive, something that lifts a mundane
schedule.

Consequences, because they are not obvious:

- **Sound is half the product, not a garnish.** For the ASMR half of the
  audience it is most of the product.
- **Nothing may demand attention.** No notifications, no streaks, no
  gamification. The app already honours this; keep it that way.
- **Sessions are long.** An hour or more, screen on, propped up. Battery,
  CPU and anything that accumulates over time matter more than they would in an
  app used for ninety seconds.
- A wider flame is not automatically better; a flame that feels *alive* is.

## 1. What this is

An Android app: a candle on your phone that behaves like a real one. The
screen should give off a candle's light in a dark room, not merely draw a
picture of one.

The distinguishing idea, and the thing not to compromise: **the flame is
simulated, not animated.** A buoyant reacting-flow solver runs the fire; the
colour comes out of Planck's law; the wax melts at the measured burn rate of a
real candle. Nothing is keyframed and there are no image assets.

## 2. Where this came from

The user arrived with a transcript of a long Gemini session (`candle_app.docx`,
uploaded, ~250 KB) that had gone through about eight rewrites without producing
anything that looked real. Every version drew the flame as hand-tuned bezier
curves with `Math.random()` jitter for flicker, and the wax as a gradient-filled
cylinder. That thread also never managed to deliver a working file — the user
repeatedly asked for something openable and never got it.

The user later said: **"doc is for reference only, make your own judgement.
gemini sucks."** So the transcript is background, not a specification.

### What the user actually asked for

Original brief, condensed from the transcript:

- Fullscreen candle; the screen emits light matching a real candle
- A **circular dial** to control flame intensity
- Yellowish flame, alive, animated — should not read as a screen
- **Melting**: the candle burns down, height decreases, wax drips
- Fast, beautiful, "built by a senior engineer"
- Deployable to Google Play, compliant

Added later, directly by the user:

- **OLED**: on a phone where black pixels are off, light must come from the
  flame only. Anything else is the panel glowing on its own account.
- **Screen lock** button, to prevent stray taps and get clean screenshots
- Renamed to **Real Candle**

## 3. Current state

Branch: `claude/app-realistic-physics-up3gkx`. 16 commits. Installed and
running on the user's phone (Xiaomi/MIUI).

### Confirmed working on the device

| | |
|---|---|
| Renders as a convincing candle | ✅ |
| OLED — true black outside the lit area | ✅ user-confirmed |
| Screen lock | ✅ user-confirmed "100%" |
| Light pool at the base | ✅ user-confirmed fixed |
| Focus timer + candle shrinking | ✅ user-confirmed over a full session |
| Microphone blow-out | ✅ user-confirmed, on native `AudioRecord` capture |
| Microphone on a **fresh install** | ✅ user-confirmed after the ordering fix |
| Screen returns to black in zen too | ✅ user-confirmed |
| Focus session survives leaving the app | ✅ user-confirmed |
| Double-tap to wake, ring to relight | ✅ user-confirmed |
| System bars hidden, incl. after the mic | ✅ user-confirmed |
| Full 25-minute focus run | ✅ user-confirmed |

### Not yet working

- **Flame shape.** Too thin and column-like; lacks teardrop volume. The user
  has explicitly deferred this to last and named it "the issue you have failed
  at repeatedly." See [§5](#what-has-already-been-tried-and-failed).

### How it is verified

Nothing here is verified by inspection alone. Every check is runnable:

```bash
node --test "test/*.test.mjs"   # 16 physics invariants
node tools/build.mjs            # -> dist/candle.html, one self-contained file
node tools/verify-bundle.mjs    # loads the built file in a real browser
node tools/tap-check.mjs        # 14 checks: taps, dial, lock (real touchscreen)
I=1.0 node tools/oled.mjs       # fails if the panel is lit where it shouldn't be
node tools/calibrate.mjs        # flame size/temperature across the dial
node tools/flamepic.mjs 0.7 6 shots/f.ppm   # flame shape, no browser needed
```

`tools/calibrate.mjs` takes arbitrary overrides —
`node tools/calibrate.mjs fuelBase=4 expansionGain=6` — which is how every
parameter was found.

## 4. Architecture

| File | Holds |
|---|---|
| `src/constants.js` | Every physical constant, SI, with its source cited |
| `src/fluid.js` | The reacting-flow solver. The heart of it. |
| `src/wax.js` | Burning, melting, the pool, the crater, drips |
| `src/air.js` | Room draft, device tilt, blow-out detection |
| `src/blackbody.js` | Planck's law → CIE 1931 → sRGB |
| `src/abel.js` | Forward Abel projection |
| `src/flamecolor.js` | Simulation state → emitted colour |
| `src/renderer.js` | Everything that reaches the screen |
| `src/audio.js` | The shared `AudioContext` and noise buffer, the wick crackle (Poisson events, not a loop), and `crackleDrive` |
| `src/rain.js` | Synthesised rain on a roof: hiss, roof body, discrete taps, and `rainDrive` |
| `src/app.js` | Loop, dial, modes, lock |
| `android/` | Thin WebView shell — one Kotlin Activity |
| `.github/workflows/android.yml` | Builds the APK; see [§6](#6-environment-constraints) |
| `tools/shape.mjs` | **Width**, where the flame is widest, its taper, soot mass, ceiling clearance — at three dial settings |
| `tools/audio-check.mjs` | The crackle in a real browser: does it follow the flame, and does the audio graph leak |

### The physics that matters

- **Solver**: Stam stable-fluids (semi-Lagrangian advection + Jacobi
  projection), Boussinesq buoyancy, vorticity confinement, molecular diffusion
  at real diffusivities. Separate fuel and oxygen fields, because a candle is a
  *diffusion* flame.
- **Low-Mach expansion**: heat release makes gas expand ~5×, fed in as a
  prescribed divergence. Without it the plume necks into a spike.
- **Cylindrical terms**: the grid is the (r,z) half-plane of an axisymmetric
  flame, so both the Laplacian and the divergence carry their `1/r` terms.
- **Wax**: 0.105 g/min → the measured 6.30 g/h and 80.7 W. Melt-pool depth from
  a quasi-steady Stefan balance (~1.65 mm). Drips with Arrhenius viscosity.
- **Abel projection**: the solver works on a slice; a camera integrates along
  the chord through an axisymmetric flame. Gives width and limb brightening.

### Three things that will look like bugs and are not

1. **`expansionGain` is 4, not the physically exact 1.** A flame sheet is
   ~0.1 mm and the cells are 0.6 mm, so the reaction zone is unresolved and its
   expansion is smeared across cells and partly cancelled — about 40% survives.
   It is a sub-grid correction, and it is the single parameter that controls
   flame width.
2. **The room draft is not decoration.** Grid, wick and boundaries are exactly
   symmetric, so in perfectly still air the flame is perfectly steady and stays
   that way. The Ornstein-Uhlenbeck draft in `air.js` is what breaks the
   symmetry and lets the buoyancy instability grow. Remove it and the flame
   goes dead. Tests pin both behaviours.
3. **`timeScale` is 6.** Real burn is ~11 mm/hr, too slow to watch. Six gives
   21% of the candle per 25-minute session. It was 90 and burned out in eight
   minutes.

---

## 5. What has already been tried and failed

**Read this before touching flame width.** Nine approaches before 2026-08-30,
six more measured that day. All measured, none guessed.

| Approach | Result |
|---|---|
| Widening the wick source | No effect — the plume necks down regardless |
| Temperature-dependent thermal diffusivity (α ∝ T^1.75) | **Made it worse** — smaller and cooler. Quenches the reaction rather than spreading it. Molecular value beats it. |
| More Jacobi iterations (8 → 60) | No change. Projection was already converged. Keep 8; it's cheap. |
| Rich core + fast sheet chemistry (`burnRate` 480) | Oxygen-depleted core achieved, but flame filled the domain and produced no soot at low intensity |
| **Burke–Schumann flamelet rewrite** | Did not close into a tip; burned as a column filling the domain. Stand-off measured **0.4–0.6×** against the predicted 4×. Reverted. Re-tested later with a realistic wick — same result. Genuinely closed. |
| Eddy diffusivity 1.5e-4 (derived from real candle geometry) | Width numbers improved to 7 mm, **but the render got worse** — flame clipped the domain ceiling with a hard flat cut. Reverted. |
| Raising Abel `refRadius` to widen the flame | **Wrong idea.** It is a brightness normalisation only; it cannot widen anything. |
| **Enlarging the domain** (height 78→156 mm, width 24→48 mm) | **No effect whatsoever.** Hot-zone width is 3.0 mm in every configuration. This kills the lead this section used to recommend. |
| Eddy thermal diffusivity + a taller domain | Clips the ceiling at *every* height (77/78, 119/120, 155/156 mm). Its width comes from heating the whole column — the profile is a flat 11.4/11.4/10.8/10.2/9.6, a cylinder, not a flame. |
| Fast chemistry alone (`burnRate` 480, so `burnRate·dt` = 1) | Hot width 3.0→4.2 mm and the widest point moves off the base — then **soot is exactly zero**, and neither `sootYield` nor `sootOxidation` moves it off zero. Mechanism below. |
| Fast chemistry + rich core (`fuelBase` 12) + rescaled `heatPerFuel` | Produces a genuine oxygen-free core (`minOx` 0.0000, 105 cells) and hot width to 6.6 mm — but the *sooty* zone collapses to 0.6–2.4 mm at the base and soot mass falls 2–5×. The visible flame gets narrower, which is backwards. |
| Fast chemistry + rich core + raised **mass** diffusivity (5e-5, 1e-4) | Worse again. Spreading the fuel destroys the rich core that was the point, and temperature pins to the adiabatic clamp at 2219 K. |
| `expansionGain` 6–9 with the wider footprint | Reaches the target — 6.6–9.0 mm, widest point finally off the base at 13–16% of height — and then **fills the domain vertically** (h = 76.8 mm in a 78 mm box) and loses its tip. The eddy failure mode again, and the same mistake: a width metric improved while the picture got worse. |

### What did work

- The `u/r` term in the divergence (was missing; largest near the axis)
- Low-Mach expansion with the sub-grid gain
- Forward Abel projection
- Separating soot *inception* temperature from the temperature at which soot
  *stops glowing* (they are not the same number; conflating them cropped the
  entire cool outer envelope)

### Best current understanding of the remaining gap

**Corrected 2026-08-30.** This section used to say the domain ceiling was
probably the thing to fix first. That was measured and it is wrong: enlarging
the domain in either direction changes the width by nothing at all. Anyone
following that advice would waste a session, which is why it is called out
rather than quietly edited.

The real deficiency is structural, and it is one number:

> **Oxygen is never consumed anywhere in the domain.** `minOx` is 0.634 with
> the shipped parameters, and not one cell holds fuel without oxygen.

So there is no fuel-rich core, and this is **not behaving as a diffusion flame
at all** — it is a slow burn spread through the whole fuel plume, which is why
it is shaped like a plume from a source rather than an envelope. That explains
every result above at once: width knobs either do nothing, or they produce a
hot column that has to be clipped by the ceiling.

A second, smaller finding: the injection profile falls off as `(1 - d²/r²)`, so
only the middle of the footprint is hot enough to burn. **The flame measured
narrower than its own source** — 3.0 mm from a 6.4 mm source.

What actually shipped is the small, safe half of that second finding: the
footprint widened (`WICK_CELLS` 5→9) with fuel density halved to hold the heat
release constant. Soot width 3.6→4.8 mm at mid dial, flame height 52.8→58.2 mm,
peak temperature unchanged at 1459 K against 1461 K, and it still tapers to a
tip. Modest and honest; it does not make a teardrop.

**If someone attacks this again**, the target is the rich core: make the solver
deplete oxygen near the wick so a stoichiometric surface can form, without the
fuel load that sends the temperature to the adiabatic clamp. Every attempt so
far has had to choose between the two. Nothing above suggests a width knob is
the answer — six were tried in one day and the two that reached the target
width did it by filling the box.

---

## 6. Environment constraints

- **This container cannot build the APK.** `dl.google.com` is blocked by egress
  policy (403 on CONNECT), and it serves both the Android SDK and the Android
  Gradle Plugin. `maven.google.com` just redirects there. Verified, not assumed.
- **`services.gradle.org` *is* reachable.** Only Google's host is blocked.
- **CI builds the APK** on GitHub runners. Every push produces a downloadable
  `candle-debug-apk` artifact. That workflow is also the only place the Kotlin
  is ever compiled.
- **Artifact downloads require being signed in to GitHub**, even on a public
  repo. The user will hit this.
- The container is ephemeral. Commit and push, always.

## 7. Open issues

1. **Flame shape** — see §5. Deferred by the user to last. This is now the only
   substantial thing left.

## 8. Play Store readiness

Audited. `targetSdk 36`, release variant verified non-debuggable in CI, WebView
hardened explicitly, no `INTERNET` permission, `PRIVACY.md` written and accurate.
Two permissions only: `RECORD_AUDIO` (requested on tap, never at launch, never
recorded or transmitted) and `VIBRATE`.

Not done: signing config (deliberately not in the repo), store listing,
screenshots, privacy policy hosted at a public URL. `docs/BUILD.md` covers all
of it, including the Gradle timeout that stalled the original attempt.

## 9. Progress log

Append-only. Newest last. Records what changed and what it meant, so the
trajectory is visible and not just the current state.

### 2026-08-30 — first build on real hardware

The app reached the user's phone for the first time (Xiaomi/MIUI). Everything
before this was verified in a desktop browser and by review only, and the gap
between those showed immediately.

Confirmed working on the device: the render, OLED blacks, the screen lock, the
light pool at the base, and the timer and melting so far.

Six bugs reported from real use, five fixed:

- **Focus timer ran at about a fifteenth of real speed.** Decremented inside a
  quarter-second display update but by that update's own frame delta, so it
  discarded ~94% of every interval. Two of the user's screenshots six minutes
  apart showed 35 seconds elapsed — the ratio almost exactly.
- **Candle burned out in ~8 minutes.** `timeScale` was 90 against an 11 mm/hr
  real burn. Now 6: about a fifth of the candle per 25-minute session.
- **Crackle continued over an empty screen.** Its level was only set when the
  flame was toggled by hand, so burning out never touched it. Burning out is
  now a real state — the wick starves at a 7 mm stub.
- **Light flooded the base.** The ground pool used a fixed radius regardless of
  flame height. Now follows `E = I·h/(d²(d+L))`, so it narrows as the flame
  descends.
- **Tapping almost anywhere snuffed the candle.** The hit region was a fixed
  band covering roughly a third of the screen, and it fired while the controls
  were hidden — so the tap that brought them back also put it out.
- **The dial was hard to use.** It tracked finger angle around a 92 px ring.
  Now a vertical drag with a pointer on the ring.

Added: screen lock, renamed to Real Candle, `tools/tap-check.mjs` (14 checks,
in CI).

Still open at that point: the microphone, and the flame's shape.

### 2026-08-30 — microphone: two theories disproved by the device

The diagnostics readout added for this purpose earned itself immediately.
The device reported:

```
error: NotReadableError   attempts: 4
OS permission: granted    secure context: yes
```

Four attempts across three seconds, permission genuinely held, proper secure
origin. That **rules out** the first two fixes, both of which were aimed at
causes inferred from the error name alone:

1. Permission acquired during `getUserMedia` rather than before it — real, and
   fixed the prompt timing, but not the cause of this.
2. The WebView audio stack not settled after resume — plausible, and wrong.
   Four spaced attempts kill it.

Current theory, and the reason it is more than a guess: the app requests
`echoCancellation: false, noiseSuppression: false, autoGainControl: false`,
because noise suppression removes exactly the sound of a blown breath. Many
Android devices cannot disable those processors — there is no raw path through
the driver — and an unsatisfiable request fails to open the device at all,
which surfaces as `NotReadableError` and reads like a hardware fault.

`enableMic` now walks a ladder of requests: raw, raw again, plain
`{audio: true}`, plain again. A processed stream still detects a puff,
attenuated rather than absent, so the detection floor moves with it. The
diagnostics also now report the audio-input count the WebView can see and
which request shape was last tried.

**Untested on the device as of writing.** If it fails again, `audio inputs: 0`
would point upstream of this app entirely — MIUI's privacy layer is the
suspect — while a success on `plain` confirms the constraint theory.

### 2026-08-30 — rain, and a shared audio context

Second stage of the sound work. Rain on a roof, synthesised like everything
else: no files, nothing to license, nothing added to the download, and no loop
for the ear to find over a two-hour session.

Three layers, because that is what the sound is: a hiss of drops too small to
resolve, the roof itself drumming in a narrow band around 420 Hz, and the drops
big enough to hear landing one at a time as a Poisson process. Heavier rain is
not just louder — the hiss gains top end, the roof drums harder and the taps
arrive faster until they blur. One control moves all of it, with a slow wander
so it swells and eases.

**The performance risk was measured before anything was built**, which the plan
required: 160 drop-chains a second held 59.9 fps beside the fluid solver with
live node counts bounded. A node per drop is fine, so no AudioWorklet. The
ceiling shipped is 50/s, and a test pins it there.

**Every layer now shares one `AudioContext`.** A context carries its own audio
thread and browsers cap how many a page may hold, and this app is meant to sit
on a desk for hours. Layers register by *name in a Set* rather than by
counting — a refcount gets it wrong the moment a stop and a start overlap,
which they do during the fade. The context suspends rather than closes when the
last layer stops.

Three things this session found that are worth carrying:

- **The bundler's module list is hand-maintained and fails silently.** A file
  missing from `MODULES` in `tools/build.mjs` is simply absent from the bundle,
  and the first symptom is a `ReferenceError` in a browser naming a class
  nobody can find. It now fails the build instead, by comparing the list
  against `src/*.js`.
- **A test's wake tap started snuffing the candle.** `audio-check` tapped at
  (200, 300) to wake the interface; widening the vaporisation footprint earlier
  the same day made the flame wide enough to be *at* that point. A reminder
  that geometry changes reach the tests, and incidentally hard evidence the
  flame really did get bigger.
- **Nobody can hear CI.** So rain is checked two ways: how many drops actually
  land, measured from real node creations, and an analyser on the layer's own
  output confirming the sound is broadband with the top rolled off — 13–20 kHz
  sits about fifty times below the mid band. That distinguishes rain from white
  noise and from a tone without anyone listening.

**Untested on the device, and worth checking first:** whether the audio actually
stops when you leave the app. The shell calls `WebView.onPause`, which makes no
firm promise about media, and this project has now been bitten three times by
Android signals that read correctly and did nothing. Rain still playing after
you switch apps would be the worst possible bug for a background companion.

Next: wind, driven from the same Ornstein-Uhlenbeck process in `air.js` that
already leans the flame, so the gust heard and the lean seen are one event.

### 2026-08-30 — the app got a purpose, and the sound got wired to the flame

**The positioning changed, and it came from the user.** Not a candle app: an
ambient companion for students and ASMR listeners. That is recorded in the new
§0 because it changes what "better" means — a wider flame is not automatically
an improvement, a flame that feels alive is, and sound stops being a garnish.

My own commercial read was worse than theirs and it is worth saying so. I had
judged it as "candle app", a novelty category with no willingness to pay. As an
ambient companion it sits next to Forest and the study-with-me and lofi
audiences, where people demonstrably do pay. Their framing was better than
mine.

**The crackle was driven by the dial.** `setLevel(state.intensity, lit)` — the
knob, not the flame. The simulation computed emission, reaction rate and
flicker every frame and none of it reached the speaker, so the candle could
gutter, recover, or be blown at in complete silence. It looked alive and
sounded like a metronome.

It now takes `renderer.luminance()` and the smoothed rate of change of it, plus
`air.blow`. Two constants, both measured rather than chosen: luminance is
divided by 1.45 (its ceiling) and flutter by 0.6 (its 95th percentile, sampled
with the draft running). The first matters more than it looks — normalised
luminance is 0.31/0.61/0.97 across the dial where the old code passed
0.25/0.70/1.00, so **the existing tuning carried over untouched and the resting
sound is unchanged.** Only the response is new. A test pins that, so a later
change cannot quietly make it louder.

The mapping is a pure function, `crackleDrive`, for the same reason the
microphone works: measure in one place, decide in another, test the decision.
Six unit tests, no browser needed. One of them caught a real hole immediately —
`Number.isNaN(undefined)` is false, so `undefined` slid through the clamp and
arrived as NaN a line later.

The scheduling horizon dropped from 0.6 s to 0.35 s. Ticks already scheduled
cannot be recalled, so that horizon *is* the latency between seeing a gutter
and hearing it.

`tools/audio-check.mjs` is new and runs in CI. It measures the tick rate from
real node creations in a browser — 3.4/s at a low dial against 6.3/s at a high
one, close to the 3.1 and 6.7 predicted offline — confirms a snuffed candle
falls silent, and **counts live audio nodes**, because every tick builds a small
graph and a leak would only surface after an hour on a desk. Currently 2 live
of 239 created.

Next, in order: rain, then wind driven from the same Ornstein-Uhlenbeck process
that already leans the flame, then a stream and night insects, then a mixer.
Birdsong is excluded — it cannot be synthesised convincingly this way and comes
out sounding like a theremin.

### 2026-08-30 — flame shape: six more dead ends, one modest gain

The last substantial item, and the one deferred to last throughout. Measuring
before changing anything killed the lead this document itself recommended.

**The domain ceiling is not the constraint.** §5 said it was probably the thing
to fix first. Hot-zone width is 3.0 mm whether the box is 78 mm or 156 mm tall,
24 mm or 48 mm wide. That advice would have cost the next session a day, so it
is corrected in place rather than quietly dropped.

**The structural finding, and it is one number: `minOx` never falls below
0.634.** Oxygen is not consumed anywhere; no cell holds fuel without oxygen.
There is no fuel-rich core, so the thing is not behaving as a diffusion flame —
it is a slow burn through the whole fuel plume. That single fact explains every
previous failure at once. A width knob cannot fix a missing flame structure,
which is why six of them failed in one day.

**A rich core can be forced, and costs more than it gives.** Raising the fuel
load produces a real oxygen-free core and 6.6 mm of hot zone, but the *sooty*
region — the part you can actually see — collapses to the base and loses most
of its mass. Widening it further with mass diffusivity destroys the core it
depends on.

**Two routes reach the target width, both by ruining the picture.**
`expansionGain` 9 gives 6.6–9.0 mm with the widest point finally off the base —
and a flame 76.8 mm tall in a 78 mm box, with no tip. Eddy diffusivity did the
same thing. The handover already records me optimising a width metric and
degrading the render; doing it again in the same session is the reason the
rendered image is now a required check and not a courtesy.

**What shipped is small and honest.** The injection profile falls off as
(1 - d²/r²), so only the middle of the footprint burns — the flame measured
narrower than its own source, 3.0 mm from 6.4 mm. Widening the footprint
(`WICK_CELLS` 5→9) with the fuel density halved to hold the heat release
constant gives soot width 3.6→4.8 mm at mid dial and height 52.8→58.2 mm, at an
unchanged 1459 K, still tapering to a tip. Better, not solved.

`tools/shape.mjs` is new and is the reason this session went differently.
Nothing in the project measured flame *width* — `sweep.mjs` reports height,
flicker and temperature — so nine previous attempts were judged without the
number they were trying to move.

**The teardrop was not achieved and is not close.** The next person should go
after the rich core, not the width.

### 2026-08-30 — one failure per install, and zen that never went dark

**The microphone failed exactly once per install, then worked forever.** The
user spotted the pattern; it is the whole diagnosis. `enableMic` ran
`enableNativeMic()` *before* `ensureHostPermission()`, and `startMic` returns
false when the permission is not held. So the first tap on a fresh install hit
a native path that refused before the user had even been asked, fell through to
the getUserMedia ladder, which asked for permission and then failed the way it
always does on that device. Every later tap reached the native path, because
the permission was by then held — including across restarts, which is why it
looked like a first-run-only curse.

Ordering bug of my own making, introduced when the native path was added: the
permission call was left where it had been, guarding only the fallback. The
permission now precedes both paths.

Worth keeping as a rule: **when a fault is "only the first time", suspect
acquisition order, not the thing that failed.** The diagnostics readout was
honest throughout — it said the permission was granted, because by the time it
was read, it was.

**Zen never returned to black.** `wake()` returned early in zen without arming
the idle timer, so a single tap brought the interface back permanently — which
defeats zen, and with the candle out held the panel at the readable brightness
instead of dropping to 0.03. Zen now arms the timer like everywhere else.

`darkRest()` no longer excludes zen either, so a dark screen takes the same
double tap whatever mode it is in. The user asked for zen to behave exactly as
normal mode does, and an accidental brush should not light the panel because
zen happens to be on. With the candle lit, zen's tap-anywhere behaviour is
untouched.

`tap-check.mjs` is at 34 checks; the zen re-hide check was confirmed to fail
with the fix reverted.

Both confirmed on the device afterwards, the microphone on a genuinely fresh
install with the app uninstalled first — which is the only way to reproduce
that one, since an upgrade keeps the permission and hides the bug.

**Everything reported from the device is now fixed and confirmed. The flame's
shape is the only substantial item left**, and it has been deferred to last
throughout at the user's request. §5 has the nine measured dead ends; read them
before attempting it.

### 2026-08-30 — a focus session that could not be resumed

Four fixes confirmed on the device in one go: the system bars stay hidden, the
microphone permission dialog no longer brings them back, a full 25-minute
session runs correctly, the relight ring is clean, and zen can relight. That
leaves the flame's shape as the only substantial thing outstanding.

One fault left. Leaving the app during a session and returning left the timer
stopped with no way to restart it — literally none: `btn.focus` calls
`endFocus`, which cancels.

`state.focusPaused` was set and cleared **only** by `visibilitychange`, and
Android's WebView is not reliable about firing it. `WebView.onPause` makes no
promise about the page's visibility state, and `MainActivity.onPause` calls
`pauseTimers()` immediately afterwards, which stops JavaScript. The hidden half
of the event arrived; the visible half on return did not. A sticky flag with a
single way out, and the platform owned that way out.

The obvious suspect was wrong and worth recording: `dt` is already clamped to
0.25 s, so a long absence cannot eat the session. The clock was not consumed,
it was frozen.

The fix is one line and deliberately owes the platform nothing: **if frames are
arriving at a normal cadence, the app is being drawn, so it is not away.** A
backgrounded or sleeping app issues no animation frames, so returning gives one
long gap and then ordinary ones — a fact about the clock rather than a platform
courtesy. `visibilitychange` is still handled, because where it works it
responds a frame sooner; it is simply no longer load-bearing.

Generalising, since this is the third fix of the same shape after the system
bars and the microphone: **do not let an Android platform signal be the only
way out of a state.** Each of those three read correctly and did nothing on the
device. Where a state can be derived from something observable — a frame
cadence, a sample actually arriving — derive it, and treat the platform event
as an optimisation.

The user chose auto-resume over tap-to-resume when asked. `tap-check.mjs` is at
30 checks; the new one reproduces the one-sided event rather than approximating
it, and was confirmed to freeze the clock at exactly 1499.3s with the fix
removed.

### 2026-08-30 — a mark with nothing lighting it, and a trap in zen

Both from using the new relight flow on the device.

**The arc inside the ring was the wick.** `drawPoolAndWick` stroked it with a
fixed, deliberately lighter grey whenever the candle was out, so that it stayed
findable in the dark. Every other element in that method multiplies by `lum` —
the wick was the only one that did not, which made it lit pixels with no light
source, and a snuffed candle was left with a small mark floating in an
otherwise black frame. The ring marks the spot properly now, so the wick scales
with the light like everything else and simply goes dark.

The uncomfortable part: `oled.mjs` had been reporting a peak of 31/255 for the
snuffed scene all along, and that number got written down as "the wick's dying
ember" instead of being chased. The fixed grey has a luminance of 33. **The
measurement was right and the explanation was invented to fit it.** The scene
now measures 100.00% off with a peak of 0, and the bounds are set just off that
(99.9%, peak 4) rather than at the loose values that let this through.

**Zen trapped the user with a candle they could not light.** `syncRelight` gated
the ring on `!state.zen`, and the canvas tap handler ignores taps in zen too, so
blowing the candle out in zen left no route back to a lit one at all. The gate
is gone; the `.dim` class already gives the right behaviour, since zen keeps an
empty screen until you tap and the ring then returns with the controls.

`tap-check.mjs` is at 26 checks and covers the zen path; both new checks were
confirmed to fail with their fixes reverted.

### 2026-08-30 — the status bar was never actually hidden

The clock, battery and signal bars were still sitting above the candle. The
activity had been setting `SYSTEM_UI_FLAG_IMMERSIVE_STICKY` and friends since
the beginning, which looked right and did nothing: those constants were
deprecated at API 30 and are ignored on a current device. Nobody noticed
because the code plainly said "hide the system bars".

`WindowInsetsControllerCompat.hide(systemBars())` is the replacement, with
`BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE` so an edge swipe still recovers them
briefly. It has to be re-applied on every focus gain, not set once: a
permission dialog, the notification shade or an incoming call all bring the
bars back. It now runs in `onCreate`, `onResume` and `onWindowFocusChanged`.

Worth remembering as a class of bug rather than a one-off: **a deprecated
Android API does not fail loudly, it just stops working**, and the code keeps
describing an intention it no longer carries out. The app also now draws into
the display cutout, so a notch leaves our own black rather than a letterbox.

For this app it is not cosmetic. Those glyphs are lit pixels on an OLED panel
in a dark room, directly above the flame that is meant to be the only source
of light in the frame - the same reason `oled.mjs` exists.

### 2026-08-30 — the microphone works, and what the dark then needed

Native `AudioRecord` capture worked on the device first try. Four attempts at
this, and the one that landed was the one that stopped guessing at the WebView
and went below it. Worth keeping as the general lesson: **three misses in a row
means the method is wrong, not the guess.**

That immediately exposed the next thing. Blowing the candle out leaves the
screen pitch black, because `syncHostBrightness` takes the panel to 0.03 with
no flame and nothing lifts it again — so the controls become unreadable and the
only way to relight was an invisible ~80×28 px box at the wick, which
`flameHitTest` collapses to when there is no flame to size itself from.

The user's own framing settled the design: *"the screen goes pitch black after
that... I think it is a good thing; but the screen should light up after that
with double tap and the app should provide option to re-ignite candle by
tapping the screen at a specific place."* So the dark stays and is now pinned
by a test rather than left to chance. What changed:

- Two brightness levels while out — 0.03 asleep, 0.35 once woken. Waking eases
  fast (0.5) rather than at the flame's 0.18: there is no flicker to smooth
  with the candle out, and a slow fade made the double tap feel unregistered.
- A single touch no longer wakes a dark screen; a deliberate double tap does.
  The canvas handler needed the same gate as the window listener, or the rule
  would only have applied to the parts of the screen nobody presses.
- A marked ring over the wick, following it down as the candle burns, labelled
  "Tap to light" or "Tap for a fresh candle" when the wax is spent.

Two bugs found by building it, both worth recording because neither is obvious:

1. **A transform makes an element the containing block for `position: fixed`
   descendants.** `#ui` animates one for 900 ms as it fades, which parked the
   ring hundreds of pixels below the screen for the whole fade. The button is
   now a sibling of `#ui` and mirrors its sleep state through a class.
2. **The tap that snuffs the candle reveals the relight ring under the same
   finger**, and the `click` belonging to that tap then landed on it and lit
   the candle straight back up — only for taps below about y=400, which is why
   it read as flaky rather than broken. Fixed with the capture-phase snapshot
   already used for `uiWasHiddenOnPress`; the fix for that bug turned out to
   be the fix for this one too.

Also: putting `syncRelight` in the frame loop wrote `textContent` and forced
layout every frame, which cost enough frame time that `adaptQuality` dropped
the substep count and changed the flame. It runs at the readout's 4 Hz now,
plus directly on the state changes it reflects.

`tap-check.mjs` covers all of it (21 checks), and the new regression check was
confirmed to fail with the fix removed. `oled.mjs` now audits the snuffed scene
too — 99.98% of it off, peak 31/255, which is the wick's ember and should stay.

### 2026-08-30 — microphone: stopped guessing, went under the WebView

The constraint theory was disproved too. The readout came back:

```
error: NotReadableError   attempts: 4      last mode: plain retry
audio inputs: 1           native shell: yes
OS permission: granted    getUserMedia: available    secure context: yes
```

`last mode: plain retry` is the important line. A bare `{ audio: true }` — no
constraints at all — was refused. Together with the earlier readouts that
leaves nothing on the WebView side to fix: permission held, secure origin, a
device enumerated, the app foreground and unpaused (the permission was already
granted, so no dialog and no pause were involved), and no constraint to fail.

Three theories, three misses, all inferred from one DOM error name. The
mistake was the method, not any individual guess: `NotReadableError` is
Chromium's catch-all for "the platform would not start the capture", and it
carries no information about why. No fourth guess at the same layer was going
to be better than the first three.

So the capture moved below it. `MicCapture.kt` opens `AudioRecord` directly —
the primitive Chromium's own capture is built on — which removes the WebView
permission gate, device enumeration, constraint negotiation and the
audio-service IPC in one go. It walks a source ladder (`UNPROCESSED`,
`VOICE_RECOGNITION`, `MIC`, `DEFAULT`), and a source only counts as working
once it has actually yielded a block of samples, because a source can
initialise and start and still hand over nothing.

Two things this buys beyond reliability. `UNPROCESSED` gets a signal with no
noise suppression applied, which is what the raw constraints were asking for
and could not get. And every failure now carries a state, a return code or an
exception per source, so the next readout will name a cause rather than
offering one word to guess from.

Kotlin measures, the web layer decides. `MicCapture` publishes two band
energies (below 450 Hz, above 1200 Hz) via one-pole filters; `AirModel.applyBlow`
turns those into a blow strength. That split matters because the decision is
then testable without a phone, which it now is.

The threshold **adapts** rather than being a constant. Native capture reports a
plain RMS whose scale depends on the phone's microphone sensitivity and on
which source the ladder settled on — neither measurable from here. Guessing a
fixed number would have been the same mistake a fourth time. It tracks the
quiet level instead and asks for a large multiple of it, falling onto a new
quiet level in a tenth of a second and drifting up from one over about twenty
seconds. The asymmetry is load-bearing: a puff must not drag its own reference
up with it (an earlier symmetric version did exactly that, and the test caught
it), while a fan should become the new normal instead of holding the candle out
forever.

The WebView path is kept as the fallback, so a plain browser and the headless
checks are unaffected.

**Untested on the device as of writing.** If `AudioRecord` fails too, the
problem is genuinely outside the app — MIUI's privacy layer is then the
suspect — and the readout will say so in the platform's own words.

### 2026-08-30 — lessons that changed how the work is checked

Three build-level bugs reached CI that careful review had passed: a hardcoded
Chromium path, a Gradle/AGP version skew, and `BuildConfig` being off by
default in AGP 8. Two behavioural bugs reached the user's phone. One test was
flaky because its bound sat inside the distribution it was testing.

The conclusion, and why the tooling looks the way it does: **review is not
verification, and a desktop browser is not a phone.** Anything claimed as
working should name how it was checked.

## 10. Working agreements

- **The user is not technical.** Explain plainly. Technical detail belongs in
  code and commit messages, not in chat. This was corrected mid-project.
- **Report honestly.** Several fixes in this project made things worse and were
  reverted; saying so immediately is why the work stayed on track.
- **Never claim it is bug-free or verified on hardware unless it is.** Multiple
  build-level bugs got past careful review and were only caught by CI; several
  behavioural bugs were only caught by the user on a real phone.
- **Watch conversation cost.** Re-reading the whole history each turn is
  expensive and the cache expires after ~an hour idle. Prefer narrow tool
  queries; avoid dumping large outputs. Start a fresh session with this
  document rather than continuing an enormous one.
