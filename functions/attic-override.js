/**
 * functions/attic-override.js - recordAtticOverride (phase 3, flag docAtticAckV1; Jo's decision Q18).
 *
 * If a homeowner will not sign the "not inspected" attic page, only the company owner or an admin may record
 * that the job proceeds anyway, with a required reason. The event (name, uid, time, reason) is written by this
 * callable only (attic_overrides is write:false in firestore.rules), so a rep cannot forge it. The form is
 * logged as notice, never as signed. See documentation/projects/ATTIC-ACK-V1-2026-11-18.md.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { callableRateLimit, assertNotViewer } = require('./shared');
const AG = require('./attic-gate');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

exports.recordAtticOverride = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    if (!(request.auth && request.auth.uid)) throw new HttpsError('unauthenticated', 'Sign in required');
    assertNotViewer(request.auth.token);
    await callableRateLimit(request, 'recordAtticOverride', 10, 60_000);
    const DE = require('./doc-evidence');
    const db = getFirestore();
    if (!(await DE.atticFlagForGate(db, request.auth.uid, HttpsError))) {
      throw new HttpsError('failed-precondition', 'The attic acknowledgment is not turned on for your account.');
    }
    return AG.recordOverride(db, { uid: request.auth.uid, token: request.auth.token || {} }, request.data, (code, msg) => new HttpsError(code, msg));
  }
);
