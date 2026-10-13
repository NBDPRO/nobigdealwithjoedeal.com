#!/usr/bin/env node
/**
 * Needs-you lifecycle audit (2026-10-13): fixes found by the volume
 * simulation (tests/needs-you-volume-sim-2026-10-13.test.js). Each check was
 * run RED on main first, then the fix, then break-tested (revert -> red).
 *
 *   1  A call a callWatch run saw while its transcript was still pending
 *      ('stored', unknown number) was told as "unknown number" and its tell id
 *      ('call:<id>') was used up: when the transcript landed an urgent call
 *      (after hours) or a promise of Jo's was never told, and it never got on
 *      the re-tell ladder. Now the stored-state tell has its own id
 *      ('call:<id>#stored'); the noted call is told again ONLY when it became
 *      high-value (urgent / promise / due / insurance), never as a repeat of
 *      "unknown number".
 *  2   The ladder's last email promised "the morning brief lists anything
 *      still open". It does not (an urgent call on a customer with no follow-up
 *      task is in neither the brief nor the sweep), so the promise is gone; the
 *      email now points at the Call Center / Today, which do list everything.
 *
 * Fake db honours where / orderBy / limit. Nothing is sent.
 * Run: node tests/needs-you-lifecycle-fixes-2026-10-13.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'functions/call-watch-logic.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' - ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
const MIN = 60000, H = 3600000;
const OWNER = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const T0 = Date.parse('2026-10-05T16:00:00Z');          // 12:00 ET, a callWatch run
const joPromise = [{ who: 'jo', text: 'send the quote' }];

function mkDb(rows) {
  const docs = { 'integrations/callWatch': { lastCheckAtMs: T0 - 2 * H } };
  const val = (x) => (x instanceof Date ? x.getTime() : x);
  const q = (all) => {
    const f = []; let lim = Infinity, field = null, desc = false;
    const self = {
      where(k, op, v) { f.push([k, op, val(v)]); return self; },
      orderBy(k, d) { field = k; desc = d === 'desc'; return self; },
      limit(n) { lim = n; return self; },
      async get() {
        let r = all.filter((x) => f.every(([k, op, v]) => { const a = val(x[k]); if (op === '==') return a === v; if (a == null) return false; return op === '>=' ? a >= v : op === '<' ? a < v : true; }));
        if (field) r = r.slice().sort((a, b) => (desc ? (val(b[field]) || 0) - (val(a[field]) || 0) : (val(a[field]) || 0) - (val(b[field]) || 0)));
        r = r.slice(0, lim);
        return { docs: r.map((x) => ({ id: x.id, data: () => x })) };
      },
    };
    return self;
  };
  const db = {
    docs, bells: [], rows,
    collection(n) {
      if (n === 'phone_calls') return q(db.rows);
      if (n === 'notifications') return { add: async (v) => { db.bells.push(v); } };
      if (n === 'companies') return { doc: () => ({ collection: () => ({ get: async () => ({ docs: [] }) }) }) };
      return q([]);
    },
    doc: (p) => ({ get: async () => ({ exists: p in docs, data: () => docs[p] }), set: async (v) => { docs[p] = v; } }),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
  };
  return db;
}
const base = (o) => Object.assign({ id: 'cube_s1', userId: OWNER, direction: 'inbound', bucket: 'unknown', phoneDigits: '5135550142', contactName: 'Unknown caller', startedAtMs: T0 - 15 * MIN, createdAtMs: T0 - 5 * MIN }, o);

(async () => {
  process.env.CALL_CENTER_INGEST_ENABLED = 'false'; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false';
  const { runWatch } = require(path.join(ROOT, 'functions/call-watch.js'))._internal;
  const run = async (db, now, pushes) => runWatch({ db, nowMs: now, live: true, push: async (u, title, body) => { pushes.push(body); return { sent: 1 }; } });

  console.log('1. a stored call told as "unknown number" is told again when its transcript makes it high-value');
  // run 1 (12:00 ET): the call is ingested but not transcribed yet
  const storedRow = base({ status: 'stored' });
  const db = mkDb([storedRow]);
  const pushes = [];
  const r1 = await run(db, T0, pushes);
  ok('run 1 tells the stored call (as an unknown number)', r1.state === 'alerted' && pushes.length === 1 && /unknown number/.test(pushes[0]), pushes);
  // transcript lands between runs: Jo promised something (not urgent), 12:30 ET
  db.rows = [Object.assign({}, storedRow, { status: 'noted', notedAtMs: T0 + 30 * MIN, promises: joPromise, callType: 'lead', summary: 'wants a roof quote' })];
  const r2 = await run(db, T0 + 2 * H, pushes);
  ok('run 2 tells the promise (it was swallowed before: its tell id was used up)', r2.state === 'alerted' && pushes.length === 2 && /promised/.test(pushes[1]), { state: r2.state, pushes });
  const r3 = await run(db, T0 + 4 * H, pushes);
  ok('run 3 is the first re-tell: it climbs the ladder like any promise', r3.state === 'alerted' && /still open/.test(pushes[2] || ''), { state: r3.state, pushes });

  console.log('2. controls');
  // a stored call whose transcript is just an ordinary unknown number: NO second "unknown number"
  const db2 = mkDb([storedRow]);
  const p2 = [];
  await run(db2, T0, p2);
  db2.rows = [Object.assign({}, storedRow, { status: 'noted', notedAtMs: T0 + 30 * MIN, promises: [], callType: 'lead', summary: 'asked about gutters' })];
  const q2 = await run(db2, T0 + 2 * H, p2);
  ok('noted, still just an unknown number -> not told a second time', q2.state === 'quiet' && p2.length === 1, { state: q2.state, p2 });
  // an urgent call pushed immediately at transcribe time is not told again by callWatch
  const db3 = mkDb([storedRow]);
  const p3 = [];
  await run(db3, T0, p3);
  db3.rows = [Object.assign({}, storedRow, { status: 'noted', notedAtMs: T0 + 30 * MIN, urgent: true, urgentPushedAtMs: T0 + 30 * MIN, callType: 'lead' })];
  const q3 = await run(db3, T0 + 2 * H, p3);
  ok('urgent + already pushed immediately -> callWatch does not tell it a second time as new (ladder re-tells it later)', p3.length === 1 || (p3.length === 2 && /still open/.test(p3[1])), p3);
  // the call that was never seen stored (transcript beat the run) is told exactly once, as before
  const db4 = mkDb([base({ status: 'noted', notedAtMs: T0 - 5 * MIN, promises: joPromise, callType: 'lead' })]);
  const p4 = [];
  const q4 = await run(db4, T0, p4);
  ok('a call first seen already noted is told once, as before', q4.state === 'alerted' && p4.length === 1 && /promised/.test(p4[0]), p4);
  // pure level: the tell id of a stored row is its own
  const need = W.newNeeds([storedRow], [], [], T0 - 2 * H, T0, null).filter((n) => n.kind === 'call')[0];
  ok('pure: a stored call carries a "#stored" tell id', need && /#stored$/.test(need.tellId || ''), need);

  console.log('2. the last-rung email does not promise what the brief does not do');
  const mail = W.ladderEmail([{ id: 'call:x', key: 'num:5135550142', who: 'Pat', why: 'urgent - still open (reminder 2)', rung: 3 }], T0);
  ok('the email text does not say the morning brief lists everything still open', mail && !/morning brief lists/i.test(mail.text) && !/morning brief lists/i.test(mail.html), mail && mail.text);
  ok('...and still points at the Call Center', mail && /pro\/dashboard\.html#\/calls/.test(mail.text));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
