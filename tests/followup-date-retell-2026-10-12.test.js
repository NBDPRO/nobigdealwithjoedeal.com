#!/usr/bin/env node
/**
 * Audit R7 (2026-10-12): a follow-up date that comes due AFTER the call was
 * noted and told is pushed on its day. Before, newNeeds only admitted rows that
 * arrived after the last check, so "call back Friday" was never pushed Friday.
 * Run: node tests/followup-date-retell-2026-10-12.test.js
 */
'use strict';
const path = require('path');
const W = require(path.join(__dirname, '..', 'functions/call-watch-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const H = 3600000, D = 86400000;
const FRI_8AM = Date.parse('2026-10-02T12:00:00Z');       // 8 AM ET Friday
const THU_8PM = Date.parse('2026-10-02T00:00:00Z') ;      // 8 PM ET Thursday
const call = { id: 'c1', contactName: 'Bob', leadId: 'L1', followUpDate: '2026-10-02', startedAtMs: FRI_8AM - 3 * D, createdAtMs: FRI_8AM - 3 * D, notedAtMs: FRI_8AM - 3 * D };

(async () => {
  console.log('A. newNeeds');
  let n = W.newNeeds([call], [], [], THU_8PM, FRI_8AM);
  ok('noted 3 days ago, date came due overnight -> told on Friday morning', n.length === 1 && n[0].why === 'follow-up due' && /#due:2026-10-02$/.test(n[0].tellId), JSON.stringify(n));
  n = W.newNeeds([call], [], [], FRI_8AM, FRI_8AM + 2 * H);
  ok('the next check the same day does not repeat it', n.length === 0);
  n = W.newNeeds([Object.assign({}, call, { followUpDate: '2026-10-09' })], [], [], THU_8PM, FRI_8AM);
  ok('a date still in the future is not told', n.length === 0);
  n = W.newNeeds([Object.assign({}, call, { handledAtMs: FRI_8AM - H })], [], [], THU_8PM, FRI_8AM);
  ok('handled -> not told', n.length === 0);
  n = W.newNeeds([Object.assign({}, call, { taskDone: true })], [], [], THU_8PM, FRI_8AM);
  ok('task done -> not told', n.length === 0);
  const tx = Object.assign({}, call, { id: 't1' });
  n = W.newNeeds([], [tx], [], THU_8PM, FRI_8AM);
  ok('a text day with a follow-up date comes due the same way', n.length === 1 && /^text:t1#due:/.test(n[0].tellId));
  n = W.newNeeds([Object.assign({}, call, { notedAtMs: FRI_8AM - H, createdAtMs: FRI_8AM - H, startedAtMs: FRI_8AM - H })], [], [], THU_8PM, FRI_8AM);
  ok('a brand-new call already due keeps its plain id (no double tell)', n.length === 1 && n[0].tellId === undefined);

  console.log('B. through runWatch (fake Firestore, told-set honoured)');
  process.env.CALL_CENTER_INGEST_ENABLED = 'false'; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false';
  const { runWatch } = require(path.join(__dirname, '..', 'functions/call-watch.js'))._internal;
  const rows = [Object.assign({ userId: 'x' }, call)];
  const docs = { 'integrations/callWatch': { lastCheckAtMs: THU_8PM, toldIds: ['call:c1'] } };   // told when first noted
  const snap = (r) => ({ docs: r.map((x) => ({ id: x.id, data: () => x })) });
  const q = (r) => { const o = { where: () => o, orderBy: () => o, limit: () => o, get: async () => snap(r) }; return o; };
  const bells = [];
  const db = { collection(c) { if (c === 'phone_calls') return q(rows); if (c === 'notifications') return { add: async (v) => { bells.push(v); } }; return q([]); },
    doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }), getAll: async (...r) => r.map(() => ({ exists: false })) };
  const pushes = [];
  const push = async (...a) => { pushes.push(a); return { sent: 1 }; };
  const r1 = await runWatch({ db, nowMs: FRI_8AM, live: true, push });
  ok('Friday 8 AM: the already-told call is pushed again because its date came due', r1.state === 'alerted' && pushes.length === 1 && /follow-up due/.test(pushes[0][2]), JSON.stringify(r1));
  const r2 = await runWatch({ db, nowMs: FRI_8AM + 2 * H, live: true, push });
  ok('10 AM: not repeated', r2.state === 'quiet' && pushes.length === 1, JSON.stringify(r2));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
