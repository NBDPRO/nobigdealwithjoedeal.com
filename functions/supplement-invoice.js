/**
 * functions/supplement-invoice.js — make an invoice from an estimate WITH its
 * approved insurance supplements, and mark those supplements billed, on the
 * server (Finding 5, Joe's decision 2026-11-14).
 *
 *   createSupplementInvoice (onCall, App Check enforced) — { estimateId, leadId? }
 *     → { ok, invoiceId, reused, reason?, supplementTotal, supplementIds, creditCents }
 *
 * WHY THE SERVER. The browser used to write the invoice and then stamp each
 * supplement it folded in (invoicedInvoiceId) so a later progress invoice
 * would not bill it twice. Two security reviews of #3060 showed a client
 * stamp cannot be made safe in rules: a throwaway $1 invoice stamped a
 * supplement "billed" for good. Now the client may never stamp
 * (firestore.rules /supplements: the stamp branch is gone), and this callable
 * decides everything money-related from its own reads, in ONE transaction:
 *
 *   - the estimate (its SIGNED view when signed) → the base lines and totals
 *     (invoice-from-estimate.js, the same copy the server drafts use);
 *   - every supplement on the estimate (Admin SDK: it sees all of them,
 *     legacy ones without companyId too) → which bill and for how much;
 *   - the lead's other invoices for the job → open it / credit them
 *     (planJobInvoice, applyJobCredits);
 *   - the deposit (deposit-rule.js) on the total with supplements;
 *   - then it creates the invoice and stamps each billed supplement.
 *
 * WHO. A signed-in, non-viewer caller who may bill the estimate: its author
 * (same tenant), company staff (company_admin / manager) of the estimate's
 * company, or the platform admin. The invoice is stamped with the estimate's
 * company. Another tenant gets the same refusal as a missing estimate.
 *
 * WHICH SUPPLEMENTS BILL (Joe, 2026-11-14). Status approved / partial, not
 * soft-deleted, not already billed, in this estimate's company, AND carrying
 * an owner-side approval record (approvedBy, approvedAt, approvalEvidence with
 * a note or a company document path; firestore.rules lets only the company
 * owner side write it). An approved / partial supplement WITHOUT that record
 * (approved before this rule, or legacy without companyId) is NOT silently
 * dropped and NOT billed: the invoice is refused and says which supplement
 * the owner must re-approve.
 */
'use strict';

const IFE = require('./invoice-from-estimate');
const CER = require('./customer-estimate-rows');
const DR = require('./deposit-rule');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const JOB_RE = /^[A-Za-z0-9_-]{1,40}$/;
const APPROVED = ['approved', 'partial'];
const EVIDENCE_NOTE_MAX = 1000;
const REFUSED = 'You cannot make an invoice for this estimate.';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cents = (v) => Math.round((Number(v) || 0) * 100);

/** The owner-side approval record a billable supplement must carry. Pure. */
function approvalEvidenceOk(sup, companyId) {
  const s = sup || {};
  if (!(typeof s.approvedBy === 'string' && s.approvedBy)) return false;
  if (s.approvedAt == null) return false;
  const ev = s.approvalEvidence;
  if (!ev || typeof ev !== 'object') return false;
  const note = typeof ev.note === 'string' ? ev.note.trim() : '';
  const p = typeof ev.path === 'string' ? ev.path : '';
  const noteOk = note.length > 0 && note.length <= EVIDENCE_NOTE_MAX;
  const pathOk = !!companyId && p.indexOf('companies/' + companyId + '/supplement-evidence/') === 0 && p.length <= 400 && !/\.\./.test(p);
  return noteOk || pathOk;
}

// The same dollars + line text as docs/pro/js/invoice-pipeline.js
// supplementBillableAmount / selectBillableSupplements / applySupplementsToTotals
// (tests/supplement-invoice-callable-2026-11-14.test.js pins the parity).
function supplementBillableAmount(sup) {
  if (!sup) return 0;
  if (sup.status === 'partial') return Number(sup.submission && sup.submission.approvedAmount) || 0;
  if (sup.status === 'approved') return Number(sup.supplementTotal) || 0;
  return 0;
}
function supplementLine(sup) {
  const version = sup && sup.version ? sup.version : 1;
  const reason = (sup && sup.reason ? String(sup.reason) : '').trim();
  const tag = sup && sup.status === 'partial' ? 'partial approval' : 'approved';
  let description = 'Insurance Supplement #' + version + ' (' + tag + ')';
  if (reason) description += ' — ' + reason;
  const amt = round2(supplementBillableAmount(sup));
  return { description, quantity: 1, unitPrice: amt, total: amt };
}

/**
 * Which of the estimate's supplements this invoice bills. Pure.
 *   docs = [{ id, ...data }], ctx = { companyId }
 * → { bill: [{ id, line, cents }], refuse: '' | message }
 */
function classifySupplements(docs, ctx) {
  const cid = (ctx && ctx.companyId) || '';
  const bill = [];
  const unapproved = [];
  const unplaced = [];
  for (const d of docs || []) {
    if (!d || d.deleted === true) continue;
    if (d.invoicedInvoiceId) continue;
    const billable = supplementBillableAmount(d) > 0 && APPROVED.includes(d.status);
    if (!d.companyId) {
      // A legacy supplement (saved before companyId) that claims money: its
      // tenant is unproven, so it is neither billed nor ignored.
      if (billable) unplaced.push(d);
      continue;
    }
    if (d.companyId !== cid) continue;            // another company's: never billed here
    if (!billable) continue;
    if (!approvalEvidenceOk(d, cid)) { unapproved.push(d); continue; }
    bill.push({ id: d.id, line: supplementLine(d), cents: cents(supplementBillableAmount(d)) });
  }
  const label = (list) => list.map((d) => '#' + (d.version || 1)).join(', ');
  let refuse = '';
  if (unplaced.length) {
    refuse = 'Invoice not made: insurance supplement ' + label(unplaced) + ' was saved before supplements were tied to a company, '
      + 'so it cannot be billed yet. Ask your NBD Pro admin to review it (supplement backfill).';
  } else if (unapproved.length) {
    refuse = 'Invoice not made: insurance supplement ' + label(unapproved) + ' is marked approved, but the company owner has not recorded '
      + 'the approval (with the carrier\'s approval note or letter). The owner or company admin must re-approve it, then make the invoice.';
  }
  return { bill, refuse };
}

/** May this caller bill this estimate? Pure. → the invoice's companyId, or '' */
function billingTenant(auth, est) {
  if (!auth || !auth.uid || !est) return '';
  const c = auth.token || {};
  const role = typeof c.role === 'string' ? c.role : '';
  if (role === 'viewer') return '';
  const claimCid = typeof c.companyId === 'string' ? c.companyId : '';
  const estCid = typeof est.companyId === 'string' ? est.companyId : '';
  if (role === 'admin') return estCid || '';
  if (est.userId === auth.uid) {
    const mine = claimCid || auth.uid;
    if (!estCid) return mine;                     // legacy estimate: its author, under their own tenant
    return estCid === mine ? estCid : '';
  }
  if ((role === 'company_admin' || role === 'manager') && estCid && estCid === claimCid) return estCid;
  return '';
}

/**
 * The invoice document. Pure. Mirrors docs/pro/js/invoice-pipeline.js
 * createOrOpenJobInvoice's create branch field for field.
 *   o = { est (signed view), estimateId, lead, leadId, jobId, companyId, uid,
 *         bill (classifySupplements().bill), invoices, jobs, nowMs }
 * → { action: 'open', invoiceId, reason } | { action: 'create', doc, credits }
 */
function planSupplementInvoice(o) {
  const est = o.est || {};
  const lead = o.lead || null;
  const t = IFE.invoiceTotalsFromEstimate(est, { estimateValue: CER.estimateValue });
  const supItems = o.bill.map((b) => b.line);
  const supC = o.bill.reduce((s, b) => s + b.cents, 0);
  const items = (t.items || []).concat(supItems);
  const subtotal = round2((Number(t.subtotal) || 0) + supC / 100);
  const tax = Number(t.tax) || 0;
  let total = round2((Number(t.total) || 0) + supC / 100);
  const supplementTotal = round2(supC / 100);

  let jobCredits = [];
  if (o.leadId) {
    const plan = IFE.planJobInvoice(Math.round(total * 100), o.invoices || [], o.jobId,
      { soleJob: IFE.soleJobOf(o.jobs, o.jobId), since: est.createdAt });
    if (plan.action === 'open' && plan.invoiceId) return { action: 'open', invoiceId: plan.invoiceId, reason: plan.reason };
    if (plan.action === 'create') jobCredits = plan.credits || [];
  }

  let depositPlan = null, depositSplit = null, depositAmount = 0;
  if (!jobCredits.length) {
    depositPlan = DR.fromEstimate(est, { totalCents: Math.round(total * 100), lead: lead || null });
    depositSplit = DR.invoiceDeposit(depositPlan);
    depositAmount = depositSplit.depositCents / 100;
  }
  let finalItems = items;
  if (jobCredits.length) {
    const credited = IFE.applyJobCredits({ items, subtotal, tax, total }, jobCredits);
    finalItems = credited.items;
    total = credited.total;
  }
  const now = new Date(Number(o.nowMs) || Date.now());
  const doc = {
    leadId: o.leadId || null,
    estimateId: o.estimateId,
    customerId: est.customerId || null,
    customerName: IFE.resolveCustomerName(est, lead),
    customerEmail: est.customerEmail || (lead && lead.email) || '',
    customerPhone: est.customerPhone || (lead && lead.phone) || '',
    status: 'draft',
    items: finalItems,
    subtotal,
    tax,
    taxRate: t.taxRate,
    total,
    supplementTotal,
    supplementIds: o.bill.map((b) => b.id),
    depositAmount,
    depositPaid: false,
    amountPaid: 0,
    balanceDue: total,
    stripeInvoiceId: null,
    stripePaymentLink: null,
    dueDate: new Date(DR.invoiceDueDateMs(now.getTime())),
    sentAt: null,
    paidAt: null,
    viewedAt: null,
    notes: '',
    depositTerms: depositPlan ? depositPlan.summary : '',
    depositRepNote: (depositSplit && depositSplit.awaitingCarrierNumbers) ? depositSplit.note
      : ((depositPlan && depositPlan.repNote) ? depositPlan.repNote : ''),
    awaitingCarrierNumbers: !!(depositSplit && depositSplit.awaitingCarrierNumbers),
    ohioHold: !!(depositPlan && depositPlan.ohio && depositPlan.ohio.reduced === true),
    milestoneAmount: (depositSplit && depositSplit.milestoneCents > 0) ? depositSplit.milestoneCents / 100 : 0,
    milestoneReleased: false,
    kyInsuranceHold: !!(depositPlan && depositPlan.kyHold),
    emergencyServices: false,
    terms: DR.netTermsText() + (depositPlan && depositPlan.summary ? ' ' + depositPlan.summary : ''),
    createdAt: now,
    updatedAt: now,
    createdBy: o.uid,
    companyId: o.companyId,
    jobId: o.jobId || null,
    source: 'supplement_invoice',
  };
  if (jobCredits.length) {
    doc.kind = 'final';
    doc.creditTotal = jobCredits.reduce((s, c) => s + c.cents, 0) / 100;
    doc.creditedInvoiceIds = jobCredits.map((c) => c.invoiceId).filter(Boolean);
  }
  if (!(Number(doc.total) > 0)) throw new Error('This estimate has no dollar total — open it and set a price before invoicing.');
  return { action: 'create', doc, credits: jobCredits };
}

async function handleCreateSupplementInvoice(request, deps) {
  const { HttpsError } = require('firebase-functions/v2/https');
  const { assertNotViewer } = require('./shared');
  const auth = request && request.auth;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  assertNotViewer(auth.token || {});
  const data = (request && request.data) || {};
  const estimateId = typeof data.estimateId === 'string' ? data.estimateId : '';
  const askedLead = (typeof data.leadId === 'string' && ID_RE.test(data.leadId)) ? data.leadId : '';
  if (!ID_RE.test(estimateId)) throw new HttpsError('invalid-argument', 'estimateId is required');

  const db = (deps && deps.db) || require('firebase-admin/firestore').getFirestore();
  const nowMs = (deps && deps.nowMs) || Date.now();
  const result = await db.runTransaction(async (tx) => {
    const es = await tx.get(db.collection('estimates').doc(estimateId));
    if (!es.exists) throw new HttpsError('permission-denied', REFUSED);
    const saved = es.data() || {};
    if (saved.deleted === true) throw new HttpsError('failed-precondition', 'This estimate was deleted.');
    const companyId = billingTenant(auth, saved);
    if (!companyId) throw new HttpsError('permission-denied', REFUSED);
    const est = CER.signedView(saved);

    const leadId = (typeof saved.leadId === 'string' && ID_RE.test(saved.leadId)) ? saved.leadId : askedLead;
    if (!leadId && saved.userId !== auth.uid) {
      throw new HttpsError('failed-precondition', 'Invoice not made: this estimate is not linked to a customer. Link it to its customer, or have the person who wrote it make the invoice.');
    }
    let lead = null;
    if (leadId) {
      const ls = await tx.get(db.collection('leads').doc(leadId));
      lead = ls.exists ? (ls.data() || {}) : null;
      // The lead must be this company's (or the estimate author's own).
      if (!lead || !(lead.companyId === companyId || (!lead.companyId && lead.userId === saved.userId))) {
        throw new HttpsError('permission-denied', REFUSED);
      }
    }
    const jobId = (saved.jobId && JOB_RE.test(String(saved.jobId)) ? String(saved.jobId) : null)
      || (lead && typeof lead.activeJobId === 'string' && JOB_RE.test(lead.activeJobId) ? lead.activeJobId : null);

    const sq = await tx.get(db.collection('supplements').where('parentEstimateId', '==', estimateId));
    const sups = sq.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const { bill, refuse } = classifySupplements(sups, { companyId });
    if (refuse) throw new HttpsError('failed-precondition', refuse);
    if (!bill.length) {
      throw new HttpsError('failed-precondition', 'The insurance supplements on this job changed (none is billable now). Reload and make the invoice again.');
    }

    let invoices = [], jobs = null;
    if (leadId) {
      const iq = await tx.get(db.collection('invoices').where('leadId', '==', leadId));
      invoices = iq.docs.map((d) => Object.assign({ id: d.id }, d.data())).filter((inv) => inv.companyId === companyId);
      if (jobId) {
        const jq = await tx.get(db.collection('leads').doc(leadId).collection('jobs'));
        jobs = jq.docs.map((d) => Object.assign({ id: d.id }, d.data()));
      }
    }
    let plan;
    try {
      plan = planSupplementInvoice({ est, estimateId, lead, leadId, jobId, companyId, uid: auth.uid, bill, invoices, jobs, nowMs });
    } catch (e) {
      throw new HttpsError('failed-precondition', (e && e.message) || 'This estimate cannot be invoiced.');
    }
    if (plan.action === 'open') return { invoiceId: plan.invoiceId, reused: true, reason: plan.reason, supplementTotal: 0, supplementIds: [], creditCents: 0 };
    const ref = db.collection('invoices').doc();
    tx.create(ref, plan.doc);
    for (const b of bill) {
      tx.update(db.collection('supplements').doc(b.id), { invoicedInvoiceId: ref.id, invoicedAt: plan.doc.createdAt });
    }
    return {
      invoiceId: ref.id, reused: false, supplementTotal: plan.doc.supplementTotal, supplementIds: plan.doc.supplementIds,
      creditCents: plan.credits.reduce((s, c) => s + c.cents, 0),
    };
  });
  try {
    require('firebase-functions/v2').logger.info('supplement_invoice', {
      estimateId, invoiceId: result.invoiceId, reused: result.reused, supplements: result.supplementIds.length, byUid: auth.uid,
    });
  } catch (_) { /* logging never fails the invoice */ }
  return Object.assign({ ok: true }, result);
}

const { onCall } = require('firebase-functions/v2/https');

exports.APPROVED = APPROVED;
exports.EVIDENCE_NOTE_MAX = EVIDENCE_NOTE_MAX;
exports.approvalEvidenceOk = approvalEvidenceOk;
exports.supplementBillableAmount = supplementBillableAmount;
exports.supplementLine = supplementLine;
exports.classifySupplements = classifySupplements;
exports.billingTenant = billingTenant;
exports.planSupplementInvoice = planSupplementInvoice;
exports.handleCreateSupplementInvoice = handleCreateSupplementInvoice;

// The deploy workflow finds functions by grepping for this exact shape: keep it on one line.
exports.createSupplementInvoice = onCall(
  {
    region: 'us-central1',
    cors: ['https://nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app'],
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB', // never below 256MiB: a 128MiB gen2 fails its startup healthcheck
  },
  require('./tenant-guard').wrapCallable((request) => handleCreateSupplementInvoice(request))
);
