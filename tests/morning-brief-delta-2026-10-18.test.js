/**
 * tests/morning-brief-delta-2026-10-18.test.js
 *
 * Delta mode for the 06:45 brief (functions/morning-brief-delta.js, rendering in
 * functions/morning-brief-logic.js, wiring in functions/morning-brief.js).
 * Notification policy step 1; flag MORNING_BRIEF_DELTA_ENABLED, default off.
 *
 *   1. delta logic (pure): first run = everything new; same lists tomorrow =
 *      nothing named; a new row, an escalation to urgent and a threshold cross
 *      each name themselves; stale / malformed snapshots fall back to "all new"
 *   2. the snapshot holds ids only (no name, phone, promise text)
 *   3. FLAG OFF is byte-for-byte the old brief (golden generated from the
 *      original logic, tests/fixtures/morning-brief-flag-off-golden.json)
 *   4. delta rendering: quiet day names nothing standing, still sends the
 *      appointments line; new items are named; escaping holds
 *   5. the run: flag absent never reads/writes morningBriefState; flag on
 *      writes after a LIVE send only, never on a dry run or a rejected send;
 *      a bad snapshot read shows the full lists; another tenant's snapshot is
 *      ignored; recipient is still the owner alone
 *   6. wiring pins: gate registered, env file false, rules deny clients
 *
 * Every sender is a fake. Run: node tests/morning-brief-delta-2026-10-18.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const stampCalls = [];
const STUBS = {
  './integrations/heartbeat': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => { throw new Error('test must not reach real Firestore'); } },
  resend: { Resend: function () { throw new Error('real Resend used in a test'); } },
  './call-center': { stampDigest: async (db, items) => { stampCalls.push(items.length); } },
  './lead-digest': { DIGEST_EMAILS: [] },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
const MB = require(path.join(FN, 'morning-brief-logic.js'));
const D = require(path.join(FN, 'morning-brief-delta.js'));
const MOD = require(path.join(FN, 'morning-brief.js'));
const FX = require(path.join(__dirname, 'fixtures', 'morning-brief-scenarios.js'));
const { runMorningBrief, STATE_COLLECTION } = MOD._test;

const NOW = FX.NOW;
const DAY = 24 * 3600000;

// ── 1. delta logic ─────────────────────────────────────────────────────
console.log('\n1. delta logic (pure)');
const sec = () => ({ newLeads: FX.newLeads, promises: FX.promises, reviewAsks: FX.reviewAsks, promiseCheckFailed: false, quietLines: [] });
{
  const first = D.computeDelta({ prev: null, needsWeek: FX.needsWeek, sections: sec(), nowMs: NOW });
  ok('no snapshot → every list is all-new (the old full brief, once)', first.lists.needsWeek.shown.length === 8 && first.lists.promises.shown.length === 3 && first.lists.reviewAsks.shown.length === 2 && first.lists.needsWeek.first === true);
  const snap = D.buildSnapshot({ needsWeek: FX.needsWeek, sections: sec(), nowMs: NOW });
  const next = D.computeDelta({ prev: snap, needsWeek: FX.needsWeek, sections: sec(), nowMs: NOW + DAY });
  ok('same lists a day later → nothing named', next.lists.needsWeek.shown.length === 0 && next.lists.promises.shown.length === 0 && next.lists.reviewAsks.shown.length === 0 && next.hasNews === false, JSON.stringify(next.lists.promises));
  ok('...counts are still carried', next.lists.needsWeek.count === 8 && next.lists.promises.count === 3 && next.lists.needsWeek.prevCount === 8);
  const more = FX.needsWeek.concat([{ leadId: 'NW9', jobId: null, name: 'Brand New' }]);
  const d2 = D.computeDelta({ prev: snap, needsWeek: more, sections: sec(), nowMs: NOW + DAY });
  ok('one new signed job → exactly that one is named', d2.lists.needsWeek.shown.length === 1 && d2.lists.needsWeek.shown[0].leadId === 'NW9' && d2.lists.needsWeek.newCount === 1 && d2.hasNews);
  const fewer = FX.needsWeek.slice(2);
  const d3 = D.computeDelta({ prev: snap, needsWeek: fewer, sections: sec(), nowMs: NOW + DAY });
  ok('rows that left are counted as cleared, not news', d3.lists.needsWeek.cleared === 2 && d3.lists.needsWeek.shown.length === 0 && d3.hasNews === false);
  const calmP = FX.promises.map((p) => Object.assign({}, p, { kind: p.kind === 'urgent' ? 'due' : p.kind }));
  const snapCalm = D.buildSnapshot({ needsWeek: [], sections: Object.assign(sec(), { promises: calmP }), nowMs: NOW });
  const d4 = D.computeDelta({ prev: snapCalm, needsWeek: [], sections: sec(), nowMs: NOW + DAY });
  ok('an old promise that turned URGENT is named (threshold crossed)', d4.lists.promises.shown.length === 1 && d4.lists.promises.shown[0].callId === 'promise:P1' && d4.lists.promises.newCount === 0);
  const d5 = D.computeDelta({ prev: snap, needsWeek: FX.needsWeek, sections: sec(), nowMs: NOW + DAY });
  ok('...but a promise that was already urgent yesterday is NOT repeated', d5.lists.promises.shown.length === 0);
  const nine = Array.from({ length: 9 }, (_, i) => ({ leadId: 'T' + i }));
  const eleven = Array.from({ length: 11 }, (_, i) => ({ leadId: 'T' + i }));
  const sN = D.buildSnapshot({ needsWeek: nine, sections: null, nowMs: NOW });
  const d6 = D.computeDelta({ prev: sN, needsWeek: eleven, sections: null, nowMs: NOW + DAY });
  ok('the count passing 10 is a threshold cross (hasNews even though...)', JSON.stringify(d6.lists.needsWeek.crossed) === '[10]' && d6.hasNews === true);
  ok('...and a count already above it does not cross again', D.computeDelta({ prev: D.buildSnapshot({ needsWeek: eleven, sections: null, nowMs: NOW }), needsWeek: eleven, sections: null, nowMs: NOW + DAY }).lists.needsWeek.crossed.length === 0);
  ok('stale snapshot (> 72 h) → treated as none, full list again', D.computeDelta({ prev: snap, needsWeek: FX.needsWeek, sections: null, nowMs: NOW + 4 * DAY }).lists.needsWeek.shown.length === 8);
  ok('snapshot at exactly 72 h is still good', D.computeDelta({ prev: snap, needsWeek: FX.needsWeek, sections: null, nowMs: NOW + 3 * DAY }).lists.needsWeek.shown.length === 0);
  for (const [label, bad] of [['wrong version', { v: 2, lists: snap.lists }], ['no lists', { v: 1 }], ['ids not an array', { v: 1, lists: { needsWeek: { atMs: NOW, ids: 'x' } } }], ['future atMs', { v: 1, lists: { needsWeek: { atMs: NOW + 10 * DAY, ids: [] } } }], ['garbage', 'nope']]) {
    ok('malformed snapshot (' + label + ') → all new, no crash', D.computeDelta({ prev: bad, needsWeek: FX.needsWeek, sections: null, nowMs: NOW + DAY }).lists.needsWeek.shown.length === 8);
  }
  ok('absorb off (sections null) → promises / reviewAsks are absent, not empty', !('promises' in D.computeDelta({ prev: null, needsWeek: [], sections: null, nowMs: NOW }).lists));
  const unkeyed = [{ kind: 'due', who: 'No Id' }];
  const sU = D.buildSnapshot({ needsWeek: [], sections: { promises: unkeyed, reviewAsks: [] }, nowMs: NOW });
  ok('a row with no id can never be remembered, so it is always shown', D.computeDelta({ prev: sU, needsWeek: [], sections: { promises: unkeyed, reviewAsks: [] }, nowMs: NOW + DAY }).lists.promises.shown.length === 1);
}

// ── 2. snapshot is ids only ────────────────────────────────────────────
console.log('\n2. the snapshot');
{
  const snap = D.buildSnapshot({ needsWeek: FX.needsWeek, sections: sec(), nowMs: NOW });
  const json = JSON.stringify(snap);
  ok('no name, phone, address or promise text anywhere in it', !/Signed Person|Dee Fox|Eli Gray|Flo|Hart|555|Send the estimate|Roof replacement|Elm St/.test(json), json);
  ok('only ids / counts / timestamps: v, atMs, lists.{needsWeek,promises,reviewAsks}.{atMs,ids,urgent}', Object.keys(snap).sort().join() === 'atMs,lists,v' && Object.keys(snap.lists).sort().join() === 'needsWeek,promises,reviewAsks' && Object.keys(snap.lists.promises).sort().join() === 'atMs,ids,urgent');
  ok('urgent ids recorded', JSON.stringify(snap.lists.promises.urgent) === '["promise:P1"]');
  const failed = D.buildSnapshot({ needsWeek: [], sections: Object.assign(sec(), { promiseCheckFailed: true, promises: [] }), nowMs: NOW });
  ok('a failed promise read leaves promises OUT (yesterday\'s good entry survives the merge)', !('promises' in failed.lists) && 'reviewAsks' in failed.lists);
  const none = D.buildSnapshot({ needsWeek: [], sections: null, nowMs: NOW });
  ok('absorb off → only needsWeek is recorded', Object.keys(none.lists).join() === 'needsWeek');
  const big = D.buildSnapshot({ needsWeek: Array.from({ length: 900 }, (_, i) => ({ leadId: 'B' + i })), sections: null, nowMs: NOW });
  ok('capped at ' + D.MAX_IDS + ' ids', big.lists.needsWeek.ids.length === D.MAX_IDS);
}

// ── 3. flag off = old bytes ────────────────────────────────────────────
console.log('\n3. flag off is byte-for-byte the old brief');
const GOLD = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'morning-brief-flag-off-golden.json'), 'utf8').replace(/^﻿/, ''));
const norm = (s) => String(s).replace(/\r\n/g, '\n');
{
  const sc = FX.scenarios();
  for (const k of Object.keys(GOLD)) {
    for (const variant of ['absent', 'null']) {
      const input = variant === 'null' ? Object.assign({}, sc[k], { delta: null }) : sc[k];
      const b = MB.buildBrief(input);
      ok(`scenario "${k}" (delta ${variant}): subject, html, text, sendable, item keys, counts identical to the original`,
        b.subject === GOLD[k].subject && norm(b.html) === norm(GOLD[k].html) && norm(b.text) === norm(GOLD[k].text) && b.sendable === GOLD[k].sendable
        && JSON.stringify(b.items.map((i) => i.key)) === JSON.stringify(GOLD[k].itemKeys) && JSON.stringify(b.sectionCounts) === JSON.stringify(GOLD[k].sectionCounts),
        k + ' subject: ' + b.subject);
    }
  }
  ok('golden is non-trivial (the full scenario names the standing items)', /Signed Person 1/.test(GOLD.full.html) && /Dee Fox/.test(GOLD.full.html) && GOLD.full.html.length > 5000);
}

// ── 4. delta rendering ─────────────────────────────────────────────────
console.log('\n4. delta rendering');
const withDelta = (scn, prev, nowMs, mut) => {
  const input = Object.assign({}, scn);
  if (mut) mut(input);
  const delta = D.computeDelta({ prev, needsWeek: input.needsWeek || [], sections: input.sections || null, nowMs: NOW });
  return MB.buildBrief(Object.assign({}, input, { delta }));
};
{
  const full = FX.scenarios().full;
  const snap = D.buildSnapshot({ needsWeek: full.needsWeek, sections: full.sections, nowMs: NOW - DAY });
  // Yesterday already had these standing items; today's only news is the new lead (a 24h window by construction).
  const quiet = withDelta(full, snap, NOW);
  ok('quiet day: no standing name is repeated (signed jobs, promise people, review-ask people)', !/Signed Person|Dee Fox|Eli Gray|Flo Hart|555-0199/.test(quiet.html + quiet.text), quiet.text);
  ok('...the appointments are still first and complete', /Cy Lee/.test(quiet.html) && /Ann Roe/.test(quiet.html) && /Bo Kim/.test(quiet.html) && quiet.html.indexOf('Ann Roe') < quiet.html.indexOf('Standing'));
  ok('...standing lists show as counts with a CRM link', /8 signed jobs need a week \(no change\)/.test(quiet.html) && /3 open promises \(no change\)/.test(quiet.html) && /2 jobs ready for a review ask \(no change\)/.test(quiet.html) && quiet.html.includes('dashboard.html#/schedule') && quiet.html.includes('dashboard.html#/calls'));
  ok('...the new-leads section is kept as-is', /New leads — last 24h \(1\)/.test(quiet.html) && /Gus Ivy/.test(quiet.html));
  ok('...subject says what is new', quiet.subject === 'Today (Mon, Oct 19): 3 appointments — first at 9:00 am · 1 new lead', quiet.subject);
  ok('...and it is much shorter than the full brief', quiet.html.length < GOLD.full.html.length * 0.8, quiet.html.length + ' vs ' + GOLD.full.html.length);

  const nothing = withDelta(full, snap, NOW, (i) => { i.sections = Object.assign({}, i.sections, { newLeads: [], quietLines: [] }); });
  ok('nothing new: subject says so, brief still has the appointments line', /nothing new$/.test(nothing.subject) && nothing.sendable === true && /3 appointments today/.test(nothing.html), nothing.subject);
  const noAppt = withDelta(Object.assign({}, full, { appointments: [], leads: [] }), snap, NOW, (i) => { i.sections = Object.assign({}, i.sections, { newLeads: [], quietLines: [] }); });
  ok('no appointments + nothing new: short brief, "no appointments — nothing new", counts only', noAppt.subject === 'Today (Mon, Oct 19): no appointments — nothing new' && noAppt.sendable === true && !/Signed Person/.test(noAppt.html) && /Standing — counts only/.test(noAppt.html), noAppt.subject);

  const newish = withDelta(full, snap, NOW, (i) => {
    i.needsWeek = full.needsWeek.concat([{ leadId: 'NW9', jobId: null, name: 'Newly Signed' }]);
    i.sections = Object.assign({}, i.sections, { promises: full.sections.promises.concat([{ callId: 'promise:P9', leadId: 'P9', kind: 'due', who: 'Hal Moss', promises: ['Bring the shingle sample'], due: '2026-10-19' }]) });
  });
  ok('a new signed job and a new promise are named, with links', /New: 1 signed job needs a week/.test(newish.html) && /Newly Signed/.test(newish.html) && /Hal Moss/.test(newish.html) && newish.html.includes('customer.html?id=NW9') && newish.html.includes('customer.html?id=P9'));
  ok('...old ones still are not', !/Signed Person|Dee Fox|Eli Gray/.test(newish.html));
  ok('...standing counts show the new ones: "9 signed jobs need a week (1 new)"', /9 signed jobs need a week \(1 new\)/.test(newish.html) && /4 open promises \(1 new\)/.test(newish.html), (newish.html.match(/Standing[\s\S]*/) || [''])[0].slice(0, 400));
  ok('...subject lists the news', /1 new lead · 1 new signed job needs a week · 1 new said-you'd-do/.test(newish.subject), newish.subject);
  ok('...text part mirrors it', /NEW: 1 SIGNED JOB NEEDS A WEEK/.test(newish.text) && /Newly Signed/.test(newish.text) && /STANDING — counts only/.test(newish.text) && !/Signed Person/.test(newish.text));

  const first = withDelta(full, null, NOW);
  ok('first-ever delta brief names everything once (nothing hidden without evidence)', /Signed Person 1/.test(first.html) && /Dee Fox/.test(first.html) && /Flo Hart/.test(first.html));
  ok('...and does not claim "no change" when there is no yesterday', !/no change/.test(first.html));

  const warn = withDelta(Object.assign({}, full, { sections: Object.assign({}, full.sections, { promiseCheckFailed: true }) }), snap, NOW);
  ok('the promise-read warning is NEVER collapsed away', /Could not check your promise tasks/.test(warn.html) && /Could not check your promise tasks/.test(warn.text));
  const quietNums = withDelta(full, snap, NOW);
  ok('the repeat-unknown-numbers line is kept', /Repeat unknown numbers/.test(quietNums.html) && /unlabelled/.test(quietNums.html));

  const evil = withDelta(full, snap, NOW, (i) => {
    i.needsWeek = [{ leadId: 'E"><img src=x>', jobId: null, name: '<script>alert(1)</script>' }];
    i.sections = Object.assign({}, i.sections, { promises: [{ callId: 'promise:E', leadId: 'E1', kind: 'due', who: '<b>x</b>', promises: ['<img onerror=1>'], due: '' }], reviewAsks: [{ id: 'R"><svg>', firstName: '<i>z</i>', lastName: '' }] });
  });
  ok('escaping holds in delta rows (name, promise, review ask, href)', !/<script>|<img|<svg|<b>x|<i>z/.test(evil.html) && evil.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), evil.html.slice(evil.html.indexOf('New:'), evil.html.indexOf('New:') + 300));
  const oneItem = withDelta(Object.assign({}, full, { sections: null }), null, NOW);
  ok('absorb off + delta on: only the signed-jobs list is collapsed; no promise/review sections invented', !/open promise|review ask/.test(oneItem.html));
}

// ── 5. the run ─────────────────────────────────────────────────────────
console.log('\n5. the run (fake db, fake sender)');
const OWNER = 'owner-uid';
function makeDb(seed, hooks) {
  const docs = new Map(Object.entries(seed));
  const reads = [];
  const val = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : v instanceof Date ? v.getTime() : v);
  const test = (d, [f, op, v]) => { const a = val(d[f]), b = val(v); if (op === '==') return a === b; if (a == null) return false; if (op === '>=') return a >= b; if (op === '<') return a < b; throw new Error('op ' + op); };
  const snapOf = (k) => { const p = k.split('/'); return { id: p[p.length - 1], ref: { parent: { parent: p.length >= 4 ? { id: p[p.length - 3] } : null } }, data: () => docs.get(k) }; };
  function query(label, pick, st) {
    return {
      where: (f, op, v) => query(label, pick, Object.assign({}, st, { fl: st.fl.concat([[f, op, v]]) })),
      orderBy: () => query(label, pick, st),
      limit: (n) => query(label, pick, Object.assign({}, st, { lim: n })),
      async get() {
        reads.push(label);
        let hits = [...docs.keys()].filter((k) => pick(k) && st.fl.every((c) => test(docs.get(k), c)));
        if (st.lim) hits = hits.slice(0, st.lim);
        const out = hits.map(snapOf);
        return { docs: out, size: out.length, empty: !out.length, forEach: (fn) => out.forEach(fn) };
      },
    };
  }
  const col = (c) => {
    const depth = c.split('/').length + 1;
    return Object.assign(query(c, (k) => k.startsWith(c + '/') && k.split('/').length === depth, { fl: [] }), {
      doc: (id) => ({
        async get() {
          reads.push(c + '/' + id);
          if (c === STATE_COLLECTION && hooks && hooks.stateReadFails) throw new Error('state read down');
          const k = c + '/' + id; return { exists: docs.has(k), id, data: () => docs.get(k) };
        },
        async set(data, opts) {
          if (hooks && hooks.stateWriteFails) throw new Error('state write down');
          const k = c + '/' + id; writes.push([k, data, opts]);
          const prev = opts && opts.merge ? (docs.get(k) || {}) : {};
          const merged = Object.assign({}, prev, data);
          if (opts && opts.merge && prev.snapshot && data.snapshot) merged.snapshot = Object.assign({}, prev.snapshot, data.snapshot, { lists: Object.assign({}, prev.snapshot.lists, data.snapshot.lists) });
          docs.set(k, merged);
        },
        collection: (sub) => col(c + '/' + id + '/' + sub),
      }),
    });
  };
  const writes = [];
  return { reads, writes, docs, collection: col, collectionGroup: (name) => query('group:' + name, (k) => { const s = k.split('/'); return s.length >= 4 && s[s.length - 2] === name; }, { fl: [] }) };
}
const ts = (iso) => ({ toMillis: () => Date.parse(iso) });
const seedRun = () => {
  const seed = {
    'users/owner-uid': { email: 'jo@example.test' },
    'appointments/a1': { repUid: OWNER, title: 'Free roof inspection', attendeeName: 'Cy Lee', location: '1 Dawn Ct', startTime: ts('2026-10-19T14:00:00Z'), endTime: ts('2026-10-19T15:00:00Z') },
  };
  for (let i = 1; i <= 8; i++) seed['leads/NW' + i] = { companyId: OWNER, userId: OWNER, firstName: 'Signed', lastName: 'Person ' + i, stage: 'contract_signed' };
  return seed;
};
const SECTIONS = async () => sec();
const fakeSender = () => { const sent = []; return { sent, makeResend: () => ({ emails: { send: async (m) => { sent.push(m); return { data: { id: 'e1' }, error: null }; } } }) }; };
const quietLog = () => { const lines = []; return { lines, info: (m, d) => lines.push(['info', m, d]), warn: (m, d) => lines.push(['warn', m, d]), error: (m, d) => lines.push(['error', m, d]) }; };
const ENV = (extra) => Object.assign({ MORNING_BRIEF_ENABLED: 'true', MORNING_BRIEF_ABSORB_ENABLED: 'true', RESEND_API_KEY: 're_test' }, extra || {});
const go = (db, env, s, extra) => runMorningBrief(Object.assign({ db, env, nowMs: NOW, makeResend: s.makeResend, log: quietLog(), owner: OWNER, sections: SECTIONS, briefLines: async () => ({}), weatherFor: async () => null }, extra || {}));

(async () => {
  {
    const db = makeDb(seedRun()); const s = fakeSender();
    const out = await go(db, ENV(), s);
    ok('flag ABSENT: sends the full brief, names the standing lists', out.status === 'sent' && /Signed Person 1/.test(s.sent[0].html) && /Dee Fox/.test(s.sent[0].html));
    ok('...and never touches morningBriefState (no read, no write)', !db.reads.some((r) => r.startsWith(STATE_COLLECTION)) && db.writes.length === 0, JSON.stringify(db.reads.filter((r) => /Brief/.test(r))));
  }
  {
    const db = makeDb(seedRun()); const s = fakeSender();
    const out = await go(db, ENV({ MORNING_BRIEF_DELTA_ENABLED: 'false' }), s);
    ok('flag "false": same as absent', out.status === 'sent' && /Signed Person 1/.test(s.sent[0].html) && db.writes.length === 0);
    const db2 = makeDb(seedRun()); const s2 = fakeSender();
    await go(db2, ENV({ MORNING_BRIEF_DELTA_ENABLED: 'yes' }), s2);
    ok('flag "yes" (not the literal true): still off', /Signed Person 1/.test(s2.sent[0].html) && db2.writes.length === 0);
  }
  {
    // Flag-off live email vs the original code path: delta absent must equal delta present-but-false.
    const a = fakeSender(); const b = fakeSender();
    await go(makeDb(seedRun()), ENV(), a);
    await go(makeDb(seedRun()), ENV({ MORNING_BRIEF_DELTA_ENABLED: 'false' }), b);
    ok('flag absent vs "false": the sent subject / html / text / recipient are identical', a.sent[0].subject === b.sent[0].subject && a.sent[0].html === b.sent[0].html && a.sent[0].text === b.sent[0].text && JSON.stringify(a.sent[0].to) === JSON.stringify(b.sent[0].to));
  }
  {
    const db = makeDb(seedRun()); const s = fakeSender();
    const out = await go(db, ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), s);
    ok('flag on, no snapshot: first brief is the full one (safe direction)', out.status === 'sent' && /Signed Person 1/.test(s.sent[0].html) && /Dee Fox/.test(s.sent[0].html));
    const w = db.writes.filter(([k]) => k === STATE_COLLECTION + '/' + OWNER);
    ok('...and writes ONE snapshot after the live send, tenant-keyed, merge:true', w.length === 1 && w[0][1].companyId === OWNER && w[0][2] && w[0][2].merge === true, JSON.stringify(db.writes.map((x) => x[0])));
    ok('...ids only: no name / phone / promise text reached Firestore', !/Signed|Person|Dee Fox|Eli|555|estimate|Hart/.test(JSON.stringify(w[0][1])), JSON.stringify(w[0][1]));
    ok('...the only doc written is morningBriefState/{owner}', db.writes.every(([k]) => k === STATE_COLLECTION + '/' + OWNER));

    // Day two, same lists, same db (snapshot persisted) one day later.
    const s2 = fakeSender();
    const out2 = await runMorningBrief({ db, env: ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), nowMs: NOW + 0, makeResend: s2.makeResend, log: quietLog(), owner: OWNER, sections: async () => Object.assign(sec(), { newLeads: [] }), briefLines: async () => ({}), weatherFor: async () => null });
    ok('flag on, snapshot present: second brief sends but names no standing person', out2.status === 'sent' && s2.sent.length === 1 && !/Signed Person|Dee Fox|Eli Gray|Flo Hart/.test(s2.sent[0].html + s2.sent[0].text), s2.sent[0] && s2.sent[0].subject);
    ok('...still has the appointment, counts, and goes to the owner only', /Cy Lee/.test(s2.sent[0].html) && /8 signed jobs need a week \(no change\)/.test(s2.sent[0].html) && JSON.stringify(s2.sent[0].to) === '["jo@example.test"]');
    ok('...shorter than the first brief', s2.sent[0].html.length < s.sent[0].html.length * 0.8, s2.sent[0].html.length + ' vs ' + s.sent[0].html.length);
  }
  {
    // recipient exactness with absorb: owner + DIGEST_EMAILS (stubbed empty) -> exactly the owner
    const s = fakeSender();
    await go(makeDb(seedRun()), ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), s);
    ok('recipients unchanged: only the owner address', JSON.stringify(s.sent[0].to) === JSON.stringify(['jo@example.test']), JSON.stringify(s.sent[0].to));
  }
  {
    const db = makeDb(seedRun()); const s = fakeSender();
    const out = await go(db, ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true', MORNING_BRIEF_ENABLED: 'false' }), s);
    ok('DRY RUN (brief not live) with delta on: nothing sent, snapshot NOT advanced', out.status === 'dry-run' && s.sent.length === 0 && db.writes.length === 0);
  }
  {
    const db = makeDb(seedRun());
    const s = { sent: [], makeResend: () => ({ emails: { send: async () => ({ data: null, error: { message: 'domain not verified' } }) } }) };
    const out = await go(db, ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), s);
    ok('a REJECTED send does not advance the snapshot (tomorrow still shows it)', out.status === 'rejected' && db.writes.length === 0);
  }
  {
    const db = makeDb(seedRun(), { stateReadFails: true }); const s = fakeSender(); const log = quietLog();
    const out = await go(db, ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), s, { log });
    ok('an unreadable snapshot → full lists, brief still sent, warning logged', out.status === 'sent' && /Signed Person 1/.test(s.sent[0].html) && log.lines.some(([l, m]) => l === 'warn' && m === 'morning_brief_snapshot_read_failed'));
    const db2 = makeDb(seedRun(), { stateWriteFails: true }); const s2 = fakeSender(); const log2 = quietLog();
    const out2 = await go(db2, ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), s2, { log: log2 });
    ok('a failed snapshot write never fails the run (the email already went)', out2.status === 'sent' && s2.sent.length === 1 && log2.lines.some(([l, m]) => l === 'warn' && m === 'morning_brief_snapshot_write_failed'));
  }
  {
    // Another tenant's snapshot under the owner's doc id is ignored.
    const seed = seedRun();
    seed[STATE_COLLECTION + '/' + OWNER] = { companyId: 'someone-else', snapshot: D.buildSnapshot({ needsWeek: FX.needsWeek, sections: sec(), nowMs: NOW - DAY }) };
    const s = fakeSender();
    await go(makeDb(seed), ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), s);
    ok('a snapshot whose companyId is not the owner is ignored (tenant check)', /Dee Fox/.test(s.sent[0].html));
  }
  {
    // A failed promise read: yesterday's promises entry survives; warning shows.
    const db = makeDb(seedRun()); const s = fakeSender();
    await go(db, ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), s);
    const before = JSON.stringify(db.docs.get(STATE_COLLECTION + '/' + OWNER).snapshot.lists.promises);
    const s2 = fakeSender();
    await runMorningBrief({ db, env: ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), nowMs: NOW, makeResend: s2.makeResend, log: quietLog(), owner: OWNER, sections: async () => ({ newLeads: [], promises: [], reviewAsks: [], promiseCheckFailed: true, quietLines: [] }), briefLines: async () => ({}), weatherFor: async () => null });
    ok('promise-read failure: warning in the email, and yesterday\'s promises ids are kept', /Could not check your promise tasks/.test(s2.sent[0].html) && JSON.stringify(db.docs.get(STATE_COLLECTION + '/' + OWNER).snapshot.lists.promises) === before);
  }
  {
    const seed = { 'users/owner-uid': { email: 'jo@example.test' } };
    const s = fakeSender();
    const out = await go(makeDb(seed), ENV({ MORNING_BRIEF_DELTA_ENABLED: 'true' }), s, { sections: async () => ({ newLeads: [], promises: [], reviewAsks: [], promiseCheckFailed: false, quietLines: [] }) });
    ok('nothing at all today → still no email in delta mode (quiet means silent)', out.status === 'nothing-today' && s.sent.length === 0);
  }
  ok('the absorb path is untouched: MORNING_BRIEF_ABSORB_ENABLED unset + delta on still works (needsWeek collapses, no sections)', await (async () => {
    const db = makeDb(seedRun()); const s = fakeSender();
    const env = { MORNING_BRIEF_ENABLED: 'true', RESEND_API_KEY: 're_test', MORNING_BRIEF_DELTA_ENABLED: 'true' };
    await runMorningBrief({ db, env, nowMs: NOW, makeResend: s.makeResend, log: quietLog(), owner: OWNER, briefLines: async () => ({}), weatherFor: async () => null });
    const snap = db.docs.get(STATE_COLLECTION + '/' + OWNER);
    return s.sent.length === 1 && snap && Object.keys(snap.snapshot.lists).join() === 'needsWeek';
  })());

  // ── 6. wiring ────────────────────────────────────────────────────────
  console.log('\n6. wiring pins');
  {
    const src = fs.readFileSync(path.join(FN, 'morning-brief.js'), 'utf8');
    ok('the gate is the literal "true" and is read from the Cloud Run env in the handler', /MORNING_BRIEF_DELTA_ENABLED === 'true'/.test(src) && /MORNING_BRIEF_DELTA_ENABLED: process\.env\.MORNING_BRIEF_DELTA_ENABLED/.test(src));
    const { CRON_GATES } = require(path.join(FN, 'cron-gates.js'));
    ok('cron-gates registers it (enabled polarity, morning-brief.js)', CRON_GATES.some((g) => g.name === 'MORNING_BRIEF_DELTA_ENABLED' && g.polarity === 'enabled' && g.file === 'morning-brief.js'));
    const REG = require(path.join(FN, 'flags-registry.js'));
    const row = REG.FLAGS.find((f) => f.name === 'MORNING_BRIEF_DELTA_ENABLED');
    ok('flags-registry row exists, dark, with a real doc', !!row && row.dark === true && fs.existsSync(path.join(ROOT, row.doc)), JSON.stringify(row));
    const env = fs.readFileSync(path.join(FN, '.env.nobigdeal-pro'), 'utf8');
    ok('functions/.env.nobigdeal-pro has MORNING_BRIEF_DELTA_ENABLED=false (shipped dark)', /^MORNING_BRIEF_DELTA_ENABLED=false\r?$/m.test(env));
    ok('MORNING_BRIEF_ABSORB_ENABLED behaviour is untouched (still true, absorb module unchanged)', /^MORNING_BRIEF_ABSORB_ENABLED=true\r?$/m.test(env) && !/DELTA/.test(fs.readFileSync(path.join(FN, 'morning-brief-absorb.js'), 'utf8')));
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    ok('firestore.rules denies every client on morningBriefState', /match \/morningBriefState\/\{companyId\}\s*\{\s*allow read, write: if false;\s*\}/.test(rules));
    const delta = fs.readFileSync(path.join(FN, 'morning-brief-delta.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
    ok('the delta module does no I/O and has no clock of its own', !/firebase|resend|fetch\(|Date\.now|new Date\(/i.test(delta));
    ok('no customer send path: the delta code never mentions sms/twilio/customer email', !/twilio|sendSms|sendEmail/i.test(delta));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFAILED:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
