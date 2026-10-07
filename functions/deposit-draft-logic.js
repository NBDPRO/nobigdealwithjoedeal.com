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
const PIF = require('./paid-in-full');
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

/** An acceptance recorded on the estimate but never applied or dismissed → deal-shaped, else null. */
function _recordedAcceptance(est) {
  if (!est || !est.acceptedTier || !(Number(est.acceptedPrice) > 0)) return null;
  if (est.acceptedTierApplied === true || est.acceptedTierDismissed === true) return null;
  return { acceptedTier: est.acceptedTier, acceptedPrice: est.acceptedPrice };
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
  // The deal's acceptance, else one recorded on the estimate (R2-2-1).
  const est = _priceEstimate(est0, (ctx.deal && Number(ctx.deal.acceptedPrice) > 0) ? ctx.deal : _recordedAcceptance(est0));

  const jobId = jobIdFor(est, lead);
  const invoiceId = draftInvoiceId(ctx.leadId, jobId);

  // An invoice the rep already made for this job (or the draft itself) —
  // never a second one. Void / deleted invoices don't count.
  const existing = (Array.isArray(ctx.existingInvoices) ? ctx.existingInvoices : []).filter((inv) => {
    if (!inv || _isDeleted(inv)) return false;
    // Another tenant's invoice naming this lead is not this job's invoice —
    // it must not block (or stand in for) this tenant's deposit draft
    // (paid-in-full.js invoiceInLeadTenant, 2026-10-05).
    if (!PIF.invoiceInLeadTenant(inv, lead)) return false;
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
  // The COMPANY's cash deposit rule (2026-10-04, tenant-ready): the caller
  // passes it (tenant-ops-logic depositConfigFor); absent = NBD's rule.
  const plan = DR.fromEstimate(est, ctx.depositConfig ? { totalCents, lead, config: ctx.depositConfig } : { totalCents, lead });
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
    // ONE due-date rule (deposit-rule.js INVOICE_DUE_DAYS = the Stripe invoice's).
    dueDate: new Date(DR.invoiceDueDateMs(nowMs)),
    sentAt: null,
    paidAt: null,
    viewedAt: null,
    notes: '',
    depositTerms: plan.summary || '',
    depositRepNote: plan.repNote || '',
    kyInsuranceHold: false, // a held job never gets here
    emergencyServices: false,
    terms: DR.netTermsText() + (plan.summary ? ' ' + plan.summary : ''),
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


// ── The FINAL invoice, drafted when the install is complete (2026-10-03) ──
//
// The spine had an 'installed' event and nothing called it, so a finished
// roof never asked for its money: 30 jobs at install or later, 4 invoices.
// When the lead enters Install Done (a client stage move or a spine move —
// functions/install-final-invoice.js), the server makes the job's FINAL
// invoice as a DRAFT — never sent — plus a "Send final invoice" task.
//   - The job already has a live invoice that bills the whole job (the
//     signing-day deposit draft is one: it carries the full total and the
//     deposit terms) → no new invoice; the task points at that one ("send
//     the balance").
//   - Otherwise a new draft from the same estimate, the same lines and
//     totals, with each earlier invoice for the job credited as a
//     "Less deposit paid" line (nbd:job-billing, invoice-from-estimate.js),
//     so the total due is what is left.
//   - Deterministic id per lead + job (like the deposit draft), so a
//     re-entered stage, a retried trigger and the spine's own move all land
//     on the same document.
const FINAL_AUTO_DRAFT_KIND = 'final_on_install';
function finalDraftInvoiceId(leadId, jobId) {
  return 'finaldraft_' + _seg(leadId) + '_' + (_seg(jobId) || 'job');
}
function finalTaskId(jobId) { return 'send-final-invoice-' + (_seg(jobId) || 'job'); }

/**
 * Decide the install-day final invoice. Pure.
 *   ctx = { leadId, lead, est?, estimateId?, invoices: [{ id, ...doc }], jobs?: [{ id, ...doc }], nowMs, sourceId? }
 *   jobs = leads/{leadId}/jobs: with exactly one, a PAID deposit mirrored in
 *   from the Stripe dashboard (no job stamp) and made on or after the
 *   estimate is credited (nbd:job-billing jobInvoicesOf opts, 2026-10-05).
 * → { action: 'create', invoiceId, invoice, jobId, credits }
 *   | { action: 'use_existing', invoiceId, jobId, reason }
 *   | { action: 'skip', reason, jobId? }
 */
function decideFinalDraft(ctx) {
  ctx = ctx || {};
  const lead = ctx.lead ? Object.assign({ id: ctx.leadId }, ctx.lead) : null;
  if (!lead) return { action: 'skip', reason: 'no_lead' };
  if (_isDeleted(lead)) return { action: 'skip', reason: 'deleted' };
  const sk = _stageKey(lead);
  if (sk === 'lost' || lead.stageRole === 'lost') return { action: 'skip', reason: 'lost' };
  const owner = lead.userId ? String(lead.userId) : '';
  if (!owner) return { action: 'skip', reason: 'no_owner' };

  const estRaw = (ctx.est && !_isDeleted(ctx.est) && _sameTenant(ctx.est, lead)) ? ctx.est : null;
  // The homeowner's accepted tier (review R2-2-1, 2026-10-06): the signing-day
  // draft bills deal.acceptedPrice, so the final bills the same price.
  // deal-accepted-tier.js now writes it onto a tier-priced estimate; an
  // estimate accepted before that only RECORDED it (acceptedTier /
  // acceptedPrice beside the rep's tier) — price it here the same way,
  // unless the rep tapped "Keep" on the customer page's chip.
  const est0 = estRaw ? _priceEstimate(estRaw, _recordedAcceptance(estRaw)) : null;
  const jobId = jobIdFor(est0, lead);
  const invoices = Array.isArray(ctx.invoices) ? ctx.invoices : [];
  const jobOpts = { soleJob: IFE.soleJobOf(ctx.jobs, jobId), since: est0 ? est0.createdAt : null };

  // Already drafted (this id) and still in play → nothing new.
  const mine = IFE.jobInvoicesOf(invoices, jobId, jobOpts);
  const finalId = finalDraftInvoiceId(ctx.leadId, jobId);
  if (invoices.some((inv) => inv && inv.id === finalId)) {
    return { action: 'use_existing', invoiceId: finalId, jobId, reason: 'duplicate' };
  }

  if (!est0) {
    // No estimate: never guess an amount. A live invoice is still the one to send.
    const live = mine.filter(IFE.isLiveInvoice);
    if (live.length) return { action: 'use_existing', invoiceId: live[0].id || null, jobId, reason: 'live_invoice' };
    return { action: 'skip', reason: 'no_estimate', jobId };
  }

  const t = IFE.invoiceTotalsFromEstimate(est0, { estimateValue: CER.estimateValue });
  const totalCents = Math.round(Number(t.total) * 100);
  if (!(totalCents > 0)) return { action: 'skip', reason: 'no_total', jobId };

  const plan = IFE.planJobInvoice(totalCents, invoices, jobId, jobOpts);
  if (plan.action === 'open') {
    if (plan.reason === 'billed_in_full') {
      const live = mine.filter(IFE.isLiveInvoice);
      if (!live.length) return { action: 'skip', reason: 'billed_in_full', jobId };
      return { action: 'use_existing', invoiceId: live[0].id || null, jobId, reason: 'billed_in_full' };
    }
    return { action: 'use_existing', invoiceId: plan.invoiceId, jobId, reason: plan.reason };
  }

  const billed = IFE.applyJobCredits({ items: t.items, subtotal: t.subtotal, tax: t.tax, total: t.total }, plan.credits);
  const nowMs = Number(ctx.nowMs) || Date.now();
  const ky = J.classifyLead(lead, est0).kyInsurance === true;
  const invoice = {
    leadId: ctx.leadId,
    estimateId: ctx.estimateId || null,
    customerId: est0.customerId || null,
    customerName: IFE.resolveCustomerName(est0, lead),
    customerEmail: est0.customerEmail || lead.email || '',
    customerPhone: est0.customerPhone || lead.phone || '',
    status: 'draft',
    items: billed.items,
    subtotal: t.subtotal,
    tax: t.tax,
    taxRate: t.taxRate,
    total: billed.total,
    supplementTotal: 0,
    // The deposit was billed on the earlier invoice(s): credited above.
    depositAmount: 0,
    depositPaid: false,
    amountPaid: 0,
    balanceDue: billed.total,
    stripeInvoiceId: null,
    stripePaymentLink: null,
    dueDate: new Date(DR.invoiceDueDateMs(nowMs)),
    sentAt: null,
    paidAt: null,
    viewedAt: null,
    notes: '',
    depositTerms: '',
    depositRepNote: '',
    // Informational, like the rep's invoice: the pay link is still held by
    // createStripePaymentLink (ky-pay-link-gate) and every surface's
    // payUrlUnlessHeld until the Kentucky window has run.
    kyInsuranceHold: ky,
    emergencyServices: false,
    terms: DR.netTermsText() + ' Balance due on completion.',
    createdBy: owner,
    companyId: lead.companyId || owner,
    jobId,
    kind: 'final',
    creditTotal: billed.creditTotal || 0,
    creditedInvoiceIds: plan.credits.map((c) => c.invoiceId).filter(Boolean),
    autoDraft: {
      kind: FINAL_AUTO_DRAFT_KIND,
      event: 'installed',
      sourceId: ctx.sourceId ? String(ctx.sourceId).slice(0, 140) : null,
    },
  };
  return { action: 'create', invoiceId: finalId, invoice, jobId, credits: plan.credits };
}

/** The "Send final invoice" task — a reminder for the rep; nothing is sent. */
function finalTask(jobId, decision, todayYmd) {
  const d = decision || {};
  let notes;
  if (d.action === 'create') {
    notes = 'The job is installed. A draft final invoice was made from the estimate'
      + (d.credits && d.credits.length ? ', less what was already billed' : '')
      + '. Nothing has been sent — open it, check it, and tap Send.';
  } else if (d.action === 'use_existing') {
    notes = 'The job is installed. Open its invoice and send the balance — nothing has been sent.';
  } else {
    notes = 'The job is installed and there is no estimate to bill from. Open the customer and tap Record payment (or make the invoice) — nothing has been sent.';
  }
  return {
    id: finalTaskId(jobId),
    doc: {
      text: '🧾 Send final invoice',
      title: 'Send final invoice',
      notes,
      source: 'final_invoice',
      invoiceId: d.invoiceId || null,
      jobId: jobId || null,
      actionId: 'send_final_invoice',
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
  FINAL_AUTO_DRAFT_KIND, finalDraftInvoiceId, finalTaskId, decideFinalDraft, finalTask,
};
