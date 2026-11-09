/**
 * tests/call-to-close-segment-confidence-2026-11-09.test.js — Call to Close
 * P1, lane "transcribe now + segment confidence" (design §3.2 point 4, §9 P1
 * item 2).
 *
 * The call doc carries a segment index (call-center-logic buildSegIndex:
 * start / end / char offset / avg_logprob per Whisper segment). The brief
 * uses it:
 *   1. call-brief-logic: a quote that falls ONLY in segments whose
 *      avg_logprob is below LOW_LOGPROB (-1.0, Whisper's own fallback
 *      threshold) is "unsure"; one clear segment under it is enough; no index
 *      (an older call) marks nothing; a quote the index cannot place is unsure
 *   2. sanitizeBrief: unsure facts, promises, stage and summary quotes are
 *      marked; a FIELD whose value has a digit (claim #, a date) and is unsure
 *      gets retype: it is never offered for one-tap fill
 *   3. callBrief passes the call's segIndex; callBriefDecide refuses a retype
 *      field without a value the person typed (retyped: true)
 *   4. the sheet: unsure quotes say so; a retype field has no Accept, starts
 *      with an empty input, and sends retyped: true
 *
 * Run: node tests/call-to-close-segment-confidence-2026-11-09.test.js
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

// ── stubs (the P0 callable suite's pattern) ──────────────────────────────
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function doc(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => ({ id: p.split('/').pop(), exists: store.has(p), data: () => clone(store.get(p)) }),
      set: async (d, o) => { store.set(p, o && o.merge ? Object.assign({}, store.get(p) || {}, clone(d)) : clone(d)); },
      create: async (d) => { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, clone(d)); },
      collection: (n) => ({ doc: (id) => doc(p + '/' + n + '/' + id) }),
    };
  }
  return { store, doc, collection: (n) => ({ doc: (id) => doc(n + '/' + id) }), runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o) }) };
}
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const silent = { info() {}, warn() {}, error() {}, debug() {} };
let currentDb = makeDb();
const STUBS = {
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
  'firebase-functions/v2': { logger: silent },
  'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
  'firebase-admin/firestore': { getFirestore: () => currentDb, FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: (n) => n, delete: () => null }, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
  './integrations/killswitch': { isAiDisabled: async () => false, isCallBriefDisabled: async () => false, getFlags: async () => ({}) },
};
const realLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad.apply(this, arguments);
};
const L = require(path.join(FN, 'call-brief-logic.js'));
const CL = require(path.join(FN, 'call-center-logic.js'));
const CB = require(path.join(FN, 'call-brief.js'));

// A call whose claim-number sentence Whisper was unsure of.
const TRANSCRIPT = 'Hi, this is Pat over on Example Street. We had that hail storm last Tuesday and the roof is leaking in the kitchen. My insurance is State Farm. The claim number is 4 4 7 2 9. Okay, I will send you the estimate by Friday. Thanks.';
const SENTS = TRANSCRIPT.match(/[^.]+\.\s*/g).map((s) => ' ' + s.trim());
const LPS = [-0.2, -0.3, -0.25, -1.6, -0.3, -0.2];  // sentence 4 (the claim #) is low
let at = 0;
const SEGS = SENTS.map((t, i) => { const s = { start: at, end: at + 3, text: t, avgLogprob: LPS[i] }; at += 3; return s; });
const SEG = CL.buildSegIndex ? CL.buildSegIndex(SEGS, TRANSCRIPT) : null;

const RAW = {
  brief_v: 1, transcript_ok: { reliable: true, cutOff: false, why: '' },
  summary: { text: 'Hail leak; State Farm claim.', quote: ['the roof is leaking in the kitchen', 'the claim number is 4 4 7 2 9'] },
  fields: {
    insCarrier: { value: 'State Farm', quote: 'My insurance is State Farm', conf: 'said' },
    claimNumber: { value: '44729', quote: 'the claim number is 4 4 7 2 9', conf: 'said' },
    dateOfLoss: { spoken: 'last Tuesday', ymd: '2026-11-03', quote: 'hail storm last Tuesday', conf: 'said' },
    adjusterName: { value: '', quote: '', conf: 'implied' },
    adjusterMeetingYmd: { spoken: '', ymd: '', quote: '', conf: 'implied' },
    damageType: { value: 'hail', quote: 'hail storm', conf: 'said' },
    jobType: { value: 'insurance', quote: 'My insurance is State Farm', conf: 'implied' },
    workKind: { value: '', quote: '', conf: 'implied' },
  },
  scope: { service: { value: '', quote: '', conf: 'implied' }, tierInterest: '', tierQuote: '', stories: '', storiesQuote: '', layers: '', layersQuote: '', mentions: { gutters: false, chimney: false, skylight: false, decking: false }, saidQuantities: [] },
  promises: [
    { who: 'jo', text: 'Send the estimate', dueSpoken: 'by Friday', dueYmd: '2026-11-06', kind: 'estimate', quote: 'I will send you the estimate by Friday' },
    { who: 'them', text: 'Send the claim number', dueSpoken: '', dueYmd: '', kind: 'waiting', quote: 'the claim number is 4 4 7 2 9' },
  ],
  followUp: { spoken: '', ymd: '', quote: '', conf: 'implied' },
  objections: [], competitor: { named: false, quote: '' }, people: [],
  stage: { targetKey: 'claim_filed', reason: 'Claim open.', quote: 'the claim number is 4 4 7 2 9' },
  drafts: { estimate: true, proposal: true, followUp: 'none' },
};
const CTX = { transcript: TRANSCRIPT, callYmd: '2026-11-05' };

(async () => {
  console.log('\n1. The low-confidence rule');
  ok('LOW_LOGPROB is -1.0 (Whisper\'s own logprob fallback threshold)', L.LOW_LOGPROB === -1);
  ok('the index built from the segments', SEG && SEG.lp.length === 6, SEG);
  const U = typeof L.unsureQuotes === 'function' ? L.unsureQuotes(TRANSCRIPT, SEG) : null;
  ok('unsureQuotes exists', typeof U === 'function');
  if (U) {
    ok('a quote only in the low segment → unsure', U('the claim number is 4 4 7 2 9') === true);
    ok('a quote in clear segments → sure', U('My insurance is State Farm') === false && U('the roof is leaking in the kitchen') === false);
    ok('a quote spanning a low and a clear segment → sure (one clear segment is enough)', U('State Farm. The claim number is 4 4 7 2 9') === false);
    ok('spoken numbers normalise the same way as grounding', U('the claim number is four four seven two nine') === true);
    ok('a quote the index cannot place → unsure (not known to be clear)', U('nothing like this was said') === true);
  }
  // A segment boundary inside a spoken digit run or inside a word: the
  // whole-transcript grounding joins it, so placing the quote must too.
  if (typeof L.unsureQuotes === 'function') {
    const T2 = 'The claim number is four four seven two nine. Thanks for calling.';
    const cut2 = [0, T2.indexOf('seven'), T2.indexOf('Thanks')];
    const U2 = (lp) => L.unsureQuotes(T2, { off: cut2, lp });
    ok('a digit run split across two clear segments → sure', U2([-0.2, -0.3, -0.2])('the claim number is four four seven two nine') === false);
    ok('…split across one low and one clear segment → sure (one clear is enough)', U2([-1.6, -0.3, -0.2])('the claim number is 4 4 7 2 9') === false);
    ok('…split across two low segments → unsure', U2([-1.6, -1.4, -0.2])('the claim number is 4 4 7 2 9') === true);
    const T3 = 'We need a new roof on the garage. Call me back.';
    const cut3 = [0, T3.indexOf('age.'), T3.indexOf('Call')];
    ok('a boundary inside a word, clear segments → sure', L.unsureQuotes(T3, { off: cut3, lp: [-0.2, -0.2, -0.2] })('a new roof on the garage') === false);
    ok('a boundary inside a word, low segments → unsure', L.unsureQuotes(T3, { off: cut3, lp: [-1.2, -1.3, -0.2] })('a new roof on the garage') === true);
  }
  const noIdx = typeof L.unsureQuotes === 'function' ? L.unsureQuotes(TRANSCRIPT, null) : null;
  ok('no index (a call transcribed before P1) → nothing is unsure', noIdx && noIdx('the claim number is 4 4 7 2 9') === false && noIdx('anything') === false);
  const allLow = CL.buildSegIndex ? CL.buildSegIndex(SEGS.map((s) => Object.assign({}, s, { avgLogprob: -1.0 })), TRANSCRIPT) : null;
  ok('exactly -1.0 is not below the threshold', typeof L.unsureQuotes === 'function' && L.unsureQuotes(TRANSCRIPT, allLow)('My insurance is State Farm') === false);

  console.log('\n2. sanitizeBrief marks them');
  const b = L.sanitizeBrief(RAW, Object.assign({ segIndex: SEG }, CTX));
  ok('claim # from the low segment: unsure + retype (never one-tap)', b.fields.claimNumber && b.fields.claimNumber.unsure === true && b.fields.claimNumber.retype === true, b.fields.claimNumber);
  ok('carrier from a clear segment: no mark', b.fields.insCarrier && !b.fields.insCarrier.unsure && !b.fields.insCarrier.retype, b.fields.insCarrier);
  ok('the claim # is still offered (shown, to retype), not dropped', b.fields.claimNumber && b.fields.claimNumber.value === '44729');
  ok('the promise quoted from the low segment is unsure; the other is not', b.promises[1] && b.promises[1].unsure === true && !b.promises[0].unsure, b.promises);
  ok('the stage quote from the low segment is unsure', b.stage && b.stage.unsure === true, b.stage);
  ok('summary: the unsure quote is listed by index', b.summary && JSON.stringify(b.summary.unsure) === '[1]', b.summary);
  ok('flags.lowConfidence counts the unsure items', b.flags && b.flags.lowConfidence >= 4, b.flags);
  const lowWord = L.sanitizeBrief(RAW, Object.assign({ segIndex: CL.buildSegIndex ? CL.buildSegIndex(SEGS.map((s, i) => Object.assign({}, s, { avgLogprob: i === 2 ? -1.5 : s.avgLogprob })), TRANSCRIPT) : null }, CTX));
  ok('an unsure value with no digit is marked unsure but not retype', lowWord.fields.insCarrier && lowWord.fields.insCarrier.unsure === true && !lowWord.fields.insCarrier.retype, lowWord.fields.insCarrier);
  const plain = L.sanitizeBrief(RAW, CTX);
  ok('without an index: no unsure, no retype (the P0 brief, unchanged)', !plain.fields.claimNumber.unsure && !plain.fields.claimNumber.retype && !plain.promises[1].unsure && !plain.summary.unsure, plain.fields.claimNumber);
  ok('…and its shape is the P0 shape (no new keys on facts)', JSON.stringify(Object.keys(plain.fields.claimNumber)) === JSON.stringify(['value', 'quote', 'conf']));

  console.log('\n3. The callables');
  const CALL_ID = 'cube_ABCDE12345';
  const seed = (call) => ({
    ['phone_calls/' + CALL_ID]: Object.assign({ userId: 'jo', companyId: 'co1', status: 'noted', callType: 'customer', leadId: 'L1', attachedBy: 'jo', alternateLeadIds: [], transcript: TRANSCRIPT, startedAtMs: Date.parse('2026-11-05T15:00:00Z'), direction: 'inbound' }, call || {}),
    'leads/L1': { userId: 'jo', companyId: 'co1', firstName: 'Pat', insCarrier: '', claimNumber: '', jobType: '' },
    'subscriptions/co1': { plan: 'growth', status: 'active' }, 'subscriptions/jo': { plan: 'growth', status: 'active' },
    'companyProfile/co1': { companyName: 'Example Roofing Co' },
  });
  const OWNER = { uid: 'jo', token: { email_verified: true, companyId: 'co1' } };
  const model = async (req) => ({ model: req.model, usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify(RAW) }] });
  const db = makeDb(seed({ segIndex: SEG }));
  currentDb = db;
  let r = null;
  try { r = await CB._test.briefCallable({ db, auth: OWNER, data: { callId: CALL_ID }, nowMs: Date.parse('2026-11-05T18:00:00Z'), callModel: model, log: silent }); } catch (e) { ok('callBrief ran', false, e.message); }
  ok('callBrief reads the call\'s segIndex: the stored claim # is retype', r && r.brief.fields.claimNumber.retype === true, r && r.brief.fields.claimNumber);
  const dec = async (data) => { try { return { r: await CB._test.decideCallable({ db, auth: OWNER, data: Object.assign({ callId: CALL_ID }, data), nowMs: Date.parse('2026-11-05T18:05:00Z'), log: silent }) }; } catch (e) { return { e }; } };
  const one = await dec({ item: 'field:claimNumber', decision: 'accept', confirmedInsurance: true });
  ok('Accept of a retype field with no typed value → refused, nothing written', one.e && one.e.code === 'failed-precondition' && !db.store.get('leads/L1').claimNumber, one.e ? one.e.message : one.r);
  const two = await dec({ item: 'field:claimNumber', decision: 'accept', confirmedInsurance: true, value: '44729' });
  ok('a value without retyped: true → refused', two.e && two.e.code === 'failed-precondition' && !db.store.get('leads/L1').claimNumber, two.e ? two.e.message : two.r);
  const three = await dec({ item: 'field:claimNumber', decision: 'accept', confirmedInsurance: true, value: '44792', retyped: true });
  ok('the person\'s typed value (retyped: true) is what is written', three.r && three.r.written === true && db.store.get('leads/L1').claimNumber === '44792', three.e ? three.e.message : db.store.get('leads/L1'));
  const car = await dec({ item: 'field:insCarrier', decision: 'accept', confirmedInsurance: true });
  ok('a clear field still accepts in one tap', car.r && car.r.written === true && db.store.get('leads/L1').insCarrier === 'State Farm', car.e && car.e.message);
  const sk = await dec({ item: 'field:dateOfLoss', decision: 'skip' });
  ok('Skip needs no retype', sk.r && sk.r.decision === 'skip', sk.e && sk.e.message);

  console.log('\n4. The sheet');
  const src = read('docs/pro/js/call-brief-ui.js');
  const doc = { body: { contains: () => true, appendChild() {} }, createElement: () => ({ setAttribute() {}, addEventListener() {}, className: '', innerHTML: '', open: false, showModal() { this.open = true; }, querySelector: () => null }), querySelector: () => null, addEventListener() {} };
  const ctx = vm.createContext({ window: { auth: { currentUser: { uid: 'jo' } } }, document: doc, console, setTimeout, Date, Object, Number, String, Array, JSON, Math, RegExp, Promise, Event: function () {} });
  vm.runInContext(src, ctx);
  const UI = ctx.window.NBDCallBrief;
  const rows = UI._fieldRows(b, {});
  const claim = rows.filter((x) => x.key === 'claimNumber')[0];
  const carrier = rows.filter((x) => x.key === 'insCarrier')[0];
  ok('fieldRows carries retype + unsure', claim && claim.retype === true && claim.unsure === true && carrier && !carrier.retype, claim);
  UI._showWith({ brief: b, lead: {}, leadId: 'L1', page: 'customer', callId: CALL_ID });
  const html = UI._render();
  const claimCard = (html.split('data-cb-row="field:claimNumber"')[1] || '').split('data-cb-row=')[0];
  ok('the claim # card has no Accept button', claimCard && !/data-cb-act="accept"/.test(claimCard), claimCard.slice(0, 400));
  ok('…it asks to type it, with an empty input', /data-cb-input="edit" data-k="claimNumber"[^>]*value=""/.test(claimCard) && /Type it/.test(claimCard), claimCard.slice(0, 600));
  ok('…and says it was hard to hear', /hard to hear/i.test(claimCard));
  const carrierCard = (html.split('data-cb-row="field:insCarrier"')[1] || '').split('data-cb-row=')[0];
  ok('the carrier card keeps Accept / Edit / Skip', /data-cb-act="accept"/.test(carrierCard) && /data-cb-act="edit"/.test(carrierCard));
  ok('unsure quotes are marked in the sheet (class + words)', /cb-quote is-unsure/.test(html) && /Unsure/.test(html));
  ok('the retype save sends retyped: true', /retyped = true/.test(src) || /retyped: true/.test(src));
  ok('the sheet CSS styles the unsure quote', /\.cb-quote\.is-unsure/.test(read('docs/pro/css/call-brief.css')));

  // Cancel on the insurance confirm keeps the value typed into the retype box
  // (it has no prefill: losing it means listening and typing again).
  {
    const on = {};
    const dlgM = { setAttribute() {}, addEventListener(t, fn) { on[t] = fn; }, className: '', innerHTML: '', open: false, showModal() { this.open = true; }, querySelector: () => null, contains: () => true };
    const doc2 = Object.assign({}, doc, { createElement: () => dlgM });
    const ctx2 = vm.createContext({ window: { auth: { currentUser: { uid: 'jo' } } }, document: doc2, console, setTimeout, Date, Object, Number, String, Array, JSON, Math, RegExp, Promise, Event: function () {} });
    vm.runInContext(src, ctx2);
    const UI2 = ctx2.window.NBDCallBrief;
    UI2._showWith({ brief: b, lead: {}, leadId: 'L1', page: 'customer', callId: CALL_ID });
    const el = (attrs) => ({ disabled: false, value: attrs.value, getAttribute: (n) => (n in attrs ? attrs[n] : null), closest() { return this; } });
    on.input({ type: 'input', target: el({ 'data-cb-input': 'edit', 'data-k': 'claimNumber', value: '44792' }) });
    await on.click({ target: el({ 'data-cb-act': 'edit-save', 'data-k': 'claimNumber' }) });
    const confirmHtml = UI2._render();
    ok('Save on the retyped claim # asks the insurance confirm, naming the value', /Fill it in as 44792\?/.test(confirmHtml), confirmHtml.slice(0, 300));
    await on.click({ target: el({ 'data-cb-act': 'cancel' }) });
    const after = (UI2._render().split('data-cb-row="field:claimNumber"')[1] || '').split('data-cb-row=')[0];
    ok('Cancel on that confirm keeps the typed value in the retype box', /data-cb-input="edit" data-k="claimNumber"[^>]*value="44792"/.test(after), after.slice(0, 600));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failed:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
