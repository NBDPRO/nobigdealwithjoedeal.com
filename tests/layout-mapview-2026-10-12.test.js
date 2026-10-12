/**
 * tests/layout-mapview-2026-10-12.test.js - M1: the shared MapView component
 * (js/layouts/mapview.js + css/layouts/mapview.css).
 *
 *   1. theme luminance: dark / light decided from the --bg colour; unknown or
 *      transparent reads dark (the CRM default); every colour syntax parses
 *   2. point-in-polygon + hail level (the danger colour rule)
 *   3. normalisers: bad coordinates, 0,0 "no location", out-of-range, junk
 *      kinds/colours/levels are dropped or defaulted, never thrown
 *   4. the instance against a FAKE Leaflet: pins/swaths/routes reach the map,
 *      select() / popup() / events, themechange re-themes, destroy() cleans up
 *   5. css: tokens only, mv-prefixed, hail layers reference ONLY --red/--gold
 *
 * Run: node tests/layout-mapview-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n      ' + detail : '')); }
}

const M = require(path.join(ROOT, 'docs/pro/js/layouts/mapview.js'));

console.log('\n1. theme luminance');
{
  ok('near-black rgb is dark', M.isDarkColor('rgb(15, 17, 23)'));
  ok('white is light', !M.isDarkColor('#ffffff'));
  ok('#fff short hex is light', !M.isDarkColor('#fff'));
  ok('space-syntax rgb with alpha parses', M.parseColor('rgb(10 20 30 / 0.5)').a === 0.5);
  ok('light parchment is light', !M.isDarkColor('rgb(244, 238, 224)'));
  ok('unparseable falls back dark (CRM default)', M.isDarkColor('color-mix(in srgb, red, blue)'));
  ok('transparent falls back dark', M.isDarkColor('rgba(0, 0, 0, 0)'));
}

console.log('\n2. point in polygon + hail level');
{
  const sq = [[39.0, -84.6], [39.0, -84.4], [39.2, -84.4], [39.2, -84.6]];
  ok('inside', M.pointInRing(39.1, -84.5, sq));
  ok('outside north', !M.pointInRing(39.3, -84.5, sq));
  ok('outside west', !M.pointInRing(39.1, -84.7, sq));
  ok('closed ring still works', M.pointInRing(39.1, -84.5, sq.concat([sq[0]])));
  // concave "C" shape: the notch between the arms is outside
  const c = [[0, 0], [0, 10], [10, 10], [10, 6], [4, 6], [4, 4], [10, 4], [10, 0]];
  ok('concave: a point in the arm is inside', M.pointInRing(2, 5, c));
  ok('concave: a point in the notch is outside', !M.pointInRing(7, 5, c));
  ok('degenerate (<3 points) is never inside', !M.pointInRing(1, 1, [[0, 0], [2, 2]]));
  ok('hail 2in is red', M.levelForHail(2) === 'red');
  ok('hail 1.75in (golf ball) is red', M.levelForHail(1.75) === 'red');
  ok('hail 1.0in is gold', M.levelForHail(1) === 'gold');
  ok('no size is warn', M.levelForHail(null) === 'warn' && M.levelForHail('abc') === 'warn');
}

console.log('\n3. normalisers');
{
  ok('good pin', !!M.normalizePin({ id: 'a', lat: 39.1, lng: -84.5 }));
  ok('lon alias accepted', M.normalizePin({ id: 'a', lat: 39.1, lon: -84.5 }).lng === -84.5);
  ok('string coords accepted', M.normalizePin({ lat: '39.1', lng: '-84.5' }).lat === 39.1);
  ok('0,0 is "no location"', M.normalizePin({ lat: 0, lng: 0 }) === null);
  ok('out of range dropped', M.normalizePin({ lat: 91, lng: 0 }) === null && M.normalizePin({ lat: 10, lng: 181 }) === null);
  ok('blank-string coords dropped (Number("") is 0)', M.normalizePin({ lat: '', lng: '' }) === null);
  ok('null / junk dropped', M.normalizePin(null) === null && M.normalizePin('x') === null);
  const p = M.normalizePin({ lat: 39, lng: -84, kind: 'evil', color: 'url(javascript:x)', num: -3 });
  ok('unknown kind / color defaulted, negative num dropped', p.kind === 'job' && p.color === 'muted' && p.num === null);
  ok('swath needs a ring of >= 3 valid points', M.normalizeSwath({ rings: [[[1, 1], [2, 2]]] }) === null);
  ok('swath bad points are skipped', M.normalizeSwath({ rings: [[[39, -84], ['x', 1], [39.1, -84], [39.1, -84.1]]] }).rings[0].length === 3);
  ok('swath unknown level -> warn', M.normalizeSwath({ rings: [[[39, -84], [39.1, -84], [39.1, -84.1]]], level: 'blue' }).level === 'warn');
  ok('route needs 2 points', M.normalizeRoute({ points: [[39, -84]] }) === null);
  ok('route default color orange', M.normalizeRoute({ points: [[39, -84], [39.1, -84.1]] }).color === 'orange');
  ok('boundsOf', JSON.stringify(M.boundsOf([[1, 5], [3, 2]])) === '[[1,2],[3,5]]');
  ok('boundsOf empty is null', M.boundsOf([]) === null);
}

console.log('\n4. instance against a fake Leaflet');
{
  const calls = [];
  const drawn = { pins: [], swaths: [], routes: [] };
  const mk = (type) => (...a) => ({
    type, a, handlers: {}, opts: a[a.length - 1],
    on(n, f) { this.handlers[n] = f; return this; },
    addTo(g) { if (g && g.bucket) g.bucket.push(this); return this; },
    bindTooltip() { return this; },
    setIcon(i) { this.icon = i; calls.push('setIcon'); },
  });
  const layerGroup = () => { const g = { bucket: [], addTo() { return g; }, clearLayers() { g.bucket.length = 0; } }; return g; };
  let mapObj; const groups = [];
  const L = {
    map() {
      mapObj = { bounds: [], h: {}, on(n, f) { this.h[n] = f; return this; }, setView() { return this; }, createPane() { return { style: {} }; },
        removeLayer() {}, getZoom() { return 11; }, fitBounds(b) { this.bounds.push(b); }, panTo(c) { this.panned = c; },
        invalidateSize() {}, remove() { this.removed = true; } };
      return mapObj;
    },
    layerGroup() { const g = layerGroup(); groups.push(g); return g; },
    tileLayer(u) { calls.push('tile:' + u); return mk('tile')(u); },
    divIcon(o) { return o; }, marker: mk('marker'), circleMarker: mk('dot'), polygon: mk('polygon'), polyline: mk('polyline'),
    popup() { const p = { setLatLng() { return p; }, setContent(n) { p.content = n; return p; }, openOn() { p.opened = true; return p; } }; L.lastPopup = p; return p; },
  };
  const classes = new Set(); const attrs = {};
  const el = {
    classList: { add: (c) => classes.add(c), remove: (...c) => c.forEach((x) => classes.delete(x)), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute: (k, v) => { attrs[k] = v; }, appendChild() {},
  };
  const docH = {};
  let bg = 'rgb(10, 12, 16)';
  const doc = { createElement: () => ({ className: '', setAttribute() {} }), addEventListener: (n, f) => { docH[n] = f; }, removeEventListener: (n) => { delete docH[n]; } };
  const win = { getComputedStyle: () => ({ backgroundColor: bg }), addEventListener() {} };
  const inst = M._build({ L, doc, win }, el, { tiles: 'streets', center: [39.1, -84.5], zoom: 10 });
  const [pinG, swathG, routeG] = groups;

  ok('streets tile layer is the OSM host the draw tool already uses', calls.some((c) => c.indexOf('tile:https://{s}.tile.openstreetmap.org/') === 0));
  ok('dark bg stamps mv-dark', classes.has('mv-dark') && attrs['data-mv-theme'] === 'dark');
  bg = 'rgb(250, 248, 240)';
  if (docH.themechange) docH.themechange();
  ok('themechange flips to light', classes.has('mv-light') && !classes.has('mv-dark') && attrs['data-mv-theme'] === 'light');

  inst.setPins([{ id: 'p1', lat: 39.1, lng: -84.5, kind: 'stop', num: 2, color: 'orange', title: 'x' },
    { id: 'bad', lat: 0, lng: 0 }, { id: 'd1', lat: 39.2, lng: -84.4, kind: 'dot', size: 40 }]);
  ok('invalid pin dropped, two drawn', pinG.bucket.length === 2);
  ok('stop pin icon carries its number', /<b>2<\/b>/.test(pinG.bucket[0].opts.icon.html) && /mv-pin--stop/.test(pinG.bucket[0].opts.icon.html));
  ok('dot radius is capped', pinG.bucket[1].opts.radius === 16);
  inst.setSwaths([{ id: 's', rings: [[[39, -84.6], [39, -84.4], [39.2, -84.4]]], level: 'red' }, { id: 'x', rings: [] }]);
  ok('one valid swath drawn with its level class', swathG.bucket.length === 1 && /mv-swath--red/.test(swathG.bucket[0].opts.className));
  inst.setRoutes([{ id: 'r', points: [[39, -84], [39.1, -84.1]] }, { id: 'r2', points: [[1, 1]] }]);
  ok('one valid route drawn', routeG.bucket.length === 1);
  ok('fit frames the drawn things', inst.fit() === true && mapObj.bounds.length === 1);
  ok('select a pin pans there and re-icons', inst.select('p1') === true && mapObj.panned[0] === 39.1 && calls.indexOf('setIcon') !== -1);
  ok('select unknown id is false', inst.select('nope') === false);
  const node = { nodeType: 1 };
  ok('popup takes a node for a known pin', inst.popup('p1', node) === true && L.lastPopup.content === node && L.lastPopup.opened);
  ok('popup for an unknown pin is a no-op', inst.popup('zzz', node) === false);

  let got = null; inst.on('mapclick', (d) => { got = d; });
  mapObj.h.click({ latlng: { lat: 39.5, lng: -84.1 } });
  ok('mapclick event carries lat/lng', got && got.lat === 39.5 && got.lng === -84.1);
  let hit = null; inst.on('pinclick', (d) => { hit = d; });
  pinG.bucket[0].handlers.click();
  ok('pinclick event carries the normalised pin', hit && hit.pin.id === 'p1' && hit.pin.num === 2);

  inst.setTiles('plain');
  ok('plain mode says so', attrs['data-mv-tiles'] === 'plain');
  inst.setTiles('bogus');
  ok('unknown tile mode is ignored', attrs['data-mv-tiles'] === 'plain');

  inst.destroy();
  ok('destroy removes the map, the theme listener and the classes', mapObj.removed === true && !docH.themechange && !classes.has('nbd-mv'));
}

console.log('\n5. css contract');
{
  const css = read('docs/pro/css/layouts/mapview.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const outside = rules.filter((m) => !/(\.nbd-mv|\.mv-)/.test(m[1]));
  ok('every selector is under .nbd-mv or mv-prefixed', outside.length === 0, outside.map((m) => m[1].trim()).join(' | '));
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  ok('no hard-coded colours except the white pin glyph', hex.every((h) => h.toLowerCase() === '#fff'), hex.join(','));
  const swath = rules.filter((m) => /\.mv-swath--/.test(m[1])).map((m) => m[2]).join(' ');
  const vars = new Set(swath.match(/var\(--[a-z0-9-]+\)/g) || []);
  ok('swaths use ONLY --red / --gold', vars.size > 0 && [...vars].every((v) => v === 'var(--red)' || v === 'var(--gold)'), [...vars].join(','));
  ok('route is --orange', /\.mv-route\s*\{[^}]*var\(--orange\)/.test(css));
  ok('land is --bg', /\.nbd-mv\s*\{[^}]*background:\s*var\(--bg\)/.test(css));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
