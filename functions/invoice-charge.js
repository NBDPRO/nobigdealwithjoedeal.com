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
  if (depLeftC > 0) return { kind: 'deposit', chargeCents: depLeftC, balanceCents: balanceC, depositLeftCents: depLeftC };
  return { kind: 'balance', chargeCents: balanceC, balanceCents: balanceC, depositLeftCents: 0 };
}

/**
 * The homeowner portal's Balance Due card for one owed invoice (portal.js
 * getPortalView). payUrl = the link already through the Kentucky hold
 * (ky-insurance-law.js payUrlUnlessHeld) — a held invoice has payUrl '' and
 * gets no link and no "on its way" promise.
 *
 * Pay Now is offered only when the link charges exactly what is due NOW
 * (createStripePaymentLink stamps every mint, functions/stripe.js):
 *   - stripeChargeCents must equal the cents due now, AND
 *   - stripeChargeKind (when stamped) must be the kind due now — a link
 *     minted for the DEPOSIT is never the balance link, even when a 50%
 *     deposit makes the two amounts equal (review R6-2-6, 2026-10-07: the
 *     spent $6,000 deposit link was offered as "Balance Due $6,000"), AND
 *   - no money has landed since the mint: stripeChargePaidCents (amount
 *     already paid when it was minted) must still equal amountPaid. A paid
 *     link that a later change leaves at the same cents owed is spent.
 * A link stamped before stripeChargeKind / stripeChargePaidCents existed is
 * judged on what it carries; an unstamped link (minted before 2026-10-06)
 * charged total - amountPaid, so it fits only a plain balance with nothing
 * paid yet.
 * When a link was sent but no longer fits, linkPending is true: the page
 * says "Your balance link is on its way" instead of offering the spent one.
 * @returns {{ amountCents, kind: 'deposit'|'balance', totalOwedCents,
 *             stripePaymentLink: string|null, linkPending: boolean }}
 */
function portalBalanceCard(inv, payUrl) {
  const i = inv || {};
  const due = chargeDueNow(i);
  const num = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const paidC = Math.max(0, _c(i.amountPaid));
  const hasUrl = /^https:\/\//i.test(String(payUrl || ''));
  let fits;
  if (num(i.stripeChargeCents)) {
    fits = Math.round(Number(i.stripeChargeCents)) === due.chargeCents
      && (!i.stripeChargeKind || i.stripeChargeKind === due.kind)
      && (!num(i.stripeChargePaidCents) || Math.round(Number(i.stripeChargePaidCents)) === paidC);
  } else {
    fits = due.kind === 'balance' && paidC === 0;
  }
  const live = fits && due.chargeCents > 0 && hasUrl;
  return {
    amountCents: due.kind === 'none' ? Math.max(0, _c(i.balanceDue)) : due.chargeCents,
    kind: due.kind === 'deposit' ? 'deposit' : 'balance',
    totalOwedCents: due.balanceCents,
    stripePaymentLink: live ? String(payUrl) : null,
    linkPending: !live && hasUrl && due.chargeCents > 0,
  };
}

module.exports = { chargeDueNow, portalBalanceCard };
