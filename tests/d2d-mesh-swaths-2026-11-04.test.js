/**
 * tests/d2d-mesh-swaths-2026-11-04.test.js
 *
 * Radar hail swaths (NOAA MRMS MESH, hail_mesh/{ymd}) on the door-knocking
 * map: docs/pro/js/d2d-storm-layer.js draws them with the Storms layer,
 * UNDER the report dots, and never claims "no radar hail" (a failed read and
 * an empty week look the same). The real file runs in a vm against a fake
 * Leaflet that records what was added, in order.
 *
 * Run: node tests/d2d-mesh-swaths-2026-11-04.test.js
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
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── fake Leaflet + map ───────────────────────────────────────────────────
function makeEnv(opts) {
  const o = opts || {};
  const added = []; // ['mesh'|'dots', group]
  const L = {
    layerGroup: (items) => ({ items, addTo(m) { m._layers.push(this); added.push(this); return this; } }),
    polygon: (rings, style) => ({ kind: 'polygon', rings, style, bindPopup(t) { this.popup = t; return this; } }),
    circleMarker: (ll, style) => ({ kind: 'dot', ll, style, bindPopup(t) { this.popup = t; return this; } }),
    Control: { extend: (def) => function () { this.addTo = (m) => { this._c = def.onAdd(); return this; }; this.getContainer = () => this._c; } },
    DomUtil: { create: () => ({ innerHTML: '' }) },
    DomEvent: { disableClickPropagation() {} },
  };
  const map = {
    _layers: [],
    removeLayer(l) { this._layers = this._layers.filter((x) => x !== l); },
    on() {}, off() {}, removeControl() {},
    getCenter: () => ({ lat: 39.1, lng: -84.5 }),
  };
  const meshDocs = o.meshDocs || [];
  let meshCalls = 0;
  const win = {
    L,
    NBDStormTime: { validMs: (v) => Date.parse(v), dateTextEt: () => 'Jun 26' },
    fetch: async () => ({ ok: true, json: async () => ({ events: o.events || [] }) }),
    showToast() {},
    location: { search: '' },
    NBDHailMeshSwaths: o.noModule ? undefined : {
      load: (args) => { meshCalls++; win._meshArgs = args; return o.meshGate ? o.meshGate.then(() => meshDocs) : Promise.resolve(meshDocs); },
      allSwaths: (docs) => require(path.join(ROOT, 'docs/pro/js/hail-mesh-swaths.js')).allSwaths(docs),
    },
    ScriptLoader: o.scriptLoader,
  };
  win.window = win;
  const ctx = vm.createContext({ window: win, document: { readyState: 'complete', addEventListener() {} }, console, Math, JSON, Date, Number, String, Array, Object, Promise, setTimeout, fetch: win.fetch });
  vm.runInContext(read('docs/pro/js/d2d-storm-layer.js'), ctx);
  return { win, map, added, D: win.NBDD2DStorms, meshCalls: () => meshCalls };
}

const BANDS = JSON.stringify([
  { minIn: 1, polygons: [{ outer: [[39.1, -84.6], [39.1, -84.5], [39.0, -84.5]], holes: [] }] },
  { minIn: 2, polygons: [{ outer: [[39.08, -84.58], [39.08, -84.55], [39.05, -84.55]], holes: [] }] },
]);
const DOCS = [{ ymd: '2026-06-26', bandsJson: BANDS }];
const EVENTS = [{ type: 'hail', magnitude: 1.25, lat: 39.07, lon: -84.56, date: new Date(Date.now() - 86400000).toISOString(), city: 'Florence' }];

(async () => {
  console.log('\npure helpers');
  const { D } = makeEnv();
  ok('meshStyle: 1.75"+ is red, the rest gold', D.meshStyle('red').fillColor === '#d64545' && D.meshStyle('gold').fillColor === '#d9a21b' && D.meshStyle('???').fillColor === '#d9a21b');
  ok('legend line is EMPTY with no swaths (never "no radar hail")', D.meshLegendHtml([]) === '' && D.meshLegendHtml(null) === '');
  const leg = D.meshLegendHtml([{ level: 'gold' }, { level: 'red' }, { level: 'red' }]);
  ok('legend counts swaths and the 1.75"+ ones', /last 7 days: 3/.test(leg) && /\(2 at 1\.75"\+\)/.test(leg), leg);
  ok('legend says it is a radar estimate, not a measurement', /Radar estimate \(NOAA MRMS\)/.test(leg) && /not a measured size/.test(leg));

  console.log('\nshow(): swaths under the dots');
  const e = makeEnv({ meshDocs: DOCS, events: EVENTS });
  e.D.show(e.map);
  await tick(); await tick(); await tick();
  const meshGroup = e.map._layers.find((g) => g.items.length && g.items[0].kind === 'polygon');
  const dotGroup = e.map._layers.find((g) => g.items.length && g.items[0].kind === 'dot');
  ok('two swaths drawn as polygons', meshGroup && meshGroup.items.length === 2, meshGroup && String(meshGroup.items.length));
  ok('the report dot is drawn too', dotGroup && dotGroup.items.length === 1);
  ok('swaths are added BEFORE the dots (dots stay clickable on top)', e.map._layers.indexOf(meshGroup) < e.map._layers.indexOf(dotGroup));
  ok('rings passed straight through as [outer, ...holes]', meshGroup && Array.isArray(meshGroup.items[0].rings[0][0]));
  ok('2" band drawn red, 1" gold', meshGroup && meshGroup.items.some((p) => p.style.fillColor === '#d64545') && meshGroup.items.some((p) => p.style.fillColor === '#d9a21b'));
  ok('popup carries the estimate wording', meshGroup && /Radar estimate \(NOAA MRMS\)/.test(meshGroup.items[0].popup));
  ok('asks for the last 7 days, keyed by today (UTC)', e.win._meshArgs && e.win._meshArgs.days === 7 && e.win._meshArgs.today === new Date().toISOString().slice(0, 10));
  ok('redraws keep ONE swath group (no stacking on every draw)', e.map._layers.filter((g) => g.items.length && g.items[0].kind === 'polygon').length === 1);

  console.log('\nhide()');
  e.D.hide(e.map);
  ok('hide removes the swaths with the dots', e.map._layers.length === 0, String(e.map._layers.length));

  console.log('\nhide while the swath read is still in flight');
  let open;
  const gate = new Promise((r) => { open = r; });
  const h = makeEnv({ meshDocs: DOCS, meshGate: gate });
  h.D.show(h.map);
  await tick();
  h.D.hide(h.map);
  open();
  await tick(); await tick(); await tick();
  ok('a late answer after hide draws nothing', !h.map._layers.some((g) => g.items.length && g.items[0].kind === 'polygon'));

  console.log('\nmodule missing / read empty');
  const none = makeEnv({ meshDocs: [], events: EVENTS });
  none.D.show(none.map);
  await tick(); await tick();
  ok('no docs: no swath group and no swath legend line', !none.map._layers.some((g) => g.items.length && g.items[0].kind === 'polygon'));
  let loaded = 0;
  const lazy = makeEnv({ noModule: true, events: EVENTS, scriptLoader: { load: (src) => { loaded++; lazy.lastSrc = src; return Promise.resolve(); } } });
  lazy.D.show(lazy.map);
  await tick(); await tick();
  ok('module not on the page: lazy-loads it once, from its own path', loaded === 1 && lazy.lastSrc === '/pro/js/hail-mesh-swaths.js?v=1');
  lazy.D.loadMesh();
  await tick();
  ok('and never retries in a loop when it still is not there', loaded === 1);
  ok('the dots still draw without the swath module', lazy.map._layers.some((g) => g.items.length && g.items[0].kind === 'dot'));

  console.log('\nwiring');
  const dash = read('docs/pro/dashboard.html');
  ok('dashboard loads the bumped d2d-storm-layer.js (?v=3) and css (?v=2)', dash.indexOf('js/d2d-storm-layer.js?v=3') > 0 && dash.indexOf('css/d2d-storm.css?v=2') > 0);
  ok('the legend swatch has a style', /\.d2d-dot\.is-mesh\s*\{/.test(read('docs/pro/css/d2d-storm.css')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
