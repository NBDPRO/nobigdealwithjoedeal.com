/**
 * tests/money-paper-2026-09-30.test.js
 *
 * "Every charge gets a filed document" (Jo's live-CRM handoff #7,
 * functions/money-paper.js + money-paper-logic.js), exercised on a tiny
 * in-memory Firestore / bucket / Stripe / renderer — no emulator, no Chromium.
 *
 *  1. ids: NBD-YYYY-MMDD-XXXX in Eastern time, per-day counter
 *  2. an unpaid invoice with a Stripe invoice → ONE NBD-500 filed, never twice
 *  3. a re-minted Stripe invoice → a fresh NBD-500
 *  4. Mark Paid (Zelle) payoff → ledger key recorded BEFORE Stripe is told,
 *     Stripe invoice paid out of band, NBD-510 receipt filed
 *  5. the real stripe-ledger planCredit then credits NOTHING (no double count)
 *  6. a Stripe-paid invoice → receipt, no out-of-band call
 *  7. a contractor tenant's invoice → nothing at all
 *  8. a failed render retries, and stops after 3 attempts
 *  9. photo plate: cover, else newest After, else none
 * 10. the PDF viewer confines pdfPath to the lead's own prefix (source)
 *
 * Run: node tests/money-paper-2026-09-30.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// ── stub firebase-functions / admin so money-paper.js loads without a project ──
const FieldValue = { serverTimestamp: () => ({ __ts: true }) };
const stubs = {
  'firebase-functions/v2/firestore': { onDocumentWritten: (opts, fn) => { fn.__opts = opts; return fn; } },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => null, FieldValue },
  'firebase-admin/storage': { getStorage: () => null },
};
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (stubs[req]) return stubs[req];
  return origLoad.apply(this, arguments);
};
const FN = path.join(__dirname, '..', 'functions');
const P = require(path.join(FN, 'money-paper-logic.js'));
const MP = require(path.join(FN, 'money-paper.js'));
const LedgerLogic = require(path.join(FN, 'stripe-ledger-logic.js'));
Module._load = origLoad;
const { handle, OWNER, MAX_ATTEMPTS } = MP._internal;

// ── in-memory Firestore ────────────────────────────────────────────────────
function makeDb() {
  const store = new Map();          // 'col/id' or 'col/id/sub/id' → data
  const clone = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v instanceof Date ? { __date: v.getTime() } : v)));
  function setPath(obj, dotted, val) {
    const parts = dotted.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== 'object' || o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = val;
  }
  function ref(p) {
    return {
      path: p,
      id: p.split('/').pop(),
      async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => (d === undefined ? undefined : clone(d)) }; },
      async set(data, opt) { store.set(p, opt && opt.merge ? Object.assign(store.get(p) || {}, clone(data)) : clone(data)); },
      async update(patch) {
        if (!store.has(p)) throw new Error('no doc ' + p);
        const d = store.get(p);
        Object.keys(patch).forEach((k) => setPath(d, k, clone({ v: patch[k] }).v));
      },
      collection(c) { return col(p + '/' + c); },
    };
  }
  function col(c) {
    return {
      doc: (id) => ref(c + '/' + id),
      where(field, op, val) {
        return { limit: () => ({ async get() {
          const docs = [];
          for (const [k, v] of store) {
            if (k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1 && v[field] === val) docs.push({ id: k.split('/').pop(), data: () => clone(v) });
          }
          return { docs };
        } }) };
      },
    };
  }
  return {
    store,
    collection: col,
    async runTransaction(fn) {
      const tx = {
        get: (r) => r.get(),
        set: (r, d, o) => { r.set(d, o); },
        update: (r, patch) => { r.update(patch); },
      };
      return fn(tx);
    },
  };
}
function makeBucket() {
  const files = new Map();
  return {
    files,
    file: (p) => ({
      async save(buf, opts) { files.set(p, { bytes: buf.length, opts }); },
      async getSignedUrl() { return ['https://storage.example/' + p + '?sig=1']; },
    }),
  };
}
function makeStripe(status) {
  const calls = [];
  const st = { status: status || 'open' };
  return {
    calls,
    client: () => ({ invoices: {
      async retrieve(id) { calls.push(['retrieve', id]); return { id, status: st.status }; },
      async update(id, p) { calls.push(['update', id, p]); return {}; },
      async pay(id, p, o) { calls.push(['pay', id, p, o]); st.status = 'paid'; return {}; },
    } }),
  };
}

const T0 = new Date('2026-09-30T14:00:00-04:00').getTime();   // 2 pm Eastern
function deps(db, bucket, stripe, render, now) {
  return { db, bucket, stripe: stripe.client, render: render || (async (kind) => Buffer.from('%PDF-' + kind)), now: () => (now || T0) };
}
async function seed(db, invoiceId, inv, lead) {
  await db.collection('leads').doc('L1').set(Object.assign({ userId: OWNER, firstName: 'Pat', lastName: 'ZZ_QA', address: '1 Test Ln, Mason, OH 45040' }, lead || {}));
  await db.collection('invoices').doc(invoiceId).set(Object.assign({ leadId: 'L1', companyId: OWNER, userId: OWNER, total: 250, amountPaid: 0, balanceDue: 250, status: 'sent', payments: [], lineItems: [{ description: 'Shake repair', qty: 1, rate: 250 }] }, inv));
}
const inv = async (db, id) => (await db.collection('invoices').doc(id).get()).data();
const docsOf = (db) => [...db.store.keys()].filter((k) => k.startsWith('leads/L1/documents/'));

(async () => {
  console.log('\n1. instance ids');
  ok('NBD-YYYY-MMDD-XXXX in Eastern time', P.instanceId(T0, 1) === 'NBD-2026-0930-0001', P.instanceId(T0, 1));
  ok('11:30 pm Eastern is still that day (not UTC tomorrow)', P.instanceId(new Date('2026-09-30T23:30:00-04:00').getTime(), 12) === 'NBD-2026-0930-0012');
  ok('codes', P.CODES.invoice === 'NBD-500' && P.CODES.receipt === 'NBD-510');

  console.log('\n2. an unpaid invoice with a Stripe invoice → one NBD-500');
  {
    const db = makeDb(), bucket = makeBucket(), stripe = makeStripe();
    await seed(db, 'I1', { stripeInvoiceId: 'in_A', stripeHostedUrl: 'https://invoice.stripe.com/i/A' });
    const r = await handle('I1', await inv(db, 'I1'), deps(db, bucket, stripe));
    const i1 = await inv(db, 'I1');
    ok('filed NBD-2026-0930-0001', r.invoice === 'NBD-2026-0930-0001', JSON.stringify(r));
    ok('invoice.paper.invoice is filed with its pdfPath', i1.paper.invoice.state === 'filed' && i1.paper.invoice.pdfPath === 'documents/' + OWNER + '/L1/NBD-2026-0930-0001.pdf');
    ok('PDF saved outside pdf-renders/ (never auto-deleted)', bucket.files.has('documents/' + OWNER + '/L1/NBD-2026-0930-0001.pdf'));
    const row = (await db.collection('leads').doc('L1').collection('documents').doc('NBD-2026-0930-0001').get()).data();
    ok('Documents-tab row: code, id, pdfPath, Stripe id, no stored URL', row.docCode === 'NBD-500' && row.pdfPath && row.stripeInvoiceId === 'in_A' && !row.url && row.source === 'nbd_invoice');
    ok('no receipt and no Stripe call for an unpaid invoice', !r.receipt && stripe.calls.length === 0);
    const again = await handle('I1', i1, deps(db, bucket, stripe));
    ok('the trigger re-firing on its own write files nothing more', !again.invoice && docsOf(db).length === 1, JSON.stringify(again));

    console.log('\n3. re-minted Stripe invoice (new balance) → a fresh NBD-500');
    await db.collection('invoices').doc('I1').update({ stripeInvoiceId: 'in_B', stripeHostedUrl: 'https://invoice.stripe.com/i/B', amountPaid: 100, balanceDue: 150, status: 'partial' });
    const r2 = await handle('I1', await inv(db, 'I1'), deps(db, bucket, stripe));
    ok('second NBD-500 is 0002 for in_B', r2.invoice === 'NBD-2026-0930-0002' && (await inv(db, 'I1')).paper.invoice.stripeInvoiceId === 'in_B', JSON.stringify(r2));

    console.log('\n4. Mark Paid (Zelle) pays it off while in_B is open');
    const payoff = { amountPaid: 250, balanceDue: 0, status: 'paid', payments: [{ amount: 100, method: 'stripe' }, { amount: 150, method: 'zelle', reference: 'ZL-1' }] };
    await db.collection('invoices').doc('I1').update(payoff);
    // Order check: the ledger key must be on the CRM invoice BEFORE Stripe is told.
    let keyAtPay = null;
    const s2 = makeStripe('open');
    const origClient = s2.client;
    s2.client = () => { const c = origClient(); const pay = c.invoices.pay; c.invoices.pay = async (...a) => { keyAtPay = ((await inv(db, 'I1')).stripeCreditKeys || []).slice(); return pay(...a); }; return c; };
    const r3 = await handle('I1', await inv(db, 'I1'), deps(db, bucket, s2));
    const i3 = await inv(db, 'I1');
    ok('Stripe invoice marked paid out of band', r3.oob === 'done' && s2.calls.some((c) => c[0] === 'pay' && c[1] === 'in_B' && c[2].paid_out_of_band === true), JSON.stringify(s2.calls));
    ok('ledger key in_B:oob was recorded BEFORE the pay call', Array.isArray(keyAtPay) && keyAtPay.includes('in_B:oob'), JSON.stringify(keyAtPay));
    ok('NBD-510 receipt filed', r3.receipt === 'NBD-2026-0930-0003' && i3.paper.receipt.state === 'filed', JSON.stringify(r3));
    const rrow = (await db.collection('leads').doc('L1').collection('documents').doc(r3.receipt).get()).data();
    ok('receipt row is NBD-510', rrow.docCode === 'NBD-510' && rrow.source === 'nbd_receipt');
    ok('no NBD-500 is filed for a paid invoice', !r3.invoice);

    console.log('\n5. the Stripe ledger then books NOTHING for the out-of-band event');
    const mv = { key: 'in_B:oob', amountCents: 25000, atMs: T0, method: 'marked_paid_in_stripe' };
    ok('real planCredit on the paid CRM invoice → null (no double count)', LedgerLogic.planCredit(i3, mv) === null);
    ok('positive control: WITHOUT the key it would have credited $250 again',
      !!LedgerLogic.planCredit(Object.assign({}, i3, { stripeCreditKeys: [] }), mv));
    const again3 = await handle('I1', i3, deps(db, bucket, s2));
    ok('re-fire after payoff: no second receipt, no second pay', !again3.receipt && !again3.oob && s2.calls.filter((c) => c[0] === 'pay').length === 1);
  }

  console.log('\n6. a Stripe-paid invoice');
  {
    const db = makeDb(), bucket = makeBucket(), stripe = makeStripe('paid');
    await seed(db, 'I2', { stripeInvoiceId: 'in_C', stripeHostedUrl: 'https://x', amountPaid: 250, balanceDue: 0, status: 'paid', payments: [{ amount: 250, method: 'stripe' }] });
    const r = await handle('I2', await inv(db, 'I2'), deps(db, bucket, stripe));
    ok('receipt filed', !!r.receipt);
    ok('no out-of-band call for a card/online payment', !r.oob && stripe.calls.length === 0, JSON.stringify(stripe.calls));
  }

  console.log('\n7. a contractor tenant\'s invoice');
  {
    const db = makeDb(), bucket = makeBucket(), stripe = makeStripe();
    await seed(db, 'I3', { companyId: 'tenantX', userId: 'tenantX', stripeInvoiceId: 'in_D', stripeHostedUrl: 'https://x' });
    const r = await handle('I3', await inv(db, 'I3'), deps(db, bucket, stripe));
    ok('nothing filed, Stripe untouched', !r.invoice && !r.receipt && docsOf(db).length === 0 && stripe.calls.length === 0);
  }

  console.log('\n8. a failed render retries, at most 3 attempts');
  {
    const db = makeDb(), bucket = makeBucket(), stripe = makeStripe();
    await seed(db, 'I4', { stripeInvoiceId: 'in_E', stripeHostedUrl: 'https://x' });
    const boom = async () => { throw new Error('chromium down'); };
    await handle('I4', await inv(db, 'I4'), deps(db, bucket, stripe, boom));
    let i4 = await inv(db, 'I4');
    ok('state failed with the error kept', i4.paper.invoice.state === 'failed' && /chromium down/.test(i4.paper.invoice.error));
    await handle('I4', i4, deps(db, bucket, stripe, boom));
    await handle('I4', await inv(db, 'I4'), deps(db, bucket, stripe, boom));
    i4 = await inv(db, 'I4');
    ok('attempts capped at ' + MAX_ATTEMPTS, i4.paper.invoice.attempts === MAX_ATTEMPTS, String(i4.paper.invoice.attempts));
    const r = await handle('I4', i4, deps(db, bucket, stripe));
    ok('after the cap it stops, even with a healthy renderer', !r.invoice && docsOf(db).length === 0);
    ok('a retry keeps the SAME instance id (no gaps burned per attempt)', i4.paper.invoice.instanceId === 'NBD-2026-0930-0001');
  }
  {
    const db = makeDb(), bucket = makeBucket(), stripe = makeStripe();
    await seed(db, 'I5', { stripeInvoiceId: 'in_F', stripeHostedUrl: 'https://x' });
    let n = 0; const flaky = async (k) => { if (++n === 1) throw new Error('cold start'); return Buffer.from('%PDF'); };
    await handle('I5', await inv(db, 'I5'), deps(db, bucket, stripe, flaky));
    const r = await handle('I5', await inv(db, 'I5'), deps(db, bucket, stripe, flaky));
    ok('a transient failure succeeds on the next write', r.invoice === 'NBD-2026-0930-0001' && (await inv(db, 'I5')).paper.invoice.state === 'filed', JSON.stringify(r));
  }

  console.log('\n9. photo plate');
  const photos = [
    { id: 'p1', path: 'photos/a.jpg', phase: 'Before', createdAt: 1 },
    { id: 'p2', path: 'photos/b.jpg', phase: 'After', createdAt: 5 },
    { id: 'p3', path: 'photos/c.jpg', phase: 'After', createdAt: 9 },
    { id: 'p4', path: 'photos/d.jpg', phase: 'After', createdAt: 12, deleted: true },
  ];
  ok('the cover photo wins', P.pickPlatePhoto({ coverPhotoId: 'p1' }, photos).id === 'p1');
  ok('no cover → newest After (skipping deleted)', P.pickPlatePhoto({}, photos).id === 'p3');
  ok('no After → no plate', P.pickPlatePhoto({}, photos.slice(0, 1)) === null);

  console.log('\n10. payload + viewer wiring');
  const pl = P.invoicePayload({ total: 250, amountPaid: 100, stripeHostedUrl: 'https://pay', lineItems: [{ description: 'Repair', qty: 1, rate: 250 }] }, { firstName: 'Pat' }, 'NBD-2026-0930-0001', T0, null);
  ok('invoice payload: balance, pay button, doc number, 7-day due date', pl.balanceDue === 150 && pl.payUrl === 'https://pay' && pl.docNumber === 'NBD-2026-0930-0001' && /October 7, 2026/.test(pl.invoice.dueDate), JSON.stringify({ b: pl.balanceDue, d: pl.invoice.dueDate }));
  const rp = P.receiptPayload({ total: 250, amountPaid: 250, payments: [{ amount: 100, method: 'stripe' }, { amount: 150, method: 'zelle', reference: 'ZL-1', at: T0 }] }, null, 'NBD-2026-0930-0003', T0, null);
  ok('receipt payload: last payment, prior payments, Zelle label', rp.amount === 150 && rp.priorPayments === 100 && rp.payment.method === 'Zelle' && rp.payment.reference === 'ZL-1');
  const dv = fs.readFileSync(path.join(FN, 'document-view.js'), 'utf8');
  ok('getDocumentPdfUrl confines pdfPath to this lead\'s documents/ prefix and .pdf', /exports\.getDocumentPdfUrl = onCall/.test(dv) && /\^documents\\\/\[\^\/\]\+\\\/\[\^\/\]\+\\\/\[\^\/\]\+\\\.pdf\$/.test(dv) && /pdfPath\.split\('\/'\)\[2\] !== leadId/.test(dv));
  const cd = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'customer-documents.js'), 'utf8');
  ok('the Documents tab opens pdfPath rows through getDocumentPdfUrl', /data-doc-pdf=/.test(cd) && /'getDocumentPdfUrl'/.test(cd));
  const sci = fs.readFileSync(path.join(FN, 'stripe-crm-invoice.js'), 'utf8');
  ok('Stripe invoices are due in 7 days', /days_until_due: 7,/.test(sci));
  ok('trigger is 2GiB (Chromium) and watches invoices/{invoiceId}', MP.moneyPaperOnInvoice.__opts && MP.moneyPaperOnInvoice.__opts.memory === '2GiB' && MP.moneyPaperOnInvoice.__opts.document === 'invoices/{invoiceId}');

  console.log('\n12. history is never touched — only a change made by THIS write (the real trigger passes `before`)');
  {
    const db = makeDb(), bucket = makeBucket(), stripe = makeStripe('open');
    // An invoice paid by Zelle months ago whose Stripe invoice is still open,
    // re-written today for an unrelated reason (a note edit).
    await seed(db, 'H1', { stripeInvoiceId: 'in_OLD', stripeHostedUrl: 'https://x', amountPaid: 250, balanceDue: 0, status: 'paid', payments: [{ amount: 250, method: 'zelle' }] });
    const cur = await inv(db, 'H1');
    const r = await handle('H1', Object.assign({}, cur, { notes: 'edited' }), deps(db, bucket, stripe), cur);
    ok('an already-paid invoice: no retro receipt, no out-of-band call', !r.receipt && !r.oob && stripe.calls.length === 0 && docsOf(db).length === 0, JSON.stringify(r));
    // An old open invoice with the same Stripe invoice, re-written.
    await seed(db, 'H2', { stripeInvoiceId: 'in_OLD2', stripeHostedUrl: 'https://x' });
    const c2 = await inv(db, 'H2');
    const r2 = await handle('H2', Object.assign({}, c2, { notes: 'x' }), deps(db, bucket, stripe), c2);
    ok('an old open invoice keeping its Stripe invoice: no retro NBD-500', !r2.invoice && docsOf(db).length === 0);
    // Real transitions still act.
    await db.collection('invoices').doc('H2').update({ stripeInvoiceId: 'in_NEW', stripeHostedUrl: 'https://y' });
    const r3 = await handle('H2', await inv(db, 'H2'), deps(db, bucket, stripe), c2);
    ok('a NEW Stripe invoice on this write → NBD-500 filed for in_NEW',
      !!r3.invoice && docsOf(db).length === 1 && (await inv(db, 'H2')).paper.invoice.stripeInvoiceId === 'in_NEW', JSON.stringify(r3));
    const T = MP._internal.transitions;
    ok('transitions: unpaid → paid is "became paid"; paid → paid is not',
      T({ status: 'sent' }, { status: 'paid' }).becamePaid === true && T({ status: 'paid' }, { status: 'paid' }).becamePaid === false);
    ok('transitions: a created doc (before null) that is paid counts', T(null, { status: 'paid' }).becamePaid === true);
    ok('transitions: same Stripe invoice is not new; a changed one is',
      T({ stripeInvoiceId: 'in_1', stripeHostedUrl: 'u' }, { stripeInvoiceId: 'in_1', stripeHostedUrl: 'u' }).newStripeInvoice === false
      && T({ stripeInvoiceId: 'in_1', stripeHostedUrl: 'u' }, { stripeInvoiceId: 'in_2', stripeHostedUrl: 'v' }).newStripeInvoice === true);
  }

  console.log('\n13. QR code of the pay link on the invoice (qrcode package, Jo OK 2026-09-30)');
  {
    const qr = await MP._internal.payQr('https://invoice.stripe.com/i/acct_x/test_abc');
    const png = qr && Buffer.from(qr.split(',')[1] || '', 'base64');
    ok('a real PNG data URI for an https pay link', /^data:image\/png;base64,/.test(qr || '') && png && png.slice(1, 4).toString() === 'PNG' && png.length > 300, (qr || '').slice(0, 40));
    ok('a non-https link gets no QR', (await MP._internal.payQr('http://x')) === null && (await MP._internal.payQr('')) === null);
    const db = makeDb(), bucket = makeBucket(), stripe = makeStripe();
    await seed(db, 'Q1', { stripeInvoiceId: 'in_Q', stripeHostedUrl: 'https://invoice.stripe.com/i/Q' });
    const seen = {};
    const d = deps(db, bucket, stripe, async (kind, payload) => { seen[kind] = payload; return Buffer.from('%PDF'); });
    d.qr = async (u) => 'data:image/png;base64,FAKE:' + u;
    await handle('Q1', await inv(db, 'Q1'), d);
    ok('the invoice render gets payQr for its own pay link', seen.invoice && seen.invoice.payQr === 'data:image/png;base64,FAKE:https://invoice.stripe.com/i/Q');
    const tpl = fs.readFileSync(path.join(FN, 'print', 'templates', 'invoice.hbs'), 'utf8');
    ok('invoice.hbs prints the QR beside the pay button', /\{\{#if payQr\}\}[\s\S]*<img src="\{\{payQr\}\}"[\s\S]*Scan to pay/.test(tpl));
    const pkg = require(path.join(FN, 'package.json'));
    ok('qrcode is a runtime dependency', !!(pkg.dependencies && pkg.dependencies.qrcode));
  }

  console.log('\n11. cover subtitle (a `sub` helper shadowed the partial param → "NaN" on every server PDF since #362)');
  {
    const Handlebars = require(path.join(FN, 'node_modules', 'handlebars'));
    const hb = Handlebars.create();
    hb.registerHelper('sub', (a, b) => Number(a) - Number(b));   // the real helper's behaviour (render-pdf.js)
    const partial = fs.readFileSync(path.join(FN, 'print', 'partials', 'coverPage.hbs'), 'utf8');
    hb.registerPartial('coverPage', partial);
    const html = hb.compile('{{> coverPage eyebrow="Invoice" tagline="T" sub=coverSub}}')({ coverSub: 'Itemized invoice with payment detail' });
    ok('the subtitle prints', /Itemized invoice with payment detail/.test(html), html.slice(0, 200));
    ok('…and never "NaN"', !/NaN/.test(html));
    const bare = hb.compile('{{sub}}')({ sub: 'x' });
    ok('positive control: a bare {{sub}} really does call the helper (NaN)', bare === 'NaN', bare);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
