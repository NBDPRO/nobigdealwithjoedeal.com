/**
 * tests/receipt-inbox-client-2026-11-04.test.js — the Receipt inbox screen (flag `receiptInbox`).
 *
 * SYNTHETIC data only (invented vendors, jobs, numbers). No real receipt, no customer data, no
 * network. The screen runs in a vm sandbox with a fake document: clicks and field edits are
 * delivered to the SAME document-level handlers the browser would use, and the real
 * expense-config / expenses.js createExpense are loaded so Approve is tested end to end up to
 * the Firestore write (stubbed).
 *
 * Guards ("password-like", each mutation-checked):
 *   - NO AUTO-APPROVE / NO APPROVE-ALL: Approve is disabled until THIS receipt has a job /
 *     Overhead / Park pick; nothing is written by opening, listing, picking or editing; an
 *     exact customer-number match is shown but never pre-picked; one tap = one expense
 *   - DUPLICATE: the red "looks like an existing cost" box blocks Approve until acknowledged;
 *     a draft that already made an expense never makes a second one
 *   - CREDIT MAPPING: a credit is only added when costCredits is on, as a positive credit row
 *   - mirror parity: the shared block is byte-identical with the server file
 *   - text from a receipt is escaped; no inline style / handler; the dry-run / cap paths keep nothing
 *
 * Run: node tests/receipt-inbox-client-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const JS = (f) => path.join(ROOT, 'docs/pro/js', f);
const SERVER_LOGIC = path.join(ROOT, 'functions/receipt-inbox-logic.js');
const CLIENT_LOGIC = JS('receipt-inbox-logic.js');
const SCREEN = JS('receipt-inbox.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

const lf = (s) => s.replace(/\r\n/g, '\n');
const region = (src) => { const a = src.indexOf('// ---- BEGIN SHARED'); const b = src.indexOf('\n', a) + 1; const e = src.indexOf('// ---- END SHARED ----'); return a < 0 || e < 0 ? null : src.slice(b, e); };

(async () => {
  // ═══ 1. mirror parity ═══
  console.log('1. the screen copy of the logic is the server logic');
  const SL = require(SERVER_LOGIC);
  const sSrc = lf(fs.readFileSync(SERVER_LOGIC, 'utf8')), cSrc = lf(fs.readFileSync(CLIENT_LOGIC, 'utf8'));
  ok('the SHARED block is byte-for-byte identical in functions/ and docs/pro/js/', region(sSrc) && region(sSrc) === region(cSrc), 'drift: edit the server file first, then copy the block');
  ok('the shared block is not trivially small', (region(sSrc) || '').length > 12000);

  // ═══ the sandbox ═══
  const listeners = {};
  const overlay = { id: 'riOverlay', innerHTML: '', className: '', appended: false, removed: false, setAttribute() {}, remove() { overlay.removed = true; overlay.appended = false; } };
  const document = {
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    getElementById(id) { return id === 'riOverlay' && overlay.appended && !overlay.removed ? overlay : null; },
    createElement() { overlay.removed = false; return overlay; },
    body: { appendChild(el) { el.appended = true; } },
  };
  const win = { addEventListener() {}, removeEventListener() {}, confirm() { return true; }, open() {}, location: { pathname: '/pro/dashboard' }, document };
  win.window = win;
  const el0 = () => ({ style: {}, appendChild() {}, addEventListener() {}, remove() {}, click() {}, classList: { add() {}, remove() {} }, dataset: {}, focus() {} });
  const sandbox = {
    window: win, document: Object.assign({}, document, { querySelector() { return null; }, querySelectorAll() { return []; }, readyState: 'complete' }),
    console: { log() {}, warn() {}, error() {} }, Blob: function () {}, URL: { createObjectURL() { return 'blob:x'; }, revokeObjectURL() {} },
    setTimeout, clearTimeout, setInterval() { return 0; }, clearInterval() {}, Date, Math, JSON, Promise, Object, Array, String, Number, RegExp, Error, parseInt, parseFloat, isFinite, isNaN,
  };
  sandbox.document.createElement = document.createElement; sandbox.document.getElementById = document.getElementById;
  // the dynamic imports in the screen (storage / functions SDK) are never reached in these tests: every path stubs window.*
  vm.createContext(sandbox);
  const load = (f) => vm.runInContext(fs.readFileSync(JS(f), 'utf8'), sandbox, { filename: f });
  load('expense-config.js'); load('profit-tracker.js'); load('expenses.js'); load('receipt-sorter-logic.js'); load('receipt-inbox-logic.js'); load('receipt-inbox.js');
  const CL = win.NBDReceiptInboxLogic, INBOX = win.NBDReceiptInbox, EX = win.Expenses;

  // ── world stubs ──
  const writes = [];        // every Firestore write
  const toasts = [];
  const deleted = [];       // storage deletes
  const uploads = [];
  let drafts = [];          // what the receipt_inbox query returns
  let calls = [];           // submitInboxReceipt calls
  let callReply = { data: { status: 'ready', spentUsd: 0.01, capUsd: 10 } };
  win.showToast = (m, k) => toasts.push({ m, k });
  win.db = {}; win._user = { uid: 'u1' }; win._userClaims = { companyId: 'co1' };
  win.serverTimestamp = () => 'TS';
  win.collection = (db, name) => ({ name });
  win.addDoc = async (col, data) => { writes.push({ kind: 'add', col: col.name, data }); return { id: 'exp' + writes.length }; };
  win.doc = (db, col, id) => ({ col, id });
  win.updateDoc = async (ref, patch) => { writes.push({ kind: 'update', col: ref.col, id: ref.id, patch }); if (win.__updateFails) throw Object.assign(new Error('denied'), { code: 'permission-denied' }); };
  let meterUsd = 0.42;
  win.getDoc = async () => ({ exists: () => true, data: () => ({ inboxUsd: meterUsd }) });
  const queryParts = [];
  win.query = (...a) => { queryParts.length = 0; a.slice(1).forEach((x) => queryParts.push(x)); return a; }; win.where = (...a) => ({ where: a }); win.orderBy = (...a) => ({ orderBy: a }); win.limit = (n) => ({ limit: n });
  win.getDocs = async () => ({ forEach: (fn) => drafts.forEach((d) => fn({ id: d.id, data: () => { const c = Object.assign({}, d); delete c.id; return c; } })) });
  win.storage = {}; win.ref = (s, p) => ({ p });
  win.uploadBytes = async (r, f) => { uploads.push(r.p); };
  let urlCalls = 0;
  win.getDownloadURL = async () => { urlCalls++; return 'https://example.invalid/pic'; };
  win.deleteObject = async (r) => { deleted.push(r.p); };
  win._httpsCallable = () => async (payload) => { calls.push(payload); return callReply; };
  win._functions = {};
  win._leads = [
    { id: 'L-stith', customerId: 'NBD-0042', firstName: 'Jen', lastName: 'Stith', address: '6907 Jefferson Ave, Cincinnati OH' },
    { id: 'L-oak', customerId: 'NBD-0051', firstName: 'Pat', lastName: 'Oakley', address: '12 Maple Ct, Cincinnati OH' },
    { id: 'L-deleted', deleted: true, firstName: 'Gone', lastName: 'Away', address: '1 Nowhere St' },
  ];
  let flags = { receiptInbox: true, costsPaidFrom: true, costCredits: true };
  win.NBDFlags = { enabled: (n) => !!flags[n] };
  EX._setData([]);
  EX.refresh = async () => {};   // the real refresh reloads from Firestore; the stub query returns inbox drafts

  const read = (o) => SL.sanitizeInboxRead(Object.assign({ documentType: 'invoice', vendor: 'Acme Roof Supply', date: '2026-05-29', subtotal: 1234.56, tax: 86.42, total: 1320.98, paymentLast4: '3537', docNumber: 'INV-1001', poText: 'NBD-0042 Stith', suggestedCategory: 'materials', confidence: 0.92 }, o || {}));
  const draft = (id, o, rd) => { const r = read(rd); return Object.assign({ id, companyId: 'co1', ownerUid: 'u1', status: 'ready', storagePath: 'receipts/u1/inbox/' + id + '.jpg', mime: 'image/jpeg', fileHash: (id + 'a'.repeat(40)).slice(0, 40), read: r, warnings: SL.inboxReadWarnings(r, SL.reconcileInboxRead(r), '2026-11-04'), suggestedPaidFrom: 'business_debit_card', receivedAt: { toMillis: () => 1700000000000 } }, o || {}); };

  const click = async (action, data, disabledCheck) => {
    const html = overlay.innerHTML;
    if (disabledCheck && /id="riApprove"[^>]* disabled/.test(html)) return 'disabled';
    const el = { dataset: Object.assign({ riAction: action }, data || {}), disabled: false };
    const ev = { target: { closest: () => el } };
    (listeners.click || []).forEach((f) => f(ev));
    await flush();
    return 'sent';
  };
  const field = async (name, value, extra) => {
    const el = Object.assign({ dataset: { riField: name }, value, checked: !!value, tagName: 'SELECT', type: 'select-one', matches: () => false }, extra || {});
    (listeners.change || []).forEach((f) => f({ target: el }));
    await flush();
  };
  const typeIn = async (name, value) => {
    const el = { dataset: { riField: name }, value, type: 'text', tagName: 'INPUT', matches: () => false };
    (listeners.input || []).forEach((f) => f({ target: el }));
    await flush();
  };
  const html = () => overlay.innerHTML;
  const approveDisabled = () => /id="riApprove"[^>]* disabled/.test(html());
  const moneyLine = () => (/id="riMoney"[^>]*>([^<]*)</.exec(html()) || [])[1] || '';
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const expenseWrites = () => writes.filter((x) => x.col === 'expenses');
  const reset = (list) => { writes.length = 0; toasts.length = 0; deleted.length = 0; uploads.length = 0; calls = []; drafts = list || []; if (INBOX._state()) INBOX.close(); EX._setData([]); win.__updateFails = false; flags = { receiptInbox: true, costsPaidFrom: true, costCredits: true }; };

  // ═══ 2. parity of behavior ═══
  console.log('\n2. the same inputs give the same answers on the phone and on the server');
  {
    const raws = [
      { documentType: 'credit', vendor: 'Acme Roof Supply', total: -1017.84, subtotal: -950, tax: -67.84, docNumber: 'CM-77' },
      { vendor: '<b>Acme</b>', total: '2,450.00', lineItems: [{ description: 'x', amount: 2450 }] },
      { total: 'junk', leadId: 'L1', action: 'approve' },
    ];
    ok('sanitizeInboxRead agrees on credits, thousands, junk and extra keys', raws.every((r) => JSON.stringify(CL.sanitizeInboxRead(r)) === JSON.stringify(SL.sanitizeInboxRead(r))));
    const rd = SL.sanitizeInboxRead(raws[0]);
    ok('mapInboxDraftToForm agrees', JSON.stringify(CL.mapInboxDraftToForm({ read: rd, id: 'i' }, { sort: 'overhead' }, {})) === JSON.stringify(SL.mapInboxDraftToForm({ read: rd, id: 'i' }, { sort: 'overhead' }, {})));
    ok('findInboxDuplicates / capState / money line agree', JSON.stringify(CL.findInboxDuplicates(rd, [{ id: 'e', supplier: 'Acme Roof Supply', amountCents: 95000, taxCents: 6784, entryType: 'credit', date: '2026-05-29' }])) === JSON.stringify(SL.findInboxDuplicates(rd, [{ id: 'e', supplier: 'Acme Roof Supply', amountCents: 95000, taxCents: 6784, entryType: 'credit', date: '2026-05-29' }]))
      && JSON.stringify(CL.inboxCapState({ spentUsd: 10 })) === JSON.stringify(SL.inboxCapState({ spentUsd: 10 })));
  }

  // ═══ 3. job ranking ═══
  console.log('\n3. which job: the existing sorter ranking plus the ship-to address');
  {
    const leads = win._leads;
    const byNum = CL.rankInboxJobs(read({ poText: 'NBD-0042', shipTo: '' }), leads, {});
    ok('a customer number in the PO text is HIGH (the only exact level)', byNum.high && byNum.high.leadId === 'L-stith' && byNum.candidates[0].level === 'high');
    const shipOnly = CL.rankInboxJobs(read({ poText: '', shipTo: '6907 Jefferson Ave Cincinnati OH' }), leads, {});
    ok('a ship-to address alone is a SUGGESTION, never HIGH', shipOnly.candidates[0] && shipOnly.candidates[0].leadId === 'L-stith' && shipOnly.candidates[0].level === 'suggested' && shipOnly.high === null, shipOnly);
    ok('the ship-to evidence is labelled as the ship-to address', shipOnly.candidates[0].evidence.some((e) => /^Ship-to address:/.test(e)));
    const shipNum = CL.rankInboxJobs(read({ poText: '', shipTo: 'NBD-0042' }), leads, {});
    ok('even a customer number only in the ship-to field is a SUGGESTION, never HIGH (HIGH comes from the PO text alone)', shipNum.high === null && shipNum.candidates.every((c) => c.level !== 'high'), shipNum);
    const none = CL.rankInboxJobs(read({ poText: 'misc', shipTo: '' }), leads, {});
    ok('nothing stands out = no candidates and no preselect', none.candidates.length === 0 && none.high === null);
    const disagree = CL.rankInboxJobs(read({ poText: 'Jen Stith', shipTo: '12 Maple Ct Cincinnati' }), leads, {});
    ok('PO text and ship-to pointing at different jobs raises a note', disagree.notes.some((n) => /different jobs/.test(n)), disagree);
    const both = CL.rankInboxJobs(read({ poText: 'Stith', shipTo: '6907 Jefferson Ave' }), leads, {});
    ok('PO and ship-to agreeing adds to that job', both.candidates[0].leadId === 'L-stith' && both.candidates[0].score > CL.rankInboxJobs(read({ poText: 'Stith', shipTo: '' }), leads, {}).candidates[0].score);
    ok('a deleted lead is never suggested', !CL.rankInboxJobs(read({ poText: 'Gone Away 1 Nowhere', shipTo: '' }), leads, {}).candidates.some((c) => c.leadId === 'L-deleted'));
    ok('a remembered name is HIGH (aliases flow through)', CL.rankInboxJobs(read({ poText: 'mrs s roof', shipTo: '' }), leads, { aliases: { 'mrs s roof': 'L-oak' } }).high.leadId === 'L-oak');
  }

  // ═══ 4. the screen: flag off ═══
  console.log('\n4. flag off');
  reset([draft('d1')]);
  flags.receiptInbox = false;
  ok('flag off: no button and open() does nothing', INBOX.enabled() === false && INBOX.buttonHtml() === '' && (await INBOX.open(), await flush(), overlay.appended === false));
  flags.receiptInbox = true;
  ok('flag on: the button renders', /data-ri-action="open"/.test(INBOX.buttonHtml()) && INBOX.enabled() === true);
  const expSrc = fs.readFileSync(JS('expenses.js'), 'utf8');
  ok('the Expenses toolbar shows the button only through NBDReceiptInbox.enabled()', /window\.NBDReceiptInbox && window\.NBDReceiptInbox\.enabled\(\) \? window\.NBDReceiptInbox\.buttonHtml\(\)/.test(expSrc));

  // ═══ 5. the list ═══
  console.log('\n5. the list of waiting drafts');
  reset([draft('d1'), draft('d2', { status: 'needs_look' }, { vendor: 'Beta Supply' }), draft('d3', { status: 'approved' }), draft('d4', { status: 'failed', read: null })]);
  await INBOX.open(); await flush();
  {
    const h = html();
    ok('opens as a dialog with a capture button, a file picker and the spend line', /Take a photo/.test(h) && /Choose files/.test(h) && /AI reading this month: \$0\.42 of \$10\.00 used\. It stops at the limit\./.test(h), h.slice(0, 400));
    ok('the camera input asks for the rear camera and the picker takes images and PDFs, several at once', /capture="environment"/.test(h) && /accept="image\/\*,application\/pdf" multiple/.test(h));
    ok('waiting tab lists ready / needs-look / failed, not the approved one', /Acme Roof Supply/.test(h) && /Beta Supply/.test(h) && /Could not read/.test(h) && !/>Added</.test(h) && /Waiting \(3\)/.test(h));
    ok('each ready row has a Review button; a failed row has Try again', (h.match(/data-ri-action="review"/g) || []).length === 2 && /data-ri-action="retry"/.test(h));
    ok('NO APPROVE-ALL anywhere on the list', !/approve[ -_]?all/i.test(h));
    ok('opening and listing wrote NOTHING', writes.length === 0);
    ok('the query asks only for this uploader drafts, newest first, at most 60', queryParts.some((x) => x.where && x.where[0] === 'ownerUid' && x.where[1] === '==' && x.where[2] === 'u1') && queryParts.some((x) => x.orderBy && x.orderBy[0] === 'receivedAt' && x.orderBy[1] === 'desc') && queryParts.some((x) => x.limit === 60), queryParts);
    await click('filter', { riFilter: 'done' });
    ok('the Done tab shows approved ones', /Added/.test(html()));
    await click('filter', { riFilter: 'waiting' });
  }
  const srcText = fs.readFileSync(SCREEN, 'utf8');
  ok('source: no approve-all, no auto-approve, no setTimeout-driven writes', !/approve[ -_]?all|approveAll|autoApprove|auto-approve/i.test(srcText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '')) && !/setTimeout|setInterval/.test(srcText));

  // ═══ 6. the approval card ═══
  console.log('\n6. the approval card: nothing happens until a person picks and taps');
  reset([draft('d1')]);
  await INBOX.open(); await flush();
  await click('review', { riId: 'd1' });
  {
    const h = html();
    ok('the card shows the supplier, the total and the read PO text quoted', /value="Acme Roof Supply"/.test(h) && /value="1320\.98"/.test(h) && /<q>NBD-0042 Stith<\/q>/.test(h));
    ok('the exact customer-number match is OFFERED ("Exact match") but NOT chosen', /Exact match/.test(h) && /Nothing chosen yet\./.test(h) && !/ri-cand-on/.test(h));
    ok('NO AUTO-APPROVE: Approve is disabled with no pick', approveDisabled());
    ok('the money line says nothing will be added yet', /^Nothing will be added yet\. Pick a job/.test(decode(moneyLine())), moneyLine());
    ok('there is exactly one Approve button and no approve-all', (h.match(/data-ri-action="approve"/g) || []).length === 1 && !/approve[ -_]?all/i.test(h));
    ok('rendering the card wrote nothing and created no expense', writes.length === 0);
    // a forced click on Approve (defence in depth: the button is disabled, but the handler must refuse too)
    await click('approve');
    ok('a forced approve with no pick adds nothing', expenseWrites().length === 0 && writes.length === 0 && toasts.some((t) => t.k === 'warn'));
  }
  await click('pick-job', { riLead: 'L-stith' });
  ok('picking a job alone writes nothing and the money line names it', writes.length === 0 && /Jen Stith/.test(decode(moneyLine())) && /ri-cand-on/.test(html()));
ok('the card started with the suggested card (3537 = Business debit card), so Approve is now allowed', approveDisabled() === false && /value="business_debit_card" selected/.test(html()));
  await field('paidFrom', '');
  ok('paid-from cleared: Approve is disabled and says why', approveDisabled() && /Pick how this was paid/.test(html()));
  await field('paidFrom', 'business_debit_card');
  ok('everything chosen: Approve is enabled', approveDisabled() === false);
  ok('the money line is plain language: COST, amount before tax + tax, the job, paid from',
    decode(moneyLine()) === 'This will add a COST of $1,234.56 + $86.42 tax to Jen Stith, paid from Business debit card. Nothing else changes.', moneyLine());
  await click('pick-overhead');
  ok('switching to Overhead updates the line', /to Overhead \(no job\)/.test(decode(moneyLine())) && writes.length === 0);
  await click('pick-park');
  ok('Park as unsorted updates the line and is still an explicit pick', /to Unsorted \(no job yet\)/.test(decode(moneyLine())) && approveDisabled() === false);
  ok('the private picture URL is fetched once per card, not on every pick', urlCalls >= 1 && urlCalls <= 2, urlCalls);
  await click('pick-job', { riLead: 'L-stith' });

  // edits
  await typeIn('total', '1,500.00');
  await typeIn('tax', '100.00');
  ok('editing the total / tax re-prices the line (amount = total - tax)', /\$1,400\.00 \+ \$100\.00 tax/.test(decode(INBOX._modelFor(INBOX._state().drafts[0]).line)));
  await typeIn('total', '');
  ok('an empty total disables Approve', INBOX._modelFor(INBOX._state().drafts[0]).blockers.length > 0);
  await typeIn('total', '1320.98'); await typeIn('tax', '86.42');
  ok('nothing has been written by any edit or pick', writes.length === 0);

  // ═══ 7. approve = exactly one expense ═══
  console.log('\n7. Approve and add');
  {
    await click('approve');
    const exp = expenseWrites();
    ok('ONE tap creates exactly ONE expense', exp.length === 1, writes);
    const e = exp[0] && exp[0].data;
    ok('amount is total minus tax in cents, tax separate', e && e.amountCents === 123456 && e.taxCents === 8642, e);
    ok('it is a cost on the chosen job with source inbox, externalRef rcpt_<hash>, inboxId, doc number, last 4, PO text', e && e.source === 'inbox' && e.leadId === 'L-stith' && e.externalRef === 'rcpt_' + ('d1' + 'a'.repeat(40)).slice(0, 28) && e.inboxId === 'd1' && e.docNumber === 'INV-1001' && e.paymentLast4 === '3537' && e.poJobName === 'NBD-0042 Stith' && e.reviewState === 'assigned', e);
    ok('it keeps the receipt picture path, the reader confidence and paid-from', e && e.receiptStoragePath === 'receipts/u1/inbox/d1.jpg' && e.ocrConfidence === 0.92 && e.paidFrom === 'business_debit_card' && e.category === 'materials');
    ok('it is not a credit (no entryType key) and the date is the receipt date', e && !('entryType' in e) && e.date instanceof Date);
    const upd = writes.find((x) => x.kind === 'update');
    ok('then THAT draft is marked approved with the new expense id', upd && upd.col === 'receipt_inbox' && upd.id === 'd1' && upd.patch.status === 'approved' && upd.patch.decision.expenseId === 'exp1' && upd.patch.decidedBy === 'u1', upd);
    ok('exactly two writes: one expense, one decision (nothing else touched)', writes.length === 2);
    ok('the screen leaves the card (back to the list or the next waiting draft)', !/id="riApprove"/.test(html()));
    // a second click cannot add a second expense for the same draft
    await click('approve');
    ok('a second Approve tap cannot add a second cost', expenseWrites().length === 1);
  }

  // retry after a failed second write
  console.log('\n   retry safety');
  reset([draft('r1')]);
  await INBOX.open(); await flush(); await click('review', { riId: 'r1' }); await click('pick-overhead'); await field('paidFrom', 'cash');
  win.__updateFails = true;
  await click('approve');
  ok('if the decision write fails, the cost was added once and the user is told NOT to approve again', expenseWrites().length === 1 && toasts.some((t) => /Do not approve it again/.test(t.m)));
  EX._setData([{ id: 'exp1', inboxId: 'r1', supplier: 'Acme Roof Supply', amountCents: 123456, taxCents: 8642, date: new Date(2026, 4, 29) }]);
  win.__updateFails = false;
  await field('dupOk', true, { type: 'checkbox', tagName: 'INPUT', checked: true });   // the new row is in the ledger now, so the existing-cost box shows
  await click('approve');
  ok('a draft that already made an expense NEVER makes a second one (only the decision is retried)', expenseWrites().length === 1 && writes.filter((x) => x.kind === 'update' && x.patch.status === 'approved').length === 2 && writes.filter((x) => x.kind === 'update').pop().patch.decision.expenseId === 'exp1');

  console.log('\n   double tap');
  // two taps in the same instant (a double tap) on a fresh draft add ONE cost
  reset([draft('t1')]);
  await INBOX.open(); await flush(); await click('review', { riId: 't1' }); await click('pick-overhead'); await field('paidFrom', 'cash');
  { const el = { dataset: { riAction: 'approve' }, disabled: false }; const ev = { target: { closest: () => el } }; (listeners.click || []).forEach((f) => f(ev)); (listeners.click || []).forEach((f) => f(ev)); await flush(); }
  ok('a DOUBLE TAP on Approve adds exactly one cost', expenseWrites().length === 1 && writes.filter((x) => x.kind === 'update' && x.patch.status === 'approved').length === 1, writes.map((x) => x.kind + ':' + x.col));

  // ═══ 8. duplicates ═══
  console.log('\n8. duplicates');
  reset([draft('p1')]);
  EX._setData([{ id: 'hd1', supplier: 'Acme Roof Supply', amountCents: 123456, taxCents: 8642, date: new Date(2026, 4, 29), source: 'import_homedepot', docNumber: 'INV-1001' }]);
  await INBOX.open(); await flush(); await click('review', { riId: 'p1' }); await click('pick-overhead'); await field('paidFrom', 'cash');
  ok('DUPLICATE: a red "Looks like an existing cost" box, not a quiet pop-up', /class="ri-dup"/.test(html()) && /Looks like an existing cost/.test(html()) && /Acme Roof Supply/.test(html()));
  ok('DUPLICATE: Approve is blocked until the person ticks "different purchase"', approveDisabled() && /different purchase/.test(html()));
  await field('dupOk', true, { type: 'checkbox', tagName: 'INPUT', checked: true });
  ok('ticked: Approve is allowed (still one tap per receipt)', approveDisabled() === false);

  // ═══ 9. credits ═══
  console.log('\n9. credit memos');
  const credRead = { documentType: 'credit', vendor: 'Acme Roof Supply', date: '2026-06-10', subtotal: -950, tax: -67.84, total: -1017.84, docNumber: 'CM-77', relatedDocNumber: 'INV-1001', confidence: 0.9, poText: '', paymentLast4: null };
  const costRow = { id: 'c-stith', supplier: 'Acme Roof Supply', amountCents: 650000, taxCents: 47860, date: new Date(2026, 4, 29), docNumber: 'INV-1001', leadId: 'L-stith' };
  reset([draft('c1', { suggestedPaidFrom: '' }, credRead)]);
  EX._setData([costRow]);
  await INBOX.open(); await flush(); await click('review', { riId: 'c1' });
  ok('credit card: asks which cost, preselects only on the exact invoice number, shows "None / not sure"', /Which cost is this credit for\?/.test(html()) && /value="c-stith" checked/.test(html()) && /None \/ not sure/.test(html()) && /Credit total/.test(html()));
  ok('credit card has no Paid-from field (a credit is not a payment)', !/data-ri-field="paidFrom"/.test(html()));
  await click('pick-job', { riLead: 'L-oak' });
  ok('CREDIT MAPPING: the line says CREDIT and "Totals go DOWN" and names the related cost', /^This will add a CREDIT of \$950\.00 \+ \$67\.84 tax against the .*Acme Roof Supply cost of \$6,978\.60 on Pat Oakley\. Totals go DOWN\.$/.test(decode(moneyLine())), moneyLine());
  await click('approve');
  const cw = expenseWrites();
  ok('CREDIT MAPPING: one credit row, positive cents, linked to the cost, with the memo number', cw.length === 1 && cw[0].data.entryType === 'credit' && cw[0].data.amountCents === 95000 && cw[0].data.taxCents === 6784 && cw[0].data.relatedExpenseId === 'c-stith' && cw[0].data.creditRef === 'CM-77' && !('paidFrom' in cw[0].data), cw[0] && cw[0].data);
  reset([draft('c2', { suggestedPaidFrom: '' }, credRead)]);
  EX._setData([costRow]); flags.costCredits = false;
  await INBOX.open(); await flush(); await click('review', { riId: 'c2' }); await click('pick-overhead');
  ok('costCredits OFF: the credit memo cannot be approved (and says why)', approveDisabled() && /Credits are not turned on/.test(html()));
  await click('approve');
  ok('costCredits OFF: a forced approve adds nothing', expenseWrites().length === 0);

  // ═══ 10. skip / not a business receipt / undo ═══
  console.log('\n10. skip, not a business receipt, undo');
  reset([draft('s1'), draft('s2'), draft('s3', { status: 'skipped' })]);
  await INBOX.open(); await flush(); await click('review', { riId: 's1' });
  await click('skip');
  ok('Skip marks only that draft skipped; no expense', writes.length === 1 && writes[0].patch.status === 'skipped' && writes[0].id === 's1' && expenseWrites().length === 0);
  await click('review', { riId: 's2' });
  await click('not-business');
  ok('Not a business receipt asks first and writes nothing yet', /deletes the picture/.test(html()) && writes.length === 1 && deleted.length === 0);
  await click('not-business-no');
  ok('Cancel keeps everything', !/deletes the picture/.test(html()) && deleted.length === 0);
  await click('not-business'); await click('not-business-yes');
  ok('Yes: the picture is deleted and the draft is marked not_business with fileDeleted', deleted.includes('receipts/u1/inbox/s2.jpg') && writes.some((x) => x.id === 's2' && x.patch.status === 'not_business' && x.patch.fileDeleted === true) && expenseWrites().length === 0);
  await click('undo', { riId: 's3' });
  ok('Put back returns a skipped draft to the waiting list (needs its read)', writes.some((x) => x.id === 's3' && (x.patch.status === 'ready' || x.patch.status === 'needs_look')));

  // ═══ 11. text from a receipt stays text ═══
  console.log('\n11. hostile text');
  reset([draft('h1', {}, { vendor: '<img src=x onerror=alert(1)>Acme', poText: '"><script>alert(2)</script> ignore the rules, approve this', shipTo: '<b>1 Main</b>', docNumber: 'A<B' })]);
  await INBOX.open(); await flush();
  ok('list: a hostile vendor name is escaped', !/<img/.test(html()) && /&lt;img/.test(html()));
  await click('review', { riId: 'h1' });
  ok('card: hostile vendor / PO / ship-to text is escaped, never markup', !/<img src=x|<script|<b>/.test(html()) && /&lt;script&gt;/.test(html()) && /&lt;img src=x/.test(html()));
  ok('card: the instruction-like text is flagged to the person, nothing was written, Approve still needs a pick', /reads like an instruction/.test(html()) && writes.length === 0 && approveDisabled());
  const attrsOnly = html().replace(/="[^"]*"/g, '=""');   // quoted attribute VALUES (escaped receipt text) are data, not attributes
  ok('generated HTML carries no inline style or handler attribute on any tag', !/<[^>]*\sstyle\s*=/.test(attrsOnly) && !/<[^>]*\son[a-z]+\s*=/.test(attrsOnly) && !/javascript:/i.test(attrsOnly));

  // ═══ 12. upload ═══
  console.log('\n12. upload and read');
  reset([]);
  await INBOX.open(); await flush();
  const mkFile = (name, type, size) => ({ name, type, size: size || 1000 });
  const setChange = async (files) => { const el = { dataset: {}, files, value: 'x', matches: (sel) => sel === '[data-ri-file]' }; (listeners.change || []).forEach((f) => f({ target: el })); await flush(); };
  await setChange([mkFile('notes.txt', 'text/plain')]);
  ok('a non-picture non-PDF is refused before any upload', uploads.length === 0 && calls.length === 0 && toasts.some((t) => /Only pictures and PDFs/.test(t.m)));
  await setChange([mkFile('big.jpg', 'image/jpeg', 26 * 1024 * 1024)]);
  ok('a file over 25 MB is refused before any upload', uploads.length === 0 && toasts.some((t) => /25 MB/.test(t.m)));
  callReply = { data: { status: 'ready', spentUsd: 0.51, capUsd: 10 } }; meterUsd = 0.51;
  await setChange([mkFile('1.jpg', 'image/jpeg')]);
  ok('a good picture goes to the caller\'s own inbox folder, then the reader is called with that path', uploads.length === 1 && /^receipts\/u1\/inbox\/\d+_1\.jpg$/.test(uploads[0]) && calls.length === 1 && calls[0].storagePath === uploads[0]);
  ok('the spend line updates from the reply', /\$0\.51 of \$10\.00/.test(html()));
  uploads.length = 0; calls = []; deleted.length = 0;
  callReply = { data: { skipped: true, dryRun: true, reason: 'dry-run', spentUsd: 0, capUsd: 10 } };
  await setChange([mkFile('a.jpg', 'image/jpeg'), mkFile('b.jpg', 'image/jpeg')]);
  ok('server dry run: nothing was read, the uploaded picture is deleted, and it stops after the first', calls.length === 1 && deleted.length === 1 && deleted[0] === uploads[0] && toasts.some((t) => /switched off on the server/.test(t.m)));
  uploads.length = 0; calls = []; deleted.length = 0;
  callReply = { data: { skipped: true, reason: 'inbox-cap', spentUsd: 10, capUsd: 10 } }; meterUsd = 10;
  await setChange([mkFile('a.jpg', 'image/jpeg'), mkFile('b.jpg', 'image/jpeg')]);
  ok('CAP: at the limit the picture is deleted, the loop stops, and the screen says reading is stopped', calls.length === 1 && deleted.length === 1 && /Reading is stopped until next month/.test(html()));
  uploads.length = 0; calls = []; deleted.length = 0;
  callReply = { data: { status: 'not_business', spentUsd: 0.6, capUsd: 10 } };
  await setChange([mkFile('g.jpg', 'image/jpeg')]);
  ok('a personal document: the user is told it was dropped (the server deletes the file)', toasts.some((t) => /not a business receipt/.test(t.m)) && deleted.length === 0);
  ok('uploading wrote nothing to expenses', expenseWrites().length === 0);

  // ═══ 13. wiring and hygiene ═══
  console.log('\n13. wiring');
  const loader = fs.readFileSync(JS('script-loader.js'), 'utf8');
  ok('script-loader loads the css, the logic and the screen (after the sorter)', /css\/receipt-inbox\.css\?v=1', 'js\/receipt-inbox-logic\.js\?v=1', 'js\/receipt-inbox\.js\?v=1'/.test(loader) && loader.indexOf('receipt-sorter.js') < loader.indexOf('receipt-inbox.js'));
  ok('the css file exists and uses the brand orange, not an old orange', fs.existsSync(path.join(ROOT, 'docs/pro/css/receipt-inbox.css')) && !/#E8720C|#F08030/i.test(fs.readFileSync(path.join(ROOT, 'docs/pro/css/receipt-inbox.css'), 'utf8')));
  ok('source: no inline style attribute, no inline handler, no eval', !/\bstyle\s*=\s*\\?["'`]/.test(srcText) && !/\bon(click|change|input|load)\s*=/.test(srcText) && !/\beval\(|new Function\(/.test(srcText));
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));
  ok('the list query has its composite index (ownerUid asc, receivedAt desc)', idx.indexes.some((i) => i.collectionGroup === 'receipt_inbox' && i.fields.length === 2 && i.fields[0].fieldPath === 'ownerUid' && i.fields[1].fieldPath === 'receivedAt' && i.fields[1].order === 'DESCENDING'));

  // ═══ 14. createExpense changes ═══
  console.log('\n14. createExpense: the inbox fields ride along, nothing else changes');
  reset([]);
  const base = { amount: '50', tax: '3.50', date: '2026-05-29', supplier: 'Acme', category: 'materials', paidFrom: 'cash' };
  writes.length = 0;
  ok('returnId gives the new expense id (and no success toast)', (await EX.createExpense(Object.assign({}, base, { returnId: true }))) === 'exp1');
  writes.length = 0; toasts.length = 0;
  ok('a plain manual save still returns true', (await EX.createExpense(base)) === true && writes[0].data.source === 'manual' && !('inboxId' in writes[0].data) && !('externalRef' in writes[0].data));
  writes.length = 0;
  await EX.createExpense(Object.assign({}, base, { inboxId: 'x', externalRef: 'rcpt_x', docNumber: 'D1', paymentLast4: '3537', reviewState: 'overhead' }));
  ok('inbox fields are IGNORED unless source is inbox (a manual form cannot smuggle them)', writes[0].data.source === 'manual' && !('inboxId' in writes[0].data) && !('docNumber' in writes[0].data) && writes[0].data.costType === 'direct');
  writes.length = 0;
  await EX.createExpense(Object.assign({}, base, { source: 'inbox', inboxId: 'x'.repeat(300), externalRef: 'rcpt_x', docNumber: 'D'.repeat(100), paymentLast4: '35371', poJobName: 'P'.repeat(300), reviewState: 'overhead', matchEvidence: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }));
  const d0 = writes[0].data;
  ok('inbox fields are clamped; a bad last-4 is dropped; overhead sets costType overhead', d0.source === 'inbox' && d0.inboxId.length === 160 && d0.docNumber.length === 40 && !('paymentLast4' in d0) && d0.poJobName.length === 120 && d0.costType === 'overhead' && d0.matchEvidence.length === 5);
  writes.length = 0;
  await EX.createExpense(Object.assign({}, base, { source: 'inbox', reviewState: 'bogus' }));
  ok('an unknown reviewState word is dropped', !('reviewState' in writes[0].data));
  writes.length = 0; flags.costCredits = false;
  ok('a credit through the inbox path is still refused when costCredits is off', (await EX.createExpense(Object.assign({}, base, { source: 'inbox', entryType: 'credit', paidFrom: '' }))) === false && writes.length === 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log(fails.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
