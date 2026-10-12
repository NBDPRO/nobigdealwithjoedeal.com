#!/usr/bin/env node
/**
 * Daily self-test canary (audit 2026-10-12): functions/pipeline-canary.js, run
 * once a day by the 10-minute dead-man. It must (a) catch a missing composite
 * index (the emulator never does), (b) catch the shared "needs you" rule
 * drifting, (c) never touch an owner row, (d) clean up after itself.
 * Run: node tests/pipeline-canary-2026-10-12.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'functions/pipeline-canary.js'));
const D = require(path.join(ROOT, 'functions/pipeline-deadman.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const NOW = Date.parse('2026-10-02T14:40:00Z'); // 10:40 AM ET

/** In-memory Firestore that honours where(==, >=), orderBy-desc, limit and can fail named query shapes. */
function fakeDb(opts) {
  const o = opts || {};
  const store = new Map(); // 'col/id' -> data
  const docs = {};         // integrations docs
  function query(col) {
    const st = { col, eq: [], gte: null, order: null, lim: null };
    const api = {
      where(f, op, v) { if (op === '==') st.eq.push([f, v]); else if (op === '>=') st.gte = [f, v]; return api; },
      orderBy(f) { st.order = f; return api; },
      limit(n) { st.lim = n; return api; },
      async get() {
        const shape = col + ':' + st.eq.map((e) => e[0]).join('+') + (st.gte ? '+range' : '') + (st.order ? '+order' : '');
        if (o.failShape && shape === o.failShape) { const e = new Error('9 FAILED_PRECONDITION: The query requires an index'); e.code = 9; throw e; }
        let rows = [...store.entries()].filter(([k]) => k.startsWith(col + '/')).map(([k, v]) => ({ id: k.slice(col.length + 1), data: () => v, v }));
        rows = rows.filter((r) => st.eq.every(([f, v]) => r.v[f] === v) && (!st.gte || r.v[st.gte[0]] >= st.gte[1]));
        if (st.order) rows.sort((a, b) => b.v[st.order] - a.v[st.order]);
        if (st.lim) rows = rows.slice(0, st.lim);
        return { docs: rows, size: rows.length };
      },
    };
    return api;
  }
  return {
    store, docs,
    collection(col) {
      return Object.assign(query(col), {
        doc: (id) => ({
          set: async (v) => { if (o.failWrite) throw new Error('write denied'); store.set(col + '/' + id, v); },
          delete: async () => { if (o.failDelete) throw new Error('delete denied'); store.delete(col + '/' + id); },
        }),
      });
    },
    doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }),
  };
}

(async () => {
  console.log('A. the canary');
  let db = fakeDb();
  db.store.set('phone_calls/real1', { userId: '1phDvAVXHSg82wDLegAbQFq14Ci1', urgent: true, startedAtMs: NOW - 1000, status: 'noted' });
  let r = await C.run({ db, nowMs: NOW });
  ok('healthy read path: ok, 7 checks, nothing left behind', r.ok === true && r.checks === 7 && r.failed.length === 0 && ![...db.store.keys()].some((k) => /canary_/.test(k)), JSON.stringify(r));
  ok('never touches an owner row', db.store.has('phone_calls/real1') && db.store.size === 1);
  db = fakeDb({ failShape: 'phone_calls:userId+status+order' });
  r = await C.run({ db, nowMs: NOW });
  ok('a query that needs an index nobody deployed is caught and named', r.ok === false && r.failed.length === 1 && /status\+startedAtMs desc \(transcribe, sweep\)/.test(r.failed[0]) && /FAILED_PRECONDITION|9/.test(r.failed[0]), JSON.stringify(r));
  db = fakeDb({ failShape: 'phone_calls:userId+order' });
  r = await C.run({ db, nowMs: NOW });
  ok('the Home query failing also fails the round trip (a failed read is not "no calls")', r.ok === false && r.failed.some((f) => /round trip failed/.test(f)) && r.failed.some((f) => /Home, Call Center/.test(f)));
  db = fakeDb({ failDelete: true });
  r = await C.run({ db, nowMs: NOW });
  ok('a cleanup failure is reported', r.ok === false && r.failed.some((f) => /could not remove/.test(f)));

  console.log('B. through the dead-man');
  const env = { CALL_WATCH_ENABLED: 'true', CALL_CENTER_INGEST_ENABLED: 'true', CALL_CENTER_TRANSCRIBE_ENABLED: 'true' };
  const base = () => {
    const d = fakeDb();
    d.docs['integrations/callWatch'] = { lastCheckAtMs: NOW - 40 * 60000 };
    d.docs['integrations/callCenter'] = { lastRunAtMs: NOW - 10 * 60000, lastTranscribeAtMs: NOW - 10 * 60000 };
    d.store.set('phone_calls/n1', { userId: '1phDvAVXHSg82wDLegAbQFq14Ci1', startedAtMs: NOW - 3600000 });
    return d;
  };
  const notes = [];
  let d = base();
  let out = await D.run({ db: d, nowMs: NOW, live: true, env, canary: C.run, notify: async (t, b) => { notes.push([t, b]); } });
  ok('first run of the day runs the canary and records the verdict', out.problems.length === 0 && d.docs['integrations/pipelineHealth'].canary.ok === true && d.docs['integrations/pipelineHealth'].canary.ymd === '2026-10-02');
  let calls = 0;
  await D.run({ db: d, nowMs: NOW + 10 * 60000, live: true, env, canary: async () => { calls++; return { ok: true, failed: [], checks: 1 }; }, notify: async () => {} });
  ok('the same ET day it does not run again (verdict carried forward)', calls === 0 && d.docs['integrations/pipelineHealth'].canary.checks === 7);
  d = base();
  const bad = fakeDb({ failShape: 'phone_text_days:userId+order' });
  Object.assign(bad.docs, d.docs); d.store.forEach((v, k) => bad.store.set(k, v));
  out = await D.run({ db: bad, nowMs: NOW, live: true, env, canary: C.run, notify: async (t, b) => { notes.push([t, b]); } });
  ok('a failing canary becomes a problem (so the heartbeat fails) and Jo is told', out.problems.join() === 'canary_failed' && notes.some((n) => /self-test failed/.test(n[1])), JSON.stringify(out) + JSON.stringify(notes));
  d = base();
  out = await D.run({ db: d, nowMs: Date.parse('2026-10-02T06:00:00Z'), live: true, env, canary: async () => { calls = 99; return { ok: true, failed: [], checks: 1 }; }, notify: async () => {} });
  ok('not before 03:00 ET, and never on a dry run', calls !== 99);
  calls = 0;
  await D.run({ db: base(), nowMs: NOW, live: false, env, canary: async () => { calls++; return { ok: true }; }, notify: async () => {} });
  ok('dry run does not write a synthetic call', calls === 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
