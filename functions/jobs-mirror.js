/**
 * jobs-mirror.js — PHASE 1 of "a customer can have more than one job"
 * (rules in jobs-logic.js; plan in
 * documentation/projects/CRM-JOBS-AND-MONEY-PAPER-PLAN-2026-09-30.md).
 *
 * The lead is still the source of truth for every screen and every writer
 * (the edit modal, the kanban, the schedule planner, Stripe's payoff advance,
 * D2D, the portal bridge…). This trigger keeps the lead's ACTIVE JOB in step:
 *
 *   - a lead with no `activeJobId` → create leads/{id}/jobs/j1 from its fields
 *     and point `activeJobId` at it (fixed id: a retry never makes two);
 *   - otherwise → copy any per-job field that changed onto the active job.
 *
 * Loop-safe: the `activeJobId` write re-fires this trigger, and the second run
 * finds the job already in step (mirrorPatch → {}), so it writes nothing.
 * A deleted lead is ignored (lead-subtree-sweep removes its jobs).
 * Off by default: runs only with JOBS_MIRROR_ENABLED=true (functions/.env.nobigdeal-pro).
 */
'use strict';

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const J = require('./jobs-logic');

/** One lead write → at most one job write (+ the activeJobId pointer once). */
async function mirrorLead(db, leadId, lead) {
  // OFF until Jo says go: this writes to live customer records (a jobs/j1
  // doc + activeJobId on each lead as it is next saved). Enable by setting
  // JOBS_MIRROR_ENABLED=true in functions/.env.nobigdeal-pro.
  if (process.env.JOBS_MIRROR_ENABLED !== 'true') return { skipped: 'disabled' };
  if (!lead) return { skipped: 'deleted' };
  const leadRef = db.collection('leads').doc(String(leadId));
  // Only a well-formed id is trusted (the rules freeze it for clients, but a
  // malformed pointer must never make this trigger write an odd doc id).
  const activeId = typeof lead.activeJobId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(lead.activeJobId) ? lead.activeJobId : null;

  if (!activeId) {
    // First job. create() fails if it already exists (a racing run made it),
    // in which case only the pointer is missing.
    const jobRef = leadRef.collection('jobs').doc(J.FIRST_JOB_ID);
    try {
      await jobRef.create(Object.assign(J.firstJobFromLead(lead), { mirroredAt: FieldValue.serverTimestamp() }));
    } catch (e) {
      if (!(e && (e.code === 6 || /already exists/i.test(e.message || '')))) throw e;
    }
    await leadRef.update({ activeJobId: J.FIRST_JOB_ID });
    return { created: J.FIRST_JOB_ID };
  }

  const jobRef = leadRef.collection('jobs').doc(activeId);
  const snap = await jobRef.get();
  if (!snap.exists) {
    // Pointer to a job that is gone: rebuild it rather than lose the mirror.
    await jobRef.set(Object.assign(J.firstJobFromLead(lead), { mirroredAt: FieldValue.serverTimestamp(), origin: 'rebuilt' }));
    logger.warn('[jobsMirror] active job was missing — rebuilt', { leadId, activeId });
    return { rebuilt: activeId };
  }
  const patch = J.mirrorPatch(lead, snap.data());
  const fields = Object.keys(patch);
  if (!fields.length) return { inSync: activeId };
  await jobRef.update(Object.assign({}, patch, { mirroredAt: FieldValue.serverTimestamp() }));
  return { updated: activeId, fields };
}

exports.jobsMirrorOnLead = onDocumentWritten(
  { document: 'leads/{leadId}', region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    try {
      await mirrorLead(getFirestore(), event.params.leadId, after);
    } catch (e) {
      // Never throw on a lead write: a failed mirror is repaired by the next
      // write to the same lead (the patch is recomputed from scratch).
      logger.error('[jobsMirror] failed', { leadId: event.params.leadId, err: e && e.message });
    }
  }
);

exports._internal = { mirrorLead };
