/**
 * tests/wind-gust-2026-10-06.test.js — "Wind measured nearby" on storm reports.
 *
 * Jo's decisions (2026-10-06): the nearest ASOS station's strongest measured
 * gust (IEM, public domain, keyless) shows on the public /storm-report, the
 * storm-report follow-up email and the CRM Storm Proof — nearest station only,
 * named with code and distance; HIDDEN when that station has no reading (an
 * outage and a calm day both hide; never 0, never a "no reading" sentence);
 * only station + date go to IEM; cached per station+date (past days final,
 * today never final); fail-closed; OH/KY wording guardrail.
 *
 * Covers: haversine nearest pick, knots→mph, max-gust parse incl. 'M',
 * hide-on-missing, cache behaviour, privacy of the IEM request, wording guard
 * (comment-stripped), and escaped rendering on page / email / CRM card.
 *
 * Run: node tests/wind-gust-2026-10-06.test.js   (needs functions/ deps)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; fails.push(label); console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}
// Comments out, so wording/privacy pins read only what ships.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');
}

const L = require('../functions/asos-gust-logic');
const G = require('../functions/integrations/asos-gust');

const XSS = '<img src=x onerror=alert(1)>';

function memDb(seed) {
  const mem = Object.assign({}, seed || {});
  const writes = [];
  return {
    mem, writes,
    doc(p) {
      return {
        get: async () => ({ exists: Object.prototype.hasOwnProperty.call(mem, p), data: () => mem[p] }),
        set: async (v) => { writes.push(p); mem[p] = v; },
      };
    },
  };
}
function csvRes(body, status) {
  return { ok: (status || 200) < 400, status: status || 200, text: async () => body };
}
const CSV_HEAD = 'station,valid,gust,peak_wind_gust\n';
const CSV_LUK_0516 = CSV_HEAD +
  'LUK,2026-05-16 09:45,30.00,M\n' +
  'LUK,2026-05-16 20:25,38.00,M\n' +
  'LUK,2026-05-16 20:53,27.00,39.00\n' +
  'LUK,2026-05-16 23:55,M,M\n';
const CSV_ALL_M = CSV_HEAD + 'LUK,2026-05-16 00:00,M,M\nLUK,2026-05-16 00:05,M,M\n';

// Mt Washington, Cincinnati — 2 mi from Lunken (LUK).
const MTW = [39.087, -84.39];

(async function main() {
  // ── 1. Station list + nearest-station pick (haversine) ─────────────────
  console.log('\nSTATIONS + NEAREST PICK');
  {
    const S = L.STATIONS;
    ok('committed station list has 26 active stations', S.length === 26, String(S.length));
    ok('every station has id, name, numeric lat/lng', S.every((s) => /^[A-Z0-9]{3}$/.test(s.id) && s.name && isFinite(s.lat) && isFinite(s.lng)));
    ok('station ids are unique', new Set(S.map((s) => s.id)).size === S.length);
    ok('LUK, CVG, LEX present with IEM coordinates',
      ['LUK', 'CVG', 'LEX'].every((id) => S.some((s) => s.id === id)) &&
      S.find((s) => s.id === 'LUK').lat === 39.1033 && S.find((s) => s.id === 'LUK').lng === -84.4186);
    const d = L.haversineMi(39.0431, -84.6717, 39.1033, -84.4186); // CVG ↔ LUK
    ok('haversine CVG↔LUK ≈ 14.1 mi (got ' + d.toFixed(2) + ')', d > 13.9 && d < 14.3);
    ok('haversine is 0 for the same point', L.haversineMi(39, -84, 39, -84) === 0);
    const a = L.nearestStation(MTW[0], MTW[1]);
    ok('Mt Washington → LUK (nearest), ~2 mi', a && a.id === 'LUK' && a.distanceMi > 1.5 && a.distanceMi < 2.5, JSON.stringify(a));
    const b = L.nearestStation(39.233, -84.161);
    ok('Goshen → Batavia I69 (~11 mi), not LUK', b && b.id === 'I69' && Math.round(b.distanceMi) === 11, JSON.stringify(b));
    const c = L.nearestStation(38.999, -84.627);
    ok('Florence KY → CVG', c && c.id === 'CVG');
    ok('a point far from every station → null (hide)', L.nearestStation(41.88, -87.63) === null);
    ok('beyond MAX_STATION_MI → null', L.nearestStation(MTW[0], MTW[1], [{ id: 'ZZZ', name: 'z', lat: 41, lng: -84 }]) === null);
    ok('invalid / missing coordinates → null', L.nearestStation(null, -84) === null && L.nearestStation('x', 'y') === null && L.nearestStation(undefined, undefined) === null);
    // picks the minimum, not the first in the list
    const two = [{ id: 'FAR', name: 'far', lat: 39.4, lng: -84.39 }, { id: 'NER', name: 'near', lat: 39.09, lng: -84.39 }];
    ok('picks the minimum distance, not list order', L.nearestStation(MTW[0], MTW[1], two).id === 'NER');
  }

  // ── 2. knots → mph ─────────────────────────────────────────────────────
  console.log('\nKNOTS → MPH');
  ok('39 kt → 45 mph (×1.15078, nearest)', L.knotsToMph(39) === 45);
  ok('30 kt → 35 mph', L.knotsToMph(30) === 35);
  ok('50 kt → 58 mph', L.knotsToMph(50) === 58);
  ok('numeric string "39.00" → 45', L.knotsToMph('39.00') === 45);
  ok('0 kt → null (never show 0)', L.knotsToMph(0) === null);
  ok("'M' / '' / null / NaN / negative → null", [ 'M', '', null, undefined, NaN, -5, 'abc' ].every((v) => L.knotsToMph(v) === null));

  // ── 3. max-gust parse incl. 'M' missing values ───────────────────────────
  console.log('\nPARSE MAX GUST');
  ok('max across gust AND peak_wind_gust (PK WND 39 > gust 38)', L.parseMaxGustKnots(CSV_LUK_0516) === 39);
  ok('gust column alone counts', L.parseMaxGustKnots(CSV_HEAD + 'X,t,33.00,M\n') === 33);
  ok('peak_wind_gust column alone counts', L.parseMaxGustKnots(CSV_HEAD + 'X,t,M,41.00\n') === 41);
  ok("every value 'M' (station outage / calm) → null, not 0", L.parseMaxGustKnots(CSV_ALL_M) === null);
  ok('header only (no data rows) → null', L.parseMaxGustKnots(CSV_HEAD) === null);
  ok('empty / non-string body → null', L.parseMaxGustKnots('') === null && L.parseMaxGustKnots(null) === null);
  ok('HTML/JSON error body → null', L.parseMaxGustKnots('<html><body>Error</body></html>') === null && L.parseMaxGustKnots('[{"msg":"bad"}]\nx') === null);
  ok('zero gust value is not a reading', L.parseMaxGustKnots(CSV_HEAD + 'X,t,0.00,0\n') === null);
  ok('CRLF line endings parse', L.parseMaxGustKnots(CSV_LUK_0516.replace(/\n/g, '\r\n')) === 39);
  ok('column order is read from the header', L.parseMaxGustKnots('station,valid,peak_wind_gust,gust\nX,t,M,44.00\n') === 44);

  // ── 4. dates, top storm days ───────────────────────────────────────────
  console.log('\nDATES + TOP STORM DAYS');
  ok('8:25 pm EDT storm (00:25Z next day) is the local date', L.localDate('2026-05-17T00:25:00Z') === '2026-05-16');
  ok('winter EST offset handled', L.localDate('2026-01-10T04:30:00Z') === '2026-01-09' && L.localDate('2026-01-10T05:30:00Z') === '2026-01-10');
  ok('bad time → empty string', L.localDate('nope') === '' && L.localDate('') === '');
  {
    const ev = [
      { date: '2026-08-01T18:00:00Z', type: 'wind', magnitude: 40 },
      { date: '2026-05-17T00:25:00Z', type: 'hail', magnitude: 1.25 },
      { date: '2025-06-01T18:00:00Z', type: 'tornado', magnitude: null },
      { date: '2026-09-01T18:00:00Z', type: 'hail', magnitude: 0.75 },
      { date: '2026-09-01T19:00:00Z', type: 'wind', magnitude: 30 },
    ];
    const top = L.pickTopStormDays(ev, 3);
    ok('top days: tornado, then ≥1" hail, then newest minor', JSON.stringify(top) === JSON.stringify(['2025-06-01', '2026-05-16', '2026-09-01']), JSON.stringify(top));
    ok('one entry per day (no duplicates)', L.pickTopStormDays(ev, 10).length === 4);
    ok('empty / garbage events → []', L.pickTopStormDays([], 3).length === 0 && L.pickTopStormDays(null, 3).length === 0);
  }

  // ── 5. wording + hide rules on the line itself ─────────────────────────
  console.log('\nLINE WORDING');
  {
    const line = L.gustLine({ stationId: 'LUK', stationName: 'Lunken Airport', distanceMi: 6.2, gustMph: 45, date: '2026-05-16' });
    ok("Jo's template, exactly", line === 'The strongest gust measured at Lunken Airport (LUK), 6 mi from your address, was 45 mph on May 16, 2026.', line);
    ok('gustMph 0 / null / NaN → empty line (hide)', ['', 0, null, NaN, -3].every((m) => L.gustLine({ stationId: 'LUK', stationName: 'x', distanceMi: 2, gustMph: m, date: '2026-05-16' }) === ''));
    ok('missing station or bad date → empty line', L.gustLine({ stationName: 'x', distanceMi: 2, gustMph: 40, date: '2026-05-16' }) === '' && L.gustLine({ stationId: 'LUK', stationName: 'x', distanceMi: 2, gustMph: 40, date: 'May 16' }) === '');
    ok('sub-mile distance reads "1 mi", never "0 mi"', /, 1 mi from/.test(L.gustLine({ stationId: 'LUK', stationName: 'x', distanceMi: 0.3, gustMph: 40, date: '2026-05-16' })));
    ok("credit line is Jo's text", L.GUST_SOURCE_LINE === 'NOAA/NWS weather-station observations via the Iowa Environmental Mesonet (Iowa State University).');
    ok('context line keeps "Only an inspection can show" + "up to your insurer"', /Only an inspection can show/.test(L.GUST_CONTEXT_LINE) && /up to your insurer/.test(L.GUST_CONTEXT_LINE));
  }

  // ── 6. privacy: only station + date reach IEM ──────────────────────────
  console.log('\nPRIVACY (IEM request)');
  {
    const u = L.buildAsosUrl('LUK', '2026-05-16');
    const q = new URL(u).searchParams;
    ok('request is the IEM asos.py service', u.startsWith('https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?'));
    ok('station + local-day window only', q.get('station') === 'LUK' && q.get('year1') === '2026' && q.get('month1') === '5' && q.get('day1') === '16' && q.get('day2') === '17' && q.get('tz') === 'America/New_York');
    const allowed = new Set(['station', 'data', 'year1', 'month1', 'day1', 'year2', 'month2', 'day2', 'tz', 'format', 'latlon', 'missing']);
    ok('no other query keys (no lat/lon/address)', [...q.keys()].every((k) => allowed.has(k)), [...q.keys()].join(','));
    ok('month rollover (May 31 → Jun 1)', new URL(L.buildAsosUrl('CVG', '2026-05-31')).searchParams.get('month2') === '6');
    let threw = 0;
    for (const bad of [['LUK; DROP', '2026-05-16'], ['LUK', '2026-5-16'], ['', '2026-05-16'], ['LUK', '39.08,-84.39']]) { try { L.buildAsosUrl(bad[0], bad[1]); } catch (e) { threw++; } }
    ok('rejects anything that is not a station code + YYYY-MM-DD', threw === 4);
    const seen = [];
    G._resetPoliteForTests();
    await G.gustForAddressDay(MTW[0], MTW[1], '2026-05-16', { db: memDb(), fetchImpl: async (url) => { seen.push(url); return csvRes(CSV_LUK_0516); } });
    ok('the live call carries no homeowner coordinates', seen.length === 1 && !/39\.08|84\.39|[?&](lat|lon|lng)=/.test(seen[0]), seen[0]);
    const signatureArgs = L.buildAsosUrl.length;
    ok('buildAsosUrl takes exactly (station, date)', signatureArgs === 2);
  }

  // ── 7. hide-on-missing + fail-closed ───────────────────────────────────
  console.log('\nHIDE ON MISSING / FAIL-CLOSED');
  {
    const run = async (fetchImpl, extra) => { G._resetPoliteForTests(); return G.gustForAddressDay(MTW[0], MTW[1], '2026-05-16', Object.assign({ db: memDb(), fetchImpl }, extra || {})); };
    const good = await run(async () => csvRes(CSV_LUK_0516));
    ok('reading present → line with station, code, distance, mph, date',
      good && good.stationId === 'LUK' && good.gustMph === 45 && good.line === 'The strongest gust measured at Lunken Airport (LUK), 2 mi from your address, was 45 mph on May 16, 2026.', good && good.line);
    ok("station outage (all 'M') → null", (await run(async () => csvRes(CSV_ALL_M))) === null);
    ok('calm day (header only, no gust rows) → null', (await run(async () => csvRes(CSV_HEAD))) === null);
    ok('HTTP 500 → null', (await run(async () => csvRes('oops', 500))) === null);
    ok('HTTP 429 (IEM rate limit) → null', (await run(async () => csvRes('slow down', 429))) === null);
    ok('network error → null (never throws)', (await run(async () => { throw new Error('ECONNRESET'); })) === null);
    ok('timeout (AbortError) → null', (await run(async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; })) === null);
    // nearest only: the nearest station (LUK) is empty — no fallback to CVG
    const asked = [];
    const nofb = await run(async (url) => { asked.push(new URL(url).searchParams.get('station')); return csvRes(url.includes('station=LUK') ? CSV_ALL_M : CSV_LUK_0516); });
    ok('nearest station empty → hidden, no fallback to a farther station', nofb === null && asked.join(',') === 'LUK', asked.join(','));
    ok('no nearby station → null without any request', (G._resetPoliteForTests(), await G.gustForAddressDay(41.88, -87.63, '2026-05-16', { db: memDb(), fetchImpl: async () => { throw new Error('must not fetch'); } }) === null));
    ok('bad date → null without any request', (await G.gustForAddressDay(MTW[0], MTW[1], '05/16/2026', { db: memDb(), fetchImpl: async () => { throw new Error('must not fetch'); } })) === null);
    // gustsForTopStormDays stops after the first failure
    let calls = 0;
    G._resetPoliteForTests();
    const ev = [{ date: '2026-05-17T00:25:00Z', type: 'hail', magnitude: 1.5 }, { date: '2026-04-01T18:00:00Z', type: 'hail', magnitude: 1.2 }, { date: '2026-03-01T18:00:00Z', type: 'hail', magnitude: 1.1 }];
    const list = await G.gustsForTopStormDays(MTW[0], MTW[1], ev, { db: memDb(), fetchImpl: async () => { calls++; throw new Error('IEM down'); } });
    ok('IEM down → [] after ONE request (no hammering)', list.length === 0 && calls === 1, 'calls=' + calls);
    calls = 0;
    G._resetPoliteForTests();
    const list2 = await G.gustsForTopStormDays(MTW[0], MTW[1], ev, { db: memDb(), fetchImpl: async (u) => { calls++; return csvRes(u.includes('day1=16') ? CSV_LUK_0516 : CSV_ALL_M); } });
    ok('top days: only days with a reading get a line', list2.length === 1 && list2[0].date === '2026-05-16' && calls === 3, JSON.stringify(list2.map((x) => x.date)) + ' calls=' + calls);
  }

  // ── 8. cache behaviour ─────────────────────────────────────────────────
  console.log('\nCACHE');
  {
    const NOW = Date.parse('2026-10-06T16:00:00Z'); // noon EDT, Oct 6
    let calls = 0;
    const f = async () => { calls++; return csvRes(CSV_LUK_0516); };
    const db = memDb();
    G._resetPoliteForTests();
    await G.gustForAddressDay(MTW[0], MTW[1], '2026-05-16', { db, fetchImpl: f, now: () => NOW });
    const past = db.mem['public_cache/gust_LUK_20260516'];
    ok('past day cached under public_cache/gust_{STATION}_{YYYYMMDD}', !!past && past.stationId === 'LUK' && past.gustKnots === 39);
    ok('past day cached FINAL', past && past.final === true);
    await G.gustForAddressDay(MTW[0], MTW[1], '2026-05-16', { db, fetchImpl: f, now: () => NOW + 400 * 86400000 });
    ok('final entry never expires (400 days later: no refetch)', calls === 1, 'calls=' + calls);
    ok('neighbour shares the station+date entry (no refetch)', (await G.gustForAddressDay(39.10, -84.40, '2026-05-16', { db, fetchImpl: f, now: () => NOW })) && calls === 1);

    // today — never final
    calls = 0;
    const db2 = memDb();
    G._resetPoliteForTests();
    await G.gustForAddressDay(MTW[0], MTW[1], '2026-10-06', { db: db2, fetchImpl: f, now: () => NOW });
    const today = db2.mem['public_cache/gust_LUK_20261006'];
    ok("today's date cached NON-final", today && today.final === false);
    await G.gustForAddressDay(MTW[0], MTW[1], '2026-10-06', { db: db2, fetchImpl: f, now: () => NOW + 10 * 60000 });
    ok('non-final reused inside its 30-min TTL', calls === 1);
    await G.gustForAddressDay(MTW[0], MTW[1], '2026-10-06', { db: db2, fetchImpl: f, now: () => NOW + 31 * 60000 });
    ok('non-final refetched after the TTL', calls === 2, 'calls=' + calls);
    ok('yesterday, ended < 3 h ago, is not final yet', L.isFinalDay('2026-10-05', Date.parse('2026-10-06T05:00:00Z')) === false);
    ok('yesterday, ended ≥ 3 h ago, is final', L.isFinalDay('2026-10-05', Date.parse('2026-10-06T07:30:00Z')) === true);
    ok('a future date is never final', L.isFinalDay('2026-12-25', NOW) === false);

    // "no reading" is cached too (a past outage does not change) but still hides
    calls = 0;
    const db3 = memDb();
    const fm = async () => { calls++; return csvRes(CSV_ALL_M); };
    G._resetPoliteForTests();
    const r1 = await G.gustForAddressDay(MTW[0], MTW[1], '2026-05-16', { db: db3, fetchImpl: fm, now: () => NOW });
    const r2 = await G.gustForAddressDay(MTW[0], MTW[1], '2026-05-16', { db: db3, fetchImpl: fm, now: () => NOW });
    ok('past "no reading" cached as gustKnots:null (not 0) and still hidden', r1 === null && r2 === null && calls === 1 && db3.mem['public_cache/gust_LUK_20260516'].gustKnots === null);

    // errors are never cached
    const db4 = memDb();
    G._resetPoliteForTests();
    await G.gustForAddressDay(MTW[0], MTW[1], '2026-05-16', { db: db4, fetchImpl: async () => csvRes('x', 503), now: () => NOW });
    ok('an IEM error writes nothing to the cache', db4.writes.length === 0);

    // cache read failure → still answers from IEM; write failure → still answers
    const brokenDb = { doc: () => ({ get: async () => { throw new Error('firestore down'); }, set: async () => { throw new Error('firestore down'); } }) };
    G._resetPoliteForTests();
    const viaBroken = await G.gustForAddressDay(MTW[0], MTW[1], '2026-05-16', { db: brokenDb, fetchImpl: async () => csvRes(CSV_LUK_0516), now: () => NOW });
    ok('Firestore down → still answers from IEM (cache is best-effort)', viaBroken && viaBroken.gustMph === 45);
    ok('a stale-shaped cache doc (no final, no fetchedAt) is refetched', L.cacheFresh({ gustKnots: 39 }, NOW) === false);
    ok('cacheKey shape', L.cacheKey('LUK', '2026-05-16') === 'gust_LUK_20260516');
  }

  // ── 9. polite: requests serialised with a gap ──────────────────────────
  console.log('\nPOLITE RATE LIMIT');
  {
    G._resetPoliteForTests();
    const stamps = [];
    const f = async () => { stamps.push(Date.now()); return csvRes(CSV_ALL_M); };
    await Promise.all(['2026-05-14', '2026-05-15', '2026-05-16'].map((d) => G.fetchStationDayKnots('LUK', d, { fetchImpl: f })));
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
    ok('concurrent lookups are serialised ≥ ' + G.MIN_GAP_MS + ' ms apart (gaps ' + gaps.join(',') + ')', stamps.length === 3 && gaps.every((g) => g >= G.MIN_GAP_MS - 5));
    ok('per-request timeout is set (≤ 8 s)', G.FETCH_TIMEOUT_MS > 0 && G.FETCH_TIMEOUT_MS <= 8000);
  }

  // ── 10. wording guard over the shipped strings (comment-stripped) ───────
  console.log('\nWORDING GUARD');
  const BANNED = [
    [/hit (your|the) (street|house|home|roof|property|neighbou?rhood)/i, '"hit your street/house"'],
    [/your roof (qualifies|is eligible)/i, '"your roof qualifies"'],
    [/claimable/i, '"claimable"'],
    [/claim will (pay|be (approved|paid))/i, '"your claim will pay"'],
    [/enough to (damage|cause|tear|lift)/i, '"enough to damage"'],
    [/\b\d+\s*mph\b[^.]{0,60}\b(damage[sd]?|qualif\w*|coverage|covered)\b/i, 'a speed tied to damage/coverage'],
    [/\b(damage[sd]?|qualif\w*|coverage|covered)\b[^.]{0,60}\b\d+\s*mph\b/i, 'damage/coverage tied to a speed'],
  ];
  function bannedHits(text) { return BANNED.filter(([re]) => re.test(text)).map(([, n]) => n); }
  // Prove the guard can fail.
  ok('guard is live: "wind hit your street" trips it', bannedHits('That wind hit your street.').length === 1);
  ok('guard is live: "60 mph is enough to damage shingles" trips it', bannedHits('60 mph is enough to damage shingles').length >= 1);
  ok('guard is live: "your roof qualifies" / "claimable" trip it', bannedHits('Your roof qualifies — claimable.').length === 2);
  ok('guard is live: "damage starts at 58 mph" trips it', bannedHits('Shingle damage starts at 58 mph').length >= 1);
  {
    const sample = L.gustLine({ stationId: 'LUK', stationName: 'Lunken Airport', distanceMi: 6, gustMph: 45, date: '2026-05-16' });
    const shipped = [sample, L.GUST_SOURCE_LINE, L.GUST_CONTEXT_LINE].join('\n');
    ok('line + credit + context pass the guard', bannedHits(shipped).length === 0, bannedHits(shipped).join(','));
    // The gust code that ships (comments stripped): new modules whole, plus the
    // gust blocks in the page / email / CRM files.
    const between = (src, a, b) => { const i = src.indexOf(a); const j = src.indexOf(b, i + 1); return i >= 0 && j > i ? src.slice(i, j) : ''; };
    const page = stripComments(read('docs/assets/js/storm-report-page.js'));
    const email = stripComments(read('functions/storm-report-email.js'));
    const crm = stripComments(read('docs/pro/js/storm-integration.js'));
    const html = read('docs/storm-report.html').replace(/<!--[\s\S]*?-->/g, ' ');
    const blocks = {
      'asos-gust-logic.js': stripComments(read('functions/asos-gust-logic.js')),
      'integrations/asos-gust.js': stripComments(read('functions/integrations/asos-gust.js')),
      'page renderGusts': between(page, 'function renderGusts', 'function stat('),
      'email gustBlock': between(email, 'const gustBlock', 'return `<!DOCTYPE'),
      'email gustForLead': between(email, 'async function gustForLead', 'exports.stormReportEmail'),
      'CRM renderStormProofWind': between(crm, 'var WIND_CONTEXT', 'window.__NBD_CALL_REGISTRY ='),
      'page markup': between(html, 'id="sr-rep-gusts"', '<a class="sr-cta'),
    };
    for (const [name, text] of Object.entries(blocks)) {
      ok(name + ': located for scanning', text.length > 40, String(text.length));
      const hits = bannedHits(text);
      ok(name + ': no banned phrasing', hits.length === 0, hits.join(','));
    }
    ok('CRM note keeps the inspection + insurer lines', /Only an inspection can show/.test(blocks['CRM renderStormProofWind']) && /up to the insurer/.test(blocks['CRM renderStormProofWind']));
    ok('page markup: context note sits directly after the readings list',
      /id="sr-rep-gust-list"><\/ul>\s*<div class="sr-gust-note"/.test(blocks['page markup']));
    ok('page: the bottom disclaimer keeps "up to your insurer"', /Whether a claim is approved is up to your insurer/.test(html));
    ok('the retired working title is gone from shipped gust code', !Object.values(blocks).some((t) => /hit your street/i.test(t)));
  }

  // ── 11. render: public page (vm, escaped via textContent) ──────────────
  console.log('\nRENDER — public /storm-report');
  async function runPage(report) {
    const els = {};
    function el(id) {
      if (!els[id]) {
        const kids = [];
        els[id] = {
          id, value: '', checked: true, hidden: false, disabled: false, style: {}, dataset: {}, _kids: kids, _html: null,
          classList: { add() {}, remove() {} },
          set textContent(v) { this._text = String(v); if (this._text === '') kids.length = 0; },
          get textContent() { return this._text || ''; },
          set innerHTML(v) { this._html = String(v); },
          get innerHTML() { return this._html || ''; },
          appendChild(c) { kids.push(c); return c; },
          addEventListener() {},
          get childElementCount() { return 0; },
        };
      }
      return els[id];
    }
    let clickHandler = null;
    const created = [];
    const doc = {
      readyState: 'complete',
      getElementById: (id) => (/^(lf-css|lf-js|sr-map)$/.test(id) ? null : el(id)),
      querySelectorAll: () => [],
      addEventListener(t, fn) { if (t === 'click') clickHandler = fn; },
      createElement(tag) { const o = { tagName: tag, style: {}, set textContent(v) { this._text = String(v); }, get textContent() { return this._text || ''; }, set innerHTML(v) { this._html = String(v); } }; created.push(o); return o; },
      head: { appendChild() {} },
    };
    let posted = null;
    const win = {
      __NBD_STORM_API: '/api/storm-report',
      scrollTo() {},
      submitPublicLead: (kind, payload) => { posted = { kind, payload }; return Promise.resolve({ ok: true }); },
    };
    win.window = win;
    const sandbox = {
      window: win, document: doc, console,
      fetch: async () => ({ json: async () => report }),
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    };
    vm.runInNewContext(read('docs/assets/js/storm-report-page.js'), sandbox, { filename: 'storm-report-page.js' });
    const click = (target) => clickHandler({ target: { closest: (sel) => target(sel) } });
    win._srAc = [{ display_name: '123 Main St, Cincinnati, OH', lat: '39.087', lon: '-84.39' }];
    click((sel) => (sel.indexOf('sr-ac-item') >= 0 ? { dataset: { idx: '0' } } : null));
    click((sel) => (sel === '[data-action]' ? { dataset: { action: 'generate' } } : null));
    await new Promise((r) => setTimeout(r, 10));
    el('sr-firstName').value = 'Pat'; el('sr-phone').value = '(513) 555-0101'; el('sr-email').value = '';
    click((sel) => (sel === '[data-action]' ? { dataset: { action: 'unlock' } } : null));
    await new Promise((r) => setTimeout(r, 10));
    return { els, el, posted, created };
  }
  {
    const base = { counts: { total: 1, hail: 1, wind: 0, tornado: 0, stormDays: 1 }, events: [{ date: '2026-05-17T00:25:00Z', type: 'hail', magnitude: 1.25, unit: 'in', distanceMi: 2, severity: 'significant' }], years: 5, radiusMi: 30, source: 'NWS' };
    const withG = Object.assign({}, base, {
      windGusts: [
        { date: '2026-05-16', stationId: 'LUK', stationName: 'Lunken Airport', distanceMi: 2, gustMph: 45, line: 'The strongest gust measured at Lunken Airport (LUK), 2 mi from your address, was 45 mph on May 16, 2026.' },
        { date: '2026-04-01', stationId: 'LUK', stationName: XSS, distanceMi: 2, gustMph: 40, line: 'At ' + XSS + ' 40 mph' },
        { date: '2026-03-01', stationId: 'LUK', stationName: 'x', distanceMi: 2, gustMph: 0, line: 'zero should never show' },
      ],
      windGustSource: L.GUST_SOURCE_LINE, windGustContext: L.GUST_CONTEXT_LINE,
    });
    const r = await runPage(withG);
    const box = r.el('sr-rep-gusts'), list = r.el('sr-rep-gust-list');
    ok('block shown when the nearest station has readings', box.hidden === false);
    ok('one <li> per reading; the 0-mph entry is dropped', list._kids.length === 2, String(list._kids.length));
    ok('lines rendered via textContent (markup stays text)', list._kids[1].textContent === 'At ' + XSS + ' 40 mph' && list._kids.every((k) => k._html === undefined));
    ok('list never written with innerHTML', list._html === null);
    ok('context note rendered next to the readings', r.el('sr-rep-gust-note').textContent === L.GUST_CONTEXT_LINE);
    ok('credit line rendered', r.el('sr-rep-gust-source').textContent === 'Wind gusts: ' + L.GUST_SOURCE_LINE);
    ok('lead payload carries the report point (lat/lon) for the email', r.posted && r.posted.kind === 'inspect' && r.posted.payload.lat === 39.087 && r.posted.payload.lon === -84.39);

    const none = await runPage(Object.assign({}, base, { windGusts: [] }));
    ok('no readings → block hidden, no "no reading" text, no 0', none.el('sr-rep-gusts').hidden === true && none.el('sr-rep-gust-note').textContent === '' && none.el('sr-rep-gust-list')._kids.length === 0);
    const old = await runPage(base);
    ok('older API response without windGusts → hidden', old.el('sr-rep-gusts').hidden === true);
    const noCtx = await runPage(Object.assign({}, withG, { windGustContext: null }));
    ok('readings without the context line → hidden (guardrail)', noCtx.el('sr-rep-gusts').hidden === true);
    const markup = read('docs/storm-report.html');
    ok('block ships hidden in the HTML (no flash before render)', /<div class="sr-gusts" id="sr-rep-gusts" hidden>/.test(markup));
    // At least v4 — later fixes bump it again (R4 storm dates: v5).
    ok('page loads the bumped storm-report-page.js?v=4', Number((markup.match(/storm-report-page\.js\?v=(\d+)"/) || [])[1]) >= 4);
    ok('.sr-gusts wraps long words (no 390px overflow)', /\.sr-gusts\{[^}]*overflow-wrap:anywhere/.test(markup));
  }

  // ── 12. render: email (escaped) ────────────────────────────────────────
  console.log('\nRENDER — follow-up email');
  {
    const E = require('../functions/storm-report-email')._test;
    const line = L.gustLine({ stationId: 'LUK', stationName: 'Lunken Airport', distanceMi: 6, gustMph: 45, date: '2026-05-16' });
    const html = E.EMAIL_HTML({ firstName: 'Pat', address: '1 Main', summary: 's', gust: { line } });
    ok('email shows "Wind measured nearby" + the line', html.includes('Wind measured nearby') && html.includes(line));
    ok('email keeps the context line under it', html.indexOf(line) < html.indexOf('Only an inspection can show') && html.includes('up to your insurer'));
    ok('email credits IEM', html.includes('Iowa Environmental Mesonet (Iowa State University)'));
    const evil = E.EMAIL_HTML({ firstName: 'Pat', address: '', summary: 's', gust: { line: 'x ' + XSS } });
    ok('email escapes the line', evil.includes('&lt;img src=x onerror=alert(1)&gt;') && !evil.includes(XSS));
    const hidden = E.EMAIL_HTML({ firstName: 'Pat', address: '', summary: 's', gust: null });
    ok('no reading → no gust block in the email', !hidden.includes('Wind measured nearby') && !/\b0 mph\b/.test(hidden));
    // gustForLead: reads the SAME server-built report, fail-closed.
    const key = L.stormReportCacheKey(39.087, -84.39);
    const seeded = {};
    seeded['public_cache/' + key] = { data: { events: [{ date: '2026-05-17T00:25:00Z', type: 'hail', magnitude: 1.25 }] } };
    seeded['public_cache/gust_LUK_20260516'] = { stationId: 'LUK', date: '2026-05-16', gustKnots: 39, final: true, fetchedAt: 1 };
    const got = await E.gustForLead({ lat: 39.087, lon: -84.39 }, memDb(seeded));
    ok('gustForLead: biggest storm day from the cached report → LUK 45 mph', got && got.gustMph === 45 && got.date === '2026-05-16' && /Lunken Airport \(LUK\)/.test(got.line), got && got.line);
    ok('gustForLead: no lat/lon on the lead → null', (await E.gustForLead({}, memDb(seeded))) === null);
    ok('gustForLead: no cached report → null', (await E.gustForLead({ lat: 39.5, lon: -84.0 }, memDb())) === null);
    ok('gustForLead: Firestore error → null', (await E.gustForLead({ lat: 39.087, lon: -84.39 }, { doc: () => ({ get: async () => { throw new Error('x'); } }) })) === null);
    ok('stormReport and the email share ONE cache-key helper',
      /GUST\.stormReportCacheKey\(lat, lon\)/.test(stripComments(read('functions/storm-report.js'))) && key === 'storm_39_09___84_39');
    ok('index.js exports stormReportEmail by name (not its _test)', /exports\.stormReportEmail = require\('\.\/storm-report-email'\)\.stormReportEmail;/.test(read('functions/index.js')));
    ok('gateway keeps lat/lon on inspect leads (range-checked numOptional)',
      /inspect: \{[\s\S]*?numOptional: \{ lat: \{ min: -90, max: 90 \}, lon: \{ min: -180, max: 180 \} \}/.test(read('functions/handlers/integrations.js')));
  }

  // ── 13. render: CRM Storm Proof (vm, textContent) + proof record ───────
  console.log('\nRENDER — CRM Storm Proof');
  {
    const SP = require('../functions/storm-proof-logic');
    const w = { stationId: 'LUK', stationName: 'Lunken Airport', distanceMi: 2, gustMph: 45, date: '2026-05-16', line: 'L' };
    const p = SP.buildStormProof({ hits: [{ sizeInches: 0.5 }], wind: w });
    ok('proof carries a wind block', p.wind && p.wind.gustMph === 45 && p.wind.stationId === 'LUK');
    ok('wind never flips verified (hail rule only)', p.verified === false);
    ok('no wind / 0 mph → wind:null', SP.buildStormProof({ hits: [] }).wind === null && SP.buildStormProof({ hits: [], wind: Object.assign({}, w, { gustMph: 0 }) }).wind === null);
    const handler = stripComments(read('functions/handlers/storm-proof.js'));
    ok('handler asks for the strongest hit\'s LOCAL date, nearest station', /localDate\(top\.at\)/.test(handler) && /gustForAddressDay\(lat, lng, windDay/.test(handler));
    ok('handler returns windLine to the card', /windLine: proof\.wind \? proof\.wind\.line : null/.test(handler));

    async function runCrm(windLine, opts) {
      const inserted = [];
      const row = { parentNode: { insertBefore: (n) => inserted.push(n) }, nextSibling: null };
      const btn = { closest: (sel) => (sel === '.cd-actions' ? row : null) };
      let existing = null;
      const mk = () => {
        const kids = [];
        const node = {
          style: {}, attrs: {}, _kids: kids, _html: undefined,
          setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
          appendChild(c) { kids.push(c); return c; }, remove() { existing = null; },
          set textContent(v) { this._text = String(v); }, get textContent() { return this._text || ''; },
          set innerHTML(v) { this._html = String(v); },
        };
        return node;
      };
      const win = {
        _cardDetailLeadId: 'L1',
        _functions: {},
        _httpsCallable: () => async () => { if (opts && opts.switchTo) win._cardDetailLeadId = opts.switchTo; return { data: { verified: true, maxSizeInches: 1, windLine } }; },
        showToast() {}, addEventListener() {},
      };
      win.window = win;
      const doc = {
        readyState: 'complete', addEventListener() {},
        getElementById: (id) => (id === 'cdStormWind' ? existing : null),
        querySelector: (sel) => (sel === '[data-fn="verifyStormProofForLead"]' ? btn : null),
        createElement: () => mk(),
      };
      vm.runInNewContext(read('docs/pro/js/storm-integration.js'), { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON });
      await win.__NBD_CALL_REGISTRY.verifyStormProofForLead();
      return inserted;
    }
    const ins = await runCrm('Gust at ' + XSS);
    const box = ins[0];
    ok('card shows the wind note under the actions', ins.length === 1 && box.attrs['data-lead-id'] === 'L1');
    ok('note text via textContent (markup stays text), no innerHTML', box._kids[1].textContent === 'Gust at ' + XSS && box._kids.every((k) => k._html === undefined) && box._html === undefined);
    ok('note keeps the context + IEM credit', /Only an inspection can show/.test(box._kids[2].textContent) && /Iowa Environmental Mesonet/.test(box._kids[2].textContent));
    ok('windLine null (no reading) → nothing on the card', (await runCrm(null)).length === 0);
    ok('rep switched cards mid-lookup → nothing attached to the wrong lead', (await runCrm('x', { switchTo: 'L2' })).length === 0);
    const dw = stripComments(read('docs/pro/js/dashboard-widgets.js'));
    ok('opening another card removes a stale note', /getElementById\('cdStormWind'\)[\s\S]{0,120}getAttribute\('data-lead-id'\) !== leadId\) _stormWind\.remove\(\)/.test(dw));
    ok('cache-busters bumped (storm-integration v3, loader v146, widgets v10)',
      /'js\/storm-integration\.js\?v=3'/.test(read('docs/pro/js/script-loader.js')) &&
      Number((read('docs/pro/dashboard.html').match(/script-loader\.js\?v=(\d+)/) || [])[1]) >= 146 && Number((read('docs/pro/customer.html').match(/script-loader\.js\?v=(\d+)/) || [])[1]) >= 146 &&
      /dashboard-widgets\.js\?v=10/.test(read('docs/pro/dashboard.html')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
