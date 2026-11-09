/**
 * tests/call-to-close-auto-brief-2026-11-09.test.js — Call to Close P1: the
 * auto-brief company flag (functions/call-brief.js callBriefAuto,
 * call-brief-logic.js autoBriefTransition / filerOf).
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.1 (P1
 * auto-brief behind a company flag, the same human-filed gate), §7, §9 P1.
 *
 * Every model call is a fake; nothing reaches Anthropic or Firestore.
 *
 *   1. the transition: only when a PERSON files a noted business call (or it
 *      becomes noted after a person filed it, or a person moves it); never an
 *      unfiled, auto-matched, alternates, short, personal or spam call, never
 *      a re-run on a call already briefable on the same customer
 *   2. the flag: companies/{companyId}/settings/callBrief.autoBrief must be
 *      true; absent or false → nothing (default OFF)
 *   3. the same gates as callBrief: both kill switches, the filer must pass
 *      callCenterAction's role test (a viewer or a sales rep who does not own
 *      the call never triggers it), verified email + paid plan, the per-user
 *      and per-company day caps, the cache (an existing brief costs nothing)
 *   4. the write: the same server-only path, marked auto, generatedBy the
 *      filer; nothing else is written (no lead field, no stage, no send)
 *   5. callBriefDecide logs the follow-up draft items (draft:followupText,
 *      draft:followupEmail) and still refuses anything else
 *   6. wiring: a Firestore trigger on phone_calls/{callId}, the Anthropic
 *      secret, index.js, FUNCTIONS_INDEX.md, function-map.json
 *
 * Run: node tests/call-to-close-auto-brief-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const INC = Symbol('inc');
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  const writes = [];
  function mergeInto(base, patch) {
    const out = Object.assign({}, base || {});
    for (const [k, v] of Object.entries(patch || {})) {
      if (v && v[INC] !== undefined) out[k] = (Number(out[k]) || 0) + v[INC];
      else if (v && typeof v === 'object' && !Array.isArray(v) && !v.__ts && Object.getPrototypeOf(v) === Object.prototype) out[k] = mergeInto(out[k], v);
      else out[k] = v;
    }
    return out;
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function doc(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => ({ id: p.split('/').pop(), exists: store.has(p), data: () => (store.has(p) ? clone(store.get(p)) : undefined) }),
      set: async (data, opts) => { writes.push({ op: 'set', path: p, data }); store.set(p, opts && opts.merge ? mergeInto(store.get(p), data) : mergeInto({}, data)); },
      create: async (data) => { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push({ op: 'create', path: p, data }); store.set(p, mergeInto({}, data)); },
      delete: async () => { writes.push({ op: 'delete', path: p }); store.delete(p); },
      collection: (n) => coll(p + '/' + n),
    };
  }
  function coll(name) { return { doc: (id) => doc(name + '/' + id) }; }
  return {
    store, writes, doc, collection: coll,
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o), create: (r, d) => r.create(d) }),
  };
}
const FV = { increment: (n) => ({ [INC]: n }), serverTimestamp: () => ({ __ts: true }), delete: () => null };
const silent = { info() {}, warn() {}, error() {}, debug() {} };
let flags = {};
let currentDb = makeDb();
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const STUBS = {
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
  'firebase-functions/v2': { logger: silent },
  'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
  'firebase-functions/v2/firestore': { onDocumentUpdated: (o, h) => ({ __trigger: 'updated', __opts: o, __handler: h }), onDocumentWritten: (o, h) => ({ __trigger: 'written', __opts: o, __handler: h }) },
  'firebase-admin/firestore': { getFirestore: () => currentDb, FieldValue: FV, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
  'firebase-admin/auth': { getAuth: () => ({ getUser: async () => { throw new Error('tests inject getUser'); } }) },
  './integrations/killswitch': { isAiDisabled: async () => flags.aiDisabled === true, isCallBriefDisabled: async () => flags.callBriefDisabled === true, getFlags: async () => flags },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
const CB = require(path.join(FN, 'call-brief.js'));
const L = require(path.join(FN, 'call-brief-logic.js'));
const T = CB._test || {};

const NOW = Date.parse('2026-11-05T18:00:00Z');
const CALL_ID = 'cube_AUTO000001';
const TRANSCRIPT = 'Hi, this is Pat over on Example Street. We had that hail storm last Tuesday and the roof is leaking in the kitchen. My insurance is State Farm. Okay, I will send you the estimate by Friday. Thanks.';
const CANNED = {
  brief_v: 1, transcript_ok: { reliable: true, cutOff: false, why: '' },
  summary: { text: 'Hail leak; State Farm.', quote: ['the roof is leaking in the kitchen'] },
  fields: {
    insCarrier: { value: 'State Farm', quote: 'My insurance is State Farm', conf: 'said' },
    claimNumber: { value: '', quote: '', conf: 'implied' },
    dateOfLoss: { spoken: 'last Tuesday', ymd: '2026-11-03', quote: 'hail storm last Tuesday', conf: 'said' },
    adjusterName: { value: '', quote: '', conf: 'implied' },
    adjusterMeetingYmd: { spoken: '', ymd: '', quote: '', conf: 'implied' },
    damageType: { value: 'hail', quote: 'hail storm', conf: 'said' },
    jobType: { value: '', quote: '', conf: 'implied' }, workKind: { value: '', quote: '', conf: 'implied' },
  },
  scope: { service: { value: '', quote: '', conf: 'implied' }, tierInterest: '', tierQuote: '', stories: '', storiesQuote: '', layers: '', layersQuote: '', mentions: { gutters: false, chimney: false, skylight: false, decking: false }, saidQuantities: [] },
  promises: [{ who: 'jo', text: 'Send the estimate', dueSpoken: 'by Friday', dueYmd: '2026-11-06', kind: 'estimate', quote: 'I will send you the estimate by Friday' }],
  followUp: { spoken: '', ymd: '', quote: '', conf: 'implied' },
  objections: [], competitor: { named: false, quote: '' }, people: [], stage: null,
  drafts: { estimate: true, proposal: false, followUp: 'none' },
};
const FILED = { userId: 'jo', companyId: 'co1', status: 'noted', callType: 'customer', leadId: 'L1', attachedBy: 'jo', attachedAtMs: NOW - 60e3, alternateLeadIds: [], transcript: TRANSCRIPT, startedAtMs: Date.parse('2026-11-05T15:00:00Z'), direction: 'inbound' };
const UNFILED = Object.assign({}, FILED, { attachedBy: null, attachedAtMs: null });
function seed(over) {
  return Object.assign({
    ['phone_calls/' + CALL_ID]: FILED,
    'leads/L1': { userId: 'jo', companyId: 'co1', firstName: 'Pat', insCarrier: '' },
    'subscriptions/co1': { plan: 'growth', status: 'active' },
    'companyProfile/co1': { companyName: 'Example Roofing Co', city: 'Dayton', state: 'OH' },
    'companies/co1/settings/callBrief': { autoBrief: true },
  }, over || {});
}
const USERS = {
  jo: { uid: 'jo', emailVerified: true, customClaims: { companyId: 'co1' } },
  ca: { uid: 'ca', emailVerified: true, customClaims: { role: 'company_admin', companyId: 'co1' } },
  rep: { uid: 'rep', emailVerified: true, customClaims: { role: 'sales_rep', companyId: 'co1' } },
  vic: { uid: 'vic', emailVerified: true, customClaims: { role: 'viewer', companyId: 'co1' } },
  unv: { uid: 'unv', emailVerified: false, customClaims: { role: 'company_admin', companyId: 'co1' } },
  off: { uid: 'off', emailVerified: true, disabled: true, customClaims: { role: 'company_admin', companyId: 'co1' } },
  // A former owner whose claims were stripped (tenant-guard.js "ghost"): no
  // companyId claim, and companies/gho now names someone else as owner.
  gho: { uid: 'gho', emailVerified: true, customClaims: {} },
};
const getUser = async (uid) => { if (!USERS[uid]) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; } return USERS[uid]; };
let modelCalls = [];
const model = async (req) => { modelCalls.push(req); return { model: req.model, usage: { input_tokens: 2500, output_tokens: 800 }, content: [{ type: 'text', text: JSON.stringify(CANNED) }] }; };
async function auto(db, before, after, extra) {
  currentDb = db;
  db.store.set('phone_calls/' + CALL_ID, after);
  return T.autoBriefHandler(Object.assign({ db, callId: CALL_ID, before, after, nowMs: NOW, callModel: model, getUser, log: silent }, extra || {}));
}

(async () => {
  console.log('\n1. When a call is filed by a person');
  {
    const tr = L.autoBriefTransition;
    ok('call-brief-logic exports autoBriefTransition and filerOf', typeof tr === 'function' && typeof L.filerOf === 'function');
    if (typeof tr === 'function') {
      ok('auto-matched → filed by a person (attachedBy set): yes', tr(UNFILED, FILED) === true);
      ok('filed by a person, then the notes arrive (stored → noted): yes', tr(Object.assign({}, FILED, { status: 'stored', transcript: '' }), FILED) === true);
      ok('moved by a person to another customer: yes', tr(FILED, Object.assign({}, FILED, { leadId: 'L2', movedBy: 'ca', movedAtMs: NOW })) === true);
      ok('a later write on a call already briefable on the same customer (handled, a re-note): no', tr(FILED, Object.assign({}, FILED, { handledAtMs: NOW })) === false);
      ok('never an unfiled call (auto-matched, no attachedBy / movedBy)', tr(Object.assign({}, UNFILED, { status: 'stored' }), UNFILED) === false);
      ok('never a call with alternate customers on the number', tr(UNFILED, Object.assign({}, FILED, { alternateLeadIds: ['L9'] })) === false);
      ok('never a call on no customer', tr(UNFILED, Object.assign({}, FILED, { leadId: null })) === false);
      for (const [n, over] of [['short', { status: 'short' }], ['personal', { status: 'personal', callType: 'personal' }], ['spam', { callType: 'spam' }], ['not noted', { status: 'stored' }], ['no transcript', { transcript: '' }]]) {
        ok('never a ' + n + ' call', tr(UNFILED, Object.assign({}, FILED, over)) === false);
      }
      ok('a created doc (no before) that is somehow filed: yes', tr(null, FILED) === true);
      // One attach re-files every earlier unfiled call from the number
      // (call-center.js refileNumber → fileCallOnLead extra { refiledFrom }).
      // The person filed ONE call: the swept ones are never auto-briefed.
      const REFILED = Object.assign({}, FILED, { refiledFrom: 'cube_OTHER0001' });
      ok('a call swept onto the customer by another call\'s attach (refiledFrom): no', tr(UNFILED, REFILED) === false);
      ok('…nor when its notes arrive later', tr(Object.assign({}, REFILED, { status: 'stored', transcript: '' }), REFILED) === false);
      ok('…but a person moving it afterwards: yes (movedBy is the later act)', tr(REFILED, Object.assign({}, REFILED, { leadId: 'L2', movedBy: 'ca', movedAtMs: NOW })) === true);
      ok('…and a person attaching it themselves (refiledFrom cleared): yes', tr(REFILED, Object.assign({}, REFILED, { refiledFrom: null, attachedAtMs: NOW })) === true);
      ok('the filer is the latest person: movedBy after attachedBy', L.filerOf(Object.assign({}, FILED, { movedBy: 'ca', movedAtMs: NOW })) === 'ca' && L.filerOf(FILED) === 'jo');
    }
  }

  if (typeof T.autoBriefHandler !== 'function') {
    ok('call-brief.js _test exports autoBriefHandler', false);
  } else {
    console.log('\n2. The company flag (default OFF)');
    {
      modelCalls = [];
      const s0 = seed(); delete s0['companies/co1/settings/callBrief'];
      const r0 = await auto(makeDb(s0), UNFILED, FILED);
      ok('no settings doc → nothing (default off)', r0 && r0.state === 'flag-off' && modelCalls.length === 0, r0);
      const r1 = await auto(makeDb(seed({ 'companies/co1/settings/callBrief': { autoBrief: false } })), UNFILED, FILED);
      ok('autoBrief false → nothing', r1.state === 'flag-off' && modelCalls.length === 0);
      const r2 = await auto(makeDb(seed({ 'companies/co1/settings/callBrief': { autoBrief: 'true' } })), UNFILED, FILED);
      ok('autoBrief "true" (a string) → nothing', r2.state === 'flag-off' && modelCalls.length === 0);
      const db = makeDb(seed());
      const r3 = await auto(db, UNFILED, FILED);
      ok('autoBrief true + a person filed it → one brief', r3.state === 'briefed' && modelCalls.length === 1, r3);
      const other = makeDb(seed({ 'companies/co2/settings/callBrief': { autoBrief: true }, 'companies/co1/settings/callBrief': { autoBrief: false } }));
      const r4 = await auto(other, UNFILED, FILED);
      ok('another company\'s flag does not turn it on for this call', r4.state === 'flag-off');
    }

    console.log('\n3. The same gates as callBrief');
    {
      modelCalls = [];
      const nf = await auto(makeDb(seed()), UNFILED, Object.assign({}, UNFILED, { handledAtMs: NOW }));
      ok('an unfiled call → nothing, before the flag is read', nf.state === 'not-filed-now' && modelCalls.length === 0);
      const rf = await auto(makeDb(seed()), UNFILED, Object.assign({}, FILED, { refiledFrom: 'cube_OTHER0001' }));
      ok('a call swept on by another call\'s attach → nothing, no quota (one tap never drafts many briefs)', rf.state === 'not-filed-now' && modelCalls.length === 0, rf);
      flags = { aiDisabled: true };
      const k1 = await auto(makeDb(seed()), UNFILED, FILED);
      flags = { callBriefDisabled: true };
      const k2 = await auto(makeDb(seed()), UNFILED, FILED);
      flags = {};
      ok('aiDisabled → nothing', k1.state === 'switched-off');
      ok('callBriefDisabled → nothing', k2.state === 'switched-off');
      const rep = await auto(makeDb(seed()), UNFILED, Object.assign({}, FILED, { attachedBy: 'rep' }));
      ok('filed by a sales rep who does not own the call → nothing (the brief is not theirs to see)', rep.state === 'gated' && /Not your call/.test(rep.why), rep);
      const vic = await auto(makeDb(seed()), UNFILED, Object.assign({}, FILED, { attachedBy: 'vic' }));
      ok('a viewer as the filer → nothing', vic.state === 'gated');
      const ghost = await auto(makeDb(seed()), UNFILED, Object.assign({}, FILED, { attachedBy: 'nobody' }));
      ok('a filer who no longer exists → nothing', ghost.state === 'gated');
      const dis = await auto(makeDb(seed()), UNFILED, Object.assign({}, FILED, { attachedBy: 'off' }));
      ok('a disabled filer → nothing', dis.state === 'gated');
      const ghostSeed = seed({ 'companies/gho': { ownerId: 'jo' }, 'subscriptions/gho': { plan: 'growth', status: 'active' } });
      const gh = await auto(makeDb(ghostSeed), UNFILED, Object.assign({}, FILED, { userId: 'gho', attachedBy: 'gho' }));
      ok('a filer tenant-guard calls a ghost (claims stripped, company handed off) → nothing, as the callables refuse them', gh.state === 'gated' && /no longer belongs/.test(gh.why || ''), gh);
      const unv = await auto(makeDb(seed()), UNFILED, Object.assign({}, FILED, { attachedBy: 'unv' }));
      ok('an unverified email → nothing', unv.state === 'plan');
      const s = seed(); delete s['subscriptions/co1'];
      const fr = await auto(makeDb(s), UNFILED, FILED);
      ok('no paid plan → nothing', fr.state === 'plan');
      const wt = await auto(makeDb(seed({ 'leads/L1': { userId: 'x', companyId: 'co9' } })), UNFILED, FILED);
      ok('the lead is in another tenant → nothing', wt.state === 'gated');
      ok('none of those reached the model', modelCalls.length === 0);
      const q = await auto(makeDb(seed({ 'call_brief_quota/2026-11-05__u__jo': { n: 20 } })), UNFILED, FILED);
      ok('the filer\'s 21st brief of the day → nothing (the 20 cap counts auto briefs)', q.state === 'quota');
      const qc = await auto(makeDb(seed({ 'call_brief_quota/2026-11-05__c__co1': { n: 60 } })), UNFILED, FILED);
      ok('the company\'s 61st → nothing', qc.state === 'quota');
      ok('…no model call', modelCalls.length === 0);
      const db = makeDb(seed());
      await auto(db, UNFILED, FILED);
      const again = await auto(db, Object.assign({}, FILED, { status: 'stored' }), FILED);
      ok('a brief already stored for this transcript → cached, no second model call, no quota', again.state === 'cached' && modelCalls.length === 1 && db.store.get('call_brief_quota/2026-11-05__u__jo').n === 1);
      const failing = async () => { throw new Error('anthropic 529'); };
      const fdb = makeDb(seed());
      const fl = await auto(fdb, UNFILED, FILED, { callModel: failing });
      ok('a model failure → no brief stored, no throw (the trigger never retries into a loop)', fl.state === 'failed' && !fdb.store.has('leads/L1/call_briefs/' + CALL_ID));
    }

    console.log('\n4. The write');
    {
      modelCalls = [];
      const db = makeDb(seed());
      const r = await auto(db, UNFILED, Object.assign({}, FILED, { attachedBy: 'ca' }));
      const stored = db.store.get('leads/L1/call_briefs/' + CALL_ID);
      ok('stored at leads/L1/call_briefs/<callId>, the same doc callBrief reads', r.state === 'briefed' && stored && stored.callId === CALL_ID && stored.v === L.BRIEF_VERSION);
      ok('marked auto, generatedBy the filer', stored.auto === true && stored.generatedBy === 'ca');
      ok('counted on the filer\'s and the company\'s quota', db.store.get('call_brief_quota/2026-11-05__u__ca').n === 1 && db.store.get('call_brief_quota/2026-11-05__c__co1').n === 1);
      const paths = db.writes.map((w) => w.path);
      ok('writes only the brief, the quota and the spend row (no lead field, no stage, no task, no send)',
        paths.every((p) => p === 'leads/L1/call_briefs/' + CALL_ID || p.startsWith('call_brief_quota/') || p.startsWith('ai_spend')), paths);
      ok('the lead is untouched (nothing is accepted for you)', JSON.stringify(db.store.get('leads/L1')) === JSON.stringify(seed()['leads/L1']));
      ok('decisions start empty (nothing pre-ticked)', Array.isArray(stored.decisions) && stored.decisions.length === 0);
      const tap = await T.briefCallable({ db, auth: { uid: 'jo', token: { companyId: 'co1', email_verified: true } }, data: { callId: CALL_ID }, nowMs: NOW + 60e3, callModel: model, log: silent });
      ok('a later tap on the call serves the auto brief from the cache (no model call)', tap.cached === true && modelCalls.length === 1);
    }
  }

  console.log('\n5. callBriefDecide logs the follow-up draft items');
  {
    const db = makeDb(seed());
    currentDb = db;
    await T.briefCallable({ db, auth: { uid: 'jo', token: { companyId: 'co1', email_verified: true } }, data: { callId: CALL_ID }, nowMs: NOW, callModel: model, log: silent });
    for (const item of ['draft:followupText', 'draft:followupEmail']) {
      let r = null, e = null;
      try { r = await T.decideCallable({ db, auth: { uid: 'jo', token: { companyId: 'co1' } }, data: { callId: CALL_ID, item, decision: 'accept', value: 'Hi Pat, thanks for the call.' }, nowMs: NOW, log: silent }); } catch (x) { e = x; }
      ok(item + ' is logged (written: false, nothing sent)', r && r.ok === true && r.written === false, e && e.message);
    }
    let e2 = null;
    try { await T.decideCallable({ db, auth: { uid: 'jo', token: { companyId: 'co1' } }, data: { callId: CALL_ID, item: 'draft:sendNow', decision: 'accept' }, nowMs: NOW, log: silent }); } catch (x) { e2 = x; }
    ok('any other draft item is refused', e2 && e2.code === 'invalid-argument');
  }

  console.log('\n6. Wiring');
  {
    const trig = CB.callBriefAuto;
    ok('callBriefAuto is a Firestore update trigger on phone_calls/{callId}', !!trig && trig.__trigger === 'updated' && trig.__opts && trig.__opts.document === 'phone_calls/{callId}', trig && trig.__opts);
    ok('…with the Anthropic secret and its own timeout', !!trig && (trig.__opts.secrets || []).some((s) => s.name === 'ANTHROPIC_API_KEY') && trig.__opts.timeoutSeconds > 0);
    const idx = read('functions/index.js');
    ok('index.js exports callBriefAuto', /exports\.callBriefAuto = require\('\.\/call-brief'\)\.callBriefAuto/.test(idx));
    ok('FUNCTIONS_INDEX.md has a callBriefAuto row', /\| `callBriefAuto` \|/.test(read('functions/FUNCTIONS_INDEX.md')));
    ok('function-map.json maps callBriefAuto to ./call-brief', JSON.parse(read('functions/function-map.json')).callBriefAuto === './call-brief');
    const src = read('functions/call-brief.js');
    ok('the trigger never throws back into Firestore (it logs and returns)', /callBriefAuto[\s\S]*catch/.test(src));
  }

  console.log('\n7. The switch on the Call Center (owner / company_admin)');
  {
    const cv = read('docs/pro/js/call-center-view.js');
    const block = (cv.match(/\/\/ ── Auto-brief switch[\s\S]*?\/\/ ── end auto-brief switch/) || [''])[0];
    ok('a switch block exists in call-center-view.js', block.length > 0);
    ok('shown to the owner or a company_admin only (never a manager, rep or viewer)', /function canSetAutoBrief\(\)/.test(block) && /company_admin/.test(block) && !/'manager'/.test(block) && /isViewer\(\)/.test(block));
    ok('reads companies/{companyId}/settings/callBrief; absent = Off', /'companies', cid, 'settings', 'callBrief'/.test(block) && /autoBrief === true/.test(block));
    ok('writes only autoBrief, updatedBy (the writer) and updatedAt (the rules\' keys)', /setDoc\([\s\S]*?\{ autoBrief: next, updatedBy: me, updatedAt: window\.serverTimestamp\(\) \}/.test(block));
    ok('turning it ON asks first (nbdConfirm) and names the daily limit', /nbdConfirm/.test(block) && /20 briefs a day/.test(block));
    ok('says it is off by default and only drafts (nothing is sent or filled in)', /Off by default/.test(block) && /Nothing is filled in, sent or moved/.test(block));
    ok('no inline style or handler', !/style=|\son[a-z]+=/.test(block));
    ok('shown only when this account has phone calls loaded (the call pipeline exists)', /channel !== 'text'/.test(block));

    // Behaviour, not just the source: run canSetAutoBrief with real claim
    // shapes. The owner accounts carry mintOwnerClaims' { owner: true,
    // role: 'admin' } (functions/handlers/auth.js), so the owner must see it.
    const fnSrc = (block.match(/function canSetAutoBrief\(\) \{[\s\S]*?\n  \}/) || [''])[0];
    ok('canSetAutoBrief is extractable from the block', fnSrc.length > 0);
    const can = (claims, uid) => {
      const sandbox = { window: { _user: uid === null ? null : { uid: uid || 'jo' }, _userClaims: claims } };
      return vm.runInNewContext('function claims() { return window._userClaims || {}; }\nfunction isViewer() { return claims().role === \'viewer\'; }\n' + fnSrc + '\ncanSetAutoBrief();', sandbox);
    };
    if (fnSrc) {
      ok('the owner (mintOwnerClaims: owner true, role admin, companyId = uid) sees the switch', can({ owner: true, role: 'admin', companyId: 'jo' }) === true);
      ok('the platform admin role sees it (the rules allow isAdmin())', can({ role: 'admin' }) === true);
      ok('a solo owner with no role claim sees it', can({}) === true && can({ companyId: 'jo' }) === true);
      ok('a company_admin of a company sees it', can({ role: 'company_admin', companyId: 'co1' }, 'ca') === true);
      ok('a manager does not', can({ role: 'manager', companyId: 'co1' }, 'm') === false);
      ok('a sales rep does not', can({ role: 'sales_rep', companyId: 'co1' }, 'rep') === false);
      ok('a viewer does not', can({ role: 'viewer', companyId: 'co1' }, 'vic') === false);
      ok('a member of someone else\'s company with no role does not (companyId is not their uid)', can({ companyId: 'co1' }, 'x') === false);
      ok('signed out → no', can({ role: 'admin' }, null) === false);
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
