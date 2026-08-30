/**
 * Application shell: the simulation loop, the dial, and the modes.
 *
 * The loop runs the fluid solver on a fixed timestep and the renderer on the
 * display's refresh. Fixed steps matter here - a buoyant plume is a genuine
 * instability, so integrating it with a variable dt makes the flicker rate
 * change whenever the frame rate does.
 */

import { FlameField } from './fluid.js';
import { WaxBody } from './wax.js';
import { AirModel, micDiagnostics } from './air.js';
import { Renderer } from './renderer.js';
import { Crackle } from './audio.js';
import { CANDLE_HEIGHT_0, LUMINOUS_INTENSITY } from './constants.js';

// ---------------------------------------------------------------- simulation
const GRID_NX = 40;
const GRID_NY = 130;
const DOMAIN_W = 0.024;                 // m across the simulated air volume
const SUBSTEP = 1 / 480;                // s, fixed physics step
const MAX_SUBSTEPS = 10;                // guard against spiral-of-death

const field = new FlameField(GRID_NX, GRID_NY, DOMAIN_W / GRID_NX);
const wax = new WaxBody();
const air = new AirModel();
const crackle = new Crackle();

const state = {
  intensity: 0.7,      // the dial, 0..1
  lit: true,
  relight: 0,          // s remaining on the wick ember before it takes
  blowStrength: 0,
  locked: false,       // screen lock: ignores touch, hides everything
  mode: null,          // null | 'focus' | 'reading'
  zen: false,
  sound: false,
  focusLeft: 0,        // ms remaining in the session
  focusPaused: false,
};

// ------------------------------------------------------------------ elements
const canvas = document.getElementById('stage');
const ui = document.getElementById('ui');
const dial = document.getElementById('dial');
const readout = document.getElementById('readout');
const toast = document.getElementById('toast');
const timerBar = document.getElementById('timerBar');
const timerText = document.getElementById('timerText');
const timerNote = document.getElementById('timerNote');
const hint = document.getElementById('hint');
const relightBtn = document.getElementById('relight');
const relightLabel = document.getElementById('relightLabel');
const btn = {
  mic: document.getElementById('btnMic'),
  focus: document.getElementById('btnFocus'),
  read: document.getElementById('btnRead'),
  sound: document.getElementById('btnSound'),
  zen: document.getElementById('btnZen'),
  lock: document.getElementById('btnLock'),
};

const renderer = new Renderer(canvas, field, wax);
window.addEventListener('resize', () => renderer.resize());
window.addEventListener('orientationchange', () => setTimeout(() => renderer.resize(), 120));

// ---------------------------------------------------------------------- dial
let readoutTimer = 0;
function setIntensity(v, haptic = false) {
  const clamped = Math.max(0, Math.min(1, v));
  if (haptic && Math.abs(clamped - state.intensity) > 0.02) buzz(6);
  state.intensity = clamped;
  dial.style.setProperty('--p', clamped.toFixed(3));
  // The arc is a conic gradient starting at the bottom and sweeping 270
  // degrees, so the pointer sits at the same place along that sweep.
  dial.style.setProperty('--angle', `${180 + clamped * 270}deg`);
  dial.setAttribute('aria-valuenow', Math.round(clamped * 100));
  // Show what the simulation is doing while the dial is in hand, then let it
  // go quiet again. A permanent heads-up display of telemetry sitting under a
  // candle undercuts the thing it is measuring.
  readout.classList.add('on');
  clearTimeout(readoutTimer);
  readoutTimer = setTimeout(() => readout.classList.remove('on'), 2600);
}

/** Short vibration, where the platform offers one. */
function buzz(ms) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* blocked */ } }
}

/**
 * The dial responds to a straight up-or-down drag.
 *
 * It used to track the angle of your finger around the ring with atan2, which
 * is the obvious reading of "dial" and is genuinely hard to use: you have to
 * describe an arc around a 92 px circle with a thumb that is covering it. A
 * vertical drag is what rotary controls in audio software have used for
 * decades, for the same reason. The ring stays as the display - now with a
 * pointer on it - and the whole travel is a comfortable thumb's length.
 */
const DIAL_TRAVEL = 170;   // CSS pixels of drag for the full range
let dragging = false;
let dragStartY = 0;
let dragBase = 0;

function pointerY(e) { return (e.touches ? e.touches[0] : e).clientY; }

function onDown(e) {
  if (state.locked) return;
  dragging = true;
  dragStartY = pointerY(e);
  dragBase = state.intensity;
  dial.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}
function onMove(e) {
  if (!dragging) return;
  setIntensity(dragBase + (dragStartY - pointerY(e)) / DIAL_TRAVEL, true);
  wake();
  e.preventDefault();
}
function onUp() { dragging = false; }

dial.addEventListener('pointerdown', onDown);
window.addEventListener('pointermove', onMove, { passive: false });
window.addEventListener('pointerup', onUp);
window.addEventListener('pointercancel', onUp);

dial.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 0.01 : 0.05;
  if (e.key === 'ArrowUp' || e.key === 'ArrowRight') setIntensity(state.intensity + step);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') setIntensity(state.intensity - step);
  else if (e.key === 'Home') setIntensity(0);
  else if (e.key === 'End') setIntensity(1);
  else if (e.key === ' ' || e.key === 'Enter') { toggleFlame(); e.preventDefault(); }
  else return;
  wake();
  e.preventDefault();
});

// ------------------------------------------------------------- light / relight
function extinguish(reason) {
  if (!state.lit) return;
  state.lit = false;
  state.relight = 0;
  dial.classList.add('out');
  buzz([14, 40, 22]);
  // The screen is about to go black on purpose, so say how to get back in.
  if (reason) showToast(`${reason}\nDouble-tap to wake the screen`);
  crackle.setLevel(0, false);
  syncRelight();
}

function light() {
  if (state.lit) return;
  state.lit = true;
  dial.classList.remove('out');
  air.extinguishFor = 0;
  buzz(12);
  crackle.setLevel(state.intensity, true);
  syncRelight();
}

function toggleFlame() {
  if (wax.spent) { freshCandle(); return; }
  state.lit ? extinguish(null) : light();
}

/**
 * Put the relight marker over the wick, and say what tapping it will do.
 *
 * The wick descends as the candle burns, so this is recomputed rather than
 * placed once. Everything else about hiding it is inherited: the button sits
 * a sibling of #ui rather than inside it - see the markup for why - so it
 * mirrors the interface's sleep state through a class instead of inheriting
 * it.
 */
function syncRelight() {
  // Not gated on zen. Zen hiding the ring meant that blowing the candle out in
  // zen left no way to light it again at all: the ring never appeared, and the
  // canvas tap handler ignores taps in zen too. The .dim class below already
  // does the right thing - zen keeps an empty screen until you tap, and the
  // ring then comes back with the rest of the controls.
  const show = !state.lit && !state.locked;
  relightBtn.hidden = !show;
  relightBtn.classList.toggle('dim', ui.classList.contains('dim'));
  // Only write text when it actually changes. Assigning textContent
  // invalidates layout, and the getBoundingClientRect below then forces it
  // again; doing both every frame is the classic thrash, and here it cost
  // enough frame time that adaptQuality dropped the substep count and
  // visibly changed the flame.
  setText(hint, state.lit
    ? 'Slide the dial up or down \u00b7 tap the flame to snuff it'
    : 'Double-tap to wake \u00b7 tap the ring to light');
  if (!show) return;
  setText(relightLabel, wax.spent ? 'Tap for a fresh candle' : 'Tap to light');
  const r = canvas.getBoundingClientRect();
  const d = renderer.dpr || 1;
  relightBtn.style.left = `${r.left + renderer.px(0) / d}px`;
  relightBtn.style.top = `${r.top + renderer.py(wax.wickTop) / d}px`;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

relightBtn.addEventListener('click', () => {
  if (state.locked) return;
  // The press that snuffs the candle also puts this button on screen, right
  // under the finger that did it - and the click belonging to that same tap
  // then lands here and lights it straight back up. Snuffing the flame near
  // its base was doing exactly that. So a click only counts if the button was
  // already showing when the finger went down. Same snapshot as the canvas
  // handler above, for the same reason: reading the state inside the handler
  // is too late.
  //
  // It also means the double tap that wakes a dark screen cannot light the
  // candle by accident, which is right: waking and lighting are two separate
  // decisions.
  if (relightWasHiddenOnPress) return;
  toggleFlame();
  wake();
});

/** Replace a burnt-out candle with a new one. */
function freshCandle() {
  wax.reset();
  field.reset();
  for (let i = 0; i < 600; i++) {
    field.injectFuel(state.intensity, SUBSTEP);
    field.step(SUBSTEP);
  }
  light();
  showToast('A fresh candle');
}

// Tapping the flame itself lights or snuffs it.
//
// Two rules, both learned from getting this wrong. The first version tested a
// fixed band across the middle of the screen, which covered about a third of
// it, so almost any tap put the candle out. And it ran even while the
// controls were hidden, which meant the tap you make to bring them back also
// snuffed the flame. So: while the interface is hidden a tap only wakes it,
// and otherwise the target is the flame itself, wherever it currently is.
// Snapshot taken in the capture phase, before anything else can react to the
// press. Reading the state inside the handler itself is too late: a
// pointermove arrives first on a mouse or stylus, wakes the interface, and
// the tap then looks like it happened on a visible interface.
let uiWasHiddenOnPress = false;
let relightWasHiddenOnPress = true;
window.addEventListener('pointerdown', () => {
  uiWasHiddenOnPress = ui.classList.contains('dim');
  relightWasHiddenOnPress = relightBtn.hidden || relightBtn.classList.contains('dim');
}, { capture: true });

canvas.addEventListener('pointerdown', (e) => {
  if (state.locked) return;
  const wasHidden = uiWasHiddenOnPress;
  // Not wake(): while the candle is out and the screen has gone black, a
  // single touch here must be as inert as one anywhere else, or the double
  // tap would only be required on the parts of the screen nobody presses.
  wakeFromInput();
  if (wasHidden || state.zen) return;
  const r = canvas.getBoundingClientRect();
  if (renderer.flameHitTest(e.clientX - r.left, e.clientY - r.top)) toggleFlame();
});

// ---------------------------------------------------------------- UI plumbing
let idleTimer = 0;
function wake() {
  if (state.locked) return;
  ui.classList.remove('dim');
  clearTimeout(idleTimer);
  if (state.zen) return;
  idleTimer = setTimeout(() => ui.classList.add('dim'), 4200);
  // Coming back from the dark should feel immediate rather than waiting on
  // the quarter-second readout tick.
  syncHostBrightness();
  syncRelight();
}
/**
 * The state a snuffed candle settles into: nothing lit, and the screen has
 * taken itself down to black.
 *
 * Zen is excluded on purpose. Its whole contract is "tap anywhere to bring the
 * controls back", and that should keep working whether or not the candle
 * happens to be alight.
 */
function darkRest() {
  return !state.lit && !state.locked && !state.zen && ui.classList.contains('dim');
}

/**
 * Waking on input, except from the dark.
 *
 * The user asked for the black screen after a snuffed candle to stay - it is
 * the point of the app, not a fault - and asked for a double tap to bring it
 * back. So a single touch must not do it: a hand brushing a phone on a desk
 * would otherwise light the panel, which is exactly what was wanted gone.
 */
function wakeFromInput() {
  if (darkRest()) return;
  wake();
}
['pointerdown', 'pointermove', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, wakeFromInput, { passive: true }));

let toastTimer = 0;
function showToast(msg, ms = 3400) {
  toast.textContent = msg;
  toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('on'), ms);
}

function press(el, on) { el.setAttribute('aria-pressed', on ? 'true' : 'false'); }

// Hold the microphone button to see exactly what went wrong, in a form that
// can be screenshotted and sent to someone who cannot reach the device.
let micHoldTimer = 0;
let micHeld = false;
btn.mic.addEventListener('pointerdown', () => {
  micHeld = false;
  clearTimeout(micHoldTimer);
  micHoldTimer = setTimeout(() => {
    micHeld = true;
    buzz(18);
    showToast(micDiagnostics(air), 9000);
  }, 600);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) =>
  btn.mic.addEventListener(ev, () => clearTimeout(micHoldTimer)));

// Microphone blow-out.
btn.mic.addEventListener('click', async () => {
  if (micHeld) { micHeld = false; return; }
  if (air.micReady) { air.disableMic(); press(btn.mic, false); showToast('Microphone off'); return; }
  showToast('Allow the microphone, then blow at your phone');
  const ok = await air.enableMic();
  press(btn.mic, ok);
  if (ok) { showToast('Blow at your phone to put it out'); return; }
  // Say what to do about it, not just what the API called it.
  const why = {
    'permission refused': 'Microphone permission was declined. Allow it in Settings to blow the candle out.',
    NotAllowedError: 'Microphone permission was declined. Allow it in Settings to blow the candle out.',
    NotReadableError: 'This phone would not open the microphone for the app. Hold this button for details and send them on.',
    'native capture refused': 'The microphone would not open. Hold this button for details and send them on.',
    'native capture threw': 'The microphone would not open. Hold this button for details and send them on.',
    NotFoundError: 'No microphone found on this device.',
  }[air.micError];
  showToast(why || `Microphone unavailable (${air.micError})`);
});

// Focus timer. Leaving the app snuffs the candle, which is the whole point.
const FOCUS_MS = 25 * 60 * 1000;
btn.focus.addEventListener('click', () => {
  if (state.mode === 'focus') { endFocus('Session ended'); return; }
  state.mode = 'focus';
  state.focusLeft = FOCUS_MS;
  state.focusPaused = false;
  press(btn.focus, true);
  timerBar.classList.add('on');
  timerNote.textContent = 'Pauses if you leave';
  light();
  showToast('25 minutes.');
});

function endFocus(msg) {
  state.mode = null;
  state.focusPaused = false;
  press(btn.focus, false);
  timerBar.classList.remove('on');
  if (msg) showToast(msg);
}

/**
 * Leaving the app pauses the session; it does not end it.
 *
 * The obvious design here is to blow the candle out the moment you check a
 * message, and call it a commitment device. It is a bad idea. Punishing
 * someone for a glance at their phone does not build the habit, it just makes
 * the app something you resent and then delete - and it means a phone call
 * costs you the session. The flame drops low while you are away, so coming
 * back to it still tells you plainly that you left, and the clock simply
 * stops rather than throwing away the time you did put in.
 */
document.addEventListener('visibilitychange', () => {
  if (state.mode !== 'focus') return;
  if (document.hidden) {
    state.focusPaused = true;
  } else {
    state.focusPaused = false;
    timerNote.textContent = 'Pauses if you leave';
  }
});

// Reading light: a wide, steady, warm pool rather than a dancing flame.
btn.read.addEventListener('click', () => {
  const on = state.mode !== 'reading';
  state.mode = on ? 'reading' : null;
  document.body.classList.toggle('reading', on);
  press(btn.read, on);
  if (on) {
    setIntensity(0.82);
    light();
    showToast('Reading light: steady and warm');
  }
});

btn.sound.addEventListener('click', () => {
  state.sound = !state.sound;
  press(btn.sound, state.sound);
  if (state.sound) { crackle.start(); crackle.setLevel(state.intensity, state.lit); }
  else crackle.stop();
});

/**
 * Solitude: the interface goes away and leaves the flame.
 *
 * Nothing else. No quotation, no daily reflection, no text at all. Anything
 * written on the screen is something the user has to read, and being asked to
 * read someone else's chosen words is the opposite of what this mode is for.
 */
/**
 * Screen lock.
 *
 * Locks out touch entirely and takes the interface away, so the candle can be
 * left on a desk without a stray brush of the hand changing anything - and so
 * a screenshot has nothing in it but the candle. Double-tap to unlock, which
 * is deliberately a gesture no accidental touch produces.
 */
btn.lock.addEventListener('click', () => {
  state.locked = true;
  press(btn.lock, true);
  document.body.classList.add('locked');
  ui.classList.add('dim');
  showToast('Screen locked. Double-tap to unlock.');
});

/**
 * Double tap: the one gesture that gets you back in.
 *
 * It serves two states, and the lock takes precedence because it is the
 * stronger claim on the screen. Neither is reachable by an accidental touch,
 * which is the reason for the gesture in both cases.
 */
let lastTapAt = 0;
window.addEventListener('pointerdown', () => {
  const unlocking = state.locked;
  if (!unlocking && !darkRest()) { lastTapAt = 0; return; }
  const now = performance.now();
  if (now - lastTapAt >= 400) { lastTapAt = now; return; }
  lastTapAt = 0;
  if (unlocking) {
    state.locked = false;
    press(btn.lock, false);
    document.body.classList.remove('locked');
    wake();
    showToast('Unlocked');
  } else {
    wake();
    buzz(10);
  }
}, { capture: true });

btn.zen.addEventListener('click', () => {
  state.zen = !state.zen;
  press(btn.zen, state.zen);
  if (state.zen) {
    ui.classList.add('dim');
    showToast('Tap anywhere to bring the controls back');
  } else {
    wake();
  }
});

// ----------------------------------------------------------------- main loop
let last = performance.now();
let carry = 0;
let fpsAcc = 0, fpsN = 0, quality = 1;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  // The first callback can carry a timestamp from before the synchronous
  // start-up priming ran, which makes dt negative. Clamp both ends: a
  // negative or absurd dt does not just look wrong, it makes the solver
  // diverge, and a NaN in a field like this never washes out again.
  if (!(dt > 0)) dt = 1 / 60;
  if (dt > 0.25) dt = 0.25;            // returning from a background tab

  air.update(dt);

  // The focus clock is advanced here, every frame, with the full frame time.
  // It used to be decremented inside the quarter-second display update but
  // by that update's *own* dt - a single frame - so it discarded about
  // ninety-four per cent of every interval and ran at roughly a fifteenth of
  // real speed. On a phone that reads as a timer randomly stalling.
  if (state.mode === 'focus' && !state.focusPaused) {
    state.focusLeft = Math.max(0, state.focusLeft - dt * 1000);
    if (state.focusLeft <= 0) { endFocus('Done.'); buzz([30, 60, 30]); }
  }

  // A hard enough puff strains the flame past the point where the chemistry
  // can keep up. Reading mode shields the flame so a cough does not cost you
  // your page.
  state.blowStrength = air.blow;
  if (state.lit && state.mode !== 'reading' && air.shouldExtinguish()) {
    extinguish('Blown out');
  }

  field.windX = air.windX();
  field.windY = air.windY();

  // Fixed-step physics with an accumulator.
  carry += dt;
  const steps = Math.min(MAX_SUBSTEPS * quality, Math.floor(carry / SUBSTEP));
  carry -= steps * SUBSTEP;
  if (carry > 0.1) carry = 0.1;

  const burn = state.lit ? effectiveIntensity() : 0;
  for (let s = 0; s < steps; s++) {
    if (state.lit) field.injectFuel(burn, SUBSTEP);
    field.step(SUBSTEP);
  }

  wax.update(dt, burn, state.lit);

  // Out of wax. The flame dies, and so does everything that belonged to it -
  // including the crackle, which used to carry on over an empty screen
  // because its level was only ever set when the flame was toggled by hand.
  if (wax.spent && state.lit) {
    extinguish(null);
    showToast('The candle has burned out.\nTap the ring for a fresh one.');
  }
  if (state.sound) crackle.setLevel(state.intensity, state.lit && !wax.spent);

  renderer.draw(state);
  updateReadout(dt);
  adaptQuality(dt);
}

/**
 * Reading mode holds the flame steady; otherwise the dial goes straight
 * through to the fuel supply, exactly as a wick length would.
 */
function effectiveIntensity() {
  if (state.mode === 'reading') return 0.86;
  // A paused session guts the flame down to a low ember rather than killing
  // it: enough that coming back tells you plainly that you left.
  if (state.focusPaused) return 0.12;
  return state.intensity;
}

/**
 * Drive the device's actual backlight from the flame.
 *
 * This is the part a web page cannot do for itself, and it is what the whole
 * app is for: the screen is meant to give off the light a candle gives off,
 * not merely to draw a picture of one. The native shell exposes a bridge that
 * sets brightness on its own window, which needs no permission and is
 * restored by Android the moment you leave the app. In a plain browser the
 * bridge is simply absent and nothing happens.
 */
function syncHostBrightness() {
  const host = window.CandleHost;
  if (!host || typeof host.setBrightness !== 'function') return;
  // Deliberately not driving the panel anywhere near full.
  //
  // A candle is about one candela: at arm's length that is a few lux, which
  // is very dim indeed, while a phone at full brightness is hundreds of nits.
  // On an OLED, brightness scales every lit pixel at once, so running the
  // backlight high would make a dark room glow orange and give the whole
  // illusion away - quite apart from the battery. This range reads as a
  // candle in the dark and still has headroom in a lit room.
  //
  // A snuffed candle takes the panel to almost nothing, and stays there. That
  // is the user's own preference and not an oversight: with no flame there is
  // no light to give off, and a phone quietly glowing at a dead candle would
  // give the whole thing away. The cost is that the controls become
  // unreadable, so waking the interface - which now takes a deliberate double
  // tap - lifts the panel to somewhere you can actually see it.
  const target = state.lit
    ? OLED_MIN_BRIGHTNESS + renderer.luminance() * (OLED_MAX_BRIGHTNESS - OLED_MIN_BRIGHTNESS)
    : (ui.classList.contains('dim') ? OUT_ASLEEP_BRIGHTNESS : OUT_AWAKE_BRIGHTNESS);
  // Ease towards it: matching the flicker frame for frame would make the
  // backlight buzz, because the panel responds far more slowly than the
  // rendered flame does. That only applies to a live flame, though - with the
  // candle out there is nothing to smooth, and a slow fade up would make the
  // double tap feel like it had not registered.
  hostBrightness += (target - hostBrightness) * (state.lit ? 0.18 : 0.5);
  try {
    host.setBrightness(hostBrightness);
  } catch (e) {
    /* the bridge went away; nothing to do about it */
  }
}
let hostBrightness = 0.35;
const OLED_MIN_BRIGHTNESS = 0.08;
const OLED_MAX_BRIGHTNESS = 0.70;
/** Candle out, screen asleep: as near off as the platform allows. */
const OUT_ASLEEP_BRIGHTNESS = 0.03;
/** Candle out, screen woken by a double tap: readable, not glaring. */
const OUT_AWAKE_BRIGHTNESS = 0.35;

let readoutAcc = 0;
function updateReadout(dt) {
  readoutAcc += dt;
  if (readoutAcc < 0.25) return;
  readoutAcc = 0;
  syncHostBrightness();
  // Four times a second is ample: the wick descends over minutes.
  syncRelight();

  if (state.mode === 'focus') {
    const m = Math.floor(state.focusLeft / 60000);
    const sec = Math.floor((state.focusLeft % 60000) / 1000);
    timerText.textContent = `${m}:${String(sec).padStart(2, '0')}`;
  }

  if (state.zen || state.mode === 'reading') { readout.textContent = ''; return; }

  // Live physical state, in real units. It is the honest version of a
  // progress bar: these are the numbers the simulation is actually running.
  const cd = (LUMINOUS_INTENSITY * (state.lit ? effectiveIntensity() : 0)).toFixed(2);
  const mm = (wax.centreHeight() * 1000).toFixed(0);
  const hrs = wax.elapsed / 3600;
  readout.innerHTML =
    `<span><b>${cd}</b> cd</span>` +
    `<span><b>${mm}</b> mm</span>` +
    `<span><b>${hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)}</b> h burnt</span>`;
}

/**
 * Drop the physics substep budget on devices that cannot keep up, rather
 * than letting the whole thing judder. The flame simply flickers a little
 * more coarsely.
 */
function adaptQuality(dt) {
  fpsAcc += dt; fpsN++;
  if (fpsN < 90) return;
  const avg = fpsAcc / fpsN;
  fpsAcc = 0; fpsN = 0;
  if (avg > 0.026 && quality > 0.5) quality = 0.5;
  else if (avg > 0.040 && quality > 0.3) quality = 0.3;
  else if (avg < 0.019 && quality < 1) quality = Math.min(1, quality + 0.25);
}

// ------------------------------------------------------------------- startup
setIntensity(0.7);
air.attachTilt();

// Give the flame a moment of simulated time so it opens already burning
// instead of igniting in front of the user.
for (let i = 0; i < 900; i++) {
  field.injectFuel(0.7, SUBSTEP);
  field.step(SUBSTEP);
}

wake();
requestAnimationFrame(frame);

// Exposed for the headless render check in tools/shoot.mjs.
window.__candle = { field, wax, air, state, renderer, setIntensity, extinguish, light };
