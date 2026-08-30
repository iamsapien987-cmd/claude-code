/**
 * Find a Chromium for the headless checks.
 *
 * The development container ships a browser at a fixed path and blocks the
 * download Playwright would otherwise do; CI has no such browser but can
 * install one normally. Resolving it here keeps that difference out of the
 * individual tools.
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const PREINSTALLED = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export function launchChromium(options = {}) {
  const opts = { ...options };
  // Only pin the path when that browser is actually there. Otherwise let
  // Playwright find the one it installed itself.
  if (fs.existsSync(PREINSTALLED)) opts.executablePath = PREINSTALLED;
  return chromium.launch(opts);
}
