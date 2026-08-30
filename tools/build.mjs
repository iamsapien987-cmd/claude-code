/**
 * Bundle the app into one self-contained HTML file.
 *
 * No dependencies, no build chain, no module server: `dist/candle.html` opens
 * from a file:// URL, which is what makes it work when emailed to a phone or
 * dropped into an Android assets folder. ES modules will not load over
 * file://, so they are concatenated in dependency order into one classic
 * script and the export/import lines are stripped.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

// Dependency order. Concatenation only works if a module's dependencies are
// already defined above it, and this list is short enough to keep by hand.
const MODULES = [
  'constants.js',
  'blackbody.js',
  'abel.js',
  'flamecolor.js',
  'fluid.js',
  'wax.js',
  'air.js',
  'audio.js',
  'renderer.js',
  'app.js',
];

/** Strip ES module syntax, leaving plain top-level declarations. */
function flatten(source, name) {
  return source
    // Whole import statements, single or multi line.
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')
    .replace(/^import\s+['"][^'"]+['"];\s*$/gm, '')
    // `export class X` / `export function x` / `export const x` -> bare decl.
    .replace(/^export\s+(default\s+)?(?=(class|function|const|let|var)\b)/gm, '')
    // Re-export lists have no meaning once everything shares a scope.
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .trim();
}

const parts = MODULES.map((m) => {
  const src = fs.readFileSync(path.join(ROOT, 'src', m), 'utf8');
  return `// ${'='.repeat(66)}\n// ${m}\n// ${'='.repeat(66)}\n\n${flatten(src, m)}`;
});

const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

html = html
  .replace('<link rel="stylesheet" href="src/styles.css">', `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="src/app.js"></script>',
    `<script>\n"use strict";\n${parts.join('\n\n')}\n</script>`);

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'candle.html');
fs.writeFileSync(outFile, html);

// Also drop it straight into the Android assets folder, so the APK never
// ships a stale copy.
const assets = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets');
if (fs.existsSync(assets)) {
  fs.writeFileSync(path.join(assets, 'candle.html'), html);
}

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`dist/candle.html  ${kb} kB, self-contained, no network needed`);
