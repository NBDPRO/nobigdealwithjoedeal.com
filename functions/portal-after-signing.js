/**
 * functions/portal-after-signing.js — what the homeowner portal says once the
 * job is signed, and the deal link that must not take a second signature
 * (homeowner money audit 2026-10-07, "Portal after signing" batch: M1, M3, M5).
 *
 * Pure: no Firestore, no clock. functions/portal.js (getHomeownerPortalView)
 * and functions/deal-acceptance.js (getDealRoom / submitDealAcceptance) do the
 * reads and call these.
 *
 *   M1  The estimate card said "Sent to you" after a deal-room signature, all
 *       the way to paid in full: deal acceptance never sets the estimate's
 *       signatureStatus, and the card read nothing else. portalJobStatus()
 *       reads every signing path (e-sign, deal room, any contract that moved
 *       the job) and the job's progress: Signed → Deposit paid → Build day set
 *       → In progress → Work complete → Paid in full.
 *   M3  Once anything was paid the portal never said what. paymentsFor()
 *       lists each payment (date, amount, method) from the invoices'
 *       append-only payments[] ledger — the same entries the CRM's receipts
 *       are built from (invoice-pipeline.js receiptDetailsOf) — in cents.
 *   M5  A deal link still loaded and accepted a second signature after the
 *       contract was e-signed and paid in full. dealLinkRefusal() refuses it
 *       once the deal's estimate is signed by any path — unless the estimate
 *       was re-priced since (a revision out to RE-sign is still signable:
 *       Jo's signed-price rule, review R6-2-2, the same test
 *       esign-envelope.js sendEstimateEnvelope applies).
 */
'use strict';

const CER = require('./customer-estimate-rows');

const DONE_DEAL_STATUSES = ['accepted', 'signed', 'scheduled'];
const NOT_LIVE_INVOICE = { draft: 1, void: 1, voided: 1, cancelled: 1, canceled: 1 };

const cents = (v) => {
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) ? n : 0;
};

/** Signed by e-sign (signatureStatus) or stamped by the job spine (signedPrice). */
function estimateIsSigned(est) {
  if (!est || est.deleted === true) return false;
  if (est.signatureStatus === 'signed') return true;
  const sp = est.signedPrice;
  return !!(sp && typeof sp === 'object' && Number(sp.totalCents) > 0);
}

function dealIsAccepted(deal) {
  return !!deal && DONE_DEAL_STATUSES.indexOf(deal.status) !== -1;
}

/**
 * How this job got signed, or null.
 * @param {object} a { estimate, deals, progress } — progress is
 *   homeowner-progress.js resolveHomeownerProgress(); deals are this lead's
 *   deal_rooms, tenant-filtered by the caller.
 * @returns {'esign'|'deal-room'|'contract'|null}
 */
function signedVia(a) {
  const o = a || {};
  const est = o.estimate || null;
  if (est && est.signatureStatus === 'signed') return 'esign';
  if ((Array.isArray(o.deals) ? o.deals : []).some(dealIsAccepted)) return 'deal-room';
  if (estimateIsSigned(est)) return 'contract';
  // The job itself moved past Signed (an in-person / uploaded contract, or a
  // stage a rep set) — the progress tracker already says "Signed".
  const p = o.progress || null;
  if (p && Number(p.currentIndex) >= 2) return 'contract';
  return null;
}

/** A live (sent, not void/draft/deleted) invoice. */
function _liveInvoice(inv) {
  return !!inv && inv.deleted !== true && !NOT_LIVE_INVOICE[String(inv.status || '').toLowerCase()];
}

function _paymentCounts(p) {
  return !!p && Number(p.amount) > 0 && p.reverted !== true && p.achStatus !== 'failed';
}

/** Has any money landed on this job? (any live invoice with a payment) */
function anyPaid(invoices) {
  return (Array.isArray(invoices) ? invoices : []).some((inv) => _liveInvoice(inv)
    && (cents(inv.amountPaid) > 0 || (Array.isArray(inv.payments) && inv.payments.some(_paymentCounts))));
}

/**
 * The estimate card's Status line.
 * @param {object} a { progress, via, invoices, signatureStatus }
 * @returns {{ key, label, tone: 'green'|'orange'|'' } | null}
 *   null = not signed — the card keeps the signature pill / "Sent to you".
 */
function portalJobStatus(a) {
  const o = a || {};
  const p = o.progress || {};
  // A revision out for a new signature: that is what the homeowner is being
  // asked to do right now — the card keeps "Awaiting signature".
  if (o.signatureStatus === 'sent' || o.signatureStatus === 'viewed') return null;
  if (p.paidInFull) return { key: 'paid_in_full', label: '✓ Paid in full', tone: 'green' };
  if (!o.via) return null;
  switch (p.currentKey) {
    case 'payment':
    case 'walkthrough':
    case 'warranty':
    case 'review':
      return { key: 'complete', label: '✓ Work complete', tone: 'green' };
    case 'build':
      return { key: 'in_progress', label: 'In progress', tone: 'orange' };
    case 'scheduled':
      return { key: 'scheduled', label: '✓ Build day set', tone: 'green' };
    default:
      return anyPaid(o.invoices)
        ? { key: 'deposit_paid', label: '✓ Deposit paid', tone: 'green' }
        : { key: 'signed', label: '✓ Signed', tone: 'green' };
  }
}

// Same words as the CRM's receipts (invoice-pipeline.js RECEIPT_METHOD_LABELS).
const METHOD_LABELS = {
  check: 'Check', zelle: 'Zelle', cash: 'Cash', card: 'Card', ach: 'Bank transfer (ACH)', other: 'Other',
  stripe: 'Card (online)', us_bank_account: 'Bank transfer (ACH)', apple_pay: 'Apple Pay', google_pay: 'Google Pay',
  link: 'Link (online)', cashapp: 'Cash App', manual: 'Payment', insurance: 'Insurance check',
};

function _isoOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    // A bare calendar day: noon, so no reader's timezone moves it a day.
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + 'T12:00:00';
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof v.toDate === 'function') { try { return v.toDate().toISOString(); } catch (_) { return null; } }
  if (typeof v.toMillis === 'function') { try { return new Date(v.toMillis()).toISOString(); } catch (_) { return null; } }
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'object' && Number.isFinite(Number(v._seconds))) return new Date(Number(v._seconds) * 1000).toISOString();
  return null;
}

/**
 * Every payment on the job, oldest first, redacted to what the homeowner
 * needs: { date (ISO or null), amountCents, method, invoiceNumber }.
 * No processor ids, no proof paths, no notes.
 */
function paymentsFor(invoices) {
  const out = [];
  (Array.isArray(invoices) ? invoices : []).forEach((inv) => {
    if (!_liveInvoice(inv)) return;
    const num = String(inv.invoiceNumber || (inv.paper && inv.paper.invoice && inv.paper.invoice.instanceId) || '').trim().slice(0, 40);
    (Array.isArray(inv.payments) ? inv.payments : []).forEach((p) => {
      if (!_paymentCounts(p)) return;
      const m = String(p.method || '').toLowerCase();
      out.push({
        date: _isoOf(p.at != null ? p.at : p.date),
        amountCents: cents(p.amount),
        method: METHOD_LABELS[m] || 'Payment',
        invoiceNumber: num || null,
      });
    });
  });
  out.sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));
  return out;
}

/** { payments, totalPaidCents } or null when nothing has been paid. */
function paidSummaryFor(invoices) {
  const payments = paymentsFor(invoices);
  if (!payments.length) return null;
  return { payments, totalPaidCents: payments.reduce((s, p) => s + p.amountCents, 0) };
}

const ALREADY_SIGNED_MSG = 'This job is already signed, so there is nothing more to sign here.';

/**
 * Should this deal link refuse to load / accept? (M5)
 * @param {object} a { estimate } — the estimate the deal was made from
 *   (deal token's estimateId, else the deal room's); none → never refused.
 * @returns {{ status: 410, code: 'already_signed', message } | null}
 */
function dealLinkRefusal(a) {
  const est = (a && a.estimate) || null;
  if (!estimateIsSigned(est)) return null;
  // Signed, then re-priced: a new deal room to RE-sign the revision is the
  // re-sign path (signed-price.js) — it must stay open.
  let changed = false;
  try { changed = CER.hasUnsignedChanges(est); } catch (_) { changed = false; }
  if (changed) return null;
  return { status: 410, code: 'already_signed', message: ALREADY_SIGNED_MSG };
}

/**
 * The homeowner's portal link to show on the refusal: an existing live portal
 * token for THIS lead and owner (never a new one is minted here).
 * @param {object[]} tokens [{ id, leadId, ownerUid, expiresAtMs, uses, maxUses, revoked }]
 */
function portalUrlFor(tokens, leadId, ownerUid, nowMs) {
  const now = Number(nowMs) || 0;
  const live = (Array.isArray(tokens) ? tokens : []).filter((t) => t
    && typeof t.id === 'string' && /^[A-Za-z0-9]{10,64}$/.test(t.id)
    && t.leadId === leadId && ownerUid && t.ownerUid === ownerUid
    && Number(t.expiresAtMs) > now
    && !(typeof t.maxUses === 'number' && (Number(t.uses) || 0) >= t.maxUses))
    .sort((x, y) => Number(y.expiresAtMs) - Number(x.expiresAtMs));
  return live.length ? 'https://nobigdealwithjoedeal.com/pro/portal.html?token=' + live[0].id : null;
}

module.exports = {
  DONE_DEAL_STATUSES,
  ALREADY_SIGNED_MSG,
  estimateIsSigned,
  dealIsAccepted,
  signedVia,
  anyPaid,
  portalJobStatus,
  paymentsFor,
  paidSummaryFor,
  dealLinkRefusal,
  portalUrlFor,
};
