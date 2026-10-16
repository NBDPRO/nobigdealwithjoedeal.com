#!/usr/bin/env node
/**
 * tests/layout-density-usage-2026-10-16.test.js — button size per layout,
 * the picker's order, and the anonymous "layout used today" counter.
 *
 *   A. density: Compact 48 / Comfortable 56 / Big 64 per layout; glove still means Big
 *   B. it is applied on every layout switch and stamped before first paint
 *   C. the picker: Field, Classic, Focus, Mission first; the rest under "More layouts"; size control
 *   D. usage: one count per device, per layout, per day; nothing personal; owner-only read
 *
 * Run: node tests/layout-density-usage-2026-10-16.test.js
 * The Firestore rule has its own emulator suite: tests/firestore-rules.layout-usage.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const U = require(path.join(ROOT, 'docs/pro/js/layout-usage.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

// the registry half of layout-system.js runs without a DOM
function registry() {
  const win = {};
  const ctx = { window: win, console, JSON, Object, Array, String, Number, Math, Promise };
  vm.createContext(ctx);
  try { vm.runInContext(read('docs/pro/js/layout-system.js'), ctx); } catch (_) { /* the engine half needs a document */ }
  return win.LayoutRegistry;
}

console.log('\nA. button size per layout');
{
  const R = registry();
  ok('the registry loaded', R && typeof R.normalizeUser === 'function');
  const u = R.normalizeUser({ density: { field: 'big', mission: 'compact', focus: 'huge', 'Bad Id': 'big', inbox: 'comfortable' } });
  ok('known sizes on valid layout ids are kept; junk is dropped', JSON.stringify(u.density) === JSON.stringify({ field: 'big', mission: 'compact', inbox: 'comfortable' }), JSON.stringify(u.density));
  ok('bounded to 12 entries (the settings doc stays small)', Object.keys(R.normalizeUser({ density: Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['l' + i, 'big'])) }).density).length === 12);
  ok('no choice: Comfortable (the 56px default)', R.densityFor(R.normalizeUser({}), 'field') === 'comfortable');
  ok('glove mode still means Big where nothing else was chosen', R.densityFor(R.normalizeUser({ glove: true }), 'field') === 'big');
  ok('a layout\'s own choice wins over glove', R.densityFor(R.normalizeUser({ glove: true, density: { field: 'compact' } }), 'field') === 'compact');
  ok('an old settings doc (no density) still normalizes', JSON.stringify(R.normalizeUser({ id: 'field', glove: false }).density) === '{}');
  const css = read('docs/pro/css/layout-system.css');
  ok('Compact is 48px (still above the 44px minimum), Big is glove\'s 64px', /:root\[data-tap="compact"\] \{ --tap: 48px; \}/.test(css) && /:root\[data-tap="glove"\] \{ --tap: 64px; \}/.test(css));
}

console.log('\nB. applied on every switch, stamped before paint, saved');
{
  const ls = read('docs/pro/js/layout-system.js');
  ok('apply() sets the size for the layout it is switching to', /root\.setAttribute\('data-layout', def\.id\);\s*\n\s*applyGlove\(def\.id\);/.test(ls));
  ok('big -> data-tap="glove", compact -> data-tap="compact", comfortable -> none', /if \(d === 'big'\) root\.setAttribute\('data-tap', 'glove'\);\s*\n\s*else if \(d === 'compact'\) root\.setAttribute\('data-tap', 'compact'\);\s*\n\s*else root\.removeAttribute\('data-tap'\);/.test(ls));
  ok('saveUser takes { density: { <id>: size | null } } and writes it with the rest', /if \(p\.density && typeof p\.density === 'object'\)/.test(ls) && /density: user\.density \};/.test(ls));
  ok('the preboot cache carries the sizes', /glove: user\.glove === true, density: user\.density \|\| \{\} \}/.test(ls));
  // run the real preboot against a cache
  const attrs = {};
  const de = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, style: { setProperty() {} } };
  const store = { nbd_layout_resolved: JSON.stringify({ uid: 'u', byDevice: { phone: 'field' }, glove: false, density: { field: 'compact' } }) };
  const ctx = { window: { innerWidth: 390, matchMedia: () => ({ matches: true }) }, document: { documentElement: de, readyState: 'complete', write() {} }, localStorage: { getItem: (k) => store[k] || null }, JSON, parseInt };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/shape-preboot.js'), ctx);
  ok('the preboot paints Field at its own size before first paint', attrs['data-layout'] === 'field' && attrs['data-tap'] === 'compact', JSON.stringify(attrs));
  ok('shape-preboot.js and layout-system.js were cache-busted', /shape-preboot\.js\?v=4/.test(read('docs/pro/dashboard.html')) && /layout-system\.js\?v=4/.test(read('docs/pro/dashboard.html')) && /layout-system\.css\?v=2/.test(read('docs/pro/dashboard.html')));
}

console.log('\nC. the picker');
{
  const pk = read('docs/pro/js/layouts/picker.js');
  ok('Field, Classic, Focus, Mission first', /var FIRST = \['field', 'classic', 'focus', 'mission'\];/.test(pk));
  ok('the rest under "More layouts (n)", open when one of them is in use', /<details class="lp-more"' \+ \(openMore \? ' open' : ''\) \+ '><summary>More layouts \(' \+ more\.length \+ '\)<\/summary>/.test(pk) && /more\.some\(function \(d\) \{ return d\.id === eff\.id \|\| d\.id === mineFor\(state\.device\); \}\)/.test(pk));
  ok('a company allow-list still filters both groups', /var all = R\.forSurface\(state\.device\)\.filter\(function \(d\) \{ return companyAllows\(d\.id\); \}\);/.test(pk));
  ok('button size: three labelled radios for the layout this device shows (none for Classic)', /name="lpSize" value="' \+ s\.id \+ '" data-lp-size="/.test(pk) && /eff\.id !== R\.FALLBACK/.test(pk) && /Button size in /.test(pk));
  ok('a size choice saves through saveUser({ density }) and is blocked by a company lock', /E\.saveUser\(\{ density: patch \}\)/.test(pk) && /if \(sz && t\.checked && !lockInfo\(\)\)/.test(pk));
  const css = read('docs/pro/css/layouts/picker.css');
  ok('44px targets for "More layouts" and the size options', /\.lp-more > summary\{[^}]*min-height:44px/.test(css) && /\.lp-size-opt\{[^}]*min-height:44px/.test(css));
  ok('the owner\'s section shows the team usage, honestly when it cannot load', /Used by your team, last 7 days/.test(pk) && /Could not load the usage counts just now\./.test(pk));
}

console.log('\nD. usage: anonymous, once per device per layout per day');
{
  const NOW = Date.parse('2026-10-16T15:00:00');
  const a = U.plan(null, 'field', NOW);
  ok('the first time Field is on screen today it counts', a.count === true && a.next.ymd === '2026-10-16' && a.next.ids.join() === 'field');
  ok('the second time it does not', U.plan(a.next, 'field', NOW).count === false);
  ok('another layout the same day counts once', U.plan(a.next, 'mission', NOW).count === true);
  ok('a new day starts over', U.plan(a.next, 'field', NOW + 86400000).count === true);
  ok('an unknown or junk id never counts', U.plan(null, 'pixel', NOW).count === false && U.plan(null, '<x>', NOW).count === false);
  ok('the last 7 day ids, newest first', U.lastDays(NOW, 7).length === 7 && U.lastDays(NOW, 7)[0] === '2026-10-16' && U.lastDays(NOW, 7)[6] === '2026-10-10');
  ok('days are summed, most used first, known ids only', JSON.stringify(U.sumDays([{ field: 2, classic: 1, evil: 9 }, { field: 1, mission: 3 }, null])) === JSON.stringify([{ id: 'field', n: 3 }, { id: 'mission', n: 3 }, { id: 'classic', n: 1 }]));
  const js = read('docs/pro/js/layout-usage.js');
  ok('the write is one key and +1: no uid, no name, no device id', /data\[cur\.id\] = w\.increment\(1\);/.test(js) && /'layoutUsage', p\.next\.ymd\), data, \{ merge: true \}/.test(js) && !/uid:|displayName|email/.test(js.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('a preview is not "used"; a viewer does not write', /cur\.source === 'preview'/.test(js) && /isViewer\(\)/.test(js));
  ok('a failed write is not remembered (the next visit tries again)', /\.then\(function \(\) \{ remember\(p\.next\); return true; \}, function \(\) \{ return false; \}\)/.test(js));
  const rules = read('firestore.rules');
  ok('the rule: one known layout, +1, a date id, never deleted; only the owner / admin reads', /match \/layoutUsage\/\{day\}/.test(rules) && /changed\.size\(\) == 1/.test(rules) && /after == before \|\| after == before \+ 1/.test(rules) && /allow delete: if false;/.test(rules.slice(rules.indexOf('match /layoutUsage/{day}'), rules.indexOf('match /layoutUsage/{day}') + 900)));
  ok('the rules suite runs in CI', /firestore-rules\.layout-usage\.test\.js/.test(read('.github/workflows/ci.yml')));
  ok('lazy bundle "layoutusage", kicked by today-home.js; kept across sign-out', /layoutusage: \[\s*'js\/layout-usage\.js\?v=\d+'\s*\]/.test(read('docs/pro/js/script-loader.js')) && /loadBundle\('layoutusage'\)/.test(read('docs/pro/js/today-home.js')) && /'nbd_layout_used'/.test(read('docs/pro/js/nbd-auth.js')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
