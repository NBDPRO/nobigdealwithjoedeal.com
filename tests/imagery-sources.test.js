/**
 * tests/imagery-sources.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * The CRM's historical-imagery slider (maps-routing.js) addressed Esri
 * Wayback releases by ids like `WB_2024_R06`, which were never valid — every
 * tile request 404'd and the slider had shown nothing since it shipped
 * (measured 2026-09-04: numeric release id → 200 image/jpeg, string → 404).
 * Nothing caught it because nothing checked that the ids were the kind the
 * service takes, and the slider's HTML range was a hard-coded 0..7 that had
 * to agree with the array by hand.
 *
 * The same PR added KyFromAbove 3-inch aerials to the D2D tracker. Both new
 * tile hosts need to be in img-src on BOTH dashboard CSP headers (enforced
 * and Report-Only) or the tiles are blocked with no visible error.
 *
 * This pins: the release table (against waybackconfig.json as read on
 * 2026-09-04), id/date shape and order, the slider range, the CSP hosts, the
 * D2D basemap wiring, and that the service worker's tile cache still matches.
 *
 * Pure-Node, no network. Run: node tests/imagery-sources.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// Esri waybackconfig.json, read 2026-09-04: release id → itemTitle date.
// One per year around June, plus the two most recent. If Esri publishes a
// newer release and someone adds it, add it here too — this is the proof
// that each id is real, not a guess.
const KNOWN_RELEASES = {
  11033: '2014-06-25', 11952: '2015-06-24', 11509: '2016-06-13', 4073: '2017-06-27',
  11334: '2018-06-27', 645: '2019-06-26', 11135: '2020-06-10', 13534: '2021-06-30',
  4905: '2022-06-29', 47963: '2023-06-29', 39767: '2024-06-27', 48925: '2025-06-26',
  49059: '2026-04-30', 26334: '2026-08-05',
};

console.log('\nWAYBACK — numeric release ids, in order, matching Esri\'s own table');
let versions = null;
{
  const src = read('docs/pro/js/maps-routing.js');
  const m = /const ESRI_WAYBACK_VERSIONS\s*=\s*(\[[\s\S]*?\]);/.exec(src);
  ok('ESRI_WAYBACK_VERSIONS is declared', !!m);
  if (m) {
    try { versions = vm.runInNewContext('(' + m[1] + ')'); } catch (e) { ok('array parses', false, e.message); }
  }
  if (Array.isArray(versions)) {
    ok('at least a decade of releases', versions.length >= 10, String(versions.length));
    ok('every entry has an integer `release` (the id the WMTS path takes)',
       versions.every((v) => Number.isInteger(v.release) && v.release > 0));
    ok('no entry still carries a WB_ string id', !versions.some((v) => typeof v.version === 'string' || /WB_/.test(JSON.stringify(v))));
    ok('every entry has an ISO date', versions.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v.date)));
    ok('ordered oldest → newest (slider left = older, right = newer)',
       versions.every((v, i) => i === 0 || v.date > versions[i - 1].date));
    ok('no duplicate release ids', new Set(versions.map((v) => v.release)).size === versions.length);
    ok('every (release, date) pair matches waybackconfig.json as read on 2026-09-04',
       versions.every((v) => KNOWN_RELEASES[v.release] === v.date),
       versions.filter((v) => KNOWN_RELEASES[v.release] !== v.date).map((v) => v.release + ':' + v.date).join(' '));
    ok('the newest release is the last entry (the default the slider opens on)',
       versions[versions.length - 1].date === Object.values(KNOWN_RELEASES).sort().pop());
  }
  const code = codeOnly(src);
  ok('tile URL is the Wayback WMTS path with the release id interpolated',
     /wayback\.maptiles\.arcgis\.com\/arcgis\/rest\/services\/World_Imagery\/WMTS\/1\.0\.0\/default028mm\/MapServer\/tile\/\$\{release\}\/\{z\}\/\{y\}\/\{x\}/.test(code));
  ok('the layer declares maxNativeZoom so zooming past Esri\'s z=19 upscales instead of going blank',
     /maxNativeZoom:\s*19/.test(code.slice(code.indexOf('function setHistoricalLayer'), code.indexOf('function updateHistoryOpacity'))));
  ok('the default index is the newest entry', /setHistoricalLayer\(ESRI_WAYBACK_VERSIONS\.length - 1\)/.test(code));
}

console.log('\nSLIDER — the HTML range agrees with the array');
{
  const html = read('docs/pro/dashboard.html');
  const panel = html.slice(html.indexOf('id="historyPanel"'), html.indexOf('historyOpacityLabel'));
  const m = /<input type="range" min="0" max="(\d+)" value="(\d+)"[^>]*data-on-input="setHistoricalLayer"/.exec(panel);
  ok('the date slider is present', !!m);
  if (m && Array.isArray(versions)) {
    ok('slider max = entries − 1', Number(m[1]) === versions.length - 1, `max=${m[1]} entries=${versions.length}`);
    ok('slider starts at max (newest)', m[2] === m[1]);
  }
}

console.log('\nCSP — both dashboard headers allow both tile hosts');
{
  const fb = JSON.parse(read('firebase.json'));
  const rules = fb.hosting.headers.filter((h) => h.source === '**');
  ok('exactly one `**` headers rule', rules.length === 1);
  const csp = (rules[0].headers || []).filter((h) => /^Content-Security-Policy(-Report-Only)?$/.test(h.key));
  ok('the `**` rule carries an enforced AND a Report-Only CSP', csp.length === 2);
  for (const h of csp) {
    const img = /img-src ([^;]+);/.exec(h.value);
    ok(`${h.key}: img-src includes wayback.maptiles.arcgis.com`, img && /https:\/\/wayback\.maptiles\.arcgis\.com(\s|$)/.test(img[1]));
    ok(`${h.key}: img-src includes kygisserver.ky.gov`, img && /https:\/\/kygisserver\.ky\.gov(\s|$)/.test(img[1]));
  }
  ok('firebase.json was edited line-wise (still one header per line — no JSON.stringify reflow)',
     read('firebase.json').split('\n').filter((l) => /Content-Security-Policy/.test(l)).length >= 2);
}

console.log('\nD2D — KyFromAbove is a basemap choice, layered over Esri imagery outside Kentucky');
{
  // 2026-10-04 (vendor audit Lane D): the satellite base under ky3in is Esri
  // World Imagery (+ a USGS underlay), no longer raw Google mt* tiles, and an
  // entry's extra layers live in an `overlays` array. The builder itself is
  // executed in tests/client-dead-vendors-2026-10-04.test.js.
  const src = codeOnly(read('docs/pro/js/d2d-tracker-core-2026b.js'));
  const bm = /const BASEMAPS\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(src);
  ok('BASEMAPS is declared', !!bm);
  const body = bm ? bm[1] : '';
  ok('ky3in entry exists', /\bky3in:\s*\{/.test(body));
  const ky = body.slice(body.indexOf('ky3in:'));
  ok('ky3in overlay is the KyFromAbove Phase 3 3-inch MapServer tile URL',
     /overlays:\s*\[\s*\{\s*url:\s*'https:\/\/kygisserver\.ky\.gov\/arcgis\/rest\/services\/WGS84WM_Services\/Ky_Imagery_Phase3_3IN_WGS84WM\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}'/.test(ky));
  ok('ky3in keeps satellite imagery underneath (blank KY tiles outside the state must not show a void)',
     /ky3in:\s*\{[^}]*url:\s*ESRI_TILE\('World_Imagery'\)[^}]*imagery:\s*true/.test(body));
  ok('ky3in is in BASEMAP_ORDER (so it gets a button)', /BASEMAP_ORDER\s*=\s*\[[^\]]*'ky3in'/.test(src));
  ok('_makeBasemapLayer builds a layerGroup when overlays/underlay are declared',
     /\(b\.overlays \|\| \[\]\)\.forEach[\s\S]{0,600}L\.layerGroup\(parts\)/.test(src));
  ok('the overlay honours the server\'s native LOD ceiling (21) via maxNativeZoom', /kygisserver[^\n]*\n\s*maxNativeZoom:\s*21/.test(ky));
  ok('setBasemap guards bringToBack (a layerGroup has none)', /if \(layer\.bringToBack\) layer\.bringToBack\(\)/.test(src));
}

console.log('\nSERVICE WORKER — the tile cache still recognises both hosts');
{
  const sw = codeOnly(read('docs/pro/sw.js'));
  ok('isMapTile matches any /tile path, which covers both new hosts', /url\.pathname\.includes\('\/tile'\)/.test(sw));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
