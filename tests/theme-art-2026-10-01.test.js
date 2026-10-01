/**
 * tests/theme-art-2026-10-01.test.js — static theme art packs.
 *
 * Most themes were colour swaps on a phone (the canvas overlays skip phones
 * and reduced motion). scripts/build-theme-art.mjs draws an original SVG tile
 * per theme into docs/pro/css/theme-art.css. This keeps it honest:
 *   - the CSS is exactly what the generator produces (no hand edits, no drift)
 *   - every art id is a real registered theme
 *   - tiles are self-contained and inert: no external refs, scripts, images
 *     or links; small
 *   - art stays faint (every alpha ≤ .25) so page text keeps the theme's contrast
 *   - "more contrast" users get no art; both CRM pages load the file
 *
 * Run: node tests/theme-art-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

(async () => {
  const gen = await import(pathToFileURL(path.join(ROOT, 'scripts/build-theme-art.mjs')).href);
  const CSS = read('docs/pro/css/theme-art.css');
  const ENGINE = read('docs/pro/js/theme-engine.js');
  const ids = Object.keys(gen.TILES);

  console.log('\n1. generator ↔ file');
  ok('theme-art.css is exactly the generator output (run node scripts/build-theme-art.mjs)', CSS === gen.buildCss());
  ok('the sci-fi and nature packs are complete', ['matrix','neon','synthwave','vaporwave','deep-space','galaxy','plasma','cyberpunk','hologram','quantum','starship','neon-rain','terminal','forest','ocean','desert','aurora','volcano','glacier','thunderstorm','sunset','canyon','coral-reef','tundra','rainforest','underwater','volcanic'].every((id) => ids.includes(id)));
  ok('no art for themes named after real products (iOS, Android, Windows)', !['ios','ios26','android','windows'].some((id) => ids.includes(id)));
  ok('the construction pack is complete', ['blueprint', 'hard-hat', 'concrete', 'copper-pipe', 'safety-orange', 'crane', 'diesel', 'sawdust', 'brick', 'toolbox'].every((id) => ids.includes(id)));

  console.log('\n2. every art id is a registered theme');
  const themesAt = ENGINE.indexOf('const THEMES = {'), themesEnd = ENGINE.indexOf('\n  };', themesAt);
  const missing = ids.filter((id) => { const i = ENGINE.indexOf(`'${id}': {`); return i < themesAt || i > themesEnd; });
  ok('all ids found inside THEMES', missing.length === 0, JSON.stringify(missing));

  const duo = ['duo-machine-red', 'duo-hyper-cobalt', 'duo-aubergine', 'duo-ghost-green', 'duo-neon-orange'];
  ok("the Duo pack (Jo's palettes) is registered under a real duo category",
    /key: 'duo'/.test(ENGINE) && duo.every((id) => {
      const i = ENGINE.indexOf(`'${id}': {`);
      return i > themesAt && i < themesEnd && /category: 'duo'/.test(ENGINE.slice(i, i + 200));
    }));

  console.log('\n3. tiles are inert, small and faint');
  for (const id of ids) {
    const s = gen.TILES[id].svg;
    const refs = (s.match(/(?:href|src)\s*=|<script|<image|<foreignObject|on[a-z]+\s*=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/gi) || []);
    // Black shading only darkens a DARK theme's page, which raises contrast for
    // its light text, so it's exempt there. Every other ink is capped.
    const at = ENGINE.indexOf(`'${id}': {`);
    const dark = !/mode: 'light'/.test(ENGINE.slice(at, ENGINE.indexOf('specialClass', at)));
    const alphas = [...s.matchAll(/rgba\(([^)]*),\s*(\.?\d*\.?\d+)\)/g)]
      .filter((m) => !(dark && /^0\s*,\s*0\s*,\s*0$/.test(m[1].trim())))
      .map((m) => parseFloat(m[2]));
    const matrix = [...s.matchAll(/values='([^']+)'/g)].map((m) => parseFloat(m[1].trim().split(/\s+/)[18]));
    const worst = Math.max(...alphas, ...matrix.filter((x) => !isNaN(x)), 0);
    ok(`${id}: self-contained (no links, scripts, images or handlers)`, refs.length === 0, JSON.stringify(refs));
    ok(`${id}: under 3KB`, Buffer.byteLength(s) < 3072, Buffer.byteLength(s) + ' bytes');
    ok(`${id}: faint (every alpha ≤ .25, worst ${worst})`, worst > 0 && worst <= 0.25);
  }
  // The alpha check must be able to fail.
  ok('self-test: a loud tile would be caught', Math.max(...[...`fill='rgba(0,0,0,.6)'`.matchAll(/rgba\([^)]*,\s*(\.?\d*\.?\d+)\)/g)].map((m) => parseFloat(m[1]))) > 0.25);

  console.log('\n4. accessibility and wiring');
  const more = (CSS.match(/@media \(prefers-contrast: more\) \{([\s\S]*?)\n\}/) || [])[1] || '';
  ok('prefers-contrast: more removes every tile', ids.every((id) => more.includes(`:root[data-theme="${id}"]`)) && /background-image:\s*none/.test(more));
  ok('no motion anywhere in the art', !/animation|transition|@keyframes|<animate/i.test(CSS));
  for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
    const h = read(page);
    const ts = h.search(/css\/theme-system\.css/), ta = h.indexOf('css/theme-art.css');
    ok(`${page.split('/').pop()} loads theme-art.css after theme-system.css`, ts > 0 && ta > ts);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
