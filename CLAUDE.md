# Real Candle

**Read `docs/HANDOVER.md` first.** It carries the full project context, what
has already been tried, and what not to repeat. This file is only the short
version.

An Android app: a candle that behaves like a real one. The flame is
**simulated, not animated** — a buoyant reacting-flow solver, Planck's law for
colour, real measured burn rates for the wax. No keyframes, no image assets.
That is the point of the project; do not replace it with drawn shapes.

## Before changing anything

```bash
node --test "test/*.test.mjs"   # 16 physics invariants
node tools/build.mjs            # -> dist/candle.html, self-contained
node tools/verify-bundle.mjs    # the built file, in a real browser
node tools/tap-check.mjs        # taps, dial, lock — real touchscreen
I=1.0 node tools/oled.mjs       # fails if the panel lights where it must not
```

## Four things that look like bugs and are not

1. **`expansionGain = 4`**, not the exact 1. Sub-grid correction for an
   unresolved flame sheet. It is the one parameter controlling flame width.
2. **The room draft in `air.js` is load-bearing.** The solver is exactly
   symmetric, so without it the flame is perfectly steady. Remove it and the
   flame goes dead. Tests pin this.
3. **`timeScale = 6`**, not real time. Real burn is unwatchably slow; 90 burned
   the candle out in eight minutes.
4. **Soot inception temperature ≠ the temperature soot stops glowing.**
   Conflating them crops the flame's whole cool outer envelope.

## Do not retry these

Flame width has nine measured dead ends recorded in `docs/HANDOVER.md` §5,
including the full Burke–Schumann flamelet rewrite and temperature-dependent
thermal diffusivity, which made it actively worse. Read that section before
attempting it. The user has deferred flame shape to last.

## Environment

- **The APK cannot be built here.** `dl.google.com` is blocked by egress
  policy; it serves both the Android SDK and AGP. CI on GitHub builds it on
  every push, and that is the only place the Kotlin gets compiled.
- The container is ephemeral. Commit and push.

## Working with this user

Not technical — explain plainly, keep the detail in code and commit messages.
Report failures immediately, including your own reverted attempts. Never claim
hardware verification you do not have: several bugs here reached a real phone
because review is not the same as running it.
