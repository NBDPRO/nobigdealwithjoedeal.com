/**
 * job-spine-2026-10-03.test.js — the event-driven job spine.
 *
 * Real events move the job forward on their own (functions/job-spine.js +
 * job-spine-logic.js). This suite covers:
 *   A. parity — the server ports of crm-stages.js (labels, legacy names,
 *      STAGE_ACTIONS / preferredActionFor, inferJobType) match the REAL
 *      client file, and the forward rank agrees with every track's order;
 *   B. the event table — forward-only, lost / closed / deleted / custom
 *      stage untouched, each job type;
 *   C. recordJobEvent against a fake transactional Firestore — the exact
 *      lead write, note, stage-entry task, and idempotency per
 *      (leadId, event, sourceId);
 *   D. every caller adapter (remote signing, e-sign envelope, deal room,
 *      Cal.com) and the invoice trigger (money-paper.js handle) with fakes;
 *   E. wiring — each caller actually calls the spine, the two old payoff
 *      stage writes are gone, the estimate bumps go through
 *      commitStageChange.
 *
 * Break-test (E): against origin/main every wiring assertion fails (no
 * caller references the spine; stripe.js and invoice-pipeline.js still
 * write the stage; the estimate paths write stage in a plain updateDoc).
 *
 * Run: node tests/job-spine-2026-10-03.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions', 'job-spine-logic.js'));
const SPINE = require(path.join(ROOT, 'functions', 'job-spine.js'));
const stageRoles = require(path.join(ROOT, 'functions', 'stage-roles.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── the real client stage config, exports stripped, in a vm ──────────────
let cs = read('docs/pro/js/crm-stages.js');
cs = cs.replace(/export\s+function\s+/g, 'function ').replace(/export\s+const\s+/g, 'const ');
cs += '\nthis.__out = { S, STAGE_META, LEGACY_MAP, STAGE_ACTIONS, preferredActionFor, stageRole, inferJobType, stageOptionsForType, JOB_TYPES };';
const sb = { console, window: {} };
vm.runInNewContext(cs, sb, { filename: 'crm-stages.js' });
const C = sb.__out;

(async () => {
  console.log('\nA. parity with docs/pro/js/crm-stages.js');
  {
    const clientKeys = Object.keys(C.STAGE_META).sort();
    ok('every built-in stage has a server label, and no extras', JSON.stringify(Object.keys(L.STAGE_LABELS).sort()) === JSON.stringify(clientKeys));
    const badLabel = clientKeys.filter((k) => L.STAGE_LABELS[k] !== C.STAGE_META[k].label);
    ok('labels match STAGE_META', !badLabel.length, badLabel.join(','));
    ok('LEGACY_MAP matches', JSON.stringify(L.LEGACY_MAP) === JSON.stringify(Object.assign({}, C.LEGACY_MAP)));
    const norm = (o) => JSON.parse(JSON.stringify(o));
    ok('STAGE_ACTIONS match exactly (id / label / icon / kind / jobTypes)',
      JSON.stringify(norm(L.STAGE_ACTIONS)) === JSON.stringify(norm(C.STAGE_ACTIONS)));
    const types = [null, 'insurance', 'cash', 'finance', 'warranty', 'service'];
    const drift = [];
    for (const k of clientKeys) for (const jt of types) {
      const a = C.preferredActionFor(k, jt); const b = L.preferredActionFor(k, jt);
      if ((a && a.id) !== (b && b.id)) drift.push(k + '/' + jt);
    }
    ok('preferredActionFor agrees for every stage × job type', !drift.length, drift.join(','));
    const roleDrift = clientKeys.filter((k) => C.stageRole(k) !== stageRoles.roleFromKey(k));
    ok('stage-roles.js roles agree with crm-stages.js (spine reuses them)', !roleDrift.length, roleDrift.join(','));
    // Every track's pipeline order (the stage dropdown) is non-decreasing in
    // the spine's rank, so "forward" means the same thing on every board —
    // except the one documented swap: Collections ranks before Final Payment.
    for (const jt of ['insurance', 'cash', 'finance', 'warranty', 'service']) {
      const order = C.stageOptionsForType(jt).map((o) => o.value).filter((k) => k !== 'lost');
      const bad = [];
      for (let i = 1; i < order.length; i++) {
        const a = order[i - 1], b = order[i];
        if (a === 'final_payment' && b === 'collections') continue;
        if (!(L.STAGE_RANK[b] >= L.STAGE_RANK[a])) bad.push(a + '>' + b);
      }
      ok(jt + ' track order is forward in STAGE_RANK', !bad.length, bad.join(','));
    }
    ok('collections → final_payment counts as forward (the Stripe payoff precedent)', L.STAGE_RANK.final_payment > L.STAGE_RANK.collections);
    const samples = [
      { jobType: 'Insurance' }, { jobType: 'cash' }, { insCarrier: 'State Farm' }, { claimNumber: 'C1' },
      { claimStatus: 'Filed' }, { loanAmount: 9000 }, { stage: 'scope_received' }, { stage: 'prequal_sent' },
      { stage: 'negotiating' }, { stage: 'contacted' }, {},
    ];
    const jtDrift = samples.filter((l) => (C.inferJobType(l) || '') !== L.jobTypeOf(l));
    ok('jobTypeOf agrees with crm-stages.js inferJobType', !jtDrift.length, JSON.stringify(jtDrift));
    ok('a custom stage normalises to null (client would fold it into New)', L.normalizeStageKey('custom_followup') === null);
    ok('legacy names normalise', L.normalizeStageKey('New') === 'new' && L.normalizeStageKey('Closed Won') === 'closed' && L.normalizeStageKey('estimate sent') === 'estimate_submitted');
  }

  console.log('\nB. the event table');
  {
    const P = (lead, ev) => L.planJobEvent(lead, ev);
    // each job type
    ok('insurance: contract_signed → contract_signed', P({ stage: 'estimate_submitted', jobType: 'insurance' }, 'contract_signed').to === 'contract_signed');
    ok('cash: deal_accepted → contract_signed', P({ stage: 'negotiating', jobType: 'cash' }, 'deal_accepted').to === 'contract_signed');
    ok('finance: deposit_paid → contract_signed', P({ stage: 'loan_approved', jobType: 'finance' }, 'deposit_paid').to === 'contract_signed');
    ok('service (repair): contract_signed → service_approved', P({ stage: 'service_quoted', jobType: 'service' }, 'contract_signed').to === 'service_approved');
    ok('service: paid_in_full does not move (no Final Payment on the repair track)', P({ stage: 'install_complete', jobType: 'service' }, 'paid_in_full').reason === 'no_target');
    ok('warranty: contract_signed does not move', P({ stage: 'inspected', jobType: 'warranty' }, 'contract_signed').action === 'skip');
    ok('estimate_shared: insurance → estimate_submitted, cash → estimate_sent_cash, service → service_quoted',
      P({ stage: 'inspected', jobType: 'insurance' }, 'estimate_shared').to === 'estimate_submitted'
      && P({ stage: 'inspected', jobType: 'cash' }, 'estimate_shared').to === 'estimate_sent_cash'
      && P({ stage: 'inspected', jobType: 'service' }, 'estimate_shared').to === 'service_quoted');
    ok('estimate_shared on a typeless lead is ambiguous → no move', P({ stage: 'inspected' }, 'estimate_shared').reason === 'no_target');
    ok('booked: New → Contacted (every type)', ['insurance', 'cash', 'finance', 'service', 'warranty', ''].every((jt) => P({ stage: 'new', jobType: jt }, 'booked').to === 'contacted'));
    ok('paid_in_full: insurance install_complete → final_payment', P({ stage: 'install_complete', jobType: 'insurance' }, 'paid_in_full').to === 'final_payment');
    ok('paid_in_full: a New cash lead → final_payment (same as the Stripe webhook)', P({ stage: 'new', jobType: 'cash' }, 'paid_in_full').to === 'final_payment');
    ok('paid_in_full: collections → final_payment', P({ stage: 'collections', jobType: 'cash' }, 'paid_in_full').to === 'final_payment');
    ok('paid_in_full refuses a lead with an open warranty claim', P({ stage: 'final_photos', openWarrantyClaimId: 'w1' }, 'paid_in_full').reason === 'payoff_not_allowed');
    ok('scheduled: contract_signed → crew_scheduled', P({ stage: 'contract_signed', jobType: 'cash' }, 'scheduled').to === 'crew_scheduled');
    ok('installed: crew_scheduled → install_complete (a won stage)', P({ stage: 'crew_scheduled', jobType: 'insurance' }, 'installed').to === 'install_complete');
    ok('lead_created never moves', P({ stage: 'new' }, 'lead_created').action === 'skip');
    // forward-only
    ok('FORWARD ONLY: contract_signed on a job already installing → no move', P({ stage: 'install_in_progress', jobType: 'insurance' }, 'contract_signed').reason === 'not_forward');
    ok('FORWARD ONLY: booked on an Inspected lead → no move', P({ stage: 'inspected' }, 'booked').reason === 'not_forward');
    ok('FORWARD ONLY: deposit on a Final Payment job → no move', P({ stage: 'final_payment', jobType: 'cash' }, 'deposit_paid').reason === 'not_forward');
    ok('same stage → no move', P({ stage: 'contract_signed', jobType: 'cash' }, 'contract_signed').reason === 'not_forward');
    // untouched
    ok('LOST untouched', P({ stage: 'lost', jobType: 'cash' }, 'paid_in_full').reason === 'lost');
    ok('legacy "Closed Lost" untouched', P({ stage: 'Closed Lost' }, 'booked').reason === 'lost');
    ok('CLOSED untouched', P({ stage: 'closed', jobType: 'cash' }, 'paid_in_full').reason === 'closed');
    ok('legacy "Complete" (closed) untouched', P({ stage: 'Complete' }, 'paid_in_full').reason === 'closed');
    ok('post-close warranty_claim untouched', P({ stage: 'warranty_claim' }, 'paid_in_full').reason === 'post_close');
    ok('DELETED untouched', P({ stage: 'new', deleted: true }, 'booked').reason === 'deleted');
    ok('CUSTOM stage untouched', P({ stage: 'custom_followup', stageRole: 'active' }, 'contract_signed').reason === 'custom_stage');
    ok('custom stage with a won role untouched too', P({ stage: 'custom_paid', stageRole: 'won' }, 'paid_in_full').reason === 'custom_stage');
    ok('unknown event → skip', P({ stage: 'new' }, 'nope').reason === 'unknown_event');
    ok('no lead → skip', P(null, 'booked').reason === 'no_lead');
    // closedAt (PR #2118's rule)
    const fv = { serverTimestamp: () => 'TS', arrayUnion: (x) => ({ u: x }) };
    const mp = (lead, ev) => L.movePayload(lead, L.planJobEvent(lead, ev), { actor: 'a', atIso: 'T', event: ev }, fv).payload;
    ok('entering a won stage stamps closedAt', mp({ stage: 'contract_signed', jobType: 'cash' }, 'paid_in_full').closedAt === 'TS');
    ok('won → won with a close date keeps it', !('closedAt' in mp({ stage: 'install_complete', stageRole: 'won', closedAt: 'X', jobType: 'cash' }, 'paid_in_full')));
    ok('won → won WITHOUT a close date stamps one', mp({ stage: 'install_complete', jobType: 'cash' }, 'paid_in_full').closedAt === 'TS');
    ok('a non-won target has no closedAt', !('closedAt' in mp({ stage: 'new' }, 'booked')));
    ok('stageRole is stamped from stage-roles.js', mp({ stage: 'new' }, 'booked').stageRole === 'active' && mp({ stage: 'new', jobType: 'cash' }, 'paid_in_full').stageRole === 'won');
    ok('a stale persisted _stageKey is rewritten with the stage', mp({ stage: 'new', _stageKey: 'final_payment' }, 'booked')._stageKey === 'contacted');
    ok('no _stageKey field invented when absent', !('_stageKey' in mp({ stage: 'new' }, 'booked')));
    // stage-entry task rule
    ok('task: won stages now get one (final_photos → Final Invoice)', L.stageEntryTask('final_photos', 'insurance', 'D').doc.actionId === 'final_invoice');
    ok('task: final_payment → Warranty Certificate', L.stageEntryTask('final_payment', 'cash', 'D').id === 'stage-final_payment-warranty_cert');
    ok('task: closed and lost get none', L.stageEntryTask('closed', 'cash', 'D') === null && L.stageEntryTask('lost', 'cash', 'D') === null);
    ok('task doc has the stage-checklist.js shape', (() => {
      const t = L.stageEntryTask('contacted', 'insurance', '2026-10-03');
      return t.id === 'stage-contacted-sched_inspect' && t.doc.text === '📅 Schedule Inspection' && t.doc.title === 'Schedule Inspection'
        && t.doc.source === 'stage_entry' && t.doc.stageKey === 'contacted' && t.doc.actionKind === 'action'
        && t.doc.dueDate === '2026-10-03' && t.doc.done === false && t.doc.notes === 'Suggested when this lead moved to "Contacted".';
    })());
    ok('todayYmdEt is the Eastern day (11 pm ET on the 3rd is still the 3rd)', L.todayYmdEt(Date.parse('2026-10-04T03:00:00Z')) === '2026-10-03');
    // invoice → events
    ok('invoice: status → paid = paid_in_full', JSON.stringify(L.invoiceEvents({ status: 'sent' }, { leadId: 'L', status: 'paid', depositPaid: true, depositAmount: 500, amountPaid: 1000 })) === '["paid_in_full"]');
    ok('invoice: deposit flipped = deposit_paid', JSON.stringify(L.invoiceEvents({ status: 'sent', depositPaid: false }, { leadId: 'L', status: 'sent', depositPaid: true, depositAmount: 500, amountPaid: 500 })) === '["deposit_paid"]');
    ok('invoice: no-deposit invoice partial payment = nothing', L.invoiceEvents({ status: 'sent', depositPaid: false }, { leadId: 'L', status: 'sent', depositPaid: true, depositAmount: 0, amountPaid: 100 }).length === 0);
    ok('invoice: already paid before = nothing (history)', L.invoiceEvents({ status: 'paid' }, { leadId: 'L', status: 'paid' }).length === 0);
    ok('invoice: void / no lead = nothing', L.invoiceEvents(null, { status: 'paid' }).length === 0 && L.invoiceEvents(null, { leadId: 'L', status: 'void' }).length === 0);
    ok('esign: contract titles count, side documents do not',
      L.envelopeIsContract({ title: 'Roofing Contract — Smith' }) && L.envelopeIsContract({ title: 'Service Agreement' })
      && !L.envelopeIsContract({ title: 'Manufacturer warranty registration' }) && !L.envelopeIsContract({ title: 'Change Order #2 to contract' })
      && !L.envelopeIsContract({ title: 'Lien waiver' }) && !L.envelopeIsContract({ title: 'Insurance form' }));
  }

  // ── a fake transactional Firestore ─────────────────────────────────────
  function makeDb(seed) {
    const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
    const writes = [];
    const apply = (cur, patch) => {
      const d = Object.assign({}, cur);
      for (const k of Object.keys(patch)) {
        const v = patch[k];
        if (v && v.__union) d[k] = (Array.isArray(d[k]) ? d[k] : []).concat(v.__union);
        else d[k] = v;
      }
      return d;
    };
    const ref = (p) => ({
      path: p, id: p.split('/').pop(),
      collection: (c) => col(p + '/' + c),
      async get() { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))) }; },
      async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); writes.push(['update', p, patch]); store.set(p, apply(store.get(p), patch)); },
      async set(data) { writes.push(['set', p, data]); store.set(p, JSON.parse(JSON.stringify(data))); },
    });
    const col = (c) => ({ doc: (id) => ref(c + '/' + id) });
    return {
      store, writes,
      collection: col,
      doc: (p) => ref(p),
      async runTransaction(fn) {
        const pending = [];
        const tx = {
          get: (r) => r.get(),
          create: (r, d) => pending.push(() => { if (store.has(r.path)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } writes.push(['create', r.path, d]); store.set(r.path, JSON.parse(JSON.stringify(d))); }),
          set: (r, d) => pending.push(() => { writes.push(['set', r.path, d]); store.set(r.path, JSON.parse(JSON.stringify(d))); }),
          update: (r, p) => pending.push(() => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); writes.push(['update', r.path, p]); store.set(r.path, apply(store.get(r.path), p)); }),
        };
        const out = await fn(tx);
        // all-or-nothing: run creates first so a marker collision aborts every write
        const snapshot = new Map(store); const wlen = writes.length;
        try { pending.forEach((f) => f()); } catch (e) { store.clear(); snapshot.forEach((v, k) => store.set(k, v)); writes.length = wlen; throw e; }
        return out;
      },
    };
  }
  const FV = { serverTimestamp: () => '__TS__', arrayUnion: (...x) => ({ __union: x }) };
  const NOW = Date.parse('2026-10-03T15:00:00Z');
  const quiet = { info() {}, warn() {}, error() {} };
  const deps = { FieldValue: FV, logger: quiet, now: () => NOW };
  const rec = (db, a) => SPINE.recordJobEvent(db, a, deps);

  console.log('\nC. recordJobEvent');
  {
    const db = makeDb({ 'leads/L1': { stage: 'estimate_submitted', jobType: 'insurance', userId: 'u1', companyId: 'c1' } });
    const r = await rec(db, { leadId: 'L1', companyId: 'c1', event: 'contract_signed', sourceId: 'doc_d1', actor: 'remote signing', meta: { detail: 'Pat signed remotely' } });
    const lead = db.store.get('leads/L1');
    ok('moves the lead', r.moved === true && lead.stage === 'contract_signed');
    ok('stamps stageRole / stageStartedAt / updatedAt', lead.stageRole === 'active' && lead.stageStartedAt === '__TS__' && lead.updatedAt === '__TS__');
    ok('appends one stageHistory entry (from / to / timestamp / user / event)',
      Array.isArray(lead.stageHistory) && lead.stageHistory.length === 1 && lead.stageHistory[0].from === 'estimate_submitted'
      && lead.stageHistory[0].to === 'contract_signed' && lead.stageHistory[0].user === 'remote signing' && lead.stageHistory[0].event === 'contract_signed'
      && lead.stageHistory[0].timestamp === new Date(NOW).toISOString());
    ok('no closedAt on a non-won stage', !('closedAt' in lead));
    const note = db.store.get('notes/spine-' + L.markerId('L1', 'contract_signed', 'doc_d1'));
    ok('writes a timeline note on the top-level notes collection (leadId, owner userId, stage_change)',
      note && note.leadId === 'L1' && note.userId === 'u1' && note.type === 'stage_change' && /Stage moved to "Contract Signed" — automatic: contract signed \(Pat signed remotely\)/.test(note.text));
    const task = db.store.get('leads/L1/tasks/stage-contract_signed-create_job');
    ok('files the stage-entry task (Create Job), due today ET', task && task.source === 'stage_entry' && task.dueDate === '2026-10-03' && task.done === false && r.taskId === 'stage-contract_signed-create_job');
    const marker = db.store.get('job_events/' + L.markerId('L1', 'contract_signed', 'doc_d1'));
    ok('creates the marker with the result', marker && marker.event === 'contract_signed' && marker.sourceId === 'doc_d1' && marker.result.action === 'move' && marker.result.to === 'contract_signed');
    const nWrites = db.writes.length;
    const again = await rec(db, { leadId: 'L1', companyId: 'c1', event: 'contract_signed', sourceId: 'doc_d1', actor: 'remote signing' });
    ok('IDEMPOTENT: the same (lead, event, source) again writes nothing', again.duplicate === true && db.writes.length === nWrites);
    ok('…and the history still has one entry', db.store.get('leads/L1').stageHistory.length === 1);
    const other = await rec(db, { leadId: 'L1', companyId: 'c1', event: 'contract_signed', sourceId: 'doc_d2', actor: 'remote signing' });
    ok('a different source is a new event (recorded, but forward-only → no move)', other.moved === false && other.reason === 'not_forward' && db.store.has('job_events/' + L.markerId('L1', 'contract_signed', 'doc_d2')));
  }
  {
    // the task already exists (rep finished it) → never reopened
    const db = makeDb({ 'leads/L2': { stage: 'new', userId: 'u1' }, 'leads/L2/tasks/stage-contacted-sched_inspect': { done: true, text: 'x' } });
    await rec(db, { leadId: 'L2', event: 'booked', sourceId: 'b1', actor: 'Cal.com' });
    ok('an existing stage task is left exactly as it was', db.store.get('leads/L2/tasks/stage-contacted-sched_inspect').done === true && !db.writes.some((w) => w[1] === 'leads/L2/tasks/stage-contacted-sched_inspect'));
  }
  {
    const db = makeDb({ 'leads/L3': { stage: 'custom_followup', stageRole: 'active', userId: 'u1' } });
    const r = await rec(db, { leadId: 'L3', event: 'contract_signed', sourceId: 's', actor: 'x' });
    ok('custom stage: no lead write, marker recorded with the reason', r.moved === false && r.reason === 'custom_stage'
      && !db.writes.some((w) => w[1] === 'leads/L3') && db.store.get('job_events/' + L.markerId('L3', 'contract_signed', 's')).result.reason === 'custom_stage');
  }
  {
    const db = makeDb({ 'leads/L4': { stage: 'lost', userId: 'u1' } });
    const r = await rec(db, { leadId: 'L4', event: 'booked', sourceId: 'b', actor: 'x', meta: { note: 'Booked via Cal.com.' } });
    ok('lost: no lead write', r.moved === false && !db.writes.some((w) => w[1] === 'leads/L4'));
    ok('…but the caller\'s own note still lands once (type note)', (db.store.get('notes/spine-' + L.markerId('L4', 'booked', 'b')) || {}).type === 'note');
  }
  {
    const db = makeDb({ 'leads/L5': { stage: 'new', userId: 'u1', companyId: 'other' } });
    const r = await rec(db, { leadId: 'L5', companyId: 'c1', event: 'booked', sourceId: 'b', actor: 'x' });
    ok('tenant mismatch: no move', r.moved === false && r.reason === 'tenant_mismatch' && db.store.get('leads/L5').stage === 'new');
  }
  {
    const db = makeDb({ 'leads/L6': { stage: 'install_complete', stageRole: 'won', jobType: 'cash', userId: 'u1' } });
    await rec(db, { leadId: 'L6', event: 'paid_in_full', sourceId: 'inv', actor: 'x' });
    const l = db.store.get('leads/L6');
    ok('won stage without a close date: closedAt stamped on Final Payment', l.stage === 'final_payment' && l.closedAt === '__TS__');
    ok('Final Payment entry files the Warranty Certificate task', !!db.store.get('leads/L6/tasks/stage-final_payment-warranty_cert'));
  }
  {
    const bad = await SPINE.recordJobEvent({ runTransaction: async () => { throw new Error('boom'); }, collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({}) }) }) }) },
      { leadId: 'L7', event: 'booked' }, deps);
    ok('never throws — a Firestore failure comes back as { error }', bad.reason === 'error' && /boom/.test(bad.error));
    ok('a bad lead id is refused before any I/O', (await rec(makeDb(), { leadId: '../x', event: 'booked' })).reason === 'bad_lead_id');
  }

  console.log('\nD. caller adapters + the invoice trigger');
  {
    const db = makeDb({ 'leads/R1': { stage: 'supplement_approved', jobType: 'insurance', userId: 'u1' }, 'leads/R1/documents/d1': { type: 'contract' } });
    const r = await SPINE.spineAfterRemoteSign(db, { leadId: 'R1', docId: 'd1', signerName: 'Pat' }, deps);
    const lead = db.store.get('leads/R1');
    ok('remote contract: stamps contractFiledAt as an ISO string (like in-person signing)', lead.contractFiledAt === new Date(NOW).toISOString() && r.filedField === 'contractFiledAt');
    ok('remote contract: moves to Contract Signed', lead.stage === 'contract_signed' && r.spine.moved === true);
    const db2 = makeDb({ 'leads/R2': { stage: 'install_complete', userId: 'u1' }, 'leads/R2/documents/d2': { type: 'certificate_of_completion' } });
    const r2 = await SPINE.spineAfterRemoteSign(db2, { leadId: 'R2', docId: 'd2' }, deps);
    ok('remote COC: stamps cocFiledAt, no stage event', db2.store.get('leads/R2').cocFiledAt && db2.store.get('leads/R2').stage === 'install_complete' && r2.skipped === 'not_a_contract');
    const db3 = makeDb({ 'leads/R3': { stage: 'new', userId: 'u1' }, 'leads/R3/documents/d3': { type: 'inspectionHomeowner' } });
    await SPINE.spineAfterRemoteSign(db3, { leadId: 'R3', docId: 'd3' }, deps);
    ok('remote non-contract doc: nothing written to the lead', !db3.writes.some((w) => w[1] === 'leads/R3'));
  }
  {
    const db = makeDb({ 'leads/E1': { stage: 'negotiating', jobType: 'cash', userId: 'u1', companyId: 'c1' } });
    const r = await SPINE.spineAfterEsign(db, { leadId: 'E1', companyId: 'c1', title: 'Roof Replacement Contract' }, 'env1', 'Pat', deps);
    ok('e-sign contract envelope: Contract Filed + Contract Signed', db.store.get('leads/E1').contractFiledAt && db.store.get('leads/E1').stage === 'contract_signed' && r.spine.moved);
    const db2 = makeDb({ 'leads/E2': { stage: 'negotiating', jobType: 'cash', userId: 'u1' } });
    await SPINE.spineAfterEsign(db2, { leadId: 'E2', title: 'Shingle warranty registration' }, 'env2', 'Pat', deps);
    ok('e-sign side document: lead untouched', !db2.writes.some((w) => w[1] === 'leads/E2'));
  }
  {
    const db = makeDb({ 'leads/D1': { stage: 'estimate_sent_cash', jobType: 'cash', userId: 'u1' } });
    const r = await SPINE.spineAfterDealAccept(db, { dealId: 'deal1', leadId: 'D1' }, 'better', deps);
    ok('deal room accepted: Contract Signed', r.moved && db.store.get('leads/D1').stage === 'contract_signed');
    const r2 = await SPINE.spineAfterDealAccept(db, { dealId: 'deal1', leadId: 'D1' }, 'better', deps);
    ok('deal room retried: duplicate', r2.duplicate === true);
    ok('deal with no lead: skipped', (await SPINE.spineAfterDealAccept(db, { dealId: 'x', leadId: null }, 'good', deps)).skipped === 'no_lead');
    const dbs = makeDb({ 'leads/D2': { stage: 'service_quoted', jobType: 'service', userId: 'u1' } });
    await SPINE.spineAfterDealAccept(dbs, { dealId: 'deal2', leadId: 'D2' }, 'good', deps);
    ok('deal room on a repair: Service Approved', dbs.store.get('leads/D2').stage === 'service_approved');
  }
  {
    const db = makeDb({ 'leads/K1': { stage: 'New', userId: 'u1', companyId: 'u1' } });
    const r = await SPINE.spineAfterBooking(db, { leadId: 'K1', companyId: 'u1', bookingId: 'bk1', startTime: new Date('2026-10-07T14:00:00Z'), title: 'Free roof inspection' }, deps);
    const note = db.store.get('notes/spine-' + L.markerId('K1', 'booked', 'calcom_bk1'));
    ok('Cal.com booking: legacy "New" → Contacted', r.moved && db.store.get('leads/K1').stage === 'contacted');
    ok('…with a timeline note naming the appointment', note && /Cal\.com: Free roof inspection, Wed, Oct 7, 10:00 AM/.test(note.text), note && note.text);
    const db2 = makeDb({ 'leads/K2': { stage: 'contract_signed', userId: 'u1' } });
    const r2 = await SPINE.spineAfterBooking(db2, { leadId: 'K2', bookingId: 'bk2', startTime: new Date('2026-10-07T14:00:00Z'), title: 'Walkthrough' }, deps);
    ok('booking on a lead further along: no move, but the note lands', !r2.moved && /Booked via Cal\.com: Walkthrough/.test((db2.store.get('notes/spine-' + L.markerId('K2', 'booked', 'calcom_bk2')) || {}).text || ''));
  }
  {
    // money-paper.js handle — the invoice trigger. A non-owner tenant so the
    // money-paper filing (owner-only) stays out of the way.
    const MP = require(path.join(ROOT, 'functions', 'money-paper.js'))._internal;
    const mk = (lead) => makeDb({ 'leads/M1': Object.assign({ userId: 't1', companyId: 't1' }, lead) });
    const hdeps = (db) => ({ db, now: () => NOW, recordJobEvent: (d, a) => SPINE.recordJobEvent(d, a, deps) });
    const inv = (o) => Object.assign({ leadId: 'M1', companyId: 't1', userId: 't1', total: 1000, depositAmount: 500 }, o);

    let db = mk({ stage: 'contract_signed', jobType: 'cash' });
    let r = await MP.handle('INV1', inv({ status: 'paid', amountPaid: 1000, balanceDue: 0, depositPaid: true, payments: [{ amount: 1000, method: 'zelle' }] }), hdeps(db), { status: 'sent', depositPaid: false });
    ok('Zelle payoff (Mark Paid) → Final Payment, same as a card payoff', db.store.get('leads/M1').stage === 'final_payment' && r.spine && r.spine.paid_in_full.moved);
    ok('…stage history names the method', /zelle/.test(((db.store.get('leads/M1').stageHistory || [])[0] || {}).user || ''));
    ok('…and the lead is now WON, so #2118\'s "paid but not closed" task (roleFor(lead) === won → null) stays quiet',
      stageRoles.roleFor(db.store.get('leads/M1')) === 'won');

    db = mk({ stage: 'contract_signed', jobType: 'cash' });
    r = await MP.handle('INV2', inv({ status: 'paid', amountPaid: 1000, balanceDue: 0, payments: [{ amount: 1000, method: 'stripe' }] }), hdeps(db), { status: 'sent' });
    ok('card payoff (the Stripe webhook writes the invoice) → Final Payment through the same path', db.store.get('leads/M1').stage === 'final_payment' && /Stripe/.test(((db.store.get('leads/M1').stageHistory || [])[0] || {}).user || ''));

    db = mk({ stage: 'negotiating', jobType: 'cash' });
    r = await MP.handle('INV3', inv({ status: 'sent', amountPaid: 500, balanceDue: 500, depositPaid: true, payments: [{ amount: 500, method: 'check' }] }), hdeps(db), { status: 'sent', depositPaid: false });
    ok('deposit by check → Contract Signed', db.store.get('leads/M1').stage === 'contract_signed' && !!(r.spine && r.spine.deposit_paid && r.spine.deposit_paid.moved));

    db = mk({ stage: 'closed', jobType: 'cash' });
    await MP.handle('INV4', inv({ status: 'paid', amountPaid: 1000, balanceDue: 0, payments: [{ amount: 1000, method: 'cash' }] }), hdeps(db), { status: 'sent' });
    ok('payoff on a Closed job never drags it back', db.store.get('leads/M1').stage === 'closed');

    db = mk({ stage: 'contract_signed', jobType: 'cash' });
    const paidInv = inv({ status: 'paid', amountPaid: 1000, balanceDue: 0 });
    r = await MP.handle('INV5', paidInv, hdeps(db), paidInv);
    ok('a later write to an already-paid invoice does nothing (history)', db.store.get('leads/M1').stage === 'contract_signed' && !r.spine);
    r = await MP.handle('INV5', paidInv, hdeps(db));
    ok('rules-only caller (before undefined) never runs the spine', !r.spine);

    db = mk({ stage: 'contract_signed', jobType: 'cash' });
    const prev = process.env.NBD_MONEY_PAPER; process.env.NBD_MONEY_PAPER = 'off';
    r = await MP.handle('INV6', inv({ status: 'paid', amountPaid: 1000, balanceDue: 0 }), hdeps(db), { status: 'sent' });
    if (prev === undefined) delete process.env.NBD_MONEY_PAPER; else process.env.NBD_MONEY_PAPER = prev;
    ok('the money-paper kill switch does not switch the spine off', r.skipped === 'killswitch' && db.store.get('leads/M1').stage === 'final_payment');
  }

  console.log('\nE. wiring (break-test: every assertion here fails on origin/main)');
  {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
    const rs = strip(read('functions/remote-signing.js'));
    ok('remote-signing.js submitSignature calls spineAfterRemoteSign after the burn',
      /require\('\.\/job-spine'\)/.test(rs) && /tx\.update\(tokRef, \{ status: 'signed'[\s\S]*await spineAfterRemoteSign\(db, info\)/.test(rs));
    const es = strip(read('functions/esign-envelope.js'));
    ok('esign-envelope.js submitEsignEnvelope calls spineAfterEsign after completion',
      /status: 'completed'[\s\S]*await spineAfterEsign\(db, env, tok\.envelopeId, signerName\)/.test(es));
    const da = strip(read('functions/deal-acceptance.js'));
    ok('deal-acceptance.js calls spineAfterDealAccept after the acceptance commits',
      /fillLeadInstallDate\(db, info[\s\S]*await spineAfterDealAccept\(db, info, tier\)/.test(da));
    const cc = strip(read('functions/integrations/calcom.js'));
    ok('calcom.js calls spineAfterBooking on BOOKING_CREATED with the linked lead',
      /trigger === 'BOOKING_CREATED' && leadId\)[\s\S]{0,200}spineAfterBooking\(db, \{ leadId/.test(cc));
    const mp = strip(read('functions/money-paper.js'));
    ok('money-paper.js handle runs the spine first, before the kill switch',
      /async function handle\([^)]*\) \{\s*const spine = await spineOnInvoice\(/.test(mp));
    const st = strip(read('functions/stripe.js'));
    ok('stripe.js no longer writes the lead stage on a payoff (one path: the invoice trigger)',
      !/stage: 'final_payment'/.test(st) && !/lead_auto_advanced_on_payment/.test(st));
    const ip = strip(read('docs/pro/js/invoice-pipeline.js'));
    ok('invoice-pipeline.js markPaid no longer writes a stage', !/commitStageChange\(invoice\.leadId/.test(ip) && !/'contract_signed'/.test(ip));
    const pr = strip(read('docs/pro/js/customer-photo-report-generator.js'));
    ok('customer-photo-report-generator.js: no stage in the plain stamp-back, bump via commitStageChange',
      !/stampUpdate\.stage\s*=/.test(pr) && /commitStageChange\(window\._customerId, 'contacted'/.test(pr));
    const dbm = strip(read('docs/pro/js/dashboard-bootstrap.module.js'));
    ok('dashboard-bootstrap.module.js: neither estimate path writes stage in the stamp-back',
      !/stampUpdate\.stage\s*=/.test(dbm) && !/stampUpdate\.stageRole\s*=/.test(dbm));
    ok('…both route the New → Contacted bump through _estimateBumpToContacted → commitStageChange',
      (dbm.match(/await _estimateBumpToContacted\(/g) || []).length === 2 && /commitStageChange\(leadId, S\.CONTACTED/.test(dbm));
    const rules = read('firestore.rules');
    ok('firestore.rules locks job_events to the admin SDK', /match \/job_events\/\{markerId\} \{\s*allow read, write: if false;/.test(rules));
    const idx = read('functions/index.js');
    ok('job-spine is never exported from index.js (it would deploy as a function group)', !/job-spine/.test(idx));
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
