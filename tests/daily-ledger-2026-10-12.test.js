#!/usr/bin/env node
/**
 * The end-of-day "nothing fell through" ledger (audit 2026-10-12): the 20:00
 * callWatch run writes ONE unread bell entry per day (+ integrations/dailyLedger).
 * Run: node tests/daily-ledger-2026-10-12.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const H = 3600000, MIN = 60000, D = 86400000;
const EVE = Date.parse('2026-10-02T00:05:00Z') + 0; // 8:05 PM ET Oct 1
const NOW = Date.parse('2026-10-02T00:05:00Z');

(async () => {
  console.log('A. pure ledger');
  const today = (extra) => Object.assign({ startedAtMs: NOW - 3 * H, status: 'noted', direction: 'inbound', bucket: 'customer', leadId: 'L9', phoneDigits: '8595550101' }, extra);
  let l = W.dailyLedger([today({ id: 'a' }), today({ id: 'b', phoneDigits: '8595550102', leadId: 'L8' })], [], NOW, {});
  ok('2 calls, none open -> "nothing fell through"', l.calls === 2 && l.open === 0 && l.clear && /nothing fell through/.test(l.title), JSON.stringify(l));
  l = W.dailyLedger([today({ id: 'a', urgent: true })], [], NOW, {});
  ok('an open urgent call -> 1 person still open, not clear', l.open === 1 && !l.clear && /1 person still open/.test(l.title));
  l = W.dailyLedger([], [], NOW, {});
  ok('zero calls today is an anomaly (a quiet phone = a dead recorder)', !l.clear && l.anomalies.some((a) => /No calls were recorded today/.test(a)) && l.priority === 'high');
  l = W.dailyLedger([today({ id: 'o', urgent: true, startedAtMs: NOW - 5 * D })], [], NOW, {});
  ok('open > 3 days is called out', l.oldOpen === 1 && l.anomalies.some((a) => /more than 3 days/.test(a)));
  l = W.dailyLedger([today({ id: 'w', status: 'stored' })], [], NOW, { lastPush: { sent: 0 } });
  ok('waiting transcript + last push reached 0 phones both surface', l.waiting === 1 && l.anomalies.some((a) => /0 phones/.test(a)));
  l = W.dailyLedger([today({ id: 'p1', urgent: true }), today({ id: 'p2', urgent: true })], [], NOW, {});
  ok('one person with two open calls counts once', l.open === 1);

  const hidden = { '8595550101': { kind: 'spam', policy: 'hide' } };
  l = W.dailyLedger([today({ id: 'sp', urgent: true, phoneDigits: '8595550101', leadId: null })], [], NOW, {});
  ok('control (no labels): an urgent call from that number is an open person', l.open === 1);
  l = W.dailyLedger([today({ id: 'sp', urgent: true, phoneDigits: '8595550101', leadId: null })], [], NOW, { labels: hidden });
  ok('hidden SPAM number is NOT counted as an open person (label rule)', l.open === 0, JSON.stringify(l));
  l = W.dailyLedger([today({ id: 'pr', promises: [{ who: 'jo', text: 'x' }], phoneDigits: '8595550101' })], [], NOW, { labels: hidden });
  ok('...but a promise from Jo on a hidden number still counts', l.open === 1);

  // QA 2026-10-13: Home's list adds hidden numbers that came back (resurfacedNumbers); the ledger did not.
  const rez = (n) => Array.from({ length: n }, (_, i) => today({ id: 'rz' + i, phoneDigits: '8595550101', leadId: null, bucket: 'unknown', startedAtMs: NOW - (i + 1) * H }));
  const H2 = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
  const hiddenOld = { '8595550101': { kind: 'spam', policy: 'hide', updatedAtMs: NOW - 5 * D } };
  l = W.dailyLedger(rez(3), [], NOW, { labels: hiddenOld });
  ok('a hidden number ringing 3x in 24 h is an open person (Home counts it)', H2.callersNeedingYou(rez(3), NOW, hiddenOld) === 1 && l.open === 1 && !l.clear, JSON.stringify(l.title));
  l = W.dailyLedger(rez(2), [], NOW, { labels: hiddenOld });
  ok('control: two calls from the hidden number are NOT a burst -> not open (Home agrees)', H2.callersNeedingYou(rez(2), NOW, hiddenOld) === 0 && l.open === 0);
  l = W.dailyLedger(rez(3), [], NOW, { labels: Object.assign({}, hiddenOld, { '8595550101': { kind: 'spam', policy: 'hide', updatedAtMs: NOW - 5 * D, ackAtMs: NOW - 10 * 60000 } }) });
  ok('"Keep hidden" (ackAtMs after the calls) quiets it in the ledger too', l.open === 0);

  console.log('B. through runWatch');
  process.env.CALL_CENTER_INGEST_ENABLED = 'false'; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false';
  const { runWatch } = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
  function mk(rows) {
    const docs = { 'integrations/callWatch': { lastCheckAtMs: NOW - 2 * H } };
    const snap = (r) => ({ docs: r.map((x) => ({ id: x.id, data: () => x })) });
    const q = (r) => { const o = { where: () => o, orderBy: () => o, limit: () => o, get: async () => snap(r) }; return o; };
    const db = { docs, bells: [], collection(n) { if (n === 'phone_calls') return q(rows); if (n === 'notifications') return { add: async (v) => { db.bells.push(v); } }; return q([]); },
      doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }), getAll: async (...r) => r.map(() => ({ exists: false, data: () => null })) };
    return db;
  }
  const push = async () => ({ sent: 1 });
  let db = mk([Object.assign({ id: 'a', userId: 'x' }, today({}))]);
  await runWatch({ db, nowMs: NOW, live: true, push });
  const ledgerBells = db.bells.filter((b) => /Day check/.test(b.title));
  ok('the 8 PM run writes one unread Day-check bell + the ledger doc', ledgerBells.length === 1 && ledgerBells[0].read === false && db.docs['integrations/dailyLedger'].ymd === '2026-10-01' && db.docs['integrations/callWatch'].ledgerYmd === '2026-10-01', JSON.stringify(db.bells.map((b) => b.title)));
  await runWatch({ db, nowMs: NOW + 5 * MIN, live: true, push });
  ok('a second run the same evening does not write another', db.bells.filter((b) => /Day check/.test(b.title)).length === 1);
  const db2 = mk([]);
  await runWatch({ db: db2, nowMs: Date.parse('2026-10-01T18:00:00Z'), live: true, push });
  ok('a 2 PM run writes no ledger', !db2.bells.some((b) => /Day check/.test(b.title)));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
