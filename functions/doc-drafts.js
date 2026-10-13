/**
 * doc-drafts.js — Firestore I/O for the stage-triggered "Docs to review"
 * queue (Jo, 2026-10-13). The decisions are functions/doc-drafts-logic.js.
 *
 *   reads   leads/{leadId}
 *           companyProfile/{tenantKey}        (brand name / phone / review link)
 *           invoices where leadId == leadId   (paid_in_full receipt amount only)
 *   writes  leads/{leadId}/doc_drafts/{ddraft_<lead>_<kind>_<job>}
 *           create-only — status 'draft'. An id that already exists (a draft
 *           the rep edited, sent or dismissed, or a retried event) is left
 *           exactly as it is.
 *
 * NEVER sends: no email, no text. The draft goes out only from the CRM's Send
 * button (docs/pro/js/doc-drafts-ui.js). NEVER throws — the caller is the job
 * spine, whose event already counted. Not a Cloud Function; never export it
 * from index.js.
 */
'use strict';

const D = require('./doc-drafts-logic');

function _deps(deps) {
  deps = deps || {};
  let FieldValue = deps.FieldValue;
  if (!FieldValue) FieldValue = require('firebase-admin/firestore').FieldValue;
  let logger = deps.logger;
  if (!logger) {
    try { logger = require('firebase-functions/v2').logger; } catch (_) { logger = console; }
  }
  return { FieldValue, logger, now: deps.now || (() => Date.now()) };
}

function _alreadyExists(e) {
  return !!e && (e.code === 6 || e.code === 'already-exists' || /already exists/i.test(String(e.message || '')));
}

/**
 * @param db Firestore (admin)
 * @param args { leadId, event, companyId?, sourceId?, meta? }
 * @returns {Promise<{ created: string[], skipped: {kind,reason}[], existing: string[], reason?: string, error?: string }>}
 */
async function draftDocsForEvent(db, args, deps) {
  const { FieldValue, logger } = _deps(deps);
  args = args || {};
  const out = { created: [], skipped: [], existing: [] };
  try {
    const leadId = typeof args.leadId === 'string' ? args.leadId.trim() : '';
    const event = String(args.event || '');
    const kinds = D.planFor(event);
    if (!kinds.length) { out.reason = 'not_a_draft_event'; return out; }
    if (!db || !/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) { out.reason = 'bad_lead_id'; return out; }

    const leadRef = db.collection('leads').doc(leadId);
    const ls = await leadRef.get();
    const lead = ls.exists ? (ls.data() || {}) : null;
    if (!lead) { out.reason = 'no_lead'; return out; }
    if (args.companyId && lead.companyId && String(lead.companyId) !== String(args.companyId)) {
      out.reason = 'tenant_mismatch'; return out;
    }
    const meta = (args.meta && typeof args.meta === 'object') ? args.meta : {};
    const JOB_RE = /^[A-Za-z0-9_-]{1,40}$/;
    const jobId = (typeof meta.jobId === 'string' && JOB_RE.test(meta.jobId)) ? meta.jobId
      : ((typeof lead.activeJobId === 'string' && JOB_RE.test(lead.activeJobId)) ? lead.activeJobId : null);

    // Cheap pure gates first — a lost / deleted / quiet lead reads nothing else.
    const planned = [];
    for (const kind of kinds) {
      const g = D.shouldDraft(lead, kind, { jobId });
      if (!g.ok) out.skipped.push({ kind, reason: g.reason }); else planned.push(kind);
    }
    if (!planned.length) return out;

    const tenantKey = String(lead.companyId || lead.userId || '');
    let profile = null;
    if (tenantKey) {
      try {
        const ps = await db.collection('companyProfile').doc(tenantKey).get();
        profile = ps.exists ? (ps.data() || {}) : null;
      } catch (e) {
        // A profile read failure leaves the placeholders in — the rep fills
        // them; it must not block the draft.
        logger.warn('[docDrafts] companyProfile read failed', { leadId, err: e && e.message });
      }
    }

    let paidCents = null;
    if (planned.indexOf('paid_receipt') !== -1) {
      const PIF = require('./paid-in-full');
      const invoices = await PIF.loadLeadInvoices(db, leadId, lead, jobId);
      // Same rule as the Request Review task: a receipt says "paid in full"
      // only when the job really is.
      if (!PIF.isPaidStage(lead) || !PIF.paidInFull(lead, invoices)) {
        out.skipped.push({ kind: 'paid_receipt', reason: 'not_paid_in_full' });
        planned.splice(planned.indexOf('paid_receipt'), 1);
      } else {
        paidCents = invoices.reduce((s, inv) => s + PIF.paidCentsOf(inv), 0);
      }
    }

    for (const kind of planned) {
      const d = D.decide({ leadId, event, kind, lead, profile, tenantKey, jobId, paidCents, sourceId: args.sourceId });
      if (d.action !== 'create') { out.skipped.push({ kind, reason: d.reason }); continue; }
      try {
        await leadRef.collection('doc_drafts').doc(d.id).create(Object.assign({}, d.doc, {
          createdAt: FieldValue.serverTimestamp(),
          createdBy: 'system: doc drafts',
        }));
        out.created.push(d.id);
      } catch (e) {
        if (_alreadyExists(e)) { out.existing.push(d.id); continue; }
        throw e;
      }
    }
    if (out.created.length) {
      logger.info('[docDrafts] drafts created (not sent)', { leadId, event, created: out.created });
    }
    return out;
  } catch (e) {
    logger.warn('[docDrafts] failed', { leadId: args && args.leadId, event: args && args.event, err: e && e.message });
    out.error = String((e && e.message) || e);
    out.reason = 'error';
    return out;
  }
}

module.exports = { draftDocsForEvent };
