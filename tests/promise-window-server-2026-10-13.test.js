#!/usr/bin/env node
/**
 * QA 2026-10-13, finding H2: the 45-day promise window lived only on Home.
 * callWatch / the 8 pm ledger / away mode QUERIED 14 days, so a 20-day-old
 * promise showed on Home while the ledger said "nothing fell through". The
 * rule (callNeedsYou) already knew 45 days; what it was FED did not.
 *
 * Fake db honours where / orderBy / limit, so the query window is under test
 * (a fake that ignores where() is how this stayed green).
 * Run: node tests/promise-window-server-2026-10-13.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const H = 3600000, D = 86400000;
const NOW = Date.parse('2026-10-02T00:05:00Z'); // 8:05 PM ET Oct 1 — the ledger hour
const joP = [{ who: 'jo', text: 'send the quote' }];
const OWNER = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const call = (o) => Object.assign({ userId: OWNER, startedAtMs: NOW - 3 * H, status: 'noted', direction: 'inbound', bucket: 'customer', leadId: 'L9', phoneDigits: '8595550101' }, o);
const todayCall = call({ id: 'today', leadId: 'L1', phoneDigits: '8595550199' }); // keeps "no calls today" out of the way

/** Firestore-ish fake: where(==, >=, <), orderBy desc, limit. */
function mkDb(rows, opts) {
  const o = opts || {};
  const docs = { 'integrations/callWatch': { lastCheckAtMs: NOW - 2 * H } };
  const q = (all, col) => {
    const f = [], st = { lim: Infinity, desc: false };
    const self = {
      where(field, op, v) { f.push([field, op, v]); return self; },
      orderBy(field, dir) { st.desc = dir === 'desc'; st.field = field; return self; },
      limit(n) { st.lim = n; return self; },
      async get() {
        if (o.failOld && col === 'phone_calls' && f.some((x) => x[1] === '<')) throw new Error('boom: old promises read');
        let r = all.filter((x) => f.every(([k, op, v]) => op === '==' ? x[k] === v : op === '>=' ? Number(x[k]) >= v : op === '<' ? Number(x[k]) < v : true));
        if (st.field) r = r.slice().sort((a, b) => st.desc ? b[st.field] - a[st.field] : a[st.field] - b[st.field]);
        r = r.slice(0, st.lim);
        return { size: r.length, docs: r.map((x) => ({ id: x.id, data: () => x })) };
      },
    };
    return self;
  };
  const db = {
    docs, bells: [],
    collection(n) {
      if (n === 'companies') return { doc: () => ({ collection: () => ({ get: async () => ({ docs: [] }) }) }) };
      if (n === 'phone_calls') return q(rows, n);
      if (n === 'notifications') return { add: async (v) => { db.bells.push(v); } };
      return q([], n);
    },
    doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }),
    collectionGroup: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }), 
    getAll: async (...r) => r.map(() => ({ exists: false, data: () => null })),
  };
  return db;
}

(async () => {
  process.env.CALL_CENTER_INGEST_ENABLED = 'false'; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false';
  const { runWatch } = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
  const push = async () => ({ sent: 1 });
  const ledgerOf = async (rows, opts) => {
    const db = mkDb(rows, opts);
    await runWatch({ db, nowMs: NOW, live: true, push });
    return db.docs['integrations/dailyLedger'];
  };

  console.log('A. the 8 pm ledger reads the same window as Home');
  let l = await ledgerOf([todayCall, call({ id: 'p20', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 20 * D, promises: joP })]);
  ok('a 20-day-old open promise is an open PERSON (was: "nothing fell through")', l && l.open === 1 && l.clear === false, JSON.stringify(l));
  l = await ledgerOf([todayCall, call({ id: 'p44', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 44 * D, promises: joP })]);
  ok('a 44-day-old open promise still counts', l && l.open === 1 && l.clear === false, JSON.stringify(l));
  l = await ledgerOf([todayCall, call({ id: 'k20', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 20 * D, promises: [{ who: 'jo', text: 'x', keptAtMs: NOW - D }] })]);
  ok('control: a 20-day-old promise stamped kept is clear', l && l.open === 0 && l.clear === true, JSON.stringify(l));
  l = await ledgerOf([todayCall, call({ id: 'o60', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 60 * D, promises: joP })]);
  ok('a 60-day-old promise is the "N old promises to review" row: not a person, but NOT all-clear',
    l && l.open === 0 && l.oldPromises === 1 && l.clear === false && l.anomalies.some((a) => /1 old promise to review/.test(a)), JSON.stringify(l));
  l = await ledgerOf([todayCall,
    call({ id: 'o60a', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 60 * D, promises: joP }),
    call({ id: 'o70a', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 70 * D, promises: joP }),
    call({ id: 'o80b', leadId: null, phoneDigits: '5135550177', startedAtMs: NOW - 80 * D, promises: joP }),
    call({ id: 'o90h', leadId: 'L5', phoneDigits: '8595550105', startedAtMs: NOW - 90 * D, promises: joP, handledAtMs: NOW - 50 * D })]);
  ok('old promises count PEOPLE (two calls, one customer = one), exclude handled', l && l.oldPromises === 2 && l.anomalies.some((a) => /2 old promises to review/.test(a)), JSON.stringify(l));
  l = await ledgerOf([todayCall, call({ id: 'o60', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 60 * D, promises: joP })], { failOld: true });
  ok('a FAILED old-promise read is a visible warning, never "nothing fell through"', l && l.clear === false && l.anomalies.some((a) => /could not check/i.test(a)), JSON.stringify(l));

  console.log('B. callWatch itself');
  const dbA = mkDb([todayCall, call({ id: 'p20', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 20 * D, promises: joP })]);
  dbA.docs['integrations/callWatch'].ladder = { 'call:p20': { n: 1, at: NOW - 4 * H } };
  const r = await runWatch({ db: dbA, nowMs: NOW, live: true, push });
  ok('a 20-day-old promise told once is on the re-tell ladder (it was pruned at day 14)', r.retold === 1, JSON.stringify(r));

  console.log('C. away mode cover list');
  const { loadOpenItems } = require(path.join(ROOT, 'functions/away-mode.js'))._internal;
  const items = await loadOpenItems(mkDb([call({ id: 'p20', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 20 * D, promises: joP }),
    call({ id: 'u20', leadId: 'L3', phoneDigits: '8595550103', startedAtMs: NOW - 20 * D, urgent: true }),
    call({ id: 'p50', leadId: 'L4', phoneDigits: '8595550104', startedAtMs: NOW - 50 * D, promises: joP })]), OWNER, NOW);
  ok('the backup is told about the 20-day-old promise (not the 20-day-old urgent: still 14 days; not the 50-day one)',
    items.length === 1 && items[0].key === 'lead:L2' && /promised/.test(items[0].why), JSON.stringify(items));

  console.log('D. Jo\'s own reply neither clears nor reopens (window anchors on the promise call)');
  const outbound = call({ id: 'reply', direction: 'outbound', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 2 * H });
  const live20 = call({ id: 'p20', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 20 * D, promises: joP });
  const old60 = call({ id: 'o60', leadId: 'L2', phoneDigits: '8595550102', startedAtMs: NOW - 60 * D, promises: joP });
  ok('a 20-day-old promise stays open after Jo calls that number back (same on Home)',
    W.callNeedsYou(live20, NOW, W.reachIndex([live20, outbound])) === true && HA.callNeedsYou(live20, NOW, HA.reachIndex([live20, outbound])) === true);
  ok('a 60-day-old promise is NOT reopened by his newer reply: still the old-promise row, on both sides',
    W.callNeedsYou(old60, NOW, W.reachIndex([old60, outbound])) === false && HA.callNeedsYou(old60, NOW, HA.reachIndex([old60, outbound])) === false
    && W.oldPromiseCount([old60, outbound], NOW) === 1 && HA.oldPromiseCount([old60, outbound], NOW) === 1);
  ok('a reply row never counts as an old promise itself', W.oldPromiseCount([outbound], NOW) === 0);

  console.log('E. one window: Home and the server cannot drift');
  ok('the server exports the window Home uses (45 days) and callNeedsYou reads it', W.PROMISE_WINDOW === 45 * D && W.CALL_WINDOW === 14 * D);
  const haSrc = fs.readFileSync(path.join(ROOT, 'docs/pro/js/home-attention.js'), 'utf8');
  const hm = haSrc.match(/const PROMISE_WINDOW = (\d+) \* DAY;/), hc = haSrc.match(/const CALL_WINDOW = (\d+) \* DAY;/);
  ok('home-attention.js declares the same two numbers (CALL_WINDOW / PROMISE_WINDOW)', hm && hc && Number(hm[1]) * D === W.PROMISE_WINDOW && Number(hc[1]) * D === W.CALL_WINDOW);
  const cwSrc = fs.readFileSync(path.join(ROOT, 'functions/call-watch.js'), 'utf8');
  const amSrc = fs.readFileSync(path.join(ROOT, 'functions/away-mode.js'), 'utf8');
  ok('callWatch and away mode query PROMISE_WINDOW (no second hand-typed number)',
    /nowMs - W\.PROMISE_WINDOW/.test(cwSrc) && /nowMs - W\.PROMISE_WINDOW/.test(amSrc) && !/since14\)\s*\.orderBy|'>=', since14\)\.orderBy/.test(cwSrc + amSrc));
  // rule parity over the new boundary: fuzz ages 0..100 days
  let diffs = 0, n = 0, oldDiffs = 0;
  const ages = []; for (let a = 0; a <= 100; a += 1) ages.push(a);
  ages.forEach((a) => [joP, [{ who: 'jo', text: 'x', keptAtMs: NOW - D }], [], [{ who: 'them', text: 'y' }]].forEach((promises) => [false, true].forEach((urgent) => [false, true].forEach((handled) => {
    const c = call({ id: 'f', startedAtMs: NOW - a * D, promises, urgent, handledAtMs: handled ? NOW - D : 0 });
    n++;
    if (W.callNeedsYou(c, NOW) !== HA.callNeedsYou(c, NOW)) diffs++;
    if ((W.oldPromiseCount([c], NOW) !== HA.oldPromiseCount([c], NOW))) oldDiffs++;
  }))));
  ok('callNeedsYou: 0 differences over ' + n + ' age x promise x urgent x handled rows', diffs === 0, diffs + ' differ');
  ok('oldPromiseCount: 0 differences on the same rows', oldDiffs === 0, oldDiffs + ' differ');

  console.log('F. a promise stamped kept stops nagging inside 14 days too');
  const kept5 = call({ id: 'k5', startedAtMs: NOW - 5 * D, promises: [{ who: 'jo', text: 'x', keptAtMs: NOW - D }] });
  ok('server: kept 5-day-old promise needs nobody', W.callNeedsYou(kept5, NOW) === false);
  ok('Home: same', HA.callNeedsYou(kept5, NOW) === false);
  const half = call({ id: 'h5', startedAtMs: NOW - 5 * D, promises: [{ who: 'jo', text: 'a', keptAtMs: NOW - D }, { who: 'jo', text: 'b' }] });
  ok('one kept, one still open: still needs Jo, both sides, reason names the promise', W.callNeedsYou(half, NOW) === true && HA.callNeedsYou(half, NOW) === true && W.reasonFor(half, NOW) === 'you promised something');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
