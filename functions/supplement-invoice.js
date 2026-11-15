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
const GENERIC = 'Invoice not made: something went wrong on the server. Try again, and ask for help if it keeps happening.';
const DEAD_INVOICE = ['void', 'cancelled'];
// Approval records count only from this moment (security review M2,
// 2026-11-15): production's rules before this change did not know the
// approval fields, so a rep could have written a fake one. The conductor sets
// this to the real deploy time if that is later.
const APPROVALS_SINCE_MS = Date.UTC(2026, 10, 15, 0, 0, 0);
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cents = (v) => Math.round((Number(v) || 0) * 100);

/** A refusal planSupplementInvoice means the user to read (L1). */
class PlanRefusal extends Error {}

/** A server Timestamp's milliseconds, or NaN for anything else (a number or a map a client wrote). */
function timestampMs(v) {
  return (v && typeof v === 'object' && typeof v.toMillis === 'function') ? Number(v.toMillis()) : NaN;
}

/**
 * The owner-side approval record a billable supplement must carry. Pure.
 * approvedBy set; approvedAt a real Timestamp, at or after the cutoff and not
 * in the future; approvalEvidence with a note (not blank, at most 1000) and/or
 * a document under companies/{companyId}/supplement-evidence/. WHO approved is
 * checked against the company in the transaction (approverOk).
 */
function approvalEvidenceOk(sup, companyId, nowMs) {
  const s = sup || {};
  if (!(typeof s.approvedBy === 'string' && s.approvedBy)) return false;
  const at = timestampMs(s.approvedAt);
  const now = Number(nowMs) || Date.now();
  if (!(at >= APPROVALS_SINCE_MS && at <= now + CLOCK_SKEW_MS)) return false;
  const ev = s.approvalEvidence;
  if (!ev || typeof ev !== 'object') return false;
  const note = typeof ev.note === 'string' ? ev.note.trim() : '';
  const p = typeof ev.path === 'string' ? ev.path : '';
  const noteOk = note.length > 0 && note.length <= EVIDENCE_NOTE_MAX;
  const pathOk = !!companyId && p.indexOf('companies/' + companyId + '/supplement-evidence/') === 0 && p.length <= 400 && !/\.\./.test(p);
  return noteOk || pathOk;
}

/**
 * Is this uid the company's owner side? Pure. claims = that user's custom
 * claims; company = companies/{companyId} data or null.
 *   the platform admin (role 'admin'), the company's company_admin, the owner
 *   named on the company doc, or a solo owner (the company is keyed by their uid).
 */
function approverOk(uid, companyId, claims, company) {
  if (!uid || !companyId) return false;
  const c = claims || {};
  if (c.role === 'admin') return true;
  if (c.role === 'company_admin' && c.companyId === companyId) return true;
  if (company && typeof company.ownerId === 'string' && company.ownerId === uid) return true;
  return uid === companyId && (!c.companyId || c.companyId === uid) && (!c.role || c.role === 'company_admin');
}

// The same dollars + line text as docs/pro/js/invoice-pipeline.js
// supplementBillableAmount / selectBillableSupplements / applySupplementsToTotals
// (tests/supplement-invoice-callable-2026-11-14.test.js pins the parity). The
// reason is a rep's free text: control characters and < > are dropped (L3).
function supplementBillableAmount(sup) {
  if (!sup) return 0;
  if (sup.status === 'partial') return Number(sup.submission && sup.submission.approvedAmount) || 0;
  if (sup.status === 'approved') return Number(sup.supplementTotal) || 0;
  return 0;
}
function supplementLine(sup) {
  const version = Number(sup && sup.version) || 1;
  const reason = (sup && sup.reason ? String(sup.reason) : '').replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const tag = sup && sup.status === 'partial' ? 'partial approval' : 'approved';
  let description = 'Insurance Supplement #' + version + ' (' + tag + ')';
  if (reason) description += ' — ' + reason;
  const amt = round2(supplementBillableAmount(sup));
  return { description, quantity: 1, unitPrice: amt, total: amt };
}
const versionLabel = (list) => list.map((d) => '#' + (Number(d.version) || 1)).join(', ');

/**
 * Which of the estimate's supplements this invoice bills. Pure.
 *   docs = [{ id, ...data }], ctx = { companyId, nowMs, liveInvoiceIds: Set }
 *   liveInvoiceIds = the invoices that still bill (exist, not void / deleted);
 *   a supplement stamped to one of them is ALREADY billed; one stamped to an
 *   invoice that no longer bills is billed again (its bill is gone).
 * → { bill: [{ id, doc, line, cents }], billed: [{ id, line, cents, invoiceId }], refuse: '' | message }
 */
function classifySupplements(docs, ctx) {
  const cid = (ctx && ctx.companyId) || '';
  const live = (ctx && ctx.liveInvoiceIds) || new Set();
  const bill = [], billed = [], unapproved = [], unplaced = [];
  for (const d of docs || []) {
    if (!d || d.deleted === true) continue;
    const claims = supplementBillableAmount(d) > 0 && APPROVED.includes(d.status);
    if (!d.companyId) {
      // A legacy supplement (saved before companyId) that claims money and
      // is not on a live bill: its tenant is unproven, so it is neither
      // billed nor ignored.
      if (claims && !(d.invoicedInvoiceId && live.has(d.invoicedInvoiceId))) unplaced.push(d);
      continue;
    }
    if (d.companyId !== cid) continue;            // another company's: never billed here
    if (!claims) continue;
    if (d.invoicedInvoiceId && live.has(d.invoicedInvoiceId)) {
      billed.push({ id: d.id, line: supplementLine(d), cents: cents(supplementBillableAmount(d)), invoiceId: d.invoicedInvoiceId });
      continue;
    }
    if (!approvalEvidenceOk(d, cid, ctx && ctx.nowMs)) { unapproved.push(d); continue; }
    bill.push({ id: d.id, doc: d, line: supplementLine(d), cents: cents(supplementBillableAmount(d)) });
  }
  let refuse = '';
  if (unplaced.length) {
    refuse = 'Invoice not made: insurance supplement ' + versionLabel(unplaced) + ' was saved before supplements were tied to a company, '
      + 'so it cannot be billed yet. Ask your NBD Pro admin to review it (supplement backfill).';
  } else if (unapproved.length) {
    refuse = unapprovedMessage(unapproved);
  }
  return { bill, billed, refuse };
}
function unapprovedMessage(list) {
  return 'Invoice not made: insurance supplement ' + versionLabel(list) + ' is marked approved, but the company owner has not recorded '
    + 'the approval (with the carrier\'s approval note or letter). The owner or company admin must re-approve it, then make the invoice.';
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
/** company staff or the platform admin acting for this company. Pure. */
function isStaffFor(auth, companyId) {
  const c = (auth && auth.token) || {};
  return c.role === 'admin' || ((c.role === 'company_admin' || c.role === 'manager') && !!companyId && c.companyId === companyId);
}

/**
 * The invoice document. Pure. Mirrors docs/pro/js/invoice-pipeline.js
 * createOrOpenJobInvoice's create branch field for field.
 *   o = { est (signed view), estimateId, lead, leadId, jobId, companyId, uid,
 *         bill, billed (classifySupplements), invoices, jobs, nowMs }
 * The job total it plans against is the base PLUS every approved supplement,
 * billed before or new (M3): an earlier supplement invoice is then credited,
 * and only the new supplements are stamped onto this one.
 * → { action: 'open', invoiceId, reason } | { action: 'create', doc, credits }
 */
function planSupplementInvoice(o) {
  const est = o.est || {};
  const lead = o.lead || null;
  const t = IFE.invoiceTotalsFromEstimate(est, { estimateValue: CER.estimateValue });
  const billed = o.billed || [];
  const supItems = billed.map((b) => b.line).concat(o.bill.map((b) => b.line));
  const newC = o.bill.reduce((s, b) => s + b.cents, 0);
  const allC = newC + billed.reduce((s, b) => s + b.cents, 0);
  const items = (t.items || []).concat(supItems);
  const subtotal = round2((Number(t.subtotal) || 0) + allC / 100);
  const tax = Number(t.tax) || 0;
  let total = round2((Number(t.total) || 0) + allC / 100);
  const supplementTotal = round2(newC / 100);

  let jobCredits = [];
  if (o.leadId) {
    const plan = IFE.planJobInvoice(Math.round(total * 100), o.invoices || [], o.jobId,
      { soleJob: IFE.soleJobOf(o.jobs, o.jobId), since: est.createdAt });
    if (plan.action === 'open' && plan.invoiceId) return { action: 'open', invoiceId: plan.invoiceId, reason: plan.reason };
    if (plan.action === 'create') jobCredits = (plan.credits || []).slice();
    // Every invoice an already-billed supplement is on is credited, paid or
    // not, job-stamped or not: its supplements and base are counted again in
    // this job total (M3), so it must come off.
    const credited = new Set(jobCredits.map((c) => c.invoiceId));
    for (const inv of o.billedInvoices || []) {
      if (!inv || credited.has(inv.id)) continue;
      const c = cents(inv.total);
      if (!(c > 0)) continue;
      const paid = String(inv.status || '').toLowerCase() === 'paid' || cents(inv.amountPaid) >= c;
      jobCredits.push({ invoiceId: inv.id, label: paid ? 'Less invoice paid' : 'Less invoice billed', cents: c, paid });
      credited.add(inv.id);
    }
    if (jobCredits.reduce((s2, c) => s2 + c.cents, 0) >= Math.round(total * 100)) {
      throw new PlanRefusal('Invoice not made: the earlier invoices on this job already cover its total. Reload the job and check its invoices.');
    }
  } else if (billed.length) {
    // No lead to credit the earlier supplement invoice against: never bill those supplements twice.
    throw new PlanRefusal('Invoice not made: this estimate is not linked to a customer, so the earlier invoice for its supplements cannot be credited. Link the estimate to its customer, then make the invoice.');
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
  if (!(Number(doc.total) > 0)) throw new PlanRefusal('This estimate has no dollar total — open it and set a price before invoicing.');
  return { action: 'create', doc, credits: jobCredits };
}

async function defaultGetClaims(uid) {
  try {
    const u = await require('firebase-admin/auth').getAuth().getUser(uid);
    return (u && u.customClaims) || {};
  } catch (_) { return {}; }   // an unknown user is nobody's owner side
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
  const getClaims = (deps && deps.getClaims) || defaultGetClaims;
  let result;
  try {
    result = await db.runTransaction(async (tx) => {
      const es = await tx.get(db.collection('estimates').doc(estimateId));
      if (!es.exists) throw new HttpsError('permission-denied', REFUSED);
      const saved = es.data() || {};
      // The tenant first (L2): another company learns nothing, not even "deleted".
      const companyId = billingTenant(auth, saved);
      if (!companyId) throw new HttpsError('permission-denied', REFUSED);
      if (saved.deleted === true) throw new HttpsError('failed-precondition', 'This estimate was deleted.');
      const est = CER.signedView(saved);
      const staff = isStaffFor(auth, companyId);

      // WHICH lead (M1): the estimate's own; an asked lead only for a lead-less
      // estimate, and only one the caller may bill (staff of the company, or
      // the caller's own lead). The lead must belong to the estimate's author
      // unless company staff is billing it.
      const estLead = (typeof saved.leadId === 'string' && ID_RE.test(saved.leadId)) ? saved.leadId : '';
      const leadId = estLead || askedLead;
      if (!leadId && saved.userId !== auth.uid) {
        throw new HttpsError('failed-precondition', 'Invoice not made: this estimate is not linked to a customer. Link it to its customer, or have the person who wrote it make the invoice.');
      }
      let lead = null;
      if (leadId) {
        const ls = await tx.get(db.collection('leads').doc(leadId));
        lead = ls.exists ? (ls.data() || {}) : null;
        const sameCompany = !!lead && (lead.companyId === companyId || (!lead.companyId && lead.userId === saved.userId));
        const authorsLead = !!lead && lead.userId === saved.userId;
        const askedOk = !!estLead || staff || (!!lead && lead.userId === auth.uid);
        if (!lead || !sameCompany || !(authorsLead || staff) || !askedOk) throw new HttpsError('permission-denied', REFUSED);
      }
      const jobId = (saved.jobId && JOB_RE.test(String(saved.jobId)) ? String(saved.jobId) : null)
        || (lead && typeof lead.activeJobId === 'string' && JOB_RE.test(lead.activeJobId) ? lead.activeJobId : null);

      const sq = await tx.get(db.collection('supplements').where('parentEstimateId', '==', estimateId));
      const sups = sq.docs.map((d) => Object.assign({ id: d.id }, d.data()));

      // The job's invoices (M4: a legacy one with no companyId counts when the
      // estimate's author or the lead's owner made it) and any invoice a
      // supplement is stamped to, to tell "already billed" from "its bill is gone".
      let invoices = [], jobs = null;
      if (leadId) {
        const iq = await tx.get(db.collection('invoices').where('leadId', '==', leadId));
        invoices = iq.docs.map((d) => Object.assign({ id: d.id }, d.data())).filter((inv) => inv.companyId === companyId
          || (!inv.companyId && (inv.createdBy === saved.userId || (lead && inv.createdBy === lead.userId))));
        if (jobId) {
          const jq = await tx.get(db.collection('leads').doc(leadId).collection('jobs'));
          jobs = jq.docs.map((d) => Object.assign({ id: d.id }, d.data()));
        }
      }
      const byId = new Map(invoices.map((inv) => [inv.id, inv]));
      for (const s of sups) {
        const iid = s.invoicedInvoiceId;
        if (typeof iid === 'string' && ID_RE.test(iid) && !byId.has(iid)) {
          const is = await tx.get(db.collection('invoices').doc(iid));
          if (is.exists) byId.set(iid, Object.assign({ id: iid }, is.data()));
        }
      }
      const liveInvoiceIds = new Set();
      for (const [id, inv] of byId) {
        const st = String(inv.status || '').toLowerCase();
        if (inv.deleted === true || inv.deletedAt || DEAD_INVOICE.includes(st)) continue;
        if (inv.companyId && inv.companyId !== companyId) continue;
        liveInvoiceIds.add(id);
      }

      // Every supplement this company has on the estimate must belong to this
      // lead (M1): their leadId is frozen at create.
      for (const s of sups) {
        if (s.companyId === companyId && s.deleted !== true && (s.leadId || '') !== (leadId || '')) {
          throw new HttpsError('permission-denied', REFUSED);
        }
      }

      const { bill, billed, refuse } = classifySupplements(sups, { companyId, nowMs, liveInvoiceIds });
      if (refuse) throw new HttpsError('failed-precondition', refuse);

      // WHO approved each new one (M2): the company's owner side, checked now.
      if (bill.length) {
        const cs = await tx.get(db.collection('companies').doc(companyId));
        const company = cs.exists ? (cs.data() || {}) : null;
        const bad = [];
        const cache = new Map();
        for (const b of bill) {
          const uid = b.doc.approvedBy;
          if (!cache.has(uid)) cache.set(uid, await getClaims(uid));
          if (!approverOk(uid, companyId, cache.get(uid), company)) bad.push(b.doc);
        }
        if (bad.length) throw new HttpsError('failed-precondition', unapprovedMessage(bad));
      }

      if (!bill.length) {
        // A retry after a lost response (L4): every approved supplement is
        // already on the same live invoice → that invoice, nothing written.
        const ids = new Set(billed.map((b) => b.invoiceId));
        if (billed.length && ids.size === 1) {
          const iid = billed[0].invoiceId;
          return { invoiceId: iid, reused: true, reason: 'already_billed', supplementTotal: 0, supplementIds: [], creditCents: 0 };
        }
        throw new HttpsError('failed-precondition', 'The insurance supplements on this job changed (none is billable now). Reload and make the invoice again.');
      }

      let plan;
      try {
        const billedInvoices = Array.from(new Set(billed.map((b) => b.invoiceId))).map((iid) => byId.get(iid)).filter(Boolean);
        plan = planSupplementInvoice({ est, estimateId, lead, leadId, jobId, companyId, uid: auth.uid, bill, billed, billedInvoices, invoices, jobs, nowMs });
      } catch (e) {
        if (e instanceof PlanRefusal) throw new HttpsError('failed-precondition', e.message);
        throw e;
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
  } catch (e) {
    // Our own refusals carry their words; anything else is generic (L1).
    if (e instanceof HttpsError) throw e;
    try { require('firebase-functions/v2').logger.error('supplement_invoice_failed', { estimateId, byUid: auth.uid, err: String((e && e.message) || e).slice(0, 300) }); } catch (_) { /* never fails the call */ }
    throw new HttpsError('internal', GENERIC);
  }
  try {
    require('firebase-functions/v2').logger.info('supplement_invoice', {
      estimateId, invoiceId: result.invoiceId, reused: result.reused, supplements: result.supplementIds.length, byUid: auth.uid,
    });
  } catch (_) { /* logging never fails the invoice */ }
  return Object.assign({ ok: true }, result);
}

const { onCall } = require('firebase-functions/v2/https');

exports.APPROVED = APPROVED;
exports.APPROVALS_SINCE_MS = APPROVALS_SINCE_MS;
exports.EVIDENCE_NOTE_MAX = EVIDENCE_NOTE_MAX;
exports.PlanRefusal = PlanRefusal;
exports.timestampMs = timestampMs;
exports.approvalEvidenceOk = approvalEvidenceOk;
exports.approverOk = approverOk;
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
