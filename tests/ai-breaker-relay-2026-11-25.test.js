/**
 * tests/ai-breaker-relay-2026-11-25.test.js
 *
 * Roadmap step 13 follow-up (documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md):
 * a tripped AI spend breaker reaches the owner's phone. The AI entry points
 * that trip it hold no Twilio secrets, so ai-gate.js only writes the
 * ai_spend_alerts claim (and queues the email); cronDeadman relays each
 * claim through notifyOwner once (relayBreakerAlerts).
 *
 *   1. an unrelayed claim of today -> one 'alert' notify, then marked relayed
 *   2. an already relayed claim -> nothing
 *   3. yesterday's claim is still relayed (an 23:50 trip, a 00:10 run)
 *   4. a failed notify leaves the claim unrelayed (the next run retries)
 *   5. a failed read never throws
 *   6. the text names the plan, never the company id
 *   7. the real aiGate writes capKey and feature into the claim
 *   8. cronDeadman calls the relay
 *
 * Run: node tests/ai-breaker-relay-2026-11-25.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const AG = require(path.join(ROOT, 'functions', 'ai-gate.js'));

let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); failed++; fails.push(label); }
}

const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const NOW = Date.UTC(2026, 10, 25, 18, 0, 0); // 13:00 ET
const TODAY = etYmd(NOW), YDAY = etYmd(NOW - 86400000), OLD = etYmd(NOW - 3 * 86400000);

// ── in-memory Firestore: doc get/create/update, collection().where('day','==').get() ──
function makeDb(seed, opts) {
  const docs = new Map(Object.entries(seed || {}).map(([k, v]) => [k, Object.assign({}, v)]));
  const o = opts || {};
  const ref = (p) => ({
    id: p.split('/').pop(), path: p,
    async get() { return { exists: docs.has(p), id: p.split('/').pop(), data: () => (docs.has(p) ? Object.assign({}, docs.get(p)) : undefined) }; },
    async create(v) { if (docs.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(p, Object.assign({}, v)); },
    async set(v) { docs.set(p, Object.assign({}, v)); },
    async update(v) { if (o.failUpdate) throw new Error('update down'); docs.set(p, Object.assign({}, docs.get(p) || {}, v)); },
    async delete() { docs.delete(p); },
  });
  return {
    docs,
    doc: ref,
    collection(c) {
      const api = {
        add: async (v) => { const id = c + '/auto' + docs.size; docs.set(id, v); return ref(id); },
        where(f, op, val) {
          return {
            async get() {
              if (o.failQuery) throw new Error('query down');
              const hits = [...docs.entries()].filter(([k, v]) => k.startsWith(c + '/') && k.split('/').length === 2 && v[f] === val);
              return { forEach: (fn) => hits.forEach(([k, v]) => fn({ id: k.split('/')[1], ref: ref(k), data: () => Object.assign({}, v) })) };
            },
          };
        },
      };
      return api;
    },
  };
}
const claim = (day, extra) => Object.assign({ day, cap: 'company', companyId: 'co_secret_123', capKey: 'growth', capMicros: 690000, spentMicros: 701000, atMs: NOW - 60000 }, extra || {});

(async () => {
  console.log('\n1-2. relay once, skip relayed');
  {
    const db = makeDb({
      ['ai_spend_alerts/' + TODAY + '__co__co_secret_123']: claim(TODAY),
      ['ai_spend_alerts/' + TODAY + '__platform']: claim(TODAY, { cap: 'platform', companyId: null, capKey: null, relayedAtMs: NOW - 1000 }),
    });
    const sent = [];
    const r = await AG.relayBreakerAlerts(db, { nowMs: NOW, notify: async (m) => { sent.push(m); return { pushed: true }; } });
    ok('one unrelayed claim -> exactly one notify', sent.length === 1 && r.relayed === 1, { r, n: sent.length });
    ok("it is an 'alert' (bell + push + one daytime text), keyed per claim", sent[0] && sent[0].severity === 'alert' && sent[0].key === 'ai-spend:' + TODAY + '__co__co_secret_123', sent[0]);
    ok('the claim is marked relayed', db.docs.get('ai_spend_alerts/' + TODAY + '__co__co_secret_123').relayedAtMs === NOW);
    const again = [];
    await AG.relayBreakerAlerts(db, { nowMs: NOW + 1800000, notify: async (m) => { again.push(m); } });
    ok('the next run sends nothing (already relayed)', again.length === 0, again);
    console.log('\n6. no company id in the text');
    ok('title and body name the plan and the amounts', /growth/.test(sent[0].title) && /\$0\.69/.test(sent[0].body) && /\$0\.70/.test(sent[0].body), sent[0]);
    ok('the company id is not in the title or body', !/co_secret_123/.test(sent[0].title + sent[0].body));
  }

  console.log('\n3. yesterday is relayed, older is not read');
  {
    const db = makeDb({
      ['ai_spend_alerts/' + YDAY + '__public']: claim(YDAY, { cap: 'public', companyId: null, capKey: null }),
      ['ai_spend_alerts/' + OLD + '__platform']: claim(OLD, { cap: 'platform', companyId: null, capKey: null }),
    });
    const sent = [];
    await AG.relayBreakerAlerts(db, { nowMs: NOW, notify: async (m) => { sent.push(m); } });
    ok("yesterday's claim is relayed", sent.length === 1 && sent[0].key === 'ai-spend:' + YDAY + '__public', sent.map((m) => m.key));
    ok("the public cap reads as 'the public website AI'", sent[0] && /public website AI/.test(sent[0].title));
  }

  console.log('\n4. failed notify retries next run');
  {
    const id = 'ai_spend_alerts/' + TODAY + '__platform';
    const db = makeDb({ [id]: claim(TODAY, { cap: 'platform', companyId: null, capKey: null }) });
    const r = await AG.relayBreakerAlerts(db, { nowMs: NOW, notify: async () => { throw new Error('bell write failed'); } });
    ok('failed counted, nothing relayed', r.failed === 1 && r.relayed === 0, r);
    ok('the claim stays unrelayed', db.docs.get(id).relayedAtMs == null);
    const sent = [];
    await AG.relayBreakerAlerts(db, { nowMs: NOW + 1800000, notify: async (m) => { sent.push(m); } });
    ok('the next run sends it', sent.length === 1);
  }

  console.log('\n5. a failed read never throws');
  {
    let threw = false, r;
    try { r = await AG.relayBreakerAlerts(makeDb({}, { failQuery: true }), { nowMs: NOW, notify: async () => {} }); } catch (_) { threw = true; }
    ok('no throw, error reported', !threw && r && /query down/.test(r.error), r);
  }

  console.log('\n7. the real aiGate writes capKey + feature into the claim');
  {
    const day = TODAY;
    const db = makeDb({
      ['ai_spend_daily_co/' + day + '__co_a']: { usdMicros: 900000 },
      ['ai_spend_daily/' + day]: { usdMicros: 900000 },
      'companies/co_a': { plan: 'growth' },
      'subscriptions/co_a': { plan: 'growth', status: 'active' },
    });
    AG._resetBreakerCache();
    const alerts = [];
    const r = await AG.aiGate(db, {
      companyId: 'co_a', feature: 'smart-followup', nowMs: NOW,
      deps: { getFlags: async () => ({ aiSpendLimits: { platformDailyUsd: 50, perPlanDailyUsd: { growth: 0.5 } } }), sendAlert: async (_db, a) => { alerts.push(a); } },
    });
    const c = db.docs.get('ai_spend_alerts/' + day + '__co__co_a');
    ok('the company cap refused the call', r && r.ok === false, r);
    ok('the claim carries capKey and feature', c && c.capKey === 'growth' && c.feature === 'smart-followup', c);
  }

  console.log('\n8. cronDeadman calls the relay');
  {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'cron-deadman.js'), 'utf8');
    const handler = src.slice(src.indexOf('exports.cronDeadman'));
    const iRelay = handler.indexOf('relayBreakerAlerts('), iFlush = handler.indexOf('flushOwnerQueue(');
    ok('the cronDeadman handler calls relayBreakerAlerts before the overnight flush', iRelay > 0 && iFlush > iRelay, { iRelay, iFlush });
  }

  console.log('\n' + '─'.repeat(50));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
