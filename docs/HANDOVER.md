# Real Candle — project handover

**Read this before doing anything else. It replaces the conversation.**

Maintained alongside the code — updated in the same commit as the change it
describes, so its dates can be trusted. Written so a session that has never
seen the chat history can pick the work up without repeating it. The most valuable part is
[What has already been tried and failed](#what-has-already-been-tried-and-failed) —
those are measured dead ends, not guesses, and re-running them costs hours.

---

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
| Focus timer + candle shrinking | ✅ looking right, full 25-min run still pending |

### Not yet working

- **Microphone blow-out.** `getUserMedia` fails with `NotReadableError` on the
  user's device under conditions that rule out every WebView-side cause. Now
  captured natively with `AudioRecord` instead. Untested on the device;
  see [§7](#7-open-issues).
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
| `src/audio.js` | Synthesised wick crackle (Poisson events, not a loop) |
| `src/app.js` | Loop, dial, modes, lock |
| `android/` | Thin WebView shell — one Kotlin Activity |
| `.github/workflows/android.yml` | Builds the APK; see [§6](#6-environment-constraints) |

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

**Read this before touching flame width.** Nine approaches, all measured.

| Approach | Result |
|---|---|
| Widening the wick source | No effect — the plume necks down regardless |
| Temperature-dependent thermal diffusivity (α ∝ T^1.75) | **Made it worse** — smaller and cooler. Quenches the reaction rather than spreading it. Molecular value beats it. |
| More Jacobi iterations (8 → 60) | No change. Projection was already converged. Keep 8; it's cheap. |
| Rich core + fast sheet chemistry (`burnRate` 480) | Oxygen-depleted core achieved, but flame filled the domain and produced no soot at low intensity |
| **Burke–Schumann flamelet rewrite** | Did not close into a tip; burned as a column filling the domain. Stand-off measured **0.4–0.6×** against the predicted 4×. Reverted. Re-tested later with a realistic wick — same result. Genuinely closed. |
| Eddy diffusivity 1.5e-4 (derived from real candle geometry) | Width numbers improved to 7 mm, **but the render got worse** — flame clipped the domain ceiling with a hard flat cut. Reverted. |
| Raising Abel `refRadius` to widen the flame | **Wrong idea.** It is a brightness normalisation only; it cannot widen anything. |

### What did work

- The `u/r` term in the divergence (was missing; largest near the axis)
- Low-Mach expansion with the sub-grid gain
- Forward Abel projection
- Separating soot *inception* temperature from the temperature at which soot
  *stops glowing* (they are not the same number; conflating them cropped the
  entire cool outer envelope)

### Best current understanding of the remaining gap

Hot zone measures 1.2–3.6 mm against a real candle's 7–10 mm. A real
axisymmetric diffusion flame stands off at ~√(1/Z_st) ≈ 4× the wick radius;
this achieves ~1×. **The domain ceiling is probably the thing to fix first** —
every width improvement so far has been defeated by the flame hitting the top
of the simulated volume.

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

1. **Microphone** — three `getUserMedia` fixes attempted and all three
   disproved by the device's own diagnostics (see the progress log). Capture
   now bypasses the WebView entirely: `MicCapture.kt` opens `AudioRecord`
   directly. Untested on the device. Hold the mic button for the readout;
   `source:` names which audio source opened, and `tried:` lists what each one
   said if none did.
2. **Flame shape** — see §5. Deferred by the user to last.
3. **25-minute timer run** — not yet completed end to end.

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

Still open: the microphone, and the flame's shape.

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
