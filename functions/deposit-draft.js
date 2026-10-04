/**
 * deposit-draft.js — the draft deposit invoice made when a contract is signed
 * (2026-10-03). The decision is functions/deposit-draft-logic.js; this file
 * does the Firestore I/O in ONE transaction:
 *
 *   reads   leads/{leadId}
 *           deal_rooms/{dealId}                (deal_accepted only)
 *           estimates/{estimateId}             (the deal's, else the primary)
 *           invoices where leadId == leadId    (an invoice already made?)
 *           invoices/{depdraft_<lead>_<job>}   (the deterministic draft id)
 *           leads/{leadId}/tasks/…             (Collect Deposit / review task)
 *   writes  invoices/{depdraft_…}              tx.create — status 'draft'
 *           leads/{leadId}/tasks/review-deposit-…   only when no Collect
 *                                              Deposit task exists already
 *
 * NEVER sends: no email, no text, no Stripe call, no payment link. The draft
 * waits for the rep's Send tap (invoice-pipeline.js sendInvoiceUI).
 *
 * Never throws — the caller is the job spine, whose event already counted.
 * Not a Cloud Function; never export it from index.js.
 */
'use strict';

const D = require('./deposit-draft-logic');
const TenantOps = require('./tenant-ops-logic');

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

// Today in Eastern time — the spine's day (job-spine-logic.js todayYmdEt).
function _todayEt(nowMs) {
  try { return require('./job-spine-logic').todayYmdEt(nowMs); } catch (_) { return new Date(nowMs).toISOString().slice(0, 10); }
}

/**
 * @param db Firestore (admin)
 * @param args { leadId, event, sourceId, meta }
 * @returns {Promise<{ created: boolean, invoiceId?: string, taskId?: string|null,
 *   reason?: string, depositCents?: number, error?: string }>}
 */
async function draftDepositAfterSign(db, args, deps) {
  const { FieldValue, logger, now } = _deps(deps);
  args = args || {};
  const leadId = typeof args.leadId === 'string' ? args.leadId.trim() : '';
  const event = String(args.event || '');
  const sourceId = args.sourceId != null ? String(args.sourceId) : '';
  const meta = (args.meta && typeof args.meta === 'object') ? args.meta : {};
  if (D.DRAFT_EVENTS.indexOf(event) === -1) return { created: false, reason: 'not_a_signing_event' };
  if (!db || !/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) return { created: false, reason: 'bad_lead_id' };

  const dealId = event === 'deal_accepted'
    ? String(meta.dealId || (sourceId.startsWith('deal_') ? sourceId.slice(5) : '') || '')
    : '';
  const nowMs = now();

  try {
    const leadRef = db.collection('leads').doc(leadId);
    const out = await db.runTransaction(async (tx) => {
      const ls = await tx.get(leadRef);
      const lead = ls.exists ? (ls.data() || {}) : null;
      if (!lead) return { created: false, reason: 'no_lead' };

      let deal = null;
      if (dealId && /^[A-Za-z0-9_-]{1,128}$/.test(dealId)) {
        const ds = await tx.get(db.collection('deal_rooms').doc(dealId));
        deal = ds.exists ? (ds.data() || {}) : null;
        if (deal && deal.leadId && deal.leadId !== leadId) deal = null;
      }

      const { estimateId } = D.estimateIdFor(lead, deal);
      let est = null;
      if (estimateId) {
        const es = await tx.get(db.collection('estimates').doc(estimateId));
        est = es.exists ? (es.data() || {}) : null;
      }

      // The company's own cash deposit rule (2026-10-04, tenant-ready).
      // NBD: undefined → deposit-rule.js's rule, unchanged.
      const tenantKey = String(lead.companyId || lead.userId || '');
      let depositConfig;
      if (tenantKey && tenantKey !== TenantOps.NBD_OWNER_UID) {
        const ps = await tx.get(db.collection('companyProfile').doc(tenantKey));
        depositConfig = TenantOps.depositConfigFor(tenantKey, ps.exists ? (ps.data() || {}) : {});
      }
      const ctx = { leadId, event, sourceId, lead, deal, est, estimateId, nowMs, depositConfig };
      // Decide once without the invoice read: a skip (no estimate, cash under
      // $2k, KY hold…) needs no query.
      let decision = D.decideDepositDraft(ctx);
      if (decision.action === 'create') {
        const invSnap = await tx.get(db.collection('invoices').where('leadId', '==', leadId).limit(50));
        const existingInvoices = (invSnap.docs || []).map((d) => Object.assign({ id: d.id }, d.data() || {}));
        decision = D.decideDepositDraft(Object.assign({}, ctx, { existingInvoices }));
      }
      if (decision.action !== 'create') {
        return { created: false, reason: decision.reason, depositCents: decision.plan ? decision.plan.depositCents : undefined, rule: decision.plan ? decision.plan.rule : undefined };
      }

      const invRef = db.collection('invoices').doc(decision.invoiceId);
      const already = await tx.get(invRef);
      if (already.exists) return { created: false, reason: 'duplicate', invoiceId: decision.invoiceId };

      // The review task — unless a Collect Deposit task is already on the
      // lead (stage-checklist's Contract Signed action), or ours already is.
      const tasks = leadRef.collection('tasks');
      const collectRef = tasks.doc(D.COLLECT_DEPOSIT_TASK_ID);
      const t = D.reviewTask(decision.invoiceId, decision.invoice.depositAmount, _todayEt(nowMs));
      const reviewRef = tasks.doc(t.id);
      const [cs, rs] = [await tx.get(collectRef), await tx.get(reviewRef)];

      tx.create(invRef, Object.assign({}, decision.invoice, {
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }));
      let taskId = null;
      if (!cs.exists && !rs.exists) {
        tx.set(reviewRef, Object.assign({}, t.doc, { createdAt: FieldValue.serverTimestamp(), createdBy: 'system: deposit draft' }));
        taskId = t.id;
      } else if (cs.exists) {
        taskId = D.COLLECT_DEPOSIT_TASK_ID;
      }
      return { created: true, invoiceId: decision.invoiceId, taskId, depositCents: decision.plan.depositCents, rule: decision.plan.rule };
    });

    if (out.created) {
      logger.info('[depositDraft] draft deposit invoice created (not sent)', { leadId, event, sourceId, invoiceId: out.invoiceId, depositCents: out.depositCents, rule: out.rule, taskId: out.taskId });
    } else {
      // "Create nothing and log the reason" — cash under $2k, KY insurance,
      // no deductible, no estimate, an invoice already made…
      logger.info('[depositDraft] no draft', { leadId, event, sourceId, reason: out.reason, rule: out.rule || null });
    }
    return out;
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) {
      return { created: false, reason: 'duplicate' };
    }
    logger.warn('[depositDraft] failed', { leadId, event, sourceId, err: e && e.message });
    return { created: false, reason: 'error', error: String((e && e.message) || e) };
  }
}


/**
 * The FINAL invoice when the install is complete (2026-10-03) — a DRAFT,
 * never sent, plus the "Send final invoice" task, in ONE transaction:
 *
 *   reads   leads/{leadId}, estimates/{primaryEstimateId},
 *           invoices where leadId == leadId, invoices/{finaldraft_…},
 *           leads/{leadId}/tasks/send-final-invoice-…
 *   writes  invoices/{finaldraft_<lead>_<job>}   tx.create (only when needed)
 *           leads/{leadId}/tasks/send-final-invoice-<job>   only if absent
 *
 * Idempotent per job: the invoice id and the task id are deterministic, so
 * a re-entered stage, a retried trigger and the spine's own 'installed' move
 * all land on the same two documents. Never throws.
 * @returns {Promise<{ created: boolean, invoiceId?: string|null, taskId?: string|null, reason?: string, error?: string }>}
 */
async function draftFinalAtInstall(db, args, deps) {
  const { FieldValue, logger, now } = _deps(deps);
  args = args || {};
  const leadId = typeof args.leadId === 'string' ? args.leadId.trim() : '';
  const sourceId = args.sourceId != null ? String(args.sourceId) : '';
  if (!db || !/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) return { created: false, reason: 'bad_lead_id' };
  const nowMs = now();
  try {
    const leadRef = db.collection('leads').doc(leadId);
    const out = await db.runTransaction(async (tx) => {
      const ls = await tx.get(leadRef);
      const lead = ls.exists ? (ls.data() || {}) : null;
      if (!lead) return { created: false, reason: 'no_lead' };
      const estimateId = (typeof lead.primaryEstimateId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(lead.primaryEstimateId)) ? lead.primaryEstimateId : null;
      let est = null;
      if (estimateId) {
        const es = await tx.get(db.collection('estimates').doc(estimateId));
        est = es.exists ? (es.data() || {}) : null;
      }
      const invSnap = await tx.get(db.collection('invoices').where('leadId', '==', leadId).limit(50));
      const invoices = (invSnap.docs || []).map((d) => Object.assign({ id: d.id }, d.data() || {}));
      const decision = D.decideFinalDraft({ leadId, lead, est, estimateId, invoices, nowMs, sourceId });
      if (decision.action === 'skip' && decision.reason !== 'no_estimate') {
        return { created: false, reason: decision.reason, invoiceId: null, taskId: null };
      }
      let invRef = null;
      if (decision.action === 'create') {
        invRef = db.collection('invoices').doc(decision.invoiceId);
        const already = await tx.get(invRef);
        if (already.exists) { invRef = null; decision.action = 'use_existing'; decision.reason = 'duplicate'; }
      }
      const t = D.finalTask(decision.jobId, decision, _todayEt(nowMs));
      const taskRef = leadRef.collection('tasks').doc(t.id);
      const ts = await tx.get(taskRef);
      if (invRef) {
        tx.create(invRef, Object.assign({}, decision.invoice, {
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        }));
      }
      if (!ts.exists) {
        tx.set(taskRef, Object.assign({}, t.doc, { createdAt: FieldValue.serverTimestamp(), createdBy: 'system: final invoice' }));
      }
      return {
        created: !!invRef,
        invoiceId: decision.invoiceId || null,
        taskId: t.id,
        taskCreated: !ts.exists,
        reason: decision.action === 'create' ? 'drafted' : (decision.reason || decision.action),
      };
    });
    logger.info('[finalDraft] install-complete billing', { leadId, sourceId, created: out.created, invoiceId: out.invoiceId || null, reason: out.reason, taskId: out.taskId || null });
    return out;
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) {
      return { created: false, reason: 'duplicate' };
    }
    logger.warn('[finalDraft] failed', { leadId, sourceId, err: e && e.message });
    return { created: false, reason: 'error', error: String((e && e.message) || e) };
  }
}
module.exports = { draftDepositAfterSign, draftFinalAtInstall };
