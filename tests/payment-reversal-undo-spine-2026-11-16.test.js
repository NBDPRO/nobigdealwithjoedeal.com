/**
 * payment-reversal-undo-spine-2026-11-16.test.js — a reversed payment walks
 * the job spine back (owner report, 2026-11-16).
 *
 * The bug: reversePayment (functions/payment-reversal.js) appends a NEGATIVE
 * entry to invoices/{id}.payments[] and takes the invoice off 'paid', but the
 * customer stayed on "Final Payment" and the job card kept "Done · paid in
 * full". Paying moved them forward through the invoice trigger
 * (money-paper.js handle → job spine); nothing walked it back, and the
 * create-once job_events marker meant even a real re-payment never moved the
 * card again.
 *
 * Covers:
 *   A. job-spine-logic.js reversedInvoiceEvents — which spine events a
 *      reversal write undoes (and that ordinary writes undo nothing);
 *   B. job-spine-logic.js planJobEventUndo / undoPayload / undoNoteText;
 *   C. job-spine.js undoJobEvent against a fake transactional Firestore —
 *      moves back only when the lead still sits where the spine put it,
 *      always deletes the marker, no marker = no-op, tenant mismatch = no move;
 *   D. money-paper.js handle — a reversal write calls the undo and clears
 *      the job's paidInFull; a normal payment write never calls the undo;
 *      after the undo a re-payment moves the card forward again.
 *
 * Run: node tests/payment-reversal-undo-spine-2026-11-16.test.js
 *      (needs functions/node_modules)
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions', 'job-spine-logic.js'));
const SPINE = require(path.join(ROOT, 'functions', 'job-spine.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const DEL = '__DELETE__';
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, clone(v)]));
  const writes = [];
  const apply = (doc, patch) => {
    const d = Object.assign({}, doc);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v === DEL) delete d[k];
      else if (v && v.__union) d[k] = (Array.isArray(d[k]) ? d[k] : []).concat(v.__union);
      else d[k] = v;
    }
    return d;
  };
  const exists = () => { const e = new Error('ALREADY_EXISTS'); e.code = 6; return e; };
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); writes.push(['update', p, patch]); store.set(p, apply(store.get(p), patch)); },
    async set(data) { writes.push(['set', p, data]); store.set(p, clone(data)); },
    async create(data) { if (store.has(p)) throw exists(); writes.push(['create', p, data]); store.set(p, clone(data)); },
    async delete() { writes.push(['delete', p]); store.delete(p); },
  });
  const col = (c) => ({
    doc: (id) => ref(c + '/' + id),
    where: (field, op, val) => ({
      limit() { return this; },
      async get() {
        const docs = [];
        for (const [k, v] of store) {
          const rest = k.slice(c.length + 1);
          if (k.startsWith(c + '/') && rest.indexOf('/') === -1 && v && v[field] === val) docs.push({ id: rest, data: () => clone(v) });
        }
        return { docs, empty: !docs.length, size: docs.length };
      },
    }),
  });
  return {
    store, writes,
    collection: col,
    doc: (p) => ref(p),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(),
        create: (r, d) => pending.push(() => { if (store.has(r.path)) throw exists(); writes.push(['create', r.path, d]); store.set(r.path, clone(d)); }),
        set: (r, d) => pending.push(() => { writes.push(['set', r.path, d]); store.set(r.path, clone(d)); }),
        update: (r, p) => pending.push(() => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); writes.push(['update', r.path, p]); store.set(r.path, apply(store.get(r.path), p)); }),
        delete: (r) => pending.push(() => { writes.push(['delete', r.path]); store.delete(r.path); }),
      };
      const out = await fn(tx);
      const snapshot = new Map(store); const wlen = writes.length;
      try { pending.forEach((f) => f()); } catch (e) { store.clear(); snapshot.forEach((v, k) => store.set(k, v)); writes.length = wlen; throw e; }
      return out;
    },
  };
}

const FV = { serverTimestamp: () => '__TS__', arrayUnion: (...x) => ({ __union: x }), delete: () => DEL };
const NOW = Date.parse('2026-11-16T15:00:00Z');
const quiet = { info() {}, warn() {}, error() {} };
const spineDeps = { FieldValue: FV, logger: quiet, now: () => NOW, depositDraft: false, finalDraft: false, reviewTask: false, docDrafts: false, signedPrice: false };

const undoFn = typeof SPINE.undoJobEvent === 'function' ? SPINE.undoJobEvent : null;
const reversed = typeof L.reversedInvoiceEvents === 'function' ? L.reversedInvoiceEvents : () => null;

(async () => {
  console.log('\nA. reversedInvoiceEvents (pure)');
  {
    const base = { leadId: 'L1', companyId: 't1', total: 1000, depositAmount: 500 };
    const paid = Object.assign({}, base, { status: 'paid', amountPaid: 1000, balanceDue: 0, depositPaid: true, payments: [{ amount: 500, method: 'check' }, { amount: 500, method: 'zelle' }] });
    const fullRev = Object.assign({}, base, { status: 'partial', amountPaid: 500, balanceDue: 500, depositPaid: true,
      payments: paid.payments.concat([{ amount: -500, method: 'zelle', reversal: true }]) });
    ok('exported', typeof L.reversedInvoiceEvents === 'function');
    ok('final payment reversed on a paid invoice → [paid_in_full]', JSON.stringify(reversed(paid, fullRev)) === '["paid_in_full"]', JSON.stringify(reversed(paid, fullRev)));
    const depOnly = Object.assign({}, base, { status: 'partial', amountPaid: 500, balanceDue: 500, depositPaid: true, payments: [{ amount: 500, method: 'check' }] });
    const depRev = Object.assign({}, base, { status: 'sent', amountPaid: 0, balanceDue: 1000, depositPaid: false,
      payments: depOnly.payments.concat([{ amount: -500, method: 'check', reversal: true }]) });
    ok('deposit fully reversed → [deposit_paid]', JSON.stringify(reversed(depOnly, depRev)) === '["deposit_paid"]', JSON.stringify(reversed(depOnly, depRev)));
    const onePay = Object.assign({}, base, { status: 'paid', amountPaid: 1000, balanceDue: 0, depositPaid: true, payments: [{ amount: 1000, method: 'cash' }] });
    const oneRev = Object.assign({}, base, { status: 'sent', amountPaid: 0, balanceDue: 1000, depositPaid: false,
      payments: onePay.payments.concat([{ amount: -1000, method: 'cash', reversal: true }]) });
    ok('the only payment reversed → [paid_in_full, deposit_paid] (pay-off first)', JSON.stringify(reversed(onePay, oneRev)) === '["paid_in_full","deposit_paid"]', JSON.stringify(reversed(onePay, oneRev)));
    const newPay = Object.assign({}, depOnly, { status: 'paid', amountPaid: 1000, balanceDue: 0, payments: depOnly.payments.concat([{ amount: 500, method: 'zelle' }]) });
    ok('a new positive payment → []', JSON.stringify(reversed(depOnly, newPay)) === '[]');
    const statusEdit = Object.assign({}, paid, { status: 'sent', depositPaid: false });
    ok('status edit with no new payment entry → []', JSON.stringify(reversed(paid, statusEdit)) === '[]');
    const over = Object.assign({}, base, { status: 'paid', amountPaid: 1200, balanceDue: 0, depositPaid: true, payments: [{ amount: 1000, method: 'check' }, { amount: 200, method: 'cash' }] });
    const overRev = Object.assign({}, over, { amountPaid: 1000, payments: over.payments.concat([{ amount: -200, method: 'cash', reversal: true }]) });
    ok('partial reversal that leaves it paid → []', JSON.stringify(reversed(over, overRev)) === '[]');
    ok('a new invoice (before null) → []', JSON.stringify(reversed(null, oneRev)) === '[]');
    ok('deleted / void / e2e invoice → []',
      JSON.stringify(reversed(onePay, Object.assign({}, oneRev, { deleted: true }))) === '[]'
      && JSON.stringify(reversed(onePay, Object.assign({}, oneRev, { status: 'void' }))) === '[]'
      && JSON.stringify(reversed(onePay, Object.assign({}, oneRev, { e2eTestData: true }))) === '[]');
  }

  console.log('\nB. planJobEventUndo / undoPayload / undoNoteText (pure)');
  {
    const P = L.planJobEventUndo || (() => ({}));
    const moved = { action: 'move', from: 'install_complete', to: 'final_payment' };
    ok('exported', typeof L.planJobEventUndo === 'function' && typeof L.undoPayload === 'function' && typeof L.undoNoteText === 'function');
    const p = P({ stage: 'final_payment' }, moved);
    ok('still on the moved-to stage → move back to the recorded from', p.action === 'move' && p.to === 'install_complete' && p.from === 'final_payment', JSON.stringify(p));
    ok('legacy names compare by key', P({ stage: 'Final Payment' }, moved).action === 'move');
    ok('rep moved it since → skip', P({ stage: 'closed' }, moved).action === 'skip');
    ok('marker recorded no move → skip', P({ stage: 'final_payment' }, { action: 'skip', from: 'final_payment', to: 'final_payment' }).action === 'skip');
    ok('move with a null from → skip', P({ stage: 'contacted' }, { action: 'move', from: null, to: 'contacted' }).action === 'skip');
    ok('deleted lead → skip', P({ stage: 'final_payment', deleted: true }, moved).action === 'skip');
    ok('no lead → skip', P(null, moved).action === 'skip');
    if (typeof L.undoPayload === 'function') {
      const lead = { stage: 'final_payment', _stageKey: 'final_payment', closedAt: 'X', installCompletedAt: 'Y' };
      const { payload } = L.undoPayload(lead, P(lead, moved), { actor: 'payment reversed', atIso: 'T', event: 'paid_in_full' }, FV);
      ok('payload: stage, stageRole, timestamps, history, _stageKey',
        payload.stage === 'install_complete' && payload.stageRole === require(path.join(ROOT, 'functions', 'stage-roles.js')).roleFromKey('install_complete')
        && payload.updatedAt === '__TS__' && payload.stageStartedAt === '__TS__' && payload._stageKey === 'install_complete'
        && payload.stageHistory.__union[0].event === 'paid_in_full_reversed' && payload.stageHistory.__union[0].from === 'final_payment'
        && payload.stageHistory.__union[0].to === 'install_complete', JSON.stringify(payload));
      ok('payload never touches closedAt / installCompletedAt', !('closedAt' in payload) && !('installCompletedAt' in payload));
      const p2 = L.undoPayload({ stage: 'final_payment' }, P({ stage: 'final_payment' }, moved), { actor: 'a', atIso: 'T', event: 'paid_in_full' }, FV).payload;
      ok('no _stageKey written when the lead has none', !('_stageKey' in p2));
      ok('note text', L.undoNoteText('install_complete', 'paid_in_full', 'INV9') === 'Stage moved back to "Install Done" — automatic: payment reversed (invoice INV9).', L.undoNoteText('install_complete', 'paid_in_full', 'INV9'));
    }
  }

  console.log('\nC. undoJobEvent (fake transactional Firestore)');
  ok('exported', !!undoFn);
  if (undoFn) {
    const mid = L.markerId('L1', 'paid_in_full', 'INV1');
    const seed = (leadStage, extra) => Object.assign({
      'leads/L1': { stage: leadStage, userId: 'u1', companyId: 't1', jobType: 'cash' },
      ['job_events/' + mid]: { leadId: 'L1', event: 'paid_in_full', sourceId: 'INV1', result: { action: 'move', from: 'install_complete', to: 'final_payment' } },
    }, extra || {});
    const args = { leadId: 'L1', companyId: 't1', event: 'paid_in_full', sourceId: 'INV1', actor: 'payment reversed', at: NOW };

    let db = makeDb(seed('final_payment'));
    let r = await undoFn(db, args, spineDeps);
    const lead = db.store.get('leads/L1');
    ok('still on Final Payment → moved back to Install Done', r.moved === true && lead.stage === 'install_complete', JSON.stringify(r));
    ok('…history entry names the reversal', (lead.stageHistory || []).some((h) => h.event === 'paid_in_full_reversed' && h.to === 'install_complete'));
    ok('…marker deleted', !db.store.has('job_events/' + mid) && r.undone === true);
    const note = [...db.store.entries()].find(([k]) => k.startsWith('notes/spine-undo-' + mid + '-'));
    ok('…timeline note (stage_change, owner userId)', note && note[1].type === 'stage_change' && note[1].leadId === 'L1' && note[1].userId === 'u1'
      && /Stage moved back to "Install Done" — automatic: payment reversed \(invoice INV1\)/.test(note[1].text), note && JSON.stringify(note[1]));

    db = makeDb(seed('closed'));
    r = await undoFn(db, args, spineDeps);
    ok('rep moved the lead since → lead untouched', db.store.get('leads/L1').stage === 'closed' && r.moved === false && !db.writes.some((w) => w[1] === 'leads/L1'));
    ok('…but the marker is still deleted', !db.store.has('job_events/' + mid) && r.undone === true);

    db = makeDb({ 'leads/L1': { stage: 'final_payment', userId: 'u1', companyId: 't1' } });
    r = await undoFn(db, args, spineDeps);
    ok('no marker → no-op', r.undone === false && r.reason === 'no_marker' && db.writes.length === 0, JSON.stringify(r));

    db = makeDb(seed('final_payment'));
    r = await undoFn(db, Object.assign({}, args, { companyId: 'OTHER' }), spineDeps);
    ok('tenant mismatch → no move', db.store.get('leads/L1').stage === 'final_payment' && r.moved === false && r.reason === 'tenant_mismatch', JSON.stringify(r));

    const boom = await undoFn({ runTransaction: async () => { throw new Error('boom'); }, collection: () => ({ doc: () => ({ collection: () => ({ doc: () => ({}) }) }) }) }, args, spineDeps);
    ok('never throws: a failure comes back as reason error', boom && boom.reason === 'error');
  }

  console.log('\nD. money-paper.js handle');
  {
    const MP = require(path.join(ROOT, 'functions', 'money-paper.js'))._internal;
    const calls = [];
    const hdeps = (db) => ({
      db, now: () => NOW, FieldValue: FV, retryDelayMs: 0,
      recordJobEvent: (d, a) => SPINE.recordJobEvent(d, a, spineDeps),
      undoJobEvent: (d, a) => { calls.push(a.event); return undoFn ? undoFn(d, a, spineDeps) : null; },
      loadLeadInvoices: async () => [],
      writePaymentTimeline: async () => null,
    });
    const base = { leadId: 'M1', companyId: 't1', userId: 't1', total: 1000, depositAmount: 0, jobId: 'J1' };
    const db = makeDb({
      'leads/M1': { stage: 'install_complete', jobType: 'cash', userId: 't1', companyId: 't1', activeJobId: 'J1' },
      'leads/M1/jobs/J1': { status: 'closed', paidInFull: false },
    });
    const sent = Object.assign({}, base, { status: 'sent', amountPaid: 0, balanceDue: 1000, payments: [] });
    const paid = Object.assign({}, base, { status: 'paid', amountPaid: 1000, balanceDue: 0, depositPaid: true, payments: [{ amount: 1000, method: 'zelle' }] });
    let r = await MP.handle('INVR', paid, hdeps(db), sent);
    ok('setup: the payoff moves the card to Final Payment', db.store.get('leads/M1').stage === 'final_payment', JSON.stringify(r && r.spine));
    ok('a normal payment write never calls the undo', calls.length === 0);
    // The job's paidInFull is set by markJobPaid (owner tenant only); set it as it would be.
    db.store.set('leads/M1/jobs/J1', { status: 'closed', paidInFull: true, paidInFullAt: 'X' });
    const rev = Object.assign({}, base, { status: 'sent', amountPaid: 0, balanceDue: 1000, depositPaid: false,
      payments: paid.payments.concat([{ amount: -1000, method: 'zelle', reversal: true }]) });
    r = await MP.handle('INVR', rev, hdeps(db), paid);
    ok('the reversal write calls the undo for paid_in_full', calls.indexOf('paid_in_full') !== -1, JSON.stringify(calls));
    ok('…the card walks back to Install Done', db.store.get('leads/M1').stage === 'install_complete', db.store.get('leads/M1').stage);
    ok('…the marker is gone', !db.store.has('job_events/' + L.markerId('M1', 'paid_in_full', 'INVR')));
    const job = db.store.get('leads/M1/jobs/J1');
    ok('…the job is no longer paid in full', job.paidInFull === false && !('paidInFullAt' in job), JSON.stringify(job));
    ok('…results ride back on the handle output', r && r.unspine && r.unspine.paid_in_full && r.unspine.paid_in_full.moved === true && r.jobUnpaid === 'J1', JSON.stringify(r));
    // A real re-payment after the reversal moves the card forward again.
    const repaid = Object.assign({}, rev, { status: 'paid', amountPaid: 1000, balanceDue: 0, depositPaid: true, payments: rev.payments.concat([{ amount: 1000, method: 'check' }]) });
    calls.length = 0;
    await MP.handle('INVR', repaid, hdeps(db), rev);
    ok('a re-payment after the reversal moves to Final Payment again', db.store.get('leads/M1').stage === 'final_payment');
    ok('…without calling the undo', calls.length === 0);
  }

  {
    // A walk-back that still fails after retries fails the trigger run, like a failed forward move (alerting).
    const MP2 = require(path.join(ROOT, 'functions', 'money-paper.js'))._internal;
    ok('spineFailures reports a failed walk-back', MP2.spineFailures({ unspine: { paid_in_full: { reason: 'error' } } }).length === 1
      && MP2.spineFailures({ unspine: { paid_in_full: { undone: true } } }).length === 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
