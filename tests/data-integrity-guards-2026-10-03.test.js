/**
 * tests/data-integrity-guards-2026-10-03.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * A read-only audit of the owner tenant (234 live leads, 2026-10-03) found
 * data the code kept producing. This pins the CODE fixes (no data was
 * touched — cleanup needs the owner's sign-off separately):
 *
 *   1. Won leads with no closedAt (10) / won with no invoice (26 of 30):
 *      commitStageChange stamps closedAt on entering a won stage (once — a
 *      won → won step keeps the date); the per-job kanban move, the Stripe
 *      payoff advance and a CSV import do too; the kanban offers
 *      "Create invoice" when a lead is won with none.
 *   2. Paid invoice but lead not won (3) / 61 Thumbtack leads at 'New' with
 *      no stageRole: a full payoff on a not-won lead files ONE "paid in full
 *      — not closed" task (never moves the stage); the bridge writes the
 *      canonical 'new' key + stageRole.
 *   3. 65 phone-less door-knock leads burying real follow-ups: no automatic
 *      follow-up for a knock lead with no phone; they don't count in
 *      "Follow-ups Due".
 *   5. Past appointments still 'booked': flagged "needs an outcome".
 *   6. Thumbtack duplicates: a repeat request from a phone already in the
 *      tenant attaches to that lead instead of minting another card.
 *   7. Soft deletes without deletedAt (10): the repo soft-delete stamps it,
 *      and every `deleted: true` write in the app carries deletedAt.
 *   (4. stage tasks with dueDate '' — already fixed by #1853, pinned in
 *      tests/stage-checklist.test.js.)
 *
 * Behavioural: real functions lifted/required into vm sandboxes or loaded
 * against in-memory fakes. Zero network. Run:
 *   node tests/data-integrity-guards-2026-10-03.test.js
 */
'use strict';

process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Lift `function name(` / `async function name(` with its body.
function lift(src, name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start === -1) start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  let depth = 0, i = src.indexOf('{', src.indexOf(')', start));
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { i++; break; }
  }
  return src.slice(start, i);
}

// ── stub firebase modules so functions/*.js load without a project ──
const FieldValue = { serverTimestamp: () => 'SERVER_TS', arrayUnion: (...a) => ({ arrayUnion: a }) };
let _currentDb = null;
const stubs = {
  'firebase-functions/v2/firestore': {
    onDocumentWritten: (opts, fn) => fn, onDocumentCreated: (opts, fn) => fn, onDocumentUpdated: (opts, fn) => fn,
  },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => _currentDb, FieldValue },
  'firebase-admin/storage': { getStorage: () => null },
  './customer-id-mint': {
    createLeadWithCustomerId: async (db, ref, doc) => {
      if ((await ref.get()).exists) { const e = new Error('already exists'); e.code = 6; throw e; }
      await ref.set(doc);
      return { customerId: null };
    },
  },
};
function requireFn(rel) {
  const origLoad = Module._load;
  Module._load = function (req) { if (stubs[req]) return stubs[req]; return origLoad.apply(this, arguments); };
  try { return require(path.join(ROOT, 'functions', rel)); } finally { Module._load = origLoad; }
}

// In-memory Firestore (admin-SDK shape) with equality where() chains.
function makeDb() {
  const store = new Map();
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  function ref(p) {
    return {
      path: p, id: p.split('/').pop(),
      async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; },
      async set(data, o) { store.set(p, o && o.merge ? Object.assign(store.get(p) || {}, clone(data)) : clone(data)); },
      async update(patch) { if (!store.has(p)) throw new Error('no doc ' + p); Object.assign(store.get(p), clone(patch)); },
      collection(c) { return col(p + '/' + c); },
    };
  }
  function query(c, filters, lim) {
    return {
      where(f, op, v) { return query(c, filters.concat([[f, v]]), lim); },
      limit(n) { return query(c, filters, n); },
      async get() {
        const docs = [];
        for (const [k, v] of store) {
          if (!k.startsWith(c + '/') || k.split('/').length !== c.split('/').length + 1) continue;
          if (filters.every(([f, val]) => v[f] === val)) docs.push({ id: k.split('/').pop(), data: () => clone(v) });
        }
        return { docs: lim ? docs.slice(0, lim) : docs, empty: !docs.length };
      },
    };
  }
  function col(c) { return Object.assign(query(c, [], 0), { doc: (id) => ref(c + '/' + id) }); }
  return { store, collection: col };
}

(async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('\n1. closedAt on entering a won stage — stage-write.js commitStageChange');
  const STAGE_SRC = read('docs/pro/js/stage-write.js');
  const WON = new Set(['closed', 'install_complete', 'final_payment']);
  const roleOf = (s) => (WON.has(s) ? 'won' : s === 'lost' ? 'lost' : s === 'new' ? 'new' : 'active');
  async function commit(opts) {
    const rec = { tx: null, plain: null };
    const win = {
      db: {}, doc: (db, c, id) => c + '/' + id, collection: (db, c) => c,
      serverTimestamp: () => 'SERVER_TS', arrayUnion: (x) => ({ arrayUnion: x }),
      addDoc: async () => ({ id: 'n' }), updateDoc: async (r, p) => { rec.plain = p; },
      stageRole: roleOf, _user: { uid: 'u1' }, auth: { currentUser: { email: 'rep@x' } },
    };
    if (!opts.noTx) {
      win.runTransaction = async (db, fn) => fn({
        get: async () => ({ exists: () => true, data: () => ({ stage: opts.cur, closedAt: opts.curClosedAt || null }) }),
        update: (r, p) => { rec.tx = p; },
      });
    }
    const sb = { window: win, console: { warn() {}, log() {}, error() {} }, document: { dispatchEvent() {} }, CustomEvent: function () {} };
    vm.createContext(sb);
    vm.runInContext(STAGE_SRC.replace(/^export\s+/gm, '') + '\nglobalThis.__c = commitStageChange;', sb);
    rec.ret = await sb.__c('L1', opts.to, opts.from || opts.cur, {});
    return rec;
  }
  {
    const r = await commit({ cur: 'contract_signed', to: 'closed' });
    ok('active → closed stamps closedAt in the transaction', r.tx && r.tx.closedAt === 'SERVER_TS', JSON.stringify(r.tx));
    ok('…and reports enteredWon (the "Create invoice" cue)', r.ret && r.ret.enteredWon === true);
  }
  {
    const r = await commit({ cur: 'install_complete', curClosedAt: { seconds: 1 }, to: 'final_payment' });
    ok('won → won with a close date keeps it (no second close)', r.tx && !('closedAt' in r.tx), JSON.stringify(r.tx));
    ok('…and is not a new win', r.ret && r.ret.enteredWon === false);
  }
  {
    const r = await commit({ cur: 'install_complete', to: 'closed' });
    ok('won → won with NO close date backfills it', r.tx && r.tx.closedAt === 'SERVER_TS');
  }
  {
    const r = await commit({ cur: 'new', to: 'contacted' });
    ok('an open → open move writes no closedAt', r.tx && !('closedAt' in r.tx) && r.ret.enteredWon === false);
  }
  {
    const r = await commit({ noTx: true, cur: 'negotiating', to: 'closed' });
    ok('no-transaction fallback stamps it too', r.plain && r.plain.closedAt === 'SERVER_TS' && r.ret.enteredWon === true);
  }

  console.log('\n1b. server: stage-roles needsClosedAt + the Stripe payoff advance');
  const SR = require(path.join(ROOT, 'functions', 'stage-roles.js'));
  ok('needsClosedAt: open lead → final_payment', SR.needsClosedAt({ stage: 'contract_signed' }, 'final_payment') === true);
  ok('needsClosedAt: won lead with a date → no', SR.needsClosedAt({ stage: 'install_complete', closedAt: 1 }, 'final_payment') === false);
  ok('needsClosedAt: won lead without a date → yes', SR.needsClosedAt({ stage: 'install_complete' }, 'final_payment') === true);
  ok('needsClosedAt: non-won destination → no', SR.needsClosedAt({ stage: 'new' }, 'contacted') === false);
  {
    // Since the job spine (#2123) the payoff advance is no longer in the
    // Stripe webhook: the invoice trigger records paid_in_full and
    // job-spine-logic.js movePayload stamps closedAt through THIS helper.
    const stripe = read('functions/stripe.js');
    const SL = require(path.join(ROOT, 'functions', 'job-spine-logic.js'));
    const fv = { serverTimestamp: () => 'TS', arrayUnion: (x) => [x] };
    const pay = (lead) => SL.movePayload(lead, SL.planJobEvent(lead, 'paid_in_full'), { actor: 'a', atIso: 'T', event: 'paid_in_full' }, fv).payload;
    let delegated = 0; const orig = SR.needsClosedAt;
    SR.needsClosedAt = function () { delegated++; return orig.apply(this, arguments); };
    const p1 = pay({ stage: 'contract_signed', jobType: 'cash' });
    const p2 = pay({ stage: 'install_complete', stageRole: 'won', closedAt: 1, jobType: 'cash' });
    SR.needsClosedAt = orig;
    ok('the Stripe payoff advance stamps closedAt via needsClosedAt',
      p1.closedAt === 'TS' && !('closedAt' in p2) && delegated === 2 && !/stage: 'final_payment'/.test(stripe));
  }

  console.log('\n1c. kanban: per-job move + the "Create invoice" offer (crm-pipeline.js)');
  const CP = read('docs/pro/js/crm-pipeline.js');
  {
    const rec = { patch: null };
    const sb = {
      window: {
        NBDJobs: {
          cardsFor: (lead, jobs) => jobs.map((j) => Object.assign({}, lead, j, { _jobId: j.id })),
          forLead: () => [{ id: 'j2', stage: 'install_in_progress' }],
          update: async (lead, jobId, patch) => { rec.patch = patch; },
        },
        normalizeStage: (s) => s, stageRole: roleOf, arrayUnion: (x) => ({ arrayUnion: x }), _user: { uid: 'u1' },
      },
      showToast() {}, renderLeads() {}, console,
    };
    vm.createContext(sb);
    vm.runInContext(lift(CP, '_moveJobCard') + '\nglobalThis.__m = _moveJobCard;', sb);
    await sb.__m({ id: 'L1' }, 'j2', 'install_complete', false);
    ok('a job moved onto install_complete (won, not "closed") gets closedAt', !!(rec.patch && rec.patch.closedAt), JSON.stringify(rec.patch));
  }
  async function offer(invoiceDocs, opts) {
    const rec = { toasts: [], created: [] };
    const sb = {
      window: {
        db: {}, _user: { uid: 'u1' }, _userClaims: {},
        collection: (db, c) => c, where: (f, op, v) => [f, v], limit: (n) => ({ limit: n }),
        query: (c, ...parts) => parts,
        getDocs: async (parts) => {
          if (opts && opts.fail) throw new Error('denied');
          const f = parts.filter(Array.isArray);
          const hit = invoiceDocs.filter((d) => f.every(([k, v]) => d[k] === v));
          return { empty: !hit.length, docs: hit };
        },
        InvoicePipeline: { createInvoiceUI: (id) => rec.created.push(id) },
      },
      showToast: (o) => rec.toasts.push(o), console: { warn() {}, log() {} },
    };
    vm.createContext(sb);
    vm.runInContext(lift(CP, '_leadHasInvoice') + '\n' + lift(CP, '_offerInvoiceOnWin') + '\nglobalThis.__o = _offerInvoiceOnWin;', sb);
    rec.ret = await sb.__o({ id: 'L1', firstName: 'Pat', lastName: 'Q' });
    return rec;
  }
  {
    const r = await offer([]);
    ok('won with no invoice → a toast offering "Create invoice"', r.ret === true && r.toasts.length === 1 && r.toasts[0].undoText === 'Create invoice');
    if (r.toasts[0]) r.toasts[0].undoAction();
    ok('…whose button opens the invoice form for that lead', r.created[0] === 'L1');
  }
  {
    const r = await offer([{ leadId: 'L1', createdBy: 'u1' }]);
    ok('won WITH an invoice → no offer', r.ret === false && r.toasts.length === 0);
  }
  {
    const r = await offer([], { fail: true });
    ok('invoice check failed → still offers (never silently skips)', r.ret === true && r.toasts.length === 1);
  }
  ok('moveCard offers it after a commit that entered a won stage',
    /const \{ historyEvent, enteredWon \} = await commitStageChange\(/.test(CP) && /if \(enteredWon\) _offerInvoiceOnWin\(lead\);/.test(CP));

  console.log('\n1d. CSV import / new won lead — covered in csv-import-stage-customerid + edit-lead-stage-write tests');

  // ══════════════════════════════════════════════════════════════════
  console.log('\n2. bridge writes the canonical new stage + role (lead-bridge-logic.js)');
  const L = require(path.join(ROOT, 'functions', 'lead-bridge-logic.js'));
  {
    const d = L.mapPublicLeadToLead({ collection: 'thumbtack_leads', sourceId: 't1', ownerUid: 'O', companyId: 'O', data: { name: 'A B', phone: '5135550100' } });
    ok("Thumbtack lead: stage 'new' (not the legacy 'New')", d.stage === 'new', d.stage);
    ok('…with stageRole new', d.stageRole === 'new');
  }

  console.log('\n2b. paid in full, lead not won → ONE task, stage untouched (money-paper.js)');
  const MP = requireFn('money-paper.js');
  const { handle } = MP._internal;
  const T0 = new Date('2026-10-03T21:30:00-04:00').getTime(); // 9:30 pm ET — still Oct 3 locally
  async function payoff(lead, lastPayment, opts) {
    opts = opts || {};
    const db = makeDb();
    await db.collection('leads').doc('L1').set(Object.assign({ companyId: 'co-x', userId: 'rep', firstName: 'Pat', lastName: 'Q' }, lead));
    if (opts.existingTask) await db.collection('leads').doc('L1').collection('tasks').doc('paid-not-closed-I1').set({ done: true });
    const before = { leadId: 'L1', companyId: 'co-x', total: 900, balanceDue: opts.alreadyPaid ? 0 : 400, status: opts.alreadyPaid ? 'paid' : 'partial', payments: [] };
    const after = Object.assign({}, before, { balanceDue: 0, status: 'paid', payments: [lastPayment] });
    // The job spine (#2123) runs first in handle(). Stubbed here so these
    // cases test the paid-but-not-won flag on its own; opts.spineMoves
    // simulates a spine that advanced the lead (the ordering case below).
    const recordJobEvent = async (d, a) => {
      if (opts.spineMoves && a.event === 'paid_in_full') {
        await d.collection('leads').doc(a.leadId).update({ stage: 'final_payment', stageRole: 'won' });
        return { moved: true };
      }
      return { moved: false, reason: 'stubbed' };
    };
    const deps = { db, now: () => T0, bucket: null, render: null, stripe: null, recordJobEvent };
    const out = await handle('I1', after, deps, before);
    const task = db.store.get('leads/L1/tasks/paid-not-closed-I1');
    return { out, task, lead: db.store.get('leads/L1') };
  }
  {
    const r = await payoff({ stage: 'contract_signed', stageRole: 'active' }, { method: 'zelle', amount: 400 });
    ok('a Zelle payoff on a Contract Signed lead files the task', !!r.task && r.task.source === 'paid_not_closed' && r.task.done === false);
    ok("…due today in Eastern time", r.task && r.task.dueDate === '2026-10-03', r.task && r.task.dueDate);
    ok('…naming the invoice', r.task && r.task.invoiceId === 'I1');
    ok('…and the stage is NOT moved', r.lead.stage === 'contract_signed' && !('closedAt' in r.lead));
  }
  {
    // Ordering with the job spine: it runs BEFORE this flag, so a payoff the
    // spine advanced to Final Payment (won) files no paid-but-not-won task.
    const r = await payoff({ stage: 'contract_signed', stageRole: 'active' }, { method: 'zelle', amount: 400 }, { spineMoves: true });
    ok('a payoff the job spine advanced (now won) files nothing', !r.task && r.lead.stage === 'final_payment');
  }
  {
    const r = await payoff({ stage: 'closed', stageRole: 'won' }, { method: 'check', amount: 400 });
    ok('a payoff on a won lead files nothing', !r.task);
  }
  {
    const r = await payoff({ stage: 'install_in_progress', stageRole: 'job' }, { method: 'stripe', amount: 400 });
    ok('a Stripe payoff the webhook will advance to Final Payment files nothing', !r.task);
  }
  {
    const r = await payoff({ stage: 'warranty_scheduled', stageRole: 'active', jobType: 'warranty' }, { method: 'stripe', amount: 400 });
    ok('a Stripe payoff the webhook may NOT advance (warranty) files the task', !!r.task);
  }
  {
    const r = await payoff({ stage: 'contract_signed', stageRole: 'active' }, { method: 'zelle', amount: 400 }, { alreadyPaid: true });
    ok('an invoice already paid before this write files nothing (no history replay)', !r.task);
  }
  {
    const r = await payoff({ stage: 'contract_signed', stageRole: 'active' }, { method: 'zelle', amount: 400 }, { existingTask: true });
    ok('an existing (done) task is never reopened', r.task && r.task.done === true);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n3. phone-less door-knock leads and follow-ups');
  {
    // 2026-10-03: the rule lives in today-plan.js (followUpDue /
    // isUnreachableKnock); crm-pipeline's two functions delegate to it.
    const sb = { window: { NBDTodayPlan: require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'today-plan.js')) } };
    vm.createContext(sb);
    vm.runInContext([lift(CP, '_followUpDay'), lift(CP, '_unreachableKnockLead'), lift(CP, '_overdueFollowUps'),
      'globalThis.__od = _overdueFollowUps; globalThis.__uk = _unreachableKnockLead;'].join('\n'), sb);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const past = '2026-01-02';
    const leads = [
      { id: 'k1', source: 'Door Knock', phone: '', firstName: 'D2D', lastName: 'Lead', followUp: past, stage: 'new' },
      { id: 'k2', d2dKnockId: 'kn', phone: '(513) 555-0101', followUp: past, stage: 'contacted' },
      { id: 'w1', source: 'Website — Contact form', phone: '', followUp: past, stage: 'contacted' },
      { id: 'c1', source: 'Referral', phone: '5135550102', followUp: past, stage: 'closed' },
    ];
    const ids = sb.__od(leads, today).map((l) => l.id).join(',');
    ok('a phone-less knock lead is not an overdue follow-up', !/k1/.test(ids), ids);
    ok('a knock lead WITH a phone still is', /k2/.test(ids));
    ok('a phone-less non-knock lead still is (rule is knock-only)', /w1/.test(ids));
    ok('a won lead still is not (unchanged)', !/c1/.test(ids));
    ok('the rule is exported for the KPI tile + bell', /window\.nbdUnreachableKnockLead = _unreachableKnockLead;/.test(CP));
    // 2026-10-03: both now call THE follow-up rule (today-plan.js followUpDue),
    // which applies the knock rule (tests/today-plan-2026-10-03.test.js runs it).
    ok('analytics KPI uses it (through followUpDue)', /window\.NBDTodayPlan\.followUpDue/.test(read('docs/pro/js/analytics-kpi.js')));
    ok('follow-up notifications use it (through followUpDue)', /P\.followUpDue\(l, today\.getTime\(\)\)/.test(read('docs/pro/js/crm-snooze.js')) && /!P\.isUnreachableKnock\(l\)/.test(read('docs/pro/js/crm-snooze.js')));
  }
  {
    const D2D = read('docs/pro/js/d2d-tracker-core-2026b.js');
    const FN = lift(D2D, 'convertToLead');
    async function convert(knock) {
      const saved = [];
      const store = { k1: { convertedToLead: false } };
      const win = {
        _db: {}, _user: { uid: 'u1' }, doc: (_d, c, id) => ({ id }), serverTimestamp: () => 'ts',
        updateDoc: async (r, d) => Object.assign(store[r.id], d),
        runTransaction: async (_d, fn) => fn({ get: async (r) => ({ exists: () => true, data: () => Object.assign({}, store[r.id]) }), update: (r, d) => Object.assign(store[r.id], d) }),
        _saveLead: async (data) => { saved.push(data); return 'lead-1'; }, showToast() {}, D2D: null,
      };
      const ctx = vm.createContext({
        window: win, state: { knocks: [Object.assign({ id: 'k1', convertedToLead: false, disposition: 'interested' }, knock)] },
        console: { error() {}, warn() {}, log() {} }, INS_DISPOSITIONS: [], DISPOSITIONS: {},
        loadKnocks: async () => {}, updateKnock: async () => {},
      });
      vm.runInContext(FN + '\nglobalThis.__cv = convertToLead;', ctx);
      await ctx.__cv('k1');
      return saved[0] || {};
    }
    const fup = new Date(2026, 9, 5);
    ok('no phone + auto follow-up → the lead gets NO follow-up', (await convert({ phone: '', followUpDate: fup, followUpSource: 'auto' })).followUp === '');
    ok('no phone + legacy knock (no source flag) → none either', (await convert({ phone: '' })).followUp === '');
    ok('no phone + a date the rep PICKED → kept', /^2026-10-0[45]$/.test((await convert({ phone: '', followUpDate: fup, followUpSource: 'manual' })).followUp));
    ok('with a phone → the disposition default still applies', /^\d{4}-\d{2}-\d{2}$/.test((await convert({ phone: '513-555-0101' })).followUp));
    ok('submitKnock records whether the date was picked or defaulted', /knockDoc\.followUpSource = fupInput \? 'manual' : 'auto';/.test(D2D));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\n5. past appointments still booked → "needs an outcome" (smart-calendar.js)');
  {
    const noop = () => {};
    const win = { addEventListener: noop, fetch: async () => { throw new Error('off'); }, sessionStorage: null, CSS: { escape: (s) => s } };
    const ctx = { window: win, document: { addEventListener: noop, getElementById: () => null }, console, setTimeout, clearTimeout, Date, Number, Math, JSON, Array, String, Set, Promise, isFinite, Error, Intl, Object };
    ctx.getComputedStyle = () => ({ display: 'none' });
    vm.createContext(ctx);
    vm.runInContext(read('docs/pro/js/smart-calendar.js'), ctx, { filename: 'smart-calendar.js' });
    const S = win.NBDSchedule;
    const now = new Date(2026, 9, 3, 15, 0).getTime();
    const at = (d, h) => new Date(2026, 9, d, h).getTime();
    ok('past + booked → needs an outcome', S.apptNeedsOutcome({ status: 'booked', startTime: at(3, 9), endTime: at(3, 10) }, now) === true);
    ok('past + rescheduled → needs an outcome', S.apptNeedsOutcome({ status: 'rescheduled', startTime: at(1, 9) }, now) === true);
    ok('future + booked → not yet', S.apptNeedsOutcome({ status: 'booked', startTime: at(3, 16), endTime: at(3, 17) }, now) === false);
    ok('in progress (ends later) → not yet', S.apptNeedsOutcome({ status: 'booked', startTime: at(3, 14), endTime: at(3, 16) }, now) === false);
    ok('cancelled / completed → no', S.apptNeedsOutcome({ status: 'cancelled', startTime: at(1, 9) }, now) === false
      && S.apptNeedsOutcome({ status: 'completed', startTime: at(1, 9) }, now) === false);
    ok('an outcome already recorded → no', S.apptNeedsOutcome({ status: 'booked', outcome: 'inspected', startTime: at(1, 9) }, now) === false);
    ok('Add-Event / job rows on the timeline are never flagged', S.apptNeedsOutcome({ status: 'event', startTime: at(1, 9) }, now) === false);
    const row = S.renderApptRow({ id: 'a1', title: 'Inspection', status: 'booked', startTime: Date.now() - 7200000, endTime: Date.now() - 3600000 });
    ok("today's agenda row carries the flag", /class="sc-outcome-chip">Needs an outcome</.test(row));
    const row2 = S.renderApptRow({ id: 'a2', title: 'Inspection', status: 'booked', startTime: Date.now() + 3600000, endTime: Date.now() + 7200000 });
    ok('…an upcoming one does not', !/sc-outcome-chip/.test(row2));
    // Past-days query: rep scope, the 14 days before today, only the ones needing an outcome.
    const calls = [];
    win._db = {};
    win.collection = (db, c) => c; win.where = (f, op, v) => ({ f, op, v }); win.orderBy = (f) => ({ orderBy: f });
    win.query = (c, ...p) => { calls.push({ c, p }); return p; };
    win.getDocs = async () => ({ forEach: (cb) => [
      { id: 'p1', data: () => ({ status: 'booked', startTime: at(1, 9), leadId: 'L9', title: '<b>Roof</b>' }) },
      { id: 'p2', data: () => ({ status: 'cancelled', startTime: at(1, 11) }) },
      { id: 'p3', data: () => ({ status: 'booked', outcome: 'no_show', startTime: at(2, 9) }) },
    ].forEach(cb) });
    const list = await S.fetchPastNeedingOutcome('u1', now);
    ok('past fetch keeps only booked-without-outcome', list.length === 1 && list[0].id === 'p1', JSON.stringify(list.map((a) => a.id)));
    const w = calls[0] && calls[0].p;
    ok('…scoped by userId (the read rule), before today, 14 days back (existing index shape)', calls[0] && calls[0].c === 'appointments'
      && w.some((x) => x.f === 'userId' && x.v === 'u1') && w.some((x) => x.f === 'startTime' && x.op === '<')
      && w.some((x) => x.f === 'startTime' && x.op === '>=' && Math.round((now - x.v.getTime()) / 86400000) >= 14));
    const html = S.renderNeedsOutcome(list);
    ok('the list says how many need an outcome and links the lead', /1 past appointment needs an outcome/.test(html) && /data-sc-id="L9"/.test(html));
    ok('…and escapes the title', /&lt;b&gt;Roof&lt;\/b&gt;/.test(html) && !/<b>Roof/.test(html));
  }
  ok('the customer timeline says "needs an outcome" too', /' · needs an outcome'/.test(read('docs/pro/js/customer-bootstrap.module.js')));

  // ══════════════════════════════════════════════════════════════════
  console.log('\n6. Thumbtack repeat request attaches to the existing lead (lead-bridge.js)');
  const BR = requireFn('lead-bridge.js');
  const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
  async function tt(db, sourceId, data) {
    _currentDb = db;
    await BR.leadBridgeThumbtack({ data: { data: () => data }, params: { leadId: sourceId } });
  }
  const leadsOf = (db) => [...db.store.entries()].filter(([k]) => /^leads\/[^/]+$/.test(k));
  {
    const db = makeDb();
    await db.collection('leads').doc('orig').set({ companyId: OWNER, userId: OWNER, phoneDigits: '5135550188', notes: 'First request', leadCost: 20, createdAt: 1 });
    await tt(db, 'tt-2', { firstName: 'Adam', phone: '513-555-0188', phoneDigits: '5135550188', notes: 'Thumbtack — Gutter Cleaning', leadPrice: '$15.50' });
    const all = leadsOf(db);
    ok('no second card for the same phone in the tenant', all.length === 1, all.map(([k]) => k).join(','));
    const o = db.store.get('leads/orig');
    ok('…the request is appended to the existing lead\'s notes', /First request/.test(o.notes) && /Repeat Thumbtack request/.test(o.notes) && /Gutter Cleaning/.test(o.notes));
    ok('…its id recorded', Array.isArray(o.externalLeadIds) && o.externalLeadIds[0] === 'tt-2');
    ok('…and the lead cost added (Thumbtack bills repeats)', o.leadCost === 35.5, String(o.leadCost));
    const notesLen = o.notes.length;
    await tt(db, 'tt-2', { firstName: 'Adam', phone: '513-555-0188', phoneDigits: '5135550188', notes: 'Thumbtack — Gutter Cleaning', leadPrice: '$15.50' });
    ok('a re-delivered trigger changes nothing', db.store.get('leads/orig').notes.length === notesLen && db.store.get('leads/orig').leadCost === 35.5 && leadsOf(db).length === 1);
  }
  {
    const db = makeDb();
    await tt(db, 'tt-3', { firstName: 'New', phone: '5135550199', phoneDigits: '5135550199', notes: 'x' });
    const all = leadsOf(db);
    ok('an unknown phone creates the lead as before', all.length === 1 && all[0][1].stage === 'new' && all[0][1].stageRole === 'new');
  }
  {
    const db = makeDb();
    await db.collection('leads').doc('other').set({ companyId: 'another-tenant', phoneDigits: '5135550177' });
    await db.collection('leads').doc('gone').set({ companyId: OWNER, phoneDigits: '5135550177', deleted: true });
    await tt(db, 'tt-4', { firstName: 'X', phone: '5135550177', phoneDigits: '5135550177', notes: 'y' });
    ok('a match in ANOTHER tenant or a deleted lead does not swallow the request', leadsOf(db).length === 3);
  }
  ok('website forms are not phone-deduped (Thumbtack only)', L.dedupesByPhone('contact_leads') === false && L.dedupesByPhone('thumbtack_leads') === true);

  // ══════════════════════════════════════════════════════════════════
  console.log('\n7. soft deletes stamp deletedAt');
  {
    const writes = [];
    const win = {
      db: {}, _user: { uid: 'u1' }, serverTimestamp: () => 'SERVER_TS',
      doc: (db, c, id) => c + '/' + id, updateDoc: async (ref, p) => { writes.push({ ref, p }); },
    };
    const sb = { window: win, console };
    vm.createContext(sb);
    vm.runInContext(read('docs/pro/js/repos.js'), sb);
    await win.NBDRepos.leads.softDelete('L1');
    await win.NBDRepos.estimates.softDelete('E1');
    ok('NBDRepos.leads.softDelete writes deleted + deletedAt', writes[0] && writes[0].p.deleted === true && writes[0].p.deletedAt === 'SERVER_TS', JSON.stringify(writes[0]));
    ok('NBDRepos.estimates.softDelete too', writes[1] && writes[1].p.deleted === true && writes[1].p.deletedAt === 'SERVER_TS');
  }
  {
    // Ratchet: every `deleted: true` WRITE in client + server code carries
    // deletedAt in the same object literal. Allowlisted: Stripe subscription
    // item ops (seats.js — a Stripe API flag, not a Firestore soft delete).
    const ALLOW = new Set(['functions/handlers/seats.js']);
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + '/' + e.name;
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'vendor') walk(rel); }
        else if (/\.(m?js)$/.test(e.name)) files.push(rel);
      }
    })('docs/pro/js');
    (function walk(dir) {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = dir + '/' + e.name;
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); }
        else if (/\.js$/.test(e.name)) files.push(rel);
      }
    })('functions');
    const offenders = [];
    let seen = 0;
    for (const rel of files) {
      if (ALLOW.has(rel)) continue;
      const src = read(rel).split('\n').map((ln) => ln.replace(/\/\/.*$/, '')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
      const re = /\bdeleted\s*:\s*true\b/g;
      let m;
      while ((m = re.exec(src))) {
        seen++;
        // the enclosing object literal: back to the nearest unmatched '{', forward to its '}'
        let depth = 0, a = m.index;
        for (; a > 0; a--) { if (src[a] === '}') depth++; else if (src[a] === '{') { if (depth === 0) break; depth--; } }
        depth = 0; let b = m.index;
        for (; b < src.length; b++) { if (src[b] === '{') depth++; else if (src[b] === '}') { if (depth === 0) break; depth--; } }
        const lit = src.slice(a, b + 1);
        if (!/deletedAt/.test(lit)) offenders.push(rel + ': ' + lit.replace(/\s+/g, ' ').slice(0, 90));
      }
    }
    ok('the scan sees the known soft-delete writes (positive control)', seen >= 5, 'seen=' + seen);
    ok('every `deleted: true` write carries deletedAt', offenders.length === 0, offenders.join(' | '));
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
