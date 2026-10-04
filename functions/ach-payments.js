/**
 * ach-payments.js — homeowners can pay by bank (ACH) (Jo, 2026-10-04).
 *
 * 1. OFFER IT. Every place the CRM makes something a homeowner pays — the
 *    CRM's Stripe Invoice (stripe-crm-invoice.js) and the Connect payment
 *    link (stripe.js createStripePaymentLink) — asks for card + Link +
 *    us_bank_account. (BoldSign's e-sign auto-invoice, integrations/esign.js,
 *    was retired in #2166, so it no longer mints a Stripe invoice.)
 *    ACH must be switched on in Jo's Stripe dashboard first; until it is,
 *    Stripe refuses the payment-method list, and createWithAch steps down
 *    (card + bank → no list at all = the account's own defaults, exactly
 *    what these calls did before). A missing dashboard switch never stops an
 *    invoice going out.
 *
 * 2. PROCESSING IS NOT MONEY. ACH takes 4–5 business days to settle and can
 *    fail at the end. A payment_intent.processing only marks the CRM invoice
 *    `achPending` (shown as "bank payment processing"); it never touches
 *    payments[] / amountPaid / balanceDue, so it is not collected revenue
 *    (collected-revenue.js reads payments[] — the collected-only rule).
 *    The credit still happens where it always did, on success
 *    (payment_intent.succeeded / the ledger's charge.succeeded).
 *
 * 3. A FAILED ACH REVERTS. payment_intent.payment_failed / charge.failed for
 *    a bank debit takes that payment back OFF the invoice if it was credited
 *    (planAchRevert — amountPaid, balanceDue, status recomputed in cents),
 *    clears achPending, and alerts Jo once (internal email + lead activity;
 *    nothing to the homeowner). The keys that credited it stay recorded, so
 *    a re-delivered success can never credit it again.
 *
 * No Stripe API call is made from here except the create the caller hands
 * in; no dashboard setting is changed.
 */
'use strict';

const ACH = 'us_bank_account';

// Most → least: what to ask Stripe for. null = pass no list (the account's
// own payment-method settings decide — the pre-2026-10-04 behaviour).
const PM_VARIANTS = Object.freeze([
  Object.freeze(['card', 'link', ACH]),
  Object.freeze(['card', ACH]),
  null,
]);

const cents = (v) => Math.round((Number(v) || 0) * 100);

/** Stripe's refusal of a payment-method list (type not activated / not allowed). */
function isPaymentMethodTypeError(e) {
  if (!e) return false;
  const t = String(e.type || e.rawType || '');
  if (t && !/invalid_request|InvalidRequest/i.test(t)) return false;
  const hay = String(e.param || '') + ' ' + String(e.message || '') + ' ' + String(e.code || '');
  return /payment_method_types|payment method type|payment_method_type|us_bank_account|\blink\b/i.test(hay);
}

/**
 * Create with ACH offered, stepping down on a payment-method refusal.
 *   create(params, requestOpts) — the Stripe call (e.g. stripe.invoices.create)
 *   params — the base params; apply(params, types) returns the params for a
 *            variant (types null → leave them alone)
 *   requestOpts — { idempotencyKey } for the FIRST variant; later variants get
 *            '-pm1' / '-pm2' appended (different params need their own key).
 * → { result, paymentMethodTypes }  (paymentMethodTypes null = account defaults)
 */
async function createWithAch(create, params, apply, requestOpts, logger) {
  let lastErr = null;
  for (let i = 0; i < PM_VARIANTS.length; i++) {
    const types = PM_VARIANTS[i];
    const p = apply(Object.assign({}, params), types ? types.slice() : null);
    let ro = requestOpts;
    if (requestOpts && requestOpts.idempotencyKey && i > 0) ro = Object.assign({}, requestOpts, { idempotencyKey: requestOpts.idempotencyKey + '-pm' + i });
    try {
      const result = ro ? await create(p, ro) : await create(p);
      return { result, paymentMethodTypes: types ? types.slice() : null };
    } catch (e) {
      if (!isPaymentMethodTypeError(e) || i === PM_VARIANTS.length - 1) throw e;
      lastErr = e;
      if (logger && logger.warn) logger.warn('ach_payment_methods_refused', { variant: i, types, err: e.message });
    }
  }
  throw lastErr || new Error('createWithAch: no variant');
}

/** Stripe Invoice params → ask for these methods. */
function applyToInvoice(p, types) {
  if (types) p.payment_settings = Object.assign({}, p.payment_settings || {}, { payment_method_types: types });
  return p;
}
/** Payment Link params → ask for these methods. */
function applyToPaymentLink(p, types) {
  if (types) p.payment_method_types = types;
  return p;
}

const offersAch = (types) => Array.isArray(types) && types.indexOf(ACH) !== -1;

/** Was this PaymentIntent / its failure a bank debit? */
function isAchIntent(pi) {
  if (!pi) return false;
  const err = pi.last_payment_error || {};
  const pm = (err.payment_method && err.payment_method.type) || (pi.payment_method && pi.payment_method.type) || '';
  if (pm) return pm === ACH;
  const types = Array.isArray(pi.payment_method_types) ? pi.payment_method_types : [];
  return types.length === 1 && types[0] === ACH;
}
function isAchCharge(ch) {
  return !!(ch && ch.payment_method_details && ch.payment_method_details.type === ACH);
}

/** The invoice patch for "this PaymentIntent is processing" (not money yet). */
function achPendingPatch(pi, nowMs) {
  return {
    achPending: {
      paymentIntentId: String(pi.id),
      amountCents: Math.max(0, Math.round(Number(pi.amount) || 0)),
      since: new Date(nowMs || Date.now()),
    },
  };
}

/**
 * Take a failed bank payment back off a CRM invoice. Pure.
 * ref = { paymentIntentId, chargeId }. → null (nothing credited and nothing
 * pending: nothing to do) or { patch, removedCents, clearedPending }.
 */
function planAchRevert(inv, ref, nowMs) {
  if (!inv || !ref) return null;
  const pi = ref.paymentIntentId ? String(ref.paymentIntentId) : '';
  const ch = ref.chargeId ? String(ref.chargeId) : '';
  const pays = Array.isArray(inv.payments) ? inv.payments : [];
  const hit = (p) => !!p && ((pi && p.paymentIntentId === pi) || (ch && (p.stripeRef === ch || p.chargeId === ch)));
  const removed = pays.filter(hit);
  const pending = inv.achPending && typeof inv.achPending === 'object' ? inv.achPending : null;
  const clearedPending = !!(pending && pi && pending.paymentIntentId === pi);
  if (!removed.length) return clearedPending ? { patch: { achPending: null }, removedCents: 0, clearedPending: true } : null;
  const removedCents = removed.reduce((s, p) => s + cents(p.amount), 0);
  const totalC = cents(Math.max(0, Number(inv.total) || 0));
  const paidC = Math.max(0, cents(inv.amountPaid) - removedCents);
  const balC = Math.max(0, totalC - paidC);
  const paidInFull = totalC > 0 && balC === 0;
  const depC = cents(inv.depositAmount);
  const returns = Array.isArray(inv.achReturns) ? inv.achReturns.slice() : [];
  returns.push({ paymentIntentId: pi || null, chargeId: ch || null, amount: removedCents / 100, at: new Date(nowMs || Date.now()) });
  const patch = {
    payments: pays.filter((p) => !hit(p)),
    amountPaid: paidC / 100,
    balanceDue: balC / 100,
    status: paidInFull ? 'paid' : (paidC > 0 ? 'partial' : 'sent'),
    paidAt: paidInFull ? (inv.paidAt || null) : null,
    depositPaid: depC > 0 ? paidC >= depC : paidC > 0,
    achReturns: returns,
  };
  if (pending && (!pi || pending.paymentIntentId === pi)) patch.achPending = null;
  return { patch, removedCents, clearedPending: 'achPending' in patch };
}

const ACH_EVENTS = new Set(['payment_intent.processing', 'payment_intent.succeeded', 'payment_intent.payment_failed', 'charge.failed']);

/** The CRM invoice a Stripe object belongs to → DocumentReference or null. */
async function _findInvoiceRef(db, { invoiceId, stripeInvoiceId, paymentIntentId, chargeId }) {
  const col = db.collection('invoices');
  if (invoiceId) return col.doc(String(invoiceId));
  const tries = [];
  if (chargeId) tries.push(['stripeCreditKeys', 'array-contains', String(chargeId)]);
  if (paymentIntentId) tries.push(['paidIntentIds', 'array-contains', String(paymentIntentId)]);
  if (paymentIntentId) tries.push(['achPending.paymentIntentId', '==', String(paymentIntentId)]);
  if (stripeInvoiceId) tries.push(['stripeInvoiceId', '==', String(stripeInvoiceId)]);
  for (const [f, op, v] of tries) {
    const snap = await col.where(f, op, v).limit(1).get();
    if (!snap.empty) return snap.docs[0].ref;
  }
  return null;
}

function _money(c) { return '$' + (Math.max(0, Number(c) || 0) / 100).toFixed(2); }

/**
 * The ACH half of invoiceWebhook (stripe.js), called after the Stripe ledger.
 * deps = { logger, now, alert(opts) } — alert is stripe.js
 * alertInvoicePaymentEvent (internal email_queue + lead activity).
 * → { handled: boolean, ... } — handled:true on a payment_failed means the
 * caller must NOT also send its "card declined" alert.
 * Throws on a Firestore failure so the caller's catch releases the event
 * marker and Stripe retries; every step is idempotent.
 */
async function handleAchEvent(db, event, deps) {
  const d = deps || {};
  const logger = d.logger || { info() {}, warn() {}, error() {} };
  const nowMs = typeof d.now === 'function' ? d.now() : Date.now();
  if (!db || !event || !ACH_EVENTS.has(event.type) || event.account) return { handled: false, skipped: 'not_ach_event' };
  const obj = (event.data && event.data.object) || {};
  const isPi = event.type.indexOf('payment_intent.') === 0;
  const pi = isPi ? obj : null;
  const ch = isPi ? null : obj;
  const meta = (obj.metadata && typeof obj.metadata === 'object') ? obj.metadata : {};
  const paymentIntentId = pi ? pi.id : (ch.payment_intent && (ch.payment_intent.id || ch.payment_intent)) || null;
  const chargeId = ch ? ch.id : null;
  const stripeInvoiceId = (obj.invoice && (obj.invoice.id || obj.invoice)) || null;

  if (event.type === 'charge.failed' && !isAchCharge(ch)) return { handled: false, skipped: 'not_ach' };
  const piOffersAch = !!(pi && Array.isArray(pi.payment_method_types) && pi.payment_method_types.indexOf(ACH) !== -1);
  if (event.type === 'payment_intent.processing' && !piOffersAch) return { handled: false, skipped: 'not_ach' };
  // A card payment on a link / subscription billing: nothing for this module
  // (and no lookups spent on it).
  if (event.type === 'payment_intent.succeeded' && !piOffersAch) return { handled: false, skipped: 'not_ach' };
  if (event.type === 'payment_intent.payment_failed' && !piOffersAch && !isAchIntent(pi)) return { handled: false, skipped: 'not_ach' };

  const ref = await _findInvoiceRef(db, { invoiceId: meta.invoiceId, stripeInvoiceId, paymentIntentId, chargeId });

  if (event.type === 'payment_intent.processing') {
    if (!ref) return { handled: false, skipped: 'no_invoice' };
    const r = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return { skipped: 'not_found' };
      const inv = s.data() || {};
      const already = (Array.isArray(inv.paidIntentIds) && inv.paidIntentIds.indexOf(pi.id) !== -1);
      if (already) return { skipped: 'already_credited' };
      tx.update(ref, Object.assign(achPendingPatch(pi, nowMs), { updatedAt: new Date(nowMs) }));
      return { pending: true };
    });
    logger.info('ach_processing', { paymentIntentId: pi.id, result: r });
    return Object.assign({ handled: true }, r);
  }

  if (event.type === 'payment_intent.succeeded') {
    if (!ref) return { handled: false, skipped: 'no_invoice' };
    const r = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return { skipped: 'not_found' };
      const inv = s.data() || {};
      if (!(inv.achPending && inv.achPending.paymentIntentId === pi.id)) return { skipped: 'no_pending' };
      tx.update(ref, { achPending: null, updatedAt: new Date(nowMs) });
      return { cleared: true };
    });
    return Object.assign({ handled: false }, r);
  }

  // payment_intent.payment_failed / charge.failed (bank debit)
  let inv = null;
  let plan = null;
  let invoiceId = null;
  if (ref) {
    invoiceId = ref.id;
    const r = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const cur = s.data() || {};
      const p = planAchRevert(cur, { paymentIntentId, chargeId }, nowMs);
      if (p) tx.update(ref, Object.assign({}, p.patch, { updatedAt: new Date(nowMs) }));
      return { cur, p };
    });
    if (r) { inv = r.cur; plan = r.p; }
  }
  const wasAch = (pi && isAchIntent(pi)) || (ch && isAchCharge(ch))
    || !!(inv && inv.achPending && paymentIntentId && inv.achPending.paymentIntentId === paymentIntentId)
    || !!(plan && plan.removedCents > 0);
  if (!wasAch) return { handled: false, skipped: 'not_ach' };

  // One alert per failed bank payment, however many events report it.
  const markerId = 'ach-' + String(paymentIntentId || chargeId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  let fresh = true;
  try {
    await db.collection('ach_failures').doc(markerId).create({
      paymentIntentId: paymentIntentId || null, chargeId: chargeId || null, invoiceId,
      revertedCents: plan ? plan.removedCents : 0, at: new Date(nowMs),
    });
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) fresh = false;
    else throw e;
  }
  const amountC = plan && plan.removedCents ? plan.removedCents
    : (pi ? (pi.amount || 0) : (ch.amount || 0));
  const errCode = pi ? ((pi.last_payment_error && (pi.last_payment_error.code || pi.last_payment_error.decline_code)) || 'unknown')
    : (ch.failure_code || 'unknown');
  if (fresh && typeof d.alert === 'function') {
    const owedLine = plan && plan.removedCents > 0
      ? 'It had been recorded as paid — it is now taken back off the invoice, which shows ' + _money(cents(plan.patch.balanceDue)) + ' owed.'
      : 'It was never counted as paid, so the invoice balance is unchanged.';
    const label = (inv && (inv.invoiceNumber || (inv.paper && inv.paper.invoice && inv.paper.invoice.instanceId) || inv.stripeInvoiceNumber)) || invoiceId || 'n/a';
    try {
      await d.alert({
        uid: (inv && inv.createdBy) || meta.userId || null,
        leadId: (inv && inv.leadId) || null,
        invoiceId,
        source: 'stripe_ach_failed',
        emailSubject: 'Bank payment (ACH) failed — ' + _money(amountC) + ' — NBD Pro',
        emailBody:
          'A homeowner\'s bank payment (ACH) did not go through.\n\n' +
          'Invoice: ' + label + '\n' +
          'Amount:  ' + _money(amountC) + '\n' +
          'Reason code: ' + errCode + '\n\n' +
          owedLine + '\n' +
          'Nothing was sent to the customer. Reach out and send a fresh link, or record a check / Zelle under Record payment.',
        slackText: '🏦 Bank payment (ACH) failed (' + _money(amountC) + ')',
        slackBlocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*🏦 Bank payment (ACH) failed*\nAmount: *' + _money(amountC) + '*\nInvoice: `' + label + '`\nCode: `' + errCode + '`' } }],
        activity: {
          userId: (inv && inv.createdBy) || meta.userId || null,
          type: 'stripe_ach_failed',
          label: 'Bank payment (ACH) failed (' + _money(amountC) + ')' + (plan && plan.removedCents > 0 ? ' — taken off the invoice' : ''),
          paymentIntentId: paymentIntentId || null,
          chargeId: chargeId || null,
          errorCode: errCode,
          amountCents: amountC,
          internalOnly: true,
        },
      });
    } catch (e) {
      logger.warn('ach_failed_alert_failed', { err: e && e.message });
    }
  }
  logger.warn('ach_payment_failed', { paymentIntentId, chargeId, invoiceId, revertedCents: plan ? plan.removedCents : 0, alerted: fresh });
  return { handled: true, reverted: !!(plan && plan.removedCents > 0), revertedCents: plan ? plan.removedCents : 0, alerted: fresh, invoiceId };
}

module.exports = {
  ACH, PM_VARIANTS, ACH_EVENTS, isPaymentMethodTypeError, createWithAch, applyToInvoice, applyToPaymentLink, offersAch,
  isAchIntent, isAchCharge, achPendingPatch, planAchRevert, handleAchEvent,
};
