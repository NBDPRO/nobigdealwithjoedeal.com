/**
 * functions/stripe-ledger.js — every Stripe money movement, recorded in the
 * CRM under the customer it belongs to.
 *
 * Jo (2026-09-29): "full throttle auto integration — literally every
 * transaction from Stripe makes its way back to the CRM, recorded, linked to
 * the customers in the CRM under their names."
 *
 * Scope: the PLATFORM tenant's own Stripe account (Jo's). Other tenants take
 * money through Connect destination charges minted by the CRM itself, which
 * the existing payment-link path in stripe.js already credits.
 *
 * Three ways in, one code path (ingest*), all idempotent:
 *   - invoiceWebhook (stripe.js) calls onEvent() for every event it receives
 *   - stripeLedgerSync   (callable, owner-only) — the backlog, with dryRun
 *   - stripeLedgerReconcile (daily) — the last 4 days again, so a missed or
 *     failed webhook delivery can never lose a payment
 * Objects are always RE-FETCHED at the pinned API version (2023-10-16), so a
 * webhook payload (the endpoint's newer version) and a list call produce the
 * same row.
 *
 * Writes:
 *   stripeLedger/{stripeObjectId}  one row per charge / refund / dispute /
 *                                  payout / invoice-paid-outside-Stripe
 *   invoices/{id}                  a credit (payments[] + totals), or a new
 *                                  CRM invoice mirroring a Stripe invoice the
 *                                  CRM had no match for (source:'stripe')
 *   leads/{id}.stripeCustomerId    remembered once a customer is matched
 * Money is only ever booked on a HIGH-confidence match (an explicit id, a
 * linked Stripe customer, email, phone, or house number + street). Anything
 * less lands in the ledger with needsReview:true and waits for Jo to assign
 * it (assignStripeTransaction). Nothing here writes to Stripe.
 *
 * The rules themselves are in stripe-ledger-logic.js (pure, unit-tested).
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const L = require('./stripe-ledger-logic');

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const API_VERSION = '2023-10-16';
const COL = 'stripeLedger';
const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app', 'https://nobigdeal-pro.firebaseapp.com'];

let _stripe = null;
function stripeClient() {
  if (_stripe) return _stripe;
  const key = String(STRIPE_SECRET_KEY.value() || '').trim();
  if (!key || key === '__unset__') throw new Error('STRIPE_SECRET_KEY not configured');
  const Stripe = require('stripe');
  _stripe = new Stripe(key, { apiVersion: API_VERSION, maxNetworkRetries: 2, timeout: 20000 });
  return _stripe;
}

const CHARGE_EXPAND = ['balance_transaction', 'customer', 'payment_intent', 'invoice'];

// ── context: the tenant's leads + invoices, loaded once per run ──────────
async function loadContext(db) {
  const [byCo, byUser, invSnap] = await Promise.all([
    db.collection('leads').where('companyId', '==', OWNER).get(),
    db.collection('leads').where('userId', '==', OWNER).get(),
    db.collection('invoices').where('companyId', '==', OWNER).get(),
  ]);
  const leads = new Map();
  [byCo, byUser].forEach((s) => s.forEach((d) => leads.set(d.id, Object.assign({ id: d.id }, d.data()))));
  const invoicesByLead = new Map();
  invSnap.forEach((d) => {
    const inv = Object.assign({ id: d.id }, d.data());
    if (!inv.leadId) return;
    if (!invoicesByLead.has(inv.leadId)) invoicesByLead.set(inv.leadId, []);
    invoicesByLead.get(inv.leadId).push(inv);
  });
  return { db, leads, idx: L.buildLeadIndex([...leads.values()]), invoicesByLead, invoicesById: new Map(invSnap.docs.map((d) => [d.id, Object.assign({ id: d.id }, d.data())])) };
}

// ── the booking step ─────────────────────────────────────────────────────
/**
 * Credit one movement to the lead's CRM invoice — the one it links to, or the
 * one pickInvoice finds, or a new mirror of the Stripe invoice/charge. Runs in
 * a transaction; planCredit's stripeCreditKeys make it idempotent.
 * Returns { invoiceId, created, credited, why } (dryRun: the same, unwritten).
 */
async function book(ctx, { leadId, mv, stripeInvoice, sourceObject, dryRun }) {
  const lead = ctx.leads.get(leadId);
  if (!lead) return { invoiceId: null, credited: false, why: 'lead_missing' };
  const invs = ctx.invoicesByLead.get(leadId) || [];
  const pick = L.pickInvoice(invs, { stripeInvoiceId: stripeInvoice && stripeInvoice.id, chargeId: mv.key, amountCents: mv.amountCents });
  let invoiceId = pick.invoiceId;
  let created = false;
  // Already recorded by hand (Mark Paid) → link it, never count it twice.
  const dup = pick.why !== 'linked' ? L.findManualDuplicate(invs, mv) : null;
  if (dup) {
    if (!dryRun) {
      const ref = ctx.db.collection('invoices').doc(dup.invoiceId);
      await ctx.db.runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) return;
        const keys = Array.isArray(s.data().stripeCreditKeys) ? s.data().stripeCreditKeys : [];
        if (!keys.includes(mv.key)) tx.update(ref, { stripeCreditKeys: keys.concat(mv.key), updatedAt: FieldValue.serverTimestamp() });
      });
    }
    return { invoiceId: dup.invoiceId, created: false, credited: false, why: 'already_recorded_by_hand' };
  }
  if (dryRun) {
    const target = invoiceId ? invs.find((i) => i.id === invoiceId) : null;
    const plan = target ? L.planCredit(target, mv) : { status: 'new' };
    return { invoiceId, created: !invoiceId, credited: !!plan, why: invoiceId ? pick.why : 'mirror_' + pick.why };
  }
  const db = ctx.db;
  const result = await db.runTransaction(async (tx) => {
    let ref, inv;
    if (invoiceId) {
      ref = db.collection('invoices').doc(invoiceId);
      const snap = await tx.get(ref);
      if (!snap.exists) return { credited: false, why: 'invoice_vanished' };
      inv = snap.data();
    } else {
      ref = db.collection('invoices').doc();
      inv = L.mirrorInvoice(stripeInvoice || sourceObject, lead, OWNER, Date.now());
      tx.set(ref, inv);
      created = true;
    }
    const plan = L.planCredit(inv, mv);
    if (!plan) return { credited: false, why: 'already_recorded' };
    const patch = {
      payments: (Array.isArray(inv.payments) ? inv.payments : []).concat(plan.payment),
      amountPaid: plan.amountPaid,
      balanceDue: plan.balanceDue,
      depositPaid: plan.depositPaid,
      stripeCreditKeys: plan.keys,
      lastPaymentAt: plan.payment.at,
      status: plan.status,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (plan.paid) patch.paidAt = plan.payment.at;
    if (created) tx.set(ref, Object.assign({}, inv, patch));
    else tx.update(ref, patch);
    return { credited: true, invoiceRef: ref, overpaidCents: plan.overpaidCents };
  });
  if (result.invoiceRef) invoiceId = result.invoiceRef.id;
  if (created) {
    // Keep the in-memory context current so a second payment on the same
    // Stripe invoice (a deposit, then the balance) lands on the same mirror.
    const fresh = (await db.collection('invoices').doc(invoiceId).get()).data();
    const row = Object.assign({ id: invoiceId }, fresh);
    ctx.invoicesByLead.set(leadId, invs.concat(row));
    ctx.invoicesById.set(invoiceId, row);
  }
  return { invoiceId, created, credited: !!result.credited, why: result.why || (created ? 'mirrored' : pick.why), overpaidCents: result.overpaidCents || 0 };
}

async function rememberCustomer(ctx, leadId, stripeCustomerId, dryRun) {
  if (dryRun || !leadId || !stripeCustomerId) return;
  const lead = ctx.leads.get(leadId);
  if (!lead || lead.stripeCustomerId === stripeCustomerId) return;
  if (lead.stripeCustomerId) return; // never overwrite a link Jo made
  await ctx.db.collection('leads').doc(leadId).update({ stripeCustomerId });
  lead.stripeCustomerId = stripeCustomerId;
  ctx.idx = L.buildLeadIndex([...ctx.leads.values()]);
}

/**
 * Write (merge) the ledger row. A manual assignment on an existing row is
 * never overwritten by an automatic pass.
 */
async function writeRow(ctx, id, row, dryRun) {
  if (dryRun) return;
  const ref = ctx.db.collection(COL).doc(id);
  const prev = await ref.get();
  const keepManual = prev.exists && prev.data().match && prev.data().match.method === 'manual';
  const out = Object.assign({}, row, { updatedAt: FieldValue.serverTimestamp() });
  if (keepManual) { delete out.match; delete out.needsReview; }
  if (!prev.exists) out.createdAt = FieldValue.serverTimestamp();
  await ref.set(out, { merge: true });
}

function summarize(row, match, booked) {
  const lead = match.leadId ? match._lead : null;
  return {
    id: row._id, kind: row.kind, status: row.status, amount: (row.amountCents || 0) / 100,
    date: row.atMs ? new Date(row.atMs).toISOString().slice(0, 10) : null,
    customer: (row.party && row.party.name) || (row.party && row.party.email) || null,
    match: match.leadId ? { leadId: match.leadId, name: lead ? L.leadName(lead) : null, method: match.method, confidence: match.confidence } : { confidence: match.confidence, candidates: match.candidates || [] },
    action: booked ? (booked.credited ? (booked.created ? 'created CRM invoice + recorded payment' : 'recorded on CRM invoice') : booked.why) : (match.confidence === 'high' ? 'ledger only' : 'needs review'),
    invoiceId: booked ? booked.invoiceId : null,
  };
}

// ── ingest: one Stripe object each ───────────────────────────────────────
async function ingestCharge(ctx, chargeOrId, opts) {
  const o = opts || {};
  const stripe = stripeClient();
  const ch = typeof chargeOrId === 'object' && chargeOrId.balance_transaction !== undefined && typeof chargeOrId.customer === 'object'
    ? chargeOrId
    : await stripe.charges.retrieve(typeof chargeOrId === 'string' ? chargeOrId : chargeOrId.id, { expand: CHARGE_EXPAND });
  const row = L.chargeEntry(ch, OWNER);
  row._id = ch.id;
  const sInv = ch.invoice && typeof ch.invoice === 'object' ? ch.invoice : null;
  // NBD Pro subscription billing (a contractor paying for the CRM) runs
  // through this same account. It is platform revenue, not a homeowner job:
  // record it, never match it to a customer, never put it in the review list.
  if (sInv && (sInv.subscription || (sInv.billing_reason && sInv.billing_reason !== 'manual'))) {
    const sub = Object.assign({}, row, { kind: 'platform_subscription', match: { leadId: null, invoiceId: null, method: null, confidence: 'none', candidates: [], leadName: null }, needsReview: false });
    delete sub._id;
    await writeRow(ctx, ch.id, sub, o.dryRun);
    return { id: ch.id, kind: 'platform_subscription', status: row.status, amount: row.amountCents / 100, action: 'NBD Pro subscription — not a customer job' };
  }
  if (sInv) {
    row.stripeInvoiceNumber = sInv.number || null;
    row.nbdInvoiceNumber = L.nbdNumberOf(sInv);
    row.stripeHostedUrl = sInv.hosted_invoice_url || null;
    // A Stripe invoice the CRM made (stripe-crm-invoice.js) names its lead.
    if (sInv.metadata && sInv.metadata.leadId && !row.party.leadIdHint) row.party.leadIdHint = sInv.metadata.leadId;
    if (!row.party.name && sInv.customer_name) row.party.name = sInv.customer_name;
  }

  // A charge the CRM's own payment link minted: stripe.js already credits it
  // (paidIntentIds). Link it, never credit it twice.
  let match;
  let booked = null;
  const hinted = row.crmInvoiceIdHint && ctx.invoicesById.get(row.crmInvoiceIdHint);
  if (hinted) {
    match = { leadId: hinted.leadId || null, method: 'crm_payment_link', confidence: 'high', candidates: [] };
    booked = { invoiceId: hinted.id, credited: false, why: 'credited_by_payment_link_path' };
  } else {
    match = L.matchLead(row.party, ctx.idx);
    if (match.confidence === 'high' && row.status === 'succeeded' && row.amountCents > 0) {
      booked = await book(ctx, {
        leadId: match.leadId,
        mv: { key: ch.id, amountCents: row.amountCents, atMs: row.atMs, method: row.method, paymentIntentId: row.paymentIntentId,
          reference: row.nbdInvoiceNumber || row.stripeInvoiceNumber || null },
        stripeInvoice: sInv, sourceObject: ch, dryRun: o.dryRun,
      });
    }
    if (match.confidence === 'high') await rememberCustomer(ctx, match.leadId, row.party.stripeCustomerId, o.dryRun);
  }
  match._lead = match.leadId ? ctx.leads.get(match.leadId) : null;
  const store = Object.assign({}, row, {
    match: { leadId: match.leadId || null, invoiceId: booked ? booked.invoiceId || null : null, method: match.method || null,
      confidence: match.confidence, candidates: match.candidates || [], leadName: match._lead ? L.leadName(match._lead) : null },
    // Review: real money we could not confidently place.
    needsReview: row.status === 'succeeded' && row.amountCents > 0 && match.confidence !== 'high',
  });
  delete store._id;
  await writeRow(ctx, ch.id, store, o.dryRun);
  return summarize(row, match, booked);
}

/**
 * A Stripe invoice: paid outside Stripe → book it like a charge; open → show
 * it on the customer as money owed (mirror, unpaid); void → void the mirror.
 * Card-paid invoices are booked through their charge, not here.
 */
async function ingestInvoice(ctx, invOrId, opts) {
  const o = opts || {};
  const stripe = stripeClient();
  const inv = typeof invOrId === 'object' && invOrId.lines && invOrId.lines.data ? invOrId
    : await stripe.invoices.retrieve(typeof invOrId === 'string' ? invOrId : invOrId.id, { expand: ['customer'] });
  if (inv.billing_reason && inv.billing_reason !== 'manual') return null;   // subscription billing — not customer work
  const party = L.partyFromCustomer(inv.customer, { name: inv.customer_name, email: inv.customer_email, phone: inv.customer_phone, address: inv.customer_address });
  if (inv.metadata && inv.metadata.leadId && !party.leadIdHint) party.leadIdHint = inv.metadata.leadId;
  // Made BY the CRM from one of its own invoices (stripe-crm-invoice.js):
  // that CRM invoice already exists and carries this in_ id — never mirror.
  const crmMade = !!(inv.metadata && inv.metadata.source === 'crm' && inv.metadata.invoiceId);
  const match = L.matchLead(party, ctx.idx);
  match._lead = match.leadId ? ctx.leads.get(match.leadId) : null;

  if (L.isPaidOutOfBand(inv)) {
    const row = L.outOfBandEntry(inv, OWNER);
    row._id = inv.id;
    row.nbdInvoiceNumber = L.nbdNumberOf(inv);
    row.stripeInvoiceNumber = inv.number || null;
    row.stripeHostedUrl = inv.hosted_invoice_url || null;
    let booked = null;
    if (match.confidence === 'high') {
      booked = await book(ctx, { leadId: match.leadId,
        mv: { key: inv.id + ':oob', amountCents: row.amountCents, atMs: row.atMs, method: 'marked_paid_in_stripe', reference: row.nbdInvoiceNumber || inv.number || null },
        stripeInvoice: inv, dryRun: o.dryRun });
      await rememberCustomer(ctx, match.leadId, party.stripeCustomerId, o.dryRun);
    }
    const store = Object.assign({}, row, { match: { leadId: match.leadId || null, invoiceId: booked ? booked.invoiceId : null, method: match.method || null,
      confidence: match.confidence, candidates: match.candidates || [], leadName: match._lead ? L.leadName(match._lead) : null },
      needsReview: match.confidence !== 'high' });
    delete store._id;
    await writeRow(ctx, inv.id, store, o.dryRun);
    return summarize(row, match, booked);
  }

  // Open (sent, unpaid): owed money the CRM should show under the customer.
  if ((inv.status === 'open') && !crmMade && match.confidence === 'high' && !o.dryRun) {
    const invs = ctx.invoicesByLead.get(match.leadId) || [];
    if (!invs.some((i) => i.stripeInvoiceId === inv.id)) {
      const ref = ctx.db.collection('invoices').doc();
      const mirror = L.mirrorInvoice(inv, match._lead, OWNER, Date.now());
      await ref.set(mirror);
      ctx.invoicesByLead.set(match.leadId, invs.concat(Object.assign({ id: ref.id }, mirror)));
      ctx.invoicesById.set(ref.id, Object.assign({ id: ref.id }, mirror));
      await rememberCustomer(ctx, match.leadId, party.stripeCustomerId, o.dryRun);
    }
  }
  // Voided / uncollectible: the mirror stops counting as owed. Only mirrors
  // (source:'stripe') — a CRM-authored invoice is Jo's to void.
  if ((inv.status === 'void' || inv.status === 'uncollectible') && !o.dryRun) {
    const snap = await ctx.db.collection('invoices').where('companyId', '==', OWNER).where('stripeInvoiceId', '==', inv.id).get();
    for (const d of snap.docs) {
      if (d.data().source === 'stripe' && !(L.cents(d.data().amountPaid) > 0)) {
        await d.ref.update({ status: 'void', balanceDue: 0, updatedAt: FieldValue.serverTimestamp() });
      }
    }
  }
  return null;
}

async function ingestRefund(ctx, re, opts) {
  const o = opts || {};
  const stripe = stripeClient();
  const refund = typeof re === 'string' ? await stripe.refunds.retrieve(re) : re;
  const chargeId = refund.charge && (refund.charge.id || refund.charge);
  const chargeRow = chargeId ? await ctx.db.collection(COL).doc(chargeId).get() : null;
  const row = L.refundEntry(refund, OWNER, null);
  const cm = chargeRow && chargeRow.exists ? (chargeRow.data().match || {}) : {};
  row.party = chargeRow && chargeRow.exists ? chargeRow.data().party || null : null;
  row.match = { leadId: cm.leadId || null, invoiceId: cm.invoiceId || null, method: cm.leadId ? 'from_charge' : null, confidence: cm.leadId ? 'high' : 'none', candidates: [], leadName: cm.leadName || null };
  row.needsReview = false;
  // Recorded on the CRM invoice for the record (refunds[]); the payments
  // ledger that revenue reads is left alone until refunds are modelled in
  // every revenue reader at once — flagged in the project note.
  if (cm.invoiceId && !o.dryRun) {
    const ref = ctx.db.collection('invoices').doc(cm.invoiceId);
    await ctx.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return;
      const cur = s.data();
      const list = Array.isArray(cur.refunds) ? cur.refunds : [];
      if (list.some((x) => x.stripeRef === refund.id)) return;
      tx.update(ref, { refunds: list.concat({ amount: (refund.amount || 0) / 100, at: new Date((refund.created || 0) * 1000), stripeRef: refund.id, status: refund.status }),
        refundedTotal: Math.round((L.cents(cur.refundedTotal) + (refund.amount || 0))) / 100, updatedAt: FieldValue.serverTimestamp() });
    });
  }
  await writeRow(ctx, refund.id, row, o.dryRun);
  return { id: refund.id, kind: 'refund', amount: -(refund.amount || 0) / 100, match: row.match };
}

async function ingestSimple(ctx, id, row, opts) {
  await writeRow(ctx, id, row, (opts || {}).dryRun);
  return { id, kind: row.kind, amount: (row.amountCents || 0) / 100, status: row.status };
}

// ── webhook entry (called from stripe.js invoiceWebhook) ─────────────────
const LEDGER_EVENTS = new Set([
  'payment_intent.succeeded', 'charge.succeeded', 'charge.failed', 'charge.refunded', 'charge.refund.updated',
  'charge.dispute.created', 'charge.dispute.closed', 'invoice.finalized', 'invoice.sent', 'invoice.paid',
  'invoice.voided', 'invoice.marked_uncollectible', 'payout.paid', 'payout.failed',
]);

/**
 * Only events on the platform account itself (Connect events carry
 * event.account and belong to a tenant). Throws on failure so invoiceWebhook's
 * outer catch releases the idempotency marker and Stripe retries — every step
 * here is idempotent.
 */
async function onEvent(db, event) {
  if (!event || !LEDGER_EVENTS.has(event.type) || event.account) return { skipped: true };
  if (process.env.STRIPE_LEDGER_DISABLED === 'true') return { skipped: 'disabled' };
  const obj = (event.data && event.data.object) || {};
  const ctx = await loadContext(db);
  const stripe = stripeClient();
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const chargeId = obj.latest_charge || (obj.charges && obj.charges.data && obj.charges.data[0] && obj.charges.data[0].id);
      return chargeId ? ingestCharge(ctx, chargeId) : { skipped: 'no_charge' };
    }
    case 'charge.succeeded': case 'charge.failed':
      return ingestCharge(ctx, obj.id);
    case 'charge.refunded': case 'charge.refund.updated': {
      const refunds = obj.object === 'refund' ? [obj] : (await stripe.refunds.list({ charge: obj.id, limit: 100 })).data;
      const out = [];
      for (const r of refunds) out.push(await ingestRefund(ctx, r));
      return out;
    }
    case 'charge.dispute.created': case 'charge.dispute.closed': {
      const chargeRow = obj.charge ? await db.collection(COL).doc(String(obj.charge.id || obj.charge)).get() : null;
      const row = L.disputeEntry(obj, OWNER, null);
      const cm = chargeRow && chargeRow.exists ? chargeRow.data().match || {} : {};
      row.party = chargeRow && chargeRow.exists ? chargeRow.data().party || null : null;
      row.match = { leadId: cm.leadId || null, invoiceId: cm.invoiceId || null, method: cm.leadId ? 'from_charge' : null, confidence: cm.leadId ? 'high' : 'none', candidates: [], leadName: cm.leadName || null };
      row.needsReview = true; // a dispute always wants Jo's eyes
      return ingestSimple(ctx, obj.id, row);
    }
    case 'invoice.finalized': case 'invoice.sent': case 'invoice.paid': case 'invoice.voided': case 'invoice.marked_uncollectible':
      return ingestInvoice(ctx, obj.id);
    case 'payout.paid': case 'payout.failed':
      return ingestSimple(ctx, obj.id, L.payoutEntry(obj, OWNER));
    default:
      return { skipped: true };
  }
}

// ── sync: backlog / nightly ──────────────────────────────────────────────
async function sync(db, { sinceSec, dryRun }) {
  const stripe = stripeClient();
  const ctx = await loadContext(db);
  const created = sinceSec ? { gte: sinceSec } : undefined;
  const out = { charges: [], invoices: [], refunds: [], disputes: [], payouts: [] };
  for await (const ch of stripe.charges.list({ limit: 100, created, expand: CHARGE_EXPAND.map((e) => 'data.' + e) })) {
    out.charges.push(await ingestCharge(ctx, ch, { dryRun }));
  }
  for await (const inv of stripe.invoices.list({ limit: 100, created, expand: ['data.customer'] })) {
    const r = await ingestInvoice(ctx, inv, { dryRun });
    if (r) out.invoices.push(r);
  }
  for await (const re of stripe.refunds.list({ limit: 100, created })) out.refunds.push(await ingestRefund(ctx, re, { dryRun }));
  for await (const dp of stripe.disputes.list({ limit: 100, created })) {
    const row = L.disputeEntry(dp, OWNER, null); row.needsReview = true;
    out.disputes.push(await ingestSimple(ctx, dp.id, row, { dryRun }));
  }
  for await (const po of stripe.payouts.list({ limit: 100, created })) out.payouts.push(await ingestSimple(ctx, po.id, L.payoutEntry(po, OWNER), { dryRun }));
  const money = out.charges.filter((c) => c.status === 'succeeded').concat(out.invoices);
  out.totals = {
    collected: Math.round(money.reduce((s, c) => s + L.cents(c.amount), 0)) / 100,
    booked: money.filter((c) => /recorded/.test(c.action || '')).length,
    needsReview: money.filter((c) => c.match && c.match.confidence !== 'high').length,
    dryRun: !!dryRun,
  };
  return out;
}

// The platform owner (Jo), the owner's company_admin, or a platform admin. The admin
// test is passed in at each call site so the gate sits where each callable
// is declared (the FUNCTIONS_INDEX drift guard reads it there).
function requireOwner(request, isPlatformAdmin) {
  const a = request.auth;
  if (!a || !a.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const t = a.token || {};
  if (a.uid === OWNER || isPlatformAdmin(t)) return;
  if (t.companyId === OWNER && t.role === 'company_admin') return;
  throw new HttpsError('permission-denied', 'Only the account owner or a company admin can use the Stripe sync.');
}

exports.stripeLedgerSync = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 540, memory: '512MiB' },
  async (request) => {
    requireOwner(request, (t) => t.role === 'admin');
    const data = request.data || {};
    const days = Number(data.sinceDays);
    const sinceSec = days > 0 ? Math.floor(Date.now() / 1000) - Math.floor(days * 86400) : null;
    const res = await sync(getFirestore(), { sinceSec, dryRun: data.dryRun !== false });
    logger.info('[stripeLedgerSync]', { dryRun: data.dryRun !== false, sinceDays: days || 'all', totals: res.totals });
    return res;
  }
);

exports.stripeLedgerReconcile = onSchedule(
  { schedule: 'every day 06:15', timeZone: 'America/New_York', secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    if (process.env.STRIPE_LEDGER_DISABLED === 'true') { logger.info('[stripeLedgerReconcile] disabled'); return; }
    const res = await sync(getFirestore(), { sinceSec: Math.floor(Date.now() / 1000) - 4 * 86400, dryRun: false });
    logger.info('[stripeLedgerReconcile] done', res.totals);
  }
);

/**
 * Jo assigns a review-list payment to a customer (and optionally a specific
 * invoice). Remembers the Stripe customer on the lead so the next payment
 * from them books itself.
 */
/** The assignment itself — plain function so tests drive it without onCall. */
async function assign(db, ledgerId, leadId, byUid) {
  if (!ledgerId || !leadId || typeof ledgerId !== 'string' || typeof leadId !== 'string') throw new HttpsError('invalid-argument', 'ledgerId and leadId required');
  const ctx = await loadContext(db);
  if (!ctx.leads.has(leadId)) throw new HttpsError('not-found', 'Customer not found');
  const rowSnap = await db.collection(COL).doc(ledgerId).get();
  if (!rowSnap.exists) throw new HttpsError('not-found', 'Transaction not found');
  const row = rowSnap.data();
  if (!['charge', 'invoice_paid_outside_stripe'].includes(row.kind) || row.status !== 'succeeded' || !(row.amountCents > 0)) {
    throw new HttpsError('failed-precondition', 'Only a completed payment can be assigned.');
  }
  const stripe = stripeClient();
  let stripeInvoice = null, sourceObject = null;
  if (row.kind === 'charge') {
    sourceObject = await stripe.charges.retrieve(ledgerId, { expand: ['invoice'] });
    stripeInvoice = sourceObject.invoice && typeof sourceObject.invoice === 'object' ? sourceObject.invoice : null;
  } else {
    stripeInvoice = await stripe.invoices.retrieve(ledgerId);
  }
  const booked = await book(ctx, { leadId,
    mv: { key: row.kind === 'charge' ? ledgerId : ledgerId + ':oob', amountCents: row.amountCents, atMs: row.atMs, method: row.method, paymentIntentId: row.paymentIntentId || null,
      reference: row.nbdInvoiceNumber || row.stripeInvoiceNumber || null },
    stripeInvoice, sourceObject });
  const lead = ctx.leads.get(leadId);
  if (row.party && row.party.stripeCustomerId && !lead.stripeCustomerId) await db.collection('leads').doc(leadId).update({ stripeCustomerId: row.party.stripeCustomerId });
  await db.collection(COL).doc(ledgerId).set({
    match: { leadId, invoiceId: booked.invoiceId || null, method: 'manual', confidence: 'high', candidates: [], leadName: L.leadName(lead), by: byUid, at: new Date() },
    needsReview: false, updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true, invoiceId: booked.invoiceId, credited: booked.credited, created: booked.created };
}

exports.assignStripeTransaction = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 60 },
  async (request) => {
    requireOwner(request, (t) => t.role === 'admin');
    const { ledgerId, leadId } = request.data || {};
    return assign(getFirestore(), ledgerId, leadId, request.auth.uid);
  }
);

/** Balance + recent payouts for the Money view's Stripe panel. */
exports.getStripeOverview = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 30 },
  async (request) => {
    requireOwner(request, (t) => t.role === 'admin');
    const stripe = stripeClient();
    const [bal, payouts] = await Promise.all([stripe.balance.retrieve(), stripe.payouts.list({ limit: 10 })]);
    const sum = (arr) => (arr || []).filter((x) => x.currency === 'usd').reduce((s, x) => s + x.amount, 0) / 100;
    return {
      available: sum(bal.available), pending: sum(bal.pending),
      payouts: payouts.data.map((p) => ({ id: p.id, amount: p.amount / 100, status: p.status, arrival: new Date(p.arrival_date * 1000).toISOString().slice(0, 10) })),
    };
  }
);

module.exports.onEvent = onEvent;
module.exports.LEDGER_EVENTS = LEDGER_EVENTS;
module.exports._internal = { loadContext, book, ingestCharge, ingestInvoice, ingestRefund, sync, assign,
  setStripe: (client) => { _stripe = client; } };
