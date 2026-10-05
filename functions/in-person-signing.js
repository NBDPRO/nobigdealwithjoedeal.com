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

// The check-then-record core lives in in-person-signing-logic.js (no npm
// packages there, so the authed E2E can run it without functions/ deps).
const { handleInPersonSignature, RefusalError } = require('./in-person-signing-logic');

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
exports._test = require('./in-person-signing-logic');
