/**
 * Review momentum — functions/google-reviews-momentum.js + its wiring in
 * functions/google-reviews.js.
 *
 * WHY THIS EXISTS
 * Jo (2026-09-27) wants visitors to see that reviews are still arriving.
 * Places API (New) returns only 5 reviews by relevance, and the newest three
 * (29 → 32 since 09-20) weren't among them. The one honest recency signal
 * Places gives us is its own review COUNT, so the server records one count
 * per day and reports growth over ~30 days as `recent`.
 *
 * The failure that matters is a FALSE claim: "4 new this month" when there is
 * no real baseline, when the count fell, or when a failed read wiped the
 * history. So most of this suite is about when `recent` must be ABSENT.
 * It runs the real module with an injected clock, then drives the real
 * handler (firebase stubbed at the module loader, the
 * google-reviews-not-configured.test.js idiom) to pin the single write.
 *
 * Pure-Node. Run: node tests/google-reviews-momentum.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'functions', 'google-reviews-momentum.js'));
const { presentPayload } = require(path.join(ROOT, 'functions', 'google-reviews-display.js'));
const { computeRecent, recordTotal, needsRecord, etDate, SEED_TOTALS } = M;

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, hint) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; fails.push(label); console.log('  ✗ ' + label + (hint ? ' — ' + hint : '')); }
}
const J = (v) => JSON.stringify(v);
// Noon ET on a calendar day — well clear of any midnight boundary.
const at = (date) => Date.parse(date + 'T16:00:00Z');

// ── Seeds ────────────────────────────────────────────────────────────
console.log('SEED POINTS — sourced, and exactly the verified three');
ok('seed is 08-31→28, 09-20→29, 09-27→32',
  J(SEED_TOTALS) === J([
    { date: '2026-08-31', total: 28 },
    { date: '2026-09-20', total: 29 },
    { date: '2026-09-27', total: 32 },
  ]), J(SEED_TOTALS));
ok('seed is frozen (no caller can mutate the compiled history)',
  Object.isFrozen(SEED_TOTALS) && Object.isFrozen(SEED_TOTALS[0]));

// ── computeRecent ────────────────────────────────────────────────────
console.log('\nSEED-ONLY — the state on the day this ships');
{
  const r = computeRecent([], 32, at('2026-09-27'));
  ok('09-27 with 32: no 30-day-old point yet → oldest (08-31), real span 27 days',
    J(r) === J({ newReviews: 4, days: 27, since: '2026-08-31' }), J(r));
  ok("today's own seed point (09-27) is never its own baseline",
    r && r.since !== '2026-09-27');
  const r30 = computeRecent([], 33, at('2026-09-30'));
  ok('09-30 with 33: 08-31 is exactly 30 days back → days 30',
    J(r30) === J({ newReviews: 5, days: 30, since: '2026-08-31' }), J(r30));
}

console.log('\nNO BASELINE → omitted');
ok('no seed, no history → null', computeRecent([], 32, at('2026-09-27'), []) === null);
ok('only a point dated today → null',
  computeRecent([{ date: '2026-09-27', total: 30 }], 32, at('2026-09-27'), []) === null);
ok('only future points (bad clock) → null',
  computeRecent([{ date: '2026-10-05', total: 10 }], 32, at('2026-09-27'), []) === null);

console.log('\nSPAN < 7 DAYS → omitted (a 3-day baseline says nothing about a month)');
ok('oldest point 3 days back → null',
  computeRecent([{ date: '2026-09-24', total: 29 }], 32, at('2026-09-27'), []) === null);
ok('oldest point 6 days back → null',
  computeRecent([{ date: '2026-09-21', total: 29 }], 32, at('2026-09-27'), []) === null);
{
  const r = computeRecent([{ date: '2026-09-20', total: 29 }], 32, at('2026-09-27'), []);
  ok('exactly 7 days back → shown, with days 7',
    J(r) === J({ newReviews: 3, days: 7, since: '2026-09-20' }), J(r));
}

console.log('\n30-DAY WINDOW — latest point at or before today − 30');
{
  // A daily history 08-01 … 09-27, count +1 every 4 days.
  const hist = [];
  for (let t = Date.parse('2026-08-01T16:00:00Z'), i = 0; t <= at('2026-09-27'); t += 86400000, i++) {
    hist.push({ date: etDate(t), total: 20 + Math.floor(i / 4) });
  }
  const base = hist.find((p) => p.date === '2026-08-28');
  const cur = hist[hist.length - 1].total;
  const r = computeRecent(hist, cur, at('2026-09-27'), []);
  ok('daily history → baseline is 08-28 exactly, days 30',
    J(r) === J({ newReviews: cur - base.total, days: 30, since: '2026-08-28' }), J(r));
  ok('newer points inside the window are NOT used as the baseline',
    r && r.since === '2026-08-28');
}
{
  const hist = [
    { date: '2026-08-01', total: 20 },
    { date: '2026-08-20', total: 25 },
    { date: '2026-09-20', total: 29 },
  ];
  const r = computeRecent(hist, 32, at('2026-09-27'), []);
  ok('sparse history → the LATEST old point (08-20), and days is the real 38, not a rounded 30',
    J(r) === J({ newReviews: 7, days: 38, since: '2026-08-20' }), J(r));
}
{
  const r = computeRecent([{ date: '2026-08-31', total: 30 }], 33, at('2026-09-30'));
  ok('a stored point overrides the seed on the same date (30 beats seeded 28)',
    J(r) === J({ newReviews: 3, days: 30, since: '2026-08-31' }), J(r));
}

console.log('\nZERO / NEGATIVE GROWTH → omitted (never "0 new")');
ok('count unchanged → null',
  computeRecent([{ date: '2026-08-20', total: 32 }], 32, at('2026-09-27'), []) === null);
ok('count FELL (Google removed a review) → null',
  computeRecent([{ date: '2026-08-20', total: 33 }], 32, at('2026-09-27'), []) === null);
ok('current total 0 (the empty fallback body) → null', computeRecent([], 0, at('2026-09-27')) === null);
ok('current total missing / non-integer → null',
  computeRecent([], undefined, at('2026-09-27')) === null && computeRecent([], 31.5, at('2026-09-27')) === null);
ok('no clock → null, not a throw', computeRecent([], 32, undefined) === null);
ok('junk history entries are ignored, not trusted',
  computeRecent([null, 'x', { date: '2026-8-1', total: 1 }, { date: '2026-08-01', total: -4 },
    { date: '2026-08-01', total: '3' }], 32, at('2026-09-27'), []) === null);

// ── recordTotal ──────────────────────────────────────────────────────
console.log('\nRECORDING — one point per day, latest wins, 400 days kept');
{
  let h = recordTotal(undefined, 30, at('2026-09-27'));
  h = recordTotal(h, 31, Date.parse('2026-09-27T20:00:00Z'));
  ok('two refreshes on one ET day → ONE point, the later total',
    J(h) === J([{ date: '2026-09-27', total: 31 }]), J(h));
  h = recordTotal(h, 32, at('2026-09-28'));
  ok('the next day appends, ascending',
    J(h) === J([{ date: '2026-09-27', total: 31 }, { date: '2026-09-28', total: 32 }]), J(h));
  ok('seeds are NOT persisted into the stored array (they live in code)',
    !h.some((p) => p.date === '2026-08-31'));
  const dup = recordTotal([{ date: '2026-09-01', total: 5 }, { date: '2026-09-01', total: 6 }], 7, at('2026-09-27'));
  ok('duplicate stored dates collapse to one (later entry wins)',
    J(dup) === J([{ date: '2026-09-01', total: 6 }, { date: '2026-09-27', total: 7 }]), J(dup));
  const kept = recordTotal([
    { date: '2025-08-22', total: 1 }, // 401 days before 2026-09-27
    { date: '2025-08-24', total: 2 }, // 399 days before
  ], 32, at('2026-09-27'));
  ok('points older than 400 days are dropped; 399 days kept',
    J(kept.map((p) => p.date)) === J(['2025-08-24', '2026-09-27']), J(kept));
  ok('an unusable total records nothing (history returned unchanged)',
    J(recordTotal([{ date: '2026-09-01', total: 5 }], 0, at('2026-09-27'))) === J([{ date: '2026-09-01', total: 5 }]));
  ok('needsRecord: missing today → true; same total today → false; changed → true',
    needsRecord([], 32, at('2026-09-27')) === true &&
    needsRecord([{ date: '2026-09-27', total: 32 }], 32, at('2026-09-27')) === false &&
    needsRecord([{ date: '2026-09-27', total: 31 }], 32, at('2026-09-27')) === true);
}

console.log('\nTIMEZONE — the day is America/New_York, not UTC');
{
  const late = Date.parse('2026-09-28T02:30:00Z'); // 22:30 EDT on the 27th
  ok('2026-09-28T02:30Z is 2026-09-27 in ET', etDate(late) === '2026-09-27', etDate(late));
  ok('2026-09-28T04:30Z is 2026-09-28 in ET (EDT midnight = 04:00Z)',
    etDate(Date.parse('2026-09-28T04:30:00Z')) === '2026-09-28');
  ok('winter: 2026-12-01T04:30Z is still 2026-11-30 in ET (EST midnight = 05:00Z)',
    etDate(Date.parse('2026-12-01T04:30:00Z')) === '2026-11-30');
  const h = recordTotal([], 32, late);
  ok('a refresh at 02:30Z records under the ET date 09-27', J(h) === J([{ date: '2026-09-27', total: 32 }]), J(h));
  const r = computeRecent([], 32, late);
  ok('...and computes as 09-27 (span 27), not as 09-28 (span 28 → "this month")',
    r && r.days === 27, J(r));
}

// ── presentPayload ───────────────────────────────────────────────────
console.log('\nPAYLOAD — recent attached only when honest; never passed through');
{
  const data = { name: 'NBD', rating: 5, total: 32, reviews: [] };
  const withIt = presentPayload(data, { totalsHistory: [], now: at('2026-09-27') });
  ok('opts given + growth → recent attached',
    J(withIt.recent) === J({ newReviews: 4, days: 27, since: '2026-08-31' }), J(withIt.recent));
  ok('no opts → no recent key at all (callers opt in)', !('recent' in presentPayload(data)));
  const flat = presentPayload({ ...data, total: 28 }, { totalsHistory: [], now: at('2026-09-27') });
  ok('no growth → the key is ABSENT, not { newReviews: 0 }', !('recent' in flat));
  const forged = presentPayload({ ...data, total: 0, recent: { newReviews: 99, days: 30 } },
    { totalsHistory: [], now: at('2026-09-27') });
  ok('a recent already on stored data is stripped, never echoed', !('recent' in forged));
  ok('rating/total untouched', withIt.rating === 5 && withIt.total === 32);
}

// ── Handler wiring ───────────────────────────────────────────────────
const MOD = path.join(ROOT, 'functions', 'google-reviews.js');
function load(opts) {
  const docs = opts.docs || {};
  const writes = [];
  const logs = { error: [], warn: [], info: [] };
  const db = {
    doc: (p) => ({
      get: async () => {
        if (opts.failRead && opts.failRead.includes(p)) throw new Error('read failed');
        return { exists: docs[p] != null, data: () => docs[p] };
      },
      set: async (data, o) => { writes.push({ path: p, data, opts: o }); },
    }),
  };
  const stubs = {
    'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }) },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => (opts.secrets || {})[n] }) },
    'firebase-functions/v2': {
      logger: { error: (...a) => logs.error.push(a), warn: (...a) => logs.warn.push(a), info: (...a) => logs.info.push(a) },
    },
    'firebase-admin/firestore': { getFirestore: () => db },
  };
  const realLoad = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    if (request === './rate-limit-policy') return { guardHttp: (n, h) => h };
    return realLoad.apply(this, arguments);
  };
  let exported;
  try {
    delete require.cache[require.resolve(MOD)];
    exported = require(MOD);
  } finally {
    Module._load = realLoad;
  }
  async function request(nowMs) {
    const headers = {};
    const res = {
      set: (k, v) => { headers[k] = v; },
      status: (code) => ({ json: (body) => ({ status: code, body, headers }) }),
    };
    const realFetch = global.fetch;
    const realNow = Date.now;
    global.fetch = async () => {
      if (!opts.places) throw new Error('simulated network failure');
      return { ok: true, status: 200, json: async () => opts.places, text: async () => '' };
    };
    Date.now = () => nowMs;
    try {
      return await exported.getGoogleReviews.__handler({ headers: {} }, res);
    } finally {
      global.fetch = realFetch;
      Date.now = realNow;
    }
  }
  return { request, writes, logs };
}

const REAL = { GOOGLE_PLACES_API_KEY: 'AIza-real', NBD_PLACE_ID: 'ChIJ-real' };
const PLACES = (count) => ({
  displayName: { text: 'No Big Deal Home Solutions' },
  rating: 5,
  userRatingCount: count,
  googleMapsUri: 'https://maps.google.com/x',
  reviews: [{ authorAttribution: { displayName: 'A' }, rating: 5, text: { text: 'x' }, publishTime: '2026-09-01T00:00:00Z' }],
});
const CACHE = 'public_cache/google_reviews';
const GBP = 'siteContent/googleReviews';

(async () => {
  console.log('\nHANDLER — the Places refresh records today in the SAME single write');
  {
    const now = at('2026-09-30');
    const t = load({
      secrets: REAL,
      places: PLACES(33),
      docs: { [CACHE]: { data: { total: 30, reviews: [] }, fetchedAt: 1, totalsHistory: [{ date: '2026-09-01', total: 30 }] } },
    });
    const r = await t.request(now);
    ok('exactly one Firestore write', t.writes.length === 1, String(t.writes.length));
    const w = t.writes[0] || { data: {} };
    ok('...merge:true, carrying data + fetchedAt + totalsHistory',
      w.opts && w.opts.merge === true && w.data.data && w.data.fetchedAt === now && Array.isArray(w.data.totalsHistory));
    ok('...history keeps the stored point and appends today',
      J(w.data.totalsHistory) === J([{ date: '2026-09-01', total: 30 }, { date: '2026-09-30', total: 33 }]),
      J(w.data.totalsHistory));
    ok('response carries recent (08-31 seed 28 → 33, days 30)',
      J(r.body.recent) === J({ newReviews: 5, days: 30, since: '2026-08-31' }), J(r.body.recent));
  }
  {
    const t = load({ secrets: REAL, places: PLACES(33), failRead: [CACHE] });
    await t.request(at('2026-09-30'));
    const w = t.writes[0] || { data: {} };
    ok('cache READ failed → the write omits totalsHistory (merge keeps the stored array, no wipe)',
      t.writes.length === 1 && !('totalsHistory' in w.data), J(Object.keys(w.data)));
  }

  console.log('\nHANDLER — fresh cache path computes from stored history, writes nothing');
  {
    const now = at('2026-09-30');
    const t = load({
      secrets: REAL,
      docs: { [CACHE]: { data: { total: 33, reviews: [{ author: 'A' }] }, fetchedAt: now - 1000, totalsHistory: [{ date: '2026-09-30', total: 33 }] } },
    });
    const r = await t.request(now);
    ok('zero writes', t.writes.length === 0);
    ok('recent present', r.body.recent && r.body.recent.newReviews === 5, J(r.body.recent));
  }

  console.log('\nHANDLER — fresh GBP full set records its total at most once a day');
  {
    const now = at('2026-09-30');
    const gbp = { data: { total: 34, reviews: [{ author: 'G' }] }, fetchedAt: now - 1000 };
    const t = load({ docs: { [GBP]: gbp, [CACHE]: { data: { total: 33, reviews: [] }, fetchedAt: 1 } } });
    const r = await t.request(now);
    ok('first GBP serve of the day → one write of ONLY totalsHistory',
      t.writes.length === 1 && J(Object.keys(t.writes[0].data)) === J(['totalsHistory']) &&
      t.writes[0].path === CACHE && t.writes[0].opts.merge === true,
      J(t.writes.map((w) => Object.keys(w.data))));
    ok('GBP response carries recent from ITS total (34 − 28)',
      r.body.source === 'gbp' && r.body.recent && r.body.recent.newReviews === 6, J(r.body.recent));
    const t2 = load({ docs: { [GBP]: gbp, [CACHE]: { totalsHistory: [{ date: '2026-09-30', total: 34 }] } } });
    await t2.request(now);
    ok('same total already recorded today → zero writes (not one per request)', t2.writes.length === 0);
    const t3 = load({ docs: { [GBP]: gbp }, failRead: [CACHE] });
    await t3.request(now);
    ok('GBP path with a failed cache read → no history write', t3.writes.length === 0);
  }

  console.log('\nHANDLER — fallbacks');
  {
    const t = load({ secrets: {}, docs: {} });
    const r = await t.request(at('2026-09-30'));
    ok('empty cold fallback carries no recent', r.body.empty === true && !('recent' in r.body));
    // Observed on 09-30 (total 33), served stale on 10-02: the window must
    // end at the OBSERVATION, so days is 30 (08-31 → 09-30), not 32.
    const seen = at('2026-09-30');
    const t2 = load({ secrets: {}, docs: { [CACHE]: { data: { total: 33, reviews: [{ author: 'A' }] }, fetchedAt: seen } } });
    const r2 = await t2.request(at('2026-10-02'));
    ok('stale cache fallback computes recent as of when the total was SEEN, and writes nothing',
      r2.body.stale === true && J(r2.body.recent) === J({ newReviews: 5, days: 30, since: '2026-08-31' }) &&
      t2.writes.length === 0, J(r2.body.recent));
    const t3 = load({ secrets: {}, docs: { [CACHE]: { data: { total: 33, reviews: [{ author: 'A' }] }, fetchedAt: seen } } });
    const r3 = await t3.request(at('2026-10-08'));
    ok('stale by more than a week → recent dropped, not dated', r3.body.stale === true && !('recent' in r3.body), J(r3.body.recent));
    const t4 = load({ secrets: {}, docs: { [GBP]: { data: { total: 33, reviews: [{ author: 'G' }] }, fetchedAt: seen } } });
    const r4 = await t4.request(at('2026-10-02'));
    ok('stale GBP fallback follows the same rule', r4.body.source === 'gbp' && r4.body.recent && r4.body.recent.days === 30,
      J(r4.body.recent));
  }

  console.log('\n' + '─'.repeat(50));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFAILED:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})();
