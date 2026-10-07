/**
 * money-paper-logic.js — pure rules for "every charge gets a filed document"
 * (Jo's standing rule; live-CRM handoff 2026-09-30 #7). No Firestore, no
 * Stripe, no Chromium: functions/money-paper.js does the I/O and is thin.
 *
 * A CRM invoice (invoices/{id}) on the NBD tenant produces:
 *   - an NBD-500 INVOICE document when a Stripe invoice is attached to it
 *     (stripe-crm-invoice.js sets stripeInvoiceId + stripeHostedUrl), filed
 *     on the lead's Documents tab. A re-minted Stripe invoice (new balance
 *     after a deposit) files a fresh NBD-500 for the new amount.
 *   - an NBD-510 RECEIPT once the invoice is PAID IN FULL (status 'paid'),
 *     whichever way it got there: a Stripe payment, or Mark Paid for Zelle /
 *     check / cash. Never before it is paid (Jo: the receipt exists only when
 *     the money does).
 *   - When Mark Paid (not Stripe) takes it to paid while a Stripe invoice is
 *     still open, that Stripe invoice is marked paid OUT OF BAND so the
 *     homeowner can no longer pay it a second time by card. The ledger key
 *     `<in_id>:oob` is recorded on the CRM invoice FIRST, so the Stripe
 *     ledger's invoice.paid ingest (stripe-ledger.js book → planCredit) sees
 *     it and does not credit the same money twice.
 *
 * Instance ids follow the NBD Document Standard: NBD-YYYY-MMDD-XXXX, the date
 * in Eastern time and XXXX a per-day counter (0001, 0002, …).
 */
'use strict';

// The ONE invoice due-date rule (deposit-rule.js INVOICE_DUE_DAYS).
const DR = require('./deposit-rule');
const LAP = require('./lead-artifact-paths');

const CODES = { invoice: 'NBD-500', receipt: 'NBD-510' };

// Eastern-time calendar parts of a moment.
function etParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {};
  f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return { y: p.year, md: p.month + p.day, ymd: p.year + '-' + p.month + p.day };
}

function instanceId(ms, seq) {
  const { y, md } = etParts(ms);
  const n = Math.max(1, Math.min(9999, parseInt(seq, 10) || 1));
  return 'NBD-' + y + '-' + md + '-' + String(n).padStart(4, '0');
}

const toCents = (v) => Math.round((Number(v) || 0) * 100);
const isStripeInv = (id) => typeof id === 'string' && id.startsWith('in_');
const paper = (inv) => (inv && inv.paper && typeof inv.paper === 'object') ? inv.paper : {};

function lastPayment(inv) {
  const p = Array.isArray(inv && inv.payments) ? inv.payments : [];
  return p.length ? p[p.length - 1] : null;
}

/**
 * What the trigger should do for this write. `after` is the invoice now.
 * → { fileInvoice, fileReceipt, markOob }
 */
function decide(after, opts) {
  const o = opts || {};
  const out = { fileInvoice: false, fileReceipt: false, markOob: false };
  if (!after || after.deleted === true) return out;
  // NBD tenant only (Jo's rule, NBD's own Stripe account). A contractor
  // tenant's invoices are untouched.
  if (o.ownerUid && (after.companyId || after.userId) !== o.ownerUid) return out;
  if (after.status === 'void' || after.status === 'draft') return out;
  const pp = paper(after);
  const paidInFull = after.status === 'paid' && toCents(after.total) > 0 && toCents(after.balanceDue) <= 0;

  // NBD-500: a live Stripe invoice we have not filed yet (by Stripe id).
  if (!paidInFull && isStripeInv(after.stripeInvoiceId) && after.stripeHostedUrl
      && !(pp.invoice && pp.invoice.stripeInvoiceId === after.stripeInvoiceId)) {
    out.fileInvoice = true;
  }
  // NBD-510: paid in full, once.
  if (paidInFull && !pp.receipt) out.fileReceipt = true;
  // Out of band: paid in full by a NON-Stripe payment while a Stripe invoice
  // is attached, once per Stripe invoice.
  const last = lastPayment(after);
  if (paidInFull && isStripeInv(after.stripeInvoiceId) && last && last.method !== 'stripe'
      && last.source !== 'stripe_ledger'
      && !(pp.oob && pp.oob.stripeInvoiceId === after.stripeInvoiceId)) {
    out.markOob = true;
  }
  return out;
}

// The Storage object a plate photo names: path, else storagePath, else (legacy
// url-only docs) the object inside its download url. '' when none.
function plateObjectPath(p) {
  if (!p) return '';
  return p.path || p.storagePath || LAP.storagePathFromUrl(p.url) || '';
}

// The photos plateFor may use for `lead` (2026-10-06). Photo docs are
// client-written and their object is signed with the admin SDK, so a photo
// counts only when it is the lead's tenant's (same owner, or same companyId)
// AND names a photo-shaped object (photos/{uid}/ or this lead's
// homeowner-uploads/{uid}/{leadId}/). A url that is not a Storage object is
// dropped (Chromium would fetch it). plateFor then checks the uid in the path
// against the photo's owner or company (photoObjectAllowed) before signing.
function platePhotosForLead(lead, photos) {
  const l = lead || {};
  return (photos || []).filter((p) => {
    if (!p) return false;
    const sameTenant = (typeof p.userId === 'string' && p.userId && p.userId === l.userId)
      || (typeof l.companyId === 'string' && l.companyId && p.companyId === l.companyId);
    return sameTenant && !!LAP.photoObjectUid(plateObjectPath(p), p);
  });
}

// P4 (Jo, 2026-09-30): the cover photo, else the newest After photo, else none.
function pickPlatePhoto(lead, photos) {
  const list = (photos || []).filter((p) => p && !p.deleted && (p.path || p.storagePath || p.url));
  if (lead && lead.coverPhotoId) {
    const c = list.find((p) => p.id === lead.coverPhotoId);
    if (c) return c;
  }
  const ms = (t) => (t && typeof t.toMillis === 'function') ? t.toMillis() : (t instanceof Date ? t.getTime() : (Number(t) || 0));
  const after = list.filter((p) => String(p.phase || '').toLowerCase() === 'after')
    .sort((a, b) => ms(b.createdAt || b.uploadedAt) - ms(a.createdAt || a.uploadedAt));
  return after[0] || null;
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' });
}

// The invoice's STORED due date (the one Stripe and the CRM show) as text in
// Eastern; '' when there is none or it is unreadable. A bare "YYYY-MM-DD"
// is a calendar date and prints as written.
function storedDueText(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  }
  let t;
  if (typeof v.toMillis === 'function') t = v.toMillis();
  else if (typeof v.toDate === 'function') t = v.toDate().getTime();
  else if (v instanceof Date) t = v.getTime();
  else if (typeof v === 'object' && typeof v.seconds === 'number') t = v.seconds * 1000;
  else t = new Date(v).getTime();
  return Number.isFinite(t) ? fmtDate(t) : '';
}

function preparedFor(inv, lead) {
  const name = inv.customerName || (lead ? (((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || lead.name) : '') || 'Homeowner';
  return {
    name,
    address: inv.customerAddress || (lead && lead.address) || '',
    customerId: (lead && lead.customerId) || inv.customerId || null,
    projectLine: inv.projectLine || null,
  };
}

// NBD's own chrome, as document-generator.js sends it for the platform tenant.
const PREPARED_BY = { name: 'Joe Deal', role: 'Project Owner · No Big Deal Home Solutions', phone: '(859) 420-7382', email: 'jd@nobigdealwithjoedeal.com' };

function linesOf(inv) {
  const src = Array.isArray(inv.lineItems) ? inv.lineItems : (Array.isArray(inv.items) ? inv.items : []);
  return src.map((i) => {
    const qty = Number(i.qty || i.quantity || 1) || 1;
    const unitPrice = Number(i.rate != null ? i.rate : (i.unitPrice != null ? i.unitPrice : 0)) || 0;
    const lineTotal = Number(i.lineTotal != null ? i.lineTotal : (i.total != null ? i.total : qty * unitPrice)) || 0;
    return { description: String(i.description || i.name || 'Item'), category: i.category || '', quantity: qty, unit: i.unit || 'ea', unitPrice, lineTotal };
  });
}

/** Payload for print/templates/invoice.hbs. */
function invoicePayload(inv, lead, id, nowMs, plate) {
  const lines = linesOf(inv);
  const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
  const total = Number(inv.total) || subtotal;
  const tax = inv.tax != null ? (Number(inv.tax) || 0) : Math.max(0, Math.round((total - subtotal) * 100) / 100);
  const paid = Number(inv.amountPaid) || 0;
  const balanceDue = Math.max(0, Math.round((total - paid) * 100) / 100);
  // The stored due date; the 7-day rule only when the invoice has none
  // (review round 4 R4-6-5: the PDF printed render time + 7).
  const due = storedDueText(inv.dueDate) || fmtDate(DR.invoiceDueDateMs(nowMs));
  return {
    docNumber: id,
    coverTagline: 'Invoice for<br>your project.',
    coverSub: 'Itemized invoice with payment detail and remaining balance. Pay online with the button, by Zelle, or by check.',
    preparedFor: preparedFor(inv, lead),
    preparedBy: PREPARED_BY,
    projectMeta: [
      { label: 'Document', value: CODES.invoice },
      { label: 'Invoice No.', value: id },
      { label: 'Due', value: due },
    ],
    summary: { headline: 'Invoice for your project.', body: inv.notes || null },
    invoice: { number: id, date: fmtDate(nowMs), dueDate: due, status: paid > 0 ? 'partial' : 'due' },
    lines, subtotal, tax, paymentsReceived: paid, total, balanceDue,
    notes: inv.notes || null,
    payUrl: inv.stripeHostedUrl || null,
    photoPlate: plate || null,
    refs: { crmInvoice: inv.invoiceNumber || null, stripeInvoice: inv.stripeInvoiceNumber || null },
  };
}

const METHOD_LABEL = { zelle: 'Zelle', check: 'Check', cash: 'Cash', stripe: 'Card / bank (online)', ach: 'ACH', cashapp: 'Cash App', other: 'Other' };

/** Payload for print/templates/receipt.hbs — the payment that closed it out. */
function receiptPayload(inv, lead, id, nowMs, plate) {
  const pays = Array.isArray(inv.payments) ? inv.payments : [];
  const last = pays[pays.length - 1] || {};
  const amount = Number(last.amount) || 0;
  const total = Number(inv.total) || 0;
  const prior = Math.max(0, Math.round(((Number(inv.amountPaid) || 0) - amount) * 100) / 100);
  const ms = (t) => (t && typeof t.toMillis === 'function') ? t.toMillis() : (t instanceof Date ? t.getTime() : (Number(t) || nowMs));
  return {
    docNumber: id,
    coverTagline: 'Paid<br>in full.',
    coverSub: 'A record of payment posted to your project. Keep it with your project documents for warranty and tax purposes.',
    preparedFor: preparedFor(inv, lead),
    preparedBy: PREPARED_BY,
    projectMeta: [
      { label: 'Document', value: CODES.receipt },
      { label: 'Receipt No.', value: id },
      { label: 'Amount', value: '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) },
    ],
    payment: {
      number: id,
      date: fmtDate(ms(last.at || last.date || inv.paidAt)),
      method: METHOD_LABEL[String(last.method || '').toLowerCase()] || String(last.method || 'Payment'),
      reference: last.reference || last.paymentIntentId || '—',
    },
    amount,
    contractTotal: total || null,
    priorPayments: prior,
    balanceRemaining: 0,
    appliedTo: (inv.invoiceNumber ? 'Invoice ' + inv.invoiceNumber : null) || inv.projectLine || null,
    photoPlate: plate || null,
  };
}

/** The Documents-tab row (leads/{leadId}/documents/{rowId}). */
function documentRow(kind, id, inv, pdfPath, bytes, extra) {
  return Object.assign({
    name: (kind === 'invoice' ? 'Invoice ' : 'Receipt ') + id,
    typeName: kind === 'invoice' ? 'Invoice' : 'Payment Receipt',
    type: 'application/pdf',
    source: kind === 'invoice' ? 'nbd_invoice' : 'nbd_receipt',
    docCode: CODES[kind],
    instanceId: id,
    pdfPath,
    size: bytes || 0,
    invoiceId: inv.id || null,
    stripeInvoiceId: inv.stripeInvoiceId || null,
    status: kind === 'invoice' ? 'sent' : null,
  }, extra || {});
}

function pdfPathFor(ownerUid, leadId, id) {
  return 'documents/' + ownerUid + '/' + leadId + '/' + id + '.pdf';
}

// The Storage object metadata a filed PDF is saved with. `signed: 'true'` in
// the custom metadata is the storage.rules lock (storedObjectIsSigned): a
// filed invoice/receipt is a record, so no client may overwrite or delete it
// (R3-4, 2026-10-06 — an owner could overwrite one with text/html behind a
// live /report/<token> link). Admin-SDK writes are unaffected.
// tests/storage-rules.test.js seeds its object from THIS function.
function filedPdfMetadata(kind, id, invoiceId) {
  return {
    contentType: 'application/pdf',
    cacheControl: 'private, max-age=31536000',
    metadata: { docCode: CODES[kind], instanceId: id, invoiceId, signed: 'true' },
  };
}

// ── "Paid but not closed" (2026-10-03 data audit) ────────────────────────
// Three owner-tenant invoices were paid in full while their lead sat on an
// open stage: a Zelle/check payoff recorded with Mark Paid only advances a
// pre-contract lead to Contract Signed (not a won stage), and the Stripe
// payoff advance refuses warranty/service leads. Nothing told the owner. We
// do NOT move the stage here (that is the owner's call) — we file one task on
// the lead, due today, so it shows on Today's Tasks and the bell.
//
// → the task doc to create, or null. Pure; the caller supplies the role
// helpers (stage-roles.js) and today's local YYYY-MM-DD.
function paidNotClosedTask(lead, invoice, invoiceId, todayYmd, roles) {
  if (!lead || lead.deleted === true || !invoice || !roles) return null;
  const paidInFull = invoice.status === 'paid' && toCents(invoice.total) > 0 && toCents(invoice.balanceDue) <= 0;
  if (!paidInFull) return null;
  if (roles.roleFor(lead) === 'won') return null;
  // A Stripe payoff on a lead the webhook is allowed to advance is about to
  // land on Final Payment (a won stage) — not a "not closed" case.
  const last = lastPayment(invoice);
  const viaStripe = !!(last && (last.method === 'stripe' || last.source === 'stripe_ledger'));
  if (viaStripe && roles.payoffAdvanceAllowed(lead)) return null;
  const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || lead.address || 'this customer';
  return {
    text: '💵 Paid in full — close out ' + name + '?',
    title: 'Paid in full — not closed',
    notes: 'Invoice ' + String(invoiceId) + ' is paid in full but the job is still on an open stage. '
      + 'Move it to Closed (or the right won stage) if the work is done.',
    source: 'paid_not_closed',
    invoiceId: String(invoiceId),
    dueDate: String(todayYmd || ''),
    done: false,
  };
}

// Deterministic task id: a re-fired trigger finds it instead of adding another.
function paidNotClosedTaskId(invoiceId) {
  return 'paid-not-closed-' + String(invoiceId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

module.exports = { CODES, etParts, instanceId, decide, pickPlatePhoto, platePhotosForLead, plateObjectPath, invoicePayload, receiptPayload, documentRow, pdfPathFor, filedPdfMetadata, lastPayment, toCents, paidNotClosedTask, paidNotClosedTaskId };
