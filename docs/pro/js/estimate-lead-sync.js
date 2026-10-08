/*! © 2026 No Big Deal Home Solutions — All Rights Reserved. Proprietary; no license granted — see LICENSE at the repo root. https://nobigdealwithjoedeal.com */
// estimate-lead-sync.js — ONE way to take an estimate off a lead (review
// R5-8-2, 2026-10-06).
//
// The dashboard's Delete (dashboard-bootstrap.module.js _deleteEstimate) used
// deleteDoc() on the estimate, against the "never deleteDoc estimates" rule,
// and the customer page's Archive (customer-bootstrap.module.js) soft-deleted
// it. Neither touched the lead. lead.primaryEstimateId kept pointing at the
// gone estimate and lead.jobValue kept its dollars, so the pipeline card, the
// KPI tiles and the leaderboard still counted it, and the next estimate was
// treated as a "revision" of a ghost.
//
// Both paths now call archiveEstimateAndSyncLead() below, so they cannot drift:
//   1. soft-delete the estimate — exactly what the customer-page Archive wrote:
//      { deleted: true, deletedAt: serverTimestamp() };
//   2. if it was the lead's primary estimate, fix the lead the way
//      _assignEstimateToLead stamps one (planLeadAfterEstimateRemoval, pure).
//
// ES module, imported statically by both bootstrap modules — no window global,
// so there is no `window.X && ...` guard to turn a missing helper into a
// silent no-op. Firestore functions are passed in (fs), which keeps this file
// free of the gstatic imports and lets node tests run it directly.

// Same rule as dashboard-bootstrap.module.js's _canStampJobValue: a 0 (or a
// value we failed to read) is never stamped as a job value.
export function canStampJobValue(v) {
  return Number.isFinite(v) && v > 0;
}

// The confirm _assignEstimateToLead shows before replacing a job value that
// did not come from an estimate being stamped (same words).
export function revisionConfirmMessage(existingVal, newVal) {
  return `This lead's job value is currently $${Number(existingVal || 0).toLocaleString()} (from an earlier estimate). ` +
    `Use this estimate's $${Number(newVal || 0).toLocaleString()} instead?`;
}

// createdAt as ms: a Firestore Timestamp (toMillis / toDate / seconds), a Date,
// or a number. Unknown shapes sort last.
function _ms(t) {
  if (!t) return 0;
  if (typeof t === 'number') return isFinite(t) ? t : 0;
  if (typeof t.toMillis === 'function') return t.toMillis() || 0;
  if (typeof t.toDate === 'function') { const d = t.toDate(); return (d && d.getTime()) || 0; }
  if (t instanceof Date) return t.getTime() || 0;
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  return 0;
}
const _cents = (v) => Math.round((Number(v) || 0) * 100);

// Pure. Given the lead, the estimate being removed and the estimates the page
// knows about, return what the lead needs, or null when it needs nothing.
//
//   null                         the removed estimate is not the lead's primary
//                                (or there is no lead) — leave the lead alone.
//   { patch, confirm: null }     write patch as-is.
//   { patch, confirm: {...} }    write patch; add jobValue: confirm.newVal only
//                                if the rep says yes to confirm.message.
//
// The lead's jobValue is a "ghost" when it equals the removed estimate's own
// value — it was stamped from that estimate, not typed or confirmed by a rep.
//   - Another live (not deleted) estimate on the lead: the newest becomes
//     primary. Its value is stamped straight through over a ghost or an empty
//     value (like _assignEstimateToLead on a lead with no primary). Over any
//     other value the rep is asked first (its revision confirm). A value that
//     cannot be stamped (canStampJobValue) is never written; a ghost is then
//     cleared rather than left behind.
//   - No other live estimate: primaryEstimateId is cleared, and a ghost
//     jobValue with it. A value that did not come from the estimate stays
//     (the same "never clobber a rep-confirmed number" rule as the un-dangle
//     in _assignEstimateToLead).
export function planLeadAfterEstimateRemoval({ lead, leadId, removedEstimate, estimates, estValue } = {}) {
  if (!lead || !removedEstimate || !removedEstimate.id) return null;
  if (String(lead.primaryEstimateId || '') !== String(removedEstimate.id)) return null;
  if (typeof estValue !== 'function') throw new Error('planLeadAfterEstimateRemoval: estValue is required');
  const lid = leadId || lead.id || removedEstimate.leadId || null;

  const curVal = Number(lead.jobValue) || 0;
  const removedVal = Number(estValue(removedEstimate)) || 0;
  const ghost = curVal > 0 && _cents(curVal) === _cents(removedVal);

  const live = (Array.isArray(estimates) ? estimates : [])
    .filter((e) => e && e.id && e.id !== removedEstimate.id && e.deleted !== true
      && lid && e.leadId === lid)
    .sort((a, b) => _ms(b.createdAt) - _ms(a.createdAt));
  const next = live[0] || null;

  if (!next) {
    const patch = { primaryEstimateId: null };
    if (ghost) patch.jobValue = null;
    return { patch, confirm: null, nextEstimateId: null };
  }

  const patch = { primaryEstimateId: next.id };
  const newVal = Number(estValue(next)) || 0;
  if (!canStampJobValue(newVal)) {
    if (ghost) patch.jobValue = null;
    return { patch, confirm: null, nextEstimateId: next.id };
  }
  if (_cents(newVal) === _cents(curVal)) return { patch, confirm: null, nextEstimateId: next.id };
  if (ghost || curVal <= 0) {
    patch.jobValue = newVal;
    return { patch, confirm: null, nextEstimateId: next.id };
  }
  return {
    patch,
    confirm: { existingVal: curVal, newVal, message: revisionConfirmMessage(curVal, newVal) },
    nextEstimateId: next.id,
  };
}

// Soft-delete an estimate, then fix its lead (best-effort, like every other
// lead stamp-back: a lead-write failure never fails the archive itself).
//
//   fs        { db, doc, getDoc, updateDoc, serverTimestamp } (Firestore v10)
//   estimate  the in-memory estimate if the page has it (else it is read)
//   estimates the page's estimates (other live estimates for the lead)
//   estValue  the page's two-shape estimate value reader
//   ask       confirm(message) -> Promise<boolean>
//
// Resolves { leadId, leadPatch } — leadPatch is what was written to the lead
// (null when nothing was) so the page can refresh its in-memory lead. Throws
// only when the estimate soft-delete itself fails.
export async function archiveEstimateAndSyncLead({ estimateId, estimate, estimates, fs, estValue, ask, log } = {}) {
  if (!estimateId) throw new Error('archiveEstimateAndSyncLead: estimateId is required');
  const warn = (log && log.warn) || ((...a) => console.warn(...a));
  const estRef = fs.doc(fs.db, 'estimates', estimateId);

  let est = estimate && estimate.id === estimateId ? estimate : null;
  if (!est) {
    try {
      const s = await fs.getDoc(estRef);
      if (s.exists()) est = { id: estimateId, ...s.data() };
    } catch (_) { /* the lead sync below degrades to a no-op */ }
  }

  // SOFT DELETE — never deleteDoc on estimates (standing rule: never lose a job).
  await fs.updateDoc(estRef, { deleted: true, deletedAt: fs.serverTimestamp() });

  const leadId = (est && est.leadId) || null;
  if (!leadId) return { leadId: null, leadPatch: null };
  try {
    const leadRef = fs.doc(fs.db, 'leads', leadId);
    const leadSnap = await fs.getDoc(leadRef);
    if (!leadSnap.exists()) return { leadId, leadPatch: null };
    const plan = planLeadAfterEstimateRemoval({
      lead: { id: leadId, ...leadSnap.data() },
      leadId,
      removedEstimate: est,
      estimates,
      estValue,
    });
    if (!plan) return { leadId, leadPatch: null };
    const patch = { ...plan.patch };
    if (plan.confirm) {
      const confirmFn = typeof ask === 'function' ? ask : () => Promise.resolve(false);
      if (await confirmFn(plan.confirm.message)) patch.jobValue = plan.confirm.newVal;
    }
    await fs.updateDoc(leadRef, patch);
    return { leadId, leadPatch: patch };
  } catch (e) {
    warn('[archiveEstimateAndSyncLead] lead sync failed:', e && e.message);
    return { leadId, leadPatch: null };
  }
}
