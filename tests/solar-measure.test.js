/**
 * tests/solar-measure.test.js — Google Solar API roof measurement provider.
 *
 * WHY THIS EXISTS
 * ───────────────
 * functions/integrations/solar-measure.js turns a Google Solar API
 * buildingInsights:findClosest response into the `measurements` shape the
 * estimate builder already prices from (VENDOR-COST-LOCKIN-2026-10-04, Lane G).
 * A wrong number here is a wrong price, so this pins:
 *
 *   1. unit conversions (degrees → x/12, m² → sq ft → squares, azimuth);
 *   2. the mapper against a fixture shaped like the documented response
 *      (tests/fixtures/solar-api/building-insights-hip-roof.json) — totals,
 *      predominant pitch, waste, segment detail, imagery date + quality;
 *   3. shape parity with Instant Roofer's normalizer, so no consumer changes;
 *   4. the accuracy guard (satellite-estimate note always; manual-check flag
 *      for > 8 planes, mixed pitches, LOW/old imagery, far-off building);
 *   5. NBD_MEASUREMENT_PROVIDER fallback logic (solar | auto), the 180-day
 *      company-scoped cache and the per-company daily cap;
 *   6. the wiring in measurement.js / public-measure.js / integrations.js and
 *      that no key reaches client code.
 *
 * No network: every call goes through deps.fetchImpl. No emulator.
 * Run: node tests/solar-measure.test.js   (needs functions/ deps)
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '').replace(/\s\/\/[^\n]*$/mg, '');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= (tol == null ? 0.01 : tol);
const clone = (o) => JSON.parse(JSON.stringify(o));

// Never let a developer machine's real key leak into a unit run.
delete process.env.SOLAR_API_KEY;
delete process.env.INSTANTROOFER_API_KEY;

let S = null, loadError = null;
try { S = require(path.join(FUNCTIONS, 'integrations', 'solar-measure.js')); } catch (e) { loadError = e; }
section('module loads');
ok('require(solar-measure.js) succeeds', !loadError, loadError && loadError.message);
if (!S) { finish(); return; }
const T = S._test;
const IR = require(path.join(FUNCTIONS, 'integrations', 'instantroofer-logic.js'));
const FIXTURE = JSON.parse(read('tests/fixtures/solar-api/building-insights-hip-roof.json'));
const PIN = { lat: 38.99870, lng: -84.62655 };
const NOW = Date.parse('2026-10-04T15:00:00Z');

// ── 1. conversions ──────────────────────────────────────────
section('unit conversions');
ok('26.565° → rise 6.0 (6/12)', near(T.degreesToRise(26.565), 6, 0.01) && T.riseToPitch(T.degreesToRise(26.565)) === '6/12');
ok('45° → 12/12', near(T.degreesToRise(45), 12, 0.001) && T.riseToPitch(T.degreesToRise(45)) === '12/12');
ok('0° (flat) → 0/12', T.degreesToRise(0) === 0 && T.riseToPitch(0) === '0/12');
ok('18.43° → 4/12', T.riseToPitch(T.degreesToRise(18.43)) === '4/12');
ok('garbage degrees → null (never NaN)', T.degreesToRise('x') === null && T.degreesToRise(-3) === null && T.degreesToRise(90) === null && T.riseToPitch(null) === null);
ok('1 m² = 10.7639 sq ft', near(T.m2ToSqft(1), 10.7639, 0.0001));
ok('100 m² = 1076 sq ft', Math.round(T.m2ToSqft(100)) === 1076);
ok('2075 sq ft = 20.75 squares', T.sqftToSquares(2075) === 20.75);
ok('azimuth → compass (180 S, 359 N, 92 E, 225 SW, -90 W)',
  T.azimuthToCompass(180) === 'S' && T.azimuthToCompass(359) === 'N' && T.azimuthToCompass(92) === 'E'
  && T.azimuthToCompass(225) === 'SW' && T.azimuthToCompass(-90) === 'W');
ok('imagery date object → YYYY-MM-DD', T.imageryDateString({ year: 2022, month: 4, day: 18 }) === '2022-04-18' && T.imageryDateString(null) === null);
ok('waste: gable 10, hip 12, 6 planes 14, 12 planes 16, 20 planes 18, mixed +2',
  T.suggestWastePct(2) === 10 && T.suggestWastePct(4) === 12 && T.suggestWastePct(6) === 14
  && T.suggestWastePct(12) === 16 && T.suggestWastePct(20) === 18 && T.suggestWastePct(6, true) === 16);

// ── 2. mapper on the fixture ────────────────────────────────
section('mapper — recorded-shape fixture (6-plane hip roof + garage)');
const mapped = S.mapBuildingInsights(FIXTURE, { lat: PIN.lat, lng: PIN.lng, now: NOW });
const m = mapped.measurements || {};
ok('returns measurements', !!mapped.measurements);
ok('rawSqft = sum of planes (62.4+61.9+18.3+18.1+16.2+15.9 m² → 2075 sq ft)', m.rawSqft === 2075, String(m.rawSqft));
ok('roofSquares (no waste) = 20.75', m.roofSquares === 20.75, String(m.roofSquares));
ok('footprintSqft from wholeRoofStats.groundAreaMeters2 (172.9 m² → 1861)', m.footprintSqft === 1861, String(m.footprintSqft));
ok('predominant pitch 6/12 (main roof outweighs the 5/12 garage)', m.pitch === '6/12', String(m.pitch));
ok('segment count 6 → facets 6', m.facets === 6);
ok('suggested waste 14% for 6 planes, single pitch family', m.wastePct === 14, String(m.wastePct));
ok('suggestedSqft = rawSqft × 1.14 = 2366', m.suggestedSqft === 2366, String(m.suggestedSqft));
ok('squares = suggested / 100 (Instant Roofer semantics) = 23.7', m.squares === 23.7, String(m.squares));
ok('complexity Moderate (5–8 planes)', m.complexity === 1 && m.complexityLabel === 'Moderate');
ok('not mixed pitch (6/12 vs 5/12 is under a 3/12 spread)', m.mixedPitch === false);
ok('imagery date + quality carried', m.imagery && m.imagery.date === '2022-04-18' && m.imagery.quality === 'HIGH' && near(m.imagery.ageYears, 4.5, 0.1));
ok('confidence label from imagery quality (High)', m.confidence && m.confidence.label === 'High' && m.confidence.score === null);
ok('per-segment detail: S plane 6/12, 672 sq ft, 6.72 sq',
  m.segments && m.segments[0].direction === 'S' && m.segments[0].pitch === '6/12' && m.segments[0].sqft === 672 && m.segments[0].squares === 6.72 && m.segments[0].azimuthDegrees === 181);
ok('garage plane reads 5/12', m.segments && m.segments[4].pitch === '5/12');
ok('building centre offset computed and small', typeof m.buildingOffsetM === 'number' && m.buildingOffsetM < 25, String(m.buildingOffsetM));
ok('ALWAYS marked satellite estimate — confirm on site', m.satelliteEstimate === true && m.accuracyNote === 'Satellite estimate — confirm on site');
ok('clean simple roof → no manual-check flag', m.needsManualCheck === false && Array.isArray(m.manualCheckReasons) && m.manualCheckReasons.length === 0, JSON.stringify(m.manualCheckReasons));
ok('source google-solar, no document', m.source === 'google-solar' && m.reportUrl === null);
ok('stories null (never overwrite the rep\'s storey count)', m.stories === null);
ok('no undefined values (Firestore rejects them)', !JSON.stringify(m, (k, v) => (v === undefined ? '__UNDEF__' : v)).includes('__UNDEF__'));
ok('solarPanelConfigs / financials never reach the result', !JSON.stringify(m).includes('panelsCount'));

section('shape parity with Instant Roofer (consumers need no change)');
{
  const irKeys = Object.keys(IR.normalizeAiResponse({}));
  const missing = irKeys.filter((k) => !(k in m));
  ok('every key Instant Roofer\'s normalizer emits is present', missing.length === 0, missing.join(','));
  ok('pitch parses with the same grammar the V2 builder uses', IR.parsePitchRise ? IR.parsePitchRise(m.pitch) === 6 : /^\d+\/12$/.test(m.pitch));
}

// ── 3. accuracy guard ───────────────────────────────────────
section('accuracy guard — manual-check flags');
function withSegments(n, degFn) {
  const b = clone(FIXTURE);
  b.solarPotential.roofSegmentStats = Array.from({ length: n }, (_, i) => ({
    pitchDegrees: degFn ? degFn(i) : 26.57, azimuthDegrees: (i * 47) % 360,
    stats: { areaMeters2: 20, groundAreaMeters2: 18 }
  }));
  return b;
}
{
  const nine = S.mapBuildingInsights(withSegments(9), { now: NOW }).measurements;
  ok('9 planes (> 8) → needsManualCheck with a complex-roof reason', nine.needsManualCheck === true && nine.manualCheckReasons.some((r) => /complex roof: 9/.test(r)));
  const eight = S.mapBuildingInsights(withSegments(8), { now: NOW }).measurements;
  ok('exactly 8 uniform planes → not flagged (boundary)', eight.needsManualCheck === false, JSON.stringify(eight.manualCheckReasons));
  const mixed = S.mapBuildingInsights(withSegments(4, (i) => (i < 2 ? 18.43 : 39.81)), { now: NOW }).measurements;
  ok('4/12 + 10/12 planes → mixedPitch + flagged + waste +2', mixed.mixedPitch === true && mixed.needsManualCheck === true
    && mixed.manualCheckReasons.some((r) => /mixed pitches: 4\/12 to 10\/12/.test(r)) && mixed.wastePct === 14, JSON.stringify(mixed));
  const tinyDormer = withSegments(4);
  tinyDormer.solarPotential.roofSegmentStats.push({ pitchDegrees: 45, azimuthDegrees: 90, stats: { areaMeters2: 1.5 } });
  ok('a tiny steep dormer cheek (< 5% of roof) does not count as mixed pitch', S.mapBuildingInsights(tinyDormer, { now: NOW }).measurements.mixedPitch === false);
  const flat = S.mapBuildingInsights(withSegments(2, (i) => (i === 0 ? 4 : 26.57)), { now: NOW }).measurements;
  ok('a low-slope plane (< 2/12) is flagged', flat.manualCheckReasons.some((r) => /low-slope/.test(r)));
  const low = clone(FIXTURE); low.imageryQuality = 'LOW';
  const lm = S.mapBuildingInsights(low, { now: NOW }).measurements;
  ok('LOW imagery → flagged, confidence Low', lm.needsManualCheck && lm.manualCheckReasons.some((r) => /low-quality/.test(r)) && lm.confidence.label === 'Low');
  const old = clone(FIXTURE); old.imageryDate = { year: 2018, month: 6, day: 1 };
  ok('imagery older than 5 years → flagged', S.mapBuildingInsights(old, { now: NOW }).measurements.manualCheckReasons.some((r) => /years old/.test(r)));
  const far = S.mapBuildingInsights(FIXTURE, { lat: 38.9995, lng: -84.6265, now: NOW }).measurements;
  ok('matched building ~90 m from the pin → flagged (findClosest may pick the neighbour)', far.buildingOffsetM > 25 && far.manualCheckReasons.some((r) => /from the pin/.test(r)), String(far.buildingOffsetM));
}

section('mapper never throws on garbage');
{
  let threw = false, r1, r2, r3;
  try {
    r1 = S.mapBuildingInsights(null);
    r2 = S.mapBuildingInsights({ solarPotential: { roofSegmentStats: 'nope' } });
    r3 = S.mapBuildingInsights({ solarPotential: { roofSegmentStats: [{ pitchDegrees: 'x', stats: {} }] } });
  } catch (e) { threw = true; }
  ok('null / malformed bodies → measurements null with a reason, no throw',
    !threw && r1.measurements === null && r2.measurements === null && r3.measurements === null && !!r2.reason);
  const wholeOnly = { imageryQuality: 'HIGH', solarPotential: { wholeRoofStats: { areaMeters2: 150 } } };
  const wm = S.mapBuildingInsights(wholeOnly, { now: NOW }).measurements;
  ok('whole-roof area only → rawSqft from wholeRoofStats, pitch null, flagged', wm && wm.rawSqft === 1615 && wm.pitch === null && wm.needsManualCheck === true);
}

// ── 4. HTTP adapter via deps.fetchImpl ──────────────────────
const jsonReply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// ── 5. fake Firestore (cache + cap) ─────────────────────────
function fakeDb() {
  const store = new Map();
  const ref = (p) => ({
    path: p,
    get: async () => ({ exists: store.has(p), data: () => clone(store.get(p)) }),
    set: async (data, opts) => { store.set(p, opts && opts.merge ? Object.assign({}, store.get(p) || {}, clone(data)) : clone(data)); },
    create: async (data) => { if (store.has(p)) { const e = new Error('exists'); e.code = 6; throw e; } store.set(p, clone(data)); }
  });
  const query = () => ({ where: () => query(), limit: () => query(), get: async () => ({ docs: [], empty: true }) });
  return {
    store,
    doc: (p) => ref(p),
    collection: (c) => Object.assign(query(), { doc: (id) => ref(c + '/' + id), add: async (d) => { const id = 'auto' + store.size; store.set(c + '/' + id, d); return { id }; } }),
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => { r.set(d, o); } })
  };
}

(async () => {
  section('requestSolar — request/response contract');
  {
    const calls = [];
    const r = await S.requestSolar({ lat: PIN.lat, lng: PIN.lng }, {
      apiKey: 'test-key', now: () => NOW,
      fetchImpl: async (url, opts) => { calls.push({ url, opts }); return jsonReply(200, FIXTURE); }
    });
    const u = calls[0] && calls[0].url || '';
    ok('GETs buildingInsights:findClosest', u.startsWith('https://solar.googleapis.com/v1/buildingInsights:findClosest?') && calls[0].opts.method === 'GET');
    ok('sends lat/lng, requiredQuality=LOW and the key server-side', /location\.latitude=38\.99870/.test(u) && /location\.longitude=-84\.62655/.test(u) && /requiredQuality=LOW/.test(u) && /key=test-key/.test(u));
    ok('asks only for the fields the mapper reads', /fields=/.test(u) && decodeURIComponent(u).includes('solarPotential.roofSegmentStats') && !decodeURIComponent(u).includes('solarPanelConfigs'));
    ok('ok result in the requestInstantRoofer shape', r.ok && r.provider === 'solar' && r.reportType === 'ai' && r.estimatedMinutes === 0 && r.jobId === 'solar-' + NOW && r.measurements.rawSqft === 2075 && r.quality === 'HIGH');
    const nk = await S.requestSolar({ lat: 1, lng: 1 }, { fetchImpl: async () => { throw new Error('must not call'); } });
    ok('no key → not configured, no network', nk.ok === false && nk.configured === false && nk.provider === 'solar');
    const r404 = await S.requestSolar({ lat: 1, lng: 1 }, { apiKey: 'k', fetchImpl: async () => jsonReply(404, { error: { code: 404 } }) });
    ok('404 → not-found with a readable message', r404.ok === false && r404.reason === 'no-building' && r404.code === 'not-found' && /no 3D roof data/.test(r404.message));
    const r403 = await S.requestSolar({ lat: 1, lng: 1 }, { apiKey: 'k', fetchImpl: async () => jsonReply(403, {}) });
    ok('403 → failed-precondition naming the key/API problem', r403.code === 'failed-precondition' && /solar\.googleapis\.com/.test(r403.message));
    const rNet = await S.requestSolar({ lat: 1, lng: 1 }, { apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    ok('network throw → reason network, never throws', rNet.ok === false && rNet.reason === 'network');
    const rEmpty = await S.requestSolar({ lat: 1, lng: 1 }, { apiKey: 'k', fetchImpl: async () => jsonReply(200, {}) });
    ok('200 with no roof → not ok (never a ready doc with nothing in it)', rEmpty.ok === false && rEmpty.code === 'not-found');
  }

  section('runSolarProvider — cache (180 days, company-scoped) + daily cap');
  {
    const db = fakeDb();
    let fetches = 0;
    const deps = (over) => Object.assign({
      mode: 'solar', apiKey: 'k', now: () => NOW, cap: 3,
      fetchImpl: async () => { fetches++; return jsonReply(200, FIXTURE); },
      instantRoofer: async () => { throw new Error('IR must not be called in solar mode'); }
    }, over || {});
    const ctxA = { lat: PIN.lat, lng: PIN.lng, uid: 'u1', companyId: 'coA', db, address: '1 Test St' };

    const r1 = await S.runSolarProvider(ctxA, deps());
    ok('first call hits the API and returns the solar result', r1.ok && r1.provider === 'solar' && fetches === 1);
    const cacheDocs = [...db.store.keys()].filter((k) => k.startsWith(T.CACHE_COLLECTION + '/'));
    ok('result cached under solar_measure_cache with its company scope', cacheDocs.length === 1 && db.store.get(cacheDocs[0]).scope === 'c_coA' && db.store.get(cacheDocs[0]).expiresAtMs === NOW + T.CACHE_TTL_MS);
    const usageKey = T.USAGE_COLLECTION + '/c_coA_2026-10-04';
    ok('daily usage counted (1)', db.store.get(usageKey) && db.store.get(usageKey).count === 1);

    const r2 = await S.runSolarProvider(Object.assign({}, ctxA, { uid: 'u2' }), deps({ now: () => NOW + 10 * 24 * 3600 * 1000 }));
    ok('same company, same roof, 10 days later → cache hit, no API call', r2.ok && r2.solarCached === true && fetches === 1 && r2.measurements.rawSqft === 2075);
    ok('a cache hit does not count against the cap', db.store.get(usageKey).count === 1);

    const r3 = await S.runSolarProvider(Object.assign({}, ctxA, { companyId: 'coB' }), deps());
    ok('another company → cache MISS (company-scoped, never shared across tenants)', r3.ok && !r3.solarCached && fetches === 2);

    const r4 = await S.runSolarProvider(ctxA, deps({ now: () => NOW + 181 * 24 * 3600 * 1000 }));
    ok('181 days later → stale, re-fetched', r4.ok && !r4.solarCached && fetches === 3);

    const capDb = fakeDb();
    let capFetches = 0, irCalls = 0;
    const capDeps = (mode) => deps({
      mode, cap: 2, fetchImpl: async () => { capFetches++; return jsonReply(200, FIXTURE); },
      instantRoofer: async () => { irCalls++; return { ok: true, provider: 'instantroofer', measurements: { rawSqft: 1 } }; }
    });
    const pt = (i) => ({ lat: 38.9 + i * 0.001, lng: -84.6, uid: 'u1', companyId: 'coCap', db: capDb });
    await S.runSolarProvider(pt(1), capDeps('solar'));
    await S.runSolarProvider(pt(2), capDeps('solar'));
    const r5 = await S.runSolarProvider(pt(3), capDeps('solar'));
    ok('3rd distinct roof with cap 2 → resource-exhausted, API not called', r5.ok === false && r5.code === 'resource-exhausted' && r5.reason === 'daily-cap' && capFetches === 2);
    const r6 = await S.runSolarProvider(pt(4), capDeps('auto'));
    ok('at the cap, auto mode does NOT escalate to the pricier Instant Roofer', r6.ok === false && r6.reason === 'daily-cap' && irCalls === 0);
    const r7 = await S.runSolarProvider(pt(1), capDeps('solar'));
    ok('a cached roof is still served at the cap', r7.ok && r7.solarCached === true);
    const r8 = await S.runSolarProvider(pt(5), capDeps('solar'));
    void r8;
    const tomorrow = await S.runSolarProvider(pt(6), Object.assign(capDeps('solar'), { now: () => NOW + 24 * 3600 * 1000 }));
    ok('the cap resets the next (UTC) day', tomorrow.ok && !tomorrow.solarCached);
    ok('default cap 40, NBD_SOLAR_DAILY_CAP overrides', T.dailyCap({}) === 40 && T.dailyCap({ NBD_SOLAR_DAILY_CAP: '7' }) === 7 && T.dailyCap({ NBD_SOLAR_DAILY_CAP: 'junk' }) === 40);
  }

  section('runSolarProvider — fallback logic');
  {
    const IR_OK = { ok: true, provider: 'instantroofer', reportType: 'ai', jobId: 'instantroofer-1', estimatedMinutes: 0, measurements: { rawSqft: 2100, pitch: '6/12' } };
    const IR_FAIL = { ok: false, provider: 'instantroofer', reason: 'network' };
    const lowBody = clone(FIXTURE); lowBody.imageryQuality = 'LOW';
    async function run(mode, solarReply, irReply, extra) {
      let irCalls = 0, fetches = 0;
      const r = await S.runSolarProvider(Object.assign({ lat: PIN.lat, lng: PIN.lng, uid: 'u1', companyId: 'co' + Math.random(), db: fakeDb() }, extra || {}), {
        mode, apiKey: (extra && extra.noKey) ? undefined : 'k', now: () => NOW, cap: 10,
        fetchImpl: async () => { fetches++; if (solarReply instanceof Error) throw solarReply; return solarReply; },
        instantRoofer: async () => { irCalls++; return irReply; }
      });
      return { r, irCalls, fetches };
    }
    let o = await run('auto', jsonReply(200, FIXTURE), IR_OK);
    ok('auto + HIGH imagery → Solar result, Instant Roofer untouched', o.r.provider === 'solar' && o.irCalls === 0);
    o = await run('auto', jsonReply(200, lowBody), IR_OK);
    ok('auto + LOW imagery → Instant Roofer, tagged fallbackFrom low-imagery-quality', o.r.provider === 'instantroofer' && o.irCalls === 1 && o.r.fallbackFrom && o.r.fallbackFrom.reason === 'low-imagery-quality');
    o = await run('auto', jsonReply(500, {}), IR_OK);
    ok('auto + Solar 500 → Instant Roofer', o.r.provider === 'instantroofer' && o.irCalls === 1 && o.r.fallbackFrom.reason === 'vendor-error');
    o = await run('auto', new Error('timeout'), IR_OK);
    ok('auto + Solar network failure → Instant Roofer', o.r.provider === 'instantroofer' && o.r.fallbackFrom.reason === 'network');
    o = await run('auto', jsonReply(404, {}), IR_OK);
    ok('auto + Solar 404 (no building) → Instant Roofer', o.r.provider === 'instantroofer' && o.r.fallbackFrom.reason === 'no-building');
    o = await run('auto', jsonReply(500, {}), IR_FAIL);
    ok('auto + both fail → the failure surfaces (no fake success)', o.r.ok === false);
    o = await run('auto', jsonReply(200, lowBody), IR_FAIL);
    ok('auto + LOW + Instant Roofer fails → the LOW Solar measure, flagged for manual check', o.r.ok && o.r.provider === 'solar' && o.r.measurements.needsManualCheck === true);
    o = await run('auto', null, IR_OK, { noKey: true });
    ok('auto + no Solar key → Instant Roofer, reason not-configured, no Solar call', o.r.provider === 'instantroofer' && o.r.fallbackFrom.reason === 'not-configured' && o.fetches === 0);
    o = await run('solar', null, IR_OK, { noKey: true });
    ok('solar + no key → configured:false (callable says "not configured")', o.r.ok === false && o.r.configured === false && o.irCalls === 0);
    o = await run('solar', jsonReply(200, lowBody), IR_OK);
    ok('solar + LOW → Solar result flagged, Instant Roofer never called', o.r.provider === 'solar' && o.r.measurements.needsManualCheck && o.irCalls === 0);
    o = await run('solar', jsonReply(500, {}), IR_OK);
    ok('solar + 500 → classified failure, no fallback', o.r.ok === false && o.r.code === 'unavailable' && o.irCalls === 0);
    o = await run('auto', jsonReply(200, FIXTURE), IR_OK, { reportType: 'human' });
    ok('human certified report → always Instant Roofer, no Solar call', o.irCalls === 1 && o.fetches === 0);
  }

  section('measurement.js provider switch (minimal diff)');
  {
    let M = null, err = null;
    try { M = require(path.join(FUNCTIONS, 'integrations', 'measurement.js')); } catch (e) { err = e; }
    ok('measurement.js still loads', !err, err && err.message);
    const shared = require(path.join(FUNCTIONS, 'integrations', '_shared.js'));
    const prev = shared.PROVIDERS.measurement;
    for (const p of ['solar', 'auto']) {
      shared.PROVIDERS.measurement = p;
      const sel = M && M._test.selectProvider();
      ok("NBD_MEASUREMENT_PROVIDER=" + p + " → a coords provider named '" + p + "'", sel && sel.name === p && sel.needsCoords === true && typeof sel.run === 'function');
    }
    shared.PROVIDERS.measurement = 'instantroofer';
    ok('instantroofer still selects Instant Roofer', M._test.selectProvider().name === 'instantroofer');
    shared.PROVIDERS.measurement = 'solr';
    ok('a typo still fails loudly (null)', M._test.selectProvider() === null);
    shared.PROVIDERS.measurement = prev;
    ok('SOLAR_API_KEY is in the SECRETS registry (deploy stub-creates it)', !!shared.SECRETS.SOLAR_API_KEY);

    const meas = codeOnly(read('functions/integrations/measurement.js'));
    ok('requestMeasurement binds SOLAR_API_KEY', /secrets:\s*\[[^\]]*SECRETS\.SOLAR_API_KEY/.test(meas));
    ok('ctx carries companyId + db for the company-scoped cache/cap', /companyId: token\.companyId \|\| null,\s*db\s*\}/.test(meas));
    ok('the Instant Roofer 5/min meter is skipped only in pure solar mode', /if \(provider\.name !== 'solar'\) await enforceRateLimit\('callable:requestMeasurement:instantroofer'/.test(meas));
    ok('a Solar AI measure is billed as a service, not a document', /result\.provider === 'solar'\) && \(result\.reportType \|\| 'ai'\) === 'ai'/.test(meas));
    ok('fallbackFrom is recorded on the doc', /fallbackFrom: result\.fallbackFrom/.test(meas));
  }

  section('availability readout lets the client button work for solar|auto');
  {
    const integ = codeOnly(read('functions/handlers/integrations.js'));
    const avail = integ.slice(integ.indexOf('exports.integrationAvailability'));
    ok('integrationAvailability reports configured.solar and configured.auto', /solar:\s*_hasInt\('SOLAR_API_KEY'\)/.test(avail) && /auto:\s*_hasInt\('SOLAR_API_KEY'\) \|\| _hasInt\('INSTANTROOFER_API_KEY'\)/.test(avail));
    ok('integrationAvailability binds SOLAR_API_KEY', /_intSecrets\.SOLAR_API_KEY/.test(avail));
    const client = codeOnly(read('docs/pro/js/integrations-client.js'));
    ok('client gates on configured[providers.measurement] (so the keys above are what it reads)', /configured\[key\]/.test(client) && /providers\?\.measurement/.test(client));
  }

  section('public /estimate web-lead measure follows the provider switch');
  {
    const shared = require(path.join(FUNCTIONS, 'integrations', '_shared.js'));
    const PM = require(path.join(FUNCTIONS, 'integrations', 'public-measure.js'));
    const prev = shared.PROVIDERS.measurement;
    const lead = { userId: 'owner1', companyId: 'coWeb', lat: PIN.lat, lng: PIN.lng, address: '1 Test St', firstName: 'A', lastName: 'B' };
    process.env.SOLAR_API_KEY = 'unit-test-key';
    let fetchedUrls = [];
    const deps = { now: () => NOW, fetchImpl: async (url) => { fetchedUrls.push(String(url)); return jsonReply(200, FIXTURE); } };
    try {
      shared.PROVIDERS.measurement = 'auto';
      const db = fakeDb();
      const out = await PM._test.measureLeadAndPublish(db, { leadId: 'L1', lead, deps });
      const job = db.store.get('measurements/weblead-L1');
      ok('auto mode measures the web lead through Solar (no Instant Roofer call)', out.ok && fetchedUrls.length === 1 && fetchedUrls[0].includes('solar.googleapis.com'), JSON.stringify(out));
      ok("the job doc records provider 'solar' and a solar external id", job && job.provider === 'solar' && job.externalJobId === 'solar-weblead-L1');
      ok('the job doc carries the satellite-estimate note', job && job.measurements.accuracyNote === 'Satellite estimate — confirm on site');
      ok('the homeowner summary uses rawSqft (no double waste): 20.8 squares', out.summary && out.summary.squares === 20.8 && out.summary.pitch === '6/12');
      shared.PROVIDERS.measurement = 'hover';
      const no = await PM._test.measureLeadAndPublish(fakeDb(), { leadId: 'L2', lead, deps });
      ok('an unsupported provider still spends nothing', no.ok === false && no.reason === 'provider-unsupported');
    } finally {
      shared.PROVIDERS.measurement = prev;
      delete process.env.SOLAR_API_KEY;
    }
  }

  section('keys never reach client code');
  {
    const hits = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.(js|html|json)$/.test(e.name)) continue;
        const t = fs.readFileSync(p, 'utf8');
        // No exceptions (2026-10-04): maps-routing.js's sun overlay, which
        // called Solar with a key pasted into localStorage, now goes through
        // the server (requestMeasurement purpose 'sun-exposure').
        const rel = path.relative(ROOT, p).replace(/\\/g, '/');
        // The one allowed mention of the old localStorage key is the line that
        // deletes it from devices that still hold one.
        const scan = t.replace(/localStorage\.removeItem\('nbd_google_solar_key'\)/g, '');
        if (/SOLAR_API_KEY|solar\.googleapis\.com|nbd_google_solar_key/.test(scan)) hits.push(rel);
      }
    })(path.join(ROOT, 'docs'));
    ok('nothing under docs/ (all of it, no allowlist) names SOLAR_API_KEY, calls solar.googleapis.com or reads a stored Solar key', hits.length === 0, hits.join(', '));
    const sm = codeOnly(read('functions/integrations/solar-measure.js'));
    ok('the adapter reads the key only through hasSecret/getSecret (stub counts as unset)', /hasSecret\('SOLAR_API_KEY'\)/.test(sm) && /getSecret\('SOLAR_API_KEY'\)/.test(sm) && !/process\.env\.SOLAR_API_KEY/.test(sm));
  }

  section('sun-exposure summary (Maps ☀️ Solar Analysis) — adapter');
  {
    const sun = S.mapSunExposure(FIXTURE);
    ok('mapSunExposure: max sunshine + one entry per plane with a centre', sun && sun.maxSunshineHoursPerYear === 1403 && sun.segments.length === FIXTURE.solarPotential.roofSegmentStats.length, JSON.stringify(sun));
    ok('per plane: centre lat/lng, area m², median sunshine (middle quantile)',
      sun && near(sun.segments[0].lat, 38.9986705, 1e-7) && near(sun.segments[0].lng, -84.6265521, 1e-7)
      && sun.segments[0].areaMeters2 === 62.4 && sun.segments[0].sunshineHoursMedian === 1346, JSON.stringify(sun && sun.segments[0]));
    ok('11 API deciles → index 5 is the median', S.mapSunExposure({ solarPotential: { roofSegmentStats: [{ center: { latitude: 1, longitude: 2 }, stats: { sunshineQuantiles: [0, 1, 2, 3, 4, 555, 6, 7, 8, 9, 10] } }] } }).segments[0].sunshineHoursMedian === 555);
    let threw = false, g1, g2;
    try { g1 = S.mapSunExposure(null); g2 = S.mapSunExposure({ solarPotential: { roofSegmentStats: [{ stats: {} }] } }); } catch (e) { threw = true; }
    ok('garbage → null, never throws', !threw && g1 === null && g2 === null);
    ok('sun summary is NOT inside measurements (never lands on measurement / lead docs)', !('sun' in m) && mapped.sun && mapped.sun.segments.length === 6);
    ok('the field mask asks for maxSunshineHoursPerYear', T.RESPONSE_FIELDS.includes('solarPotential.maxSunshineHoursPerYear') && !T.RESPONSE_FIELDS.includes('solarPanelConfigs'));

    const db = fakeDb();
    let fetches = 0;
    const deps = (over) => Object.assign({ apiKey: 'k', now: () => NOW, cap: 2, fetchImpl: async () => { fetches++; return jsonReply(200, FIXTURE); } }, over || {});
    const ctxA = { lat: PIN.lat, lng: PIN.lng, uid: 'u1', companyId: 'coSun', db };
    const s1 = await S.runSunAnalysis(ctxA, deps());
    ok('runSunAnalysis: ok with sun + imagery, not cached, one API call', s1.ok && s1.sun && s1.sun.segments.length === 6 && s1.imagery.quality === 'HIGH' && s1.cached === false && fetches === 1, JSON.stringify(s1));
    const cacheKey = [...db.store.keys()].find((k) => k.startsWith(T.CACHE_COLLECTION + '/'));
    ok('the sun summary is stored in the company-scoped cache doc', cacheKey && db.store.get(cacheKey).scope === 'c_coSun' && db.store.get(cacheKey).sun && db.store.get(cacheKey).sun.segments.length === 6);
    const s2 = await S.runSunAnalysis(Object.assign({}, ctxA, { uid: 'u2' }), deps());
    ok('same company, same roof → cache hit, no API call, no cap use', s2.ok && s2.cached === true && fetches === 1 && db.store.get(T.USAGE_COLLECTION + '/c_coSun_2026-10-04').count === 1);
    const m2 = await S.runSolarProvider(Object.assign({}, ctxA, { uid: 'u3' }), deps({ mode: 'solar' }));
    ok('a roof cached by the sun overlay is free for a roof MEASURE too (shared cache)', m2.ok && m2.solarCached === true && fetches === 1);
    // An entry cached before the sun summary was stored has none: the overlay re-fetches it once.
    const legacyDb = fakeDb();
    const legacyCtx = { lat: PIN.lat, lng: PIN.lng, uid: 'u1', companyId: 'coOld', db: legacyDb };
    await S.runSolarProvider(legacyCtx, deps({ mode: 'solar' }));
    const lk = [...legacyDb.store.keys()].find((k) => k.startsWith(T.CACHE_COLLECTION + '/'));
    const legacy = legacyDb.store.get(lk); delete legacy.sun; legacyDb.store.set(lk, legacy);
    const before = fetches;
    const s3 = await S.runSunAnalysis(legacyCtx, deps());
    ok('a cache entry without a sun summary is a miss for the overlay (re-fetched once)', s3.ok && s3.cached === false && fetches === before + 1);
    const capCtx = (i) => ({ lat: 38.9 + i * 0.001, lng: -84.6, uid: 'u1', companyId: 'coSunCap', db });
    await S.runSunAnalysis(capCtx(1), deps());
    await S.runSunAnalysis(capCtx(2), deps());
    const capped = await S.runSunAnalysis(capCtx(3), deps());
    ok('the per-company daily cap applies (cap 2 → 3rd new roof refused)', capped.ok === false && capped.reason === 'daily-cap' && capped.code === 'resource-exhausted');
    let irCalls = 0;
    const solo = await S.runSunAnalysis({ lat: PIN.lat, lng: PIN.lng, uid: 'u9', companyId: 'coX', db: fakeDb() },
      deps({ fetchImpl: async () => jsonReply(500, {}), instantRoofer: async () => { irCalls++; return { ok: true }; }, mode: 'auto' }));
    ok('Solar failure never escalates to Instant Roofer (even if a caller passes mode auto)', solo.ok === false && irCalls === 0);
    const noKey = await S.runSunAnalysis({ lat: PIN.lat, lng: PIN.lng, uid: 'u1', companyId: 'coK', db: fakeDb() }, { now: () => NOW, fetchImpl: async () => { throw new Error('must not call'); } });
    ok('no key → configured:false, no network', noKey.ok === false && noKey.configured === false);
  }

  section('requestMeasurement purpose sun-exposure — the callable (auth, viewer, company cache, cap)');
  {
    const Module = require('module');
    const origLoad = Module._load;
    const origFetch = global.fetch;
    const db = fakeDb();
    let handler = null, limits = [], fetchUrls = [];
    class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
    const realFs = {
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }), now: () => ({ toMillis: () => Date.now() }) },
      FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }), increment: (n) => ({ __fv: 'inc', n }) }
    };
    Module._load = function (request, parent, isMain) {
      if (request === 'firebase-functions/v2/https') {
        return { onCall: (o, h) => { if (o && o.secrets && !handler && h) handler = { opts: o, fn: h }; return { __handler: h }; }, onRequest: () => ({}), HttpsError };
      }
      if (request === 'firebase-admin/firestore') {
        return { getFirestore: () => db, Timestamp: realFs.Timestamp, FieldValue: realFs.FieldValue };
      }
      if (request === './upstash-ratelimit') {
        return { enforceRateLimit: async (ns, key) => { limits.push(ns + '|' + key); return { count: 1 }; } };
      }
      return origLoad.apply(this, arguments);
    };
    const measPath = require.resolve(path.join(FUNCTIONS, 'integrations', 'measurement.js'));
    const savedMeas = require.cache[measPath];
    delete require.cache[measPath];
    process.env.SOLAR_API_KEY = 'unit-test-key';
    process.env.NBD_SOLAR_DAILY_CAP = '2';
    global.fetch = async (url) => { fetchUrls.push(String(url)); return jsonReply(200, FIXTURE); };
    const call = async (auth, data) => {
      try { return { res: await handler.fn({ auth, data }) }; } catch (e) { return { err: e }; }
    };
    const rep = (uid, companyId, role) => ({ uid, token: Object.assign({ companyId }, role ? { role } : {}) });
    const sunData = (i) => ({ purpose: 'sun-exposure', lat: PIN.lat + (i || 0) * 0.001, lng: PIN.lng });
    try {
      require(measPath);
      ok('requestMeasurement captured with SOLAR_API_KEY bound + App Check', handler && handler.opts.enforceAppCheck === true && handler.opts.secrets.some((s) => s && s.name === 'SOLAR_API_KEY'));

      let o = await call(null, sunData());
      ok('signed out → unauthenticated, no Solar call', o.err && o.err.code === 'unauthenticated' && fetchUrls.length === 0);
      o = await call(rep('v1', 'coA', 'viewer'), sunData());
      ok('viewer → permission-denied (paid call), no Solar call', o.err && o.err.code === 'permission-denied' && fetchUrls.length === 0);
      o = await call(rep('u1', 'coA'), { purpose: 'sun-exposure', lat: 'x', lng: 1 });
      ok('bad coordinates → invalid-argument, no Solar call', o.err && o.err.code === 'invalid-argument' && fetchUrls.length === 0);

      o = await call(rep('u1', 'coA'), Object.assign(sunData(), { address: '1 Test St' }));
      ok('rep → sun data for the roof (server fetched it)', o.res && o.res.ok && o.res.sun && o.res.sun.segments.length === 6 && o.res.cached === false && fetchUrls.length === 1, JSON.stringify(o.err || o.res));
      ok('the key is used server-side and never returned to the client', fetchUrls[0].includes('key=unit-test-key') && !JSON.stringify(o.res).includes('unit-test-key'));
      ok('the per-uid limiter ran', limits.some((l) => l.startsWith('callable:requestMeasurement:uid|u1')));
      ok('no measurement or lead doc written (overlay only)', ![...db.store.keys()].some((k) => k.startsWith('measurements/') || k.startsWith('leads/')));
      o = await call(rep('u2', 'coA'), sunData());
      ok('a colleague in the SAME company → cache hit, no second Solar call', o.res && o.res.cached === true && fetchUrls.length === 1);
      o = await call(rep('u3', 'coB'), sunData());
      ok('ANOTHER company, same roof → its own fetch (cache is company-scoped)', o.res && o.res.cached === false && fetchUrls.length === 2);
      o = await call(rep('u1', 'coA'), sunData(1));
      ok('coA second new roof → allowed (cap 2)', o.res && o.res.ok && fetchUrls.length === 3);
      o = await call(rep('u1', 'coA'), sunData(2));
      ok('coA third new roof → resource-exhausted at the daily cap, no Solar call', o.err && o.err.code === 'resource-exhausted' && fetchUrls.length === 3, o.err && o.err.message);
      o = await call(rep('u2', 'coA'), sunData());
      ok('a cached roof still works at the cap', o.res && o.res.cached === true);
      delete process.env.SOLAR_API_KEY;
      o = await call(rep('u1', 'coC'), sunData(5));
      ok('no SOLAR_API_KEY → failed-precondition, no Solar call', o.err && o.err.code === 'failed-precondition' && fetchUrls.length === 3);
    } catch (e) {
      ok('callable section ran', false, e && e.stack);
    } finally {
      Module._load = origLoad;
      global.fetch = origFetch;
      delete process.env.SOLAR_API_KEY;
      delete process.env.NBD_SOLAR_DAILY_CAP;
      if (savedMeas) require.cache[measPath] = savedMeas; else delete require.cache[measPath];
    }
  }

  section('Maps ☀️ Solar Analysis client — server call, no key on the device');
  {
    const vm = require('vm');
    const src = read('docs/pro/js/maps-routing.js').replace(/\r\n/g, '\n');
    const start = src.indexOf("try { localStorage.removeItem('nbd_google_solar_key'); }");
    const end = src.indexOf('function renderSolarEstimate(');
    const endEst = src.indexOf('\n}\n', src.indexOf('function renderSolarEstimate(')) + 3;
    ok('client block found', start > 0 && end > start && endEst > end);
    const block = src.slice(start, endEst);
    ok('no client fetch, no stored-key read, no key prompt',
      !/\bfetch\s*\(/.test(codeOnly(block)) && !/getItem\(\s*'nbd_google_solar_key'/.test(block) && !/API key/i.test(codeOnly(block)));
    const toasts = [], storage = { removed: [], got: [] }, calls = [], circles = [];
    const layer = () => ({ addTo: () => layer(), bindPopup: () => ({ addTo: () => { circles.push(1); } }) });
    const sandbox = {
      console: { warn: () => {}, error: () => {}, log: () => {} },
      localStorage: { removeItem: (k) => storage.removed.push(k), getItem: (k) => { storage.got.push(k); return 'AIzaLEAKEDKEY'; } },
      showToast: (m, k) => toasts.push([k, m]),
      fetch: () => { throw new Error('client fetch'); },
      document: { getElementById: () => ({ value: '1 Test St' }) },
      drawMap: { getCenter: () => ({ lat: PIN.lat, lng: PIN.lng }), removeLayer: () => {} },
      L: { layerGroup: () => ({ addTo: () => {} }), circle: () => ({ bindPopup: () => ({ addTo: () => { circles.push(1); } }), addTo: () => {} }), marker: () => ({ addTo: () => {} }), divIcon: (o) => o, polyline: () => ({ addTo: () => {} }) },
      window: {}
    };
    sandbox.window._functions = {};
    sandbox.window._httpsCallable = (fns, name) => async (payload) => {
      calls.push({ name, payload });
      return { data: { ok: true, cached: false, sun: S.mapSunExposure(FIXTURE), imagery: { quality: 'HIGH' } } };
    };
    vm.createContext(sandbox);
    try {
      vm.runInContext(block + '\nthis.runSolarAnalysis = runSolarAnalysis;', sandbox);
      ok('loading the module deletes any stored Solar key', storage.removed.includes('nbd_google_solar_key'));
      await sandbox.runSolarAnalysis();
      ok("calls requestMeasurement with purpose 'sun-exposure' + the map centre", calls.length === 1 && calls[0].name === 'requestMeasurement'
        && calls[0].payload.purpose === 'sun-exposure' && calls[0].payload.lat === PIN.lat && calls[0].payload.lng === PIN.lng, JSON.stringify(calls));
      ok('draws one circle per roof plane from the server summary', circles.length === 6, String(circles.length));
      ok('success toast with max sun hours; never reads localStorage', toasts.some(([k, t]) => k === 'success' && /1403 hours\/year/.test(t)) && storage.got.length === 0, JSON.stringify(toasts));
      // Server refusal (e.g. daily cap) → latitude estimate, no key prompt.
      sandbox.window._httpsCallable = () => async () => { const e = new Error('Daily satellite-measure limit reached'); e.code = 'functions/resource-exhausted'; throw e; };
      toasts.length = 0;
      await sandbox.runSolarAnalysis();
      ok('server error → estimate shown with the reason, no key prompt', toasts.some(([k, t]) => k === 'warning' && /limit reached/.test(t) && !/key/i.test(t)), JSON.stringify(toasts));
    } catch (e) {
      ok('client block runs in a sandbox', false, e && e.stack);
    }
  }

  section('harness');
  {
    const h = read('scripts/measure-compare.js');
    ok('scripts/measure-compare.js exists and refuses to run without --live', /--live/.test(h) && /requestSolar/.test(h) && /requestInstantRoofer/.test(h));
  }

  finish();
})().catch((e) => { ok('async sections ran without throwing', false, e && e.stack); finish(); });

function finish() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
}
