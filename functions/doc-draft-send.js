/**
 * doc-draft-send.js — the SERVER side of "send this draft" (Jo, 2026-10-13,
 * security review of #2447). Not a Cloud Function: functions/email-functions.js
 * (sendEmail) calls it when the request names {leadId, draftId}.
 *
 * WHY: before this, the Docs-to-review queue sent through the generic sendEmail
 * with a client-supplied `to` and `kind`, then wrote status 'sent' from the
 * browser. That left three holes —
 *   1. a rep could call sendEmail directly with kind:'document' and skip the
 *      unsubscribe gate for what is really marketing;
 *   2. two tabs / two people could both press Send: nothing on the server
 *      knew the draft existed, so both emails went;
 *   3. do-not-contact was checked in the browser only, and soldTier (rep
 *      editable) could write a wrong warranty year into a reviewed draft.
 *
 * NOW the draft is the authority:
 *   - `to` and the email kind come FROM THE DRAFT (kind from the server-side
 *     DRAFT_KINDS table, not the stored copy); the client sends only
 *     {leadId, draftId} plus, while the draft is still 'draft', the rep's
 *     edited subject/body (length-checked, control/bidi stripped, unresolved
 *     [[...]] refused);
 *   - every gate runs HERE: caller can open the lead, recipient still on the
 *     lead, do-not-contact, and — for the commercial kind (the thank-you's
 *     review ask) — the unsubscribe register, STOP, CAN-SPAM postal address;
 *   - the draft is CLAIMED in a transaction (status 'draft' -> 'sending' +
 *     nonce) BEFORE the provider is called, so two concurrent sends make
 *     exactly one provider call; the loser gets 409.
 *
 * Claim outcomes:
 *   provider accepted          -> 'sent' (+ sentAt, messageId, sentBy)
 *   provider DEFINITELY refused (a 4xx API answer other than 408)
 *                              -> released back to 'draft' (+ lastSendError)
 *   anything ambiguous (thrown, network, 5xx, 408, no status) -> the claim is
 *     KEPT as 'sending' with sendState 'check_provider'. The email may have
 *     gone out; nothing retries it. The rep clears the card by hand (rules let
 *     the browser move a stale/ambiguous 'sending' draft to 'copied' or
 *     'dismissed'; never back to 'draft').
 *
 * Two phases so the HTTP handler can run its rate limiters between them
 * (a 429 must never strand a claim): prepareDraftSend (reads + gates, NO
 * writes to the draft) then executeDraftSend (claim -> provider -> finalise).
 *
 * Dependency-injected (db, send, FieldValue, Suppression, SendGuard) so the
 * race test can drive it with a stub provider and a concurrent fake Firestore.
 */
'use strict';

const D = require('./doc-drafts-logic');

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SUBJECT_MAX = 300;   // firestore.rules doc_drafts limit
const BODY_MAX = 10000;    // firestore.rules doc_drafts limit

// Control chars (keeps \n), DEL + C1, zero-width / bidi marks and overrides /
// isolates / invisible operators, line + paragraph separators, BOM, ALM.
const STRIP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/g;

function cleanText(value, multiline) {
  let t = String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(STRIP_RE, '').replace(/\t/g, ' ');
  if (!multiline) t = t.replace(/\n+/g, ' ').replace(/ {2,}/g, ' ');
  return t.trim();
}

// meta never reaches the client: { logRow } names the email_log status to
// record, { log } is a server-log detail.
function refuse(status, code, error, extra, meta) {
  return { status, json: Object.assign({ error, code }, extra || {}), meta: meta || null };
}

/** A provider answer that definitely means "not sent" (a 4xx API answer). */
function definiteProviderRefusal(response) {
  const err = response && response.error;
  if (!err) return false;
  const code = Number(err.statusCode != null ? err.statusCode : err.status);
  return Number.isFinite(code) && code >= 400 && code < 500 && code !== 408;
}

function errMsg(response) {
  const err = response && response.error;
  if (!err) return 'unknown';
  return String(typeof err === 'string' ? err : (err.message || 'Email provider rejected the request')).slice(0, 300);
}

/**
 * Phase 1 — everything that can refuse, with NO write to the draft.
 * input: { decoded, leadId, draftId, subject, body }
 * deps:  { db, Suppression, SendGuard, FieldValue }
 * → { refusal: {status, json} } | { plan }
 */
async function prepareDraftSend(input, deps) {
  const { decoded, leadId, draftId } = input;
  const { db, Suppression, SendGuard, FieldValue } = deps;
  if (typeof leadId !== 'string' || !ID_RE.test(leadId) || typeof draftId !== 'string' || !ID_RE.test(draftId)) {
    return { refusal: refuse(400, 'bad_draft_ref', 'That draft reference is not valid.') };
  }
  const leadRef = db.doc('leads/' + leadId);
  const draftRef = db.doc('leads/' + leadId + '/doc_drafts/' + draftId);
  let lead = null;
  let draft = null;
  try {
    const [ls, ds] = await Promise.all([leadRef.get(), draftRef.get()]);
    lead = ls.exists ? (ls.data() || {}) : null;
    draft = ds.exists ? (ds.data() || {}) : null;
  } catch (e) {
    // Unknown record state is "do not send".
    return { refusal: refuse(503, 'record_unverified', 'Could not load the customer record — nothing was sent. Try again in a moment.', null, { log: e && e.message }) };
  }
  if (!lead) return { refusal: refuse(404, 'record_not_found', 'That customer could not be found.') };
  // Same people the draft rules let in: the lead's owner, a platform admin, a
  // company_admin / manager of the lead's own company.
  if (!SendGuard.callerCanAccessLead(decoded, lead)) {
    return { refusal: refuse(403, 'record_forbidden', 'You cannot email this customer from your account.') };
  }
  if (!draft) return { refusal: refuse(404, 'draft_not_found', 'That draft no longer exists.') };

  // Cheap early answers for the common double-click / second-tab case. The
  // authoritative check is the claim transaction in executeDraftSend.
  if (draft.status === 'sent') return { refusal: refuse(409, 'already_sent', 'This was already sent.', { draftStatus: 'sent' }) };
  if (draft.status === 'sending') {
    return { refusal: refuse(409, 'already_sending', 'This is already being sent (or needs checking at the provider).', { draftStatus: 'sending', sendState: draft.sendState || null }) };
  }
  if (draft.status !== 'draft') {
    return { refusal: refuse(409, 'draft_not_sendable', 'This draft cannot be sent any more.', { draftStatus: String(draft.status || '') }) };
  }

  // Binding: the draft must belong to THIS lead and tenant.
  if (draft.leadId && String(draft.leadId) !== leadId) {
    return { refusal: refuse(403, 'record_forbidden', 'That draft does not belong to this customer.') };
  }
  if (draft.companyId && lead.companyId && String(draft.companyId) !== String(lead.companyId)) {
    return { refusal: refuse(403, 'record_forbidden', 'That draft does not belong to this customer.') };
  }
  const spec = D.DRAFT_KINDS[String(draft.kind || '')];
  if (!spec) return { refusal: refuse(422, 'unknown_draft_kind', 'This draft cannot be sent from here.') };
  if (draft.channel !== 'email') {
    return { refusal: refuse(422, 'not_email_draft', 'This draft has no email to send to — copy it instead.') };
  }

  // do-not-contact: every kind, fail closed (the lead was read above — an
  // unreadable lead already answered 503).
  if (lead.doNotContact === true || lead.dnc === true) {
    return { refusal: refuse(403, 'do_not_contact', 'This customer is on your do-not-contact list. Nothing was sent.') };
  }

  // The address comes from the draft, and must still be on the lead (the
  // customer's email can change between drafting and sending).
  const to = String(draft.to || '').trim();
  if (!to || !SendGuard.recipientOnRecord(to, lead, null)) {
    return { refusal: refuse(422, 'recipient_not_on_record', 'That address is no longer on this customer\'s record. Nothing was sent.') };
  }

  // Text: the rep's edit counts only while the draft is still a draft (it is,
  // by the checks above); otherwise the stored text.
  const wantSubject = typeof input.subject === 'string' ? input.subject : draft.subject;
  const wantBody = typeof input.body === 'string' ? input.body : draft.body;
  if (typeof wantSubject === 'string' && wantSubject.length > SUBJECT_MAX * 2) {
    return { refusal: refuse(422, 'invalid_text', 'The subject is too long.') };
  }
  if (typeof wantBody === 'string' && wantBody.length > BODY_MAX * 2) {
    return { refusal: refuse(422, 'invalid_text', 'The message is too long.') };
  }
  const subject = cleanText(wantSubject, false);
  const body = cleanText(wantBody, true);
  if (!subject || !body) return { refusal: refuse(422, 'invalid_text', 'Subject and message can\'t be empty.') };
  if (subject.length > SUBJECT_MAX) return { refusal: refuse(422, 'invalid_text', 'The subject is too long (300 characters at most).') };
  if (body.length > BODY_MAX) return { refusal: refuse(422, 'invalid_text', 'The message is too long (10,000 characters at most).') };
  const left = D.placeholdersIn(subject).concat(D.placeholdersIn(body));
  if (left.length) {
    return { refusal: refuse(422, 'unresolved_placeholders', 'Fill in the highlighted blanks first: ' + left.slice(0, 3).join(' '), { placeholders: left.slice(0, 5) }) };
  }

  // Unsubscribe / STOP / postal address — by the DRAFT'S kind (spec.emailKind),
  // never a client claim. '' = commercial (the review ask).
  const tenantKey = String(decoded.companyId || decoded.uid || '');
  const emailKind = spec.emailKind;
  const category = Suppression.resolveCategory({ kind: emailKind });
  let unsubGate = null;
  if (category === Suppression.CATEGORY.COMMERCIAL) {
    if (lead.smsOptedOut === true) {
      return { refusal: refuse(403, 'stop_requested', 'This customer replied STOP — a review ask is marketing. Nothing was sent.') };
    }
    try {
      unsubGate = await Suppression.gateCommercialEmail(db, {
        companyId: tenantKey, email: to, leadId, source: 'sendEmail',
      }, { timeoutMs: Suppression.READ_TIMEOUT_MS, serverTimestamp: FieldValue.serverTimestamp });
    } catch (e) {
      return { refusal: refuse(503, 'suppression_unverified', 'Could not confirm this person can be emailed — nothing was sent. Try again in a moment.', null, { log: e && e.message }) };
    }
    if (unsubGate.suppressed) {
      return { refusal: refuse(403, 'unsubscribed', 'This person unsubscribed from email', null, { logRow: 'suppressed', to, subject }) };
    }
    if (unsubGate.blocked) {
      return { refusal: refuse(403, Suppression.NO_POSTAL_ADDRESS, Suppression.NO_POSTAL_ADDRESS_MESSAGE, null, { logRow: 'blocked_no_postal_address', to, subject }) };
    }
  }

  return {
    plan: {
      leadId, draftId, leadRef, draftRef, to, subject, body,
      kind: String(draft.kind), emailKind, category, unsubGate, tenantKey,
      companyId: decoded.companyId || null, uid: decoded.uid,
      draftTo: String(draft.to || ''), draftKind: String(draft.kind || ''),
    },
  };
}

async function _claim(plan, nonce, deps) {
  const { db, FieldValue } = deps;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(plan.draftRef);
    if (!snap.exists) return { ok: false, status: 404, code: 'draft_not_found', error: 'That draft no longer exists.' };
    const cur = snap.data() || {};
    if (cur.status === 'sent') return { ok: false, status: 409, code: 'already_sent', error: 'This was already sent.', draftStatus: 'sent' };
    if (cur.status === 'sending') return { ok: false, status: 409, code: 'already_sending', error: 'This is already being sent (or needs checking at the provider).', draftStatus: 'sending', sendState: cur.sendState || null };
    if (cur.status !== 'draft') return { ok: false, status: 409, code: 'draft_not_sendable', error: 'This draft cannot be sent any more.', draftStatus: String(cur.status || '') };
    // Everything the gates decided on is server-owned and immutable; if it
    // moved anyway, re-run from the top.
    if (String(cur.to || '') !== plan.draftTo || String(cur.kind || '') !== plan.draftKind) {
      return { ok: false, status: 409, code: 'draft_changed', error: 'This draft changed. Reopen it and review it again.', draftStatus: 'draft' };
    }
    tx.update(plan.draftRef, {
      status: 'sending', sendNonce: nonce, sendState: 'in_flight',
      sendingAt: FieldValue.serverTimestamp(), sendingBy: plan.uid,
      subject: plan.subject, body: plan.body,
    });
    return { ok: true };
  });
}

// Nonce-guarded writes: only the claim holder may change a claimed draft.
async function _ifOwner(plan, nonce, deps, patchFn) {
  const { db } = deps;
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(plan.draftRef);
    const cur = snap.exists ? (snap.data() || {}) : null;
    if (!cur || cur.status !== 'sending' || cur.sendNonce !== nonce) return false;
    tx.update(plan.draftRef, patchFn(cur));
    return true;
  });
}

/**
 * Phase 2 — claim, provider, finalise.
 * deps: { db, FieldValue, logger, buildMessage(plan) -> message, send(message) -> response,
 *         nonce?, logEmail?(status, extra) }
 * → { status, json }
 */
async function executeDraftSend(plan, deps) {
  const { FieldValue, logger } = deps;
  const logEmail = deps.logEmail || (async () => {});
  const nonce = (deps.nonce || (() => require('crypto').randomBytes(16).toString('hex')))();
  const extra = { kind: plan.emailKind || 'commercial', category: plan.category, draftId: plan.draftId };

  let claim;
  try {
    claim = await _claim(plan, nonce, deps);
  } catch (e) {
    // The claim transaction itself failed: nothing was sent.
    logger.error('doc_draft_send claim_failed', { draftId: plan.draftId, err: e && e.message });
    return refuse(503, 'claim_failed', 'Could not reserve this draft — nothing was sent. Try again in a moment.');
  }
  if (!claim.ok) {
    return refuse(claim.status, claim.code, claim.error, { draftStatus: claim.draftStatus, sendState: claim.sendState });
  }

  const release = async (code, msg) => {
    try {
      await _ifOwner(plan, nonce, deps, () => ({
        status: 'draft', sendNonce: FieldValue.delete(), sendState: FieldValue.delete(),
        sendingAt: FieldValue.delete(), sendingBy: FieldValue.delete(),
        lastSendError: { code, message: String(msg || '').slice(0, 300) },
      }));
    } catch (e) {
      // Could not release: it stays 'sending' and goes stale; the rep sees
      // "check provider" after 5 min. Safe (no double send), just stuck.
      logger.error('doc_draft_send release_failed', { draftId: plan.draftId, err: e && e.message });
    }
  };

  // Build the message AFTER the claim but BEFORE the provider: a throw here
  // means nothing was sent, so the claim is released.
  let message;
  try {
    message = await deps.buildMessage(plan);
  } catch (e) {
    logger.error('doc_draft_send build_failed', { draftId: plan.draftId, err: e && e.message });
    await release('build_failed', e && e.message);
    return refuse(500, 'build_failed', 'Failed to send email');
  }

  let response;
  try {
    response = await deps.send(message);
  } catch (e) {
    // The request may have reached the provider. KEEP the claim, mark it for
    // a human, never auto-retry.
    logger.error('doc_draft_send provider_threw', { draftId: plan.draftId, err: e && e.message });
    await _markUnconfirmed(plan, nonce, deps, e && e.message);
    await logEmail('unconfirmed', extra);
    return refuse(502, 'send_unconfirmed', 'This may or may not have gone out. Check your email provider before doing anything else — it will not be retried automatically.', { draftStatus: 'sending', sendState: 'check_provider' });
  }

  if (response && response.error) {
    const msg = errMsg(response);
    if (definiteProviderRefusal(response)) {
      logger.error('doc_draft_send provider_refused', { draftId: plan.draftId, err: msg });
      await release('provider_rejected', msg);
      await logEmail('failed', extra);
      return refuse(502, 'provider_rejected', 'Failed to send email', { detail: msg, draftStatus: 'draft' });
    }
    logger.error('doc_draft_send provider_ambiguous', { draftId: plan.draftId, err: msg });
    await _markUnconfirmed(plan, nonce, deps, msg);
    await logEmail('unconfirmed', extra);
    return refuse(502, 'send_unconfirmed', 'This may or may not have gone out. Check your email provider before doing anything else — it will not be retried automatically.', { draftStatus: 'sending', sendState: 'check_provider' });
  }

  const messageId = (response && ((response.data && response.data.id) || response.id)) || null;
  let bookkeeping = 'ok';
  try {
    const wrote = await _ifOwner(plan, nonce, deps, () => ({
      status: 'sent', sentAt: FieldValue.serverTimestamp(), sentBy: plan.uid,
      messageId: messageId || null, sendState: FieldValue.delete(),
    }));
    if (!wrote) bookkeeping = 'claim_lost';
  } catch (e) {
    bookkeeping = 'failed';
    logger.error('doc_draft_send finalise_failed', { draftId: plan.draftId, messageId, err: e && e.message });
  }
  await logEmail('sent', extra);
  // The email WENT. A bookkeeping miss never turns into "could not send".
  return { status: 200, json: { success: true, id: messageId, draftId: plan.draftId, draftStatus: 'sent', bookkeeping } };
}

async function _markUnconfirmed(plan, nonce, deps, msg) {
  const { FieldValue, logger } = deps;
  try {
    await _ifOwner(plan, nonce, deps, () => ({
      sendState: 'check_provider', sendError: String(msg || '').slice(0, 300),
      sendUnconfirmedAt: FieldValue.serverTimestamp(),
    }));
  } catch (e) {
    logger.error('doc_draft_send mark_unconfirmed_failed', { draftId: plan.draftId, err: e && e.message });
  }
}

module.exports = {
  ID_RE, SUBJECT_MAX, BODY_MAX,
  cleanText, definiteProviderRefusal, prepareDraftSend, executeDraftSend,
};
