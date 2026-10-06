/**
 * functions/stripe-ledger-logic.js — the pure half of the Stripe ledger.
 *
 * Jo (2026-09-29): "full throttle auto integration — literally every
 * transaction from Stripe makes its way back to the CRM, recorded, linked to
 * the customers in the CRM under their names."
 *
 * What was true before this (verified against the live account, read-only):
 * Jo gets paid through Stripe Invoices built by hand in the Stripe dashboard. The
 * CRM's invoiceWebhook received every one of those payments (200s in the
 * logs) and credited none of them — it only understood payments minted by the
 * CRM's own payment links, which carry metadata.invoiceId. So a month of
 * collected money never reached CRM revenue.
 *
 * This module decides, with no I/O:
 *   - which CRM customer (lead) a Stripe customer is      → matchLead()
 *   - which of that customer's CRM invoices a payment pays → pickInvoice()
 *   - the ledger row for a charge / refund / dispute / payout / paid-outside
 *     invoice                                              → *Entry()
 *   - the CRM invoice to create when Stripe billed a customer the CRM has no
 *     invoice for                                           → mirrorInvoice()
 *   - the credit to apply to a CRM invoice, idempotently   → planCredit()
 * functions/stripe-ledger.js does the reading and writing.
 *
 * Money is integer cents everywhere here. CRM invoice `payments[]` entries
 * keep their historical dollar amounts; the conversion happens once, in
 * planCredit.
 */
'use strict';

// ── normalizers ──────────────────────────────────────────────────────────
const normEmail = (e) => String(e || '').trim().toLowerCase();

function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length < 10) return '';
  return d.slice(-10);
}

const STREET_WORDS = {
  street: 'st', avenue: 'ave', av: 'ave', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct',
  boulevard: 'blvd', place: 'pl', circle: 'cir', terrace: 'ter', parkway: 'pkwy', highway: 'hwy',
  north: 'n', south: 's', east: 'e', west: 'w', trail: 'trl', way: 'way', pike: 'pike',
};

/**
 * "5760 Bellwether Dr, Cincinnati OH 45040" → "5760 bellwether". House number + the
 * first street word: survives "Dr" vs "Drive", a missing city, a unit suffix.
 * '' when there is no leading house number (a PO box, a bare city).
 */
function addressKey(addr) {
  const line = String(addr || '').split(',')[0].toLowerCase().replace(/[.#]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(\d+[a-z]?)\s+(.+)$/.exec(line);
  if (!m) return '';
  const words = m[2].split(' ').filter(Boolean).map((w) => STREET_WORDS[w] || w);
  // Skip a leading directional ("W Wolfram") — the name word is what differs.
  const first = ['n', 's', 'e', 'w'].includes(words[0]) && words[1] ? words[1] : words[0];
  return first ? m[1] + ' ' + first : '';
}

const nameTokens = (s) => String(s || '').toLowerCase().replace(/[^a-z\s&-]/g, ' ').split(/[\s&-]+/).filter((t) => t.length > 1);

function leadName(l) {
  const n = ((l.firstName || '') + ' ' + (l.lastName || '')).trim();
  return n || l.name || '';
}

// ── matching a Stripe customer to a CRM lead ─────────────────────────────
/**
 * Index the tenant's live leads once per run.
 */
function buildLeadIndex(leads) {
  const idx = { byId: new Map(), email: new Map(), phone: new Map(), addr: new Map(), stripe: new Map(), last: new Map() };
  const add = (map, key, id) => { if (!key) return; if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); };
  for (const l of leads || []) {
    if (!l || !l.id || l.deleted === true) continue;
    idx.byId.set(l.id, l);
    add(idx.email, normEmail(l.email), l.id);
    add(idx.phone, normPhone(l.phone || l.phoneDigits), l.id);
    add(idx.addr, addressKey(l.address), l.id);
    if (l.stripeCustomerId) add(idx.stripe, String(l.stripeCustomerId), l.id);
    const toks = nameTokens(l.lastName || leadName(l).split(' ').slice(-1)[0]);
    if (toks[0]) add(idx.last, toks[toks.length - 1], l.id);
  }
  return idx;
}

/**
 * party: { stripeCustomerId, leadIdHint, name, email, phone, address }
 * Returns { leadId, method, confidence: 'high'|'suggest'|'none', candidates[] }.
 *
 * Strong keys (exact, unique) → 'high' and the money is booked automatically:
 *   an explicit lead id (metadata / a manual assignment), a Stripe customer id
 *   already linked to a lead, email, phone, house-number+street.
 * Name alone never books money: 'suggest' puts it in the review list with the
 * guess pre-selected. Two leads sharing a strong key (a couple with one phone
 * on two cards) narrows by the next key; still two → review.
 */
function matchLead(party, idx) {
  const p = party || {};
  const none = { leadId: null, method: null, confidence: 'none', candidates: [] };
  if (p.leadIdHint && idx.byId.has(p.leadIdHint)) return { leadId: p.leadIdHint, method: 'metadata', confidence: 'high', candidates: [p.leadIdHint] };

  const tiers = [
    ['stripe_customer', p.stripeCustomerId ? idx.stripe.get(String(p.stripeCustomerId)) : null],
    ['email', idx.email.get(normEmail(p.email))],
    ['phone', idx.phone.get(normPhone(p.phone))],
    ['address', idx.addr.get(addressKey(p.address))],
  ];
  let pool = null;        // candidates narrowed so far
  let method = null;
  for (const [m, set] of tiers) {
    if (!set || !set.size) continue;
    const ids = [...set];
    const narrowed = pool ? ids.filter((id) => pool.includes(id)) : ids;
    if (!narrowed.length) continue;            // this key disagrees; keep the earlier pool
    pool = narrowed; method = method || m;
    if (pool.length === 1) return { leadId: pool[0], method: m === method ? m : method + '+' + m, confidence: 'high', candidates: pool };
  }
  if (pool && pool.length > 1) {
    // Several leads share every strong key present — a name can break the tie
    // for a SUGGESTION, never for booking.
    const byName = pool.filter((id) => nameAgrees(idx.byId.get(id), p.name));
    return { leadId: byName.length === 1 ? byName[0] : null, method: method + '+ambiguous', confidence: 'suggest', candidates: pool };
  }
  // Name only.
  const toks = nameTokens(p.name);
  if (!toks.length) return none;
  const lastSet = idx.last.get(toks[toks.length - 1]);
  if (!lastSet) return none;
  const cands = [...lastSet].filter((id) => nameAgrees(idx.byId.get(id), p.name));
  if (!cands.length) return none;
  return { leadId: cands.length === 1 ? cands[0] : null, method: 'name', confidence: 'suggest', candidates: cands };
}

// Last names equal and (no first name on one side, or first initials equal).
function nameAgrees(lead, name) {
  if (!lead) return false;
  const a = nameTokens(leadName(lead));
  const b = nameTokens(name);
  if (!a.length || !b.length) return false;
  // "Jane & John Example": any token of the Stripe name may be a first name.
  if (!b.includes(a[a.length - 1])) return false;
  if (a.length === 1 || b.length === 1) return true;
  const firstA = a[0][0];
  return b.slice(0, -1).some((t) => t[0] === firstA);
}

// ── picking the CRM invoice a payment pays ───────────────────────────────
const cents = (dollars) => Math.round((parseFloat(dollars) || 0) * 100);

/**
 * invoices: the lead's CRM invoices. ref: { stripeInvoiceId, chargeId, amountCents }.
 * Returns { invoiceId, why } or { invoiceId: null, why }.
 *   1. already linked to this Stripe invoice / charge
 *   2. an open invoice whose balance equals the payment
 *   3. exactly one open invoice with at least this much owed (a partial)
 * Otherwise null — the caller mirrors the Stripe invoice as a new CRM invoice
 * rather than guess which of several jobs the money was for.
 */
function pickInvoice(invoices, ref) {
  const live = (invoices || []).filter((i) => i && i.id && i.deleted !== true);
  const r = ref || {};
  const linked = live.find((i) => (r.stripeInvoiceId && i.stripeInvoiceId === r.stripeInvoiceId)
    || (r.chargeId && Array.isArray(i.stripeCreditKeys) && i.stripeCreditKeys.includes(r.chargeId)));
  if (linked) return { invoiceId: linked.id, why: 'linked' };
  const open = live.filter((i) => cents(i.balanceDue) > 0 && i.status !== 'void');
  const exact = open.filter((i) => cents(i.balanceDue) === r.amountCents);
  if (exact.length === 1) return { invoiceId: exact[0].id, why: 'balance_equals_payment' };
  const fits = open.filter((i) => cents(i.balanceDue) >= r.amountCents);
  if (open.length === 1 && fits.length === 1) return { invoiceId: fits[0].id, why: 'only_open_invoice' };
  return { invoiceId: null, why: exact.length > 1 ? 'several_equal_balances' : open.length ? 'no_clear_fit' : 'no_open_invoice' };
}

/**
 * Money Jo already recorded by hand. Before the ledger existed, a Stripe
 * payment could only reach the CRM by Jo clicking Mark Paid — so a Stripe
 * payment whose amount matches a manual (non-Stripe-ledger) payment on one of
 * the customer's invoices, within 14 days, IS that payment. Booking it again
 * would count the money twice. Returns { invoiceId } or null.
 */
function findManualDuplicate(invoices, mv) {
  const WINDOW = 14 * 86400000;
  for (const inv of invoices || []) {
    if (!inv || inv.deleted === true) continue;
    for (const p of inv.payments || []) {
      if (!p || p.source === 'stripe_ledger' || p.stripeRef) continue;
      if (cents(p.amount) !== mv.amountCents) continue;
      const at = p.at && typeof p.at.toDate === 'function' ? p.at.toDate().getTime()
        : p.at && typeof p.at.seconds === 'number' ? p.at.seconds * 1000 : new Date(p.at).getTime();
      if (!isFinite(at) || Math.abs(at - mv.atMs) <= WINDOW) return { invoiceId: inv.id };
    }
    // A pre-ledger invoice marked paid with no payments[] at all: same total,
    // paid within the window.
    if ((!inv.payments || !inv.payments.length) && cents(inv.balanceDue) === 0 && cents(inv.total) === mv.amountCents) {
      const pa = inv.paidAt && typeof inv.paidAt.toDate === 'function' ? inv.paidAt.toDate().getTime() : new Date(inv.paidAt).getTime();
      if (!isFinite(pa) || Math.abs(pa - mv.atMs) <= WINDOW) return { invoiceId: inv.id };
    }
  }
  return null;
}

/**
 * The credit to apply to a CRM invoice for one Stripe money movement.
 * key: a stable id for THIS movement ('ch_…', 'in_…:oob') — recorded in
 * stripeCreditKeys so a webhook retry, the nightly reconcile and a backfill
 * can all run over the same payment without crediting it twice. Also refuses
 * a payment intent the CRM's own payment-link path already credited
 * (paidIntentIds, stripe.js invoiceWebhook).
 * Returns null (nothing to do) or { payment, amountPaid, balanceDue, status,
 * paid, depositPaid, keys }.
 */
function planCredit(inv, mv) {
  if (!inv || !mv || !mv.key || !(mv.amountCents > 0)) return null;
  const keys = Array.isArray(inv.stripeCreditKeys) ? inv.stripeCreditKeys : [];
  if (keys.includes(mv.key)) return null;
  if (mv.paymentIntentId && Array.isArray(inv.paidIntentIds) && inv.paidIntentIds.includes(mv.paymentIntentId)) return null;
  const totalC = cents(inv.total);
  const paidC = cents(inv.amountPaid);
  const newPaidC = paidC + mv.amountCents;
  const balC = Math.max(0, totalC - newPaidC);
  const payment = { amount: mv.amountCents / 100, at: new Date(mv.atMs), method: mv.method || 'stripe', source: 'stripe_ledger', stripeRef: mv.key };
  if (mv.paymentIntentId) payment.paymentIntentId = mv.paymentIntentId;
  if (mv.reference) payment.reference = mv.reference;
  const depC = cents(inv.depositAmount);
  return {
    payment,
    amountPaid: newPaidC / 100,
    balanceDue: balC / 100,
    paid: balC === 0,
    status: balC === 0 ? 'paid' : 'partial',
    depositPaid: !!inv.depositPaid || (depC > 0 && newPaidC >= depC),
    keys: keys.concat(mv.key),
    overpaidCents: Math.max(0, newPaidC - totalC),
  };
}

// ── ledger rows ──────────────────────────────────────────────────────────
function methodOfCharge(ch) {
  const d = (ch && ch.payment_method_details) || {};
  if (d.type === 'card') {
    const w = d.card && d.card.wallet && d.card.wallet.type;
    return w ? w : 'card';                       // 'apple_pay', 'google_pay', 'card'
  }
  return d.type || 'stripe';                      // 'link', 'us_bank_account', 'cashapp', …
}

function partyFromCustomer(cust, fallback) {
  const c = cust && typeof cust === 'object' ? cust : {};
  const f = fallback || {};
  const addr = c.address || f.address || {};
  return {
    stripeCustomerId: c.id || (typeof cust === 'string' ? cust : null) || f.stripeCustomerId || null,
    leadIdHint: (c.metadata && (c.metadata.nbd_lead_id || c.metadata.leadId)) || f.leadIdHint || null,
    name: c.name || f.name || '',
    email: c.email || f.email || '',
    phone: c.phone || f.phone || '',
    address: typeof addr === 'string' ? addr : [addr.line1, addr.city, addr.state, addr.postal_code].filter(Boolean).join(', '),
  };
}

/** The NBD invoice number Jo writes into Stripe invoices, wherever it was put. */
function nbdNumberOf(inv) {
  const re = /NBD-\d{4}-\d{4}-[A-Z0-9-]+/;
  const pools = [];
  if (inv) {
    (inv.custom_fields || []).forEach((f) => pools.push(f && f.value));
    Object.values(inv.metadata || {}).forEach((v) => pools.push(v));
    pools.push(inv.number, inv.description);
  }
  for (const v of pools) { const m = re.exec(String(v || '')); if (m) return m[0]; }
  return null;
}

const baseRow = (companyId) => ({ companyId, userId: companyId });

/**
 * A charge (money in). ch is a 2023-10-16-shape Charge, ideally with
 * balance_transaction and customer expanded.
 */
function chargeEntry(ch, companyId, extra) {
  const bt = ch.balance_transaction && typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;
  const pmd = ch.payment_method_details || {};
  const card = pmd.card || {};
  const party = partyFromCustomer(ch.customer, {
    name: ch.billing_details && ch.billing_details.name,
    email: (ch.billing_details && ch.billing_details.email) || ch.receipt_email,
    phone: ch.billing_details && ch.billing_details.phone,
    address: ch.billing_details && ch.billing_details.address,
  });
  const pi = ch.payment_intent && typeof ch.payment_intent === 'object' ? ch.payment_intent : null;
  return Object.assign(baseRow(companyId), {
    kind: 'charge',
    status: ch.status,                                  // succeeded | failed | pending
    amountCents: ch.status === 'succeeded' ? (ch.amount_captured || ch.amount || 0) : 0,
    attemptedCents: ch.amount || 0,
    refundedCents: ch.amount_refunded || 0,
    feeCents: bt ? bt.fee : null,
    netCents: bt ? bt.net : null,
    atMs: (ch.created || 0) * 1000,
    method: methodOfCharge(ch),
    last4: card.last4 || null,
    brand: card.brand || null,
    failure: ch.failure_message || null,
    description: ch.description || null,
    receiptUrl: ch.receipt_url || null,
    paymentIntentId: pi ? pi.id : (ch.payment_intent || null),
    crmInvoiceIdHint: (pi && pi.metadata && pi.metadata.invoiceId) || (ch.metadata && ch.metadata.invoiceId) || null,
    stripeInvoiceId: (ch.invoice && (ch.invoice.id || ch.invoice)) || null,
    party,
  }, extra || {});
}

function refundEntry(re, companyId, charge) {
  return Object.assign(baseRow(companyId), {
    kind: 'refund',
    status: re.status,
    amountCents: -(re.amount || 0),
    atMs: (re.created || 0) * 1000,
    chargeId: (re.charge && (re.charge.id || re.charge)) || null,
    reason: re.reason || null,
    party: charge ? chargeEntry(charge, companyId).party : null,
  });
}

function disputeEntry(dp, companyId, charge) {
  return Object.assign(baseRow(companyId), {
    kind: 'dispute',
    status: dp.status,
    amountCents: -(dp.amount || 0),
    atMs: (dp.created || 0) * 1000,
    chargeId: (dp.charge && (dp.charge.id || dp.charge)) || null,
    reason: dp.reason || null,
    party: charge ? chargeEntry(charge, companyId).party : null,
  });
}

function payoutEntry(po, companyId) {
  return Object.assign(baseRow(companyId), {
    kind: 'payout',
    status: po.status,
    amountCents: po.amount || 0,
    atMs: (po.arrival_date || po.created || 0) * 1000,
    method: po.method || null,
    description: po.description || null,
    // A payout is money moving from Stripe to the bank — not revenue, never
    // matched to a customer.
    party: null,
  });
}

/**
 * A Stripe invoice marked paid WITHOUT a Stripe charge (Jo took Zelle or a
 * check and clicked "Mark as paid" in Stripe). That is collected money and the
 * CRM must know — but it moved outside Stripe.
 */
function outOfBandEntry(inv, companyId) {
  return Object.assign(baseRow(companyId), {
    kind: 'invoice_paid_outside_stripe',
    status: 'succeeded',
    amountCents: oobAmountCents(inv),
    atMs: ((inv.status_transitions && inv.status_transitions.paid_at) || inv.created || 0) * 1000,
    method: 'marked_paid_in_stripe',
    stripeInvoiceId: inv.id,
    party: partyFromCustomer(inv.customer, {
      name: inv.customer_name, email: inv.customer_email, phone: inv.customer_phone, address: inv.customer_address,
    }),
  });
}

// At the pinned API version (2023-10-16) an invoice marked paid outside
// Stripe reports amount_paid: 0 — the total is what was paid. Verified
// against the live account 2026-09-29 (the first preview skipped both of
// Jo's Zelle/check invoices because of it).
function oobAmountCents(inv) { return inv && inv.amount_paid > 0 ? inv.amount_paid : ((inv && inv.total) || 0); }

function isPaidOutOfBand(inv) {
  if (!inv || inv.status !== 'paid') return false;
  if (inv.paid_out_of_band === true) return oobAmountCents(inv) > 0;
  // Older objects: paid, money recorded, but no charge and no payment intent.
  return !inv.charge && !inv.payment_intent && inv.amount_paid > 0;
}

/**
 * The job + estimate a mirror belongs to, when the customer leaves no doubt
 * (2026-10-05). A mirror used to carry neither, so the final invoice at
 * install (nbd:job-billing jobInvoicesOf) skipped a deposit paid through the
 * Stripe dashboard and billed the whole job again: $4,620 paid, $9,240
 * billed. Stamped only when ALL hold:
 *   - leads/{id}/jobs (not deleted) is exactly ONE job, and it is the
 *     lead's activeJobId (when the lead names one);
 *   - the lead has a primary estimate, it exists and is not deleted;
 *   - the Stripe object was made on or after that estimate — a payment for
 *     an earlier roof (a backlog sync) is never stamped onto this job.
 * Anything else → {} (the mirror stays un-stamped, as before).
 * → { jobId, estimateId } | {}
 */
function mirrorJobStamp(lead, jobs, est, srcCreatedMs) {
  const l = lead || {};
  const okId = (v, n) => (typeof v === 'string' && v.length <= n && /^[A-Za-z0-9_-]+$/.test(v)) ? v : null;
  const live = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.deleted !== true);
  if (live.length !== 1) return {};
  const jobId = okId(live[0].id, 40);
  if (!jobId) return {};
  if (l.activeJobId && l.activeJobId !== jobId) return {};
  const estimateId = okId(l.primaryEstimateId, 128);
  if (!estimateId || !est || est.deleted === true) return {};
  const c = est.createdAt;
  const estMs = !c ? 0 : (typeof c.toMillis === 'function' ? c.toMillis()
    : (c instanceof Date ? c.getTime() : (typeof c === 'number' ? c : (Date.parse(c) || 0))));
  if (!(estMs > 0) || !(Number(srcCreatedMs) >= estMs)) return {};
  return { jobId, estimateId };
}

/**
 * A CRM invoice mirroring a Stripe invoice (or a bare charge), for a customer
 * the CRM had no matching invoice for. Everything a CRM screen needs to show
 * it, and the Stripe links to open the original. `payments` starts empty —
 * planCredit adds the money in the same transaction. `stamp` = mirrorJobStamp's.
 */
function mirrorInvoice(src, lead, companyId, nowMs, stamp) {
  const isInv = src && src.object === 'invoice';
  const lines = isInv ? ((src.lines && src.lines.data) || []) : [];
  const items = lines.length
    // The CRM invoice line shape (invoice-pipeline.js): unitPrice + total.
    ? lines.map((l) => ({ description: l.description || 'Item', quantity: l.quantity || 1, unitPrice: Math.round((l.amount || 0) / (l.quantity || 1)) / 100, total: (l.amount || 0) / 100 }))
    : [{ description: (src && src.description) || 'Stripe payment', quantity: 1, unitPrice: ((src && (src.amount_captured || src.amount)) || 0) / 100, total: ((src && (src.amount_captured || src.amount)) || 0) / 100 }];
  const totalC = isInv ? (src.total || 0) : ((src && (src.amount_captured || src.amount)) || 0);
  const createdMs = ((src && src.created) || Math.floor(nowMs / 1000)) * 1000;
  const out = {
    leadId: lead.id,
    customerId: lead.customerId || null,
    customerName: leadName(lead) || (isInv ? src.customer_name : '') || '',
    customerEmail: lead.email || (isInv ? src.customer_email : '') || '',
    customerPhone: lead.phone || (isInv ? src.customer_phone : '') || '',
    status: 'sent',
    items,
    subtotal: (isInv ? (src.subtotal || totalC) : totalC) / 100,
    tax: 0,
    taxRate: 0,
    total: totalC / 100,
    depositAmount: 0,
    depositPaid: false,
    amountPaid: 0,
    balanceDue: totalC / 100,
    payments: [],
    stripeCreditKeys: [],
    // A real Stripe Invoice id (in_…) — unlike the payment-link path, which
    // historically stored a plink_ id in this same field.
    stripeInvoiceId: isInv ? src.id : null,
    stripeInvoiceNumber: isInv ? (src.number || null) : null,
    stripeHostedUrl: isInv ? (src.hosted_invoice_url || null) : null,
    stripePdfUrl: isInv ? (src.invoice_pdf || null) : null,
    nbdInvoiceNumber: isInv ? nbdNumberOf(src) : null,
    source: 'stripe',
    sentAt: new Date(createdMs),
    dueDate: isInv && src.due_date ? new Date(src.due_date * 1000) : null,
    createdAt: new Date(createdMs),
    updatedAt: new Date(nowMs),
    createdBy: companyId,
    companyId,
    notes: 'Created from Stripe' + (isInv && src.number ? ' invoice ' + src.number : ' payment') + ' — the customer was billed in Stripe.',
  };
  // The job it belongs to, when mirrorJobStamp could tell (else none, as before).
  if (stamp && stamp.jobId) out.jobId = stamp.jobId;
  if (stamp && stamp.estimateId) out.estimateId = stamp.estimateId;
  return out;
}

module.exports = {
  normEmail, normPhone, addressKey, nameTokens, leadName,
  buildLeadIndex, matchLead, nameAgrees,
  cents, pickInvoice, findManualDuplicate, planCredit,
  methodOfCharge, partyFromCustomer, nbdNumberOf,
  chargeEntry, refundEntry, disputeEntry, payoutEntry, outOfBandEntry, isPaidOutOfBand, oobAmountCents, mirrorInvoice, mirrorJobStamp,
};
