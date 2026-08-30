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
import { AirModel } from './air.js';
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
const btn = {
  mic: document.getElementById('btnMic'),
  focus: document.getElementById('btnFocus'),
  read: document.getElementById('btnRead'),
  sound: document.getElementById('btnSound'),
  zen: document.getElementById('btnZen'),
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

// Dragging anywhere on the dial adjusts it; the angle is taken with atan2 so
// it tracks the finger rather than the raw vertical distance.
let dragging = false;
let dragRef = 0;
let dragBase = 0;

function angleAt(e) {
  const r = dial.getBoundingClientRect();
  const p = e.touches ? e.touches[0] : e;
  return Math.atan2(p.clientY - (r.top + r.height / 2),
                    p.clientX - (r.left + r.width / 2));
}

function onDown(e) {
  dragging = true;
  dragRef = angleAt(e);
  dragBase = state.intensity;
  dial.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}
function onMove(e) {
  if (!dragging) return;
  let d = angleAt(e) - dragRef;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  // Three quarters of a turn spans the full range.
  setIntensity(dragBase + d / (Math.PI * 1.5), true);
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
  if (reason) showToast(reason);
  crackle.setLevel(0, false);
}

function light() {
  if (state.lit) return;
  state.lit = true;
  dial.classList.remove('out');
  air.extinguishFor = 0;
  buzz(12);
  crackle.setLevel(state.intensity, true);
}

function toggleFlame() { state.lit ? extinguish(null) : light(); }

// Tapping the flame itself lights or snuffs it.
canvas.addEventListener('pointerdown', (e) => {
  wake();
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const near = Math.abs(x - r.width / 2) < r.width * 0.28
    && y > r.height * 0.18 && y < r.height * 0.72;
  if (near) toggleFlame();
});

// ---------------------------------------------------------------- UI plumbing
let idleTimer = 0;
function wake() {
  ui.classList.remove('dim');
  clearTimeout(idleTimer);
  if (state.zen) return;
  idleTimer = setTimeout(() => ui.classList.add('dim'), 4200);
}
['pointerdown', 'pointermove', 'keydown'].forEach((ev) =>
  window.addEventListener(ev, wake, { passive: true }));

let toastTimer = 0;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('on'), 3400);
}

function press(el, on) { el.setAttribute('aria-pressed', on ? 'true' : 'false'); }

// Microphone blow-out.
btn.mic.addEventListener('click', async () => {
  if (air.micReady) { air.disableMic(); press(btn.mic, false); showToast('Microphone off'); return; }
  showToast('Allow the microphone, then blow at your phone');
  const ok = await air.enableMic();
  press(btn.mic, ok);
  showToast(ok ? 'Blow at your phone to put it out'
               : `Microphone unavailable (${air.micError})`);
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
  const target = state.lit
    ? Math.max(0.10, Math.min(1, renderer.luminance() * 0.92))
    : 0.03;
  // Ease towards it: matching the flicker frame for frame would make the
  // backlight buzz, because the panel responds far more slowly than the
  // rendered flame does.
  hostBrightness += (target - hostBrightness) * 0.18;
  try {
    host.setBrightness(hostBrightness);
  } catch (e) {
    /* the bridge went away; nothing to do about it */
  }
}
let hostBrightness = 0.5;

let readoutAcc = 0;
function updateReadout(dt) {
  readoutAcc += dt;
  if (readoutAcc < 0.25) return;
  readoutAcc = 0;
  syncHostBrightness();

  if (state.mode === 'focus') {
    if (!state.focusPaused) state.focusLeft = Math.max(0, state.focusLeft - dt * 1000);
    const m = Math.floor(state.focusLeft / 60000);
    const sec = Math.floor((state.focusLeft % 60000) / 1000);
    timerText.textContent = `${m}:${String(sec).padStart(2, '0')}`;
    if (state.focusLeft <= 0) { endFocus('Done.'); buzz([30, 60, 30]); }
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
