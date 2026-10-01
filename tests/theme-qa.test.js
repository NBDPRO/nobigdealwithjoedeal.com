/**
 * tests/theme-qa.test.js — automated theme legibility + completeness gate.
 *
 * Phase 3 deliverable: a broken or illegible theme must not merge. For EVERY
 * theme in both registries we assert (a) the required color vars are present and
 * (b) text/muted/accent clear the WCAG floor AS RENDERED.
 *
 * For the JS engine registry we don't re-derive the palette by hand — we extract
 * the REAL render function generateCSSVariables (plus its colour helpers) from
 * docs/pro/js/theme-engine.js and DRIVE IT, so the gate tests the shipping math
 * verbatim. Crucially we render each theme in BOTH modes (PR #557 F-2): the
 * theme's native authored palette AND the algorithm-derived opposite-mode
 * palette (deriveLightPalette/deriveDarkPalette), because a user whose mode pref
 * differs from a theme's native mode sees the derived side — ~half of real
 * renders that were previously ungated. We also assert the primary body text
 * token --t against the card surface and page bg, which the old gate never did
 * (it only checked --m / card ink / accent).
 *
 * Themes are enumerated by evaluating the real THEMES object (order-independent),
 * not by a regex that required `category:` to precede `colors:` and silently
 * skipped any theme authored colors-first.
 *
 * Static theme-system.css themes are checked at their authored values (+ the
 * appended --m override block), since engine-less pages render them as-is.
 *
 * Zero deps. Run: node tests/theme-qa.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/theme-engine.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/css/theme-system.css'), 'utf8');

// ── extract the real render pipeline: colour helpers (parseHex … resolvePalette)
//    THROUGH generateCSSVariables, the function the engine actually paints with ──
const sliceStart = ENGINE.indexOf('function parseHex');
const sliceEnd = ENGINE.indexOf('function loadGoogleFont'); // first fn AFTER generateCSSVariables
const helperSrc = ENGINE.slice(sliceStart, sliceEnd);

// ── eval the real THEMES registry (pure data) so we render the SHIPPING objects
//    — including colorsLight/colorsDark overrides and fonts — and enumerate it
//    order-independently instead of via a colors-position-sensitive regex ──
const tStart = ENGINE.indexOf('const THEMES = {');
const tEnd = ENGINE.indexOf('\n  };', tStart) + '\n  };'.length;
const themesSrc = ENGINE.slice(tStart, tEnd);

const sb = { Math, __exp: null, __mode: 'dark' };
vm.runInNewContext(
  helperSrc + '\n' + themesSrc + '\n' +
  // Replace the localStorage/OS-backed mode resolver with one that reads a
  // controllable global, so we can force generateCSSVariables to render in
  // either mode (native + derived) — PR #557 F-2.
  'getResolvedModeFromPref = function(){ return __mode; };\n' +
  'this.__exp = { parseHex, contrastRatio, generateCSSVariables, getNativeMode, THEMES,\n' +
  '  setMode: function(mo){ __mode = mo; } };',
  sb, { filename: 'engine-render.js' }
);
const { parseHex, contrastRatio, generateCSSVariables, getNativeMode, THEMES, setMode } = sb.__exp;

const AA_BODY = 4.5, AA_UI = 3.0;
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, fix) { if (cond) { passed++; } else { failed++; fails.push(name); console.log('  ✗ ' + name + (fix ? '\n      fix: ' + fix : '')); } }

// A failing contrast pair says what to change, not just that it failed
// (the shadcn/lint idea, Repo Lab 2026-10-01): the measured ratio, both
// colours, and the nearest shade of the foreground that clears the bar,
// found by walking it toward white or black, whichever gains contrast.
const hex2 = (n) => Math.round(n).toString(16).padStart(2, '0');
function nearestPassing(fg, bg, min) {
  const f = parseHex(fg);
  if (!f || !parseHex(bg)) return null;
  const towardWhite = contrastRatio('#ffffff', bg) > contrastRatio('#000000', bg);
  const end = towardWhite ? 255 : 0;
  for (let t = 0.01; t <= 1.0001; t += 0.01) {
    const c = '#' + [f.r, f.g, f.b].map((x) => hex2(x + (end - x) * t)).join('');
    if (contrastRatio(c, bg) >= min) return c;
  }
  return null;
}
function contrast(name, fgVar, fg, bgVar, bg, min) {
  const r = contrastRatio(fg, bg);
  const pass = r >= min - 0.01;
  const nudge = pass ? null : nearestPassing(fg, bg, min);
  ok(name, pass, `${r.toFixed(2)}:1 for --${fgVar} ${fg} on --${bgVar} ${bg}, needs ${min}:1` +
    (nudge ? ` — try --${fgVar}: ${nudge}` : ' — no shade of this hue clears it; change --' + bgVar));
}

// sanity: the extracted pipeline works
ok('engine pipeline extracted', [parseHex, contrastRatio, generateCSSVariables, getNativeMode].every(f => typeof f === 'function'));
ok('THEMES registry evaluated', THEMES && typeof THEMES === 'object');
ok('contrast(white,black) ≈ 21', Math.abs(contrastRatio('#fff', '#000') - 21) < 0.2);
// The fix hint is only useful if the shade it suggests really passes.
{
  const s = nearestPassing('#aaaaaa', '#ffffff', AA_BODY);
  ok('fix hint: a too-light grey on white is walked darker until it clears AA',
    !!s && contrastRatio(s, '#ffffff') >= AA_BODY && parseHex(s).r < 0xaa);
  const d = nearestPassing('#444444', '#111111', AA_BODY);
  ok('fix hint: a too-dark grey on near-black is walked lighter until it clears AA',
    !!d && contrastRatio(d, '#111111') >= AA_BODY && parseHex(d).r > 0x44);
}

// pull the `--var: value;` pairs out of a rendered CSS block
function parseVars(css) {
  const out = {};
  css.replace(/--([\w-]+):\s*([^;]+);/g, (_, k, v) => { out[k] = v.trim(); });
  return out;
}

// ── 1. JS engine registry — render EACH theme in BOTH modes, check as painted ──
const REQUIRED = ['bg', 'surface', 'surface2', 'text', 'muted', 'accent'];
const MODES = ['dark', 'light'];
let jsCount = 0;
const totalKeys = Object.keys(THEMES).length;
for (const id of Object.keys(THEMES)) {
  const theme = THEMES[id];
  if (!theme || !theme.colors || !theme.colors.bg) continue;
  jsCount++;
  // required authored vars
  const missing = REQUIRED.filter(k => !theme.colors[k]);
  ok(`[js:${id}] has required color vars`, missing.length === 0);
  if (missing.length) continue;
  const native = getNativeMode(theme);
  for (const mode of MODES) {
    setMode(mode);
    const v = parseVars(generateCSSVariables(theme, id));
    const tag = `${id}/${mode}${mode === native ? ' native' : ' derived'}`;
    // primary body text (--t) — the gap F-2 flagged: must clear AA on the card
    // surface (--s2) AND the page bg (--bg). --t is emitted raw (never tuned),
    // so this is a real tripwire, not a tautology.
    if (parseHex(v.t) && parseHex(v.s2)) contrast(`[${tag}] body text --t AA on card`, 't', v.t, 's2', v.s2, AA_BODY);
    if (parseHex(v.t) && parseHex(v.bg)) contrast(`[${tag}] body text --t AA on bg`, 't', v.t, 'bg', v.bg, AA_BODY);
    // muted (--m) on card surface
    if (parseHex(v.m) && parseHex(v.s2)) contrast(`[${tag}] muted --m AA on card`, 'm', v.m, 's2', v.s2, AA_BODY);
    // accent (--orange) at UI 3:1 on bg
    if (parseHex(v.orange) && parseHex(v.bg)) contrast(`[${tag}] accent --orange UI on bg`, 'orange', v.orange, 'bg', v.bg, AA_UI);
    // accent-fg (label painted ON the --orange fill) MUST be present and clear
    // UI 3:1 — the B-1/P-2 fix: pale/desaturated-light accents must flip the fg
    // to dark ink so the quick-add ADD button / CTA labels never render
    // light-on-light. Engine emits --accent-fg computed from the SAME
    // accentFinal as --orange. Presence is required (not guarded) so dropping
    // the emission trips this, and contrast is checked in both modes.
    ok(`[${tag}] accent-fg present & UI on accent`,
      parseHex(v['accent-fg']) && parseHex(v.orange) && contrastRatio(v['accent-fg'], v.orange) >= AA_UI - 0.01);
    // card ink on card paper
    if (parseHex(v.ink) && parseHex(v.paper)) contrast(`[${tag}] card ink AA on paper`, 'ink', v.ink, 'paper', v.paper, AA_BODY);
  }
}
// Tight, eval-based count — every registered key with a colors block was
// rendered, and the registry still carries its full 186-theme complement.
ok(`every registered theme rendered (${jsCount}/${totalKeys})`, jsCount === totalKeys);
ok(`JS registry still >= 186 themes (got ${jsCount})`, jsCount >= 186);

// ── 2. static theme-system.css themes — authored values (+ overrides merged) ──
const cssRe = /:root\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g;
const cssThemes = {}; let cm;
while ((cm = cssRe.exec(CSS))) {
  const v = {}; cm[2].replace(/--([\w-]+)\s*:\s*([^;]+);/g, (_, k, val) => { v[k] = val.trim(); });
  cssThemes[cm[1]] = Object.assign(cssThemes[cm[1]] || {}, v); // merge override blocks
}
const CSS_REQUIRED = ['bg', 's', 's2', 's3', 't', 'm', 'orange'];
let cssCount = 0;
for (const id of Object.keys(cssThemes)) {
  const v = cssThemes[id];
  if (!v.bg && !v.t) continue; // skip accent-only override blocks
  cssCount++;
  const missing = CSS_REQUIRED.filter(k => !v[k]);
  ok(`[css:${id}] has required vars`, missing.length === 0);
  if (missing.length) continue;
  // only check resolvable hex values (some use var() refs e.g. --paper:var(--s3))
  if (parseHex(v.t) && parseHex(v.s2)) contrast(`[css:${id}] body text AA on card`, 't', v.t, 's2', v.s2, AA_BODY);
  if (parseHex(v.t) && parseHex(v.bg)) contrast(`[css:${id}] body text AA on bg`, 't', v.t, 'bg', v.bg, AA_BODY);
  if (parseHex(v.m) && parseHex(v.s2)) contrast(`[css:${id}] muted AA on card`, 'm', v.m, 's2', v.s2, AA_BODY);
}
ok('parsed the static CSS registry (>=60 themes)', cssCount >= 60);

console.log('\n──────────────────────────────────────────────────');
console.log(`THEME QA — ${jsCount} engine themes × ${MODES.length} modes + ${cssCount} static themes`);
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
