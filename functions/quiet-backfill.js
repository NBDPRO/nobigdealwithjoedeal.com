/**
 * quiet-backfill.js — "was this job marked already completed after the fact?"
 * (schedule planner "Already completed", 2026-10-13).
 *
 * docs/pro/js/stage-write.js commitStageChange({ backfill }) moves a lead to
 * Install Done QUIETLY: it stamps completedAt, sets lead.completedBackfill and
 * appends a stageHistory event { to: 'install_complete', backfill: true }.
 * Jo's rule: nothing customer-facing, and no review ask, fires for it.
 *
 * Every server automation asks THIS, not the bare flag, because the flag is a
 * lead-level field while a customer can have several jobs (jobs-mirror copies
 * stageHistory per job but not the flag) and a job dragged back and finished
 * for real later must not stay muted:
 *
 *   quiet  ⇔  the MOST RECENT stageHistory entry that landed on
 *             install_complete was a backfill.
 *
 * With no install_complete entry in the history at all (a lead whose history
 * was never written, or was trimmed) the flag on the document decides.
 * PURE: no Firestore, no clock.
 */
'use strict';

/** @param {object} doc a lead or a job document */
function isQuietBackfill(doc) {
  if (!doc || typeof doc !== 'object') return false;
  // Payment backfill (2026-10-19, docs/pro/js/payment-backfill.js): a customer
  // created from a past check / Zelle / cash record is quiet FOR GOOD, whatever
  // its stage history says. No review ask, no portal rating, no anniversary
  // touch, no referral payout, no drafted customer paperwork.
  if (doc.paymentBackfill === true) return true;
  const h = Array.isArray(doc.stageHistory) ? doc.stageHistory : null;
  if (h) {
    for (let i = h.length - 1; i >= 0; i--) {
      const e = h[i];
      if (e && e.to === 'install_complete' && e.backfillUndo !== true) return e.backfill === true;
    }
  }
  return !!doc.completedBackfill;
}

/**
 * An invoice the payment backfill wrote (source 'backfill'): it records money that
 * was collected long ago, so no server automation may treat it as news (no spine
 * stage move, no filed invoice / receipt, no "paid but not closed" task, no
 * out-of-band mark). Only the timeline note is still written.
 */
function isBackfillInvoice(inv) {
  return !!inv && typeof inv === 'object' && (inv.source === 'backfill' || inv.backfilled === true);
}

/**
 * Any live invoice on the list is a payment-backfill invoice. A backfilled payment
 * can land on a REAL, unfinished customer ("same customer" in the backfill screen);
 * money recorded after the fact must not start the customer-facing clocks that
 * key off a payment date (review ask, referral credit, portal rating).
 */
function hasBackfillInvoice(invoices) {
  return (Array.isArray(invoices) ? invoices : []).some((i) => !!i && i.deleted !== true && isBackfillInvoice(i));
}

/** The invoices that are NOT payment-backfill invoices (the real money). */
function withoutBackfill(invoices) {
  return (Array.isArray(invoices) ? invoices : []).filter((i) => !isBackfillInvoice(i));
}

/**
 * Does a backfill invoice keep this customer from the customer-facing "job is done" steps
 * (portal rating, rep review nudge)? Yes when one is on the list AND the job is not paid in
 * full by REAL payments alone. A customer with a real, fully paid job who also had an old
 * check backfilled is unaffected. paidFn(lead, invoices) is the caller's own paid-in-full rule.
 */
function backfillBlocksRating(lead, invoices, paidFn) {
  const list = Array.isArray(invoices) ? invoices : [];
  if (!hasBackfillInvoice(list)) return false;
  const real = withoutBackfill(list).filter((i) => !!i && i.deleted !== true);
  const hasRealPayment = real.some((i) => (Array.isArray(i.payments) && i.payments.some((p) => p && Number(p.amount) > 0)) || String(i.status || '').toLowerCase() === 'paid');
  return !(hasRealPayment && paidFn(lead, real));
}

module.exports = { isQuietBackfill, isBackfillInvoice, hasBackfillInvoice, withoutBackfill, backfillBlocksRating };
