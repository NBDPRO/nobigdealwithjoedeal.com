/**
 * tests/theme-daylight-2026-10-01.test.js — the Daylight and Jobsite skins.
 *
 * Jo liked all three mockups (Live Ops, Daylight, Jobsite), 2026-10-01.
 *   Daylight: near-black ink on white for full sun, light-native, 2px edges.
 *   Jobsite:  slate + copper + a static diagonal hatch, dark-native.
 *
 * For each: the token line clears WCAG AA (text and muted on every surface,
 * accent at UI 3:1, the label on the accent fill at 4.5:1); the engine entry
 * mirrors the token line; the scoped block touches only its own theme, in its
 * native mode, and never animates. theme-qa.test.js separately renders both
 * engine modes of every registered theme.
 *
 * Run: node tests/theme-daylight-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const ENGINE = read('docs/pro/js/theme-engine.js');
const { parseHex, contrastRatio } = (() => {
  const start = ENGINE.indexOf('function parseHex');
  const crStart = ENGINE.indexOf('function contrastRatio', start);
  const end = ENGINE.indexOf('\n  }', crStart) + 4;
  const sb = { Math, __exp: null };
  vm.runInNewContext(ENGINE.slice(start, end) + '\nthis.__exp = { parseHex, contrastRatio };', sb);
  return sb.__exp;
})();
const CSS = read('docs/pro/css/theme-system.css');
const CATS = vm.runInNewContext('(' + ENGINE.slice(ENGINE.indexOf('[', ENGINE.indexOf('const CATEGORIES')), ENGINE.indexOf('];', ENGINE.indexOf('const CATEGORIES')) + 1) + ')');

function entryOf(id) {
  const at = ENGINE.indexOf(`'${id}': {`);
  if (at === -1) return null;
  let depth = 0, i = ENGINE.indexOf('{', at); const from = i;
  for (; i < ENGINE.length; i++) { if (ENGINE[i] === '{') depth++; else if (ENGINE[i] === '}' && --depth === 0) break; }
  const inThemes = at > ENGINE.indexOf('const THEMES = {') && at < ENGINE.indexOf('\n  };', ENGINE.indexOf('const THEMES = {'));
  return inThemes ? vm.runInNewContext('(' + ENGINE.slice(from, i + 1) + ')') : null;
}
function selectorsOf(cssText) {
  const out = [];
  cssText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/([^{}]+)\{/g, (_, sel) => {
    const s = sel.trim(); if (!s || s.startsWith('@')) return;
    s.split(',').forEach((x) => out.push(x.trim()));
  });
  return out;
}

const SKINS = [
  { id: 'daylight', name: 'Daylight', mode: 'light', header: '/* ══ Daylight sun treatment', notMode: 'dark',
    expectSel: ['.w-card', '.ui-panel', '.ui-seg.is-on', ':focus-visible'] },
  { id: 'jobsite', name: 'Jobsite', mode: 'dark', header: '/* ══ Jobsite treatment', notMode: 'light',
    expectSel: ['.w-card', '.ui-card', '.w-card-title', 'header'] },
];

for (const S of SKINS) {
  console.log(`\n${S.name}: token line`);
  const m = CSS.match(new RegExp(`:root\\[data-theme="${S.id}"\\]\\s*\\{([^}]*)\\}`));
  const tok = {};
  if (m) m[1].replace(/--([\w-]+)\s*:\s*([^;]+);/g, (_, k, v) => { tok[k] = v.trim(); });
  ok('token line exists with every core token', !!m && ['bg', 's', 's2', 's3', 't', 'm', 'orange', 'br', 'green', 'red', 'gold'].every((k) => tok[k]), JSON.stringify(tok));
  for (const fg of ['t', 'm']) for (const bg of ['bg', 's', 's2', 's3']) {
    const r = contrastRatio(tok[fg], tok[bg]);
    ok(`--${fg} on --${bg} clears AA (${r.toFixed(2)}:1)`, r >= 4.5);
  }
  for (const c of ['green', 'red', 'gold', 'blue']) {
    const r = contrastRatio(tok[c], tok.s2);
    ok(`--${c} reads as text on cards (${r.toFixed(2)}:1)`, r >= 4.5);
  }
  const ui = contrastRatio(tok.orange, tok.bg);
  ok(`accent at UI 3:1 on the page (${ui.toFixed(2)}:1)`, ui >= 3);
  const fgDecl = (S.mode === 'light')
    ? new RegExp(`:root\\[data-theme="${S.id}"\\],\\n:root\\[data-theme="presentation"\\]\\{\\n  --accent-fg:(#[0-9a-f]{3,6})`, 'i')
    : new RegExp(`:root\\[data-theme="${S.id}"\\]\\s*\\{\\s*--accent-fg:\\s*(#[0-9a-f]{6})`, 'i');
  const fg = (CSS.match(fgDecl) || [])[1];
  ok('--accent-fg is declared for the theme', !!fg);
  if (fg) { const r = contrastRatio(fg, tok.orange); ok(`label on the accent fill clears AA (${r.toFixed(2)}:1)`, r >= 4.5); }

  console.log(`\n${S.name}: engine entry`);
  const e = entryOf(S.id);
  ok('entry found inside THEMES', !!e);
  ok(`name "${S.name}", unlocked, real category, ${S.mode}-native`, !!e && e.name === S.name && e.locked === false && e.unlockCondition === null
    && CATS.some((c) => c.key === e.category) && e.mode === S.mode);
  ok('no wallpaper overlay (static skin)', !!e && e.overlay && e.overlay.type === 'none');
  const C = (e && e.colors) || {};
  const pairs = [['outerBg', 'bg'], ['bg', 's'], ['surface', 's2'], ['surface2', 's3'], ['text', 't'], ['muted', 'm'], ['accent', 'orange'], ['green', 'green'], ['red', 'red'], ['gold', 'gold'], ['blue', 'blue']];
  const mismatch = pairs.filter(([a, b]) => String(C[a]).toLowerCase() !== String(tok[b]).toLowerCase());
  ok('engine colours mirror the token line', mismatch.length === 0, JSON.stringify(mismatch));

  console.log(`\n${S.name}: scoped treatment`);
  const at = CSS.indexOf(S.header);
  const end = at === -1 ? -1 : CSS.indexOf('/* ══', at + 5);
  const block = at === -1 ? '' : CSS.slice(at, end === -1 ? CSS.length : end);
  const sels = selectorsOf(block);
  const SCOPE = `:root[data-theme="${S.id}"]:not([data-mode="${S.notMode}"])`;
  ok('block present', at !== -1);
  ok('positive control: the parser sees the expected selectors', S.expectSel.every((c) => sels.some((s) => s.endsWith(' ' + c))), sels.length + ' selectors');
  ok('self-test: an unscoped selector would be flagged', selectorsOf('.w-card{color:red}').some((s) => !s.startsWith(SCOPE)));
  ok(`every selector starts with ${SCOPE}`, sels.length > 0 && sels.every((s) => s.startsWith(SCOPE)), JSON.stringify(sels.filter((s) => !s.startsWith(SCOPE))));
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '');
  // A scoped ".ui-seg { color }" outranks the base ".ui-seg.is-on" rule, so the
  // block must restate the label colour for the active state (caught on screen).
  const segColor = /\.ui-seg\s*\{[^}]*\bcolor\s*:/.test(code);
  ok('if the block recolours .ui-seg, it restates the .is-on label as --accent-fg',
    !segColor || /\.ui-seg\.is-on\s*\{[^}]*\bcolor\s*:\s*var\(--accent-fg\)/.test(code));
  ok('no animation, keyframes or transitions', !/@keyframes|animation\s*:|transition\s*:/.test(code));
  ok('never changes layout or size (no width/height/padding/margin/font-size/display)', !/(^|[;{\s])(width|height|padding|margin|font-size|display)\s*:/m.test(code));
  const outside = CSS.slice(0, at === -1 ? CSS.length : at).split('\n').filter((l) => new RegExp(`data-theme="${S.id}"`).test(l));
  ok('outside its block the theme appears only on its token + accent lines', outside.length === 2, JSON.stringify(outside.map((l) => l.slice(0, 60))));
}

console.log('\nShipping');
ok('engine bundle version bumped (theme-engine.js ≥ v5)', +((read('docs/pro/js/script-loader.js').match(/'js\/theme-engine\.js\?v=(\d+)'/) || [])[1] || 0) >= 5);
ok('dashboard.html busts the theme-system.css cache (≥ v9)', +((read('docs/pro/dashboard.html').match(/css\/theme-system\.css\?v=(\d+)"/) || [])[1] || 0) >= 9);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
