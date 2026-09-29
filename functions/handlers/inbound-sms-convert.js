/**
 * functions/handlers/inbound-sms-convert.js — idea #7 Phase 2
 * ═══════════════════════════════════════════════════════════════════
 *
 * `convertUnmatchedSms` — one-tap "convert to lead" for the admin
 * unmatched-SMS triage inbox (#1048). incomingSMS logs every text from a
 * number that matched no lead into the global `unmatched_sms` collection; the
 * Phase-1 inbox surfaces them read-only. This callable turns a row into a real
 * lead — with server-side phone dedup — and auto-drafts an AI reply into the
 * lead's ai_drafts (reusing the same approve/edit/send loop inbound SMS uses),
 * then clears the row from the inbox.
 *
 * Security: `unmatched_sms` is a GLOBAL admin-only inbox (firestore.rules
 * gates read to isAdmin(); an unknown number has no tenant). So this callable
 * is admin-gated too — owner claim or platform admin. The lead + draft are
 * written via the admin SDK (ai_drafts `create` is `if false` for clients), so
 * they bypass rules; we stamp userId/companyId to the caller so the new lead is
 * rules-compatible for their subsequent reads/writes.
 *
 * generateAIDraft self-gates (no-ops when the Anthropic secret is unset or the
 * persona/opt-out gates decline), so the draft half deploys dark & safe. The
 * draft carries the default 'inbound_sms' triggerType — it IS an inbound SMS
 * reply, indistinguishable from one incomingSMS would have created had the lead
 * existed — so onAiDraftApproved routes it down the normal SMS path (never the
 * portal fork), texting the sender back on approval.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { callableRateLimit } = require('../shared');
const { CORS_ORIGINS, isOwnerCaller } = require('./_shared');
const { phoneDigits10 } = require('../phone-utils');
const { buildConvertedLead } = require('../inbound-sms-convert-logic');
const { createLeadWithCustomerId } = require('../customer-id-mint');
const { generateAIDraft, ANTHROPIC_API_KEY } = require('./ai-texting');

exports.convertUnmatchedSms = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
    secrets: [ANTHROPIC_API_KEY],
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

    // unmatched_sms is admin-only (firestore.rules isAdmin()). Gate the same:
    // owner claim OR platform admin. A subordinate/tenant user must never reach
    // the global inbox.
    const claims = request.auth.token || {};
    if (!(isOwnerCaller(claims) || claims.role === 'admin')) {
      throw new HttpsError('permission-denied', 'Admin access required');
    }

    await callableRateLimit(request, 'convertUnmatchedSms', 60, 60_000);

    const id = request.data && String(request.data.unmatchedSmsId || '').trim();
    if (!id) throw new HttpsError('invalid-argument', 'unmatchedSmsId required');

    const db = getFirestore();
    const ref = db.collection('unmatched_sms').doc(id);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'That inbound text is no longer in the inbox.');

    const sms = snap.data() || {};
    const from = sms.from || '';
    const body = sms.body || '';
    const pd = phoneDigits10(from);

    const ownerUid = uid;
    const companyId = claims.companyId || uid;

    // Server-side dedup: reuse an existing same-tenant lead for this number —
    // one may have been created after the text landed, or the admin may be
    // converting a second text from the same sender. Scope to the caller's
    // company so we never graft the draft onto another tenant's lead. Two
    // equality filters need no composite index (single-field index merge).
    let leadId = null;
    let deduped = false;
    if (pd) {
      const dup = await db.collection('leads')
        .where('companyId', '==', companyId)
        .where('phoneDigits', '==', pd)
        .limit(1)
        .get();
      if (!dup.empty) { leadId = dup.docs[0].id; deduped = true; }
    }

    let lead;
    if (leadId) {
      lead = (await db.collection('leads').doc(leadId).get()).data() || {};
    } else {
      const leadDoc = buildConvertedLead({ from, body, phoneDigits: pd, ownerUid, companyId, unmatchedId: id });
      const created = db.collection('leads').doc();
      const { customerId } = await createLeadWithCustomerId(db, created, Object.assign({}, leadDoc, {
        createdAt: FieldValue.serverTimestamp(),
        stageStartedAt: FieldValue.serverTimestamp(),
      }));
      leadId = created.id;
      lead = customerId ? Object.assign({}, leadDoc, { customerId }) : leadDoc;
    }

    // Auto-draft an AI reply (best-effort; self-gates on the Anthropic secret).
    let draftId = null;
    if (body) {
      try {
        draftId = await generateAIDraft({
          db, leadId, lead,
          incomingBody: body,
          incomingNoteId: 'unmatched:' + id,
          incomingPhone: from,
        });
      } catch (e) {
        logger.warn('[convertUnmatchedSms] draft generation threw', { leadId, err: e && e.message });
      }
    }

    // Clear the row from the inbox so it can't be double-converted. Best-effort
    // — the lead already exists, so a failed delete just leaves a stale inbox
    // row (the next convert dedupes onto the same lead).
    await ref.delete().catch((e) => logger.warn('[convertUnmatchedSms] inbox delete failed', { id, err: e && e.message }));

    logger.info('[convertUnmatchedSms] converted', { id, leadId, deduped, draftId: draftId || null });
    return { leadId, deduped, draftId: draftId || null };
  }
);
