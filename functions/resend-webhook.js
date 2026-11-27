/**
 * resend-webhook.js — Resend's own bounce / spam-complaint signal, folded
 * into the per-tenant email suppression register.
 * ═══════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-22)
 *
 * #1715 built the opt-out register but only ever WROTE to it from things a
 * person did: the unsubscribe link, the RFC 8058 one-click POST, and a rep
 * marking someone unsubscribed. Two signals were missing, and both are the
 * ones mailbox providers actually judge a sender on:
 *
 *   - a HARD bounce — the address does not exist. Every further send to it
 *     is a deliverability tax on the sending domain.
 *   - a SPAM COMPLAINT — the recipient pressed "report spam". Continuing to
 *     mail them is the single fastest way to poison a sending domain, and
 *     CAN-SPAM treats a complaint as an opt-out signal in practice.
 *
 * `email-suppression.js` already reserved `'bounce'` and `'complaint'` in
 * SOURCES for exactly this. This file fills them in.
 *
 * ── DARK UNTIL CONFIGURED ────────────────────────────────────────────
 * Needs TWO things the owner does in the Resend dashboard (neither is in
 * this repo — see documentation/audit/EMAIL-UNSUBSCRIBE-2026-09-22.md):
 *   1. add an endpoint  https://nobigdealwithjoedeal.com/hooks/resend
 *      subscribed to `email.bounced` and `email.complained`
 *   2. put its signing secret (`whsec_…`) in the RESEND_WEBHOOK_SECRET
 *      Firebase secret
 * Until then `secretValue()` returns null and every request is refused 503
 * before any parsing. The function is inert, not half-armed.
 *
 * ── HOW A BOUNCE FINDS ITS TENANT ────────────────────────────────────
 * Resend's payload says WHICH ADDRESS bounced, never which of our tenants
 * sent to it, and suppression is per tenant — company A's bounce must not
 * silence company B. `email_log` does not store the Resend message id, so
 * there is nothing to join on.
 *
 * So the send carries the answer: every COMMERCIAL send already mints an
 * unsubscribe token (`email_unsub_tokens/{token}` → companyId, email,
 * leadId), and `gateCommercialEmail` now also returns that token as a Resend
 * TAG (`nbd_unsub`). Resend echoes tags back on the webhook. A 43-char
 * base64url token is exactly Resend's tag charset ([A-Za-z0-9_-]), so
 * nothing has to be encoded. The webhook reads the tag, loads the token doc,
 * and suppresses for THAT tenant only.
 *
 * Consequence worth stating plainly: only COMMERCIAL mail is tagged, so only
 * commercial mail can be suppressed by a bounce. That is the right scope —
 * a hard bounce on an invoice should not stop the next invoice from being
 * attempted, and suppression has never blocked transactional mail anyway.
 * An untagged event is acknowledged and dropped, never guessed at.
 *
 * ── WHAT IS DELIBERATELY NOT SUPPRESSED ──────────────────────────────
 * A TRANSIENT bounce (mailbox full, greylisted, temporarily unavailable).
 * Resend reports `data.bounce.type` as Permanent / Transient / Undetermined;
 * only Permanent is an opt-out. Suppressing a full mailbox would silently
 * and permanently cut off a real customer who did nothing.
 */
'use strict';

const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { secretValue } = require('./integrations/_shared');
const Suppression = require('./email-suppression');

const RESEND_WEBHOOK_SECRET = defineSecret('RESEND_WEBHOOK_SECRET');

// Svix (what Resend signs with) allows 5 minutes of clock skew. Stated
// explicitly so an SDK or platform default can never silently widen it.
const TOLERANCE_SECONDS = 300;

const EVENTS_COLLECTION = 'resend_events';

/**
 * Standard-webhooks / Svix signature check.
 *
 * signedContent = `${id}.${timestamp}.${rawBody}` and the header carries a
 * space-separated list of `v1,<base64>` candidates (Svix sends more than one
 * during a secret rotation). Implemented here rather than pulling the `svix`
 * dependency in: it is ~20 lines, and a webhook verifier is the last place to
 * want an unaudited transitive dependency tree.
 *
 * Accepts both the `svix-*` headers Resend sends today and the vendor-neutral
 * `webhook-*` spelling of the same spec, so a Resend change of spelling
 * cannot silently turn verification into a 400 storm.
 */
function verifySignature(req, secret) {
  const h = req.headers || {};
  const id = h['svix-id'] || h['webhook-id'];
  const timestamp = h['svix-timestamp'] || h['webhook-timestamp'];
  const signature = h['svix-signature'] || h['webhook-signature'];
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing_headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > TOLERANCE_SECONDS) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  // `whsec_` is a prefix on the printable form only; the key is the base64
  // that follows it. A secret pasted without the prefix still works.
  const raw = String(secret).startsWith('whsec_') ? String(secret).slice(6) : String(secret);
  let key;
  try { key = Buffer.from(raw, 'base64'); } catch (_) { return { ok: false, reason: 'bad_secret' }; }
  if (!key.length) return { ok: false, reason: 'bad_secret' };

  const signed = String(id) + '.' + String(timestamp) + '.' + req.rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', key).update(signed, 'utf8').digest();

  // Every candidate is compared, and always with timingSafeEqual — never a
  // string ===, which leaks the position of the first differing byte.
  const candidates = String(signature).split(' ');
  for (const part of candidates) {
    const comma = part.indexOf(',');
    if (comma === -1) continue;
    if (part.slice(0, comma) !== 'v1') continue;
    let got;
    try { got = Buffer.from(part.slice(comma + 1), 'base64'); } catch (_) { continue; }
    if (got.length !== expected.length) continue;
    if (crypto.timingSafeEqual(got, expected)) return { ok: true, id: String(id) };
  }
  return { ok: false, reason: 'no_matching_signature' };
}

/** The `nbd_unsub` tag value, whatever shape Resend echoes tags back in. */
function unsubTokenFromTags(tags) {
  const name = Suppression.UNSUB_TAG_NAME;
  if (Array.isArray(tags)) {
    for (const t of tags) {
      if (t && t.name === name && Suppression.isToken(t.value)) return t.value;
    }
    return '';
  }
  // Resend has also been seen returning tags as a plain object map.
  if (tags && typeof tags === 'object') {
    const v = tags[name];
    if (Suppression.isToken(v)) return v;
  }
  return '';
}

/**
 * Is this event an opt-out signal? Returns the suppression source, or ''.
 * A transient/undetermined bounce is NOT one — see the header.
 */
function sourceForEvent(type, data) {
  if (type === 'email.complained') return 'complaint';
  if (type === 'email.bounced') {
    const b = (data && data.bounce) || {};
    const kind = String(b.type || '').toLowerCase();
    // Resend omits bounce.type on some providers. Absent = do NOT assume
    // permanent: guessing turns a full mailbox into a permanent block.
    return kind === 'permanent' ? 'bounce' : '';
  }
  return '';
}

/** The recipient this event is about. Resend sends `to` as an array. */
function recipientOf(data) {
  const to = data && data.to;
  if (Array.isArray(to)) return Suppression.normalizeEmail(to[0]);
  return Suppression.normalizeEmail(to);
}

async function handleResendWebhook(req, res) {
  if (String(req.method || '').toUpperCase() !== 'POST') {
    res.set('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Fail closed when unconfigured — the same posture as stripeWebhook. Note
  // this is checked BEFORE anything reads the body: an unconfigured endpoint
  // must be inert, not a parser reachable by anyone.
  const secret = secretValue(RESEND_WEBHOOK_SECRET);
  if (!secret) {
    logger.error('resendWebhook: RESEND_WEBHOOK_SECRET not set — rejecting unsigned request');
    res.status(503).json({ error: 'Webhook not configured' });
    return;
  }

  // Same rawBody requirement, same reason as stripeWebhook: verifying a
  // re-serialised body either never matches or, worse, matches something the
  // sender did not sign. Never fall back to req.body.
  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
    logger.error('resendWebhook: missing rawBody — misconfigured middleware');
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  const verdict = verifySignature(req, secret);
  if (!verdict.ok) {
    logger.error('resendWebhook: signature verification failed', { reason: verdict.reason });
    res.status(400).json({ error: 'Webhook signature verification failed' });
    return;
  }

  let event;
  try { event = JSON.parse(req.rawBody.toString('utf8')); } catch (_) {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const type = String((event && event.type) || '');
  const data = (event && event.data) || {};
  const db = getFirestore();

  // Idempotency BEFORE any write, with create() rather than exists-then-write:
  // Resend retries, and two concurrent deliveries of the same id must not both
  // record. (recordSuppression is itself idempotent, so this is belt and
  // braces — but it also stops a retry storm re-reading token docs forever.)
  try {
    await db.doc(EVENTS_COLLECTION + '/' + verdict.id).create({
      type,
      receivedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    // Already processed. 200 so Resend stops retrying.
    logger.info('resendWebhook: duplicate delivery ignored', { id: verdict.id, type });
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  const source = sourceForEvent(type, data);
  if (!source) {
    // A delivered/opened/clicked event, or a transient bounce. Acknowledged
    // and dropped — subscribing to extra events must never 4xx.
    res.status(200).json({ ok: true, ignored: type });
    return;
  }

  const token = unsubTokenFromTags(data.tags);
  if (!token) {
    // Transactional mail carries no unsubscribe token, so there is no tenant
    // to attribute this to. Logged (it is worth seeing) and dropped — never
    // guessed at, because guessing wrong silences a tenant that did nothing.
    logger.warn('resendWebhook: opt-out signal with no nbd_unsub tag — not attributable to a tenant',
      { type, source, emailId: data.email_id || null });
    res.status(200).json({ ok: true, unattributed: true });
    return;
  }

  let tok = null;
  try {
    const snap = await db.doc(Suppression.TOKENS + '/' + token).get();
    tok = snap && snap.exists ? (snap.data() || {}) : null;
  } catch (e) {
    // A read failure here must be RETRIED, not swallowed: dropping it loses a
    // real opt-out. 503 makes Resend redeliver. The idempotency doc is left in
    // place deliberately-not — see below.
    logger.error('resendWebhook: token read failed', { err: e && e.message });
    try { await db.doc(EVENTS_COLLECTION + '/' + verdict.id).delete(); } catch (_) { /* best effort */ }
    res.status(503).json({ error: 'Temporarily unavailable' });
    return;
  }
  if (!tok || !tok.companyId || !tok.email) {
    logger.warn('resendWebhook: unknown unsubscribe token on an opt-out event', { type, source });
    res.status(200).json({ ok: true, unknownToken: true });
    return;
  }

  // The token says which address it was minted for. If the event is about a
  // DIFFERENT address, something is wrong (a forwarded message, a recycled
  // tag) and suppressing the token's address would silence the wrong person.
  const recipient = recipientOf(data);
  if (recipient && recipient !== Suppression.normalizeEmail(tok.email)) {
    logger.warn('resendWebhook: event recipient does not match the token address — ignoring',
      { type, source });
    res.status(200).json({ ok: true, mismatch: true });
    return;
  }

  try {
    const r = await Suppression.recordSuppression(db, {
      companyId: tok.companyId,
      email: tok.email,
      leadId: tok.leadId || null,
      source,
    }, FieldValue.serverTimestamp);
    logger.info('resendWebhook: recorded', { companyId: tok.companyId, source, created: r.created });
    // S3: a complaint / permanent bounce on REVIEW-ASK mail counts toward that company's health,
    // once per event id (review-ask-health.js; dark = nothing written; never throws).
    await require('./review-ask-health').noteEmailEvent(db, { eventId: verdict.id, source, tok });
    res.status(200).json({ ok: true, source, created: r.created });
  } catch (e) {
    logger.error('resendWebhook: record failed', { err: e && e.message });
    try { await db.doc(EVENTS_COLLECTION + '/' + verdict.id).delete(); } catch (_) { /* best effort */ }
    res.status(503).json({ error: 'Temporarily unavailable' });
  }
}

exports.resendWebhook = onRequest(
  {
    region: 'us-central1',
    secrets: [RESEND_WEBHOOK_SECRET],
    maxInstances: 10,
    concurrency: 40,
    timeoutSeconds: 15,
    memory: '256MiB', // never below 256MiB: a 128MiB gen2 fails its startup healthcheck
  },
  handleResendWebhook
);

exports._test = {
  verifySignature,
  unsubTokenFromTags,
  sourceForEvent,
  recipientOf,
  handleResendWebhook,
  TOLERANCE_SECONDS,
  EVENTS_COLLECTION,
};
