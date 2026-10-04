/**
 * deposit-draft-logic.js — the PURE decision behind the draft deposit invoice
 * (functions/deposit-draft.js does the Firestore I/O).
 *
 * Jo, 2026-10-03: "when a contract is signed, auto-create a DRAFT deposit
 * invoice — it never sends until Jo taps it."
 *
 * When the job spine records contract_signed or deal_accepted, the server
 * makes ONE invoice in status 'draft' — the same document the rep's "Create
 * Invoice" makes (docs/pro/js/invoice-pipeline.js createInvoiceFromEstimate),
 * from the same estimate, with the same deposit — and a "Review deposit
 * invoice" task. Nothing is emailed, texted or linked to Stripe: the draft
 * goes out only through the existing Send button.
 *
 * Nothing here is a second copy of a rule:
 *   - the deposit is deposit-rule.js fromEstimate (functions/deposit-rule.js
 *     is a byte-identical copy of docs/pro/js/deposit-rule.js);
 *   - the lines, totals and Bill To name are invoice-pipeline.js's own code
 *     (functions/invoice-from-estimate.js, byte-identical blocks);
 *   - the Kentucky test is ky-insurance-law.js classifyLead — the one the
 *     contract prints its KRS 367.624 notices from.
 *
 * When the rule says nothing is due at signing, NO invoice is made and the
 * reason is returned for the log: cash under $2,000, a Kentucky insurance job
 * (KRS 367.626 — nothing before the insurer's written decision and the
 * cancellation window), an insurance job with no deductible entered, no
 * estimate, no total.
 */
'use strict';

const DR = require('./deposit-rule');
const J = require('./ky-insurance-law');
const IFE = require('./invoice-from-estimate');
const CER = require('./customer-estimate-rows');

const DRAFT_EVENTS = ['contract_signed', 'deal_accepted'];
const AUTO_DRAFT_KIND = 'deposit_on_sign';
// stage-checklist.js / job-spine-logic.js id of the "Collect Deposit" stage
// action on Contract Signed. If a rep or the spine already filed it, that
// task IS the review reminder — no second one.
const COLLECT_DEPOSIT_TASK_ID = 'stage-contract_signed-collect_deposit';
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function _seg(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80); }
function _validJobId(v) { return (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v)) ? v : null; }

/**
 * The job the draft bills — invoice-pipeline.js's jobId rule: the estimate's
 * own job, else the job on the customer's card.
 */
function jobIdFor(est, lead) {
  return _validJobId(est && est.jobId) || _validJobId(lead && lead.activeJobId) || null;
}

/**
 * Deterministic invoice id: one draft per lead + job. A contract signed
 * remotely and a deal-room acceptance for the same job, a re-signed contract,
 * and every retry all land on this id — tx.create makes the second a no-op.
 */
function draftInvoiceId(leadId, jobId) {
  return 'depdraft_' + _seg(leadId) + '_' + (_seg(jobId) || 'job');
}

function reviewTaskId(invoiceId) { return 'review-deposit-' + _seg(invoiceId); }

/** Is this invoice the server's untouched draft deposit invoice? */
function isDepositDraft(inv) {
  return !!(inv && inv.status === 'draft' && inv.autoDraft && inv.autoDraft.kind === AUTO_DRAFT_KIND);
}

function _isDeleted(o) { return !!o && (o.deleted === true || !!o.deletedAt); }
function _stageKey(lead) { return String((lead && (lead._stageKey || lead.stage)) || '').trim().toLowerCase(); }

/**
 * Which estimate the draft bills, and at what price.
 *   deal_accepted → the deal room's estimate (else the lead's primary), at
 *                   the ACCEPTED tier and price when the estimate is per-SQ
 *                   (its one summary line then names the tier the homeowner
 *                   picked; acceptedPrice is the server-snapshotted retail
 *                   tier price, deal-acceptance.js).
 *   contract_signed → the lead's primary estimate.
 * → { estimateId } or { estimateId: null }
 */
function estimateIdFor(lead, deal) {
  const fromDeal = deal && typeof deal.estimateId === 'string' && ID_RE.test(deal.estimateId) ? deal.estimateId : null;
  const primary = lead && typeof lead.primaryEstimateId === 'string' && ID_RE.test(lead.primaryEstimateId) ? lead.primaryEstimateId : null;
  return { estimateId: fromDeal || primary || null };
}

function _priceEstimate(est, deal) {
  if (!deal || !(Number(deal.acceptedPrice) > 0)) return est;
  const perSq = (est.priceMode === 'per-sq') || (est.prices != null);
  if (!perSq) return est;
  return Object.assign({}, est, {
    selectedTier: String(deal.acceptedTier || est.selectedTier || est.tier || ''),
    grandTotal: Number(deal.acceptedPrice),
  });
}

function _sameTenant(est, lead) {
  if (!est || !lead) return false;
  if (est.leadId && est.leadId !== lead.id) return false;
  const owners = [lead.userId, lead.companyId].filter(Boolean).map(String);
  const estOwners = [est.userId, est.companyId, est.createdBy].filter(Boolean).map(String);
  if (!estOwners.length) return true; // legacy doc with no owner stamp — its leadId tied it above
  return estOwners.some((o) => owners.indexOf(o) !== -1);
}

/** Why the rule asks nothing at signing, for the log. */
function noDepositReason(plan) {
  if (!plan) return 'no_plan';
  if (plan.kyHold || plan.rule === 'insurance-ky') return 'ky_insurance_hold';
  if (plan.rule === 'cash-none') return 'cash_under_threshold';
  if (plan.needsDeductible) return 'needs_deductible';
  return 'no_deposit';
}

/**
 * Decide the draft. Pure.
 *   ctx = { leadId, event, sourceId, lead, deal?, est?, estimateId?, nowMs,
 *           existingInvoices?: [{ id, ...doc }] }
 * → { action: 'create', invoiceId, invoice, plan, totals }
 *   | { action: 'skip', reason, plan? }
 * invoice has no createdAt / updatedAt — the I/O layer stamps those.
 */
function decideDepositDraft(ctx) {
  ctx = ctx || {};
  const event = String(ctx.event || '');
  if (DRAFT_EVENTS.indexOf(event) === -1) return { action: 'skip', reason: 'not_a_signing_event' };
  const lead = ctx.lead ? Object.assign({ id: ctx.leadId }, ctx.lead) : null;
  if (!lead) return { action: 'skip', reason: 'no_lead' };
  if (_isDeleted(lead)) return { action: 'skip', reason: 'deleted' };
  const sk = _stageKey(lead);
  if (sk === 'lost' || lead.stageRole === 'lost') return { action: 'skip', reason: 'lost' };
  if (sk === 'closed') return { action: 'skip', reason: 'closed' };
  const owner = lead.userId ? String(lead.userId) : '';
  if (!owner) return { action: 'skip', reason: 'no_owner' };

  const est0 = ctx.est;
  if (!est0 || _isDeleted(est0)) return { action: 'skip', reason: 'no_estimate' };
  if (!_sameTenant(est0, lead)) return { action: 'skip', reason: 'estimate_other_tenant' };
  const est = _priceEstimate(est0, ctx.deal || null);

  const jobId = jobIdFor(est, lead);
  const invoiceId = draftInvoiceId(ctx.leadId, jobId);

  // An invoice the rep already made for this job (or the draft itself) —
  // never a second one. Void / deleted invoices don't count.
  const existing = (Array.isArray(ctx.existingInvoices) ? ctx.existingInvoices : []).filter((inv) => {
    if (!inv || _isDeleted(inv)) return false;
    const st = String(inv.status || '').toLowerCase();
    if (st === 'void' || st === 'voided' || st === 'cancelled' || st === 'canceled') return false;
    const ij = _validJobId(inv.jobId);
    if (jobId && ij) return ij === jobId;
    // No job to compare: an open invoice counts; a PAID one with no job
    // stamp is an earlier job's history, not this job's deposit.
    return st !== 'paid';
  });
  if (existing.some((inv) => inv.id === invoiceId)) return { action: 'skip', reason: 'duplicate' };
  if (existing.length) return { action: 'skip', reason: 'invoice_exists' };

  // Lines + totals — invoice-pipeline.js's own code.
  const t = IFE.invoiceTotalsFromEstimate(est, { estimateValue: CER.estimateValue });
  if (!(Number(t.total) > 0)) return { action: 'skip', reason: 'no_total' };
  const totalCents = Math.round(Number(t.total) * 100);

  // The deposit — deposit-rule.js, exactly as createInvoiceFromEstimate asks it.
  const plan = DR.fromEstimate(est, { totalCents, lead });
  // Kentucky insurance job → nothing at signing. deposit-rule.js decides it
  // from the estimate's mode; the contract decides it from the LEAD too (a
  // claim number or carrier makes it an insurance job). classifyLead is that
  // contract test, so a KY claim lead priced in cash mode is held here even
  // before PR #2112's lead-aware rule reaches this copy.
  if (plan.kyHold || J.classifyLead(lead, est).kyInsurance === true) {
    return { action: 'skip', reason: 'ky_insurance_hold', plan };
  }
  if (!(plan.depositCents > 0)) return { action: 'skip', reason: noDepositReason(plan), plan };

  const depositAmount = plan.depositCents / 100;
  const nowMs = Number(ctx.nowMs) || Date.now();
  const invoice = {
    leadId: ctx.leadId,
    estimateId: ctx.estimateId || null,
    customerId: est.customerId || null,
    customerName: IFE.resolveCustomerName(est, lead),
    customerEmail: est.customerEmail || lead.email || '',
    customerPhone: est.customerPhone || lead.phone || '',
    status: 'draft',
    items: t.items,
    subtotal: t.subtotal,
    tax: t.tax,
    taxRate: t.taxRate,
    total: t.total,
    // Supplements are approved after signing; a rep invoice made later folds
    // them in. The draft is the signing-day invoice, so none yet.
    supplementTotal: 0,
    depositAmount,
    depositPaid: false,
    amountPaid: 0,
    balanceDue: t.total,
    stripeInvoiceId: null,
    stripePaymentLink: null,
    dueDate: new Date(nowMs + 14 * 24 * 60 * 60 * 1000),
    sentAt: null,
    paidAt: null,
    viewedAt: null,
    notes: '',
    depositTerms: plan.summary || '',
    depositRepNote: plan.repNote || '',
    kyInsuranceHold: false, // a held job never gets here
    emergencyServices: false,
    terms: 'Net 14.' + (plan.summary ? ' ' + plan.summary : ''),
    // The lead's owner: every invoice reader keys by createdBy (owner) or
    // companyId (team), and the rep made-invoice convention is the uid.
    createdBy: owner,
    companyId: lead.companyId || owner,
    jobId,
    // Marks the server draft: the CRM shows "Draft deposit — review & send",
    // and nothing sends it but the rep's own Send tap.
    autoDraft: {
      kind: AUTO_DRAFT_KIND,
      event,
      sourceId: ctx.sourceId ? String(ctx.sourceId).slice(0, 140) : null,
      depositRule: plan.rule || null,
    },
  };
  return { action: 'create', invoiceId, invoice, plan, totals: t };
}

/** The "Review deposit invoice" task (stage-entry task shape). */
function reviewTask(invoiceId, depositAmount, todayYmd) {
  return {
    id: reviewTaskId(invoiceId),
    doc: {
      text: '🧾 Review deposit invoice',
      title: 'Review deposit invoice',
      notes: 'A draft deposit invoice (' + DR.fmtCents(Math.round(Number(depositAmount) * 100)) + ' due at signing) was made when the contract was signed. '
        + 'Nothing has been sent — open it, check it, and tap Send.',
      source: 'deposit_draft',
      invoiceId,
      actionId: 'review_deposit_invoice',
      actionKind: 'action',
      dueDate: String(todayYmd || ''),
      done: false,
    },
  };
}

module.exports = {
  DRAFT_EVENTS, AUTO_DRAFT_KIND, COLLECT_DEPOSIT_TASK_ID,
  jobIdFor, draftInvoiceId, reviewTaskId, isDepositDraft, estimateIdFor, noDepositReason,
  decideDepositDraft, reviewTask,
};
