/**
 * tests/ds-accent-picker-2026-10-22.test.js
 *
 * Daily Success accent picker (roadmap Horizon 2 item 8): a short curated list of accents laid over the ten skins. Every accent
 * must read on EVERY skin, so this checks the whole accent x skin matrix with real WCAG maths:
 *   - white text on the fill >= 5:1 (buttons)
 *   - the accent as text (the tint chosen for that skin's card) >= 4.5:1 on the card and on the page
 *   - the on-dark tint >= 4.5:1 on the header bar, both tab-bar colours and the always-dark Floor Score panel
 *
 * Run: node tests/ds-accent-picker-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const HTML = stripComments(fs.readFileSync(path.join(DIR, 'index.html'), 'utf8').replace(/\r\n/g, '\n'));
const APP = stripComments(fs.readFileSync(path.join(DIR, 'js', 'app.js'), 'utf8').replace(/\r\n/g, '\n'));
const UI = stripComments(fs.readFileSync(path.join(DIR, 'js', 'accent-ui.js'), 'utf8').replace(/\r\n/g, '\n'));
const A = require(path.join(DIR, 'js', 'accent-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const ratio = (a, b) => { const x = A.lum(a), y = A.lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const readVars = (css) => { const o = {}; css.replace(/(--[a-z-]+)\s*:\s*([^;}]+)/g, (_, k, v) => { o[k] = v.trim(); return ''; }); return o; };

// --- the skins, parsed the same way the theme test does ---
const skins = {};
const defRow = (HTML.match(/\n\[data-theme="default"\]\{([^}]*)\}/) || [])[1] || '';
const baseRow = (HTML.match(/\n\[data-theme="dark"\][^{]*\{([^}]*)\}/) || [])[1] || '';
skins.default = Object.assign({}, readVars(baseRow), readVars(defRow));
for (const m of HTML.matchAll(/\n:root\[data-theme="([a-z-]+)"\]\{([^}]*)\}/g)) skins[m[1]] = readVars(m[2]);

/** Every failing pair for one accent on one skin. Empty array = the accent is safe there. */
function failures(a, k) {
  const out = [];
  const t = A.textFor(a, k['--paper']);
  const chk = (label, x, y, min) => { const r = ratio(x, y); if (r < min) out.push(label + ' ' + r.toFixed(2)); };
  chk('white/fill', '#ffffff', a.fill, 5);
  chk('text/card', t, k['--paper'], 4.5);
  chk('text/page', t, k['--bg'], 4.5);
  ['--bar', '--tabbar', '--taboff'].forEach((v) => chk('on-dark/' + v, a.onDark, k[v], 4.5));
  chk('on-dark/floor panel', a.onDark, '#0a1018', 4.5);
  return out;
}

console.log('\n1. the list');
{
  ok('there are skins to test against (ten)', Object.keys(skins).length === 10, Object.keys(skins).join(','));
  ok('a small curated set, 6 to 10 accents', A.ACCENTS.length >= 6 && A.ACCENTS.length <= 10, String(A.ACCENTS.length));
  ok('every id is unique and every colour is a 6-digit hex', new Set(A.ACCENTS.map((a) => a.id)).size === A.ACCENTS.length && A.ACCENTS.every((a) => ['fill', 'onLight', 'onDark'].every((f) => /^#[0-9a-f]{6}$/i.test(a[f]))));
  const BANNED = /pantone|coca|starbucks|tiffany|facebook|twitter|ups|fedex|home ?depot|lowe|gaf|tamko|iko|nbd|batman|mario|pok[eé]mon/i;
  ok('no trademarked colour names', A.ACCENTS.every((a) => !BANNED.test(a.label) && !BANNED.test(a.id)), A.ACCENTS.map((a) => a.label).join(', '));
  ok('control: the name checker catches one', BANNED.test('Tiffany Blue'));
}

console.log('\n2. the whole accent x skin matrix (real WCAG ratios)');
{
  let pairs = 0, bad = [];
  A.ACCENTS.forEach((a) => Object.keys(skins).forEach((id) => {
    pairs++;
    const f = failures(a, skins[id]);
    if (f.length) bad.push(a.id + ' on ' + id + ': ' + f.join('; '));
  }));
  ok('all ' + pairs + ' pairs pass (accent x skin)', pairs === A.ACCENTS.length * 10 && !bad.length, bad.join(' | '));
  // negative controls: the matrix must be able to fail, for each kind of pair
  const light = skins.light, dark = skins.default;
  ok('control: a pale fill fails the white-text check', failures({ id: 'x', fill: '#F5C242', onLight: '#7A4B00', onDark: '#FFC857' }, dark).some((s) => /^white\/fill/.test(s)));
  ok('control: a dark text tint fails on a dark card', failures({ id: 'x', fill: '#B4461E', onLight: '#9A3A14', onDark: '#3a1000' }, dark).some((s) => /^text\/card/.test(s)));
  ok('control: a light text tint fails on a light card', failures({ id: 'x', fill: '#B4461E', onLight: '#FFB27A', onDark: '#FF9A70' }, light).some((s) => /^text\/card/.test(s)));
  ok('control: a dim on-dark tint fails on the header bar', failures({ id: 'x', fill: '#B4461E', onLight: '#9A3A14', onDark: '#553322' }, dark).some((s) => /^on-dark/.test(s)));
  ok('control: a good accent passes on both a light and a dark skin', !failures(A.ACCENTS[0], light).length && !failures(A.ACCENTS[0], dark).length);
}

console.log('\n3. logic');
{
  const a = A.ACCENTS[0];
  ok('a light card gets the light-surface tint, a dark card the dark-surface tint', A.textFor(a, '#ffffff') === a.onLight && A.textFor(a, '#12161c') === a.onDark);
  ok('a missing or rgba card value takes the dark-surface tint (the safe side)', A.textFor(a, '') === a.onDark && A.textFor(a, 'rgba(255,255,255,.1)') === a.onDark);
  ok('vars() sets --ac to the fill, --ac-text to the surface tint and --ac-on-dark', JSON.stringify(A.vars(a.id, '#ffffff')) === JSON.stringify({ '--ac': a.fill, '--ac-text': a.onLight, '--ac-on-dark': a.onDark }));
  ok('an unknown id or hand-edited storage means "theme default"', A.normAccent('nope') === null && A.normAccent(null) === null && A.normAccent(42) === null && A.vars('nope', '#fff') === null);
  ok('a real id round-trips', A.normAccent('teal') === 'teal');
}

console.log('\n4. wiring');
{
  ok('both scripts load deferred, logic before ui', /accent-logic\.js[^>]*defer/.test(HTML) && /accent-ui\.js[^>]*defer/.test(HTML) && HTML.indexOf('accent-logic.js') < HTML.indexOf('accent-ui.js'));
  ok('the swatch row mounts in the Themes tab', /id="npm-accents"/.test(HTML));
  ok('no inline handlers were added for it', !/<[^>]*acc-(sw|reset)[^>]*\son[a-z]+=/.test(HTML));
  ok('persisted per device, guarded by try/catch', /try\s*\{\s*return localStorage\.getItem\(A\.KEY\)/.test(UI) && /try\s*\{\s*if \(next\) localStorage\.setItem\(A\.KEY, next\)/.test(UI));
  ok('"Theme default" resets (empty pick id removes the key) and restores the theme\'s own --ac', /data-accent-pick=""/.test(UI) && /localStorage\.removeItem\(A\.KEY\)/.test(UI) && /themeAccent\(\)/.test(UI));
  ok('re-applies after every theme change (MutationObserver on data-theme)', /MutationObserver\(apply\)\.observe\(html, \{ attributes: true, attributeFilter: \['data-theme'\] \}\)/.test(UI));
  ok('accent code never assigns document.body.className', !/body\.className\s*=/.test(UI));
  ok('swatch and reset targets are 44px', /:root \.acc-sw\{width:44px;height:44px;/.test(HTML) && /:root \.acc-reset\{min-height:44px;/.test(HTML));
  const lastStyle = HTML.slice(HTML.lastIndexOf('<style'));
  ok('the picker CSS sits in the LAST <style> block, at :root specificity', /:root \.acc-row\{/.test(lastStyle) && /:root \.acc-sw\{/.test(lastStyle));
  ok('control: app.js is untouched by this feature (no accent code there)', !/NBDAccent|nbd_ds_accent/.test(APP));
  // behaviour: drive the real ui file against a stub DOM
  const store = {}; const style = {};
  const html = { style: { setProperty: (k, v) => { style[k] = v; }, removeProperty: (k) => { delete style[k]; } }, };
  const ctx = { window: { NBDAccent: A }, document: { documentElement: html, getElementById: () => null, addEventListener: () => {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    getComputedStyle: () => ({ getPropertyValue: () => '#ffffff' }), MutationObserver: function () { this.observe = () => {}; },
    _nbdGetTheme: () => ({ accent: '#BD5728' }), _nbd_activeTheme: 'default' };
  ctx.window.window = ctx.window;
  vm.runInNewContext(fs.readFileSync(path.join(DIR, 'js', 'accent-ui.js'), 'utf8'), ctx);
  const api = ctx.window.NBDAccent;
  api.set('teal');
  ok('picking an accent stores it and sets the three properties (light card -> light tint)', store.nbd_ds_accent === 'teal' && style['--ac'] === '#0F766E' && style['--ac-text'] === '#0B5F58' && style['--ac-on-dark'] === '#5FD6C8');
  api.set('not-an-accent');
  ok('control: an unknown id behaves as reset, never as a colour', !('nbd_ds_accent' in store) && style['--ac'] === '#BD5728' && !('--ac-text' in style));
  api.set('rose'); api.set('');
  ok('Reset to theme default clears storage and the text overrides, puts the theme accent back', !('nbd_ds_accent' in store) && style['--ac'] === '#BD5728' && !('--ac-text' in style) && !('--ac-on-dark' in style));
  ctx.localStorage.setItem = () => { throw new Error('blocked'); };
  let threw = false; try { api.set('plum'); } catch (_) { threw = true; }
  ok('blocked storage does not throw and still applies for this visit', !threw && style['--ac'] === '#9D2D7E' && api.current() === 'plum');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
