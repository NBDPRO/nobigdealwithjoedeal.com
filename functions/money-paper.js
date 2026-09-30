/**
 * money-paper.js — every charge gets a filed document (Jo's standing rule;
 * live-CRM handoff 2026-09-30 #7). The rules are in money-paper-logic.js.
 *
 * One Firestore trigger on invoices/{invoiceId}, NBD tenant only:
 *   - NBD-500 invoice PDF when a Stripe invoice is attached (and again for a
 *     re-minted one), filed on the lead's Documents tab.
 *   - NBD-510 receipt PDF once the invoice is paid in full, filed the same way.
 *   - Paid in full by Mark Paid (Zelle / check / cash) while a Stripe invoice
 *     is open → that Stripe invoice is marked paid out of band, AFTER the
 *     ledger key `<in_id>:oob` is recorded on the CRM invoice, so the Stripe
 *     ledger never credits the same money twice.
 *
 * Filed = PDF in Storage at documents/{ownerUid}/{leadId}/{instanceId}.pdf
 * (NOT pdf-renders/, which is deleted after 30 days) + a leads/{id}/documents
 * row with `pdfPath`. The Documents tab opens it through getDocumentPdfUrl
 * (document-view.js): authed, a short-lived signed link, never a public URL.
 *
 * Safe by construction:
 *   - Each document is CLAIMED in a transaction (instance id allocated, state
 *     'rendering') before any work, so a retried or doubled event never files
 *     twice; the row id IS the instance id.
 *   - The trigger's own writes back to the invoice re-fire it, and decide()
 *     then returns nothing for work already claimed — no loop.
 *   - A failed render is retried on later writes at most 3 times.
 *   - Kill switch: NBD_MONEY_PAPER=off.
 * Drive filing (CUSTOMERS/<Name>/Docs) waits on Jo sharing the folder — see
 * documentation/projects/CRM-JOBS-AND-MONEY-PAPER-PLAN-2026-09-30.md (P2).
 */
'use strict';

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const P = require('./money-paper-logic');

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const MAX_ATTEMPTS = 3;
const STALE_MS = 10 * 60 * 1000;   // a claim still 'rendering' after this died mid-run

// A claimed document that may be tried again: it failed, or its run died
// while rendering (function timeout), and it has attempts left.
function retriable(cur, nowMs) {
  if (!cur || (cur.attempts || 0) >= MAX_ATTEMPTS) return false;
  if (cur.state === 'failed') return true;
  const at = cur.at && typeof cur.at.toMillis === 'function' ? cur.at.toMillis() : (cur.at instanceof Date ? cur.at.getTime() : 0);
  return cur.state === 'rendering' && at > 0 && nowMs - at > STALE_MS;
}

let _stripe = null;
function stripeClient() {
  if (_stripe) return _stripe;
  const { secretValue } = require('./integrations/_shared');
  const key = secretValue(STRIPE_SECRET_KEY);
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  const Stripe = require('stripe');
  _stripe = new Stripe(key, { apiVersion: '2023-10-16', maxNetworkRetries: 2, timeout: 20000 });
  return _stripe;
}

async function realRender(templateKey, payload, companyId) {
  const R = require('./render-pdf');
  const { html, company, tmplCfg, docNumber } = await R.buildDocHtml(templateKey, payload, companyId);
  return R.htmlToPdf(html, company, tmplCfg, docNumber);
}

// A short-lived link for the photo plate (Chromium fetches it while printing).
async function plateFor(db, bucket, lead, leadId) {
  try {
    const snap = await db.collection('photos').where('leadId', '==', leadId).limit(200).get();
    const photos = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    const p = P.pickPlatePhoto(lead, photos);
    if (!p) return null;
    const path = p.path || p.storagePath;
    let url = null;
    if (path) {
      [url] = await bucket.file(path).getSignedUrl({ action: 'read', expires: Date.now() + 30 * 60 * 1000 });
    } else if (/^https:/i.test(p.url || '')) {
      url = p.url;
    }
    return url ? { url, caption: p.caption ? String(p.caption).slice(0, 140) : null } : null;
  } catch (e) {
    logger.warn('[moneyPaper] photo plate skipped', { leadId, err: e && e.message });
    return null;
  }
}

/**
 * Claim `kind` on the invoice: allocate an instance id from the per-day
 * counter and mark it rendering. → { id } | null (already claimed / done).
 */
async function claim(db, invRef, kind, nowMs) {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(invRef);
    if (!s.exists) return null;
    const inv = s.data();
    const d = P.decide(inv, { ownerUid: OWNER });
    const want = kind === 'invoice' ? d.fileInvoice : d.fileReceipt;
    const cur = (inv.paper && inv.paper[kind]) || null;
    const retry = retriable(cur, nowMs) && (kind !== 'invoice' || cur.stripeInvoiceId === inv.stripeInvoiceId);
    if (!want && !retry) return null;
    if (!retry && cur && cur.state === 'rendering' && cur.stripeInvoiceId === inv.stripeInvoiceId) return null;
    let id = retry ? cur.instanceId : null;
    if (!id) {
      const ymd = P.etParts(nowMs).ymd;
      const cRef = db.collection('counters').doc('moneyPaper_' + ymd);
      const c = await tx.get(cRef);
      const n = ((c.exists && c.data().n) || 0) + 1;
      tx.set(cRef, { n, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      id = P.instanceId(nowMs, n);
    }
    tx.update(invRef, {
      ['paper.' + kind]: {
        instanceId: id, code: P.CODES[kind], state: 'rendering',
        stripeInvoiceId: inv.stripeInvoiceId || null,
        attempts: ((cur && cur.attempts) || 0) + 1, at: new Date(nowMs),
      },
    });
    return { id, inv };
  });
}

async function fileOne(deps, invRef, invoiceId, kind) {
  const { db, bucket, render, now } = deps;
  const nowMs = now();
  const c = await claim(db, invRef, kind, nowMs);
  if (!c) return null;
  const inv = Object.assign({ id: invoiceId }, c.inv);
  const leadId = inv.leadId ? String(inv.leadId) : null;
  try {
    if (!leadId) throw new Error('invoice has no leadId — nowhere to file');
    const ls = await db.collection('leads').doc(leadId).get();
    const lead = ls.exists ? ls.data() : null;
    if (!lead) throw new Error('lead ' + leadId + ' not found');
    const plate = await plateFor(db, bucket, lead, leadId);
    const payload = kind === 'invoice'
      ? P.invoicePayload(inv, lead, c.id, nowMs, plate)
      : P.receiptPayload(inv, lead, c.id, nowMs, plate);
    const pdf = await render(kind, payload, inv.companyId || OWNER);
    const ownerUid = String(lead.userId || inv.userId || OWNER);
    const pdfPath = P.pdfPathFor(ownerUid, leadId, c.id);
    await bucket.file(pdfPath).save(pdf, {
      resumable: false,
      metadata: { contentType: 'application/pdf', cacheControl: 'private, max-age=31536000', metadata: { docCode: P.CODES[kind], instanceId: c.id, invoiceId } },
    });
    await db.collection('leads').doc(leadId).collection('documents').doc(c.id).set(Object.assign(
      P.documentRow(kind, c.id, inv, pdfPath, pdf.length),
      { uploadedAt: FieldValue.serverTimestamp(), uploadedBy: 'money-paper' }));
    await invRef.update({ ['paper.' + kind + '.state']: 'filed', ['paper.' + kind + '.pdfPath']: pdfPath, ['paper.' + kind + '.filedAt']: FieldValue.serverTimestamp() });
    logger.info('[moneyPaper] filed', { kind, invoiceId, leadId, instanceId: c.id, bytes: pdf.length });
    return c.id;
  } catch (e) {
    logger.error('[moneyPaper] file failed', { kind, invoiceId, leadId, err: e && e.message });
    await invRef.update({ ['paper.' + kind + '.state']: 'failed', ['paper.' + kind + '.error']: String((e && e.message) || e).slice(0, 300) }).catch(() => {});
    return null;
  }
}

/**
 * Mark the open Stripe invoice paid out of band — after recording the ledger
 * key that stops stripe-ledger.js crediting it again.
 */
async function markOutOfBand(deps, invRef, invoiceId) {
  const { db, stripe } = deps;
  const go = await db.runTransaction(async (tx) => {
    const s = await tx.get(invRef);
    if (!s.exists) return null;
    const inv = s.data();
    if (!P.decide(inv, { ownerUid: OWNER }).markOob) return null;
    const sid = inv.stripeInvoiceId;
    const keys = Array.isArray(inv.stripeCreditKeys) ? inv.stripeCreditKeys : [];
    tx.update(invRef, {
      stripeCreditKeys: keys.includes(sid + ':oob') ? keys : keys.concat(sid + ':oob'),
      'paper.oob': { stripeInvoiceId: sid, state: 'pending', at: new Date() },
    });
    return sid;
  });
  if (!go) return null;
  try {
    const si = await stripe().invoices.retrieve(go);
    if (si.status !== 'open') {
      await invRef.update({ 'paper.oob.state': 'skipped_' + si.status });
      return 'skipped';
    }
    await stripe().invoices.update(go, { metadata: { nbd_paid_out_of_band: 'crm_mark_paid', nbd_invoice_id: String(invoiceId) } });
    await stripe().invoices.pay(go, { paid_out_of_band: true }, { idempotencyKey: 'nbd-oob-' + go });
    await invRef.update({ 'paper.oob.state': 'done', 'paper.oob.doneAt': FieldValue.serverTimestamp() });
    logger.info('[moneyPaper] Stripe invoice marked paid out of band', { invoiceId, stripeInvoiceId: go });
    return 'done';
  } catch (e) {
    logger.error('[moneyPaper] out-of-band failed', { invoiceId, stripeInvoiceId: go, err: e && e.message });
    await invRef.update({ 'paper.oob.state': 'failed', 'paper.oob.error': String((e && e.message) || e).slice(0, 300) }).catch(() => {});
    return 'failed';
  }
}

/**
 * Only act on a CHANGE made now, never on history: an invoice that was
 * already paid (or already carried this Stripe invoice) before the write is
 * left alone. Without this, the first unrelated write to an old invoice after
 * deploy would file a receipt for a months-old payoff and could mark an old
 * Stripe invoice paid out of band. `before` null = a new invoice doc.
 */
function transitions(before, after) {
  const b = before || {};
  const paidNow = after && after.status === 'paid';
  return {
    newStripeInvoice: !!(after && after.stripeInvoiceId && after.stripeHostedUrl
      && (b.stripeInvoiceId !== after.stripeInvoiceId || !b.stripeHostedUrl)),
    becamePaid: !!(paidNow && b.status !== 'paid'),
  };
}

/** One invoice write → whatever it needs. Exported for tests with fake deps. */
async function handle(invoiceId, after, deps, before) {
  if (process.env.NBD_MONEY_PAPER === 'off') return { skipped: 'killswitch' };
  const d = P.decide(after, { ownerUid: OWNER });
  // before === undefined → a caller that cannot tell (tests of the rules
  // alone); the trigger always passes the real before (null for a create).
  if (before !== undefined) {
    const t = transitions(before, after);
    if (!t.newStripeInvoice) d.fileInvoice = false;
    if (!t.becamePaid) { d.fileReceipt = false; d.markOob = false; }
  }
  const out = {};
  if (!d.fileInvoice && !d.fileReceipt && !d.markOob
      && !(after && after.paper && ['invoice', 'receipt'].some((k) => retriable(after.paper[k], deps.now())))) {
    return out;
  }
  const invRef = deps.db.collection('invoices').doc(String(invoiceId));
  // Out of band first: it stops a second card payment as early as possible.
  if (d.markOob) out.oob = await markOutOfBand(deps, invRef, invoiceId);
  // Only the kinds this write asked for, or a claim that is due a retry —
  // fileOne's claim re-checks the rules but cannot see the transition mask.
  const pp = (after && after.paper) || {};
  if (d.fileInvoice || retriable(pp.invoice, deps.now())) out.invoice = await fileOne(deps, invRef, invoiceId, 'invoice');
  if (d.fileReceipt || retriable(pp.receipt, deps.now())) out.receipt = await fileOne(deps, invRef, invoiceId, 'receipt');
  return out;
}

exports.moneyPaperOnInvoice = onDocumentWritten(
  { document: 'invoices/{invoiceId}', region: 'us-central1', memory: '2GiB', timeoutSeconds: 120, maxInstances: 3, secrets: [STRIPE_SECRET_KEY] },
  async (event) => {
    const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
    if (!after) return;
    const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    await handle(event.params.invoiceId, after, {
      db: getFirestore(), bucket: getStorage().bucket(), render: realRender, stripe: stripeClient, now: () => Date.now(),
    }, before);
  }
);

exports._internal = { handle, transitions, claim, fileOne, markOutOfBand, retriable, OWNER, MAX_ATTEMPTS, STALE_MS };
