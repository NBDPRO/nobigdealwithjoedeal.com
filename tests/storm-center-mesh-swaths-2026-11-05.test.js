/**
 * tests/storm-center-mesh-swaths-2026-11-05.test.js
 *
 * Radar hail swaths (NOAA MRMS MESH) on the Storm Center map, the same layer
 * the Mission and D2D maps already draw (js/hail-mesh-swaths.js).
 *
 *   1. meshStyle (run for real): 1.75"+ red, smaller gold, and every swath
 *      carries the NOAA MRMS attribution.
 *   2. Layer order: the swaths sit above the SPC outlook and under the
 *      alerts, zones and pins.
 *   3. Loading: the shared module only, on demand through ScriptLoader;
 *      a stale load never draws; a failed read never throws.
 *   4. Wording: the popup is escaped and says "Not a measured size"; nothing
 *      claims "no radar hail".
 *
 * Run: node tests/storm-center-mesh-swaths-2026-11-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
function liftBetween(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) return '';
  const b = src.indexOf(end, a + start.length);
  return b < 0 ? '' : src.slice(a, b + end.length);
}

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const SRC = read('docs/pro/js/storm-center.js');
const code = stripComments(SRC);

console.log('\n1. meshStyle (run for real)');
const styleSrc = liftBetween(SRC, '  function meshStyle(level) {', '\n  }\n');
const colorsSrc = (SRC.match(/  const MESH_COLORS = \{[^}]*\};/) || [''])[0];
ok('lifted meshStyle and MESH_COLORS', !!styleSrc && !!colorsSrc);
const ctx = {}; vm.createContext(ctx);
vm.runInContext(colorsSrc + '\n' + styleSrc + '\nthis.meshStyle = meshStyle;', ctx);
const red = ctx.meshStyle('red'), gold = ctx.meshStyle('gold'), other = ctx.meshStyle('purple');
ok('1.75"+ is red, more opaque', red.color === '#d64545' && red.fillOpacity > gold.fillOpacity);
ok('smaller hail is gold; an unknown level falls back to gold', gold.color === '#d9a21b' && other.color === '#d9a21b');
ok('every swath carries the NOAA MRMS attribution', red.attribution === 'Radar hail estimate: NOAA MRMS' && gold.attribution === red.attribution);
ok('same colours as the D2D map', /MESH_COLORS = \{ gold: '#d9a21b', red: '#d64545' \}/.test(read('docs/pro/js/d2d-storm-layer.js')));

console.log('\n2. layer order');
const iOut = code.indexOf('stormLayers.outlook = L.layerGroup().addTo(stormMap);');
const iMesh = code.indexOf('stormLayers.mesh = L.layerGroup().addTo(stormMap);');
const iAlerts = code.indexOf('stormLayers.alerts = L.layerGroup().addTo(stormMap);');
const iPins = code.indexOf('stormLayers.pins = L.layerGroup().addTo(stormMap);');
ok('outlook, then swaths, then alerts / zones / pins', iOut > 0 && iMesh > iOut && iAlerts > iMesh && iPins > iAlerts);
ok('drawn into their own layer, cleared before each draw', /stormLayers\.mesh\.clearLayers\(\);/.test(code) && /\.addTo\(stormLayers\.mesh\)/.test(code));
ok('the map build redraws what is loaded, then refreshes', /renderMapLayers\(\);\s*drawMeshSwaths\(\);\s*loadMeshSwaths\(\);/.test(code));

console.log('\n3. loading');
const loadSrc = liftBetween(code, '  function loadMeshSwaths() {', '\n  }\n');
ok('the shared module, on demand, once', /SL\.load\('\/pro\/js\/hail-mesh-swaths\.js\?v=1'\)/.test(loadSrc) && /!meshLoaderTried/.test(loadSrc));
ok('a stale load never draws (sequence check)', /if \(seq !== meshSeq\) return;/.test(loadSrc));
ok('a failed read never throws (rejections swallowed)', (loadSrc.match(/\(\) => \{\}\)/g) || []).length >= 2);
ok('the last 7 storm days, keyed by UTC day', /const MESH_DAYS = 7;/.test(code) && /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(loadSrc));
ok('Storm Center cache-buster bumped (v>=9)', Number((read('docs/pro/js/script-loader.js').match(/js\/storm-center\.js\?v=(\d+)/) || [])[1]) >= 9);

console.log('\n4. wording');
ok('popup escaped, says not a measured size', /bindPopup\(esc\(s\.title\) \+ '<br><small>Not a measured size<\/small>'\)/.test(code));
ok('esc exists in this file (no undefined helper)', /function esc\(s\)/.test(code));
ok('never claims there was no radar hail', !/no radar hail/i.test(code));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
