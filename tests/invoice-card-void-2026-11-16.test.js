/**
 * tests/invoice-card-void-2026-11-16.test.js
 *
 * The customer page's Invoices & Payments card and the owner-side Void
 * (follow-ups from the 2026-11-15 live payment test, NBD-0378):
 *   A. Total Paid is the payment lines net of reversals (it was total -
 *      balanceDue: $400 paid on a $40 invoice read $40).
 *   B. A void invoice reads "void" (it read "draft") and offers no Mark Paid;
 *      the Void button shows only for the owner side, on an invoice with no
 *      money on it and no online pay link.
 *   C. The Record payment sheet shows a refused save IN the sheet and keeps
 *      what was typed (live: permission-denied left the sheet open, no error).
 *   D. voidInvoiceUI: what it refuses, what it writes; Reverse and Void
 *      repaint the customer card.
 *
 * Synthetic data only (ZZ_QA ids). NBD_TEST_ROOT runs it against another
 * checkout's docs/ (used to prove it fails on main).
 *
 * Run: node tests/invoice-card-void-2026-11-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.env.NBD_TEST_ROOT || path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 200; i++) { if (fn()) return true; await tick(); }
  throw new Error('timed out waiting for ' + what);
}

// ── A/B. the card, run for real (same harness as deposit-draft-2026-10-03) ──
async function renderCard(docs, claims, uid) {
  const src = read('docs/pro/js/customer-tasks-ui.js');
  const a = src.indexOf('window.loadInvoices = async function');
  const b = src.indexOf('\n};\n', a);
  const fnSrc = src.slice(a, b + 3);
  const el = { innerHTML: '' };
  const ctx = { console, document: { getElementById: (id) => (id === 'invoiceList' ? el : { innerHTML: '' }) }, window: {} };
  Object.assign(ctx.window, {
    auth: { currentUser: { uid: uid || 'zzqa-owner' } }, db: {}, _userClaims: claims || {},
    collection: () => ({}), query: () => ({}), where: () => ({}),
    getDocs: async () => ({ docs: docs.map((d) => ({ id: d.id, data: () => Object.assign({}, d) })) }),
    nbdTitleCount: () => {},
  });
  vm.createContext(ctx);
  vm.runInContext(fnSrc, ctx);
  await ctx.window.loadInvoices('zzqa-lead');
  return el.innerHTML;
}
const paidOf = (html) => (html.match(/Total Paid<\/div>\s*<div class="summary-value">\$([\d,.]+)/) || [])[1];
const at = '2026-11-15T12:00:00Z';

// ── C/D. invoice-pipeline.js through a tiny fake DOM (deposited-to-ui harness) ──
function makeNode(html) {
  const node = {
    _html: html || '', _kids: {}, value: '', checked: false, disabled: false, textContent: '', hidden: true,
    style: {}, dataset: {}, classList: { add() {}, remove() {} },
    remove() { node.removed = true; },
    addEventListener(type, fn) { if (type === 'click') node.onclick = fn; },
    removeEventListener() {}, setAttribute() {},
    querySelectorAll() { return []; },
    querySelector(sel) {
      const m = /^#([\w-]+)$/.exec(sel);
      if (!m || node._html.indexOf('id="' + m[1] + '"') < 0) return null;
      return node._kids[m[1]] || (node._kids[m[1]] = makeNode(''));
    },
  };
  return node;
}
const body = { kids: [], appendChild(el) { body.kids.push(el); }, contains(el) { return !el.removed; } };
global.document = {
  body,
  createElement() {
    const n = makeNode('');
    Object.defineProperty(n, 'innerHTML', { get() { return n._html; }, set(v) { n._html = String(v); } });
    return n;
  },
  getElementById(id) { return body.kids.find((k) => k.id === id && !k.removed) || null; },
  querySelectorAll() { return []; },
  addEventListener() {}, removeEventListener() {},
};
global.MutationObserver = function () { this.observe = () => {}; this.disconnect = () => {}; };
global.window = global.window || {};
const toasts = [];
global.showToast = (m, k) => toasts.push({ m, k });
const IP = require(path.join(ROOT, 'docs', 'pro', 'js', 'invoice-pipeline.js'));
// invoice-void.js holds the Void (loaded on first tap from the customer page).
const V = (() => { try { return require(path.join(ROOT, 'docs', 'pro', 'js', 'invoice-void.js')); } catch (e) { return {}; } })();

const docs = {};
const writes = [];
let writeError = null;
Object.assign(global.window, {
  _db: {}, _auth: { currentUser: { uid: 'zzqa-owner' } }, _user: { uid: 'zzqa-owner' }, _userClaims: {},
  collection: () => ({}), query: () => ({}), where: () => ({}),
  doc: (_db, col, id) => ({ path: col + '/' + id }),
  getDoc: async (ref) => ({ exists: () => ref.path in docs, data: () => docs[ref.path] }),
  getDocs: async () => ({ docs: [{ id: 'zzqa-inv', data: () => docs['invoices/zzqa-inv'] }] }),
  updateDoc: async (ref, data) => { if (writeError) throw writeError; writes.push({ path: ref.path, data }); },
  NBDFlags: { enabled: () => false, load: async () => {} },
});

(async () => {
  console.log('\nA. Total Paid = payment lines net of reversals');
  {
    const html = await renderCard([{ id: 'i1', leadId: 'zzqa-lead', status: 'paid', total: 40, balanceDue: 0, amountPaid: 400,
      payments: [{ amount: 400, at, method: 'cash' }] }]);
    ok('$400 recorded on a $40 invoice → Total Paid $400.00 (was capped at $40.00)', paidOf(html) === '400.00', 'paid=' + paidOf(html));
  }
  {
    const html = await renderCard([{ id: 'i1', leadId: 'zzqa-lead', status: 'sent', total: 40, balanceDue: 40, amountPaid: 0,
      payments: [{ amount: 400, at, method: 'cash' }, { amount: -400, at, method: 'cash' }, { amount: 40, at, method: 'cash' }, { amount: -40, at, method: 'cash' }] }]);
    ok('every payment reversed → Total Paid $0.00', paidOf(html) === '0.00', 'paid=' + paidOf(html));
  }
  {
    const html = await renderCard([{ id: 'i1', leadId: 'zzqa-lead', status: 'partial', total: 1000, balanceDue: 200, amountPaid: 300,
      payments: [{ amount: 500, at, method: 'check' }, { amount: -500, at, method: 'check' }, { amount: 300, at, method: 'zelle' }] }]);
    ok('a reversed $500 and a $300 → Total Paid $300.00 (the stale balanceDue said $800)', paidOf(html) === '300.00', 'paid=' + paidOf(html));
  }
  {
    const html = await renderCard([{ id: 'i1', leadId: 'zzqa-lead', status: 'paid', total: 900, balanceDue: 0 }]);
    ok('positive control: an older invoice with no payment lines keeps total − balanceDue ($900.00)', paidOf(html) === '900.00', 'paid=' + paidOf(html));
  }

  console.log('\nB. void status and the Void button');
  {
    const html = await renderCard([{ id: 'v1', leadId: 'zzqa-lead', status: 'void', total: 40, balanceDue: 40, payments: [] }]);
    ok('a void invoice reads "void", not "draft"', /class="invoice-status void">void</.test(html));
    ok('…and offers no Mark Paid', !/NBDCustomerInvoices\.markPaid" data-arg="v1"/.test(html));
  }
  const unpaid = { id: 'u1', leadId: 'zzqa-lead', status: 'sent', total: 40, balanceDue: 40, amountPaid: 0, payments: [] };
  const reversed = { id: 'r1', leadId: 'zzqa-lead', status: 'sent', total: 40, balanceDue: 40, amountPaid: 0,
    payments: [{ amount: 40, at, method: 'cash' }, { amount: -40, at, method: 'cash' }] };
  {
    const html = await renderCard([unpaid, reversed], {}, 'zzqa-owner');
    ok('solo owner: Void on an unpaid invoice', /data-action="NBDCustomerInvoices\.voidInvoice" data-arg="u1"/.test(html));
    ok('solo owner: Void on a fully reversed invoice', /data-action="NBDCustomerInvoices\.voidInvoice" data-arg="r1"/.test(html));
  }
  {
    const html = await renderCard([unpaid], { role: 'company_admin', companyId: 'zzqa-co' });
    ok('company_admin: Void shows', /NBDCustomerInvoices\.voidInvoice/.test(html));
  }
  {
    const html = await renderCard([unpaid], { role: 'sales_rep', companyId: 'zzqa-co' });
    ok('a rep sees no Void', !/NBDCustomerInvoices\.voidInvoice/.test(html));
  }
  {
    const html = await renderCard([
      Object.assign({}, unpaid, { id: 'p1', status: 'partial', amountPaid: 10, payments: [{ amount: 10, at, method: 'cash' }] }),
      Object.assign({}, unpaid, { id: 'l1', stripePaymentLink: 'https://buy.stripe.com/zzqa' }),
      Object.assign({}, unpaid, { id: 'b1', source: 'backfill' }),
    ]);
    ok('no Void with money on it, with a pay link, or on a backfill invoice', !/NBDCustomerInvoices\.voidInvoice/.test(html));
  }

  console.log('\nC. Record payment: a refused save is shown in the sheet');
  {
    docs['invoices/zzqa-inv'] = { leadId: 'zzqa-lead', total: 1000, amountPaid: 0, balanceDue: 1000, status: 'sent', payments: [] };
    docs['leads/zzqa-lead'] = { firstName: 'ZZ_QA', lastName: 'Lead' };
    body.kids.length = 0; toasts.length = 0; writes.length = 0;
    const err = new Error('Missing or insufficient permissions.'); err.code = 'permission-denied';
    writeError = err;
    let settled = false;
    const p = IP.recordPaymentUI('zzqa-lead').then((v) => { settled = true; return v; });
    await until(() => body.kids.some((k) => k.id === 'nbd-recordpay-modal'), 'record sheet');
    const overlay = body.kids.find((k) => k.id === 'nbd-recordpay-modal');
    const q = (s) => overlay.querySelector(s);
    q('#nbd-rp-amount').value = '400';
    q('#nbd-rp-date').value = IP.localDateInputValue(new Date());
    await q('#nbd-rp-save').onclick();
    for (let i = 0; i < 20; i++) await tick();
    const box = q('#nbd-rp-err');
    ok('the sheet has an error box (role=alert)', /id="nbd-rp-err"[^>]*role="alert"/.test(overlay._html));
    ok('…it shows a plain "refused (no permission)" message', !!box && box.hidden === false && /refused \(no permission\)/.test(box.textContent || ''), box && box.textContent);
    ok('…the sheet stays open with the amount kept, and Save works again',
      !settled && !overlay.removed && q('#nbd-rp-amount').value === '400' && q('#nbd-rp-save').disabled === false);
    ok('…nothing was written', writes.length === 0);
    writeError = null;
    q('#nbd-rp-cancel').onclick();
    await p;
  }

  console.log('\nD. voidInvoiceUI');
  ok('blocked: money recorded', /reverse its payments/.test(V.voidBlockedReason({ status: 'partial', payments: [{ amount: 10 }], amountPaid: 10 })));
  ok('blocked: paid', /paid/.test(V.voidBlockedReason({ status: 'paid' })));
  ok('blocked: online pay link', /online payment link/.test(V.voidBlockedReason({ status: 'sent', stripePaymentLink: 'x' })));
  ok('blocked: backfill / supplements / already void',
    !!V.voidBlockedReason({ status: 'sent', source: 'backfill' }) && !!V.voidBlockedReason({ status: 'sent', supplementIds: ['s'] })
    && !!V.voidBlockedReason({ status: 'void' }) && !!V.voidBlockedReason({ status: 'sent', deleted: true }));
  ok('allowed: unpaid, and fully reversed',
    V.voidBlockedReason({ status: 'sent', payments: [] }) === ''
    && V.voidBlockedReason({ status: 'sent', amountPaid: 0, payments: [{ amount: 40 }, { amount: -40 }] }) === '');
  {
    docs['invoices/zzqa-v'] = { leadId: 'zzqa-lead', total: 40, balanceDue: 40, amountPaid: 0, status: 'sent',
      payments: [{ amount: 40, at, method: 'cash' }, { amount: -40, at, method: 'cash' }] };
    writes.length = 0;
    global.window._customerId = 'zzqa-lead';
    global.window.nbdConfirm = async () => true;

    global.window.nbdPrompt = async () => '';
    let r = await V.voidInvoiceUI('zzqa-v');
    ok('no reason → nothing written', r === false && writes.length === 0);

    global.window._userClaims = { role: 'sales_rep', companyId: 'zzqa-co' };
    global.window.nbdPrompt = async () => 'test invoice';
    r = await V.voidInvoiceUI('zzqa-v');
    ok('a rep is refused, nothing written', r === false && writes.length === 0);
    global.window._userClaims = {};

    r = await V.voidInvoiceUI('zzqa-v');
    const w = writes[0] && writes[0].data;
    ok('owner, fully reversed invoice: writes status void + the reason + who', r === true && writes.length === 1
      && w.status === 'void' && w.voidNote === 'test invoice' && w.voidedBy === 'zzqa-owner' && w.voidedAt instanceof Date,
      JSON.stringify(w));
    ok('…and touches no money field', w && !['payments', 'amountPaid', 'balanceDue', 'total', 'deleted', 'paidAt'].some((k) => k in w));
    await tick();

    docs['invoices/zzqa-p'] = { leadId: 'zzqa-lead', total: 40, balanceDue: 0, amountPaid: 40, status: 'paid', payments: [{ amount: 40, at, method: 'cash' }] };
    writes.length = 0;
    r = await V.voidInvoiceUI('zzqa-p');
    ok('a paid invoice is refused, nothing written', r === false && writes.length === 0);
  }
  {
    const src = read('docs/pro/js/invoice-pipeline.js');
    const fn = src.slice(src.indexOf('async function reversePaymentUI'), src.indexOf('async function reversePaymentUI') + 6000);
    ok('Reverse repaints the customer card after a confirmed reversal',
      /out\.ok !== true[\s\S]*_refreshCustomerInvoices\(\);\s*\n\s*return true;/.test(fn));
  }

  {
    const ct = read('docs/pro/js/customer-tasks-ui.js');
    const h = ct.slice(ct.indexOf('voidInvoice: async function'), ct.indexOf('voidInvoice: async function') + 1200);
    ok('the card\'s Void loads invoice-void.js on first tap, calls voidInvoiceUI, then repaints the card',
      /ScriptLoader\.load\('js\/invoice-void\.js\?v=\d+'\)/.test(h) && /NBDInvoiceVoid\.voidInvoiceUI\(invoiceId\)/.test(h)
      && /if \(done && typeof reload === 'function' && window\._customerId\) await reload\(window\._customerId\)/.test(h));
    ok('invoice-void.js is not loaded at boot on the dashboard', !/invoice-void\.js/.test(read('docs/pro/dashboard.html')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
