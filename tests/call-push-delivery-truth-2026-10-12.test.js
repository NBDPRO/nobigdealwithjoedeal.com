#!/usr/bin/env node
/**
 * Audit R2 (2026-10-12): push-functions.sendPushNotification RESOLVES
 * {sent:0} for "no device on file" / "every token failed". callWatch and
 * pushUrgent used to ignore the result, so an urgent call was marked told to
 * nobody. Pinned here:
 *   - pushUrgent does NOT stamp urgentPushedAtMs on sent:0 (callWatch tells it)
 *   - callWatch records lastPush and FAILS the run (heartbeat /fail) on sent:0
 *   - a push that reached a device still stamps / passes as before
 * Run: node tests/call-push-delivery-truth-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const H = 3600000, MIN = 60000;

(async () => {
  console.log('A. pushUrgent (source extracted from call-center.js)');
  const src = fs.readFileSync(path.join(ROOT, 'functions/call-center.js'), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('async function pushUrgent');
  const end = src.indexOf('\n}\n', start) + 3;
  const stamped = [], bells = [], warns = [];
  const sandbox = {
    process: { env: { CALL_WATCH_ENABLED: 'true' } },
    require: (m) => { if (m === './call-watch-logic') return require(path.join(ROOT, 'functions/call-watch-logic.js')); throw new Error('unexpected require ' + m); },
    L: { urgentPushText: () => ({ title: 'Urgent call — Maria', body: 'leak' }) },
    OWNER: 'owner1', COLLECTION: 'phone_calls', labelFor: async () => ({}),
    FieldValue: { serverTimestamp: () => 'TS' },
    logger: { warn: (...a) => warns.push(a), info() {} },
    Promise, Object, String, Number,
  };
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end) + '\nglobalThis.pushUrgent = pushUrgent;', sandbox);
  const db = { collection: (c) => ({ doc: (id) => ({ set: async (v) => { stamped.push([c, id, v]); } }), add: async (v) => { bells.push(v); } }) };
  const NOON = Date.parse('2026-10-01T16:00:00Z');
  const call = { id: 'cube_x', startedAtMs: NOON - 60000 };
  let r = await sandbox.pushUrgent({ db, d: { push: async () => ({ sent: 0, failed: 0, errors: [] }) }, call, notes: {}, leadName: '', nowMs: NOON });
  ok('push reached 0 devices -> not told: no stamp, returns false', r === false && stamped.length === 0, JSON.stringify(stamped));
  ok('...and no pretend bell entry either (callWatch writes it when it tells)', bells.length === 0);
  r = await sandbox.pushUrgent({ db, d: { push: async () => ({ sent: 1, failed: 0, errors: [] }) }, call, notes: {}, leadName: '', nowMs: NOON });
  ok('push reached a device -> stamped + bell, as before', r === true && stamped.length === 1 && stamped[0][2].urgentPushedAtMs === NOON && bells.length === 1);

  console.log('B. callWatch.runWatch');
  process.env.CALL_CENTER_INGEST_ENABLED = 'false'; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false';
  const { runWatch } = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
  const NOW = Date.parse('2026-10-02T18:00:00Z'); // 2 PM ET
  function fakeDb() {
    const docs = { 'integrations/callWatch': { lastCheckAtMs: NOW - 2 * H } };
    const calls = [{ id: 'u1', userId: 'x', urgent: true, contactName: 'Maria', startedAtMs: NOW - 20 * MIN, createdAtMs: NOW - 15 * MIN }];
    const snap = (rows) => ({ docs: rows.map((r) => ({ id: r.id, data: () => r })), forEach() {} });
    const q = (rows) => { const o = { where: () => o, orderBy: () => o, limit: () => o, get: async () => snap(rows) }; return o; };
    return {
      docs, added: [],
      collection(c) { if (c === 'phone_calls') return q(calls); if (c === 'notifications') return { add: async (v) => { this.added.push(v); } }; return q([]); },
      doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }),
      getAll: async () => [],
    };
  }
  let d1 = fakeDb();
  let threw = null;
  try { await runWatch({ db: d1, nowMs: NOW, live: true, push: async () => ({ sent: 0, failed: 0, errors: [] }) }); } catch (e) { threw = e; }
  ok('push reached 0 devices -> the run FAILS (heartbeat /fail)', !!threw && /0 devices/.test(threw.message), threw && threw.message);
  ok('...after the bell was written and the state saved (no re-alert loop)', d1.added.length === 1 && d1.docs['integrations/callWatch'].lastPush.sent === 0 && d1.docs['integrations/callWatch'].lastCheckAtMs === NOW);
  d1 = fakeDb(); threw = null;
  try { await runWatch({ db: d1, nowMs: NOW, live: true, push: async () => { throw new Error('fcm down'); } }); } catch (e) { threw = e; }
  ok('push throwing counts as unreached too', !!threw);
  d1 = fakeDb(); threw = null; let res;
  try { res = await runWatch({ db: d1, nowMs: NOW, live: true, push: async () => ({ sent: 2, failed: 0, errors: [] }) }); } catch (e) { threw = e; }
  ok('push reached a device -> normal alerted run, lastPush.sent recorded', !threw && res.state === 'alerted' && d1.docs['integrations/callWatch'].lastPush.sent === 2, threw && threw.message);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
