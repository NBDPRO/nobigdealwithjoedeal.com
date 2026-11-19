/**
 * functions/paper-cert.js - attestWetSigned (paper certification, flag docClauseSetV1; Jo's decisions Q49, Q63).
 *
 *   attestWetSigned({ leadId, docId, witnessName? })   onCall, authenticated, not a viewer
 *
 * A signed paper document uploaded to a customer waits as 'wet_signed_uploaded' ("Uploaded, not certified").
 * The lead's owner or same-company staff certify it here; the SERVER writes the attestation, the digest of the
 * linked original and the move to 'signed', then files the contract through the job spine like every other
 * signing path. firestore.rules keep those fields and that status transition server-owned. The check-then-record
 * core is paper-cert-logic.js. See documentation/projects/PAPER-CERT-SIGNERS-2026-11-18.md.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { callableRateLimit, assertNotViewer } = require('./shared');
const { attestWetSigned, RefusalError } = require('./paper-cert-logic');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

exports.attestWetSigned = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    assertNotViewer(request.auth.token);
    await callableRateLimit(request, 'attestWetSigned', 20, 60_000);
    try {
      const db = getFirestore();
      const DE = require('./doc-evidence');
      return await attestWetSigned(db, { uid, token: request.auth.token || {} }, request.data, Object.assign({
        // A flag read that fails is a retryable refusal, never "off".
        flagOn: () => DE.clauseFlagForGate(db, uid, HttpsError),
        toTimestamp: (ms) => Timestamp.fromMillis(ms),
        readBytes: async (p, max) => {
          const f = getStorage().bucket().file(p);
          const [md] = await f.getMetadata();
          if (Number(md && md.size) > max) { const er = new Error('over the read cap'); er.code = 'too_large'; throw er; }
          const [buf] = await f.download();
          return buf;
        },
        // Storage metadata of the uploaded file (null = no such object). Size, content type and the object's own hash are recorded.
        statFile: async (p) => {
          try {
            const [md] = await getStorage().bucket().file(p).getMetadata();
            return md ? { size: Number(md.size), contentType: md.contentType, md5Hash: md.md5Hash } : null;
          } catch (e) { if (e && (e.code === 404 || e.code === 'ENOENT')) return null; throw e; }
        },
        fileSigned: (d, info) => require('./job-spine').spineAfterWetSign(d, info),
      }, { facts: DE.requestFacts(request.rawRequest) }));
    } catch (e) {
      if (e instanceof RefusalError) throw new HttpsError(e.code, e.message);
      if (e instanceof HttpsError) throw e;
      logger.warn('[attestWetSigned] failed', { uid, err: e && e.message });
      throw new HttpsError('internal', 'Could not certify the paper copy');
    }
  }
);

exports._test = require('./paper-cert-logic');
