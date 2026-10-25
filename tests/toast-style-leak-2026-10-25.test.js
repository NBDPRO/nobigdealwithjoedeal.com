/**
 * tests/toast-style-leak-2026-10-25.test.js — the dashboard's toasts were
 * wearing the achievement banner's clothes.
 *
 *   theme-achievements.js injects a <style> for its "THEME UNLOCKED!" banner
 *   and wrote its inner rules bare: `.toast-content { padding: 20px 32px …}`,
 *   `.toast-icon { font-size: 48px; animation: pulse }`. ui.js's showToast
 *   builds every ordinary toast from the same class names, so each one got a
 *   48px pulsing icon and 32px of padding inside its text column. At 360x640
 *   on the Draw screen that made "Facet 1 closed — 1075 sf" wrap one word per
 *   line into a 160px-tall toast over the magnifier (@shard2, the first run
 *   that ever finished, 2026-10-25).
 *
 *   1. every selector in that injected stylesheet is scoped to the banner
 *      (.achievement-*, or .achievement-unlock-toast descendants)
 *   2. the dashboard's own toast icon stays 20px (dashboard-app.css)
 *
 * Run: node tests/toast-style-leak-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('\n1. the achievement stylesheet is scoped');
{
  const js = read('docs/pro/js/theme-achievements.js');
  const a = js.indexOf("styleEl.textContent = `"), b = js.indexOf('`;', a);
  ok('the injected stylesheet is found', a > 0 && b > a);
  const css = js.slice(a, b).replace(/@keyframes[\s\S]*?\n\s*\}\n\s*\}/g, '').replace(/@media[^{]*\{/g, '');
  const selectors = [...css.matchAll(/^\s*([.#][^{\n]+)\{/gm)].map((m) => m[1].trim());
  ok('selectors are read', selectors.length > 10, String(selectors.length));
  const bare = selectors.filter((s) => !/^\.achievement-/.test(s));
  ok('no selector can reach a toast outside the banner (every one starts with .achievement-)', bare.length === 0, bare.join(' | '));
  ok('the banner keeps its big icon, under its own root', /\.achievement-unlock-toast \.toast-icon \{/.test(js));
}

console.log('\n2. the ordinary toast icon');
{
  const css = read('docs/pro/css/dashboard-app.css');
  const m = /\.toast-icon\{\s*font-size:(\d+)px/.exec(css);
  ok('dashboard-app.css keeps .toast-icon at 20px', !!m && m[1] === '20', m && m[0]);
  ok('ci-manifest lists this file', read('tests/ci-manifest.json').indexOf('toast-style-leak-2026-10-25.test.js') !== -1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('  failed: ' + fails.join('; ')); process.exit(1); }
