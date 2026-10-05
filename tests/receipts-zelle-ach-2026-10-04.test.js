/**
 * receipts-zelle-ach-2026-10-04.test.js — Jo's three money decisions, 2026-10-04.
 *
 *   1. RECEIPTS: draft it, one-click send. Marking a payment paid never
 *      emails the customer from any caller (markPaid, Record payment, the
 *      Stripe webhook). Each payment carries a receipt DRAFT; "Send receipt"
 *      (invoice row, timeline line, invoice detail) sends ONE email through
 *      NBDComms.sendEmail with leadId + invoiceId — which the server's #2120
 *      recipient binding (email-send-guard.js) accepts — or the share sheet.
 *      The receipt names the NBD invoice number, never the doc id.
 *   2. ZELLE goes to (859) 420-7382 or jd@nobigdealwithjoedeal.com, NOT
 *      info@ — while the documents email stays info@. brand.contact.zelle*
 *      on the company profile; other tenants fall back to what they did.
 *   3. ACH: us_bank_account offered on every homeowner pay surface (stepping
 *      down when Stripe refuses it — Jo has not switched it on yet);
 *      processing is not revenue; a failed bank debit reverts the payment
 *      and alerts Jo, internally, once. The Kentucky hold still blocks.
 *
 * Every send primitive is a capturing fake (Resend rejects example.com —
 * the addresses here are delivered@resend.dev or never leave the fakes).
 * Run: node tests/receipts-zelle-ach-2026-10-04.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const lf = (s) => s.replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
function req(p) {
  try { return require(path.join(ROOT, p)); }
  catch (e) { ok('loads ' + p, false, e && e.message); return null; }
}

const IP = req('docs/pro/js/invoice-pipeline.js');
const JB = req('docs/pro/js/ky-insurance-law.js');
const J = req('functions/ky-insurance-law.js');
const ZC = req('functions/zelle-contact.js');
const ACH = req('functions/ach-payments.js');
const SCI = req('functions/stripe-crm-invoice.js');
const GUARD = req('functions/email-send-guard.js');
const REM = req('docs/pro/js/invoice-reminder.js');

const NOW = Date.parse('2026-10-04T15:00:00Z');
const OH = '12 Main St, Milford, OH 45150';
const KY = '9 Dixie Hwy, Florence, KY 41042';
const ohLead = { id: 'L1', userId: 'u1', companyId: 'u1', address: OH, jobType: 'cash', firstName: 'Pat', email: 'delivered@resend.dev' };
const kyLeadHeld = { id: 'L1', userId: 'u1', companyId: 'u1', address: KY, jobType: 'insurance', claimNumber: 'C-1', firstName: 'Kay' };
const EMAIL = 'delivered@resend.dev';

// ── browser fakes (invoice-pipeline.js reads window.*) ──────────────────
function browser(seed, extra) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const emails = [], sms = [], shares = [], updates = [];
  const W = {
    _db: { fake: true },
    doc: (db, c, id) => ({ path: c + '/' + id, id }),
    collection: (db, c) => ({ col: c }),
    where: (f, op, v) => ({ f, op, v }),
    query: (c, ...ws) => ({ col: c.col, ws }),
    getDoc: async (r) => ({ exists: () => store.has(r.path), data: () => JSON.parse(JSON.stringify(store.get(r.path))) }),
    getDocs: async (q) => {
      const docs = [];
      for (const [k, v] of store) {
        const [c, id] = k.split('/');
        if (c !== q.col || k.split('/').length !== 2) continue;
        if ((q.ws || []).every((w) => v[w.f] === w.v)) docs.push({ id, data: () => JSON.parse(JSON.stringify(v)) });
      }
      return { empty: !docs.length, size: docs.length, docs, forEach: (f) => docs.forEach(f) };
    },
    updateDoc: async (r, patch) => { if (!store.has(r.path)) throw new Error('NOT_FOUND'); updates.push([r.path, patch]); store.set(r.path, Object.assign({}, store.get(r.path), JSON.parse(JSON.stringify(patch)))); },
    addDoc: async (c, data) => { const id = 'new' + store.size; store.set(c.col + '/' + id, JSON.parse(JSON.stringify(data))); return { id }; },
    setDoc: async (r, data) => { store.set(r.path, JSON.parse(JSON.stringify(data))); },
    NBDComms: {
      sendSMS: async (o) => { sms.push(o); return { success: true }; },
      sendEmail: async (o) => { emails.push(o); return { success: true, mode: 'platform' }; },
    },
    NBDJurisdiction: JB,
    NBDDepositRule: req('docs/pro/js/deposit-rule.js'),
    _auth: { currentUser: { uid: 'u1', getIdToken: async () => 'tok' } },
    _user: { uid: 'u1' },
    _userClaims: {},
    _leads: [ohLead],
    __nbdInvoiceLockTimeoutMs: 5,
    showToast: () => {},
  };
  Object.assign(W, extra || {});
  global.window = W;
  global.showToast = () => {};
  global.fetch = async () => ({ ok: true, json: async () => ({}) });
  return { W, store, emails, sms, shares, updates };
}

// ── server fakes (admin-SDK shaped) ─────────────────────────────────────
function serverDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const get = (o, f) => f.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    async get() { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : clone(d)), ref: ref(p) }; },
    async update(patch) { store.set(p, Object.assign({}, store.get(p), clone(patch))); },
    async create(data) { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, clone(data)); },
  });
  const query = (c, filters, lim) => ({
    where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim),
    limit: (n) => query(c, filters, n),
    async get() {
      const docs = [];
      for (const [k, v] of store) {
        const parts = k.split('/');
        if (parts.length !== 2 || parts[0] !== c) continue;
        const pass = filters.every(([f, op, val]) => {
          const x = get(v, f);
          if (op === 'array-contains') return Array.isArray(x) && x.indexOf(val) !== -1;
          return x === val;
        });
        if (pass) docs.push({ id: parts[1], ref: ref(k), data: () => clone(v) });
      }
      const out = docs.slice(0, lim || docs.length);
      return { empty: !out.length, docs: out };
    },
  });
  return {
    store,
    collection: (c) => Object.assign({ doc: (id) => ref(c + '/' + id) }, query(c, [], 0)),
    async runTransaction(fn) {
      const pending = [];
      const tx = { get: (r) => r.get(), update: (r, p) => pending.push(() => store.set(r.path, Object.assign({}, store.get(r.path), clone(p)))) };
      const out = await fn(tx);
      pending.forEach((f) => f());
      return out;
    },
  };
}

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\n1a. No auto-send on any path');
  if (IP) {
    const inv = { leadId: 'L1', createdBy: 'u1', status: 'sent', total: 9240, amountPaid: 0, balanceDue: 9240, customerEmail: EMAIL };
    let B = browser({ 'invoices/i1': inv });
    const r = await IP.markPaid('i1', '4000', 'zelle', { at: new Date(NOW), paymentId: 'mp_z1' });
    ok('markPaid with a customer email on file → NO email', B.emails.length === 0);
    ok('…the payment carries a receipt DRAFT', B.store.get('invoices/i1').payments[0]?.receipt?.status === 'draft' && r && r.receipt === 'draft');
    B = browser({ 'invoices/i2': inv });
    await IP.markPaid('i2', '100', 'cash', { at: new Date(NOW), sendReceipt: true });
    ok('markPaid with the old sendReceipt:true → still NO email', B.emails.length === 0);
    B = browser({ 'leads/L1': ohLead, 'invoices/i3': Object.assign({ jobId: null }, inv) });
    await IP.recordPaymentCommit({ leadId: 'L1', lead: ohLead, target: IP.recordPaymentTarget({ lead: ohLead, invoices: [{ id: 'i3', status: 'sent', total: 9240 }] }),
      amount: '500', method: 'check', payer: 'homeowner', at: new Date(NOW), reference: '77', sendReceipt: true });
    ok('Record payment (even sendReceipt:true) → NO email, receipt drafted', B.emails.length === 0 && B.store.get('invoices/i3').payments[0]?.receipt?.status === 'draft');
    const sheet = lf(read('docs/pro/js/invoice-pipeline.js')).split('async function recordPaymentUI')[1].split('// ═══')[0];
    ok('the sheet\'s "Email a receipt" checkbox is gone', !/nbd-rp-receipt/.test(sheet) && !/Email a receipt/.test(sheet));
  }
  {
    // The Stripe webhook credits payments[] and sends the customer nothing:
    // the credit block never touches customerEmail / Resend / sendEmail.
    const st = lf(read('functions/stripe.js'));
    const a = st.indexOf("if (event.type === 'payment_intent.succeeded') {", st.indexOf('exports.invoiceWebhook'));
    const b = st.indexOf("} else if (event.type === 'charge.dispute.created'", a);
    const credit = (a > 0 && b > a) ? st.slice(a, b) : '';
    ok('Stripe webhook payment credit: no customer email of any kind', !!credit && !/customerEmail|Resend|sendEmail|email_queue/.test(credit));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n1b. Receipt draft → one-tap send through the bound email path');
  if (IP && IP.receiptStateOf) {
    ok('a Stripe-webhook payment (no receipt field) reads as a draft', IP.receiptStateOf({ amount: 50, method: 'stripe', paymentIntentId: 'pi_1' }) === 'draft');
    ok('a sent one reads sent; nothing to receipt for $0', IP.receiptStateOf({ amount: 5, receipt: { status: 'sent' } }) === 'sent' && IP.receiptStateOf({ amount: 0 }) === 'none');
    const inv = {
      leadId: 'L1', createdBy: 'u1', status: 'partial', total: 9240, amountPaid: 4000, balanceDue: 5240, customerEmail: EMAIL,
      paper: { invoice: { instanceId: 'NBD-2026-1004-0003' } },
      payments: [{ amount: 4000, method: 'zelle', at: '2026-10-02T16:00:00Z', paymentId: 'mp_z1', reference: 'ZX9', receipt: { status: 'draft' } }],
    };
    const B = browser({ 'invoices/inv_doc_9f3a': inv, 'notes/pay-inv_doc_9f3a-mp_z1': { leadId: 'L1', type: 'payment' } });
    const res = await IP.sendReceipt('inv_doc_9f3a', 'mp_z1');
    ok('one tap → exactly ONE email', res.sent === true && B.emails.length === 1, JSON.stringify(res));
    const e = B.emails[0] || {};
    ok('…to the invoice\'s customer email, kind receipt, naming leadId + invoiceId (#2120 binding)',
      e.to === EMAIL && e.kind === 'receipt' && e.leadId === 'L1' && e.invoiceId === 'inv_doc_9f3a');
    ok('…the server\'s recipient binding accepts it (email-send-guard.recipientOnRecord)',
      !!GUARD && GUARD.recipientOnRecord(e.to, ohLead, inv) === true);
    ok('…subject + body name the NBD invoice number, never the internal doc id',
      /NBD-2026-1004-0003/.test(e.subject) && /NBD-2026-1004-0003/.test(e.html) && !/inv_doc_9f3a/.test(e.subject + e.html));
    ok('…amount paid, method, date, balance remaining',
      /\$4,000\.00/.test(e.html) && /Zelle #ZX9/.test(e.html) && /October 2, 2026/.test(e.html) && /\$5,240\.00/.test(e.html), e.html);
    ok('…the receipt is marked sent on the payment and its timeline line',
      B.store.get('invoices/inv_doc_9f3a').payments[0]?.receipt?.status === 'sent' && !!B.store.get('notes/pay-inv_doc_9f3a-mp_z1').receiptSentAt);
    const again = await IP.sendReceipt('inv_doc_9f3a', 'mp_z1');
    ok('a second tap sends nothing (already sent)', again.sent === false && again.reason === 'already_sent' && B.emails.length === 1);

    // No email on file → the share sheet, with the filed NBD-510 PDF.
    const paidInv = {
      leadId: 'L1', createdBy: 'u1', status: 'paid', total: 1000, amountPaid: 1000, balanceDue: 0,
      paper: { receipt: { state: 'filed', pdfPath: 'documents/u1/L1/NBD-2026-1004-0009.pdf', instanceId: 'NBD-2026-1004-0009' } },
      payments: [{ amount: 1000, method: 'check', at: '2026-10-03T16:00:00Z', paymentId: 'mp_c1' }],
    };
    const shared = [];
    const B2 = browser({ 'invoices/p1': paidInv }, {
      getDownloadURL: async () => 'https://storage.test/r.pdf', ref: (s, p) => ({ p }), storage: {},
    });
    global.fetch = async () => ({ ok: true, blob: async () => new Blob(['%PDF'], { type: 'application/pdf' }) });
    Object.defineProperty(global, 'navigator', { configurable: true, value: { share: async (d) => { shared.push(d); }, canShare: () => true } });
    const d = IP.receiptDetailsOf(paidInv, 'mp_c1');
    ok('the paid-in-full payment\'s receipt carries the filed NBD-510 PDF', d && d.pdfPath === 'documents/u1/L1/NBD-2026-1004-0009.pdf' && d.paidInFull === true);
    const r2 = await IP.sendReceipt('p1', 'mp_c1');
    ok('no email on file → share sheet (with the PDF), no email', r2.sent === true && r2.via === 'share' && B2.emails.length === 0 && shared.length === 1
      && shared[0].files && shared[0].files[0].name === 'Receipt NBD-2026-1004-0009.pdf');
    delete global.navigator;
  } else {
    ok('invoice-pipeline.js exports the receipt draft + one-tap send (receiptStateOf, sendReceipt)', false);
  }
  {
    // The three surfaces carry the tap.
    const ct = lf(read('docs/pro/js/customer-tasks-ui.js'));
    const cb = lf(read('docs/pro/js/customer-bootstrap.module.js'));
    const ip = lf(read('docs/pro/js/invoice-pipeline.js'));
    ok('customer page invoice row: Send receipt per drafted payment', /data-action="NBDCustomerInvoices\.sendReceipt" data-arg="' \+ esc\(inv\.id\) \+ '" data-arg2="' \+ esc\(r\.key\)/.test(ct) && /sendReceipt: async function \(invoiceId, key\)/.test(ct));
    ok('payment timeline line: Send receipt until sent', /data-action="NBDCustomerInvoices\.sendReceipt" data-arg="\$\{esc\(item\.receipt\.invoiceId\)\}"/.test(cb) && /!n\.receiptSentAt/.test(cb));
    ok('invoice detail Payment History: Send receipt → sendReceiptUI', /data-ip-action="sendReceipt"/.test(ip) && /case 'sendReceipt':[\s\S]{0,160}IP\.sendReceiptUI\(id, key\)/.test(ip));
    ok('role gate: a viewer cannot send a receipt', /'NBDCustomerInvoices\.sendReceipt'/.test(read('docs/pro/js/role-gate.js')) && /\[data-ip-action="sendReceipt"\]/.test(read('docs/pro/js/role-gate.js')));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n2. Zelle → (859) 420-7382 or jd@ — the documents email stays info@');
  if (ZC) {
    const OWNER = ZC.NBD_OWNER_UID;
    const nbd = ZC.zelleContactOf(null, OWNER);
    ok('server: NBD Zelle = (859) 420-7382 or jd@', nbd.text === '(859) 420-7382 or jd@nobigdealwithjoedeal.com');
    // NBD-only is decided by the NBD companyId, never by brand strings: a
    // tenant that never set legalName looks exactly like NBD by brand.
    ok('server: an NBD-looking brand from ANOTHER companyId → no Zelle (Jo\'s pair never on another tenant\'s invoice)',
      ZC.zelleContactOf(null, 'co_other').text === '' && ZC.zelleContactOf({ contact: { email: 'x@y.com' } }, 'co_other').text === ''
      && ZC.zelleContactOf({ legalName: 'No Big Deal Home Solutions' }, 'co_other').text === '');
    ok('server: no companyId → no NBD default (fail closed)', ZC.zelleContactOf(null).text === '' && ZC.zelleContactOf(null, '').text === '' && ZC.zelleContactOf({}, undefined).text === '');
    ok('server: a tenant with none set → empty (its surfaces keep their old behaviour)', ZC.zelleContactOf({ legalName: 'Oaks Roofing', contact: { email: 'joe@oaksrfc.com' } }, 'co_oaks').text === '');
    ok('server: a tenant\'s own pair wins', ZC.zelleContactOf({ legalName: 'Oaks Roofing', contact: { zellePhone: '(513) 555-0100' } }, 'co_oaks').text === '(513) 555-0100');
  }
  {
    // company-profile.js (browser): NBD defaults; documents email untouched.
    const src = read('docs/pro/js/company-profile.js');
    const st = {};
    const ls = { getItem: (k) => (k in st ? st[k] : null), setItem: (k, v) => { st[k] = String(v); }, removeItem: (k) => { delete st[k]; } };
    const win = { addEventListener() {}, removeEventListener() {}, localStorage: ls };
    win.window = win;
    vm.runInNewContext(src, { window: win, localStorage: ls, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON }, { filename: 'company-profile.js' });
    const OWNER_UID = '1phDvAVXHSg82wDLegAbQFq14Ci1';
    ok('company profile: identity unknown → not the NBD platform tenant (fail closed)', win._isNbdPlatformTenant() === false);
    win._userClaims = { companyId: 'co_unprovisioned' };
    const bx = win._brand();
    // A tenant that never set legalName looks like NBD by brand and carries
    // NBD's merged defaults — the Zelle consumers must still print nothing.
    ok('company profile: an unprovisioned tenant (NBD-looking brand) is NOT the platform tenant', win._isNbdPlatformTenant() === false);
    if (IP) ok('browser: that tenant\'s Zelle text is empty even though its brand carries NBD\'s defaults',
      bx.contact.zelleEmail === 'jd@nobigdealwithjoedeal.com' && IP.zelleTextFor(bx, win._isNbdPlatformTenant()) === '');
    win._userClaims = { companyId: OWNER_UID, user_id: 'someone-else' };
    win._user = { uid: 'me' };
    ok('company profile: claims read for a different account never make you NBD', win._isNbdPlatformTenant() === false);
    win._user = null;
    win._userClaims = { companyId: OWNER_UID };
    const b = win._brand();
    ok('company profile: _isNbdPlatformTenant is the NBD companyId', win._isNbdPlatformTenant() === true);
    ok('company profile: NBD zelleEmail jd@ + zellePhone (859) 420-7382', b.contact.zelleEmail === 'jd@nobigdealwithjoedeal.com' && b.contact.zellePhone === '(859) 420-7382');
    ok('company profile: the documents email is STILL info@', b.contact.email === 'info@nobigdealwithjoedeal.com');
    await win._saveCompanyProfile({ brand: { legalName: 'Oaks Roofing & Construction', contact: { email: 'joe@oaksrfc.com' } } });
    const ob = win._brand();
    ok('company profile: another tenant never inherits NBD\'s Zelle', ob.contact.zelleEmail === '' && ob.contact.zellePhone === '');
    if (IP) ok('browser Zelle text agrees with the server (NBD + tenant)', typeof IP.zelleTextFor === 'function' && IP.zelleTextFor(b, win._isNbdPlatformTenant()) === ZC.zelleContactOf(null, ZC.NBD_OWNER_UID).text && IP.zelleTextFor(ob, win._isNbdPlatformTenant()) === '');
    if (IP) ok('browser zelleTextFor: NBD defaults only for the platform tenant',
      IP.zelleTextFor(null, true) === ZC.zelleContactOf(null, ZC.NBD_OWNER_UID).text
      && IP.zelleTextFor(null, false) === '' && IP.zelleTextFor({ contact: {} }, false) === ''
      && IP.zelleTextFor(null) === '' /* no identity helper loaded → fail closed */);
  }
  if (SCI) {
    ok('Stripe invoice footer: Zelle to (859) 420-7382 or jd@, never info@', /Zelle to \(859\) 420-7382 or jd@nobigdealwithjoedeal\.com/.test(SCI.FOOTER) && !/info@/.test(SCI.FOOTER));
  }
  if (IP && typeof IP.zelleTextFor === 'function') {
    const html = IP.buildInvoiceHtml({ items: [], total: 100, terms: 'Net 7.' }, { payUrl: 'https://buy.stripe.com/x', zelle: IP.zelleTextFor(null, true), payByBank: true });
    const htmlOther = IP.buildInvoiceHtml({ items: [], total: 100, terms: 'Net 7.' }, { payUrl: 'https://buy.stripe.com/x', zelle: '' });
    ok('invoice email from another tenant: Pay Online, but no ACH claim (ACH is offered on NBD links only)', /Pay Online/.test(htmlOther) && !/ACH/.test(htmlOther));
    ok('invoice email: Zelle line with phone + jd@, ACH line beside Pay Online', /Zelle: \(859\) 420-7382 or jd@nobigdealwithjoedeal\.com/.test(html) && /Pay by bank \(ACH\) — lower fees/.test(html) && !/info@/.test(html));
    // Invoice text: the Kentucky hold blanks the link AND the Zelle line.
    const sendKy = browser({ 'invoices/k1': { leadId: 'L1', createdBy: 'u1', status: 'draft', total: 100, balanceDue: 100, customerPhone: '5135550100', stripePaymentLink: 'https://buy.stripe.com/k' } }, { _leads: [kyLeadHeld] });
    await IP.sendInvoice('k1', 'sms');
    ok('invoice text on a held Kentucky job: no link, no Zelle', sendKy.sms.length === 1 && !/stripe|Zelle/.test(sendKy.sms[0].message || sendKy.sms[0].body || ''), JSON.stringify(sendKy.sms));
    const sendOh = browser({ 'invoices/o1': { leadId: 'L1', createdBy: 'u1', status: 'draft', total: 100, balanceDue: 100, customerPhone: '5135550100', stripePaymentLink: 'https://buy.stripe.com/o' } }, { _isNbdPlatformTenant: () => true });
    await IP.sendInvoice('o1', 'sms');
    const t = (sendOh.sms[0] && (sendOh.sms[0].message || sendOh.sms[0].body)) || '';
    ok('invoice text: link + bank/ACH + Zelle (859) 420-7382 or jd@', /https:\/\/buy\.stripe\.com\/o \(card or bank\/ACH — bank has lower fees\)/.test(t) && /Zelle: \(859\) 420-7382 or jd@nobigdealwithjoedeal\.com/.test(t), t);
    // Same send from a tenant that is NOT the NBD companyId (its brand looks
    // like NBD's because it never set legalName): link yes, Jo's Zelle never.
    const sendOther = browser({ 'invoices/o2': { leadId: 'L1', createdBy: 'u1', status: 'draft', total: 100, balanceDue: 100, customerPhone: '5135550100', stripePaymentLink: 'https://buy.stripe.com/o2' } }, { _isNbdPlatformTenant: () => false });
    await IP.sendInvoice('o2', 'sms');
    const t2 = (sendOther.sms[0] && (sendOther.sms[0].message || sendOther.sms[0].body)) || '';
    ok('invoice text from another tenant: no NBD Zelle (jd@ / 420-7382), no ACH claim', /buy\.stripe\.com\/o2/.test(t2) && !/Zelle|jd@|420-7382|ACH/.test(t2), t2);
  } else {
    ok('invoice-pipeline.js exports zelleTextFor (invoice email / text Zelle + ACH lines)', false);
  }
  if (REM && J) {
    const inv = { id: 'i1', status: 'sent', total: 5000, balanceDue: 5000, stripeHostedUrl: 'https://invoice.stripe.com/i/x', dueDate: new Date(NOW - 10 * 864e5) };
    const opts = { company: 'NBD', now: new Date(NOW), zelle: '(859) 420-7382 or jd@nobigdealwithjoedeal.com', payByBank: true, holdFn: (l, i, n) => J.payLinkHold(l, i, n) };
    ok('reminder text: bank/ACH + Zelle line', /bank\/ACH/.test(REM.buildReminder(inv, ohLead, opts).text) && /Zelle: \(859\) 420-7382 or jd@/.test(REM.buildReminder(inv, ohLead, opts).text));
    const optsOther = { company: 'Oaks', now: new Date(NOW), zelle: '', holdFn: (l, i, n) => J.payLinkHold(l, i, n) };
    ok('reminder from another tenant: the link, no ACH claim, no Zelle', /invoice\.stripe\.com/.test(REM.buildReminder(inv, ohLead, optsOther).text) && !/ACH|Zelle/.test(REM.buildReminder(inv, ohLead, optsOther).text));
    ok('reminder UI passes payByBank from the NBD companyId check', /payByBank: \(function \(\) \{ try \{ return typeof root\._isNbdPlatformTenant === 'function' && root\._isNbdPlatformTenant\(\) === true;/.test(read('docs/pro/js/invoice-reminder.js')));
    ok('reminder on a held Kentucky job: no Zelle either', !/Zelle/.test(REM.buildReminder(inv, kyLeadHeld, opts).text));
  }
  {
    // The portal's balance card (functions/portal.js), run for real.
    const src = lf(read('functions/portal.js'));
    const a = src.indexOf('    // Pay link: stripePaymentLink OR stripeHostedUrl');
    const b = src.indexOf('} : null;', a);
    const code = (a >= 0 && b > a) ? src.slice(a, b + 9) : '';
    const run = (lead, inv, zelleBrand, tenantKey) => {
      const ctx = { KyLaw: J, lead, _unpaidInvoice: inv, kyTz: J.DEFAULT_TIME_ZONE, Date, Math, Number, tenantKey: tenantKey === undefined ? ZC.NBD_OWNER_UID : tenantKey, require: (p) => require(path.join(ROOT, 'functions', p)) };
      if (zelleBrand !== undefined) ctx.zelleBrand = zelleBrand;
      vm.createContext(ctx);
      vm.runInContext(code + '\nthis.__b = _balance;', ctx);
      return ctx.__b;
    };
    const inv = { status: 'sent', balanceDue: 4000, stripeHostedUrl: 'https://invoice.stripe.com/i/acct/x' };
    const oh = code && J ? run(ohLead, inv, null) : null;
    ok('portal: Pay Now + "Pay by bank (ACH)" + Zelle (phone + jd@)', !!oh && oh.payByBank === true && oh.zelle === '(859) 420-7382 or jd@nobigdealwithjoedeal.com');
    const ky = code && J ? run(kyLeadHeld, inv, null) : null;
    ok('portal: Kentucky hold → no link, no ACH line, no Zelle', !!ky && ky.stripePaymentLink === null && ky.payByBank === false && ky.zelle === null);
    const none = code && J ? run(ohLead, inv, undefined) : null;
    ok('portal: a tenant with no profile → no Zelle line', !!none && none.zelle === null);
    const other = code && J ? run(ohLead, inv, {}, 'co_other') : null;
    ok('portal: another tenant whose brand looks like NBD\'s (no legalName) → no Zelle line', !!other && other.zelle === null);
    ok('portal: another tenant\'s link shows, but no "Pay by bank (ACH)" claim', !!other && !!other.stripePaymentLink && other.payByBank === false);
    const pjs = read('docs/pro/js/portal.js');
    ok('portal page renders both lines from the view (escaped, no inline style)', /data-pay-by-bank>Pay by bank \(ACH\) — lower fees/.test(pjs) && /data-zelle>Zelle: ' \+ esc\(view\.balance\.zelle\)/.test(pjs));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n3. ACH — offered, processing is not money, a failed debit reverts');
  if (ACH) {
    const calls = [];
    const r1 = await ACH.createWithAch(async (p, o) => { calls.push([p, o]); return { id: 'in_1' }; }, { customer: 'c' }, ACH.applyToInvoice, { idempotencyKey: 'k' });
    ok('Stripe invoice: payment_settings.payment_method_types has us_bank_account (first key unchanged)',
      JSON.stringify(calls[0][0].payment_settings.payment_method_types) === '["card","link","us_bank_account"]' && calls[0][1].idempotencyKey === 'k' && r1.paymentMethodTypes.indexOf('us_bank_account') !== -1);
    const calls2 = [];
    await ACH.createWithAch(async (p) => { calls2.push(p); return { id: 'plink_1' }; }, { line_items: [] }, ACH.applyToPaymentLink);
    ok('payment link: payment_method_types has us_bank_account', JSON.stringify(calls2[0].payment_method_types) === '["card","link","us_bank_account"]');
    // ACH not switched on yet: Stripe refuses the list → step down; the
    // last step passes no list (the account's own defaults — the old call).
    const calls3 = [];
    const refuse = (p) => { const e = new Error('The payment method type "us_bank_account" is invalid. Please ensure the provided type is activated in your dashboard'); e.type = 'StripeInvalidRequestError'; e.param = 'payment_settings[payment_method_types]'; throw e; };
    const r3 = await ACH.createWithAch(async (p, o) => { calls3.push([p, o]); if (p.payment_settings) refuse(p); return { id: 'in_ok' }; }, { customer: 'c' }, ACH.applyToInvoice, { idempotencyKey: 'k' });
    ok('ACH not activated → steps down to the account defaults, the invoice still goes out',
      r3.result.id === 'in_ok' && calls3.length === 3 && !calls3[2][0].payment_settings && calls3[2][1].idempotencyKey === 'k-pm2' && r3.paymentMethodTypes === null);
    let threw = null;
    try { await ACH.createWithAch(async () => { const e = new Error('card_declined'); e.type = 'StripeCardError'; throw e; }, {}, ACH.applyToInvoice); } catch (e) { threw = e; }
    ok('any other Stripe error is NOT swallowed', threw && threw.message === 'card_declined');
    const src = lf(read('functions/stripe.js'));
    ok('createStripePaymentLink mints through createWithAch + applyToPaymentLink', /AchPay\.createWithAch\(\(p\) => stripe\.paymentLinks\.create\(p\)/.test(src) && /_achOnLink \? AchPay\.applyToPaymentLink : AchPay\.noAch, null, logger\)/.test(src));
    ok('…ACH only on the NBD platform account\'s own link (Connect tenants keep their defaults)',
      /const _achOnLink = !connectState && isPlatformTenant\(decoded\);/.test(src) && ACH.noAch({ a: 1 }, ['card', 'us_bank_account']).payment_method_types === undefined);
    // BoldSign's e-sign auto-invoice (integrations/esign.js) was retired in
    // #2166; no other functions file may mint a Stripe invoice around ACH.
    ok('no Stripe invoice is minted outside stripe-crm-invoice.js (BoldSign auto-invoice retired)',
      !fs.existsSync(path.join(ROOT, 'functions/integrations/esign.js'))
      && fs.readdirSync(path.join(ROOT, 'functions')).filter((f) => /\.js$/.test(f) && f !== 'stripe-crm-invoice.js' && f !== 'ach-payments.js')
        .every((f) => !/stripe\.invoices\.create\(/.test(read('functions/' + f))));

    // processing → achPending, never money.
    const db = serverDb({ 'invoices/A1': { leadId: 'L1', createdBy: 'u1', status: 'sent', total: 5000, amountPaid: 0, balanceDue: 5000, payments: [] } });
    const pi = { id: 'pi_ach1', amount: 500000, metadata: { invoiceId: 'A1' }, payment_method_types: ['card', 'us_bank_account'] };
    const p1 = await ACH.handleAchEvent(db, { type: 'payment_intent.processing', data: { object: pi } }, { now: () => NOW });
    const a1 = db.store.get('invoices/A1');
    ok('payment_intent.processing → achPending on the invoice, payments / amountPaid / balance untouched',
      p1.pending === true && a1.achPending.paymentIntentId === 'pi_ach1' && a1.achPending.amountCents === 500000 && a1.payments.length === 0 && a1.amountPaid === 0 && a1.balanceDue === 5000);
    // collected revenue (collected-revenue.js) reads payments[] — processing is $0.
    const win = { addEventListener() {} };
    vm.runInNewContext(read('docs/pro/js/collected-revenue.js'), { window: win, console, Date, Math, JSON });
    const R = win.NBDRevenue;
    ok('…and collected revenue counts $0 for it (collected-only rule)', !!R && R.collectedBetween([Object.assign({ id: 'A1' }, a1)], NOW - 864e5, NOW + 864e5).total === 0
      // positive control: the same invoice once the money is really in
      && R.collectedBetween([Object.assign({ id: 'A1' }, a1, { payments: [{ amount: 5000, at: new Date(NOW) }], amountPaid: 5000, balanceDue: 0, status: 'paid' })], NOW - 864e5, NOW + 864e5).total === 5000);
    if (IP) ok('…the invoice detail says "processing — not counted as paid"', /\$5,000\.00 processing — not counted as paid/.test(IP.achPendingText(a1)));

    // Succeeds → (the existing credit runs) + achPending cleared.
    const s1 = await ACH.handleAchEvent(db, { type: 'payment_intent.succeeded', data: { object: pi } }, { now: () => NOW });
    ok('payment_intent.succeeded → achPending cleared (the webhook\'s own credit books the money)', s1.cleared === true && db.store.get('invoices/A1').achPending === null && s1.handled === false);

    // A bank payment credited, then FAILS (late return) → reverted + Jo alerted once.
    const db2 = serverDb({ 'invoices/B1': {
      leadId: 'L1', createdBy: 'u1', status: 'paid', total: 5000, amountPaid: 5000, balanceDue: 0, depositAmount: 2500, depositPaid: true, paidAt: '2026-10-01',
      paidIntentIds: ['pi_dep', 'pi_ach2'],
      payments: [{ amount: 2500, method: 'check', paymentId: 'mp_1' }, { amount: 2500, method: 'stripe', paymentIntentId: 'pi_ach2' }],
    } });
    const alerts = [];
    const failedPi = { id: 'pi_ach2', amount: 250000, metadata: { invoiceId: 'B1', userId: 'u1' }, payment_method_types: ['us_bank_account'],
      last_payment_error: { code: 'payment_method_insufficient_funds', payment_method: { type: 'us_bank_account' } } };
    const f1 = await ACH.handleAchEvent(db2, { type: 'payment_intent.payment_failed', data: { object: failedPi } }, { now: () => NOW, alert: async (o) => { alerts.push(o); } });
    const b1 = db2.store.get('invoices/B1');
    ok('failed ACH → the payment comes OFF the invoice ($2,500 owed again, partial, not paid)',
      f1.reverted === true && b1.payments.length === 1 && b1.amountPaid === 2500 && b1.balanceDue === 2500 && b1.status === 'partial' && b1.paidAt === null, JSON.stringify(b1));
    ok('…recorded as an ACH return; the intent stays in paidIntentIds (a re-delivered success can never credit it again)',
      b1.achReturns.length === 1 && b1.achReturns[0].paymentIntentId === 'pi_ach2' && b1.paidIntentIds.indexOf('pi_ach2') !== -1);
    ok('…Jo is alerted, internally (the rep\'s own email queue + lead activity), once',
      alerts.length === 1 && alerts[0].uid === 'u1' && alerts[0].source === 'stripe_ach_failed' && /taken back off the invoice/.test(alerts[0].emailBody)
      && /Nothing was sent to the customer/.test(alerts[0].emailBody) && alerts[0].activity.internalOnly === true);
    ok('…handled:true, so the webhook skips its "card declined" alert', f1.handled === true);
    const f2 = await ACH.handleAchEvent(db2, { type: 'charge.failed', data: { object: { id: 'py_ach2', payment_intent: 'pi_ach2', amount: 250000, payment_method_details: { type: 'us_bank_account' }, failure_code: 'R01' } } }, { now: () => NOW, alert: async (o) => { alerts.push(o); } });
    ok('the matching charge.failed: nothing reverted twice, no second alert', f2.reverted === false && alerts.length === 1 && db2.store.get('invoices/B1').amountPaid === 2500);
    // A ledger-booked ACH (stripeCreditKeys) failing.
    const db3 = serverDb({ 'invoices/C1': { leadId: 'L1', createdBy: 'u1', status: 'paid', total: 800, amountPaid: 800, balanceDue: 0, stripeCreditKeys: ['py_led'],
      payments: [{ amount: 800, method: 'us_bank_account', source: 'stripe_ledger', stripeRef: 'py_led' }] } });
    const f3 = await ACH.handleAchEvent(db3, { type: 'charge.failed', data: { object: { id: 'py_led', payment_intent: 'pi_led', amount: 80000, payment_method_details: { type: 'us_bank_account' } } } }, { now: () => NOW, alert: async () => {} });
    ok('a ledger-booked bank payment that fails is found by its credit key and reverted', f3.reverted === true && db3.store.get('invoices/C1').amountPaid === 0 && db3.store.get('invoices/C1').status === 'sent');
    // A CARD decline is not this module's business.
    const card = await ACH.handleAchEvent(db2, { type: 'payment_intent.payment_failed', data: { object: { id: 'pi_card', metadata: { invoiceId: 'B1' }, payment_method_types: ['card'], last_payment_error: { payment_method: { type: 'card' } } } } }, { alert: async (o) => { alerts.push(o); } });
    ok('a card decline → not handled here (the existing card alert runs)', card.handled === false && alerts.length === 1);
    ok('stripe.js: ACH handler runs after the ledger; the card alert is skipped when ACH handled it',
      /AchPay\.handleAchEvent\(db, event,/.test(src) && /if \(meta\.invoiceId && !\(achOut && achOut\.handled\)\)/.test(src));
  }
  {
    // The pay surfaces say it: customer page row, invoice detail, portal.
    const ct = read('docs/pro/js/customer-tasks-ui.js');
    ok('customer page: "Pay by bank (ACH) — lower fees" right under the Pay link, and an ACH in flight shows',
      /class="doc-btn">Pay<\/a>\s*\$\{\(typeof window\._isNbdPlatformTenant === 'function' && window\._isNbdPlatformTenant\(\) === true\) \? '<div class="invoice-paynote" data-pay-by-bank>Pay by bank \(ACH\) — lower fees<\/div>' : ''\}/.test(ct) && /data-ach-pending/.test(ct));
    ok('customer page: the Pay link still only through the Kentucky hold', /_J\.payUrlUnlessHeld\(_payLead, inv, new Date\(\)\)/.test(ct));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
