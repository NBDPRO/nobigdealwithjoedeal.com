/**
 * tests/call-to-close-stage-2026-11-09.test.js — Call to Close P1: the brief's
 * stage suggestion becomes a one-tap move through the CRM's own stage writer.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §4 (5), §7, §9 P1.
 *
 *   1. the plan (docs/pro/js/call-to-close-logic.js stagePlan): Inspected,
 *      install_complete and any appointment-setting stage NEVER apply in one
 *      tap; Lost / Archived / Cancelled confirm (Lost needs a reason); a
 *      signed contract, a job or a won stage is refused; a plain forward move
 *      is one tap
 *   2. the server mirror (functions/call-brief-logic.js stageOneTapAllowed)
 *      agrees with the client for every key
 *   3. callBriefDecide 'stage': a one-tap accept of a never-one-tap stage is
 *      refused; only the stage the call suggested; the mode is logged in
 *      decisions[] (append-only); a viewer and a rep who is not the call
 *      owner are refused
 *   4. the sheet: the existing stage writer is reused (spies on
 *      window.progressStage / window.moveCard), never stage-write.js itself;
 *      the never-one-tap list asks first or opens the normal flow; the
 *      decision is logged only after the writer moved the customer
 *   5. customer-bootstrap.module.js progressStage takes an explicit target
 *      (the button still passes none), threads a Lost reason and returns true
 *   6. boot + CSP: the logic file loads lazily, no new <script> tag
 *
 * Every model call and Firestore is a fake. Run: node tests/call-to-close-stage-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail)) : '')); }
}
function guard(name, fn) {
  try { return fn(); } catch (e) { ok(name, false, e && e.message); return null; }
}

const LOGIC_PATH = 'docs/pro/js/call-to-close-logic.js';

(async () => {
  console.log('\n1. The plan: what a stage suggestion may do');
  const C = guard('call-to-close-logic.js loads in node', () => require(path.join(ROOT, LOGIC_PATH)));
  if (C) {
    const plan = (key, role, cur) => C.stagePlan({ targetKey: key, role, label: key }, cur || 'new');
    ok('Inspected is never one tap (it orders a $3 measurement): confirm, naming the charge', plan('inspected', 'active').kind === 'confirm' && /\$3/.test(plan('inspected', 'active').why));
    ok('install_complete is never one tap, even when a tenant gives it an active role', plan('install_complete', 'active').kind === 'confirm' && plan('install_complete', 'won').kind === 'refuse');
    for (const k of ['adjuster_meeting_scheduled', 'crew_scheduled', 'warranty_scheduled', 'appointment_set', 'appt_booked', 'inspection_booked', 'site_visit']) {
      ok('an appointment-setting stage (' + k + ') opens the normal flow, never moves from the sheet', plan(k, 'active').kind === 'flow');
    }
    ok('Lost confirms and needs a reason', plan('lost', 'lost').kind === 'confirm' && plan('lost', 'lost').needsReason === true);
    ok('a custom lost-role stage confirms with a reason too', plan('not_interested', 'lost').kind === 'confirm' && plan('not_interested', 'lost').needsReason === true);
    ok('archived / cancelled confirm', plan('archived', 'active').kind === 'confirm' && plan('job_cancelled', 'active').kind === 'confirm');
    ok('contract_signed is refused (a call never signs)', plan('contract_signed', 'active').kind === 'refuse');
    ok('a job stage is refused', plan('job_created', 'job').kind === 'refuse' && plan('materials_ordered', 'job').kind === 'refuse');
    ok('a won stage is refused', plan('closed', 'won').kind === 'refuse' && plan('final_payment', 'won').kind === 'refuse');
    ok('an unknown role is refused (fail closed)', plan('contacted', '').kind === 'refuse' && plan('contacted', 'weird').kind === 'refuse');
    ok('a plain forward move is one tap', plan('contacted', 'active').kind === 'one-tap' && plan('estimate_submitted', 'active').kind === 'one-tap' && plan('claim_filed', 'active').kind === 'one-tap');
    ok('already at that stage → nothing to do', plan('contacted', 'active', 'contacted').kind === 'none');
    ok('a move BACK to an earlier stage is never one tap: it asks, saying so', plan('contacted', 'active', 'estimate_submitted').kind === 'confirm' && /back/i.test(plan('contacted', 'active', 'estimate_submitted').why));
    ok('…back to New too', plan('new', 'new', 'contacted').kind === 'confirm');
    ok('a forward move from where the customer is stays one tap', plan('estimate_submitted', 'active', 'contacted').kind === 'one-tap');
    ok('a custom stage the order does not know is not called a move back', plan('my_custom_stage', 'active', 'estimate_submitted').kind === 'one-tap');
    ok('no suggestion → nothing to do', C.stagePlan(null, 'new').kind === 'none');
    // A tenant's own pipeline order (companyProfile.pipelines.views[*].stages)
    // decides what "back" means when it lists both stages (review 2026-11-09).
    ok('tenantStageOrders reads each view\'s ordered stage list', typeof C.tenantStageOrders === 'function' &&
      JSON.stringify(C.tenantStageOrders({ views: { a: { stages: ['new', 'My Custom Stage', 7] }, b: null } })) === JSON.stringify([['new', 'my_custom_stage']]));
    if (typeof C.tenantStageOrders === 'function') {
      const ORD = C.tenantStageOrders({ views: { main: { stages: ['new', 'my_custom_stage', 'estimate_submitted', 'contacted'] } } });
      const tplan = (key, cur) => C.stagePlan({ targetKey: key, role: 'active', label: key }, cur, ORD);
      ok('a tenant that put Contacted after Estimate Submitted: that move is forward, one tap', tplan('contacted', 'estimate_submitted').kind === 'one-tap');
      ok('…and the other way is a move back, it asks', tplan('estimate_submitted', 'contacted').kind === 'confirm');
      ok('a tenant\'s custom stage earlier in its pipeline is a move back, it asks', tplan('my_custom_stage', 'estimate_submitted').kind === 'confirm');
      ok('a stage no tenant view lists falls back to the default order', tplan('new', 'claim_filed').kind === 'confirm' && tplan('claim_filed', 'new').kind === 'one-tap');
    }
  }

  console.log('\n2. The server mirror agrees');
  const L = guard('functions/call-brief-logic.js loads', () => require(path.join(ROOT, 'functions/call-brief-logic.js')));
  if (C && L) {
    ok('call-brief-logic exports stageOneTapAllowed', typeof L.stageOneTapAllowed === 'function');
    if (typeof L.stageOneTapAllowed === 'function') {
      const keys = ['new', 'contacted', 'inspected', 'claim_filed', 'adjuster_meeting_scheduled', 'adjuster_inspection_done', 'scope_received', 'estimate_submitted', 'supplement_requested',
        'estimate_sent_cash', 'negotiating', 'prequal_sent', 'loan_approved', 'contract_signed', 'job_created', 'crew_scheduled', 'install_complete', 'closed', 'warranty_scheduled',
        'service_quoted', 'lost', 'archived', 'appointment_set', 'site_visit', 'my_custom_stage'];
      const roles = ['new', 'active', 'lost', 'job', 'won', ''];
      const diff = [];
      for (const k of keys) for (const r of roles) if (C.oneTapAllowed(k, r) !== L.stageOneTapAllowed(k, r)) diff.push(k + '/' + r);
      ok('client and server answer the same for ' + keys.length * roles.length + ' key / role pairs', diff.length === 0, diff);
      const bdiff = [];
      for (const k of keys) for (const cur of keys) if (C.oneTapAllowed(k, 'active', cur) !== L.stageOneTapAllowed(k, 'active', cur)) bdiff.push(k + '<-' + cur);
      ok('…and for every target / current-stage pair (moves back)', bdiff.length === 0, bdiff.slice(0, 10));
      ok('the stage order both use is the default pipeline order', JSON.stringify(C.STAGE_ORDER) === JSON.stringify(L.DEFAULT_STAGES.map((s) => s.key)));
      const PIPE = { views: { main: { stages: ['new', 'my_custom_stage', 'estimate_submitted', 'contacted'] }, other: { stages: ['new', 'inspected', 'claim_filed'] } } };
      ok('the server reads the same tenant orders', typeof L.tenantStageOrders === 'function' && JSON.stringify(L.tenantStageOrders(PIPE)) === JSON.stringify(C.tenantStageOrders(PIPE)));
      if (typeof L.tenantStageOrders === 'function') {
        const tdiff = [];
        const ords = C.tenantStageOrders(PIPE);
        for (const k of keys) for (const cur of keys) if (C.oneTapAllowed(k, 'active', cur, ords) !== L.stageOneTapAllowed(k, 'active', cur, L.tenantStageOrders(PIPE))) tdiff.push(k + '<-' + cur);
        ok('…and answers the same with a tenant order', tdiff.length === 0, tdiff.slice(0, 10));
      }
    }
  }

  console.log('\n3. callBriefDecide records the stage move');
  {
    const INC = Symbol('inc');
    function makeDb(seed) {
      const store = new Map(Object.entries(seed || {}));
      const clone = (v) => JSON.parse(JSON.stringify(v));
      function merge(base, patch) { const out = Object.assign({}, base || {}); for (const [k, v] of Object.entries(patch || {})) out[k] = v && v[INC] !== undefined ? (Number(out[k]) || 0) + v[INC] : v; return out; }
      function doc(p) {
        return {
          id: p.split('/').pop(), path: p,
          get: async () => ({ id: p.split('/').pop(), exists: store.has(p), data: () => (store.has(p) ? clone(store.get(p)) : undefined) }),
          set: async (data, opts) => { store.set(p, opts && opts.merge ? merge(store.get(p), data) : merge({}, data)); },
          create: async (data) => { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, merge({}, data)); },
        };
      }
      return { store, doc, collection: (n) => ({ doc: (id) => doc(n + '/' + id) }), runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d, o) => r.set(d, o) }) };
    }
    class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
    const silent = { info() {}, warn() {}, error() {}, debug() {} };
    const STUBS = {
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
      'firebase-functions/v2': { logger: silent },
      'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
      'firebase-admin/firestore': { getFirestore: () => null, FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: (n) => ({ [INC]: n }) }, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
      './integrations/killswitch': { isAiDisabled: async () => false, isCallBriefDisabled: async () => false, getFlags: async () => ({}) },
    };
    const realLoad = Module._load;
    Module._load = function (request) { return Object.prototype.hasOwnProperty.call(STUBS, request) ? STUBS[request] : realLoad.apply(this, arguments); };
    const CB = guard('functions/call-brief.js loads', () => require(path.join(ROOT, 'functions/call-brief.js')));
    Module._load = realLoad;
    const CALL_ID = 'cube_ABCDE12345';
    const GEN = Date.parse('2026-11-05T18:00:00Z');
    const seed = (stage) => ({
      ['phone_calls/' + CALL_ID]: { userId: 'jo', companyId: 'co1', status: 'noted', callType: 'customer', leadId: 'L1', attachedBy: 'jo', alternateLeadIds: [], transcript: 'x' },
      'leads/L1': { userId: 'jo', companyId: 'co1', stage: 'new' },
      ['leads/L1/call_briefs/' + CALL_ID]: { callId: CALL_ID, leadId: 'L1', generatedAtMs: GEN, decisions: [], brief: { stage } },
    });
    const OWNER = { uid: 'jo', token: { email_verified: true, companyId: 'co1' } };
    const decide = async (db, auth, data) => {
      try { return { r: await CB._test.decideCallable({ db, auth, data: Object.assign({ callId: CALL_ID, item: 'stage' }, data), nowMs: GEN + 1000, log: silent }) }; }
      catch (e) { return { e }; }
    };
    if (CB) {
      const insp = { targetKey: 'inspected', label: 'Inspected', role: 'active', reason: 'They want a look.', quote: 'come look at it' };
      const db1 = makeDb(seed(insp));
      const r1 = await decide(db1, OWNER, { decision: 'accept', value: 'inspected', mode: 'one-tap' });
      ok('a one-tap accept of Inspected is refused (it is never one tap)', r1.e && r1.e.code === 'failed-precondition' && /one tap/i.test(r1.e.message), r1.e ? r1.e.message : r1.r);
      ok('…and nothing is logged', (db1.store.get('leads/L1/call_briefs/' + CALL_ID).decisions || []).length === 0);
      const r2 = await decide(db1, OWNER, { decision: 'accept', value: 'inspected', mode: 'confirmed' });
      const d2 = (db1.store.get('leads/L1/call_briefs/' + CALL_ID).decisions || []).slice(-1)[0] || {};
      ok('a confirmed accept of Inspected is logged with its mode', r2.r && d2.item === 'stage' && d2.decision === 'accept' && d2.finalValue === 'inspected' && d2.mode === 'confirmed' && d2.decidedBy === 'jo', d2);
      ok('…the decide call writes no stage itself (the CRM writer moved it)', db1.store.get('leads/L1').stage === 'new' && r2.r.written === false);
      const r3 = await decide(db1, OWNER, { decision: 'accept', value: 'contacted', mode: 'confirmed' });
      ok('only the stage the call suggested can be logged as accepted', r3.e && r3.e.code === 'invalid-argument', r3.e ? r3.e.code : r3.r);
      const r4 = await decide(db1, OWNER, { decision: 'accept', value: 'inspected', mode: 'whenever' });
      ok('an unknown mode is refused', r4.e && r4.e.code === 'invalid-argument');
      const contacted = { targetKey: 'contacted', label: 'Contacted', role: 'active', reason: 'Spoke with them.', quote: 'thanks for calling back' };
      const db2 = makeDb(seed(contacted));
      const r5 = await decide(db2, OWNER, { decision: 'accept', value: 'contacted', mode: 'one-tap', fromStage: 'new' });
      const ds = db2.store.get('leads/L1/call_briefs/' + CALL_ID).decisions || [];
      ok('a one-tap accept of a plain forward move is logged (mode one-tap, AI value, final value, brief gen)', r5.r && ds.length === 1 && ds[0].mode === 'one-tap' && ds[0].aiValue === 'contacted' && ds[0].finalValue === 'contacted' && ds[0].gen === GEN, ds);
      await decide(db2, OWNER, { decision: 'skip', value: 'opened the stage picker' });
      const ds2 = db2.store.get('leads/L1/call_briefs/' + CALL_ID).decisions || [];
      ok('append-only: the earlier decision stays, a skip is added', ds2.length === 2 && JSON.stringify(ds2[0]) === JSON.stringify(ds[0]) && ds2[1].decision === 'skip');
      await decide(db2, OWNER, { decision: 'skip', undone: true });
      const ds3 = db2.store.get('leads/L1/call_briefs/' + CALL_ID).decisions || [];
      ok('an Undo after the move is logged as a skip marked undone', ds3.length === 3 && ds3[2].decision === 'skip' && ds3[2].undone === true, ds3[2]);
      for (const s of [{ targetKey: 'crew_scheduled', label: 'Crew Scheduled', role: 'active' }, { targetKey: 'adjuster_meeting_scheduled', label: 'Adjuster Mtg', role: 'active' }]) {
        const r = await decide(makeDb(seed(s)), OWNER, { decision: 'accept', value: s.targetKey, mode: 'one-tap' });
        ok('a one-tap accept of ' + s.targetKey + ' (sets an appointment) is refused', r.e && r.e.code === 'failed-precondition');
      }
      const won = await decide(makeDb(seed({ targetKey: 'closed', label: 'Closed', role: 'won' })), OWNER, { decision: 'accept', value: 'closed', mode: 'confirmed' });
      ok('a won stage is refused even confirmed (a call never closes a job)', won.e && won.e.code === 'failed-precondition');
      const v = await decide(makeDb(seed(contacted)), { uid: 'v', token: { role: 'viewer', companyId: 'co1' } }, { decision: 'accept', value: 'contacted', mode: 'one-tap' });
      ok('a viewer is refused', v.e && v.e.code === 'permission-denied');
      const rep = await decide(makeDb(seed(contacted)), { uid: 'rep', token: { role: 'sales_rep', companyId: 'co1' } }, { decision: 'accept', value: 'contacted', mode: 'one-tap' });
      ok('a sales rep who does not own the call is refused', rep.e && rep.e.code === 'permission-denied');
      const ca = await decide(makeDb(seed(contacted)), { uid: 'ca', token: { role: 'company_admin', companyId: 'co1' } }, { decision: 'accept', value: 'contacted', mode: 'one-tap', fromStage: 'new' });
      // The log comes AFTER the writer moved the lead, so the stage it moved
      // from travels with it (fromStage); the lead itself already reads the target.
      const back = makeDb(seed(contacted));
      back.store.set('leads/L1', { userId: 'jo', companyId: 'co1', stage: 'contacted' });
      const rb = await decide(back, OWNER, { decision: 'accept', value: 'contacted', mode: 'one-tap', fromStage: 'estimate_submitted' });
      ok('a one-tap log of a move BACK (from a later stage) is refused', rb.e && rb.e.code === 'failed-precondition', rb.e ? rb.e.message : rb.r);
      const moved = await decide(back, OWNER, { decision: 'accept', value: 'contacted', mode: 'one-tap', fromStage: 'new' });
      ok('a one-tap log after the move landed (the lead already reads the target) is accepted', moved.r && moved.r.ok === true, moved.e && moved.e.message);
      const rb2 = await decide(back, OWNER, { decision: 'accept', value: 'contacted', mode: 'confirmed', fromStage: 'estimate_submitted' });
      ok('…confirmed, it is logged', rb2.r && rb2.r.ok === true);
      // fromStage comes from the client: a one-tap log without it says
      // nothing about a move back, so it is refused (review 2026-11-09).
      const nofrom = await decide(makeDb(seed(contacted)), OWNER, { decision: 'accept', value: 'contacted', mode: 'one-tap' });
      ok('a one-tap log with no fromStage is refused (a move back cannot be ruled out)', nofrom.e && nofrom.e.code === 'failed-precondition', nofrom.e ? nofrom.e.message : nofrom.r);
      // The lead's own stageHistory (written by the CRM writer) outranks the
      // client's fromStage: a forged later-looking fromStage cannot launder a move back.
      const hist = makeDb(seed(contacted));
      hist.store.set('leads/L1', { userId: 'jo', companyId: 'co1', stage: 'contacted', stageHistory: [
        { from: 'New', to: 'estimate_submitted', timestamp: '2026-11-01T10:00:00Z' },
        { from: 'estimate_submitted', to: 'contacted', timestamp: '2026-11-05T18:00:01Z' },
      ] });
      const forged = await decide(hist, OWNER, { decision: 'accept', value: 'contacted', mode: 'one-tap', fromStage: 'new' });
      ok('a one-tap log is checked against the lead\'s stageHistory, not the client\'s fromStage', forged.e && forged.e.code === 'failed-precondition', forged.e ? forged.e.message : forged.r);
      const histOk = makeDb(seed(contacted));
      histOk.store.set('leads/L1', { userId: 'jo', companyId: 'co1', stage: 'contacted', stageHistory: [{ from: 'New', to: 'contacted', timestamp: '2026-11-05T18:00:01Z' }] });
      const real = await decide(histOk, OWNER, { decision: 'accept', value: 'contacted', mode: 'one-tap', fromStage: 'estimate_submitted' });
      const rd = (histOk.store.get('leads/L1/call_briefs/' + CALL_ID).decisions || []).slice(-1)[0] || {};
      ok('…a real forward move is logged with the stage history\'s from, whatever the client said', real.r && real.r.ok === true && rd.fromStage === 'New', real.e ? real.e.message : rd);
      // The tenant's pipeline order (companyProfile) decides a move back on the server too.
      const tdb = makeDb(seed(contacted));
      tdb.store.set('leads/L1', { userId: 'jo', companyId: 'co1', stage: 'contacted', stageHistory: [{ from: 'estimate_submitted', to: 'contacted' }] });
      tdb.store.set('companyProfile/co1', { pipelines: { views: { main: { stages: ['new', 'estimate_submitted', 'contacted'] } } } });
      const tr = await decide(tdb, OWNER, { decision: 'accept', value: 'contacted', mode: 'one-tap', fromStage: 'estimate_submitted' });
      ok('a tenant pipeline that puts Contacted later makes that one tap a forward move (logged)', tr.r && tr.r.ok === true, tr.e && tr.e.message);
      const cdb = makeDb(seed({ targetKey: 'my_custom_stage', label: 'Mine', role: 'active' }));
      cdb.store.set('leads/L1', { userId: 'jo', companyId: 'co1', stage: 'my_custom_stage', stageHistory: [{ from: 'estimate_submitted', to: 'my_custom_stage' }] });
      cdb.store.set('companyProfile/co1', { pipelines: { views: { main: { stages: ['new', 'my_custom_stage', 'estimate_submitted'] } } } });
      const cr = await decide(cdb, OWNER, { decision: 'accept', value: 'my_custom_stage', mode: 'one-tap', fromStage: 'estimate_submitted' });
      ok('a one-tap log back to a tenant\'s earlier custom stage is refused', cr.e && cr.e.code === 'failed-precondition', cr.e ? cr.e.message : cr.r);
      ok('a same-company company_admin may (the callCenterAction set)', ca.r && ca.r.ok === true, ca.e && ca.e.message);
    }
  }

  console.log('\n4. The sheet reuses the CRM stage writer');
  const UI = read('docs/pro/js/call-brief-ui.js');
  ok('the sheet never imports stage-write.js or writes a stage itself', !/stage-write|commitStageChange|updateDoc\([^)]*stage/i.test(UI));
  ok('the sheet moves through window.progressStage (customer page) or window.moveCard (dashboard)', /window\.progressStage\(/.test(UI) && /window\.moveCard\(/.test(UI));
  function load(o) {
    const opts = o || {};
    const listeners = {};
    const dlgEl = {
      className: '', innerHTML: '', open: false, attrs: {},
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'open') this.open = false; },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      showModal() { this.open = true; }, close() { this.open = false; (listeners.close || []).forEach((f) => f()); },
      contains() { return true; }, querySelector() { return null; },
    };
    const body = { kids: [], appendChild(x) { this.kids.push(x); }, contains(x) { return this.kids.includes(x); } };
    const calls = [];
    const moves = [];
    let ctx;
    const win = {
      ScriptLoader: { load: async (src) => { if (/call-to-close-logic\.js/.test(src)) vm.runInContext(read(LOGIC_PATH), ctx); }, loadBundle: async () => {} },
      _functions: {}, _httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); return { data: { ok: true } }; },
      auth: { currentUser: { uid: 'jo' } },
      showToast: () => {},
    };
    if (opts.page === 'customer') {
      win._currentStage = 'new';
      win.progressStage = async (target, popts) => { moves.push({ via: 'progressStage', target, opts: popts }); if (opts.refuse) return undefined; win._currentStage = target; return true; };
    } else {
      win._leads = [{ id: 'L1', stage: 'new' }];
      // moveCard resolves true only when its own write committed. raceLost: another
      // tab landed the same target first, moveCard reloaded _leads and resolved undefined.
      win.moveCard = async (id, stage, mopts) => {
        moves.push({ via: 'moveCard', id, target: stage, opts: mopts });
        if (opts.raceLost) { win._leads[0].stage = stage; return undefined; }
        if (opts.refuse) return undefined;
        win._leads[0].stage = stage; return true;
      };
    }
    ctx = vm.createContext({ window: win, document: { createElement: () => dlgEl, body, querySelector: () => null }, console, setTimeout, Date, Event: function () {} });
    vm.runInContext(read('docs/pro/js/call-brief-ui.js'), ctx);
    vm.runInContext(read(LOGIC_PATH), ctx);
    const click = async (attrs) => {
      const b = { disabled: false, getAttribute: (k) => (k in attrs ? attrs[k] : null), closest: () => b };
      for (const fn of listeners.click || []) fn({ target: b });
      await new Promise((r) => setTimeout(r, 10));
    };
    const input = (attrs, value) => {
      const t = { value, getAttribute: (k) => (k in attrs ? attrs[k] : null) };
      for (const fn of listeners.input || []) fn({ target: t, type: 'input' });
    };
    return { CB: win.NBDCallBrief, dlg: dlgEl, calls, moves, click, input, win };
  }
  const BRIEF = (stage) => ({
    v: 1, transcriptOk: { reliable: true, cutOff: false, why: '' }, summary: { text: 'Call.', quotes: [], inferred: true },
    fields: {}, scope: { mentions: {} }, promises: [], followUp: null, stage, drafts: {}, flags: {}, people: [], objections: [], competitor: null,
  });
  const CONTACTED = { targetKey: 'contacted', label: 'Contacted', role: 'active', reason: 'They called back.', quote: 'thanks for calling me back' };
  const INSPECTED = { targetKey: 'inspected', label: 'Inspected', role: 'active', reason: 'They want it looked at.', quote: 'can you come look at it' };
  const MEETING = { targetKey: 'adjuster_meeting_scheduled', label: 'Adjuster Mtg', role: 'active', reason: 'The adjuster is coming.', quote: 'the adjuster comes Thursday' };
  const LOST = { targetKey: 'lost', label: 'Lost', role: 'lost', reason: 'They went with someone else.', quote: 'we went with another company' };
  const show = (h, stage, page) => h.CB._showWith({ callId: 'cube_ABCDE12345', brief: BRIEF(stage), call: { attachedBy: 'jo', leadId: 'L1' }, lead: { firstName: 'Pat', stage: 'new' }, leadId: 'L1', page });

  if (UI.indexOf('NBDCallToClose') !== -1) {
    {
      const h = load({ page: 'customer' });
      show(h, CONTACTED, 'customer');
      await new Promise((r) => setTimeout(r, 10));
      const html = h.CB._render();
      ok('a plain forward move shows one "Move to Contacted" button', /data-cb-act="stage-move"[^>]*>Move to Contacted</.test(html), html.split('cbStageH')[1]);
      ok('nothing moves on render', h.moves.length === 0 && !h.calls.some((c) => c.name === 'callBriefDecide'));
      await h.click({ 'data-cb-act': 'stage-move' });
      ok('one tap → the page\'s own writer window.progressStage(target)', h.moves.length === 1 && h.moves[0].via === 'progressStage' && h.moves[0].target === 'contacted', h.moves);
      const d = h.calls.find((c) => c.name === 'callBriefDecide' && c.data.item === 'stage');
      const popts = h.moves[0] && h.moves[0].opts;
      ok('the move hands the writer an onUndone hook (its toast\'s Undo)', popts && typeof popts.onUndone === 'function');
      if (popts && typeof popts.onUndone === 'function') {
        popts.onUndone();
        await new Promise((r) => setTimeout(r, 10));
        const u = h.calls.find((c) => c.name === 'callBriefDecide' && c.data.item === 'stage' && c.data.decision === 'skip');
        ok('…Undo logs a skip marked undone, so decisions[] does not keep a bare accept', u && u.data.undone === true && u.data.callId === 'cube_ABCDE12345', u);
      }
      ok('…then the decision is logged: accept, the key, mode one-tap, the stage it moved from', d && d.data.decision === 'accept' && d.data.value === 'contacted' && d.data.mode === 'one-tap' && d.data.callId === 'cube_ABCDE12345' && d.data.fromStage === 'new', d);
    }
    {
      const h = load({ page: 'customer', refuse: true });
      show(h, CONTACTED, 'customer');
      await new Promise((r) => setTimeout(r, 10));
      await h.click({ 'data-cb-act': 'stage-move' });
      ok('when the writer did not move it (a gate, a cancel), nothing is logged as accepted', h.moves.length === 1 && !h.calls.some((c) => c.name === 'callBriefDecide' && c.data.decision === 'accept'));
    }
    {
      const h = load({ page: 'calls' });
      show(h, CONTACTED, 'calls');
      await new Promise((r) => setTimeout(r, 10));
      await h.click({ 'data-cb-act': 'stage-move' });
      ok('on #/calls the one tap goes through window.moveCard(leadId, target)', h.moves.length === 1 && h.moves[0].via === 'moveCard' && h.moves[0].id === 'L1' && h.moves[0].target === 'contacted', h.moves);
      ok('…and is logged once it landed', h.calls.some((c) => c.name === 'callBriefDecide' && c.data.item === 'stage' && c.data.mode === 'one-tap'));
    }
    {
      const h = load({ page: 'calls', raceLost: true });
      show(h, CONTACTED, 'calls');
      await new Promise((r) => setTimeout(r, 10));
      await h.click({ 'data-cb-act': 'stage-move' });
      ok('on #/calls only moveCard\'s own true counts: a lost race that reloaded the board at the target logs nothing', h.moves.length === 1 && !h.calls.some((c) => c.name === 'callBriefDecide' && c.data.decision === 'accept'));
    }
    {
      const h = load({ page: 'calls' });
      h.win._leads[0].stage = 'estimate_submitted';
      show(h, CONTACTED, 'calls');
      await new Promise((r) => setTimeout(r, 10));
      ok('on #/calls the board\'s own copy of the lead says where it is (a move back asks)', !/data-cb-act="stage-move"/.test(h.CB._render()) && /data-cb-act="stage-ask"/.test(h.CB._render()));
    }
    {
      const h = load({ page: 'calls' });
      h.win._leads[0].stage = 'estimate_submitted';
      h.win._companyProfile = { pipelines: { views: { main: { stages: ['new', 'my_custom_stage', 'estimate_submitted'] } } } };
      show(h, { targetKey: 'my_custom_stage', label: 'Mine', role: 'active', reason: 'x', quote: 'y' }, 'calls');
      await new Promise((r) => setTimeout(r, 10));
      ok('the sheet reads the tenant\'s pipeline order: back to its earlier custom stage asks', !/data-cb-act="stage-move"/.test(h.CB._render()) && /data-cb-act="stage-ask"/.test(h.CB._render()));
    }
    {
      const h = load({ page: 'customer' });
      show(h, INSPECTED, 'customer');
      await new Promise((r) => setTimeout(r, 10));
      let html = h.CB._render();
      ok('Inspected offers no one-tap move', !/data-cb-act="stage-move"/.test(html) && /data-cb-act="stage-ask"/.test(html));
      await h.click({ 'data-cb-act': 'stage-move' });
      ok('a forged one-tap on Inspected moves nothing', h.moves.length === 0);
      await h.click({ 'data-cb-act': 'stage-ask' });
      html = h.dlg.innerHTML;
      ok('the first tap asks, naming the $3 measurement; nothing moved yet', /\$3/.test(html) && /data-cb-act="stage-yes"/.test(html) && h.moves.length === 0);
      await h.click({ 'data-cb-act': 'stage-yes' });
      ok('…the second tap moves it through progressStage, told the person already confirmed', h.moves.length === 1 && h.moves[0].target === 'inspected' && h.moves[0].opts && h.moves[0].opts.asked === true, h.moves);
      ok('…logged as confirmed', h.calls.some((c) => c.name === 'callBriefDecide' && c.data.item === 'stage' && c.data.mode === 'confirmed'));
    }
    {
      const h = load({ page: 'customer' });
      show(h, { targetKey: 'install_complete', label: 'Install Done', role: 'active', reason: 'Done.', quote: 'all done' }, 'customer');
      await new Promise((r) => setTimeout(r, 10));
      ok('install_complete offers no one-tap move', !/data-cb-act="stage-move"/.test(h.CB._render()));
    }
    {
      const h = load({ page: 'customer' });
      show(h, MEETING, 'customer');
      await new Promise((r) => setTimeout(r, 10));
      const html = h.CB._render();
      ok('an appointment-setting stage offers no move and no confirm: only the normal place to change it', !/data-cb-act="stage-(move|ask|yes)"/.test(html) && /data-cb-act="stage"/.test(html));
      await h.click({ 'data-cb-act': 'stage-move' });
      await h.click({ 'data-cb-act': 'stage-yes' });
      ok('…and forged taps move nothing', h.moves.length === 0);
    }
    {
      const h = load({ page: 'customer' });
      show(h, LOST, 'customer');
      await new Promise((r) => setTimeout(r, 10));
      await h.click({ 'data-cb-act': 'stage-ask' });
      const html = h.dlg.innerHTML;
      const box = (html.match(/<input[^>]*data-cb-input="lostReason"[^>]*>/) || [''])[0];
      ok('Lost asks first, with an EMPTY reason box (the customer\'s words are never the default loss reason)', !!box && /value=""/.test(box) && !/we went with another company/.test(box) && h.moves.length === 0, box);
      ok('…what was said shows beside it as a hint', /we went with another company/.test(html));
      await h.click({ 'data-cb-act': 'stage-yes' });
      ok('Yes on the untouched box moves nothing', h.moves.length === 0);
      h.input({ 'data-cb-input': 'lostReason' }, '   ');
      await h.click({ 'data-cb-act': 'stage-yes' });
      ok('an empty reason moves nothing', h.moves.length === 0);
      h.input({ 'data-cb-input': 'lostReason' }, 'Went with another roofer');
      await h.click({ 'data-cb-act': 'stage-yes' });
      ok('with a reason → progressStage(lost, { lostReason })', h.moves.length === 1 && h.moves[0].target === 'lost' && h.moves[0].opts.lostReason === 'Went with another roofer', h.moves);
    }
    {
      const h = load({ page: 'customer' });
      show(h, { targetKey: 'job_created', label: 'Job Created', role: 'job', reason: 'x', quote: 'y' }, 'customer');
      await new Promise((r) => setTimeout(r, 10));
      await h.click({ 'data-cb-act': 'stage-move' });
      await h.click({ 'data-cb-act': 'stage-yes' });
      ok('a job stage (a stored brief from before the lock) never moves', h.moves.length === 0 && !/data-cb-act="stage-(move|ask)"/.test(h.CB._render()));
    }
    {
      const h = load({ page: 'customer' });
      h.win._currentStage = 'contacted';
      show(h, CONTACTED, 'customer');
      await new Promise((r) => setTimeout(r, 10));
      ok('already there → no move button', !/data-cb-act="stage-move"/.test(h.CB._render()));
    }
  } else {
    ok('call-brief-ui.js uses NBDCallToClose for the stage card', false);
  }

  console.log('\n5. progressStage takes an explicit target');
  {
    const src = read('docs/pro/js/customer-bootstrap.module.js');
    const fn = (src.split('window.progressStage = async function')[1] || '').split('\n};')[0];
    ok('progressStage(target, opts): a string target replaces the next-stage pick', /^\s*\(target, opts\)/.test(fn) && /typeof target === 'string'/.test(fn) && /_nextStageFor\(/.test(fn));
    ok('a Lost move threads the reason to commitStageChange (isLostMove + lostReason)', /isLostMove/.test(fn) && /lostReason/.test(fn));
    ok('a sheet that already asked skips the page\'s second confirm, unless the cancellation-window warning applies', /\.asked\b/.test(fn) && /cxlWarn/.test(fn));
    ok('it resolves true once the stage moved', /return true;/.test(fn));
    ok('its toast\'s Undo calls the caller\'s onUndone once the move back committed', /_undoStageMove\([^)]*o\.onUndone\)/.test(fn) &&
      /onUndone\(\)/.test((src.split('async function _undoStageMove')[1] || '').split('\n}\n')[0].split('catch (e)')[0]));
    ok('the stage button still calls it with no arguments', /data-action="progressStage"(?![^>]*data-arg)/.test(read('docs/pro/customer.html')));
  }

  console.log('\n5b. moveCard keeps the sheet\'s Lost reason for a custom lost-role stage');
  {
    const src = read('docs/pro/js/crm-pipeline.js');
    const mc = (src.split('async function moveCard(id, newStage, opts){')[1] || '').split('\n}\n')[0];
    const def = (mc.match(/const isLostMove = [^;]+;/) || [''])[0];
    ok('a move to a lost-role key with a reason given is a lost move (the reason is written)', /stageRole\(/.test(def) && /'lost'/.test(def) && /_givenLostReason/.test(def), def);
    ok('…the reason is read before isLostMove is decided', mc.indexOf('const _givenLostReason') !== -1 && mc.indexOf('const _givenLostReason') < mc.indexOf('const isLostMove'));
    ok('…a plain drag to a custom lost-role key (no reason given) keeps today\'s behaviour', /\/\^lost\$\/i\.test/.test(def));
    ok('dashboard.html busts the crm-pipeline.js cache', !/crm-pipeline\.js\?v=22"/.test(read('docs/pro/dashboard.html')));
  }

  console.log('\n6. Boot + CSP');
  {
    ok(LOGIC_PATH + ' exists', exists(LOGIC_PATH));
    for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
      ok(page + ' has no <script> tag for call-to-close-logic.js (it loads on tap)', !/call-to-close-logic\.js/.test(read(page)));
    }
    ok('the sheet loads it through ScriptLoader', /ScriptLoader\.load\([^)]*\)|CTC_JS/.test(UI) && /call-to-close-logic\.js/.test(UI));
    const all = exists(LOGIC_PATH) ? read(LOGIC_PATH) : '';
    ok('no inline handler or style in the new code', !/\son[a-z]+=|style=/.test(all) && !/\son[a-z]+="/.test(UI.split('renderStage')[1] || ''));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
