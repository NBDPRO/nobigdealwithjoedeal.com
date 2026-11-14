/**
 * connect-refund-logic.js — a refund on a Connect tenant's (contractor's)
 * invoice, as an invoice patch. Pure; stripe.js invoiceWebhook does the I/O
 * (charge.refunded) and the tenant checks.
 *
 * Joe, 2026-11-14: a refund on a Connect invoice marks it refunded or partly
 * refunded and puts the amount back into what's owed, instead of leaving it
 * paid. Same record the owner's Stripe ledger writes (stripe-ledger.js
 * recordMoneyBack): invoices/{id}.refunds[] keyed by the Stripe refund id,
 * plus refundedTotal. Revenue readers subtract refunds[] on its own date
 * (collected-revenue.js refundsOf) and read payments[] for what came in, so
 * payments[] is NEVER touched here — the refund is subtracted exactly once.
 * What this adds over the ledger is the balance: amountPaid comes down and
 * balanceDue goes up by the refunded amount (cents math, the ACH-return
 * shape in ach-payments.js planAchRevert), so a payment link bills
 * (total − amountPaid) = the reopened amount again.
 *
 * Status stays inside firestore.rules invoiceStatusWord: 'paid' when nothing
 * is owed, 'partial' when some is still paid, 'sent' when nothing is (the
 * word an ACH return writes). The "refunded" label is a separate field,
 * refundStatus: 'refunded' | 'partly_refunded' | null.
 *
 * Idempotent: the balance moves by the CHANGE in counted refunds for the
 * refund ids passed in, so a retried webhook with the same refunds is a
 * no-op (→ null), and a refund that later fails gives the money back.
 */
'use strict';

const cents = (v) => Math.round((Number(v) || 0) * 100);
// Same "returned money" test as recordMoneyBack / refundsOf.
const counts = (r) => !!r && r.status !== 'failed' && r.status !== 'canceled' && r.status !== 'won';
const CLOSED = { void: 1, voided: 1, cancelled: 1, canceled: 1, draft: 1 };

/**
 * inv = the invoice doc; stripeRefunds = Stripe Refund objects for the charge
 * ({ id, amount (cents), status, created (seconds) }); opts.chargeId optional.
 * → null (nothing to write) or { patch, deltaCents, reopened }.
 */
function planConnectRefund(inv, stripeRefunds, opts) {
  if (!inv) return null;
  const o = opts || {};
  const list = (Array.isArray(inv.refunds) ? inv.refunds : []).map((x) => Object.assign({}, x));
  let changed = false;
  let priorC = 0;
  let nextC = 0;
  for (const r of Array.isArray(stripeRefunds) ? stripeRefunds : []) {
    const id = r && r.id ? String(r.id) : '';
    const amtC = Math.max(0, Math.round(Number(r && r.amount) || 0));
    if (!id || amtC <= 0) continue;
    const entry = {
      amount: amtC / 100,
      at: new Date((Number(r.created) || 0) * 1000),
      stripeRef: id,
      status: r.status || 'succeeded',
      kind: 'refund',
    };
    if (o.chargeId) entry.chargeId = String(o.chargeId);
    const i = list.findIndex((x) => x && x.stripeRef === id);
    if (i > -1) {
      if (counts(list[i])) priorC += cents(list[i].amount);
      if (list[i].status !== entry.status || cents(list[i].amount) !== amtC) {
        list[i] = Object.assign({}, list[i], entry);
        changed = true;
      }
      if (counts(list[i])) nextC += cents(list[i].amount);
    } else {
      list.push(entry);
      changed = true;
      if (counts(entry)) nextC += amtC;
    }
  }
  if (!changed) return null;

  const refundedC = list.filter(counts).reduce((t, x) => t + cents(x.amount), 0);
  const deltaC = nextC - priorC;
  const patch = { refunds: list, refundedTotal: refundedC / 100 };

  // A voided / cancelled / draft / deleted invoice is not owed — record the
  // refund (revenue stays right) but never reopen it.
  const closed = inv.deleted === true || !!CLOSED[String(inv.status || '').toLowerCase()];
  let paidC = cents(inv.amountPaid);
  if (deltaC !== 0 && !closed) {
    const totalC = cents(Math.max(0, Number(inv.total) || 0));
    paidC = Math.max(0, paidC - deltaC);
    const balC = Math.max(0, totalC - paidC);
    const paidInFull = totalC > 0 && balC === 0;
    const depC = cents(inv.depositAmount);
    patch.amountPaid = paidC / 100;
    patch.balanceDue = balC / 100;
    patch.status = paidInFull ? 'paid' : (paidC > 0 ? 'partial' : 'sent');
    patch.paidAt = paidInFull ? (inv.paidAt || null) : null;
    patch.depositPaid = depC > 0 ? paidC >= depC : paidC > 0;
  }
  patch.refundStatus = refundedC > 0 ? (paidC > 0 ? 'partly_refunded' : 'refunded') : null;
  return { patch, deltaCents: closed ? 0 : deltaC, reopened: !closed && deltaC > 0 };
}

module.exports = { planConnectRefund };
