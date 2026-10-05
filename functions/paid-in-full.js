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

module.exports = {
  isPaidStage, isPaidInFull, paidInFull, pifStageKey,
  invoicesForLead, lastPaidMs, loadLeadInvoices,
  PIF_PRE_FINAL,
};
