/**
 * invoice-charge.js — how much an online payment of this invoice charges
 * NOW (review R2-2-6, Jo 2026-10-06). Pure, cents in and out.
 *
 * An invoice that carries a deposit (depositAmount, deposit-rule.js — the
 * signing-day draft and the rep's Create Invoice both write it) used to be
 * "Deposit due" in text only: the Stripe link / Stripe invoice charged
 * total − amountPaid, so Pay Now on a $12,000 cash job charged $12,000 at
 * signing while the quote, contract and invoice said "50% due at signing".
 *
 * The rule:
 *   - a deposit that is not yet met (depositPaid not set and amountPaid <
 *     depositAmount) → charge the rest of the DEPOSIT;
 *   - otherwise → charge the outstanding balance (total − amountPaid);
 *   - never more than the balance due, never below zero.
 * A deposit equal to or above the total is no split (the whole invoice is
 * the deposit) — the balance is charged, as before.
 *
 * Callers: functions/stripe.js createStripePaymentLink (the amount Stripe
 * charges — the server is the source of truth) and functions/portal.js (the
 * homeowner portal's Balance Due card shows the same number). The Kentucky
 * insurance hold is a separate gate that runs before this and is unchanged.
 */
'use strict';

function _c(v) {
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object} inv  the CRM invoice doc (dollar fields)
 * @param {object} [o]  { totalCents } — the caller's reconciled total (stripe.js)
 * @returns {{ kind: 'deposit'|'balance'|'none', chargeCents: number,
 *             balanceCents: number, depositLeftCents: number }}
 */
function chargeDueNow(inv, o) {
  const i = inv || {};
  const paidC = Math.max(0, _c(i.amountPaid));
  // No total on the doc (a thin legacy / mirror row): what is owed + paid.
  const hasTotal = i.total != null && i.total !== '' && Number.isFinite(Number(i.total));
  const totalC = (o && o.totalCents != null) ? Math.round(Number(o.totalCents))
    : (hasTotal ? _c(i.total) : Math.max(0, _c(i.balanceDue)) + paidC);
  const balanceC = Math.max(0, totalC - paidC);
  const depC = Math.max(0, _c(i.depositAmount));
  const split = depC > 0 && depC < totalC;
  const depMet = i.depositPaid === true || paidC >= depC;
  const depLeftC = split && !depMet ? Math.min(depC - paidC, balanceC) : 0;
  if (!(balanceC > 0)) return { kind: 'none', chargeCents: 0, balanceCents: 0, depositLeftCents: 0 };
  // An insurance invoice made before the carrier's numbers were on the claim
  // (deposit-rule.js invoiceDeposit, 2026-10-07): nothing is charged — not
  // the whole job, which is what an invoice with no deposit used to charge.
  if (i.awaitingCarrierNumbers === true) return { kind: 'awaiting', chargeCents: 0, balanceCents: balanceC, depositLeftCents: 0 };
  if (depLeftC > 0) return { kind: 'deposit', chargeCents: depLeftC, balanceCents: balanceC, depositLeftCents: depLeftC };
  return { kind: 'balance', chargeCents: balanceC, balanceCents: balanceC, depositLeftCents: 0 };
}

/**
 * The homeowner portal's Balance Due card for one owed invoice (portal.js
 * getPortalView). payUrl = the link already through the Kentucky hold
 * (ky-insurance-law.js payUrlUnlessHeld). Pay Now is offered only when the
 * link charges exactly what is due now: createStripePaymentLink stamps
 * stripeChargeCents on every mint; an unstamped link (minted before
 * 2026-10-06) charged total - amountPaid, so it fits only a plain balance.
 *
 * hold = ky-insurance-law.js payLinkHold(lead, inv) (2026-10-07, money audit
 * H2). While a Kentucky insurance job is held, NOTHING is due: the card is
 * kind 'held' with amountCents 0 and no link, and carries what comes next
 * (nextCents — the deductible + first check, when the invoice knows it —
 * and the release date) so the portal can say "nothing is due yet — here is
 * what happens next" instead of "Balance due $13,250". An invoice waiting on
 * the carrier's numbers is kind 'awaiting', also $0 and no link.
 * @returns {{ amountCents, kind: 'deposit'|'balance'|'held'|'awaiting', totalOwedCents, stripePaymentLink,
 *             nextCents?, releaseDate? }}
 */
function portalBalanceCard(inv, payUrl, hold) {
  const i = inv || {};
  const due = chargeDueNow(i);
  if (hold && hold.held === true) {
    return {
      amountCents: 0, kind: 'held', totalOwedCents: 0, stripePaymentLink: null,
      nextCents: due.kind === 'deposit' ? due.chargeCents : null,
      releaseDate: String(hold.releaseDate || ''),
    };
  }
  if (due.kind === 'awaiting') {
    return { amountCents: 0, kind: 'awaiting', totalOwedCents: 0, stripePaymentLink: null };
  }
  const stamped = i.stripeChargeCents != null && i.stripeChargeCents !== '' && Number.isFinite(Number(i.stripeChargeCents));
  const fits = stamped ? Math.round(Number(i.stripeChargeCents)) === due.chargeCents : due.kind === 'balance';
  const url = (fits && due.chargeCents > 0 && /^https:\/\//i.test(String(payUrl || ''))) ? String(payUrl) : null;
  return {
    amountCents: due.kind === 'none' ? Math.max(0, _c(i.balanceDue)) : due.chargeCents,
    kind: due.kind === 'deposit' ? 'deposit' : 'balance',
    totalOwedCents: due.balanceCents,
    stripePaymentLink: url,
  };
}

module.exports = { chargeDueNow, portalBalanceCard };
