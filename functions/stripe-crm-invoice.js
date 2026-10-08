/**
 * functions/stripe-crm-invoice.js — a CRM invoice becomes a real Stripe
 * Invoice (platform tenant only).
 *
 * Jo (2026-09-29): "isn't it clear we would rather send an invoice over a
 * link?" A Stripe Invoice gives the homeowner a proper invoice page + PDF,
 * card (Apple Pay / Google Pay), Link and bank payment (ACH, us_bank_account
 * — 2026-10-04, ach-payments.js; until ACH is switched on in the Stripe
 * dashboard the list steps down to the account's own defaults, so nothing
 * breaks), and Stripe tracks it as an invoice
 * (open / paid / void), which is what lets the ledger tie the money back.
 *
 * createStripePaymentLink (stripe.js) calls mintCrmStripeInvoice for the
 * platform tenant INSTEAD of minting a bare payment link, after every one of
 * its gates (auth, tenancy, the Kentucky insurance hold, the line/total/
 * balance validation) has already passed. It returns the same shape, so the
 * CRM's Pay Online button, the SMS link and the portal's Pay Now all open the
 * Stripe invoice page with no client change. Connect tenants keep the
 * payment-link path.
 *
 * Stripe does NOT email this invoice (auto_advance:false, never sent): the
 * CRM already emails / texts the homeowner, and two invoices in one inbox is
 * worse than one. The hosted page is what the CRM's button opens.
 *
 * Tagging, so the Stripe ledger books the payment onto THIS CRM invoice:
 *   - invoice.metadata { invoiceId, leadId, companyId, userId, source:'crm' }
 *   - customer.metadata { nbd_lead_id, nbd_customer_id }
 *   - the CRM invoice gets stripeInvoiceId (in_…) BEFORE finalize, so an
 *     invoice.finalized webhook racing the response already finds it linked
 */
'use strict';

/**
 * Stripe PaymentLink line_items (price_data shape) → invoice items.
 * One invoice item per line; the total is the line's full amount, the
 * quantity goes into the description (an invoice item with `amount` is a
 * lump sum).
 */
function invoiceItemsFrom(lineItems) {
  return (lineItems || []).map((li) => {
    const pd = li.price_data || {};
    const prod = pd.product_data || {};
    const qty = Math.max(1, parseInt(li.quantity, 10) || 1);
    const unit = Math.round(Number(pd.unit_amount) || 0);
    const name = String(prod.name || 'Item').slice(0, 200);
    const desc = prod.description ? ' — ' + String(prod.description).slice(0, 300) : '';
    return { amount: unit * qty, description: (qty > 1 ? name + ' (×' + qty + ')' : name) + desc };
  }).filter((it) => it.amount !== 0);
}

// Zelle goes to the company profile's Zelle pair (Jo, 2026-10-04: (859)
// 420-7382 or jd@ — never info@, which stays the documents address).
// zelle-contact.js; NBD's defaults when the profile sets none AND tenantId is
// the NBD platform tenant (companyId-keyed, never brand strings). The ACH line
// appears only when the invoice really offers a bank payment.
const ZC = require('./zelle-contact');
const ACH = require('./ach-payments');
function footerFor(zelleText, offersAch) {
  const z = zelleText ? 'Zelle to ' + zelleText + ', or a check' : 'a check';
  return (offersAch ? 'Pay by bank (ACH) on this page — lower fees than a card. ' : '')
    + 'Also accepted: ' + z + ' payable to No Big Deal Home Solutions, LLC. Questions? Call or text (859) 420-7382.';
}
const FOOTER = footerFor(ZC.zelleContactOf(null, ZC.NBD_OWNER_UID).text, false);

/**
 * @returns {Promise<{url, id, pdf, reused}>}
 */
async function mintCrmStripeInvoice(stripe, db, args) {
  const { invoiceId, invoice, tenantId, uid, lineItems, balanceDueCents } = args;
  const invRef = db.collection('invoices').doc(String(invoiceId));

  // 1. The customer: the one already linked to the lead, else by email, else new.
  let lead = null;
  if (invoice.leadId) {
    const ls = await db.collection('leads').doc(String(invoice.leadId)).get();
    lead = ls.exists ? ls.data() : null;
  }
  let customerId = (lead && lead.stripeCustomerId) || null;
  if (!customerId && invoice.customerEmail) {
    const found = await stripe.customers.list({ email: String(invoice.customerEmail).trim(), limit: 1 });
    customerId = (found.data && found.data[0] && found.data[0].id) || null;
  }
  const custMeta = { nbd_lead_id: String(invoice.leadId || ''), nbd_customer_id: String((lead && lead.customerId) || invoice.customerId || '') };
  if (!customerId) {
    const c = await stripe.customers.create({
      name: invoice.customerName || undefined,
      email: invoice.customerEmail || undefined,
      phone: invoice.customerPhone || undefined,
      metadata: custMeta,
    }, { idempotencyKey: 'nbd-crm-cust-' + invoiceId });
    customerId = c.id;
  } else if (invoice.leadId) {
    try { await stripe.customers.update(customerId, { metadata: custMeta }); } catch (_) { /* tagging is best-effort */ }
  }
  if (invoice.leadId && lead && !lead.stripeCustomerId) {
    await db.collection('leads').doc(String(invoice.leadId)).update({ stripeCustomerId: customerId });
  }

  // 2. A prior Stripe invoice on this CRM invoice: reuse it if it already
  //    asks for exactly this balance; otherwise void it (unpaid) so the
  //    homeowner can never pay a stale amount — the same job the payment-link
  //    path's "deactivate the prior plink_" does.
  const prior = invoice.stripeInvoiceId;
  if (typeof prior === 'string' && prior.startsWith('in_')) {
    const p = await stripe.invoices.retrieve(prior);
    if (p.status === 'open' && p.amount_remaining === balanceDueCents) {
      return { url: p.hosted_invoice_url, id: p.id, pdf: p.invoice_pdf, reused: true };
    }
    // R4-11 (2026-10-06): an OPEN prior that already took part of a payment
    // used to be left as is while a new invoice was minted, so the homeowner
    // held two payable bills for the same job. It cannot be voided without
    // losing track of that payment, so refuse and say why; the office
    // reconciles the prior in Stripe first.
    if (p.status === 'open' && p.amount_paid > 0) {
      const err = new Error('Prior Stripe invoice ' + prior + ' is open and partly paid ('
        + p.amount_paid + ' of ' + (p.amount_due || p.total || '?') + ' cents) — not minting a second payable invoice');
      err.code = 'prior_invoice_partly_paid';
      err.httpStatus = 409;
      err.publicMessage = 'This invoice already has a partly paid Stripe invoice (' + (p.number || prior) + '). '
        + 'Record or refund that payment in Stripe before sending a new pay link, so the homeowner is never asked to pay twice.';
      throw err;
    }
    if (p.status === 'open') await stripe.invoices.voidInvoice(prior);
    else if (p.status === 'draft') await stripe.invoices.del(prior);
  }

  // 3. Create (draft), link it on the CRM invoice, add the lines, finalize.
  const metadata = {
    invoiceId: String(invoiceId), leadId: String(invoice.leadId || ''), companyId: String(tenantId),
    userId: String(uid), source: 'crm', chargedCents: String(balanceDueCents),
  };
  // The tenant's Zelle pair (platform tenant: NBD's defaults unless Jo set
  // his own on the profile). Best-effort read — the defaults are right.
  let zelleText = ZC.zelleContactOf(null, String(tenantId || '')).text;
  try {
    const cp = await db.collection('companyProfile').doc(String(tenantId)).get();
    if (cp && cp.exists) zelleText = ZC.zelleContactOf((cp.data() || {}).brand || null, String(tenantId || '')).text;
  } catch (_) { /* defaults above (NBD's only for the NBD companyId) */ }
  // Card + Link + bank (ACH), stepping down to the account's defaults if
  // ACH is not switched on in the Stripe dashboard yet (ach-payments.js).
  const { result: draft } = await ACH.createWithAch((p, o) => stripe.invoices.create(p, o), {
    customer: customerId,
    collection_method: 'send_invoice',
    // 7 days (Jo's live-CRM handoff, 2026-09-30); was 14. ONE value for
    // every invoice since 2026-10-03 — deposit-rule.js INVOICE_DUE_DAYS, which
    // the CRM invoice doc, its "Net N" terms and the NBD-500 PDF all read.
    days_until_due: require('./deposit-rule').INVOICE_DUE_DAYS,
    auto_advance: false,
    pending_invoice_items_behavior: 'exclude',
    metadata,
    custom_fields: [{ name: 'NBD Invoice', value: String(invoice.invoiceNumber || invoiceId).slice(0, 30) }],
    description: invoice.customerName ? ('Invoice for ' + String(invoice.customerName).slice(0, 200)) : undefined,
    footer: footerFor(zelleText, false),
  }, (p, types) => {
    ACH.applyToInvoice(p, types);
    p.footer = footerFor(zelleText, ACH.offersAch(types));
    return p;
  }, { idempotencyKey: 'nbd-crm-inv-' + invoiceId + '-' + balanceDueCents + '-' + (prior || 'none') });
  await invRef.update({ stripeInvoiceId: draft.id, stripeInvoiceKind: 'invoice', updatedAt: new Date() });

  for (const [i, it] of invoiceItemsFrom(lineItems).entries()) {
    await stripe.invoiceItems.create({ customer: customerId, invoice: draft.id, currency: 'usd', amount: it.amount, description: it.description },
      { idempotencyKey: 'nbd-crm-ii-' + draft.id + '-' + i });
  }
  const fin = await stripe.invoices.finalizeInvoice(draft.id, { auto_advance: false });
  if (fin.amount_due !== balanceDueCents) {
    // The lines did not add up to what the CRM says is owed — never leave a
    // wrong bill payable.
    try { await stripe.invoices.voidInvoice(fin.id); } catch (_) { /* reported below */ }
    throw new Error('Stripe invoice total ' + fin.amount_due + ' ≠ balance ' + balanceDueCents + ' — voided');
  }
  const finPatch = { stripeHostedUrl: fin.hosted_invoice_url || null, stripePdfUrl: fin.invoice_pdf || null, stripeInvoiceNumber: fin.number || null, updatedAt: new Date() };
  // The CRM invoice shows the SAME due date as the Stripe invoice the
  // homeowner opens (both are INVOICE_DUE_DAYS, but counted from different
  // days — the CRM doc's creation vs this mint).
  if (Number(fin.due_date) > 0) finPatch.dueDate = new Date(Number(fin.due_date) * 1000);
  await invRef.update(finPatch);
  return { url: fin.hosted_invoice_url, id: fin.id, pdf: fin.invoice_pdf, reused: false };
}

module.exports = { invoiceItemsFrom, mintCrmStripeInvoice, FOOTER, footerFor };
