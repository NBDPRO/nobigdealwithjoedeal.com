/**
 * tests/daily-success-picker-fit-2026-10-22.test.js
 *
 * Appearance picker, found by the all-theme sweep (documentation/qa/daily-success-theme-sweep-2026-10-22.md):
 * the "NBD Light" / "Warm Paper" labels were 1.2:1 (label colour chosen from the page bg, painted on the dark surface),
 * the tab strip / "Active:" line / subtitle were #5a6478 (3.2:1), the selected tab and category chip were 2.8-3.1:1, and
 * the chips, search box, Guide / Random / close were 24-32 px tall; the four tabs ran 4 px past the panel at 360 px.
 *
 * Run: node tests/daily-success-picker-fit-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const read = (p) => stripComments(fs.readFileSync(path.join(DIR, p), 'utf8').replace(/\r\n/g, '\n'));
const HTML = read('index.html'), APP = read('js/app.js'), ACC = read('js/accent-logic.js');
const LAST_STYLE = HTML.split('<style').pop();

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const parse = (hex) => { const h = hex.replace('#', ''); const f = h.length === 3 ? h.replace(/./g, (c) => c + c) : h; return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)); };
const lum = (hex) => parse(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const readVars = (css) => { const o = {}; css.replace(/(--[a-z-]+)\s*:\s*([^;}]+)/g, (_, k, v) => { o[k] = v.trim(); return ''; }); return o; };

const THEMES = vm.runInNewContext((APP.match(/const NBD_THEMES = (\[[\s\S]*?\n\]);/) || [])[1] || '[]');
const PANEL = ((HTML.match(/#nbd-picker-inner\s*\{[^}]*?background:\s*(#[0-9a-fA-F]{6})/) || [])[1]) || '';
const skins = {};
const baseRow = (HTML.match(/\n\[data-theme="dark"\][^{]*\{([^}]*)\}/) || [])[1] || '';
skins.default = Object.assign({}, readVars(baseRow), readVars((HTML.match(/\n\[data-theme="default"\]\{([^}]*)\}/) || [])[1] || ''));
for (const m of HTML.matchAll(/\n:root\[data-theme="([a-z-]+)"\]\{([^}]*)\}/g)) skins[m[1]] = readVars(m[2]);
const FILLS = [...ACC.matchAll(/fill: '(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1]);

console.log('\n1. the maths');
{
  ok('the picker panel colour is read from source', /^#/.test(PANEL), PANEL);
  ok('ten themes and eight accent fills are read', THEMES.length === 10 && FILLS.length === 8, THEMES.length + '/' + FILLS.length);
  ok('control: the old #5a6478 tab ink on the panel is the reported 3.2:1', ratio('#5a6478', PANEL) < 4.5);
  ok('control: black on at least one theme accent is under 4.5:1 (the selected chip)', THEMES.some((t) => ratio('#000000', t.accent) < 4.5));
  ok('the new tab ink #9aa6b8 clears 4.5:1 on the panel', ratio('#9aa6b8', PANEL) >= 4.5, ratio('#9aa6b8', PANEL).toFixed(2));
  Object.keys(skins).forEach((id) => {
    const t = skins[id]['--ac-on-dark'] || '#E4783F';
    ok(id + ': --ac-on-dark (selected tab, Active: name) on the panel >= 4.5:1', ratio(t, PANEL) >= 4.5, ratio(t, PANEL).toFixed(2));
  });
  THEMES.forEach((t) => ok(t.id + ': white on its accent (selected category chip) >= 4.5:1', ratio('#ffffff', t.accent) >= 4.5, ratio('#ffffff', t.accent).toFixed(2)));
  FILLS.forEach((f) => ok('accent fill ' + f + ': white on it (selected category chip) >= 4.5:1', ratio('#ffffff', f) >= 4.5, ratio('#ffffff', f).toFixed(2)));
}

console.log('\n2. bubble labels are read against the colour they are painted on');
{
  // app.js picks the label ink from a luminance; the bubble is painted with t.s, so t.s must drive it
  ok('the label ink follows the bubble surface (t.s), not the page bg', /const textCol = hexLum\(t\.s\|\|'#13171d'\) > 0\.12 \? '#1a1208' : '#e8eaf0';/.test(APP) && !/hexLum\(t\.bg/.test(APP));
  const label = (t) => (lum(t.s || '#13171d') > 0.12 ? '#1a1208' : '#e8eaf0');
  THEMES.forEach((t) => ok(t.id + ': label ink vs its bubble surface >= 4.5:1', ratio(label(t), t.s || '#13171d') >= 4.5, ratio(label(t), t.s || '#13171d').toFixed(2)));
  const old = (t) => (lum(t.bg || '#000') > 0.12 ? '#1a1208' : '#e8eaf0');
  ok('control: the old rule fails on NBD Light and Warm Paper', ['light', 'paper'].every((id) => { const t = THEMES.find((x) => x.id === id); return ratio(old(t), t.s) < 2; }));
}

console.log('\n3. the rules, in the last <style> block');
{
  const rule = (re, label) => ok(label, re.test(LAST_STYLE));
  rule(/#nbd-picker-inner \.npm-tab,#nbd-picker-inner \.npm-active-lbl,#nbd-picker-inner \.npm-subtitle\{color:#9aa6b8;\}/, 'tab strip, Active: line and subtitle use #9aa6b8');
  rule(/#nbd-picker-inner \.npm-tab\.on,#nbd-picker-inner \.npm-active-lbl strong\{color:var\(--ac-on-dark,#E4783F\);\}/, 'the selected tab and active name use the on-dark accent');
  rule(/#nbd-picker-inner \.npm-cat\.on\{color:#fff;\}/, 'the selected category chip is white');
  rule(/@media \(max-width:768px\)\{\s*#nbd-picker-inner \.npm-cat,#nbd-picker-inner \.npm-rnd,#nbd-picker-inner \.npm-copy-btn,#nbd-picker-inner \.npm-search\{min-height:44px;\}/, 'chips, Random, Guide and search are 44 px on a phone');
  rule(/#nbd-picker-inner \.npm-close\{min-width:44px;min-height:44px;\}/, 'the close button is 44 x 44 on a phone');
  rule(/#nbd-picker-inner \.npm-tab\{min-height:44px;padding-inline:9px;letter-spacing:\.06em;\}/, 'tabs are 44 px tall and tight enough that all four fit at 360 px');
  ok('control: a rule only in an earlier <style> block would not count', !/#nbd-picker-inner \.npm-cat\.on\{color:#fff;\}/.test(HTML.split('<style').slice(0, -1).join('<style')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
