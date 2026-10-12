'use strict';
/**
 * pipeline-canary.js — the daily self-test (2026-10-12 reliability audit).
 *
 * WHY: the Firestore emulator never enforces composite indexes, so every
 * "needs you" query can be green in CI and FAILED_PRECONDITION in prod (callWatch
 * did exactly that on its first run, 2026-10-02), and Home renders such a failure
 * as "all clear". Nothing exercised the real read path on a schedule.
 *
 * WHAT: once a day (the 10-minute dead-man calls this after 03:00 ET) it runs
 * the SAME queries Home / callWatch / the transcribe + sweep jobs run, against a
 * reserved synthetic user id so no real row can match, and does a full round
 * trip: write one synthetic urgent call, read it back through the Home query,
 * require that the shared "needs you" rule says it needs Jo, delete it. Owner
 * queries never see it (different userId), so it can never be counted, pushed
 * or shown. Any failure is returned for the dead-man to raise.
 *
 * It exercises the server's read path and the rule; it cannot exercise the
 * client's Firestore security rules (the admin SDK bypasses them).
 */
const W = require('./call-watch-logic');

const CANARY_USER = '__nbd_canary__';
const MIN = 60000;

/** deps: { db, nowMs }. Returns { ok, failed: [string], checks: n }. Never throws. */
async function run({ db, nowMs }) {
  const failed = [];
  let checks = 0;
  const since = nowMs - W.CALL_WINDOW;
  const q = (col) => db.collection(col).where('userId', '==', CANARY_USER);
  const queries = [
    ['phone_calls userId+startedAtMs desc (Home, Call Center)', () => q('phone_calls').orderBy('startedAtMs', 'desc').limit(200).get()],
    ['phone_calls userId+startedAtMs range (callWatch)', () => q('phone_calls').where('startedAtMs', '>=', since).orderBy('startedAtMs', 'desc').get()],
    ['phone_calls userId+status+startedAtMs desc (transcribe, sweep)', () => q('phone_calls').where('status', '==', 'noted').orderBy('startedAtMs', 'desc').limit(300).get()],
    ['phone_text_days userId+startedAtMs desc (Home)', () => q('phone_text_days').orderBy('startedAtMs', 'desc').limit(100).get()],
    ['phone_text_days userId+startedAtMs range (callWatch)', () => q('phone_text_days').where('startedAtMs', '>=', since).orderBy('startedAtMs', 'desc').get()],
    ['phone_text_days userId+status+startedAtMs desc (sweep)', () => q('phone_text_days').where('status', '==', 'noted').orderBy('startedAtMs', 'desc').limit(300).get()],
  ];
  for (const [name, fn] of queries) {
    checks++;
    try { await fn(); } catch (e) { failed.push('query failed: ' + name + ' — ' + String(e && (e.code || e.message) || e).slice(0, 120)); }
  }

  // Full round trip through the Home query + the shared rule.
  const id = 'canary_' + W.etYmd(nowMs);
  const ref = db.collection('phone_calls').doc(id);
  const row = { userId: CANARY_USER, companyId: CANARY_USER, urgent: true, status: 'noted', direction: 'inbound', bucket: 'unknown', contactName: 'NBD self-test', synthetic: true, startedAtMs: nowMs - MIN, createdAtMs: nowMs };
  checks++;
  try {
    await ref.set(row);
    const snap = await q('phone_calls').orderBy('startedAtMs', 'desc').limit(200).get();
    const found = snap.docs.map((d) => Object.assign({ id: d.id }, d.data())).find((r) => r.id === id);
    if (!found) failed.push('round trip: the synthetic call was written but did not come back through the Home query');
    else if (!W.callNeedsYou(found, nowMs)) failed.push('round trip: the "needs you" rule did not flag the synthetic urgent call');
  } catch (e) {
    failed.push('round trip failed — ' + String(e && (e.code || e.message) || e).slice(0, 120));
  } finally {
    try { await ref.delete(); } catch (e) { failed.push('could not remove the synthetic call ' + id); }
  }
  return { ok: failed.length === 0, failed, checks };
}

module.exports = { run, CANARY_USER };
