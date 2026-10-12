#!/usr/bin/env node
/**
 * pipeline-deadman (2026-10-12 reliability audit R3/R4): the independent check
 * that callWatch and the copy/transcribe jobs have not stopped.
 * functions/pipeline-deadman.js, hooked into leadAlertWatchdog.
 * Run: node tests/pipeline-deadman-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'functions/pipeline-deadman.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const MIN = 60000, H = 3600000;
// Friday 2026-10-02 (EDT, UTC-4). ET clock times -> epoch ms.
const et = (hhmm) => Date.parse('2026-10-02T' + hhmm + ':00-04:00');

(async () => {
  console.log('A. which callWatch slot is due');
  ok('10:29 ET: the 10:00 slot is not due yet (30 min grace) -> 08:00', D.expectedWatchSlotMs(et('10:29')) === et('08:00'));
  ok('10:31 ET -> the 10:00 slot', D.expectedWatchSlotMs(et('10:31')) === et('10:00'));
  ok('15:45 ET -> the 14:00 slot (even hours only)', D.expectedWatchSlotMs(et('15:45')) === et('14:00'));
  ok('22:00 ET -> still the 20:00 slot', D.expectedWatchSlotMs(et('22:00')) === et('20:00'));
  ok('07:50 ET -> nothing due (callWatch is silent overnight)', D.expectedWatchSlotMs(et('07:50')) === null);

  console.log('B. the rules');
  const on = { watch: true, ingest: true, transcribe: true };
  const healthy = { watch: { lastCheckAtMs: et('10:00') + 5000 }, cc: { lastRunAtMs: et('10:20'), lastTranscribeAtMs: et('10:20') }, now: et('10:40'), gates: on };
  ok('healthy: nothing to say', D.deadManProblems(healthy).length === 0);
  const noWatch = Object.assign({}, healthy, { watch: { lastCheckAtMs: et('08:00') + 5000 } });
  const p1 = D.deadManProblems(noWatch);
  ok('callWatch missed its 10:00 slot -> callwatch_not_running', p1.length === 1 && p1[0].key === 'callwatch_not_running', JSON.stringify(p1));
  ok('...and the text names the overdue slot', /10:00 AM/.test(p1[0].text), p1[0].text);
  ok('callWatch gate OFF (dry-run deployment) -> a missing run IS the problem only when the gate is on',
    D.deadManProblems(Object.assign({}, noWatch, { gates: { watch: false, ingest: true, transcribe: true } })).length === 0);
  ok('no callWatch doc at all -> problem', D.deadManProblems(Object.assign({}, healthy, { watch: null })).some((p) => p.key === 'callwatch_not_running'));
  const stale = D.deadManProblems(Object.assign({}, healthy, { cc: { lastRunAtMs: et('08:30'), lastTranscribeAtMs: et('08:30') } }));
  ok('ingest + transcribe silent for 2h+ -> both named', stale.map((p) => p.key).sort().join() === 'ingest_not_running,transcribe_not_running', JSON.stringify(stale));
  ok('paused pipeline is not a problem', D.deadManProblems(Object.assign({}, healthy, { cc: { paused: true } })).length === 0);

  console.log('C. runner against an in-memory Firestore');
  function fakeDb(docs) {
    const added = [];
    return {
      added, docs,
      doc: (p) => ({
        get: async () => ({ exists: p in docs, data: () => docs[p] }),
        set: async (v) => { docs[p] = v; },
      }),
      collection: (c) => ({ add: async (v) => { added.push({ c, v }); } }),
    };
  }
  const base = () => ({ 'integrations/callWatch': { lastCheckAtMs: et('08:00') + 1000 }, 'integrations/callCenter': { lastRunAtMs: et('10:20'), lastTranscribeAtMs: et('10:20') } });
  const env = { CALL_WATCH_ENABLED: 'true', CALL_CENTER_INGEST_ENABLED: 'true', CALL_CENTER_TRANSCRIBE_ENABLED: 'true' };
  let sent = [];
  const notify = async (t, b) => { sent.push([t, b]); };
  let db = fakeDb(base());
  let r = await D.run({ db, nowMs: et('10:40'), live: true, env, notify });
  ok('stale callWatch inside watch hours: reported, told once, state recorded',
    r.problems.join() === 'callwatch_not_running' && r.told.length === 1 && sent.length === 1 && db.docs['integrations/pipelineHealth'].problems[0] === 'callwatch_not_running', JSON.stringify(r));
  r = await D.run({ db, nowMs: et('10:50'), live: true, env, notify });
  ok('10 minutes later: still a problem (so the run can fail) but not told again', r.problems.length === 1 && r.told.length === 0 && sent.length === 1, JSON.stringify(r));
  r = await D.run({ db, nowMs: et('16:50'), live: true, env, notify });
  ok('6+ hours later: told again', r.told.includes('callwatch_not_running') && sent.length === 2, JSON.stringify(r));
  sent = []; db = fakeDb(base());
  r = await D.run({ db, nowMs: Date.parse('2026-10-03T03:00:00-04:00'), live: true, env: Object.assign({}, env, { CALL_WATCH_ENABLED: 'false' }), notify });
  ok('overnight: ingest silent is reported but no 3 a.m. push', r.problems.length === 1 && r.problems[0] === 'ingest_not_running' || r.problems.includes('ingest_not_running'));
  ok('...nothing sent overnight', sent.length === 0);
  db = fakeDb(base()); sent = [];
  r = await D.run({ db, nowMs: et('10:40'), live: false, env, notify });
  ok('dry run: computes, tells nothing, writes nothing', r.problems.length === 1 && sent.length === 0 && !db.docs['integrations/pipelineHealth']);
  const broken = { doc: () => ({ get: async () => { throw new Error('unavailable'); } }), collection: () => ({}) };
  r = await D.run({ db: broken, nowMs: et('10:40'), live: true, env, notify });
  ok('a failed read is itself a problem, not silence', r.state === 'read_failed' && r.problems[0] === 'deadman_read_failed');

  console.log('C2. the phone stopped uploading (ingest healthy, nothing new)');
  const fresh = { watch: { lastCheckAtMs: et('10:00') + 5000 }, cc: { lastRunAtMs: et('10:20'), lastTranscribeAtMs: et('10:20') }, now: et('10:40'), gates: on };
  ok('newest recording 40 h old -> no_new_recordings', D.deadManProblems(Object.assign({}, fresh, { newestCallMs: et('10:40') - 40 * H })).map((p) => p.key).join() === 'no_new_recordings');
  ok('newest recording 5 h old -> fine', D.deadManProblems(Object.assign({}, fresh, { newestCallMs: et('10:40') - 5 * H })).length === 0);
  ok('unreadable / never-any -> says nothing (not a false alarm)', D.deadManProblems(Object.assign({}, fresh, { newestCallMs: undefined })).length === 0 && D.deadManProblems(Object.assign({}, fresh, { newestCallMs: 0 })).length === 0);
  function fakeDb2(newest) {
    const docs = { 'integrations/callWatch': { lastCheckAtMs: et('10:00') + 1000 }, 'integrations/callCenter': { lastRunAtMs: et('10:20'), lastTranscribeAtMs: et('10:20') } };
    const q = { where: () => q, orderBy: () => q, limit: () => q, get: async () => ({ docs: newest == null ? [] : [{ data: () => ({ startedAtMs: newest }) }] }) };
    return { docs, doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }), collection: () => q };
  }
  r = await D.run({ db: fakeDb2(et('10:40') - 50 * H), nowMs: et('10:40'), live: true, env, notify: async () => {} });
  ok('runner reads the newest phone_calls row and reports a silent phone', r.problems.join() === 'no_new_recordings', JSON.stringify(r));
  r = await D.run({ db: fakeDb2(et('10:40') - 2 * H), nowMs: et('10:40'), live: true, env, notify: async () => {} });
  ok('control: a recent recording -> all clear', r.problems.length === 0 && r.state === 'ok', JSON.stringify(r));

  console.log('D. wired into the 10-minute watchdog');
  const src = fs.readFileSync(path.join(ROOT, 'functions/lead-alert-watchdog.js'), 'utf8').replace(/\r\n/g, '\n');
  ok('leadAlertWatchdog runs the dead-man and fails the heartbeat on a problem',
    /require\('\.\/pipeline-deadman'\)\.run\(/.test(src) && /throw new Error\('pipelineDeadMan: '/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
