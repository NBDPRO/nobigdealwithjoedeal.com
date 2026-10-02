#!/usr/bin/env node
/**
 * Storm Watch on the D2D map (2026-10-02, GameForce idea #2).
 *
 *   A. Pure rules: newer reports brighter, hail dot grows with stone size,
 *      the 90-day / 1-year / 5-year filter, the popup label.
 *   B. The deep link ?storm=<lat>,<lon> parses only real US coordinates.
 *   C. Wiring: a "Storms" toggle in the D2D Layers panel calls the layer;
 *      the dashboard loads the file eagerly (deep link) + its CSS; the layer
 *      reads the SAME public endpoint as /storm-report; no inline styles.
 *   D. stormWatch's text to Jo leads with the map link (never cut by the
 *      480-char slice).
 *
 * Run: node tests/d2d-storm-layer-2026-10-02.test.js
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

const win = { location: { search: '', pathname: '/pro/dashboard.html', hash: '' }, history: { replaceState() {} } };
win.window = win;
const ctx = vm.createContext({ window: win, document: { readyState: 'complete', addEventListener() {} }, console, Math, JSON, Date, Number, String, setTimeout });
vm.runInContext(read('docs/pro/js/d2d-storm-layer.js'), ctx);
const S = win.NBDD2DStorms;

console.log('A. rules');
const now = Date.parse('2026-10-02T18:00:00Z');
const ev = (type, magnitude, date) => ({ type, magnitude, date, lat: 39.2, lon: -84.4, city: 'Mason' });
const fresh = S.styleFor(ev('hail', 1.75, '2026-09-30T21:00Z'), now);
const old = S.styleFor(ev('hail', 1.75, '2023-05-01T21:00Z'), now);
ok('newer reports are brighter', fresh.fillOpacity > old.fillOpacity && fresh.fillOpacity >= 0.9 && old.fillOpacity <= 0.3, JSON.stringify([fresh.fillOpacity, old.fillOpacity]));
ok('bigger hail draws a bigger dot (capped)', S.styleFor(ev('hail', 2.5, '2026-09-30'), now).radius > S.styleFor(ev('hail', 0.75, '2026-09-30'), now).radius && S.styleFor(ev('hail', 9, '2026-09-30'), now).radius <= 16);
ok('hail blue, wind green, tornado red', fresh.fillColor === '#3b82f6' && S.styleFor(ev('wind', 60, '2026-09-30'), now).fillColor === '#22c55e' && S.styleFor(ev('tornado', null, '2026-09-30'), now).fillColor === '#ef4444');
const list = [ev('hail', 1, '2026-09-01T00:00Z'), ev('wind', 60, '2026-03-01T00:00Z'), ev('hail', 1.5, '2022-06-01T00:00Z'), { type: 'hail', date: '2026-09-01', lat: NaN, lon: 1 }];
ok('90 days / 1 year / 5 years filters, and drops reports with no position',
  S.inWindow(list, 'd90', now).length === 1 && S.inWindow(list, 'y1', now).length === 2 && S.inWindow(list, 'y5', now).length === 3, [S.inWindow(list, 'd90', now).length, S.inWindow(list, 'y1', now).length, S.inWindow(list, 'y5', now).length].join());
ok('popup label: size, date, town', /^1\.75" hail · \w{3} \d+, 2026 · Mason$/.test(S.label(ev('hail', 1.75, '2026-09-30T21:00Z'))), S.label(ev('hail', 1.75, '2026-09-30T21:00Z')));
ok('popup text is escaped before Leaflet renders it', /bindPopup\(esc\(label\(ev\)\)\)/.test(read('docs/pro/js/d2d-storm-layer.js')));

console.log('B. deep link');
ok('?storm=39.31,-84.28 parses', JSON.stringify(S.parseStormParam('?storm=39.310,-84.280')) === '{"lat":39.31,"lon":-84.28}');
ok('junk or out-of-US coordinates are ignored', S.parseStormParam('?storm=abc') === null && S.parseStormParam('?storm=0,0') === null && S.parseStormParam('') === null);

console.log('C. wiring');
const core = read('docs/pro/js/d2d-tracker-core-2026b.js');
ok('Layers panel has a Storms toggle (off by default)', /\{ key: 'storms',\s+icon: '🌩️', label: 'Storms' \}/.test(core) && /storms: false \};/.test(core));
ok('toggling calls the layer show / hide', /case 'storms':[\s\S]{0,200}NBDD2DStorms\.show\(state\.d2dMap\)[\s\S]{0,80}NBDD2DStorms\.hide\(state\.d2dMap\)/.test(core));
ok('the deep link can turn the layer on (toggleLayer + isLayerOn exported)', /state\.toggleLayer = \(k\) => \{ toggleLayer\(k\); updateLayerPanel\(\); \};/.test(core) && /state\.isLayerOn = /.test(core));
const layer = read('docs/pro/js/d2d-storm-layer.js');
ok('the layer reads the same public endpoint as /storm-report', /const ENDPOINT = '\/api\/storm-report';/.test(layer) && /"source": "\/api\/storm-report"/.test(read('firebase.json')));
ok('no inline style attributes in the layer (CSS classes)', !/style=/.test(layer));
const dash = read('docs/pro/dashboard.html');
ok('dashboard loads the layer eagerly (deep link works before the D2D bundle) + its CSS', /<script defer src="js\/d2d-storm-layer\.js\?v=\d+"><\/script>/.test(dash) && /css\/d2d-storm\.css\?v=\d+/.test(dash));

console.log('D. Storm Watch text');
const sw = read('functions/storm-watch.js');
ok('the text to Jo leads with the D2D map link on the first report', /const mapLink = 'https:\/\/nobigdealwithjoedeal\.com\/pro\/dashboard\.html\?storm=' \+ events\[0\]\.lat\.toFixed\(3\) \+ ',' \+ events\[0\]\.lon\.toFixed\(3\);/.test(sw) && /`⛈️ NBD Storm Watch — map: \$\{mapLink\} — \$\{evLines\.join/.test(sw));
const sample = '⛈️ NBD Storm Watch — map: https://nobigdealwithjoedeal.com/pro/dashboard.html?storm=39.310,-84.280 — ';
ok('…which fits well inside the 480-char cut', sample.length < 140);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
