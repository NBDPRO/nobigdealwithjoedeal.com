#!/usr/bin/env node
/**
 * The re-tell ladder (audit R1, 2026-10-12): an urgent call / a promise Jo made
 * that is still open is told again on the next callWatch runs (short ladder),
 * and NEVER after it is handled, task-done or snoozed with a date.
 * Run: node tests/call-ladder-2026-10-12.test.js
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
const H = 3600000, MIN = 60000;
const T0 = Date.parse('2026-10-02T14:00:00Z'); // 10 AM ET

(async () => {
  console.log('A. pure ladder');
  const urgent = { id: 'u', urgent: true, contactName: 'Maria', startedAtMs: T0 - 10 * MIN, leadId: 'L1' };
  const promise = { id: 'p', promises: [{ who: 'jo', text: 'send quote' }], contactName: 'Bob', startedAtMs: T0 - 10 * MIN };
  const meh = { id: 'm', bucket: 'unknown', status: 'noted', startedAtMs: T0 - 10 * MIN };
  const c = [urgent, promise, meh];
  ok('only high-value items are candidates (not a plain unknown number)', W.ladderCandidates(c, [], T0).map((x) => x.id).sort().join() === 'call:p,call:u');
  let L = W.nextLadder(c, [], {}, ['call:u', 'call:p', 'call:m'], [], true, T0);
  ok('first tell opens rung 1 for high-value items only', L['call:u'].n === 1 && L['call:p'].n === 1 && !L['call:m']);
  ok('not told again inside the gap', W.ladderRetells(c, [], L, T0 + 30 * MIN).length === 0);
  let re = W.ladderRetells(c, [], L, T0 + 2 * H);
  ok('2 h later still open -> both re-told (rung 2), worded "still open"', re.length === 2 && re.every((r) => r.rung === 2 && /still open/.test(r.why)), JSON.stringify(re));
  L = W.nextLadder(c, [], L, [], re, true, T0 + 2 * H);
  re = W.ladderRetells(c, [], L, T0 + 4 * H);
  ok('4 h: rung 3 (the last)', re.length === 2 && re.every((r) => r.rung === 3));
  L = W.nextLadder(c, [], L, [], re, true, T0 + 4 * H);
  ok('6 h: ladder exhausted -> the morning brief takes over, no more pushes', W.ladderRetells(c, [], L, T0 + 6 * H).length === 0);

  console.log('B. it stops when Jo deals with it');
  L = W.nextLadder(c, [], {}, ['call:u', 'call:p'], [], true, T0);
  const handled = [Object.assign({}, urgent, { handledAtMs: T0 + MIN }), promise];
  ok('handled -> not re-told', W.ladderRetells(handled, [], L, T0 + 2 * H).map((r) => r.id).join() === 'call:p');
  ok('task done -> not re-told', W.ladderRetells([Object.assign({}, urgent, { taskDone: true }), promise], [], L, T0 + 2 * H).map((r) => r.id).join() === 'call:p');
  const tomorrow = '2026-10-03';
  ok('snoozed with a date (call) -> not re-told', W.ladderRetells([Object.assign({}, urgent, { snoozeUntilYmd: tomorrow }), promise], [], L, T0 + 2 * H).map((r) => r.id).join() === 'call:p');
  ok('snoozed by moving its task -> not re-told', W.ladderRetells([Object.assign({}, urgent, { taskDueYmd: tomorrow }), promise], [], L, T0 + 2 * H).map((r) => r.id).join() === 'call:p');
  ok('...and a handled item leaves the persisted map', !('call:u' in W.nextLadder(handled, [], L, [], [], true, T0 + 2 * H)));

  console.log('C. the immediate urgent push counts as rung 1');
  const pushed = Object.assign({}, urgent, { urgentPushedAtMs: T0 });
  ok('urgentPushedAtMs seeds the ladder (no duplicate first tell, re-told at +2h)', W.ladderRetells([pushed], [], {}, T0 + 2 * H).length === 1 && W.ladderRetells([pushed], [], {}, T0 + 30 * MIN).length === 0);

  console.log('D. a push that reached nobody does not use up a rung');
  L = W.nextLadder(c, [], {}, ['call:u'], [], false, T0);
  ok('unreached first tell -> n:0, retried next run', L['call:u'].n === 0 && W.ladderRetells(c, [], L, T0 + 2 * H).some((r) => r.id === 'call:u'));

  console.log('D2. labels (contact labels, 2026-10-12): the ladder follows the same rule as the first tell');
  const num = { phoneDigits: '8595550177' };
  const lab = (kind, policy) => ({ '8595550177': { kind, policy } });
  const ids = (rows, l) => W.ladderCandidates(rows, [], T0, l).map((x) => x.id).join();
  ok('no label: urgent is a candidate', ids([Object.assign({}, urgent, num, { id: 'lb' })], null) === 'call:lb');
  ok('hidden SPAM number: urgent does NOT climb the ladder', ids([Object.assign({}, urgent, num, { id: 'lb' })], lab('spam', 'hide')) === '');
  ok('hidden PERSONAL number: urgent still breaks through', ids([Object.assign({}, urgent, num, { id: 'lb' })], lab('personal', 'hide')) === 'call:lb');
  ok('quiet number: urgent alone does not, a Jo promise does', ids([Object.assign({}, urgent, num, { id: 'lb' })], lab('sub', 'quiet')) === '' && ids([Object.assign({}, promise, num, { id: 'lp' })], lab('sub', 'quiet')) === 'call:lp');
  ok('hidden spam number with a promise from Jo still surfaces', ids([Object.assign({}, promise, num, { id: 'lp' })], lab('spam', 'hide')) === 'call:lp');

  console.log('E. through runWatch (fake Firestore)');
  process.env.CALL_CENTER_INGEST_ENABLED = 'false'; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false';
  const { runWatch } = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
  function mk(rows) {
    const docs = { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H } };
    const snap = (r) => ({ docs: r.map((x) => ({ id: x.id, data: () => x })) });
    const q = (r) => { const o = { where: () => o, orderBy: () => o, limit: () => o, get: async () => snap(r) }; return o; };
    const db = {
      docs, bells: [],
      collection(n) { if (n === 'phone_calls') return q(db.rows); if (n === 'notifications') return { add: async (v) => { db.bells.push(v); } }; return q([]); },
      doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }),
      getAll: async (...refs) => refs.map(() => ({ exists: false, data: () => null })),
      rows,
    };
    return db;
  }
  const row = { id: 'ux', userId: 'x', urgent: true, contactName: 'Maria', startedAtMs: T0 - 5 * MIN, createdAtMs: T0 - 5 * MIN, status: 'noted' };
  const db = mk([row]);
  const pushes = [];
  const push = async (...a) => { pushes.push(a); return { sent: 1 }; };
  const r1 = await runWatch({ db, nowMs: T0, live: true, push });
  const r2 = await runWatch({ db, nowMs: T0 + 2 * H, live: true, push });
  const r3 = await runWatch({ db, nowMs: T0 + 4 * H, live: true, push });
  const r4 = await runWatch({ db, nowMs: T0 + 6 * H, live: true, push });
  ok('run 1 tells; runs 2 and 3 re-tell; run 4 is quiet', r1.state === 'alerted' && r2.state === 'alerted' && r2.retold === 1 && r3.state === 'alerted' && r4.state === 'quiet', [r1, r2, r3, r4].map((r) => r.state + ':' + r.retold).join(' '));
  ok('re-tell says "still open"; the last rung is sticky', /still open/.test(pushes[1][2]) && pushes[2][3].requireInteraction === 'true' && !pushes[1][3].requireInteraction, JSON.stringify(pushes.map((p) => [p[2], p[3]])));
  const db2 = mk([row]);
  await runWatch({ db: db2, nowMs: T0, live: true, push });
  db2.rows = [Object.assign({}, row, { handledAtMs: T0 + H })];
  const n0 = pushes.length;
  const h2 = await runWatch({ db: db2, nowMs: T0 + 2 * H, live: true, push });
  ok('handled between runs -> nothing re-told', h2.state === 'quiet' && pushes.length === n0, JSON.stringify(h2));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
