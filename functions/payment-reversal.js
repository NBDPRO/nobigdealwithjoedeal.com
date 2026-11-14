/**
 * functions/payment-reversal.js — reverse a mistyped or bounced payment
 * (wave-1 money-path review, 2026-11-14, finding 1).
 *
 *   reversePayment (onCall, App Check enforced) — { invoiceId, paymentId, reason }
 *     → { ok, amountPaid, balanceDue, status }
 *
 * Before this there was no way to fix a recorded payment: $40,000 typed for a
 * $4,000 check marked the invoice paid and added $36,000 to Collected for
 * good. A reversal is NEVER a delete. It APPENDS one entry to the invoice's
 * payments[] ledger:
 *
 *   { amount: -<the whole payment>, at: <the payment's own date>, method,
 *     reversal: true, reverses: <its paymentId>, reversesIndex, reason,
 *     recordedBy, recordedAt, paymentId: 'rev_' + id }
 *
 * and lowers amountPaid by the same amount (balanceDue, status, paidAt and
 * depositPaid follow). Dating it on the original's date nets every period
 * total back to what really came in. Every revenue reader sums payments[]
 * with negatives (docs/pro/js/collected-revenue.js and its mirrors); lists,
 * receipts and the homeowner portal hide the reversed payment.
 *
 * WHO: the owner side of the invoice's company only — platform admin, the
 * company's company_admin, or a solo owner (no role claim, company keyed by
 * their uid) — the same people firestore.rules backfillWriterOk trusts with
 * money. Never a viewer, rep or manager.
 *
 * WHY A CALLABLE, not a client write: the invoice update rule already runs at
 * Firestore's 1000-expression budget (tests/firestore-rules.test.js pins a
 * 12-payment append), and a rules-checked reversal entry ran past it on any
 * invoice with two or more payments. The Admin SDK skips the rules; the checks
 * live here instead, inside one transaction.
 *
 * Only manual entries (check, Zelle, cash, card, ACH, other) with a
 * paymentId. Stripe-booked money is refunded in Stripe (the ledger records
 * that as refunds[]), never reversed here.
 */
'use strict';

const MANUAL_METHODS = ['check', 'zelle', 'cash', 'card', 'ach', 'other'];
const REASON_MAX = 300;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const PAYMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const cents = (v) => Math.round((Number(v) || 0) * 100);
const dollars = (c) => Math.round(c) / 100;
function tsMs(v) {
  if (v == null) return NaN;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  return new Date(v).getTime();
}
function cleanReason(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, REASON_MAX);
}

/** Ids of the payments a reversal entry in this list cancels. Pure. */
function reversedPaymentIds(payments) {
  const out = new Set();
  (Array.isArray(payments) ? payments : []).forEach((p) => {
    if (p && p.reversal === true && Number(p.amount) < 0 && typeof p.reverses === 'string' && p.reverses) out.add(p.reverses);
  });
  return out;
}

/**
 * Why payments[index] cannot be reversed, or '' when it can. Pure. The same
 * words as docs/pro/js/invoice-pipeline.js reversalBlockedReason (the UI's
 * copy, which decides whether to draw the button).
 */
function reversalBlockedReason(invoice, index) {
  const inv = invoice || {};
  const list = Array.isArray(inv.payments) ? inv.payments : [];
  const p = list[index];
  if (!p || !Number.isInteger(index)) return 'That payment changed — reopen the invoice and try again';
  if (p.reversal === true || !(cents(p.amount) > 0)) return 'That entry is not a payment';
  if (p.method === 'stripe' || p.paymentIntentId || p.stripeRef || p.source === 'stripe_ledger') {
    return 'Card and bank payments made online are refunded in Stripe, not reversed here';
  }
  if (!MANUAL_METHODS.includes(p.method)) return 'Only check, Zelle, cash, card, ACH or other payments typed in here can be reversed';
  if (typeof p.paymentId !== 'string' || !PAYMENT_ID_RE.test(p.paymentId)) {
    return 'This older payment has no id to reverse — ask for help fixing it';
  }
  if (reversedPaymentIds(list).has(p.paymentId)) return 'That payment is already reversed';
  if (!(tsMs(p.at) > 0)) return 'That payment has no date';
  const st = String(inv.status || '').toLowerCase();
  if (st === 'sending') return 'The invoice is being sent — try again in a minute';
  if (inv.deleted === true || st === 'void' || st === 'cancelled') return 'The invoice is voided';
  return '';
}

/**
 * The invoice write for reversing payments[index]. Pure.
 * o = { reason, by, now } → { entry, patch } ; throws Error(reason) when it cannot.
 */
function planReversal(invoice, index, o) {
  o = o || {};
  const why = reversalBlockedReason(invoice, index);
  if (why) throw new Error(why);
  const reason = cleanReason(o.reason);
  if (!reason) throw new Error('Say why the payment is reversed');
  const inv = invoice || {};
  const list = inv.payments.slice();
  const orig = list[index];
  const now = o.now instanceof Date ? o.now : new Date();
  const amtC = cents(orig.amount);
  const entry = {
    amount: -dollars(amtC),
    at: orig.at,                    // its own date value, unchanged (a Timestamp stays one)
    method: orig.method,
    reversal: true,
    reverses: orig.paymentId,
    reversesIndex: index,
    reason,
    recordedBy: String(o.by || ''),
    recordedAt: now,
    paymentId: 'rev_' + orig.paymentId.slice(0, 60),
  };
  list.push(entry);
  const totalC = cents(Math.max(0, Number(inv.total) || 0));
  const newPaidC = Math.max(0, cents(Math.max(0, Number(inv.amountPaid) || 0)) - amtC);
  const balC = Math.max(0, totalC - newPaidC);
  const depositC = cents(Math.max(0, Number(inv.depositAmount) || 0));
  const paid = totalC > 0 && balC === 0 && newPaidC > 0;
  return {
    entry,
    patch: {
      payments: list,
      amountPaid: dollars(newPaidC),
      balanceDue: dollars(balC),
      depositPaid: depositC > 0 ? newPaidC >= depositC : newPaidC > 0,
      status: paid ? 'paid' : (newPaidC > 0 ? 'partial' : 'sent'),
      paidAt: paid ? (inv.paidAt == null ? null : inv.paidAt) : null,
      updatedAt: now,
    },
  };
}

/**
 * The owner side of THIS invoice's company (firestore.rules backfillWriterOk,
 * plus the tenant match the invoice update rule adds). Pure.
 */
function ownerSideFor(auth, inv) {
  if (!auth || !auth.uid || !inv) return false;
  const c = auth.token || {};
  const role = c.role || '';
  const cid = typeof inv.companyId === 'string' ? inv.companyId : '';
  if (role === 'admin') return true;
  if (role === 'company_admin') return !!c.companyId && !!cid && c.companyId === cid;
  if (role) return false;
  if (c.companyId && c.companyId !== auth.uid) return false;   // a claimed company that is not their own uid
  return cid ? cid === auth.uid : inv.createdBy === auth.uid;
}

async function handleReversePayment(request, deps) {
  const { HttpsError } = require('firebase-functions/v2/https');
  const { assertNotViewer } = require('./shared');
  const auth = request && request.auth;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  assertNotViewer(auth.token || {});
  const data = (request && request.data) || {};
  const invoiceId = typeof data.invoiceId === 'string' ? data.invoiceId : '';
  const paymentId = typeof data.paymentId === 'string' ? data.paymentId : '';
  const reason = cleanReason(data.reason);
  if (!ID_RE.test(invoiceId)) throw new HttpsError('invalid-argument', 'invoiceId is required');
  if (!PAYMENT_ID_RE.test(paymentId)) throw new HttpsError('invalid-argument', 'paymentId is required');
  if (!reason) throw new HttpsError('invalid-argument', 'Say why the payment is reversed');

  const db = (deps && deps.db) || require('firebase-admin/firestore').getFirestore();
  const now = (deps && deps.now) || new Date();
  const ref = db.collection('invoices').doc(invoiceId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found');
    const inv = snap.data() || {};
    // The same answer for "no such invoice in your company" and "not yours to reverse": nothing leaks across tenants.
    if (!ownerSideFor(auth, inv)) throw new HttpsError('permission-denied', 'Only the owner can reverse a payment.');
    const list = Array.isArray(inv.payments) ? inv.payments : [];
    const index = list.findIndex((p) => p && p.paymentId === paymentId && p.reversal !== true);
    if (index < 0) throw new HttpsError('failed-precondition', 'That payment changed — reopen the invoice and try again');
    let plan;
    try { plan = planReversal(inv, index, { reason, by: auth.uid, now }); }
    catch (e) { throw new HttpsError('failed-precondition', (e && e.message) || 'This payment cannot be reversed'); }
    tx.update(ref, plan.patch);
    return { plan, cents: -Math.round(plan.entry.amount * 100) };
  });
  try {
    require('firebase-functions/v2').logger.info('payment_reversed', {
      invoiceId, paymentId, cents: result.cents, byUid: auth.uid, status: result.plan.patch.status,
    });
  } catch (_) { /* logging never fails the reversal */ }
  return { ok: true, amountPaid: result.plan.patch.amountPaid, balanceDue: result.plan.patch.balanceDue, status: result.plan.patch.status };
}

const { onCall } = require('firebase-functions/v2/https');

module.exports = {
  MANUAL_METHODS, REASON_MAX,
  reversedPaymentIds, reversalBlockedReason, planReversal, ownerSideFor, handleReversePayment,
  reversePayment: onCall(
    {
      region: 'us-central1',
      cors: ['https://nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app'],
      enforceAppCheck: true,
      timeoutSeconds: 15,
      memory: '256MiB', // never below 256MiB: a 128MiB gen2 fails its startup healthcheck
    },
    require('./tenant-guard').wrapCallable((request) => handleReversePayment(request))
  ),
};
