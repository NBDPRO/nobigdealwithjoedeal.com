/**
 * tests/mark-paid-methods-2026-09-29.test.js
 *
 * Manual "Record Payment" upgrade (Jo, 2026-09-29): "the only other payments
 * would be checks I can attach and upload to customers to be as easy and
 * automated as possible", and the receipt "either photo or pdf ... not
 * required but definitely recommended".
 *
 * Pins the pure pieces exported from docs/pro/js/invoice-pipeline.js:
 * the method list + validation, cents rounding on DECIMAL digits
 * ($1,234.565 → 123457; 1.005 → 101, which Math.round(x*100) gets wrong), the payments[]
 * entry shape, proof being optional, the overpay rule (recorded, balance
 * clamped at 0 — what markPaid has always done), attach-proof matching, and
 * HTML escaping of every user value in the payment history. Then drives the
 * real markPaid against a fake Firestore to check what is written.
 *
 * Synthetic data only (public repo): ZZ_QA names, fake ids.
 *
 * Run: node tests/mark-paid-methods-2026-09-29.test.js
 */
'use strict';

const path = require('path');
global.window = global.window || {};
const IP = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'invoice-pipeline.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
function throws(fn, re) {
  try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
}

(async () => {
  console.log('\n1. payment methods');
  const keys = IP.PAYMENT_METHODS.map(m => m.key);
  ok('check, zelle, cash, ach, other — in that order', keys.join(',') === 'check,zelle,cash,ach,other', keys.join(','));
  ok('each method has a label and a reference label', IP.PAYMENT_METHODS.every(m => m.label && m.refLabel));
  for (const k of keys) ok('valid: ' + k, IP.isManualPaymentMethod(k));
  for (const k of ['stripe', 'manual', '', null, undefined, 'CHECK', 'venmo', '<b>']) {
    ok('refused: ' + JSON.stringify(k), !IP.isManualPaymentMethod(k));
  }
  ok('Stripe entries label as Stripe', IP.paymentMethodLabel('stripe') === 'Stripe');
  ok('legacy method-less entries label as Manual', IP.paymentMethodLabel(undefined) === 'Manual' && IP.paymentMethodLabel('manual') === 'Manual');
  ok('ach labels as ACH / bank transfer', IP.paymentMethodLabel('ach') === 'ACH / bank transfer');

  console.log('\n2. cents rounding');
  ok('Math.round(1.005*100) really is wrong — 100, not 101 (the reason toCents exists)', Math.round(1.005 * 100) === 100);
  ok('1.005 → 101 on the decimal digits', IP.toCents(1.005) === 101, IP.toCents(1.005));
  ok('1234.565 (number) → 123457', IP.toCents(1234.565) === 123457, IP.toCents(1234.565));
  ok('"$1,234.565" → 123457', IP.toCents('$1,234.565') === 123457, IP.toCents('$1,234.565'));
  ok('"1234.564" → 123456', IP.toCents('1234.564') === 123456);
  ok('"0.005" → 1 (half-up)', IP.toCents('0.005') === 1);
  ok('"0.1" + "0.2" add exactly in cents', IP.toCents('0.1') + IP.toCents('0.2') === 30);
  ok('"12" → 1200, ".5" → 50', IP.toCents('12') === 1200 && IP.toCents('.5') === 50);
  ok('0.30000000000000004 → 30', IP.toCents(0.1 + 0.2) === 30);
  for (const bad of ['', '.', 'abc', '-5', '1.2.3', null, undefined, NaN, Infinity, '1e5']) {
    ok('not a amount: ' + JSON.stringify(bad), Number.isNaN(IP.toCents(bad)));
  }
  ok('centsToDollars(123457) → 1234.57', IP.centsToDollars(123457) === 1234.57);

  console.log('\n3. entry shape');
  const at = new Date(2026, 8, 28, 12);
  const recordedAt = new Date(2026, 8, 29, 9, 30);
  const full = IP.buildManualPaymentEntry({
    amount: '1,234.565', method: 'check', at, recordedAt, recordedBy: 'zzqa-uid',
    reference: '  1042 ', note: 'ZZ_QA deposit',
    proofStoragePath: 'payment-proofs/zzqa-uid/inv1/1_check.jpg', proofName: 'check.jpg',
  });
  ok('amount stored in DOLLARS, rounded from cents', full.amount === 1234.57, full.amount);
  ok('at is the received date', full.at === at);
  ok('method kept', full.method === 'check');
  ok('reference trimmed', full.reference === '1042');
  ok('note kept', full.note === 'ZZ_QA deposit');
  ok('proof path + name kept', full.proofStoragePath === 'payment-proofs/zzqa-uid/inv1/1_check.jpg' && full.proofName === 'check.jpg');
  ok('recordedBy / recordedAt stamped', full.recordedBy === 'zzqa-uid' && full.recordedAt === recordedAt);
  ok('exactly the documented keys', Object.keys(full).sort().join(',') ===
    ['amount', 'at', 'method', 'note', 'proofName', 'proofStoragePath', 'recordedAt', 'recordedBy', 'reference'].sort().join(','),
    Object.keys(full).join(','));

  console.log('\n4. proof (and reference/note) optional');
  const bare = IP.buildManualPaymentEntry({ amount: 500, method: 'zelle', at, recordedAt, recordedBy: 'zzqa-uid' });
  ok('no proof → no proof keys at all (Firestore rejects undefined)', !('proofStoragePath' in bare) && !('proofName' in bare));
  ok('blank reference/note → omitted', !('reference' in bare) && !('note' in bare));
  ok('no undefined values anywhere', Object.values(bare).every(v => v !== undefined));
  ok('proofFileCheck(null) is ok (optional)', IP.proofFileCheck(null).ok === true);
  ok('a JPEG is accepted', IP.proofFileCheck({ type: 'image/jpeg', size: 3e6 }).ok);
  ok('a HEIC phone photo is accepted', IP.proofFileCheck({ type: 'image/heic', size: 3e6 }).ok);
  ok('a PDF is accepted', IP.proofFileCheck({ type: 'application/pdf', size: 1e5 }).ok);
  ok('a .zip is refused', !IP.proofFileCheck({ type: 'application/zip', size: 10 }).ok);
  ok('over 25MB is refused', !IP.proofFileCheck({ type: 'image/jpeg', size: 25 * 1024 * 1024 + 1 }).ok);
  ok('exactly 25MB is accepted', IP.proofFileCheck({ type: 'image/jpeg', size: 25 * 1024 * 1024 }).ok);
  ok('bad method throws', throws(() => IP.buildManualPaymentEntry({ amount: 5, method: 'stripe', at }), /method/));
  ok('zero amount throws', throws(() => IP.buildManualPaymentEntry({ amount: 0, method: 'cash', at }), /amount/));
  ok('negative amount throws', throws(() => IP.buildManualPaymentEntry({ amount: -5, method: 'cash', at }), /amount/));
  ok('missing date throws', throws(() => IP.buildManualPaymentEntry({ amount: 5, method: 'cash' }), /date/));
  ok('control chars stripped from reference', IP.buildManualPaymentEntry({ amount: 5, method: 'check', at, reference: 'A\u0000B\nC' }).reference === 'A B C');
  ok('reference capped at 80 chars', IP.buildManualPaymentEntry({ amount: 5, method: 'check', at, reference: 'x'.repeat(200) }).reference.length === 80);

  console.log('\n5. storage path');
  const p = IP.paymentProofPath('zzqa-uid', 'inv/../x', 1790000000000, 'my check (1).JPG');
  ok('payment-proofs/{uid}/{invoiceId}/{ts}_{name}', /^payment-proofs\/zzqa-uid\/[A-Za-z0-9_-]+\/1790000000000_[A-Za-z0-9._-]+$/.test(p), p);
  ok('no path traversal survives in the invoice id', !/\.\.|\/x\//.test(p.split('/')[2]) && p.split('/').length === 4, p);

  console.log('\n6. received date');
  const now = new Date(2026, 8, 29, 15, 45);
  ok('today → the current instant', IP.receivedAtFromDateInput('2026-09-29', now).getTime() === now.getTime());
  const y = IP.receivedAtFromDateInput('2026-09-28', now);
  ok('yesterday → local noon yesterday', y.getFullYear() === 2026 && y.getMonth() === 8 && y.getDate() === 28 && y.getHours() === 12);
  ok('tomorrow is refused', IP.receivedAtFromDateInput('2026-09-30', now) === null);
  ok('garbage is refused', IP.receivedAtFromDateInput('2026-02-31', now) === null && IP.receivedAtFromDateInput('', now) === null);
  ok('the default field value is local YYYY-MM-DD', IP.localDateInputValue(now) === '2026-09-29');

  console.log('\n7. applying a payment (cents math, overpay)');
  const inv = { total: 10000.10, amountPaid: 0.2, depositAmount: 5000, status: 'sent', paidAt: null, payments: [{ amount: 0.2, at: new Date(2026, 8, 1), method: 'cash' }] };
  const e1 = IP.buildManualPaymentEntry({ amount: '0.10', method: 'cash', at, recordedAt });
  const r1 = IP.applyPaymentToInvoice(inv, e1);
  ok('0.2 + 0.1 paid = 0.3 exactly', r1.patch.amountPaid === 0.3, r1.patch.amountPaid);
  ok('balance = 10000.10 − 0.30 = 9999.80 exactly', r1.patch.balanceDue === 9999.8 && r1.newBalanceDue === 9999.8, r1.patch.balanceDue);
  ok('partial keeps status + paidAt', r1.patch.status === 'sent' && r1.patch.paidAt === null);
  ok('ledger appended, prior entry untouched', r1.patch.payments.length === 2 && r1.patch.payments[0] === inv.payments[0] && r1.patch.payments[1] === e1);
  ok('input invoice not mutated', inv.payments.length === 1);
  ok('deposit not yet paid', r1.patch.depositPaid === false);
  const over = IP.applyPaymentToInvoice(inv, IP.buildManualPaymentEntry({ amount: 20000, method: 'check', at, recordedAt }));
  ok('overpay is RECORDED (amountPaid 20000.20)', over.patch.amountPaid === 20000.2, over.patch.amountPaid);
  ok('…balance clamped at 0 and the invoice is paid', over.patch.balanceDue === 0 && over.patch.status === 'paid' && over.patch.paidAt === at);
  const later = new Date(2026, 8, 29, 18);
  const back = IP.applyPaymentToInvoice(Object.assign({}, inv, { lastPaymentAt: later }), e1);
  ok('a back-dated check never moves lastPaymentAt backwards', back.patch.lastPaymentAt === later);
  ok('a newer payment moves lastPaymentAt forward', IP.applyPaymentToInvoice(inv, e1).patch.lastPaymentAt === at);
  ok('an invoice with no status stays open as sent (never undefined)', IP.applyPaymentToInvoice({ total: 100 }, e1).patch.status === 'sent');

  console.log('\n8. attach proof in place');
  const t1 = new Date(2026, 8, 20), t2 = new Date(2026, 8, 25);
  const pays = [
    { amount: 100, at: t1, method: 'stripe', paymentIntentId: 'pi_zzqa' },
    { amount: 250, at: t2, method: 'check' },                                        // legacy, no recordedAt
    { amount: 75, at: t2, method: 'zelle', recordedAt: recordedAt, recordedBy: 'u' },
  ];
  const k2 = IP.paymentKey(pays[2]);
  const next = IP.attachProofToPayments(pays, 2, k2, { proofStoragePath: 'payment-proofs/u/inv1/1_z.png', proofName: 'z.png' });
  ok('the matched entry gets the proof', next[2].proofStoragePath === 'payment-proofs/u/inv1/1_z.png' && next[2].proofName === 'z.png' && next[2].amount === 75);
  ok('other entries untouched, input not mutated', next[1] === pays[1] && !pays[2].proofStoragePath);
  const shifted = [{ amount: 9, at: new Date(), method: 'cash', recordedAt: new Date(1) }].concat(pays);
  ok('a shifted array is matched by recordedAt, not the stale index', IP.findPaymentIndex(shifted, 2, k2) === 3);
  ok('a legacy entry (no recordedAt) matches by at + amount + method', IP.findPaymentIndex(pays, 1, IP.paymentKey(pays[1])) === 1);
  ok('Stripe entries refuse attach', throws(() => IP.attachProofToPayments(pays, 0, IP.paymentKey(pays[0]), { proofStoragePath: 'x' }), /Stripe/));
  ok('an entry that already has proof refuses a second', throws(() => IP.attachProofToPayments(next, 2, k2, { proofStoragePath: 'y' }), /already/));
  ok('a vanished entry refuses', throws(() => IP.attachProofToPayments([pays[0]], 2, k2, { proofStoragePath: 'y' }), /changed/));

  console.log('\n9. payment history rows + escaping');
  const hostile = '<img src=x onerror=alert(1)>&"\'';
  const hinv = { payments: [
    { amount: 100, at: t1, method: 'stripe' },
    { amount: 250, at: t2, method: 'check', reference: hostile, note: hostile, proofStoragePath: 'payment-proofs/u/i/1_a.jpg', proofName: hostile },
    { amount: 75, at: new Date(2026, 8, 27), method: 'zelle', recordedAt },
    { amount: 0, at: t1, method: 'cash' },
  ] };
  const rows = IP.paymentHistoryRows(hinv);
  ok('zero-amount entries are not listed', rows.length === 3);
  ok('newest first', rows[0].method === 'zelle' && rows[2].method === 'stripe');
  ok('Stripe row never offers attach', rows[2].isStripe && !rows[2].canAttach && rows[2].methodLabel === 'Stripe');
  ok('manual row without proof offers attach', rows[0].canAttach && rows[0].index === 2);
  ok('row with proof does not offer attach', !rows[1].canAttach && rows[1].proofStoragePath);
  const html = IP.paymentHistoryHtml('inv1', hinv);
  ok('no raw hostile markup reaches the HTML', !/<img/i.test(html) && !/onerror=alert\(1\)>/.test(html.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')));
  ok('reference/note/proofName are entity-escaped (& < > " \')', html.includes('&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;'));
  ok('📎 View on the proof row, 📎 Attach proof on the bare manual row only', (html.match(/data-ip-action="viewProof"/g) || []).length === 1
    && (html.match(/data-ip-action="attachProof"/g) || []).length === 1);
  ok('attach button carries the recordedAt key', /data-ip-action="attachProof" data-ip-id="inv1" data-ip-idx="2" data-ip-rec="\d+"/.test(html));
  ok('escHtml covers all five characters', IP.escHtml(`&<>"'`) === '&amp;&lt;&gt;&quot;&#39;');
  ok('an invoice with no payments renders no history block', IP.paymentHistoryHtml('inv1', { payments: [] }) === '');

  console.log('\n10. markPaid writes the new entry (fake Firestore)');
  const writes = [];
  const docs = { 'invoices/zzqa-inv': { total: 1000, amountPaid: 0, depositAmount: 500, status: 'sent', paidAt: null, payments: [] } };
  Object.assign(global.window, {
    _db: {},
    _auth: { currentUser: { uid: 'zzqa-uid' } },
    collection: () => ({}),
    doc: (_db, col, id) => ({ path: col + '/' + id }),
    getDoc: async (ref) => ({ exists: () => ref.path in docs, data: () => docs[ref.path] }),
    updateDoc: async (ref, data) => { writes.push({ path: ref.path, data }); },
  });
  await IP.markPaid('zzqa-inv', '400', 'zelle', { at, reference: 'ZZQA-CONF-1', note: '' });
  const w = writes[0] && writes[0].data;
  const pe = w && w.payments && w.payments[0];
  ok('one invoice write', writes.length === 1 && writes[0].path === 'invoices/zzqa-inv');
  ok('entry: amount 400, zelle, received date, reference', pe && pe.amount === 400 && pe.method === 'zelle' && pe.at === at && pe.reference === 'ZZQA-CONF-1');
  ok('entry: recordedBy from auth, recordedAt a Date, no proof keys', pe && pe.recordedBy === 'zzqa-uid' && pe.recordedAt instanceof Date && !('proofStoragePath' in pe) && !('note' in pe));
  ok('invoice: amountPaid 400 / balance 600 / still sent / lastPaymentAt = received date',
    w.amountPaid === 400 && w.balanceDue === 600 && w.status === 'sent' && w.lastPaymentAt === at);
  ok('no undefined anywhere in the write', JSON.stringify(w, (k, v) => (v === undefined ? '__UNDEF__' : v)).indexOf('__UNDEF__') === -1);
  writes.length = 0;
  await IP.markPaid('zzqa-inv', 1000, 'check', { proofStoragePath: 'payment-proofs/zzqa-uid/zzqa-inv/1_c.jpg', proofName: 'c.jpg' });
  ok('legacy 3-arg shape still works and a proof path rides along', writes[0].data.payments[0].proofStoragePath === 'payment-proofs/zzqa-uid/zzqa-inv/1_c.jpg');
  let refused = false;
  try { await IP.markPaid('zzqa-inv', 0, 'check'); } catch (e) { refused = /amount/.test(e.message); }
  ok('zero amount refused before any read', refused);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
