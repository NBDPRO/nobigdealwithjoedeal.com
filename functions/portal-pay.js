/**
 * functions/portal-pay.js — the homeowner portal's pay panel extras
 * (2026-11-04, documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md
 * Phase 3). Jo's decision: payment stays on Stripe's own secure page (a
 * Stripe Invoice for NBD, a single-use Payment Link for Connect tenants);
 * the portal explains it and comes back to life when the payment posts.
 * There is NO new charge path here — nothing in this file talks to Stripe.
 *
 * Adds two things to the balance card getHomeownerPortalView already builds
 * (invoice-charge.js portalBalanceCard):
 *   - processingCents: a bank (ACH) payment already in flight on this
 *     invoice (ach-payments.js achPending — never money until it clears).
 *     While it is set the Pay button is withheld, so nobody pays twice
 *     while the bank debit settles (3-5 business days).
 *   - invoiceNumber: the same number the Payments card shows.
 */
'use strict';

/** Pure. { processingCents, invoiceNumber } for the owed invoice. */
function payExtras(inv) {
  const i = inv || {};
  const p = i.achPending && typeof i.achPending === 'object' ? i.achPending : null;
  const c = p ? Math.round(Number(p.amountCents)) : 0;
  const num = String(i.invoiceNumber || (i.paper && i.paper.invoice && i.paper.invoice.instanceId) || '').trim().slice(0, 40);
  return { processingCents: Number.isFinite(c) && c > 0 ? c : 0, invoiceNumber: num || null };
}

/**
 * Pure. The balance card with the extras applied, or the card unchanged
 * when there is none. A processing bank payment blanks the pay link (and
 * linkPending, which would otherwise say a new link is on its way).
 */
function withPayExtras(balance, inv) {
  if (!balance) return balance;
  const x = payExtras(inv);
  const out = Object.assign({}, balance, x);
  if (x.processingCents > 0) {
    out.stripePaymentLink = null;
    out.linkPending = false;
    out.payByBank = false;
  }
  return out;
}

module.exports = { payExtras, withPayExtras };
