/**
 * connect-refund-logic.js — a refund on a Connect tenant's (contractor's)
 * invoice, as an invoice patch. Pure; stripe.js invoiceWebhook does the I/O
 * (charge.refunded / charge.refund.updated) and the tenant checks.
 *
 * Joe, 2026-11-14: a refund on a Connect invoice marks it refunded or partly
 * refunded and puts the amount back into what's owed, instead of leaving it
 * paid.
 *
 * WHAT IT WRITES
 *  - invoices/{id}.refunds[]: one entry per Stripe refund, keyed by the
 *    refund id, the same shape the owner's Stripe ledger writes
 *    (stripe-ledger.js recordMoneyBack). Revenue readers subtract it on its
 *    own date (collected-revenue.js refundsOf). payments[] is never touched.
 *  - amountPaid down / balanceDue up by what the refund actually moved, so a
 *    payment link bills (total − amountPaid) = the reopened amount again.
 *  - refundReopenedTotal: everything refunds have moved into balanceDue.
 *    Revenue readers add it back to (total − balanceDue) (collectedDollarsOf
 *    and its mirrors), so the refund comes off revenue ONCE, via refunds[].
 *  - status inside firestore.rules invoiceStatusWord: 'paid' (nothing owed),
 *    'partial' (some still paid), 'sent' (nothing paid — the ACH-return word).
 *    The label is refundStatus: 'refunded' | 'partly_refunded' | null.
 *
 * WHAT IT TRUSTS. A rep may edit an invoice (refunds[], refundedTotal,
 * amountPaid … are client-writable). So what has ALREADY been applied lives
 * in a server-only record per refund, invoices/{id}/connectRefunds/{refundId}
 * (no rule matches it, so the default deny covers it):
 *   { countedCents, movedCents, status, amountCents, chargeId }
 * The money moves by the change against THAT record, never against
 * refunds[]. refunds[] is a display/revenue copy rebuilt from Stripe on every
 * delivery, so an edited entry is put back the next time Stripe speaks.
 *
 * Idempotent: the same refunds again → null. Clamped: a refund never takes
 * amountPaid below 0, and a refund that later fails gives back only what it
 * actually moved.
 */
'use strict';

const cents = (v) => Math.round((Number(v) || 0) * 100);
// Same "returned money" test as recordMoneyBack / refundsOf.
const counts = (status) => status !== 'failed' && status !== 'canceled' && status !== 'won';
const CLOSED = { void: 1, voided: 1, cancelled: 1, canceled: 1, draft: 1 };

/**
 * inv     the invoice doc
 * stripeRefunds  Stripe Refund objects for one charge ({ id, amount (cents), status, created (s) })
 * applied { [refundId]: record } — every connectRefunds record on this invoice
 * opts    { chargeId, nowMs }
 * → null (nothing to write) or { patch, records: { [refundId]: record }, movedCents }
 */
function planConnectRefund(inv, stripeRefunds, applied, opts) {
  if (!inv) return null;
  const o = opts || {};
  const prior = applied && typeof applied === 'object' ? applied : {};
  const list = (Array.isArray(inv.refunds) ? inv.refunds : []).map((x) => Object.assign({}, x));
  const closed = inv.deleted === true || !!CLOSED[String(inv.status || '').toLowerCase()];
  let paidC = Math.max(0, cents(inv.amountPaid));
  let movedTotal = 0;
  let listChanged = false;
  const records = {};

  for (const r of Array.isArray(stripeRefunds) ? stripeRefunds : []) {
    const id = r && r.id ? String(r.id) : '';
    const amtC = Math.max(0, Math.round(Number(r && r.amount) || 0));
    if (!id || amtC <= 0) continue;
    const status = r.status || 'succeeded';
    const hasDate = Number(r.created) > 0;

    // Money: against the server-only record.
    const rec = prior[id] || null;
    const countedC = counts(status) ? amtC : 0;
    const wasCounted = rec ? (Number(rec.countedCents) || 0) : 0;
    const wasMoved = rec ? (Number(rec.movedCents) || 0) : 0;
    const want = countedC - wasCounted;
    let moved = 0;
    if (!closed && want > 0) moved = Math.min(paidC, want);
    else if (!closed && want < 0) moved = -Math.min(-want, wasMoved);
    paidC -= moved;
    movedTotal += moved;
    const next = { countedCents: countedC, movedCents: wasMoved + moved, status, amountCents: amtC };
    if (o.chargeId) next.chargeId = String(o.chargeId);
    if (!rec || rec.countedCents !== next.countedCents || rec.movedCents !== next.movedCents
        || rec.status !== next.status || rec.amountCents !== next.amountCents) {
      records[id] = next;
    }

    // Display / revenue copy: rebuilt from Stripe (repairs an edited entry).
    const entry = { amount: amtC / 100, stripeRef: id, status, kind: 'refund' };
    if (o.chargeId) entry.chargeId = String(o.chargeId);
    const i = list.findIndex((x) => x && x.stripeRef === id);
    if (i > -1) {
      const cur = list[i];
      if (hasDate) entry.at = new Date(Number(r.created) * 1000);
      const same = cents(cur.amount) === amtC && cur.status === status && cur.kind === 'refund'
        && (!hasDate || (cur.at != null && new Date(cur.at.toDate ? cur.at.toDate() : cur.at).getTime() === entry.at.getTime()));
      if (!same) { list[i] = Object.assign({}, cur, entry); listChanged = true; }
    } else {
      // Stripe always sends created; without it, the delivery time (never 1970).
      entry.at = new Date(hasDate ? Number(r.created) * 1000 : (Number(o.nowMs) || Date.now()));
      list.push(entry);
      listChanged = true;
    }
  }
  if (!Object.keys(records).length && !listChanged) return null;

  const refundedC = list.filter((x) => x && Number(x.amount) > 0 && counts(x.status))
    .reduce((t, x) => t + cents(x.amount), 0);
  const all = Object.assign({}, prior, records);
  const reopenedC = Object.keys(all).reduce((t, k) => t + (Number(all[k] && all[k].movedCents) || 0), 0);
  const patch = { refunds: list, refundedTotal: refundedC / 100, refundReopenedTotal: reopenedC / 100 };

  if (movedTotal !== 0) {
    const totalC = cents(Math.max(0, Number(inv.total) || 0));
    const priorBalC = inv.balanceDue != null ? cents(inv.balanceDue) : Math.max(0, totalC - cents(inv.amountPaid));
    const balC = Math.max(0, priorBalC + movedTotal);
    const paidInFull = totalC > 0 && balC === 0;
    const depC = cents(inv.depositAmount);
    patch.amountPaid = paidC / 100;
    patch.balanceDue = balC / 100;
    patch.status = paidInFull ? 'paid' : (paidC > 0 ? 'partial' : 'sent');
    patch.paidAt = paidInFull ? (inv.paidAt || null) : null;
    patch.depositPaid = depC > 0 ? paidC >= depC : paidC > 0;
  }
  // Refunded vs partly refunded, against what was paid before refunds (net
  // paid + what refunds moved), so a void invoice reads right too.
  const grossC = paidC + reopenedC;
  patch.refundStatus = refundedC > 0 ? (refundedC >= grossC ? 'refunded' : 'partly_refunded') : null;
  return { patch, records, movedCents: movedTotal };
}

module.exports = { planConnectRefund };
