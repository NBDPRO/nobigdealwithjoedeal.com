/**
 * install-final-invoice.js — when a lead ENTERS Install Done, the job's
 * final invoice is drafted (2026-10-03).
 *
 * The job spine has an 'installed' event (job-spine-logic.js) and nothing
 * called it: a client stage move (stage-write.js commitStageChange — the
 * kanban drag, the stage menu, a bulk move) writes only the lead, and there
 * is no server path from a client stage change into the spine. So a
 * finished roof never asked for its money (2026-10-03 prod audit: 30 jobs at
 * install or later, 4 invoices).
 *
 * This trigger watches leads/{leadId}. A write that lands the lead on
 * install_complete from any other stage (job-spine-logic.js enteredStage —
 * client move, bulk move, or the spine's own move) records the 'installed'
 * spine event, sourced to the lead's job. recordJobEvent then (job-spine.js)
 * drafts the FINAL invoice — or points at the job's live invoice — and files
 * the "Send final invoice" task (deposit-draft.js draftFinalAtInstall).
 *
 * NEVER sends: no email, no text, no Stripe call. Idempotent per job: the
 * spine marker, the invoice id and the task id are all deterministic.
 * Never throws (a lead write must never fail because of billing).
 */
'use strict';

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const L = require('./job-spine-logic');

/** One lead write → the spine's 'installed' event, or nothing. Exported for tests. */
async function onLeadWrite(db, leadId, before, after, deps) {
  if (!L.enteredStage(before, after, 'install_complete')) return { skipped: 'not_entered' };
  const jobId = (after && typeof after.activeJobId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(after.activeJobId)) ? after.activeJobId : '';
  const record = (deps && deps.recordJobEvent) || require('./job-spine').recordJobEvent;
  try {
    return await record(db, {
      leadId: String(leadId), companyId: (after && after.companyId) || null, event: 'installed',
      sourceId: 'stage_install_complete_' + (jobId || 'job'),
      actor: 'stage moved to Install Done',
      meta: { jobId: jobId || '', detail: 'stage moved to Install Done' },
    }, deps);
  } catch (e) {
    logger.warn('[installFinal] failed', { leadId, err: e && e.message });
    return { error: String((e && e.message) || e) };
  }
}

exports.finalInvoiceOnInstall = onDocumentUpdated(
  { document: 'leads/{leadId}', region: 'us-central1', memory: '256MiB', timeoutSeconds: 60 },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    if (!L.enteredStage(before, after, 'install_complete')) return;
    const out = await onLeadWrite(getFirestore(), event.params.leadId, before, after);
    logger.info('[installFinal] install complete', { leadId: event.params.leadId, finalDraft: out && out.finalDraft ? out.finalDraft.reason : null });
  }
);

exports._internal = { onLeadWrite };
