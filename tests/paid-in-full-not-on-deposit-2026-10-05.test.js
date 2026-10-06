/**
 * paid-in-full-not-on-deposit-2026-10-05.test.js — a paid DEPOSIT is not the
 * job paid in full.
 *
 * Bug (HIGH, Jo approved the fix 2026-10-05): the invoice trigger
 * (functions/money-paper.js) fired the job spine's paid_in_full on ANY
 * invoice reaching 'paid'. Paying a $4,620 deposit invoice moved the job from
 * Contract Signed straight to Final Payment, filed the "request a review"
 * task before the install, skipped Install Done (so the final invoice was
 * never drafted and the balance never billed), and filed a "paid in full —
 * not closed" task. The fix: functions/paid-in-full.js invoiceSettlesJob,
 * applied by money-paper.js settlesJob to the spine, the job-paid mark and
 * the paid-not-closed task.
 *
 *   A. the pure rule (isDepositInvoice / billsWholeJob / invoiceSettlesJob)
 *   B. the trigger end to end against a fake Firestore (real loadLeadInvoices,
 *      real recordJobEvent): deposit paid → no paid_in_full, stage unchanged,
 *      no review / paid-not-closed task; final paid with the deposit paid
 *      earlier → paid_in_full fires
 *   C. wiring: the job-paid mark and the paid-not-closed task are gated too
 *
 * Break-test: against origin/main, B's deposit cases fail (the lead lands on
 * Final Payment with a review task and a paid-not-closed task) and A fails
 * (no invoiceSettlesJob).
 *
 * Run: node tests/paid-in-full-not-on-deposit-2026-10-05.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PIF = require(path.join(ROOT, 'functions', 'paid-in-full.js'));
const SPINE = require(path.join(ROOT, 'functions', 'job-spine.js'));
const MP = require(path.join(ROOT, 'functions', 'money-paper.js'))._internal;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

// ── fake Firestore: docs, subcollections, where('leadId','==',x), create, transactions ──
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const clone = (d) => (d === undefined ? undefined : JSON.parse(JSON.stringify(d)));
  const apply = (cur, patch) => {
    const d = Object.assign({}, cur);
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && v.__union) d[k] = (Array.isArray(d[k]) ? d[k] : []).concat(v.__union);
      else d[k] = v;
    }
    return d;
  };
  const exists = (code) => { const e = new Error('ALREADY_EXISTS'); e.code = code; return e; };
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    collection: (c) => col(p + '/' + c),
    async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; },
    async update(patch) { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); store.set(p, apply(store.get(p), patch)); },
    async set(data) { store.set(p, clone(data)); },
    async create(data) { if (store.has(p)) throw exists(6); store.set(p, clone(data)); },
  });
  const col = (c) => ({
    doc: (id) => ref(c + '/' + id),
    where: (field, op, val) => ({
      async get() {
        const docs = [];
        for (const [k, v] of store) {
          const rest = k.slice(c.length + 1);
          if (k.startsWith(c + '/') && rest.indexOf('/') === -1 && v && v[field] === val) docs.push({ id: rest, data: () => clone(v) });
        }
        return { docs };
      },
    }),
  });
  return {
    store,
    collection: col,
    doc: (p) => ref(p),
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        get: (r) => r.get(),
        create: (r, d) => pending.push(() => { if (store.has(r.path)) throw exists(6); store.set(r.path, clone(d)); }),
        set: (r, d) => pending.push(() => { store.set(r.path, clone(d)); }),
        update: (r, p) => pending.push(() => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); store.set(r.path, apply(store.get(r.path), p)); }),
      };
      const out = await fn(tx);
      const snapshot = new Map(store);
      try { pending.forEach((f) => f()); } catch (e) { store.clear(); snapshot.forEach((v, k) => store.set(k, v)); throw e; }
      return out;
    },
  };
}
const FV = { serverTimestamp: () => '__TS__', arrayUnion: (...x) => ({ __union: x }) };
const NOW = Date.parse('2026-10-05T15:00:00Z');
const quiet = { info() {}, warn() {}, error() {} };
const spineDeps = { FieldValue: FV, logger: quiet, now: () => NOW, depositDraft: false, finalDraft: false };
const hdeps = (db) => ({
  db, now: () => NOW, FieldValue: FV,
  recordJobEvent: (d, a) => SPINE.recordJobEvent(d, a, spineDeps),
  writePaymentTimeline: async () => null,
});
const tasksOf = (db, leadId) => [...db.store.keys()].filter((k) => k.startsWith('leads/' + leadId + '/tasks/'));

(async () => {
  console.log('\nA. the pure rule (functions/paid-in-full.js)');
  {
    ok('exports invoiceSettlesJob / isDepositInvoice / billsWholeJob',
      typeof PIF.invoiceSettlesJob === 'function' && typeof PIF.isDepositInvoice === 'function' && typeof PIF.billsWholeJob === 'function');
    const D = PIF.isDepositInvoice || (() => null);
    ok('deposit: kind "deposit"', D({ kind: 'deposit', total: 4620 }) === true);
    ok('deposit: type / invoiceType "Deposit"', D({ type: 'Deposit', total: 4620 }) === true && D({ invoiceType: 'deposit', total: 4620 }) === true);
    ok('deposit: the whole invoice is the deposit (total ≤ depositAmount)', D({ total: 4620, depositAmount: 4620 }) === true);
    ok('deposit: every billed line says deposit (a Stripe-mirrored deposit invoice)',
      D({ total: 4620, depositAmount: 0, items: [{ description: '50% Deposit — roof replacement', total: 4620 }] }) === true);
    ok('not deposit: the signing-day invoice (full total with deposit terms)', D({ total: 9240, depositAmount: 4620, items: [{ description: 'Roof replacement', total: 9240 }] }) === false);
    ok('not deposit: a final invoice crediting "Less deposit paid"',
      D({ kind: 'final', total: 4620, items: [{ description: 'Roof replacement', total: 9240 }, { description: 'Less deposit paid', total: -4620, credit: true }] }) === false);

    const S = PIF.invoiceSettlesJob || (() => ({}));
    const lead = { companyId: 't1', userId: 't1', jobValue: 9240, stage: 'contract_signed' };
    const dep = { id: 'DEP', leadId: 'M1', companyId: 't1', status: 'paid', total: 4620, amountPaid: 4620, balanceDue: 0, jobId: 'J1', items: [{ description: 'Deposit', total: 4620 }] };
    ok('deposit invoice paid → does NOT settle the job', S(dep, lead, [dep]).settles === false && S(dep, lead, [dep]).reason === 'deposit_invoice');
    ok('…even when the invoices could not be read', S(dep, lead, null).settles === false);
    const plain = { id: 'P1', leadId: 'M1', companyId: 't1', status: 'paid', total: 4620, amountPaid: 4620, balanceDue: 0, jobId: 'J1', items: [{ description: 'Roofing', total: 4620 }] };
    ok('untagged partial bill short of the lead\'s jobValue → does not settle', S(plain, lead, [plain]).reason === 'short_of_job_value',
      JSON.stringify(S(plain, lead, [plain])));
    ok('…the same invoice with no jobValue on the lead → settles (nothing says it is short)', S(plain, { companyId: 't1' }, [plain]).settles === true);
    const fin = { id: 'FIN', leadId: 'M1', companyId: 't1', status: 'paid', kind: 'final', total: 4620, amountPaid: 4620, balanceDue: 0, jobId: 'J1' };
    ok('final invoice paid, deposit paid earlier → settles', S(fin, lead, [dep, fin]).settles === true);
    const finPlain = Object.assign({}, plain, { id: 'P2' });
    ok('untagged second bill that brings the collected total to jobValue → settles', S(finPlain, lead, [dep, finPlain]).settles === true);
    const open = { id: 'OPEN', leadId: 'M1', companyId: 't1', status: 'sent', total: 1000, balanceDue: 1000, jobId: 'J1' };
    ok('another invoice on the job still owes → does not settle', S(fin, lead, [dep, fin, open]).reason === 'balance_owed');
    const otherJob = Object.assign({}, open, { id: 'OJ', jobId: 'J2' });
    ok('an open invoice on a DIFFERENT job does not block this one', S(fin, lead, [dep, fin, otherJob]).settles === true);
    const full = { id: 'FULL', leadId: 'M1', companyId: 't1', status: 'paid', total: 9000, amountPaid: 9000, balanceDue: 0, estimateId: 'E1', jobId: 'J1' };
    ok('full invoice from the estimate → settles even if jobValue is stale', S(full, lead, [full]).settles === true);
    ok('not paid → never settles', S(Object.assign({}, full, { status: 'partial' }), lead, [full]).settles === false);
  }

  console.log('\nB. the invoice trigger end to end (money-paper.js handle → job spine)');
  {
    // The bug: a $4,620 deposit invoice paid by card on a Contract Signed job.
    const db = makeDb({
      'leads/M1': { userId: 't1', companyId: 't1', stage: 'contract_signed', jobType: 'cash', jobValue: 9240, activeJobId: 'J1' },
      'invoices/DEP': { leadId: 'M1', companyId: 't1', userId: 't1', status: 'sent', total: 4620, depositAmount: 4620, amountPaid: 0, balanceDue: 4620, jobId: 'J1' },
    });
    const before = db.store.get('invoices/DEP');
    const after = Object.assign({}, before, { status: 'paid', amountPaid: 4620, balanceDue: 0, depositPaid: true, payments: [{ amount: 4620, method: 'stripe' }] });
    db.store.set('invoices/DEP', after);
    const r = await MP.handle('DEP', after, hdeps(db), before);
    const lead = db.store.get('leads/M1');
    ok('deposit paid → NO paid_in_full event', !(r.spine && r.spine.paid_in_full), JSON.stringify(r.spine));
    ok('…stage unchanged (still Contract Signed, not Final Payment)', lead.stage === 'contract_signed', lead.stage);
    ok('…at most a deposit_paid event (forward only — no move from Contract Signed)', !!(r.spine && r.spine.deposit_paid) && r.spine.deposit_paid.moved !== true);
    ok('…no "Request Review" task before the install', !tasksOf(db, 'M1').some((k) => /review/i.test(k)), tasksOf(db, 'M1').join(','));
    ok('…no "paid in full — not closed" task', !r.paidNotClosed && !tasksOf(db, 'M1').some((k) => /paid-not-closed/.test(k)), tasksOf(db, 'M1').join(','));
    ok('…no paid_in_full marker in job_events', ![...db.store.keys()].some((k) => /^job_events\/.*paid_in_full/.test(k)));
  }
  {
    // Same, with a deposit invoice made earlier as a deposit-only Stripe invoice
    // (no depositAmount stamp, line says Deposit) on a Negotiating lead:
    // money landed → at least Contract Signed, never Final Payment.
    const db = makeDb({
      'leads/M2': { userId: 't1', companyId: 't1', stage: 'negotiating', jobType: 'cash' },
      'invoices/DEP2': { leadId: 'M2', companyId: 't1', userId: 't1', status: 'sent', total: 4620, depositAmount: 0, amountPaid: 0, balanceDue: 4620, items: [{ description: 'Deposit', total: 4620 }] },
    });
    const before = db.store.get('invoices/DEP2');
    const after = Object.assign({}, before, { status: 'paid', amountPaid: 4620, balanceDue: 0, payments: [{ amount: 4620, method: 'zelle' }] });
    db.store.set('invoices/DEP2', after);
    const r = await MP.handle('DEP2', after, hdeps(db), before);
    ok('deposit-only invoice paid on a Negotiating lead → Contract Signed (deposit_paid), not Final Payment',
      db.store.get('leads/M2').stage === 'contract_signed' && !(r.spine && r.spine.paid_in_full), db.store.get('leads/M2').stage);
    // Paid by Zelle (not a Stripe payoff the webhook may advance), lead left on
    // an open stage: the old "paid in full — not closed" rule would file here.
    ok('…and no "paid in full — not closed" task for a paid deposit', !r.paidNotClosed && !tasksOf(db, 'M2').some((k) => /paid-not-closed/.test(k)), tasksOf(db, 'M2').join(','));
  }
  {
    // The final invoice paid, the deposit paid earlier → paid in full.
    const db = makeDb({
      'leads/M3': { userId: 't1', companyId: 't1', stage: 'install_complete', jobType: 'cash', jobValue: 9240, activeJobId: 'J1' },
      'invoices/DEP': { leadId: 'M3', companyId: 't1', userId: 't1', status: 'paid', total: 4620, depositAmount: 4620, amountPaid: 4620, balanceDue: 0, jobId: 'J1' },
      'invoices/FIN': { leadId: 'M3', companyId: 't1', userId: 't1', status: 'sent', kind: 'final', total: 4620, amountPaid: 0, balanceDue: 4620, jobId: 'J1',
        items: [{ description: 'Roof replacement', total: 9240 }, { description: 'Less deposit paid', total: -4620, credit: true }] },
    });
    const before = db.store.get('invoices/FIN');
    const after = Object.assign({}, before, { status: 'paid', amountPaid: 4620, balanceDue: 0, payments: [{ amount: 4620, method: 'check' }] });
    db.store.set('invoices/FIN', after);
    const r = await MP.handle('FIN', after, hdeps(db), before);
    ok('final paid (deposit paid earlier) → paid_in_full fires and moves to Final Payment',
      !!(r.spine && r.spine.paid_in_full && r.spine.paid_in_full.moved) && db.store.get('leads/M3').stage === 'final_payment', JSON.stringify(r.spine));
    ok('…and the review ask is filed now (the job really is paid)', tasksOf(db, 'M3').some((k) => /review/i.test(k)), tasksOf(db, 'M3').join(','));
  }
  {
    // One invoice for the whole job (signing-day shape), paid off in one go → still paid in full.
    const db = makeDb({
      'leads/M4': { userId: 't1', companyId: 't1', stage: 'contract_signed', jobType: 'cash', jobValue: 9240 },
      'invoices/ONE': { leadId: 'M4', companyId: 't1', userId: 't1', status: 'sent', total: 9240, depositAmount: 4620, amountPaid: 0, balanceDue: 9240 },
    });
    const before = db.store.get('invoices/ONE');
    const after = Object.assign({}, before, { status: 'paid', amountPaid: 9240, balanceDue: 0, depositPaid: true, payments: [{ amount: 9240, method: 'stripe' }] });
    db.store.set('invoices/ONE', after);
    const r = await MP.handle('ONE', after, hdeps(db), before);
    ok('whole-job invoice paid off → paid_in_full (unchanged behaviour)', !!(r.spine && r.spine.paid_in_full) && db.store.get('leads/M4').stage === 'final_payment');
  }

  console.log('\nC. wiring (money-paper.js)');
  {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
    const mp = strip(fs.readFileSync(path.join(ROOT, 'functions', 'money-paper.js'), 'utf8'));
    ok('the job-paid mark waits for settlesJob', /becamePaid[\s\S]{0,160}=== OWNER && after\.leadId\s*&& \(await settlesJob\(deps, invoiceId, after\)\)\.settles\) \{\s*out\.jobPaid = await markJobPaid\(/.test(mp));
    ok('the paid-not-closed task waits for settlesJob', /becamePaid && after\.leadId\s*&& \(await settlesJob\(deps, invoiceId, after\)\)\.settles\) \{\s*out\.paidNotClosed = await flagPaidNotClosed\(/.test(mp));
    ok('the spine swaps paid_in_full for deposit_paid when the job is not settled',
      /indexOf\('paid_in_full'\) !== -1 && !\(await settlesJob\(deps, invoiceId, after\)\)\.settles\)[\s\S]{0,120}'deposit_paid'/.test(mp));
  }

  console.log('\n──────────────────────\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
