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
  const due = fmtDate(nowMs + 7 * 86400000);
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

module.exports = { CODES, etParts, instanceId, decide, pickPlatePhoto, invoicePayload, receiptPayload, documentRow, pdfPathFor, lastPayment, toCents };
