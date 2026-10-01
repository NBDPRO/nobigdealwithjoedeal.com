/**
 * tests/shape-styles-2026-10-01.test.js — the Clay, Liquid Glass, Skeuo and
 * Spatial surface styles in Settings > Appearance > Shape & Depth (Jo,
 * 2026-10-01: "maximize customizability").
 *
 *   1. every preset the picker offers is in the allow-list, and vice versa
 *   2. shape-styles.css: each new preset sets the shape role tokens; every
 *      selector is scoped to one preset; no layout or size properties; colour
 *      only from theme tokens or white/black mixes; no blur on pipeline cards;
 *      motion only inside a reduced-motion guard
 *   3. dashboard.html loads it after dashboard-app.css and bumps prefs-boot
 *
 * Run: node tests/shape-styles-2026-10-01.test.js
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

const NEW = ['clay', 'liquid', 'skeuo', 'spatial'];
const HTML = read('docs/pro/dashboard.html');
const BOOT = read('docs/pro/js/dashboard-ui-prefs-boot.js');
const CSS = read('docs/pro/css/shape-styles.css');
const code = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n1. picker ↔ allow-list');
const list = JSON.parse((BOOT.match(/var NBD_SHAPE_STYLES = (\[[^\]]*\]);/) || [])[1].replace(/'/g, '"'));
const group = HTML.slice(HTML.indexOf('id="shapeStyleBtnGroup"'), HTML.indexOf('</div>', HTML.indexOf('id="shapeStyleBtnGroup"')));
const buttons = [...group.matchAll(/data-shape="([a-z]+)"[^>]*data-arg="([a-z]+)"/g)];
ok('the four new presets are allowed', NEW.every((s) => list.includes(s)), JSON.stringify(list));
ok('every picker button is an allowed preset, with matching data-shape and data-arg',
  buttons.length === list.length && buttons.every(([, a, b]) => a === b && list.includes(a)), buttons.map((b) => b[1]).join(','));
ok('every allowed preset has a button', list.every((s) => buttons.some(([, a]) => a === s)));

console.log('\n2. shape-styles.css');
function selectors(text) {
  const out = [];
  const flat = text.replace(/@media[^{]*\{([\s\S]*?\}\s*)\}/g, '$1');
  flat.replace(/([^{}]+)\{/g, (_, sel) => {
    const s = sel.trim(); if (!s || s.startsWith('@')) return;
    let d = 0, cur = '';
    for (const ch of s) { if (ch === '(') d++; else if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; }
    out.push(cur.trim());
  });
  return out;
}
const sels = selectors(code);
const scoped = (s) => NEW.some((id) => s.startsWith(`:root[data-shape="${id}"]`));
ok('positive control: selectors parsed', sels.length >= 20, sels.length + ' selectors');
ok('self-test: an unscoped selector would be flagged', !scoped('.w-card'));
ok('every selector is scoped to one of the four presets', sels.every(scoped), JSON.stringify(sels.filter((s) => !scoped(s))));
for (const id of NEW) {
  const tok = (code.match(new RegExp(`:root\\[data-shape="${id}"\\]\\s*\\{([^}]*)\\}`)) || [])[1] || '';
  ok(`${id}: sets the shape role tokens (--r-btn/--r-card/--r-input/--r-modal)`, ['--r-btn', '--r-card', '--r-input', '--r-modal'].every((t) => tok.includes(t + ':')));
  ok(`${id}: restyles cards, buttons and fields`, [`:root[data-shape="${id}"] :is(.w-card`, `:root[data-shape="${id}"] :is(.btn, .ui-seg)`, `:root[data-shape="${id}"] :is(.ui-input`].every((s) => code.includes(s)));
}
ok('never layout or size (no width/height/padding/margin/display/font-size/position)',
  !/(^|[;{\s])(width|height|min-height|max-width|padding|margin|display|font-size|position|top|left|right|bottom)\s*:/m.test(code));
const colours = code.match(/#[0-9a-f]{3,8}\b/gi) || [];
ok('literal colours are only white/black mixes (the theme supplies colour)', colours.every((c) => /^#(fff|ffffff|000|000000)$/i.test(c)), JSON.stringify([...new Set(colours)]));
const blurRules = [...code.matchAll(/([^{}]+)\{[^}]*backdrop-filter[^}]*\}/g)].map((m) => m[1]);
ok('backdrop blur is never applied to pipeline cards or list rows', blurRules.length > 0 && blurRules.every((s) => !/\.k-card|\.cl-card|\.ui-row/.test(s)), JSON.stringify(blurRules.map((s) => s.trim().slice(0, 80))));
const motion = code.match(/@media \(prefers-reduced-motion: no-preference\)\s*\{[\s\S]*?\n\}/);
const outsideMotion = motion ? code.replace(motion[0], '') : code;
ok('transform/transition only inside the reduced-motion guard, also gated on [data-motion]',
  !/transition\s*:|transform\s*:/.test(outsideMotion) && (!motion || /:not\(\[data-motion="reduce"\]\)/.test(motion[0])));
ok('no animations or keyframes', !/@keyframes|animation\s*:/.test(code));

console.log('\n3. wiring');
ok('dashboard.html loads shape-styles.css after dashboard-app.css',
  HTML.indexOf('css/shape-styles.css') > HTML.indexOf('css/dashboard-app.css') && HTML.indexOf('css/dashboard-app.css') > 0);
ok('prefs-boot cache busted (≥ v5)', +((HTML.match(/js\/dashboard-ui-prefs-boot\.js\?v=(\d+)/) || [])[1] || 0) >= 5);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
