#!/usr/bin/env node
/**
 * tests/layouts-2467-followups-2026-10-16.test.js — the open follow-ups from
 * the layouts cleanup (#2467):
 *
 *   A. Mission Control remembers its tab, route order and map layers per user
 *   B. Crew remembers Week / Day per user and per screen size
 *   C. Mission's map redraws only the pins that changed
 *   D. the boot preboot never paints another account's cached layout
 *   E. Crew's palette is colour-blind-safe, and every number on a crew colour clears 4.5:1
 *
 * Run: node tests/layouts-2467-followups-2026-10-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

console.log('\nA. Mission remembers its state');
{
  const m = read('docs/pro/js/layouts/mission.js');
  ok('tab, route mode and layers are saved through LayoutEngine.saveUser (layoutState.mission)', /E\.saveUser\(\{ layoutState: \{ mission: \{ tab: S\.tab, mode: S\.route\.mode, layers: layers \} \} \}\)/.test(m));
  ok('saved on a tab, mode or layer change, debounced', /if \(a === 'tab'\) \{ goTab\(.*?\); saveState\(\); return; \}/.test(m) && /S\.route\.mode = [^;]*; render\(\); saveState\(\);/.test(m) && /S\.route\.layers\[lid\] = !S\.route\.layers\[lid\]; render\(\); saveState\(\);/.test(m) && /setTimeout\(function \(\) \{\s*\n\s*saveT = null;/.test(m));
  ok('restored on mount: a saved tab opens through the same tab code (knocks, route kick)', /var savedTab = restoreState\(\);/.test(m) && /if \(savedTab && savedTab !== 'watch'\) goTab\(savedTab\); else render\(\);/.test(m));
  ok('never saved from a preview, a storm switch or a day/night offer (saveUser would flip the screen back)', /\['preview', 'storm', 'auto', 'fallback'\]\.indexOf\(cur\.source\) !== -1\) return;/.test(m));
  ok('a saved value is cleaned: known tab, known mode, boolean layers only', /TABS\.indexOf\(r\.tab\) !== -1 \? r\.tab : 'watch'/.test(m) && /mode: r\.mode === 'short' \? 'short' : 'time'/.test(m) && /typeof r\.layers\[k\] === 'boolean'/.test(m));
  ok('an unmount drops a pending save', /if \(saveT\) \{ clearTimeout\(saveT\); saveT = null; \}/.test(m));
}

console.log('\nB. Crew remembers Week / Day');
{
  const c = read('docs/pro/js/layouts/crew.js');
  ok('per user and per screen size (layoutState.crew = { phone, desktop })', /E\.saveUser\(\{ layoutState: \{ crew: next \} \}\)/.test(c) && /next\[surfaceKey\(\)\] = S\.view;/.test(c));
  ok('mount opens on the saved view, else Day on a phone and Week on a computer', /S\.view = savedView\(\) \|\| \(W\.innerWidth <= 768 \? 'day' : 'week'\);/.test(c));
  ok('saved when the rep switches view; never from a preview / storm / offer', /S\.view = [^;]*; S\.menu = false; render\(\); saveView\(\);/.test(c) && /\['preview', 'storm', 'auto', 'fallback'\]\.indexOf\(cur\.source\) !== -1\) return;/.test(c));
}

console.log('\nC. Mission\'s map redraws only what changed');
{
  const M = require(path.join(ROOT, 'docs/pro/js/layouts/mapview.js'));
  let made = 0;
  const mk = (type) => (...a) => { made++; return { type, a, opts: a[a.length - 1], handlers: {}, on(n, f) { this.handlers[n] = f; return this; }, addTo(g) { if (g && g.bucket) g.bucket.push(this); return this; }, bindTooltip() { return this; }, setIcon(i) { this.icon = i; } }; };
  const groups = [];
  const layer = () => { const g = { bucket: [], addTo() { return g; }, clearLayers() { g.bucket.length = 0; }, removeLayer(m) { const i = g.bucket.indexOf(m); if (i !== -1) g.bucket.splice(i, 1); } }; groups.push(g); return g; };
  const L = {
    map() { return { on() { return this; }, setView() { return this; }, createPane() { return { style: {} }; }, removeLayer() {}, getZoom() { return 11; }, fitBounds() {}, panTo() {}, invalidateSize() {}, remove() {} }; },
    layerGroup: layer, tileLayer: mk('tile'), divIcon(o) { return o; }, marker: mk('marker'), circleMarker: mk('dot'), polygon: mk('polygon'), polyline: mk('polyline'), popup() { return { setLatLng() { return this; }, setContent() { return this; }, openOn() { return this; } }; },
  };
  const el = { classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {} };
  const doc = { createElement: () => ({ className: '', setAttribute() {} }), addEventListener() {}, removeEventListener() {} };
  const inst = M._build({ L, doc, win: { getComputedStyle: () => ({ backgroundColor: 'rgb(10,12,16)' }), addEventListener() {} } }, el, { tiles: 'streets', center: [39.1, -84.5], zoom: 10 });
  const pinG = groups[0];
  const pins = Array.from({ length: 300 }, (_, i) => ({ id: 'L:' + i, lat: 39 + i / 1000, lng: -84.5, kind: 'lead', color: 'blue', title: 'Lead ' + i }));
  made = 0;
  inst.setPins(pins);
  const first = made;
  const kept = pinG.bucket[5];
  made = 0;
  inst.setPins(pins.map((p) => Object.assign({}, p)));
  ok('300 pins drawn once', first === 300 && pinG.bucket.length === 300, first);
  ok('the same 300 pins again: nothing rebuilt', made === 0 && pinG.bucket.length === 300 && pinG.bucket.indexOf(kept) !== -1, made);
  made = 0;
  const changed = pins.slice(0, 299).map((p) => Object.assign({}, p));
  changed[7] = Object.assign({}, changed[7], { color: 'green' });
  inst.setPins(changed);
  ok('one pin changed, one gone: one marker rebuilt, one removed', made === 1 && pinG.bucket.length === 299, made + ' / ' + pinG.bucket.length);
  let hit = null; inst.on('pinclick', (d) => { hit = d; });
  const m7 = pinG.bucket.find((m) => m.opts && m.opts.title === 'Lead 7');
  m7.handlers.click();
  ok('a click reports the pin as drawn now', hit && hit.pin.id === 'L:7' && hit.pin.color === 'green');
  const m8 = pinG.bucket.find((m) => m.opts && m.opts.title === 'Lead 8');
  inst.setPins(changed.map((p, i) => (i === 8 ? Object.assign({}, p, { title: 'Renamed' }) : p)));
  ok('a kept marker never reports stale facts', pinG.bucket.indexOf(m8) === -1);
  ok('select() keeps the record of what is drawn in step', inst.select('L:3') === true && /e\.sig = pinSig\(e\.pin\);/.test(read('docs/pro/js/layouts/mapview.js')));
  made = 0;
  inst.setPins(changed.map((p, i) => (i === 8 ? Object.assign({}, p, { title: 'Renamed' }) : p)));
  ok('…so the next repaint does not rebuild the selected pin (or anything else)', made === 0, made);
}

console.log('\nD. the preboot never paints another account\'s layout');
{
  const run = (store) => {
    const attrs = {};
    const de = { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; }, style: { setProperty() {} } };
    const ctx = { window: { innerWidth: 390, matchMedia: () => ({ matches: true }) }, document: { documentElement: de, readyState: 'complete', write() {} }, localStorage: { getItem: (k) => (k in store ? store[k] : null) }, JSON, parseInt };
    vm.createContext(ctx);
    vm.runInContext(read('docs/pro/js/shape-preboot.js'), ctx);
    return attrs;
  };
  const cache = JSON.stringify({ uid: 'alice', byDevice: { phone: 'field' }, glove: true });
  ok('the signed-in account\'s own cache paints before first paint', run({ nbd_layout_resolved: cache, nbd_signin_uid: 'alice' })['data-layout'] === 'field');
  const other = run({ nbd_layout_resolved: cache, nbd_signin_uid: 'bob' });
  ok('another account\'s cache paints nothing (no layout, no glove)', !('data-layout' in other) && !('data-tap' in other), JSON.stringify(other));
  ok('no sign-in marker yet (an existing session): unchanged behaviour', run({ nbd_layout_resolved: cache })['data-layout'] === 'field');
  const login = read('docs/pro/js/pages/login.js');
  ok('every login redirect goes through goDashboard(), which records the uid first', (login.match(/goDashboard\(\);/g) || []).length === 6 && !/window\.location\.replace\(POST_LOGIN_DEST\);\s*\n\s*\}\s*catch/.test(login.replace(/function goDashboard[\s\S]*?\n\}/, '')) && /localStorage\.setItem\('nbd_signin_uid', auth\.currentUser\.uid\)/.test(login));
  const reg = read('docs/pro/js/pages/register.js');
  ok('sign-up records it too, before every redirect', (reg.match(/markSignedIn\(\); window\.location\.replace\(/g) || []).length === (reg.match(/window\.location\.replace\(/g) || []).length);
  ok('kept across sign-out (a device fact, not account data); login.js and the preboot cache-busted', /'nbd_signin_uid'/.test(read('docs/pro/js/nbd-auth.js')) && /login\.js\?v=4/.test(read('docs/pro/login.html')) && /shape-preboot\.js\?v=5/.test(read('docs/pro/dashboard.html')));
}

console.log('\nE. Crew\'s palette');
{
  const css = read('docs/pro/css/layouts/crew.css');
  const lum = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const okabe = ['#0072b2', '#009e73', '#cc79a7', '#f0e442', '#56b4e9', '#e69f00', '#d55e00'];
  const rows = [...css.matchAll(/\.cw-k([1-7]) \{ --cw-k: (#[0-9a-f]{6}); --cw-k-fg: (#[0-9a-f]{3,6}); \}/g)].map((m) => ({ k: m[1], bg: m[2], fg: m[3].length === 4 ? '#' + m[3][1].repeat(2) + m[3][2].repeat(2) + m[3][3].repeat(2) : m[3] }));
  ok('crews 1-7 use the Okabe-Ito colour-blind-safe set', rows.length === 7 && rows.every((r) => okabe.indexOf(r.bg) !== -1) && new Set(rows.map((r) => r.bg)).size === 7, JSON.stringify(rows));
  ok('each colour carries its own ink, and every pair clears 4.5:1', rows.every((r) => ratio(r.bg, r.fg) >= 4.5), JSON.stringify(rows.map((r) => [r.bg, r.fg, ratio(r.bg, r.fg).toFixed(2)])));
  ok('the first crew stays the brand orange with the accent ink; "No crew" uses theme tokens', /\.cw-k0 \{ --cw-k: var\(--orange\); --cw-k-fg: var\(--accent-fg, #fff\); \}/.test(css) && /\.cw-kn \{ --cw-k: var\(--m\); --cw-k-fg: var\(--bg\); \}/.test(css));
  ok('stop numbers use the crew\'s ink (not always white)', /\.cw-stop-n \{[^}]*color: var\(--cw-k-fg, var\(--accent-fg, #fff\)\);/.test(css));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
