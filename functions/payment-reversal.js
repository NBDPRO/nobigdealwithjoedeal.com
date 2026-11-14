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
 * WHO (Joe, 2026-11-14): the OWNER of the invoice's company only —
 * companies/{id}.ownerId, or a solo owner whose company is keyed by their own
 * uid. Not another company_admin, a manager, a rep, a viewer or a platform
 * admin. A reason is required.
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

// Which payments a reversal cancels, from frozen fields only: functions/reversal-pairs.js.
const { reversalPairs } = require('./reversal-pairs');

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
  if (!(cents(p.amount) > 0)) return 'That entry is not a payment';
  // recordedBy is set on every payment typed in the CRM (the rules force it) and frozen; no Stripe / ACH
  // server writer sets it. Keyed on it rather than on stripeRef / source, which an editor could strip.
  if (p.method === 'stripe' || p.paymentIntentId || p.stripeRef || p.source === 'stripe_ledger'
      || typeof p.recordedBy !== 'string' || !p.recordedBy) {
    return 'Card and bank payments made online are refunded in Stripe, not reversed here';
  }
  if (!MANUAL_METHODS.includes(p.method)) return 'Only check, Zelle, cash, card, ACH or other payments typed in here can be reversed';
  if (typeof p.paymentId !== 'string' || !PAYMENT_ID_RE.test(p.paymentId)) {
    return 'This older payment has no id to reverse — ask for help fixing it';
  }
  if (reversalPairs(list).has(index)) return 'That payment is already reversed';
  if (!(tsMs(p.at) > 0)) return 'That payment has no date';
  const st = String(inv.status || '').toLowerCase();
  if (st === 'sending') return 'The invoice is being sent — try again in a minute';
  if (inv.deleted === true || st === 'void' || st === 'cancelled') return 'The invoice is voided';
  // The rules let a browser edit a payments list of at most 15; past that the invoice would lock.
  if (list.length >= 15) return 'This invoice has too many payment lines to add a reversal — ask for help';
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
  // Nothing paid any more: back to the status the money moved it off ('sent'), but an 'overdue' or
  // 'viewed' invoice keeps that word (only 'paid' / 'partial' were statuses the money set).
  const prior = String(inv.status || '').toLowerCase();
  const unpaidStatus = (prior === 'paid' || prior === 'partial' || !prior) ? 'sent' : inv.status;
  return {
    entry,
    patch: {
      payments: list,
      amountPaid: dollars(newPaidC),
      balanceDue: dollars(balC),
      depositPaid: depositC > 0 ? newPaidC >= depositC : newPaidC > 0,
      status: paid ? 'paid' : (newPaidC > 0 ? 'partial' : unpaidStatus),
      paidAt: paid ? (inv.paidAt == null ? null : inv.paidAt) : null,
      updatedAt: now,
    },
  };
}

/**
 * Is the caller the OWNER of this invoice's company? (Joe, 2026-11-14: only the
 * company owner may reverse a payment.) company = companies/{inv.companyId}
 * data, or null when there is no company doc. Pure.
 *   - a company doc: its ownerId must be the caller (another company_admin,
 *     a manager or a platform admin is not the owner);
 *   - no company doc: a solo owner, whose company is keyed by their own uid
 *     (and who carries no other company claim);
 *   - an invoice with no companyId: nobody (an ex-member could be its creator;
 *     such an invoice needs a hand fix).
 */
function isCompanyOwner(auth, inv, company) {
  if (!auth || !auth.uid || !inv) return false;
  const c = auth.token || {};
  if (c.role === 'viewer') return false;
  const cid = typeof inv.companyId === 'string' ? inv.companyId : '';
  if (company && typeof company === 'object') {
    return !!cid && typeof company.ownerId === 'string' && company.ownerId === auth.uid
      && (!c.companyId || c.companyId === cid);
  }
  if (!cid) return false;
  if (c.companyId && c.companyId !== auth.uid) return false;   // a claimed company that is not their own uid
  if (c.role && c.role !== 'company_admin') return false;
  return cid === auth.uid;
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
  // The amount the owner saw and confirmed: the entry must still carry it (paymentId alone is editable).
  const expectCents = Number(data.cents);
  if (!ID_RE.test(invoiceId)) throw new HttpsError('invalid-argument', 'invoiceId is required');
  if (!PAYMENT_ID_RE.test(paymentId)) throw new HttpsError('invalid-argument', 'paymentId is required');
  if (!reason) throw new HttpsError('invalid-argument', 'Say why the payment is reversed');
  if (!Number.isInteger(expectCents) || expectCents <= 0) throw new HttpsError('invalid-argument', 'cents is required');

  const db = (deps && deps.db) || require('firebase-admin/firestore').getFirestore();
  const now = (deps && deps.now) || new Date();
  const ref = db.collection('invoices').doc(invoiceId);
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    // A missing invoice gets the same answer as someone else's: nothing about other tenants leaks.
    if (!snap.exists) throw new HttpsError('permission-denied', 'Only the company owner can reverse a payment.');
    const inv = snap.data() || {};
    let company = null;
    if (typeof inv.companyId === 'string' && ID_RE.test(inv.companyId)) {
      const cs = await tx.get(db.collection('companies').doc(inv.companyId));
      company = cs.exists ? (cs.data() || {}) : null;
    }
    // The same answer for "not in your company" and "not the owner": nothing leaks across tenants.
    if (!isCompanyOwner(auth, inv, company)) throw new HttpsError('permission-denied', 'Only the company owner can reverse a payment.');
    const list = Array.isArray(inv.payments) ? inv.payments : [];
    const index = list.findIndex((p) => p && p.paymentId === paymentId && cents(p.amount) === expectCents);
    if (index < 0) throw new HttpsError('failed-precondition', 'That payment changed — reopen the invoice and try again');
    let plan;
    try { plan = planReversal(inv, index, { reason, by: auth.uid, now }); }
    catch (e) { throw new HttpsError('failed-precondition', (e && e.message) || 'This payment cannot be reversed'); }
    tx.update(ref, plan.patch);
    // The record nobody can edit: payments[] entries keep only amount, date, method and recorder frozen, so
    // the reason and who reversed what are kept here too (server-only: the rules' catch-all denies clients).
    tx.create(db.collection('payment_reversals').doc(invoiceId + '_' + plan.entry.paymentId), {
      invoiceId, companyId: inv.companyId, leadId: inv.leadId || null,
      paymentId, paymentIndex: index, cents: -Math.round(plan.entry.amount * 100),
      paymentAt: plan.entry.at, method: plan.entry.method, reason, byUid: auth.uid, at: now,
    });
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
  reversalPairs, reversalBlockedReason, planReversal, isCompanyOwner, handleReversePayment,
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
