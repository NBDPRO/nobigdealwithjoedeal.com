/**
 * payment-timeline.js — one timeline line per payment, whatever path the
 * money came in by (2026-10-03).
 *
 * A read-only prod audit found payments reaching invoices with no trace on
 * the customer's timeline: the Stripe webhook (stripe.js invoiceWebhook),
 * the Stripe ledger (stripe-ledger.js) and Mark Paid each write the
 * invoice's payments[] and nothing else a rep would see. Every path ends on
 * the invoice doc, so the invoice trigger (money-paper.js
 * moneyPaperOnInvoice) calls writePaymentTimeline with the before / after
 * docs, and each NEW payments[] entry gets a /notes line (the timeline
 * reads notes by leadId).
 *
 * Idempotent per payment id: the note id is derived from the payment's own
 * id (paymentId on a manual entry, the PaymentIntent on a webhook credit,
 * the ledger's stripeRef), the write is create-only, and the browser's
 * Record Payment / Mark Paid writes the SAME id — so a retried trigger, a
 * re-delivered webhook or a second path never makes a second line. A legacy
 * entry with no id gets a content hash.
 *
 * The id + text rules are invoice-pipeline.js's nbd:payment-timeline block,
 * byte-identical below (functions/ cannot reach docs/), pinned by
 * tests/money-getting-paid-2026-10-03.test.js. Internal only: a note is
 * never sent anywhere. Never throws.
 */
'use strict';

const crypto = require('crypto');

  // nbd:payment-timeline:start — every payment gets ONE line on the
  // customer's timeline (2026-10-03). Byte-identical in
  // functions/payment-timeline.js, pinned by
  // tests/money-getting-paid-2026-10-03.test.js. The line is a /notes doc
  // (the timeline reads notes by leadId) whose id is derived from the
  // payment's own id, so whichever path writes it first — the Record Payment
  // sheet / Mark Paid in the browser, or the server's invoice trigger for a
  // Stripe webhook / ledger credit — every later write lands on the SAME doc:
  // one entry per payment, however many paths see it.
  var PAYMENT_TIMELINE_METHODS = {
    check: 'check', zelle: 'Zelle', cash: 'cash', card: 'card (not Stripe)', ach: 'ACH / bank (not Stripe)',
    other: 'other', manual: 'manual entry', stripe: 'online card (Stripe)', apple_pay: 'Apple Pay (Stripe)',
    google_pay: 'Google Pay (Stripe)', link: 'Link (Stripe)', us_bank_account: 'bank transfer (Stripe)', cashapp: 'Cash App (Stripe)'
  };
  var PAYMENT_TIMELINE_PAYERS = { homeowner: 'the homeowner', insurance: 'the insurance carrier', mortgage: 'the mortgage company' };
  function _ptlSeg(s) {
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  }
  /** The payment's own stable id, or '' (a legacy entry with none). */
  function paymentIdOf(p) {
    p = p || {};
    return String(p.paymentId || p.paymentIntentId || p.stripeRef || '');
  }
  /** The timeline note's doc id for this payment, or '' without a payment id. */
  function paymentTimelineNoteId(invoiceId, p) {
    const pid = paymentIdOf(p);
    return pid ? 'pay-' + _ptlSeg(invoiceId) + '-' + _ptlSeg(pid) : '';
  }
  function paymentTimelineText(invoiceId, p) {
    p = p || {};
    const n = Number(p.amount) || 0;
    const amt = '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const method = PAYMENT_TIMELINE_METHODS[p.method] || (p.method ? String(p.method).slice(0, 40) : 'payment');
    const ref = p.reference ? ' #' + String(p.reference).slice(0, 40) : '';
    const payer = PAYMENT_TIMELINE_PAYERS[p.payer] ? ' from ' + PAYMENT_TIMELINE_PAYERS[p.payer] : '';
    return '💵 Payment received: ' + amt + ' by ' + method + ref + payer + ' — invoice ' + String(invoiceId || '').slice(0, 12) + '.';
  }
  // nbd:payment-timeline:end

function _ms(v) {
  if (!v) return NaN;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/** The note id for an entry, with a content hash for a legacy entry that has no id. */
function noteIdFor(invoiceId, p) {
  const id = paymentTimelineNoteId(invoiceId, p);
  if (id) return id;
  const q = p || {};
  const h = crypto.createHash('sha1')
    .update([Math.round((Number(q.amount) || 0) * 100), String(q.method || ''), _ms(q.at != null ? q.at : q.date), _ms(q.recordedAt)].join('|'))
    .digest('hex').slice(0, 16);
  return 'pay-' + _ptlSeg(invoiceId) + '-h' + h;
}

/**
 * The payments[] entries this write ADDED. before null = a new invoice (all
 * of its payments are new to the timeline). Pure.
 */
function newPayments(invoiceId, before, after) {
  const prior = new Set(((before && Array.isArray(before.payments)) ? before.payments : []).map((p) => noteIdFor(invoiceId, p)));
  return ((after && Array.isArray(after.payments)) ? after.payments : [])
    .filter((p) => p && Number(p.amount) > 0)
    .filter((p) => !prior.has(noteIdFor(invoiceId, p)));
}

/**
 * Is the invoice's lead in the invoice's own company? (R3-6, 2026-10-06.) The
 * invoice create rule now checks leadId, but an invoice written before that
 * (or by a path that skips rules) could name another company's lead, and the
 * note below would land on that lead under its owner's name. A lead that
 * carries companyId must match the invoice's; a legacy lead without one must
 * belong to the invoice's writer or to the solo tenant it is keyed on. Pure.
 */
function invoiceLeadSameTenant(inv, lead) {
  if (!inv || !lead) return false;
  const invCo = inv.companyId || inv.createdBy || null;
  if (lead.companyId) return !!invCo && lead.companyId === invCo;
  const owner = lead.userId || null;
  return !!owner && (owner === inv.createdBy || owner === inv.companyId);
}

/**
 * Write the timeline line for each new payment. Create-only; an existing
 * note (another path, a retry) is left alone.
 * @returns {Promise<{ written: number, existing: number, ids: string[] } | { skipped: string } | { error: string }>}
 */
async function writePaymentTimeline(db, invoiceId, before, after, deps) {
  try {
    if (!db || !after || !after.leadId || after.deleted === true || after.e2eTestData) return { skipped: 'no_lead' };
    const fresh = newPayments(invoiceId, before, after);
    if (!fresh.length) return { skipped: 'no_new_payment' };
    let FieldValue = deps && deps.FieldValue;
    if (!FieldValue) FieldValue = require('firebase-admin/firestore').FieldValue;
    let owner = after.createdBy || null;
    // A read failure throws to the catch below ({ error }) rather than
    // writing onto a lead we could not check.
    const ls = await db.collection('leads').doc(String(after.leadId)).get();
    if (ls.exists) {
      const lead = ls.data() || {};
      if (!invoiceLeadSameTenant(after, lead)) return { skipped: 'lead_other_tenant' };
      if (lead.userId) owner = lead.userId;
    }
    let written = 0, existing = 0;
    const ids = [];
    for (const p of fresh) {
      const id = noteIdFor(invoiceId, p);
      ids.push(id);
      const atMs = _ms(p.at != null ? p.at : p.date);
      try {
        await db.collection('notes').doc(id).create({
          leadId: String(after.leadId),
          userId: owner,
          text: paymentTimelineText(invoiceId, p),
          type: 'payment',
          source: 'payment',
          invoiceId: String(invoiceId),
          paymentId: paymentIdOf(p) || id,
          amount: Number(p.amount) || 0,
          method: String(p.method || ''),
          createdAt: Number.isFinite(atMs) ? new Date(atMs) : FieldValue.serverTimestamp(),
          loggedAt: FieldValue.serverTimestamp(),
          createdBy: 'system: payment timeline',
        });
        written++;
      } catch (e) {
        if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) { existing++; continue; }
        throw e;
      }
    }
    return { written, existing, ids };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

module.exports = {
  paymentIdOf, paymentTimelineNoteId, paymentTimelineText, noteIdFor, newPayments, writePaymentTimeline,
  invoiceLeadSameTenant,
};
