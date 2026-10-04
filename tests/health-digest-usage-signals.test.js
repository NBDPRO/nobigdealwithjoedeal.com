/**
 * tests/health-digest-usage-signals.test.js — two of the daily digest's six
 * signals must actually see the data they claim to summarize.
 *
 * WHY THIS EXISTS.
 *
 * 1. gatherApiUsage() summed `d.data().tokensUsed`, a field no writer in this
 *    repo ever sets. The M2 budget counters (functions/handlers/_shared.js
 *    reserveClaudeBudget/adjustClaudeBudget) write `tokens` via
 *    FieldValue.increment on api_usage_daily/{day}__uid__{uid} docs, and the
 *    voice-intelligence integration adds `voice_analysisTokens` on the same
 *    docs (functions/integrations/voice-intelligence.js incrementVoiceUsage
 *    — also real Claude/Anthropic spend, per callClaudeJson hitting
 *    api.anthropic.com). Reading the wrong key means `total` is always 0 and
 *    `topUsers` is always empty, silently, forever, no matter how much
 *    Claude spend actually happened that day.
 *
 * 2. gatherStripe() fetched `stripe_events.limit(200)` with no orderBy and no
 *    time-based where, then filtered the 200 docs it happened to get back by
 *    `processedAt >= cutoffMs` in JS. stripe_events is an append-only,
 *    ever-growing idempotency-marker collection (one doc per Stripe event
 *    ever processed — see functions/stripe.js eventRef.create()) with no
 *    orderBy, so once it holds more than 200 documents Firestore's 200 are
 *    an arbitrary slice of all-time history, not the newest ones. The
 *    in-memory cutoff filter can then find zero matches even while webhooks
 *    are actively arriving, which is exactly the "webhook not delivering"
 *    failure this signal exists to catch (see the comment in
 *    functions/health-digest.js above gatherStripe).
 *
 * Case A1/A2 replay the real writer shape (tokens + voice_analysisTokens) and
 * pin that gatherApiUsage sums them, not `tokensUsed`. Case B replays a
 * collection that has outgrown the fetch cap: 250 events exist, the 200 the
 * fake Firestore ".get()" hands back (unordered, oldest-first — Firestore
 * makes no ordering guarantee without orderBy) are NOT the 30 that fall
 * inside the 24h window, and the fixed suite input proves the old
 * `.limit(200)`-then-filter shape returns 0 while a query that filters at
 * the Firestore level (what the fix must do) returns the real count.
 *
 * health-digest.js imports firebase-functions/firebase-admin at module scope
 * and a worktree has no functions/node_modules, so the module cannot be
 * require()d. gatherApiUsage/gatherStripe are lifted out of the source and
 * run in a vm against fake Firestore collections, so these assertions run
 * the shipped code rather than matching strings in it.
 *
 * Zero deps.  Run: node tests/health-digest-usage-signals.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'functions/health-digest.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function extractFn(src, name) {
  const decl = src.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
  const start = src.indexOf(decl);
  if (start === -1) throw new Error(`extractFn: ${name} not found in health-digest.js`);
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) throw new Error(`extractFn: unbalanced braces reading ${name}`);
  return src.slice(start, i);
}

// Lift the two real gatherers under test. gatherStripe calls
// Timestamp.fromMillis (from firebase-admin/firestore at module scope in the
// real file); provide the minimal shape the fake Firestore's where-filter
// understands (an object with .toMillis()).
const Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }) };
// FieldPath.documentId() → the '__name__' sentinel the fake below filters
// on by doc id (2026-10-03: gatherApiUsage reads an id range, not the
// whole collection).
const FieldPath = { documentId: () => '__name__' };
const sandbox = { console, Object, Array, String, Number, Math, Date, Promise, Error, Timestamp, FieldPath };
vm.createContext(sandbox);
vm.runInContext(
  ['gatherApiUsage', 'gatherStripe']
    .map((n) => extractFn(SRC, n)).join('\n') +
  '\nglobalThis.API = { gatherApiUsage, gatherStripe };',
  sandbox
);
const { gatherApiUsage, gatherStripe } = sandbox.API;

// ── Fake Firestore: a query-builder collection() that records .where()/
// .limit() calls, so the test can prove WHAT gets requested, not just what
// comes back. .get() returns docs from an in-memory array, applying only the
// where/limit the real code is expected to push down to Firestore (an
// unbounded, unordered fetch surfaces this by ignoring the where entirely,
// same as production Firestore would with a collection larger than the
// naive .limit()). ──
function makeSnap(docs) {
  return {
    size: docs.length,
    forEach(fn) { docs.forEach(fn); },
  };
}

function fakeDb(collections) {
  return {
    collection(name) {
      const all = collections[name] || [];
      const state = { wheres: [], lim: null };
      const builder = {
        where(field, op, value) {
          state.wheres.push({ field, op, value });
          return builder;
        },
        orderBy() { return builder; },
        limit(n) {
          state.lim = n;
          return builder;
        },
        async get() {
          let rows = all.slice();
          // Document-id range filters (FieldPath.documentId() → '__name__').
          for (const w of state.wheres) {
            if (w.field !== '__name__') continue;
            rows = rows.filter((d) => (w.op === '>=' ? d.id >= w.value : w.op === '<' ? d.id < w.value
              : w.op === '<=' ? d.id <= w.value : w.op === '>' ? d.id > w.value : true));
          }
          if (fakeDb.reads) fakeDb.reads.push({ name, wheres: state.wheres.slice(), returned: rows.length });
          // Apply only >= filters the fixed code is expected to issue.
          for (const w of state.wheres) {
            if (w.op === '>=' && w.field !== '__name__') {
              rows = rows.filter((d) => {
                const v = d._raw[w.field];
                const ms = v && v.toMillis ? v.toMillis() : v;
                const cutoff = w.value && w.value.toMillis ? w.value.toMillis() : w.value;
                return ms >= cutoff;
              });
            }
          }
          // Simulate Firestore's lack of ordering guarantee absent orderBy:
          // .limit() truncates whatever order the collection happens to be
          // in on disk, which here is insertion order (oldest-first) — the
          // worst case for an unordered fetch of an append-only collection.
          if (state.lim != null) rows = rows.slice(0, state.lim);
          return makeSnap(rows.map((d) => ({ id: d.id, data: () => d._raw })));
        },
      };
      return builder;
    },
  };
}

function ts(ms) {
  return { toMillis: () => ms };
}

(async () => {
  console.log('\nhealth digest — Anthropic token usage + Stripe activity signals\n');

  // ═══════════════════════ gatherApiUsage ═══════════════════════
  console.log('A. Anthropic Token Usage reads the fields the real writers set');

  const dayKey = '2026-09-15';
  const apiDocs = {
    api_usage_daily: [
      // claudeProxy writer (functions/handlers/_shared.js reserveClaudeBudget):
      // sets `tokens` via FieldValue.increment, never `tokensUsed`.
      { id: `${dayKey}__uid__user-A`, _raw: { uid: 'user-A', dayKey, scope: 'uid', tokens: 4200 } },
      // voice-intelligence writer (incrementVoiceUsage): sets
      // `voice_analysisTokens` on the SAME doc shape — also real Claude spend.
      { id: `${dayKey}__uid__user-B`, _raw: { uid: 'user-B', dayKey, scope: 'uid', tokens: 100, voice_analysisTokens: 900 } },
      // A company-scope row for the same day — must be excluded (doubles counts).
      { id: `${dayKey}__co__company-X`, _raw: { companyId: 'company-X', dayKey, scope: 'company', tokens: 4300 } },
      // Yesterday's uid row — must be excluded (dayKey prefix filter).
      { id: `2026-09-14__uid__user-C`, _raw: { uid: 'user-C', dayKey: '2026-09-14', scope: 'uid', tokens: 5000 } },
    ],
  };

  const nowRestore = Date;
  global.__origDate = nowRestore;
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) return new RealDate('2026-09-15T18:00:00.000Z');
      return new RealDate(...args);
    }
    static now() { return new RealDate('2026-09-15T18:00:00.000Z').getTime(); }
  }
  sandbox.Date = FixedDate;

  const usage = await gatherApiUsage(fakeDb(apiDocs));

  ok('A1 total sums `tokens` (the real claudeProxy field), not `tokensUsed`',
    usage.total === 4200 + 100 + 900, `got ${usage.total}, expected 5200`);
  ok('A2 co-scope and other-day rows excluded from the total',
    usage.total !== 4200 + 100 + 900 + 4300 && usage.total !== 4200 + 100 + 900 + 5000);
  ok('A3 per-user tokens include voice_analysisTokens (user-B: 100 + 900)',
    usage.topUsers.some((u) => u.uid === 'user-B' && u.tokens === 1000),
    JSON.stringify(usage.topUsers));
  ok('A4 top users sorted descending by tokens',
    usage.topUsers.length >= 2 && usage.topUsers[0].tokens >= usage.topUsers[1].tokens);
  ok('A5 non-zero total — the pre-fix bug reported exactly 0 forever',
    usage.total > 0, `got ${usage.total}`);

  // Sanity: prove this test WOULD have failed against the literal pre-fix
  // read (tokensUsed), so a future accidental revert is caught here too.
  const preFixTotal = apiDocs.api_usage_daily
    .filter((d) => d.id.includes('__uid__') && d.id.startsWith(dayKey))
    .reduce((sum, d) => sum + Number(d._raw.tokensUsed || 0), 0);
  ok('A6 (sanity) the old `tokensUsed` field is absent on every doc — pre-fix read is provably 0',
    preFixTotal === 0);

  // A7 (2026-10-03): the read is bounded to today's uid rows by a document-id
  // range — it used to .get() the WHOLE collection (every day since launch,
  // uid and co rows) and filter in memory.
  {
    const big = { api_usage_daily: apiDocs.api_usage_daily.slice() };
    for (let i = 0; i < 1500; i++) {
      const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      if (d === dayKey) continue;
      big.api_usage_daily.push({ id: d + '__uid__old-' + i, _raw: { tokens: 7 } });
      big.api_usage_daily.push({ id: d + '__co__co-' + i, _raw: { tokens: 7 } });
    }
    fakeDb.reads = [];
    const u7 = await gatherApiUsage(fakeDb(big));
    const r7 = fakeDb.reads.filter((r) => r.name === 'api_usage_daily');
    fakeDb.reads = null;
    ok('A7 same answer on a collection with ~3000 other-day rows', u7.total === 5200, 'got ' + u7.total);
    ok('A7 the query is a document-id range on today\'s uid prefix (reads 2 docs, not ' + big.api_usage_daily.length + ')',
      r7.length === 1 && r7[0].returned === 2
      && r7[0].wheres.some((w) => w.field === '__name__' && w.op === '>=' && w.value === dayKey + '__uid__')
      && r7[0].wheres.some((w) => w.field === '__name__' && w.op === '<' && String(w.value).startsWith(dayKey + '__uid__')),
      JSON.stringify(r7));
  }

  // ═══════════════════════ gatherStripe ═══════════════════════
  console.log('\nB. Stripe Webhook Activity is not blind past 200 all-time events');

  const NOW_MS = Date.UTC(2026, 8, 15, 18, 0, 0);
  const CUTOFF_MS = NOW_MS - 24 * 60 * 60 * 1000;

  // 250 total stripe_events docs, oldest-first (how an append-only,
  // unordered-by-default collection actually lays out). The newest 30 are
  // inside the last-24h window; the other 220 predate it by weeks.
  const stripeDocs = [];
  for (let i = 0; i < 220; i++) {
    stripeDocs.push({
      id: `evt_old_${i}`,
      _raw: { type: 'payment_intent.succeeded', processedAt: ts(CUTOFF_MS - (220 - i) * 3600_000) },
    });
  }
  for (let i = 0; i < 30; i++) {
    stripeDocs.push({
      id: `evt_recent_${i}`,
      _raw: { type: 'charge.succeeded', processedAt: ts(CUTOFF_MS + (i + 1) * 60_000) },
    });
  }

  const stripeResult = await gatherStripe(fakeDb({ stripe_events: stripeDocs }), CUTOFF_MS);

  ok('B1 finds all 30 events actually inside the 24h window',
    stripeResult.total === 30, `got ${stripeResult.total}, expected 30 (collection has ${stripeDocs.length} docs total)`);
  ok('B2 recentTypes reflects only the in-window events',
    stripeResult.recentTypes['charge.succeeded'] === 30 && !stripeResult.recentTypes['payment_intent.succeeded']);

  // Prove the OLD shape (fetch 200 unordered docs, filter in JS) goes blind
  // on exactly this data: taking the first 200 of this oldest-first layout
  // never reaches the 30 recent docs at all.
  const oldShapeFirst200 = stripeDocs.slice(0, 200);
  const oldShapeTotal = oldShapeFirst200.filter((d) => d._raw.processedAt.toMillis() >= CUTOFF_MS).length;
  ok('B3 (sanity) the old unordered-.limit(200)-then-filter shape finds ZERO of the 30 recent events on this data',
    oldShapeTotal === 0, `old shape found ${oldShapeTotal}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
