/**
 * functions/in-person-signing.js — an in-person signature moves the card
 * (Jo, 2026-10-03).
 *
 * Remote signing (remote-signing.js), e-sign envelopes and the deal room all
 * reach the job spine (job-spine.js recordJobEvent → contract_signed), so the
 * card moves to Contract Signed and #2131's draft deposit invoice is made.
 * In-person signing never did: the homeowner signs on the rep's phone, the
 * BROWSER saves the signed contract (document-generator.js onPersistFinalized
 * — status 'signed', signedAt, signedSigners, the Contract Filed stamp) and
 * nothing told the server. Jo's most common signing, the one at the kitchen
 * table, left the card where it was and made no deposit draft.
 *
 *   recordInPersonSignature({ leadId, docId })   onCall, authenticated
 *
 * The client calls it right after it saved the signed contract. The server
 * trusts nothing but the ids: it READS the lead and the document and checks
 *   - the caller is signed in and is not a viewer (viewer = read-only, Jo's
 *     decision B, 2026-09-25);
 *   - the lead belongs to the caller's company (owner, or same companyId);
 *   - the document lives under that lead (leads/{leadId}/documents/{docId});
 *   - the document is actually signed: status 'signed', a signedAt, and every
 *     REQUIRED signer role it was generated with present in signedSigners;
 *   - it is a contract (other signed documents — a completion certificate, an
 *     AOB — are not a signing of the job, and return skipped).
 * Then contract_signed goes through the spine with sourceId 'doc_<docId>' —
 * the same id remote signing uses for the same document — so a retry, a
 * double tap or the same contract signed remotely as well counts ONCE.
 *
 * Never sends anything to the homeowner (the spine and the deposit draft
 * never do). The client must not block on this call: the contract is already
 * saved; a failure only logs and shows a toast.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { callableRateLimit, assertNotViewer } = require('./shared');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

class RefusalError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Is this lead the caller's company's? Owner, or the same companyId claim. */
function sameCompany(lead, uid, token) {
  if (!lead || !uid) return false;
  if (lead.userId && lead.userId === uid) return true;
  const co = token && typeof token.companyId === 'string' ? token.companyId : '';
  if (co && lead.companyId && lead.companyId === co) return true;
  // A solo operator's leads carry companyId === their uid.
  if (!co && lead.companyId && lead.companyId === uid) return true;
  return false;
}

/**
 * Is this document really signed? Read from Firestore, never from the call.
 * → null when signed, else the reason it is not.
 */
function notSignedReason(docMeta) {
  const d = docMeta || {};
  if (String(d.status || '') !== 'signed') return 'not_signed';
  if (!d.signedAt) return 'no_signed_at';
  const signed = Array.isArray(d.signedSigners) ? d.signedSigners.filter((s) => s && s.role) : [];
  if (!signed.length) return 'no_signers';
  const have = new Set(signed.map((s) => String(s.role)));
  const required = Array.isArray(d.signers) ? d.signers.filter((s) => s && s.role && s.required) : [];
  for (const s of required) if (!have.has(String(s.role))) return 'missing_required_signer';
  return null;
}

/**
 * The whole check-then-record, with the database injected (testable with a
 * fake Firestore; the E2E drives it against the emulator).
 * auth = { uid, token }. Throws RefusalError(code, message) to refuse.
 */
async function handleInPersonSignature(db, auth, data, deps) {
  const uid = auth && auth.uid;
  if (!uid) throw new RefusalError('unauthenticated', 'Sign in required');
  const token = (auth && auth.token) || {};
  const d = data || {};
  const leadId = typeof d.leadId === 'string' ? d.leadId.trim() : '';
  const docId = typeof d.docId === 'string' ? d.docId.trim() : '';
  if (!ID_RE.test(leadId) || !ID_RE.test(docId)) throw new RefusalError('invalid-argument', 'leadId and docId required');

  const leadSnap = await db.doc('leads/' + leadId).get();
  if (!leadSnap.exists) throw new RefusalError('not-found', 'Lead not found');
  const lead = leadSnap.data() || {};
  if (lead.deleted === true) throw new RefusalError('not-found', 'Lead not found');
  if (!sameCompany(lead, uid, token)) throw new RefusalError('permission-denied', 'Not your company\'s lead');

  const docSnap = await db.doc('leads/' + leadId + '/documents/' + docId).get();
  if (!docSnap.exists) throw new RefusalError('not-found', 'Document not found');
  const docMeta = docSnap.data() || {};
  const why = notSignedReason(docMeta);
  if (why) throw new RefusalError('failed-precondition', 'This document is not signed (' + why + ')');
  if (String(docMeta.type || '') !== 'contract') return { ok: true, skipped: 'not_a_contract' };

  const recordJobEvent = (deps && deps.recordJobEvent) || require('./job-spine').recordJobEvent;
  const r = await recordJobEvent(db, {
    leadId, companyId: lead.companyId || null,
    event: 'contract_signed', sourceId: 'doc_' + docId,
    actor: 'in-person signing',
    meta: { docId, detail: 'signed in person' },
  }, deps) || {};
  return {
    ok: true,
    moved: !!r.moved,
    duplicate: !!r.duplicate,
    reason: r.reason || null,
    to: r.to || null,
    depositDraft: r.depositDraft ? { created: !!r.depositDraft.created, reason: r.depositDraft.reason || null } : null,
  };
}

exports.recordInPersonSignature = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // A viewer is read-only — no stage move, no invoice draft, even on a
    // lead they own (decision B, 2026-09-25).
    assertNotViewer(request.auth.token);
    await callableRateLimit(request, 'recordInPersonSignature', 30, 60_000);
    try {
      return await handleInPersonSignature(getFirestore(), { uid, token: request.auth.token || {} }, request.data);
    } catch (e) {
      if (e instanceof RefusalError) throw new HttpsError(e.code, e.message);
      logger.warn('[recordInPersonSignature] failed', { uid, err: e && e.message });
      throw new HttpsError('internal', 'Could not record the signing');
    }
  }
);

// Test hooks (index.js exports recordInPersonSignature by name only).
exports._test = { handleInPersonSignature, notSignedReason, sameCompany, RefusalError };
