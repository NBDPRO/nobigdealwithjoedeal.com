#!/usr/bin/env node
/**
 * Thursday's own off switch (roadmap step 10, 2026-11-25; audit
 * documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md §3.3 med):
 * thursday_config/{companyId}.enabled was read but never enforced.
 *
 * Off = thursday_config thursdayDisabled:true, or
 * feature_flags/global.thursdayDisabled. thursday_config enabled:false is only
 * the CRM inbox WIDGET switch (docs/pro/js/widgets.js), so hiding the widget
 * must never hold a call. Then:
 *   - the webhook still answers Bland 200 and stores the call, as status
 *     'held' (never 'pending', so the processor never picks it up);
 *   - a call that reaches the processor anyway (a reprocess, a backfill doc)
 *     is parked as 'held' before any Bland fetch, extraction, lead match,
 *     route or alert;
 *   - controls: with the switch on, the same call is queued 'pending' and the
 *     processor runs the extraction.
 *
 * Real handlers over an in-memory Firestore (Module._load stubs).
 * Run: node tests/thursday-kill-switch-2026-11-25.test.js
 */
'use strict';
const path = require('path');
const Module = require('module');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); failed++; }
}

const docs = new Map();
const reads = [];      // every doc path read, in order
const GATES = {};      // path -> promise a doc read waits on (a slow Firestore read)
const events = [];     // 'leads-query' when the lookup's lead queries run
function mk(p) {
  return {
    id: p.split('/').pop(), path: p,
    get: async () => { reads.push(p); if (GATES[p]) await GATES[p]; return { id: p.split('/').pop(), exists: docs.has(p), data: () => docs.get(p) }; },
    create: async (v) => { if (docs.has(p)) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; } docs.set(p, Object.assign({}, v)); },
    set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : Object.assign({}, v)); },
    update: async (v) => { if (!docs.has(p)) throw new Error('NOT_FOUND'); docs.set(p, Object.assign({}, docs.get(p), v)); },
  };
}
// The caller lookup's lead queries answer with LOOKUP_LEADS; every other query is empty.
let LOOKUP_LEADS = [];
function query(name) {
  const rows = () => (name === 'leads' ? LOOKUP_LEADS : []).map((l) => ({ id: l.id, data: () => l }));
  const q = { where: () => q, select: () => q, limit: () => q, orderBy: () => q, get: async () => { if (name === 'leads') events.push('leads-query'); const d = rows(); return { docs: d, size: d.length, empty: !d.length, forEach: (fn) => d.forEach(fn) }; } };
  return q;
}
const DB = { doc: mk, collection: (name) => Object.assign(query(name), { doc: (id) => mk('x/' + id) }), runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, v) => r.update(v), set: (r, v) => r.set(v) }) };
const FieldValue = { serverTimestamp: () => ({ ts: true }), delete: () => ({ del: true }), increment: (n) => ({ inc: n }) };
let FLAGS = {};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue };
  if (request === 'firebase-admin/storage') return { getStorage: () => ({ bucket: () => ({ file: () => ({ save: async () => {} }) }) }) };
  if (request === './killswitch') return { getFlags: async () => FLAGS };
  if (request === './upstash-ratelimit') return { enforceRateLimit: async () => ({ count: 1 }), clientIp: () => '203.0.113.9' };
  return origLoad.apply(this, arguments);
};

// Every outside call (Bland hydrate / recording, Anthropic) goes through fetch.
const fetched = [];
global.fetch = async (url) => { fetched.push(String(url)); return { ok: false, status: 500, json: async () => ({ error: { message: 'stub' } }), headers: { get: () => 'application/json' } }; };

process.env.BLAND_WEBHOOK_SECRET = 'whsec_' + 'test_thursday_switch';
process.env.ANTHROPIC_API_KEY = 'sk-' + 'ant-test-thursday-switch';
process.env.THURSDAY_LOOKUP_TOKEN = 'tlt_' + 'test_thursday_switch';
const T = require(path.join(ROOT, 'functions/integrations/thursday-logic.js'));
const THU = require(path.join(ROOT, 'functions/integrations/thursday.js'));

const NBD = T.NBD_OWNER_UID;
const CFG = 'thursday_config/' + NBD;
function payload(callId) {
  return {
    call_id: callId, to: T.THURSDAY_NUMBER, from: '+15135550123', inbound: true, call_length: 2.5,
    concatenated_transcript: 'user: Hi, my roof is leaking over the kitchen. assistant: I can help with that.',
    transcripts: [{ user: 'user', text: 'Hi, my roof is leaking over the kitchen after the storm last night, can someone come look' }],
    summary: 'Caller reports a roof leak.',
  };
}
async function webhook(body) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const sig = crypto.createHmac('sha256', process.env.BLAND_WEBHOOK_SECRET).update(raw).digest('hex');
  const req = { method: 'POST', rawBody: raw, body, headers: { 'x-webhook-signature': sig }, get(h) { return this.headers[String(h).toLowerCase()]; }, header(h) { return this.get(h); } };
  const res = { code: 200, body: null, set() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
  await THU.thursdayWebhook(req, res);
  return res;
}
const callDoc = (id) => docs.get('thursday_calls/' + T.callDocId(id));

(async () => {
  console.log('A. the rule');
  const H = T.thursdayHoldReason;
  ok('off: thursdayDisabled:true or the global flag; on: anything else',
    typeof H === 'function' && !!H({ enabled: true, thursdayDisabled: true }, {}) && !!H({ thursdayDisabled: true }, {}) && !!H({ enabled: true }, { thursdayDisabled: true })
    && H({ enabled: true }, {}) === null && H({}, {}) === null && H({ enabled: true }, { thursdayExtractDisabled: true }) === null);
  ok('enabled:false alone (the CRM widget switch) is NOT a hold', typeof H === 'function' && H({ enabled: false }, {}) === null && H({ enabled: false, thursdayDisabled: false }, {}) === null);

  console.log('B. the webhook');
  docs.set(CFG, { enabled: false });
  let r = await webhook(payload('call-widget-off'));
  ok('widget hidden (enabled:false only): the call is still queued pending, never held', r.code === 200 && callDoc('call-widget-off') && callDoc('call-widget-off').status === 'pending', JSON.stringify(callDoc('call-widget-off') && callDoc('call-widget-off').status));
  docs.set(CFG, { thursdayDisabled: true });
  r = await webhook(payload('call-held-1'));
  let d = callDoc('call-held-1');
  ok('switched off: Bland still gets 200', r.code === 200, r.code + ' ' + JSON.stringify(r.body));
  ok('…and the call is stored as held, never pending (the processor never claims it)', !!d && d.status === 'held' && !!d.heldReason && d.callId === 'call-held-1', JSON.stringify(d && { status: d.status, heldReason: d.heldReason }));
  docs.set(CFG, { enabled: true, thursdayDisabled: true });
  r = await webhook(payload('call-held-2'));
  ok('thursdayDisabled:true holds it the same way', r.code === 200 && callDoc('call-held-2') && callDoc('call-held-2').status === 'held');
  docs.set(CFG, { enabled: true });
  FLAGS = { thursdayDisabled: true };
  r = await webhook(payload('call-held-3'));
  ok('feature_flags/global.thursdayDisabled holds it too', r.code === 200 && callDoc('call-held-3') && callDoc('call-held-3').status === 'held');
  FLAGS = {};
  r = await webhook(payload('call-live-1'));
  ok('control: switched on, the same call is queued pending', r.code === 200 && callDoc('call-live-1') && callDoc('call-live-1').status === 'pending', JSON.stringify(callDoc('call-live-1') && callDoc('call-live-1').status));
  r = await webhook(payload('call-held-1'));
  ok('a redelivery of a held call is still a 200 duplicate, the doc unchanged', r.code === 200 && r.body && r.body.duplicate === true && callDoc('call-held-1').status === 'held');

  console.log('C. the processor');
  const proc = THU._test && THU._test.processCall;
  ok('processCall is reachable through the test seam', typeof proc === 'function');
  const run = async (id) => {
    const p = 'thursday_calls/' + T.callDocId(id);
    docs.set(p, Object.assign({}, T.buildPendingCallDoc(T.normalizeCall(payload(id)), 'webhook'), { status: 'processing', notify: 'suppress' }));
    fetched.length = 0;
    if (proc) await proc(mk(p), Object.assign({}, docs.get(p), { status: 'reprocess' }));
    return docs.get(p);
  };
  docs.set(CFG, { thursdayDisabled: true });
  d = await run('call-proc-held');
  ok('switched off: a reprocessed call is parked as held', d.status === 'held' && !!d.heldReason, d.status);
  ok('…with no Bland fetch, no extraction, no match, no route, no alert', fetched.length === 0 && d.extraction === undefined && d.route === undefined && d.notifyState === undefined, fetched);
  docs.set(CFG, { enabled: true });
  d = await run('call-proc-live');
  ok('control: switched on, the processor runs the extraction (Anthropic is called) and records the result',
    fetched.some((u) => /api\.anthropic\.com/.test(u)) && (d.status === 'failed' || d.status === 'processed') && d.route !== undefined, JSON.stringify({ fetched, status: d.status }));

  console.log('D. the live caller lookup');
  const lookup = async () => {
    const req = { method: 'POST', body: { from: '+15135550123' }, headers: { authorization: 'Bearer ' + process.env.THURSDAY_LOOKUP_TOKEN }, get(h) { return this.headers[String(h).toLowerCase()]; }, header(h) { return this.get(h); } };
    const res = { code: 200, body: null, set() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
    await THU.thursdayCallerLookup(req, res);
    return res;
  };
  LOOKUP_LEADS = [{ id: 'lk1', companyId: NBD, firstName: 'Dana', lastName: 'Lee', phone: '5135550123', phoneDigits: '5135550123', stage: 'contacted', address: '9 Elm St' }];
  docs.set(CFG, { enabled: true });
  FLAGS = {};
  let lk = await lookup();
  ok('control: switched on, the lookup knows the caller', lk.code === 200 && lk.body && lk.body.known === true, JSON.stringify(lk.body));
  docs.set(CFG, { enabled: false });
  lk = await lookup();
  ok('widget hidden (enabled:false only): the lookup still knows the caller', lk.code === 200 && lk.body && lk.body.known === true, JSON.stringify(lk.body));
  docs.set(CFG, { thursdayDisabled: true });
  lk = await lookup();
  ok('switched off (thursday_config): the lookup gives the plain unknown reply, no CRM context', lk.code === 200 && lk.body && lk.body.known === false && !lk.body.first_name && !lk.body.job_hint, JSON.stringify(lk.body));
  docs.set(CFG, { enabled: true });
  FLAGS = { thursdayDisabled: true };
  lk = await lookup();
  ok('switched off (feature_flags/global.thursdayDisabled): the same', lk.code === 200 && lk.body && lk.body.known === false && !lk.body.first_name, JSON.stringify(lk.body));
  FLAGS = {};

  console.log('E. the lookup never waits on the switch read (the Bland snippet aborts at 2.5 s)');
  docs.set(CFG, { enabled: true });
  let release;
  GATES[CFG] = new Promise((r2) => { release = r2; });
  reads.length = 0; events.length = 0;
  const pending = lookup();
  for (let i = 0; i < 20; i++) await new Promise((r2) => setImmediate(r2));
  ok('the lead queries start while the thursday_config read is still in flight', events.indexOf('leads-query') !== -1 && reads.indexOf(CFG) !== -1, JSON.stringify({ events, reads }));
  release();
  delete GATES[CFG];
  lk = await pending;
  ok('…and the answer still waits for it (known caller, switch on)', lk.code === 200 && lk.body && lk.body.known === true, JSON.stringify(lk.body));
  docs.set(CFG, { thursdayDisabled: true });
  GATES[CFG] = new Promise((r2) => { release = r2; });
  const pending2 = lookup();
  for (let i = 0; i < 20; i++) await new Promise((r2) => setImmediate(r2));
  release();
  delete GATES[CFG];
  lk = await pending2;
  ok('switched off with a slow switch read: still the plain unknown reply, no CRM context', lk.code === 200 && lk.body && lk.body.known === false && !lk.body.first_name && !lk.body.job_hint, JSON.stringify(lk.body));
  docs.set(CFG, { enabled: true });
  LOOKUP_LEADS = [];

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
