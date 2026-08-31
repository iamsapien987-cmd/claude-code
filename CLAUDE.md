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

Flame width has fifteen measured dead ends recorded in `docs/HANDOVER.md` §5,
including the full Burke–Schumann flamelet rewrite, temperature-dependent
thermal diffusivity, and enlarging the domain — which §5 used to recommend and
which measurably does nothing. Read that section before attempting it.

`node tools/shape.mjs` is the tool for judging any attempt: it reports width,
where the flame is widest and how it tapers. Two attempts have now reached the
target width by turning the flame into a column that fills the domain, so
**always look at a rendered image before believing a width number**.

## Environment

- **The APK cannot be built here.** `dl.google.com` is blocked by egress
  policy; it serves both the Android SDK and AGP. CI on GitHub builds it on
  every push, and that is the only place the Kotlin gets compiled.
- The container is ephemeral. Commit and push.

## Keeping this current

`docs/HANDOVER.md` exists so a fresh session can start cheaply instead of
re-reading a long conversation. That only holds if it stays true, so **update
it in the same commit as the change it describes** — never as a tidy-up later,
which is how it silently goes stale.

Worth an entry:

- a fix confirmed working, or still failing, **on the device**
- an approach tried and abandoned — goes to the dead ends in §5, with what it
  measured, so nobody repeats it
- a new environment constraint, or surprising platform behaviour
- a change to the working agreements
- a shift in what is being worked on next

Not worth an entry: refactors, comment edits, parameter tuning that does not
change a conclusion. If everything gets logged it stops being the thing worth
reading first.

## Working with this user

Not technical — explain plainly, keep the detail in code and commit messages.
Report failures immediately, including your own reverted attempts. Never claim
hardware verification you do not have: several bugs here reached a real phone
because review is not the same as running it.
