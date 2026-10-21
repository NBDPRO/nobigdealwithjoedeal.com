/**
 * tests/daily-success-themes-2026-10-21.test.js
 *
 * Daily Success shipped ~100 themes, many named after trademarked characters and franchises (Batman, Mario,
 * Darth Vader...), each with legacy cream-card colours that were never contrast-checked, plus a "Copy Firestore
 * Write" developer button in the picker. Jo (2026-10-21): keep ~10-12 brand-safe themes, remove the dev button.
 * Now there are TEN skins, each one token row, and this test checks every one of them with real WCAG maths.
 *
 * Run: node tests/daily-success-themes-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
// Pins read the source with comments removed: a commented-out line must not satisfy a pin (vacuous-test audit, 2026-10-21).
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const HTML = stripComments(fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').replace(/\r\n/g, '\n'));
const APP = stripComments(fs.readFileSync(path.join(DIR, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
function parse(hex) {
  if (/^rgba/.test(hex)) return null;
  const h = hex.replace('#', ''); const f = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}
function lum(hex) { return parse(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0); }
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const readVars = (css) => { const o = {}; css.replace(/(--[a-z-]+)\s*:\s*([^;}]+)/g, (_, k, v) => { o[k] = v.trim(); return ''; }); return o; };

// --- the registry in app.js, evaluated as written ---
const reg = (APP.match(/const NBD_THEMES = (\[[\s\S]*?\n\]);/) || [])[1] || '[]';
const THEMES = vm.runInNewContext(reg);
// --- the skins in the page: the default token row + one :root[data-theme] row per other skin ---
const skins = {};
const defRow = (HTML.match(/\n\[data-theme="default"\]\{([^}]*)\}/) || [])[1] || '';
// the default skin's tab bar / gold come from the shared base block it also matches; its own row overrides
const baseRow = (HTML.match(/\n\[data-theme="dark"\][^{]*\{([^}]*)\}/) || [])[1] || '';
skins.default = Object.assign({}, readVars(baseRow), readVars(defRow));
for (const m of HTML.matchAll(/\n:root\[data-theme="([a-z-]+)"\]\{([^}]*)\}/g)) skins[m[1]] = readVars(m[2]);

console.log('\n1. ten brand-safe themes');
{
  ok('the registry has exactly ten themes', THEMES.length === 10, String(THEMES.length));
  ok('every registry id has a skin row in the page and vice versa', JSON.stringify(THEMES.map((t) => t.id).sort()) === JSON.stringify(Object.keys(skins).sort()), JSON.stringify(Object.keys(skins).sort()));
  const BANNED = /batman|superman|captain|wolverine|magneto|darth|vader|stormtrooper|lightsaber|halo|mario|kirby|zelda|mega ?man|digimon|pok[eé]mon|lego|american dad|family guy|south park|fbi|cia|ios|android|windows/i;
  ok('no trademarked / third-party names in the picker', THEMES.every((t) => !BANNED.test(t.name) && !BANNED.test(t.id)), THEMES.map((t) => t.name).join(', '));
  ok('control: the checker really does catch one', BANNED.test('Darth Vader') && BANNED.test('Mario Underground'));
  ok('the default theme is NBD Default and is first', THEMES[0].id === 'default' && THEMES[0].name === 'NBD Default');
  ok('there are light, dark and high-contrast options', ['light', 'dark', 'contrast'].every((c) => THEMES.some((t) => t.cat === c)));
  ok('no legacy theme blocks are left in the page (176 of them used to be)', !/:root\[data-theme="(batman|mario|matrix|neon|galaxy|obsidian|sakura|cobalt|volcanic|halloween)"/.test(HTML) && (HTML.match(/\n:root\[data-theme="/g) || []).length === 9);
  ok('the developer "Copy Firestore Write" button and its handler are gone', !/Copy Firestore Write/.test(HTML) && !/nbdCopyFS|nbd-copy-fs/.test(APP) && !/nbd-copy-fs/.test(HTML));
  ok('the page starts on the default theme (no flash of another theme)', /<html lang="en" data-theme="default">/.test(HTML));
  ok('a saved theme that no longer exists falls back to default at boot', /_nbdGetTheme\(saved\) \|\| _nbdGetTheme\('default'\)/.test(APP));
  ok('the category chips match the new groups', /const cats = \['all','dark','light','contrast','custom'\];/.test(APP));
}

console.log('\n2. every skin is readable (real WCAG ratios)');
{
  const REQUIRED = ['--ac', '--ac-text', '--on-dark', '--ac-on-dark', '--bg', '--bar', '--paper', '--ink', '--rule', '--muted', '--ghost', '--input-bg', '--ph', '--footer', '--mbg', '--stxt', '--sbg'];
  Object.keys(skins).forEach((id) => {
    const k = skins[id];
    const miss = REQUIRED.filter((v) => !k[v]);
    ok(id + ': defines every token', !miss.length, miss.join(', '));
    if (miss.length) return;
    const R = (a, b) => ratio(a, b);
    const fails = [];
    if (R(k['--ink'], k['--paper']) < 7) fails.push('ink/paper ' + R(k['--ink'], k['--paper']).toFixed(1));
    if (R(k['--muted'], k['--paper']) < 4.5) fails.push('muted/paper ' + R(k['--muted'], k['--paper']).toFixed(1));
    if (R(k['--ac-text'], k['--paper']) < 4.5) fails.push('ac-text/paper ' + R(k['--ac-text'], k['--paper']).toFixed(1));
    if (R('#ffffff', k['--ac']) < 4.5) fails.push('white/accent-fill ' + R('#ffffff', k['--ac']).toFixed(1));
    if (R(k['--ghost'], k['--paper']) < 4.5) fails.push('ghost/paper ' + R(k['--ghost'], k['--paper']).toFixed(1));
    if (R(k['--ph'], k['--input-bg']) < 4.5) fails.push('placeholder/input ' + R(k['--ph'], k['--input-bg']).toFixed(1));
    if (R(k['--ink'], k['--input-bg']) < 7) fails.push('ink/input ' + R(k['--ink'], k['--input-bg']).toFixed(1));
    if (R(k['--on-dark'], k['--bar']) < 4.5) fails.push('header text/bar ' + R(k['--on-dark'], k['--bar']).toFixed(1));
    if (R(k['--ac-on-dark'], k['--bar']) < 4.5) fails.push('header orange/bar ' + R(k['--ac-on-dark'], k['--bar']).toFixed(1));
    if (R(k['--footer'], k['--bg']) < 4.5) fails.push('footer/page ' + R(k['--footer'], k['--bg']).toFixed(1));
    // text that sits straight on the page, on the tab bar, and on the always-dark Floor Score panel (#0a1018)
    if (R(k['--ac-text'], k['--bg']) < 4.5) fails.push('ac-text/page (the NOT EARNED banner) ' + R(k['--ac-text'], k['--bg']).toFixed(1));
    if (R(k['--ac-on-dark'], k['--tabbar']) < 4.5) fails.push('inactive tab/tab bar ' + R(k['--ac-on-dark'], k['--tabbar']).toFixed(1));
    if (R(k['--ac-on-dark'], k['--taboff']) < 4.5) fails.push('inactive tab/tab off ' + R(k['--ac-on-dark'], k['--taboff']).toFixed(1));
    if (R(k['--gold-on-dark'] || k['--gold'], '#0a1018') < 4.5) fails.push('score gold/Floor panel ' + R(k['--gold-on-dark'] || k['--gold'], '#0a1018').toFixed(1));
    if (R(k['--ac-on-dark'], '#0a1018') < 4.5) fails.push('score orange/Floor panel ' + R(k['--ac-on-dark'], '#0a1018').toFixed(1));
    ok(id + ': text, muted, orange text, button fill, ghost, input, header and footer all >= AA', !fails.length, fails.join('; '));
  });
  ok('the NOT EARNED banner uses the readable text orange (it was a fixed gold, 2.8:1 on the light skins)', /\.floor-egg\.not-earned\{background:transparent;border:2px dashed var\(--ac-text,#d97706\);\}/.test(HTML) && /\.floor-egg\.not-earned \.floor-egg-title\{color:var\(--ac-text,#d97706\);\}/.test(HTML));
  ok('the Floor Score numbers use the on-dark colours (their panel is dark in every skin)', /const scoreColor=allMet\?'#4caf82':pct>=67\?'var\(--gold-on-dark,var\(--gold\)\)':'var\(--ac-on-dark,var\(--ac\)\)';/.test(APP));
  ok('control: the old fixed gold on the light page is NOT readable', ratio('#d97706', '#eef1f5') < 3);
  ok('control: the light skin\'s old on-dark orange was below AA on its tab bar (so the tab check is not vacuous)', ratio('#E4783F', '#1A3057') < 4.5);
  ok('control: the old cream-era muted (#8a9ab0) on a white card is NOT readable (what these ratios guard against)', ratio('#8a9ab0', '#ffffff') < 4.5);
  ok('control: the checker is not vacuous - a bad row would be caught', ratio('#777777', '#808080') < 4.5);
}

console.log('\n3. picker entries agree with the skins');
{
  THEMES.forEach((t) => {
    const k = skins[t.id] || {};
    ok(t.id + ': picker swatches match the skin (accent, page, bar)', t.accent.toLowerCase() === (k['--ac'] || '').toLowerCase() && t.bg.toLowerCase() === (k['--bg'] || '').toLowerCase() && t.s.toLowerCase() === (k['--bar'] || '').toLowerCase(), JSON.stringify([t.accent, k['--ac'], t.bg, k['--bg'], t.s, k['--bar']]));
  });
}

console.log('\n9. sweep fixes: tab-close x and the week-strip letters follow the theme');
{
  ok('the tab-close x takes the muted token (it was a fixed #445, 1.9:1 on the dark card)', /:root \.tx\{color:var\(--muted,#8793a4\);\}/.test(HTML));
  ok('control: no fixed colour is left on the base .tx rule', !/(^|\n)\.tx\{[^}]*color:#445/.test(HTML) || /:root \.tx\{color:var\(--muted/.test(HTML));
  const strip = (APP.match(/const days=\['M','T','W','T','F','S','S'\];[\s\S]{0,1800}/) || [''])[0];
  ok('the week-strip letters use theme tokens (today: --ac-text, others: --muted)', /color:\$\{isToday\?'var\(--ac-text\)':'var\(--muted\)'\}/.test(strip));
  ok('control: the strip block was found and no longer hard-codes #8fa1b8 for its letters', strip.length > 200 && !/color:\$\{isToday\?'var\(--ac\)':'#8fa1b8'\}/.test(strip));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
