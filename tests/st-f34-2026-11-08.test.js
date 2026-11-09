/**
 * tests/st-f34-2026-11-08.test.js — the Settings > Appearance font picker
 * works from the keyboard and tells a screen reader which font is on (CRM
 * audit ST-F34, 2026-11-08).
 *
 * nbdRenderFontGrid() (dashboard-ui-prefs-boot.js) drew each of the 28 fonts
 * as a <div data-action="call"> with no role and no tabindex: Tab skipped the
 * whole grid and Enter/Space did nothing, and the chosen font was marked only
 * by colour and a ✓. Each card is now a <button type="button"> (so Tab reaches
 * it and Enter/Space fire the same delegated data-action click) with
 * aria-pressed naming the saved font, and holds phrasing content only.
 *
 * Runs the real nbdRenderFontGrid and _NBD_LEGACY_FONTS lifted from the file
 * against a fake grid and localStorage.
 * Zero deps. Run: node tests/st-f34-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const SRC = read('docs/pro/js/dashboard-ui-prefs-boot.js');
function slice(src, start, endMarker) {
  const i = src.indexOf(start); if (i < 0) return '';
  const j = src.indexOf(endMarker, i); return j < 0 ? '' : src.slice(i, j + endMarker.length);
}
const FONTS = slice(SRC, 'var _NBD_LEGACY_FONTS = [', '\n];\n');
const RENDER = slice(SRC, 'function nbdRenderFontGrid() {', '\n}\n');
ok('control: the font list and the renderer are found', FONTS.length > 1000 && /settings-font-grid/.test(RENDER), FONTS.length + ' / ' + RENDER.length);

function render(store) {
  const grid = { innerHTML: '' };
  const ctx = {
    document: { getElementById: (id) => (id === 'settings-font-grid' ? grid : null) },
    localStorage: { getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null) },
  };
  vm.createContext(ctx);
  vm.runInContext(FONTS + '\n' + RENDER + '\nnbdRenderFontGrid();', ctx);
  return grid.innerHTML;
}
// Each card's opening tag, and its whole markup up to the next card or heading.
// The 28 font ids, read from the shipped list itself.
const IDS = new Set(Array.from(FONTS.matchAll(/\{ id: '([^']+)'/g), (m) => m[1]));
const cards = (html) => html.split(/(?=<\w+ [^>]*class="nbd-font-card")/).slice(1).map((c) => c.split('<div class="nbd-font-cat-head"')[0]);
const openTag = (c) => c.slice(0, c.indexOf('>') + 1);
const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"')); return m ? m[1] : null; };

console.log('\nST-F34: every font card is a real button');
{
  const html = render({ nbd_font: 'inter' });
  const cs = cards(html);
  ok('28 font cards are drawn, one per font (control)', cs.length === 28 && IDS.size === 28, cs.length + ' / ' + IDS.size);
  const notBtn = cs.filter((c) => !/^<button type="button" class="nbd-font-card"/.test(c));
  ok('every card is a <button type="button"> (Tab reaches it; Enter/Space click it)', notBtn.length === 0, notBtn.length + ': ' + (notBtn[0] || '').slice(0, 60));
  const badDispatch = cs.filter((c) => { const t = openTag(c); return attr(t, 'data-action') !== 'call' || attr(t, 'data-fn') !== 'nbdApplyLegacyFont' || !IDS.has(attr(t, 'data-arg')); });
  ok('every card still dispatches data-action="call" → nbdApplyLegacyFont(its id)', badDispatch.length === 0, badDispatch.length);
  ok('each font has exactly one card', new Set(cs.map((c) => attr(openTag(c), 'data-arg'))).size === 28);
  ok('each card\'s own text is its font name (the button\'s accessible name)', cs.every((c) => /<\/span>[^<]+<\/button>$/.test(c.trim())), cs[0].slice(-60));
  ok('every card closes as a button and holds no <div> (phrasing content only)', cs.every((c) => /<\/button>$/.test(c.trim()) && !/<div\b/.test(c)), cs.find((c) => /<div\b/.test(c) || !/<\/button>$/.test(c.trim())));
  ok('button tags balance', (html.match(/<button\b/g) || []).length === (html.match(/<\/button>/g) || []).length);
  const pressed = cs.filter((c) => attr(openTag(c), 'aria-pressed') === 'true');
  ok('exactly one card is aria-pressed="true": the saved font', pressed.length === 1 && attr(openTag(pressed[0]), 'data-arg') === 'inter', pressed.map((c) => attr(openTag(c), 'data-arg')).join(','));
  ok('every other card is aria-pressed="false"', cs.filter((c) => attr(openTag(c), 'aria-pressed') === 'false').length === 27);
  const inter = cs.find((c) => attr(openTag(c), 'data-arg') === 'inter') || '';
  ok('control: the saved card still shows the ✓ and the orange border', /Inter ✓/.test(inter) && /border:2px solid var\(--orange\)/.test(openTag(inter)), inter.slice(0, 120));
  ok('control: the category headings still draw (Sans-serif / Serif / Monospace; Display has no fonts)', (html.match(/class="nbd-font-cat-head"/g) || []).length === 3, (html.match(/class="nbd-font-cat-head"/g) || []).length);
  ok('control: each card still previews its own font', cs.every((c) => /font-family:'[^']+',[^;]*;[^"]*">Aa</.test(c)), cs[0].slice(0, 200));
}

console.log('\nST-F34: the pressed state follows the saved choice');
{
  const none = cards(render({}));
  const p0 = none.filter((c) => attr(openTag(c), 'aria-pressed') === 'true').map((c) => attr(openTag(c), 'data-arg'));
  ok('nothing saved: Barlow (the default) is the pressed card', p0.length === 1 && p0[0] === 'barlow', p0.join(','));
  const retired = cards(render({ 'nbd-font': 'modern' }));
  const p1 = retired.filter((c) => attr(openTag(c), 'aria-pressed') === 'true');
  ok('a retired maps.js pairing is worn: no card claims pressed', p1.length === 0 && retired.length === 28, p1.length);
}

console.log('\nWIRING');
ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"st-f34-2026-11-08.test.js"') >= 0);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
