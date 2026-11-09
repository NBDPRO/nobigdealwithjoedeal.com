/**
 * tests/call-to-close-transcribe-now-2026-11-09.test.js — Call to Close P1,
 * lane "transcribe now" (design §9 P1 items 1-2, Q5).
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.2, §9.
 *
 * Every transcriber and model is a fake; nothing reaches Groq, Anthropic or
 * Firestore (an in-memory db whose transactions run one at a time, like
 * Firestore's serialisable ones).
 *
 *   1. the segment index (call-center-logic buildSegIndex): per-segment
 *      start / end / char offset / avg_logprob, capped at SEG_MAX entries
 *      (merged groups keep the WORST logprob), bounded bytes
 *   2. Groq: transcribeGroqBuffer({ confidence: true }) keeps avg_logprob and
 *      no_speech_prob; without it the result is unchanged
 *   3. the scheduled pass writes segIndex on a noted call and respects a live
 *      lease (an expired one does not block it)
 *   4. callTranscribeNow gates: signed out, viewer, a sales rep who does not
 *      own the call, another tenant → refused; owner, company_admin, manager,
 *      admin → allowed (exactly callCenterAction's role test)
 *   5. idempotent: a transcript already on the call comes back, no Groq call,
 *      no quota; two taps at once transcribe once (the lease)
 *   6. switches: the AI kill switch, CALL_CENTER_TRANSCRIBE_ENABLED off, and
 *      integrations/callCenter.paused all refuse before any audio leaves
 *   7. which calls: short, personal, too large, no recording, not in the
 *      owner's queue, three failed tries, today's audio allowance spent
 *   8. caps: 10 per user and 30 per company per ET day, one transaction; a
 *      run that transcribed nothing gives the quota back
 *   9. wiring: App Check, ghost check, both secrets, index.js, function-map,
 *      FUNCTIONS_INDEX.md, the demo answer
 *  10. the buttons: "Transcribe now" on a stored call with no transcript, for
 *      the same roles as "Draft from this call", lazy through call-brief-ui.js
 *
 * Run: node tests/call-to-close-transcribe-now-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

// ── Fake Firestore: merge, create, queries, serialised transactions ──────
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function doc(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => ({ id: p.split('/').pop(), exists: store.has(p), data: () => clone(store.get(p)) }),
      set: async (data, opts) => { store.set(p, opts && opts.merge ? Object.assign({}, store.get(p) || {}, clone(data)) : clone(data)); },
      create: async (data) => { if (store.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } store.set(p, clone(data)); },
      delete: async () => { store.delete(p); },
      collection: (n) => coll(p + '/' + n),
    };
  }
  function query(name, filters, lim) {
    return {
      where: (f, _op, v) => query(name, filters.concat([[f, v]]), lim),
      orderBy: () => query(name, filters, lim),
      limit: (n) => query(name, filters, n),
      get: async () => {
        const depth = name.split('/').length + 1;
        const rows = [...store.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === depth && filters.every(([f, val]) => v[f] === val)).slice(0, lim || 1e9);
        const docs = rows.map(([k, v]) => ({ id: k.split('/').pop(), data: () => clone(v) }));
        return { docs, forEach: (fn) => docs.forEach(fn), size: docs.length, empty: !docs.length };
      },
    };
  }
  function coll(name) { return Object.assign(query(name, [], null), { doc: (id) => doc(name + '/' + id) }); }
  let chain = Promise.resolve();
  return {
    store, doc, collection: coll,
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    // One transaction at a time (Firestore retries a conflicting one; here it waits).
    runTransaction(fn) {
      const run = chain.then(() => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), create: (r, d) => r.create(d), delete: (r) => r.delete() }));
      chain = run.catch(() => {});
      return run;
    },
  };
}

const silent = { info() {}, warn() {}, error() {}, debug() {} };
let flags = {};
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const STUBS = {
  'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
  './integrations/killswitch': { isAiDisabled: async () => flags.aiDisabled === true, isCallBriefDisabled: async () => false, getFlags: async () => flags },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};

const CL = require(path.join(FN, 'call-center-logic.js'));
const CC = require(path.join(FN, 'call-center.js'));
let TN = null;
try { TN = require(path.join(FN, 'call-transcribe-now.js')); } catch (e) { console.log('  (call-transcribe-now.js did not load: ' + e.message + ')'); }
const OWNER = CC._test.OWNER;

const NOW = Date.parse('2026-11-09T18:00:00Z');
const ID = 'cube_ABCDE12345';
const TEXT = 'Hi Jo, this is Pat. The roof is leaking in the kitchen again. My claim number is 4 4 7 2 9. Can you come Thursday?';
const SEGS = [
  { start: 0, end: 3.2, text: ' Hi Jo, this is Pat.', avgLogprob: -0.21, noSpeechProb: 0.01 },
  { start: 3.2, end: 7.9, text: ' The roof is leaking in the kitchen again.', avgLogprob: -0.3, noSpeechProb: 0.02 },
  { start: 7.9, end: 12.4, text: ' My claim number is 4 4 7 2 9.', avgLogprob: -1.42, noSpeechProb: 0.2 },
  { start: 12.4, end: 14.0, text: ' Can you come Thursday?', avgLogprob: -0.4, noSpeechProb: 0.01 },
];
const STORED = { userId: OWNER, companyId: OWNER, status: 'stored', storagePath: 'calls/' + OWNER + '/cube-acr/2026-11-09/' + ID + '.m4a', sizeBytes: 300000, startedAtMs: NOW - 600e3, direction: 'inbound', contactName: 'Pat Example', leadId: 'L1' };
function seed(callOver, extra) {
  return Object.assign({
    ['phone_calls/' + ID]: Object.assign({}, STORED, callOver || {}),
    'leads/L1': { userId: OWNER, companyId: OWNER, firstName: 'Pat', lastName: 'Example' },
    'integrations/callCenter': {},
  }, extra || {});
}
const bucket = { file: () => ({ download: async () => [Buffer.from('audio')], delete: async () => {} }) };
let tCalls = 0;
let tDelay = 0;
function stubDeps(text) {
  tCalls = 0;
  CC._test.setDeps({
    transcribe: async () => { tCalls++; if (tDelay) await new Promise((r) => setTimeout(r, tDelay)); return { text: text || TEXT, durationSec: 14, segments: SEGS }; },
    notes: async () => ({ call_type: 'customer', summary: 'Roof leak again; claim open.', promises: [{ who: 'jo', text: 'Come look Thursday', due: '2026-11-12' }], follow_up_date: '2026-11-12', urgent: false }),
    push: async () => ({ sent: 0 }),
  });
}
const AUTH = {
  owner: { uid: OWNER, token: { companyId: OWNER, email_verified: true } },
  ca: { uid: 'ca1', token: { role: 'company_admin', companyId: OWNER } },
  mgr: { uid: 'mg1', token: { role: 'manager', companyId: OWNER } },
  admin: { uid: 'adm', token: { role: 'admin' } },
  viewer: { uid: 'v1', token: { role: 'viewer', companyId: OWNER } },
  rep: { uid: 'rep1', token: { role: 'sales_rep', companyId: OWNER } },
  otherCa: { uid: 'x1', token: { role: 'company_admin', companyId: 'someone-else' } },
};
async function tap(db, auth, data, nowMs) {
  if (!TN || !TN._test) return { e: { code: 'missing', message: 'call-transcribe-now.js missing' } };
  try { return { r: await TN._test.transcribeNow({ db, bucket, auth, data: Object.assign({ callId: ID }, data || {}), nowMs: nowMs || NOW, log: silent }) }; }
  catch (e) { return { e }; }
}

(async () => {
  process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'true';

  console.log('\n1. Segment index');
  ok('buildSegIndex exists, with a documented cap', typeof CL.buildSegIndex === 'function' && Number(CL.SEG_MAX) > 0 && Number(CL.SEG_MAX) <= 600, CL.SEG_MAX);
  if (typeof CL.buildSegIndex === 'function') {
    const si = CL.buildSegIndex(SEGS, TEXT);
    ok('one entry per segment: start, end, char offset, avg_logprob', si && si.v === CL.SEG_V && si.start.length === 4 && si.end.length === 4 && si.off.length === 4 && si.lp.length === 4, si);
    ok('char offsets point at each segment in the transcript', si && si.off.every((o, i) => TEXT.slice(o).startsWith(SEGS[i].text.trim())), si && si.off);
    ok('logprob kept to 2 decimals, times to 0.1 s', si && si.lp[2] === -1.42 && si.end[2] === 12.4);
    ok('flat number arrays only (Firestore has no nested arrays)', si && ['start', 'end', 'off', 'lp'].every((k) => si[k].every((n) => typeof n === 'number')));
    ok('no segments, or no logprob (an older call) → null', CL.buildSegIndex([], TEXT) === null && CL.buildSegIndex([{ start: 0, end: 1, text: 'Hi' }], TEXT) === null && CL.buildSegIndex(SEGS, '') === null);
    const many = [];
    let big = '';
    for (let i = 0; i < 2000; i++) { const t = ' word' + i + ' is here.'; many.push({ start: i * 2, end: i * 2 + 2, text: t, avgLogprob: i === 1001 ? -2.5 : -0.2 }); big += t; }
    const capped = CL.buildSegIndex(many, big);
    ok('2000 segments → at most SEG_MAX entries', capped && capped.lp.length <= CL.SEG_MAX && capped.lp.length > 0, capped && capped.lp.length);
    ok('a merged group keeps its WORST logprob (one bad segment still shows)', capped && capped.lp.some((x) => x === -2.5));
    ok('a merged group spans first start → last end, offsets climb', capped && capped.start[0] === 0 && capped.end[capped.end.length - 1] === 4000 && capped.off.every((o, i) => i === 0 || o > capped.off[i - 1]));
    ok('bounded bytes (< 24 KB as JSON)', capped && JSON.stringify(capped).length < 24 * 1024, capped && JSON.stringify(capped).length);
    const cut = CL.buildSegIndex(SEGS, TEXT.slice(0, 40));
    ok('segments past the stored (sliced) transcript are left out', cut && cut.off.every((o) => o < 40) && cut.off.length < 4, cut);
  }

  console.log('\n2. Groq keeps avg_logprob on request');
  const savedFetch = global.fetch;
  const savedKey = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_' + 'test_dummy';
  let form = null;
  global.fetch = async (url, init) => {
    form = init && init.body;
    return { ok: true, status: 200, json: async () => ({ text: TEXT, duration: 14, segments: [{ start: 0, end: 3.2, text: ' Hi', avg_logprob: -0.21, no_speech_prob: 0.01, tokens: [1, 2] }] }) };
  };
  try {
    const VI = require(path.join(FN, 'integrations', 'voice-intelligence.js'));
    const plain = await VI.transcribeGroqBuffer({ buffer: Buffer.from('x'), mimeType: 'audio/flac', filename: 'a.flac' });
    ok('default: segment shape unchanged (start, end, text)', JSON.stringify(Object.keys(plain.segments[0])) === JSON.stringify(['start', 'end', 'text']), plain.segments[0]);
    const conf = await VI.transcribeGroqBuffer({ buffer: Buffer.from('x'), mimeType: 'audio/flac', filename: 'a.flac', confidence: true });
    ok('confidence: avgLogprob + noSpeechProb kept', conf.segments[0].avgLogprob === -0.21 && conf.segments[0].noSpeechProb === 0.01, conf.segments[0]);
    ok('the request itself is the same verbose_json + segment timestamps', form && form.get('response_format') === 'verbose_json' && form.getAll('timestamp_granularities[]').join() === 'segment');
    ok('the call-center transcriber asks for confidence', /transcribeGroqBuffer\(\{[^}]*confidence: true/.test(read('functions/call-center.js')));
  } catch (e) { ok('Groq helper ran', false, e.message); }
  global.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = savedKey;

  console.log('\n3. The scheduled pass: segIndex + the lease');
  {
    stubDeps();
    const db = makeDb(seed());
    await CC._test.runTranscribe({ db, bucket, live: true, nowMs: NOW });
    const c = db.store.get('phone_calls/' + ID);
    ok('noted with the transcript', c.status === 'noted' && c.transcript === TEXT, c.status);
    ok('segIndex stored on the call', c.segIndex && c.segIndex.lp.length === 4 && c.segIndex.lp[2] === -1.42, c.segIndex);
    ok('the lease is released after the run', !c.transcribeLease, c.transcribeLease);

    stubDeps();
    const db2 = makeDb(seed({ transcribeLease: { by: 'now:someone', untilMs: NOW + 60e3 } }));
    await CC._test.runTranscribe({ db: db2, bucket, live: true, nowMs: NOW });
    ok('a live lease (a Transcribe now in flight) → the schedule skips the call', tCalls === 0 && db2.store.get('phone_calls/' + ID).status === 'stored', tCalls);

    stubDeps();
    const db3 = makeDb(seed({ transcribeLease: { by: 'now:someone', untilMs: NOW - 1 } }));
    await CC._test.runTranscribe({ db: db3, bucket, live: true, nowMs: NOW });
    ok('an expired lease (a run that died) does not block it', tCalls === 1 && db3.store.get('phone_calls/' + ID).status === 'noted', tCalls);

    stubDeps();
    const db4 = makeDb(seed({ status: 'personal', transcript: null }));
    const out4 = await CC._test.runTranscribe({ db: db4, bucket, live: true, nowMs: NOW, only: { id: ID, by: 'now:x' } });
    ok('only-mode on a call that is not stored picks nothing', tCalls === 0 && out4 && out4.picked === 0, out4);

    stubDeps();
    const db5 = makeDb(seed());
    const out5 = await CC._test.runTranscribe({ db: db5, bucket, live: true, nowMs: NOW, only: { id: ID, by: 'now:x' } });
    const cfg5 = db5.store.get('integrations/callCenter');
    ok('only-mode counts its audio against the day allowance', cfg5.audioSecUsed === 14 && cfg5.audioSecDay === '2026-11-09', cfg5);
    ok('only-mode leaves the schedule\'s own run record alone', cfg5.lastTranscribe === undefined && cfg5.lastTranscribeAtMs === undefined, Object.keys(cfg5));
    ok('only-mode runs no backfill (one call, one Groq call)', tCalls === 1 && out5.noted === 1, out5);
  }

  console.log('\n4. Who may tap it');
  for (const [who, allowed] of [['owner', true], ['ca', true], ['mgr', true], ['admin', true], ['viewer', false], ['rep', false], ['otherCa', false]]) {
    stubDeps();
    const db = makeDb(seed());
    const { r, e } = await tap(db, AUTH[who]);
    if (allowed) ok(who + ' → transcribed', r && r.state === 'noted' && tCalls === 1, e ? e.code + ' ' + e.message : r);
    else ok(who + ' → refused, no audio leaves', e && e.code === 'permission-denied' && tCalls === 0, e ? e.code : r);
  }
  {
    stubDeps();
    const { e } = await tap(makeDb(seed()), null);
    ok('signed out → unauthenticated', e && e.code === 'unauthenticated' && tCalls === 0, e && e.code);
    const bad = await tap(makeDb(seed()), AUTH.owner, { callId: '../leads/L1' });
    ok('a bad call id → invalid-argument', bad.e && bad.e.code === 'invalid-argument');
    const gone = await tap(makeDb({}), AUTH.owner);
    ok('a missing call → not-found', gone.e && gone.e.code === 'not-found');
  }

  console.log('\n5. Idempotent');
  {
    stubDeps();
    const db = makeDb(seed({ status: 'noted', transcript: TEXT }));
    const { r } = await tap(db, AUTH.owner);
    ok('a transcript already there comes back, no Groq call', r && r.state === 'already' && r.transcript === TEXT && tCalls === 0, r);
    ok('…and costs no quota', ![...db.store.keys()].some((k) => k.startsWith('call_transcribe_quota/')));
    flags = { aiDisabled: true };
    const off = await tap(makeDb(seed({ status: 'noted', transcript: TEXT })), AUTH.owner);
    ok('…even with the AI switched off (reading it is not AI work)', off.r && off.r.state === 'already', off.e && off.e.message);
    flags = {};

    stubDeps();
    const dbS = makeDb(seed({ transcriptSaved: true, transcript: TEXT }));
    const saved = await tap(dbS, AUTH.owner);
    ok('a transcript saved before a notes outage is reused, never re-transcribed', saved.r && tCalls === 0 && dbS.store.get('phone_calls/' + ID).status === 'noted', saved.r || (saved.e && saved.e.message));

    stubDeps();
    const db2 = makeDb(seed({ transcribeLease: { by: 'schedule', untilMs: NOW + 120e3 } }));
    const busy = await tap(db2, AUTH.owner);
    ok('already being transcribed → "busy", no Groq call, no quota', busy.r && busy.r.state === 'busy' && tCalls === 0 && ![...db2.store.keys()].some((k) => k.startsWith('call_transcribe_quota/')), busy.r || busy.e);

    stubDeps();
    tDelay = 30;
    const db3 = makeDb(seed());
    const both = await Promise.all([tap(db3, AUTH.owner), tap(db3, AUTH.ca)]);
    tDelay = 0;
    ok('two taps at once → ONE Groq call', tCalls === 1, tCalls);
    ok('one of them says noted, the other already / busy', both.map((x) => x.r && x.r.state).sort().join() === 'busy,noted' || both.map((x) => x.r && x.r.state).sort().join() === 'already,noted', both.map((x) => (x.r ? x.r.state : x.e && x.e.message)));
    const q = db3.store.get('call_transcribe_quota/2026-11-09__c__' + OWNER);
    ok('…and only the run that transcribed keeps a quota count', q && q.n === 1, q);

    // The same person twice (a double tap, two tabs, both cards): the lease
    // holder's own id is no pass either.
    stubDeps();
    tDelay = 30;
    const db4 = makeDb(seed());
    const same = await Promise.all([tap(db4, AUTH.owner), tap(db4, AUTH.owner)]);
    tDelay = 0;
    const sameStates = same.map((x) => x.r && x.r.state).sort().join();
    ok('the same user tapping twice at once → ONE Groq call', tCalls === 1, tCalls);
    ok('…one says noted, the other already / busy', sameStates === 'busy,noted' || sameStates === 'already,noted', same.map((x) => (x.r ? x.r.state : x.e && x.e.message)));
    const q4 = db4.store.get('call_transcribe_quota/2026-11-09__c__' + OWNER);
    ok('…and the quota counts it once', q4 && q4.n === 1, q4);
  }

  console.log('\n6. Switches');
  for (const [name, setup] of [
    ['the AI kill switch', () => { flags = { aiDisabled: true }; }],
    ['CALL_CENTER_TRANSCRIBE_ENABLED off', () => { process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'false'; }],
  ]) {
    stubDeps();
    setup();
    const { e } = await tap(makeDb(seed()), AUTH.owner);
    ok(name + ' → refused before any audio leaves', e && e.code === 'failed-precondition' && tCalls === 0, e ? e.code + ' ' + e.message : 'allowed');
    flags = {}; process.env.CALL_CENTER_TRANSCRIBE_ENABLED = 'true';
  }
  {
    stubDeps();
    const { e } = await tap(makeDb(seed({}, { 'integrations/callCenter': { paused: true } })), AUTH.owner);
    ok('integrations/callCenter.paused → refused', e && e.code === 'failed-precondition' && tCalls === 0, e && e.message);
  }

  console.log('\n7. Which calls');
  for (const [name, over, extra, who] of [
    ['a short call', { status: 'short', storagePath: null }],
    ['a personal call', { status: 'personal', storagePath: null }],
    ['a recording too large for Groq', { status: 'too_large' }],
    ['no recording', { storagePath: null }],
    ['a call outside the owner\'s queue (a teammate may act on it, the schedule never picks it)', { userId: 'someone-else', companyId: OWNER }, {}, 'ca'],
    ['three failed tries', { transcribeAttempts: 3, transcribeError: 'bad audio' }],
    ['today\'s audio allowance spent', {}, { 'integrations/callCenter': { audioSecDay: '2026-11-09', audioSecUsed: 7.5 * 3600 } }],
  ]) {
    stubDeps();
    const db = makeDb(seed(over, extra));
    const { r, e } = await tap(db, AUTH[who || 'owner']);
    ok(name + ' → not transcribed, says why', tCalls === 0 && ((e && e.code === 'failed-precondition' && e.message) || (r && r.state !== 'noted' && r.message)), e ? e.code : r);
    ok(name + ' → no quota spent', ![...db.store.keys()].some((k) => k.startsWith('call_transcribe_quota/')));
  }

  console.log('\n8. Daily caps');
  ok('caps are 10 per user and 30 per company', TN && TN.USER_DAY_CAP === 10 && TN.COMPANY_DAY_CAP === 30);
  {
    stubDeps();
    const db = makeDb(seed({}, { ['call_transcribe_quota/2026-11-09__u__' + OWNER]: { n: 10 } }));
    const { e } = await tap(db, AUTH.owner);
    ok('user over the cap → resource-exhausted, no Groq call', e && e.code === 'resource-exhausted' && tCalls === 0, e && e.code);
    stubDeps();
    const db2 = makeDb(seed({}, { ['call_transcribe_quota/2026-11-09__c__' + OWNER]: { n: 30 } }));
    const r2 = await tap(db2, AUTH.mgr);
    ok('company over the cap → resource-exhausted (a teammate too)', r2.e && r2.e.code === 'resource-exhausted' && tCalls === 0, r2.e && r2.e.code);
    stubDeps();
    const db3 = makeDb(seed());
    const r3 = await tap(db3, AUTH.mgr);
    const u = db3.store.get('call_transcribe_quota/2026-11-09__u__mg1');
    const c = db3.store.get('call_transcribe_quota/2026-11-09__c__' + OWNER);
    ok('a run counts once for the user and once for the company', r3.r && u && u.n === 1 && c && c.n === 1, { u, c });
    const call = db3.store.get('phone_calls/' + ID);
    ok('the call is noted with its segment index and no lease', call.status === 'noted' && call.segIndex && !call.transcribeLease, call.status);
    ok('the answer says what happened, with the transcript', !!r3.r && r3.r.state === 'noted' && r3.r.transcript === TEXT && typeof r3.r.message === 'string');
    stubDeps();
    const db4 = makeDb(seed({}, { ['call_transcribe_quota/2026-11-10__u__' + OWNER]: { n: 10 } }));
    const r4 = await tap(db4, AUTH.owner);
    ok('a cap is per ET day (yesterday\'s count does not block today)', r4.r && r4.r.state === 'noted', r4.e && r4.e.message);
  }

  console.log('\n9. Wiring');
  ok('callTranscribeNow: App Check enforced, Groq + Anthropic secrets', TN && TN.callTranscribeNow && TN.callTranscribeNow.__opts.enforceAppCheck === true
    && ['GROQ_API_KEY', 'ANTHROPIC_API_KEY'].every((n) => (TN.callTranscribeNow.__opts.secrets || []).some((s) => (s && s.name) === n)), TN && TN.callTranscribeNow && TN.callTranscribeNow.__opts);
  ok('callTranscribeNow: ghost check in the wrapper', /assertNotGhost\(request\)/.test(TN ? read('functions/call-transcribe-now.js') : ''));
  ok('a timeout long enough for a long call (≥ 300 s), under the lease', TN && TN.callTranscribeNow.__opts.timeoutSeconds >= 300 && TN.callTranscribeNow.__opts.timeoutSeconds * 1000 < CC.TRANSCRIBE_LEASE_MS, TN && TN.callTranscribeNow.__opts.timeoutSeconds);
  ok('index.js exports callTranscribeNow', /exports\.callTranscribeNow = require\('\.\/call-transcribe-now'\)\.callTranscribeNow/.test(read('functions/index.js')));
  ok('function-map.json maps it', JSON.parse(read('functions/function-map.json')).callTranscribeNow === './call-transcribe-now');
  ok('FUNCTIONS_INDEX.md has its row', /\| `callTranscribeNow` \|/.test(read('functions/FUNCTIONS_INDEX.md')));
  ok('the demo answers it with the no-phone answer (nothing leaves)', /callTranscribeNow: \(\) => \{ throw noPhoneInSample\('callTranscribeNow'\); \}/.test(read('docs/pro/demo-sdk/firebase-functions.js')));
  ok('the lease outlives the scheduled run (540 s)', Number(CC.TRANSCRIBE_LEASE_MS) > 540e3, CC.TRANSCRIBE_LEASE_MS);

  console.log('\n10. The buttons');
  function gateFrom(file) {
    const m = /function txGate\(c\) \{[\s\S]*?\n  \}\n/.exec(read(file));
    if (!m) return null;
    return (claims, uid, c) => {
      const ctx = vm.createContext({ window: { _userClaims: claims, auth: { currentUser: { uid } } } });
      vm.runInContext('function claims() { return window._userClaims || {}; }\nfunction isViewer() { return claims().role === "viewer"; }\n' + m[0] + '\nthis.__r = txGate(' + JSON.stringify(c) + ');', ctx);
      return ctx.__r;
    };
  }
  const BASE = { userId: 'jo', companyId: 'co1', status: 'stored', storagePath: 'calls/jo/x.m4a', transcript: null };
  const CASES = [
    ['owner, stored, no transcript', [{}, 'jo'], {}, true],
    ['company_admin, same company', [{ role: 'company_admin', companyId: 'co1' }, 'ca'], {}, true],
    ['manager, same company', [{ role: 'manager', companyId: 'co1' }, 'mg'], {}, true],
    ['platform admin', [{ role: 'admin' }, 'adm'], {}, true],
    ['viewer', [{ role: 'viewer', companyId: 'co1' }, 'v'], {}, false],
    ['sales rep who does not own the call', [{ role: 'sales_rep', companyId: 'co1' }, 'rep'], {}, false],
    ['company_admin of another company', [{ role: 'company_admin', companyId: 'co2' }, 'x'], {}, false],
    ['already noted', [{}, 'jo'], { status: 'noted', transcript: 'hi' }, false],
    ['a transcript saved, notes pending', [{}, 'jo'], { transcript: 'hi' }, false],
    ['short call', [{}, 'jo'], { status: 'short', storagePath: null }, false],
    ['personal', [{}, 'jo'], { status: 'personal' }, false],
    ['no recording', [{}, 'jo'], { storagePath: null }, false],
  ];
  for (const file of ['docs/pro/js/customer-calls.js', 'docs/pro/js/call-center-view.js']) {
    const gate = gateFrom(file);
    ok(path.basename(file) + ': txGate exists', !!gate);
    if (!gate) continue;
    for (const [name, [claims, uid], over, want] of CASES) ok(path.basename(file) + ': ' + name + ' → ' + (want ? 'button' : 'none'), gate(claims, uid, Object.assign({}, BASE, over)) === want);
  }
  const cc = read('docs/pro/js/customer-calls.js');
  const cv = read('docs/pro/js/call-center-view.js');
  ok('customer card: the button renders behind txGate, not for viewers', /txGate\(c\)[^\n]*data-calls-act="pc-tx"[^\n]*Transcribe now/.test(cc) && /if \(!isViewer\(\)\) \{[\s\S]*?txGate\(c\)/.test(cc));
  ok('Call Center card: the button renders behind txGate, not for viewers', /txGate\(c\)[^\n]*data-cc="tx"[^\n]*Transcribe now/.test(cv) && /if \(!isViewer\(\)\) \{[\s\S]*?txGate\(c\)/.test(cv));
  ok('both taps go through the lazy sheet (NBDCallBrief.transcribe), no new <script>', /pc-tx[\s\S]{0,80}openBrief\(id, 1\)/.test(cc) && /'tx'[\s\S]{0,40}openBrief\(id, 1\)/.test(cv) && /NBDCallBrief\[tx \? 'transcribe' : 'open'\]/.test(cc) && /NBDCallBrief\[tx \? 'transcribe' : 'open'\]/.test(cv));
  const ui = read('docs/pro/js/call-brief-ui.js');
  ok('the sheet module calls callTranscribeNow', /callable\('callTranscribeNow', \{ callId:/.test(ui) && /transcribe: transcribe/.test(ui));
  ok('no <script> tag names a new file', !/call-transcribe/.test(read('docs/pro/customer.html') + read('docs/pro/dashboard.html')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failed:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
