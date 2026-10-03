/**
 * integrations/erasure-billing.js — stop Stripe billing before an account is
 * erased (legal-checklist audit, 2026-10-03).
 *
 * THE BUG
 *   confirmAccountErasure deleted `subscriptions/{uid}` — the ONLY place the
 *   app keeps the Stripe customer + subscription ids — and never told Stripe.
 *   The subscription kept renewing every month against the card on file for
 *   a person whose account no longer existed, and once the doc was gone
 *   nothing in the CRM could even find the subscription to cancel it. A user
 *   who exercised their right to erasure kept being billed.
 *
 * THE RULE
 *   Before any data is deleted, every live Stripe subscription tied to the
 *   erased user's own billing doc is cancelled immediately. If that cannot be
 *   confirmed (Stripe unreachable, key unset, any error other than "already
 *   gone"), erasure is REFUSED with a clear message and nothing is deleted —
 *   a half-finished erasure that leaves the billing running is the exact
 *   failure being fixed, so "probably fine" is not an answer here.
 *
 * SCOPE
 *   Only `subscriptions/{uid}` — the doc the erasure cascade itself deletes
 *   (user-owned.js OWNER_KEYED_DOCS). For a solo owner that IS the company's
 *   billing doc (companyId == uid). A company_admin or rep whose company is
 *   billed under someone else's uid is not the payer: erasing their personal
 *   account must not cancel the company's plan, and doesn't, because their
 *   own `subscriptions/{uid}` has no Stripe ids.
 *
 * Pure and dependency-injected (db + a Stripe client factory) so it is
 * unit-tested with fakes — tests/account-erasure-billing.test.js. No real
 * Stripe call is ever made from a test.
 */
'use strict';

// Statuses Stripe can still charge on (or will, after a trial / dunning).
// Mirrors stripe.js LIVE_SUB_STATUS / CONNECT_MINT_LIVE_SUB, plus `paused`,
// which resumes billing on its own.
const CANCELLABLE = Object.freeze(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

function isResourceMissing(e) {
  return !!e && (e.code === 'resource_missing' || e.statusCode === 404);
}

/**
 * Cancel every live Stripe subscription the erased user pays for.
 *
 * @param {object}   args
 * @param {object}   args.db         Firestore-shaped ({ doc(p).get() })
 * @param {string}   args.uid        the account being erased
 * @param {Function} args.getStripe  () => Stripe client; only called when
 *                                   there is something to cancel
 * @param {object}   [args.logger]
 * @returns {Promise<{ok: boolean, cancelled: string[], reason: string}>}
 *   ok:false means DO NOT ERASE — billing may still be running.
 */
async function cancelBillingForErasure(args) {
  const a = args || {};
  const log = a.logger || { info() {}, warn() {}, error() {} };
  const uid = String(a.uid || '');
  if (!uid || uid.indexOf('/') !== -1) return { ok: false, cancelled: [], reason: 'bad_uid' };

  let sub;
  try {
    const snap = await a.db.doc('subscriptions/' + uid).get();
    sub = snap && snap.exists ? (snap.data() || {}) : null;
  } catch (e) {
    // Can't tell whether there is a subscription → can't promise there isn't.
    log.error('erasure_billing_read_failed', { uid, err: e && e.message });
    return { ok: false, cancelled: [], reason: 'billing_record_unreadable' };
  }
  const subId = sub && typeof sub.stripeSubscriptionId === 'string' ? sub.stripeSubscriptionId : '';
  const customerId = sub && typeof sub.stripeCustomerId === 'string' ? sub.stripeCustomerId : '';
  if (!subId && !customerId) return { ok: true, cancelled: [], reason: 'no_stripe_billing' };

  let stripe;
  try { stripe = a.getStripe(); } catch (e) {
    log.error('erasure_billing_no_client', { uid, err: e && e.message });
    return { ok: false, cancelled: [], reason: 'stripe_unavailable' };
  }

  // Candidate ids: the stored one, plus anything else live on the customer
  // (the double-bill guard exists because a second sub CAN be minted — an
  // orphaned one would keep charging after the doc that names it is gone).
  const ids = new Set();
  if (subId) ids.add(subId);
  try {
    if (customerId) {
      const list = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
      for (const s of (list && list.data) || []) {
        if (s && s.id && CANCELLABLE.indexOf(String(s.status)) !== -1) ids.add(s.id);
      }
    }
  } catch (e) {
    if (!isResourceMissing(e)) {
      log.error('erasure_billing_list_failed', { uid, err: e && e.message });
      return { ok: false, cancelled: [], reason: 'stripe_error' };
    }
  }

  const cancelled = [];
  for (const id of ids) {
    try {
      const cur = await stripe.subscriptions.retrieve(id);
      if (!cur || CANCELLABLE.indexOf(String(cur.status)) === -1) continue; // canceled / incomplete_expired
      await stripe.subscriptions.cancel(id);
      cancelled.push(id);
    } catch (e) {
      if (isResourceMissing(e)) continue; // already gone at Stripe — nothing to bill
      log.error('erasure_billing_cancel_failed', { uid, subscriptionId: id, err: e && e.message });
      return { ok: false, cancelled, reason: 'stripe_error' };
    }
  }
  log.info('erasure_billing_cancelled', { uid, cancelled });
  return { ok: true, cancelled, reason: cancelled.length ? 'cancelled' : 'nothing_live' };
}

/** What the data subject is told when erasure is refused for billing. */
const REFUSAL_MESSAGE =
  'We could not confirm your NBD Pro subscription was cancelled, so nothing has been deleted yet '
  + '(deleting your account while billing is still active would leave you being charged). '
  + 'Please try again in a few minutes, or cancel from Settings → Billing first. '
  + 'If this keeps happening, email jd@nobigdealwithjoedeal.com.';

module.exports = { cancelBillingForErasure, CANCELLABLE, REFUSAL_MESSAGE };
