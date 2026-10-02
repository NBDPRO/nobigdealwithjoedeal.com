/**
 * tests/storm-outlook.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Storm Center shows what is happening now (active NWS alerts) and what
 * already happened (hail history). storm-outlook.js adds what is COMING —
 * SPC's Day-1 convective outlook — which is the signal a roofer can actually
 * pre-position on.
 *
 * The failure modes are all quiet ones:
 *   - The research note's endpoint names (`day1probotlk_*`) 404. Probed live
 *     2026-09-05: the working names are `day1otlk_cat` / `day1otlk_hail`. A
 *     404 here would just mean "no outlook ever appears", forever, silently.
 *   - SPC polygons NEST (TSTM contains MRGL contains SLGT). Take the first
 *     match instead of the highest DN and the rep is told "General
 *     Thunderstorms" while standing inside a Slight Risk.
 *   - A point outside every polygon must render NOTHING. Rendering a zero
 *     would claim SPC forecast no risk, which is a different statement.
 *   - Caching on a fixed TTL rather than the payload's own EXPIRE_ISO shows a
 *     stale outlook after SPC reissues.
 *
 * Fixtures are the REAL payloads captured from the live endpoints on
 * 2026-09-05 (properties verbatim, geometry reduced to simple rings).
 *
 * Pure Node, no network. Run: node tests/storm-outlook.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const codeOnly = (s) => s.replace(/^\s*\/\/.*$/mg, '').replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// ── load the module with a stub window ───────────────────────────
const SRC_PATH = path.join(ROOT, 'docs', 'pro', 'js', 'storm-outlook.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const store = {};
const sandbox = {
  window: {},
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  console: { log() {}, warn() {}, error() {} },
  JSON, Date, Math, Number, String, Object, Array, Promise, isNaN, parseFloat,
};
sandbox.window.window = sandbox.window;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'storm-outlook.js' });
const O = sandbox.window.StormOutlook;

// A square ring in GeoJSON [lng, lat] order.
const box = (w, s, e, n) => [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
const feat = (props, coords) => ({ type: 'Feature', properties: props, geometry: { type: 'MultiPolygon', coordinates: [coords] } });

// Real property sets, captured 2026-09-05 from the live endpoints.
const COMMON = {
  VALID: '202609050100', EXPIRE: '202609051200', ISSUE: '202609050053',
  VALID_ISO: '2026-09-05T01:00:00+00:00', EXPIRE_ISO: '2026-09-05T12:00:00+00:00',
  ISSUE_ISO: '2026-09-05T00:53:00+00:00', FORECASTER: 'Mead',
};
// Nested, exactly as SPC ships them: TSTM is the biggest, SLGT the smallest.
const CAT = [
  feat({ ...COMMON, DN: 2, LABEL: 'TSTM', LABEL2: 'General Thunderstorms Risk', stroke: '#55BB55', fill: '#C1E9C1' }, box(-90, 35, -80, 42)),
  feat({ ...COMMON, DN: 3, LABEL: 'MRGL', LABEL2: 'Marginal Risk', stroke: '#005500', fill: '#66A366' }, box(-88, 37, -82, 41)),
  feat({ ...COMMON, DN: 4, LABEL: 'SLGT', LABEL2: 'Slight Risk', stroke: '#DDAA00', fill: '#FFE066' }, box(-86, 38, -83, 40)),
];
const HAIL = [
  feat({ ...COMMON, DN: 5, LABEL: '0.05', LABEL2: '5% Hail Risk', stroke: '#8B4726', fill: '#C5A392' }, box(-87, 38, -83, 40.5)),
];
const CINCY = { lat: 39.1031, lng: -84.5120 };   // inside all three cat polygons
const FAR = { lat: 25.0, lng: -80.0 };           // inside none

console.log('\nLOADS');
ok('the module evaluates and exposes its API', !!O && typeof O.load === 'function');
ok('pure helpers are exported for testing', typeof O._highestAt === 'function' && typeof O._summarizeAt === 'function');

console.log('\nENDPOINTS — the names the note got wrong');
{
  // Probed live 2026-09-05: day1probotlk_* → 404, day1otlk_* → 200.
  ok('categorical URL is the one that actually serves',
     O._urls.CAT_URL === 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson');
  ok('hail URL is the one that actually serves',
     O._urls.HAIL_URL === 'https://www.spc.noaa.gov/products/outlook/day1otlk_hail.nolyr.geojson');
  ok('neither uses the note\'s 404-ing day1probotlk_ name',
     !/day1probotlk/.test(O._urls.CAT_URL + O._urls.HAIL_URL));
}

console.log('\nPOINT IN POLYGON — GeoJSON order, holes respected');
{
  ok('a point inside a simple ring is inside', O._pointInRing(-84.5, 39.1, box(-86, 38, -83, 40)[0]) === true);
  ok('a point outside is outside', O._pointInRing(-70, 39.1, box(-86, 38, -83, 40)[0]) === false);
  // Coordinates are [lng, lat]; swapping them is the classic bug and would put
  // Cincinnati in the Indian Ocean.
  ok('lng/lat order is not swapped', O._pointInRing(39.1, -84.5, box(-86, 38, -83, 40)[0]) === false);

  const withHole = {
    type: 'Polygon',
    coordinates: [box(-90, 30, -80, 45)[0], box(-86, 38, -83, 40)[0]],
  };
  ok('a point in the outer ring is inside', O._pointInGeometry(-88, 44, withHole) === true);
  ok('a point inside a HOLE is NOT inside (a hole means "not this bit")',
     O._pointInGeometry(-84.5, 39.1, withHole) === false);
  ok('a MultiPolygon checks every part',
     O._pointInGeometry(-84.5, 39.1, { type: 'MultiPolygon', coordinates: [box(-10, 0, -5, 5), box(-86, 38, -83, 40)] }) === true);
  ok('a null/unknown geometry is false, not a throw',
     O._pointInGeometry(0, 0, null) === false && O._pointInGeometry(0, 0, { type: 'Point', coordinates: [0, 0] }) === false);
}

console.log('\nNESTED POLYGONS — the worst risk wins, not the first match');
{
  const best = O._highestAt(CAT, CINCY.lat, CINCY.lng);
  ok('inside all three, the answer is the HIGHEST DN', best && best.properties.LABEL === 'SLGT');
  ok('...not the first one in the array (which is TSTM)', CAT[0].properties.LABEL === 'TSTM');
  const outside = O._highestAt(CAT, FAR.lat, FAR.lng);
  ok('outside every polygon → null, never a default', outside === null);
  ok('an empty feature list → null', O._highestAt([], CINCY.lat, CINCY.lng) === null);
  ok('a malformed feature is skipped rather than thrown on',
     O._highestAt([{}, null, CAT[2]], CINCY.lat, CINCY.lng).properties.LABEL === 'SLGT');
}

console.log('\nTHE HEADER LINE');
{
  const st = { cat: CAT, hail: HAIL, fetchedAt: 0, expiresAt: 0 };
  const s = O._summarizeAt(st, CINCY.lat, CINCY.lng);
  ok('reads as the categorical risk plus the hail probability',
     s && s.text === 'Slight Risk · 5% hail', s && s.text);
  ok('the hail decimal is rendered as a percentage', s.hailPct === 5);
  ok('it carries SPC\'s own colour so the map and the chip agree', s.color === '#DDAA00');
  ok('DN is exposed for ordering', s.dn === 4);

  // The important negative: a quiet day must render NOTHING, not a zero. A "0"
  // would assert SPC forecast no risk, which is a different claim.
  ok('outside every polygon → null (absence, not a zero)',
     O._summarizeAt(st, FAR.lat, FAR.lng) === null);
  ok('categorical only (no hail polygon) still summarizes',
     O._summarizeAt({ cat: CAT, hail: [] }, CINCY.lat, CINCY.lng).text === 'Slight Risk');
  ok('hail only (no categorical) still summarizes',
     O._summarizeAt({ cat: [], hail: HAIL }, CINCY.lat, CINCY.lng).text === '5% hail');
  ok('an empty state → null', O._summarizeAt({ cat: [], hail: [] }, CINCY.lat, CINCY.lng) === null);
  ok('a null state → null', O._summarizeAt(null, CINCY.lat, CINCY.lng) === null);
}

console.log('\nEXPIRY — the payload states it, so do not guess a TTL');
{
  const expiresAt = Date.parse('2026-09-05T12:00:00+00:00');
  ok('EXPIRE_ISO is read off the features', O._expiryOf(CAT) === expiresAt);
  ok('no parsable expiry → 0 rather than a wrong guess', O._expiryOf([{ properties: {} }]) === 0);
  ok('before the expiry, the cache is live',
     O._isExpired({ expiresAt }, expiresAt - 60_000) === false);
  ok('at the expiry instant it is stale (SPC has reissued)',
     O._isExpired({ expiresAt }, expiresAt) === true);
  ok('a cache with no expiry is always stale', O._isExpired({ cat: [] }, 1) === true);
  ok('a null cache is stale', O._isExpired(null, 1) === true);
}

console.log('\nDRAW — SPC colours, worst on top, one bad feature cannot stop the rest');
{
  const drawnOrder = [];
  const fakeLayer = { };
  const L = {
    geoJSON(f, opts) {
      if (!f.properties.LABEL) throw new Error('bad feature');
      drawnOrder.push({ label: f.properties.LABEL, style: opts.style });
      return { bindPopup() { return { addTo() {} }; } };
    },
  };
  const n = O.draw(L, fakeLayer, { cat: CAT, hail: HAIL });
  ok('every categorical polygon is drawn', n === 3);
  ok('lowest risk first, so the worst ends up on top',
     drawnOrder.map((d) => d.label).join(',') === 'TSTM,MRGL,SLGT');
  ok('SPC\'s own stroke and fill are used', drawnOrder[2].style.color === '#DDAA00' && drawnOrder[2].style.fillColor === '#FFE066');
  ok('the fill is translucent so the basemap stays readable', drawnOrder[0].style.fillOpacity <= 0.2);

  drawnOrder.length = 0;
  const withBad = O.draw(L, fakeLayer, { cat: [{ properties: {}, geometry: null }].concat(CAT) });
  ok('a feature that throws does not stop the others', withBad === 3);

  ok('a missing Leaflet or layer group is a no-op, not a crash',
     O.draw(null, fakeLayer, { cat: CAT }) === 0 && O.draw(L, null, { cat: CAT }) === 0);
}

console.log('\nWIRING');
{
  const sc = codeOnly(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'storm-center.js'), 'utf8'));
  ok('an outlook layer group is created', /stormLayers\.outlook = L\.layerGroup\(\)/.test(sc));
  ok('...beneath alerts and zones, which must stay readable on top',
     sc.indexOf('stormLayers.outlook = L.layerGroup()') < sc.indexOf('stormLayers.alerts = L.layerGroup()'));
  ok('it is cleared and redrawn on every paint (render() rebuilds the map)',
     /stormLayers\.outlook\.clearLayers\(\)/.test(sc) && /window\.StormOutlook\.draw\(L, stormLayers\.outlook\)/.test(sc));
  ok('every call into the module is guarded — a failed outlook must not stop alerts',
     /window\.StormOutlook && typeof window\.StormOutlook\.draw === 'function'/.test(sc));
  ok('the outlook loads in PARALLEL with the alert fetch, not before it',
     /StormOutlook\.load\(\)[\s\S]{0,200}await fetchAlerts/.test(sc));
  ok('a failed outlook load is swallowed', /\.catch\(\(\) => \{\}\)/.test(sc));

  const loader = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'script-loader.js'), 'utf8');
  ok('the file is in the storm bundle', /js\/storm-outlook\.js/.test(loader));
  ok('storm-center is version-bumped so phones do not run the cached copy',
     Number((loader.match(/js\/storm-center\.js\?v=(\d+)/) || [])[1]) >= 3);

  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const rule = fb.hosting.headers.find((h) => h.source === '**');
  const csps = rule.headers.filter((h) => /^Content-Security-Policy(-Report-Only)?$/.test(h.key));
  ok('both CSP headers exist', csps.length === 2);
  for (const h of csps) {
    ok(h.key + ': connect-src allows www.spc.noaa.gov',
       /connect-src [^;]*https:\/\/www\.spc\.noaa\.gov/.test(h.value));
  }
  ok('the CSP edit stayed line-wise (one header per line, no reflow)',
     fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')
       .split('\n').filter((l) => /Content-Security-Policy/.test(l)).length >= 2);

  const mod = codeOnly(src);
  ok('the module never writes to the DOM directly (Storm Center owns rendering)',
     !/innerHTML/.test(mod));
  ok('popup text is escaped', /function esc\(/.test(mod) && /esc\(p\.LABEL2/.test(mod));
  ok('fetches carry a timeout so a hung SPC cannot wedge the page',
     /AbortSignal\.timeout\(FETCH_TIMEOUT_MS\)/.test(mod));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
