/**
 * paid-in-full.js — the ONE "is this job paid in full?" rule (2026-10-03).
 *
 * Jo: a review request waits until the job is PAID IN FULL — not Install
 * Done, not Final Photos. Prod data that day: 0 of 36 won or paid jobs ever
 * got a review request, because the ask fired at Install Done (mid final-
 * payment conversation) and nobody followed it up.
 *
 * Paid in full means BOTH:
 *   1. The lead (or job) sits at a WON stage at or after Final Payment —
 *      final_payment, closed, warranty_claim, or a tenant's custom won stage
 *      — never Install Done / Final Photos / Deductible / Collections
 *      (stage-roles.js PRE_FINAL_WON).
 *   2. No invoice on it still owes money, under the owed rule
 *      (invoice-owed.js / collected-revenue.js nbd:owed-rule): drafts, void,
 *      paid and cancelled invoices owe nothing; any other with a balance does.
 *
 * Readers: review-request-nudge.js (the morning rep digest), job-spine.js (the
 * "Request Review" task at Final Payment), and — through a byte-identical
 * copy of the block below — docs/pro/js/review-engine.js (the bell, the review
 * deck, the Home count). tests/review-paid-in-full-2026-10-03.test.js fails if
 * the two copies drift.
 *
 * PR #2130 (homeowner portal progress tracker) carries the same rule as
 * functions/homeowner-progress.js paidInFullFor — PAID_STAGES {final_payment,
 * closed, warranty_claim} + custom won, collections never, any owing invoice
 * blocks. It was not on this branch's base; once it merges the portal should
 * call isPaidInFull here (or this module should call it) so the portal's
 * rating card and the review ask stay one rule.
 */
'use strict';

const { owedDollarsOf } = require('./invoice-owed');

  // nbd:paid-in-full-rule:start — ONE "paid in full" rule, kept byte-identical
  // in functions/paid-in-full.js and docs/pro/js/review-engine.js
  // (tests/review-paid-in-full-2026-10-03.test.js). A WON stage at or after
  // Final Payment (a custom won stage counts; Install Done, Final Photos,
  // Deductible and Collections never do), and no invoice still owes money
  // under the owed rule (owedDollarsOf — passed in, so both copies use their
  // own side's owed rule). invoices null/undefined = not known yet = NOT paid.
  var PIF_WON = { closed: 1, final_payment: 1, warranty_claim: 1, install_complete: 1, final_photos: 1, deductible_collected: 1, collections: 1 };
  var PIF_PRE_FINAL = { install_complete: 1, final_photos: 1, deductible_collected: 1, collections: 1 };
  var PIF_ALIAS = { complete: 'closed', 'closed won': 'closed', closed_won: 'closed', 'closed-won': 'closed', won: 'closed' };
  var PIF_ROLES = { 'new': 1, active: 1, job: 1, won: 1, lost: 1 };
  function pifStageKey(lead) {
    var raw = String((lead && (lead._stageKey || lead.stage)) || '').trim().toLowerCase();
    return PIF_ALIAS[raw] || raw.replace(/\s+/g, '_');
  }
  function isPaidStage(lead) {
    if (!lead) return false;
    var key = pifStageKey(lead);
    if (PIF_PRE_FINAL[key]) return false;
    var role = (typeof lead.stageRole === 'string' && PIF_ROLES[lead.stageRole]) ? lead.stageRole : (PIF_WON[key] ? 'won' : '');
    return role === 'won';
  }
  function isPaidInFull(lead, invoices, owedDollarsOf) {
    if (!lead || lead.deleted === true || !isPaidStage(lead)) return false;
    if (!Array.isArray(invoices) || typeof owedDollarsOf !== 'function') return false;
    for (var i = 0; i < invoices.length; i++) {
      if (owedDollarsOf(invoices[i]) > 0) return false;
    }
    return true;
  }
  // nbd:paid-in-full-rule:end

function _ms(t) {
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.toDate === 'function') return t.toDate().getTime();
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  if (typeof t === 'number') return t;
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : 0;
}

/**
 * The lead's invoices that belong to it: same lead, same tenant (an invoice
 * stamped with another company's id is not this customer's money), not
 * deleted. jobId given → only that job's invoices plus any with no job stamp.
 */
function invoicesForLead(invoices, lead, leadId, jobId) {
  const L = lead || {};
  const tenant = L.companyId || L.userId || null;
  return (Array.isArray(invoices) ? invoices : []).filter((inv) => {
    if (!inv || inv.deleted === true) return false;
    if (leadId && inv.leadId && String(inv.leadId) !== String(leadId)) return false;
    const it = inv.companyId || null;
    if (tenant && it && it !== tenant && it !== L.userId) return false;
    if (jobId && inv.jobId && inv.jobId !== jobId) return false;
    return true;
  });
}

/** When the money finished: the latest paidAt on the lead's paid invoices. */
function lastPaidMs(invoices) {
  let m = 0;
  for (const inv of (Array.isArray(invoices) ? invoices : [])) {
    if (!inv || String(inv.status || '').toLowerCase() !== 'paid') continue;
    m = Math.max(m, _ms(inv.paidAt));
  }
  return m;
}

/** Server: the lead's invoices from Firestore (tenant-filtered). Throws on a read error. */
async function loadLeadInvoices(db, leadId, lead, jobId) {
  const snap = await db.collection('invoices').where('leadId', '==', String(leadId)).get();
  const rows = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  return invoicesForLead(rows, lead, leadId, jobId || null);
}

/** Server convenience: isPaidInFull with this module's owed rule. */
function paidInFull(lead, invoices) {
  return isPaidInFull(lead, invoices, owedDollarsOf);
}

// ── Did paying THIS invoice pay the job off? (2026-10-05) ────────────────
// The invoice trigger (money-paper.js) fired the job spine's paid_in_full on
// ANY invoice reaching 'paid'. A paid $4,620 deposit invoice moved the job
// from Contract Signed to Final Payment, filed the review ask before the
// install, skipped Install Done (so the final invoice was never drafted and
// the balance never billed), marked the job paidInFull and filed a "paid in
// full — not closed" task. Now an invoice going 'paid' settles the job only
// when:
//   1. it is not a deposit invoice (isDepositInvoice), and
//   2. no other invoice on the lead/job still owes money (invoicesForLead +
//      the owed rule above), and
//   3. it is not a partial bill short of the job: an invoice that does not
//      bill the whole job (billsWholeJob) settles it only when everything
//      collected on the lead reaches the lead's jobValue (when one is set).
// Cents throughout. invoices null = could not be read: rules 1 and 3 still
// apply on what the invoice and lead carry.
const _DEAD = { void: 1, voided: 1, cancelled: 1, canceled: 1, uncollectible: 1 };
function _c(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : 0; }
function _tag(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

/**
 * A deposit invoice: tagged deposit (kind / type / invoiceType), or the whole
 * invoice is the deposit (total ≤ depositAmount), or every billed line is a
 * deposit line. A final invoice (kind 'final', which credits the deposit as
 * "Less deposit paid" lines) never is.
 */
function isDepositInvoice(inv) {
  if (!inv) return false;
  if (_tag(inv.kind) === 'final') return false;
  if ([inv.kind, inv.type, inv.invoiceType].some((v) => _tag(v) === 'deposit')) return true;
  const totalC = _c(inv.total);
  const depC = _c(inv.depositAmount);
  if (depC > 0 && totalC > 0 && totalC <= depC) return true;
  const lines = (Array.isArray(inv.items) ? inv.items : []).filter((l) => l && l.credit !== true && _c(l.total != null ? l.total : l.unitPrice) > 0);
  return lines.length > 0 && lines.every((l) => /\bdeposit\b/i.test(String(l.description || l.name || '')));
}

/**
 * An invoice that bills the whole job: the final invoice, one made from the
 * estimate or from a rep-confirmed job total (Record payment), or one that
 * carries deposit terms on a larger total (the signing-day invoice).
 */
function billsWholeJob(inv) {
  if (!inv) return false;
  if (_tag(inv.kind) === 'final') return true;
  if (inv.estimateId) return true;
  if (inv.source === 'record_payment') return true;
  const depC = _c(inv.depositAmount);
  return depC > 0 && _c(inv.total) > depC;
}

/** Money collected on one invoice, in cents (a paid invoice = its total). */
function paidCentsOf(inv) {
  if (!inv || inv.deleted === true || _DEAD[_tag(inv.status)]) return 0;
  const paid = Math.max(0, _c(inv.amountPaid));
  return _tag(inv.status) === 'paid' ? Math.max(paid, _c(inv.total)) : paid;
}

/**
 * inv = the invoice that just went 'paid' (with its id), lead = its lead doc
 * (or null), invoices = the lead's invoices (loadLeadInvoices) or null.
 * → { settles: true } | { settles: false, reason, … }
 */
function invoiceSettlesJob(inv, lead, invoices) {
  if (!inv || _tag(inv.status) !== 'paid') return { settles: false, reason: 'not_paid' };
  if (isDepositInvoice(inv)) return { settles: false, reason: 'deposit_invoice' };
  const L = lead || {};
  const id = inv.id != null ? String(inv.id) : null;
  const jobId = typeof inv.jobId === 'string' && inv.jobId ? inv.jobId : null;
  const others = Array.isArray(invoices)
    ? invoicesForLead(invoices, L, inv.leadId || null, jobId).filter((o) => !(id && o.id != null && String(o.id) === id))
    : [];
  const owing = others.find((o) => owedDollarsOf(o) > 0);
  if (owing) return { settles: false, reason: 'balance_owed', invoiceId: owing.id || null };
  if (!billsWholeJob(inv)) {
    const jobValueCents = _c(L.jobValue);
    if (jobValueCents > 0) {
      const collectedCents = others.reduce((s, o) => s + paidCentsOf(o), paidCentsOf(inv));
      if (collectedCents < jobValueCents) return { settles: false, reason: 'short_of_job_value', collectedCents, jobValueCents };
    }
  }
  return { settles: true };
}

module.exports = {
  isPaidStage, isPaidInFull, paidInFull, pifStageKey,
  invoicesForLead, lastPaidMs, loadLeadInvoices,
  isDepositInvoice, billsWholeJob, paidCentsOf, invoiceSettlesJob,
  PIF_PRE_FINAL,
};
