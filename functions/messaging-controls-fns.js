/**
 * functions/messaging-controls-fns.js — the owner's handle on the master kill switch
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   manageMessagingControls (onCall, App Check enforced) — { action, ... }
 *
 *     get                         → { controls, internal }
 *     set { patch, reason }       → { ok, controls }
 *         patch: any of customerSendsEnabled, smsEnabled, emailEnabled,
 *         otpEnabled, canary — booleans only. `reason` (3-300 chars) is
 *         required for EVERY change and is written, with who / when / before /
 *         after, to messaging_controls_audit (append-only; no client access).
 *     setInternal { patch, reason } → { ok, internal }
 *         patch: internalAlertsEnabled (boolean), ownerPhone, ownerEmail
 *         (canary copies and internal alerts go there; never logged in full).
 *
 * JO ONLY: the caller must be NBD's owner (uid === NBD_OWNER_UID). Not "any
 * company admin": the customer kill switch is the platform's, and the NBD
 * tenant's office staff do not get to turn customer sends back on.
 *
 * The docs are written ONLY here (firestore.rules denies every client).
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const MC = require('./messaging-controls');
const TextingGate = require('./sms-texting-gate');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

const CONTROL_FIELDS = Object.freeze(['customerSendsEnabled', 'smsEnabled', 'emailEnabled', 'otpEnabled', 'canary']);

function maskPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d ? '***' + d.slice(-2) : ''; }

function assertOwner(request) {
  const auth = request.auth;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  if (auth.uid !== TextingGate.NBD_OWNER_UID) {
    throw new HttpsError('permission-denied', 'Only the owner can change messaging controls');
  }
  return auth;
}

function reasonOf(data) {
  const r = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (r.length < 3) throw new HttpsError('invalid-argument', 'Add a short reason for the change (it is saved in the audit log)');
  if (r.length > 300) throw new HttpsError('invalid-argument', 'Keep the reason under 300 characters');
  return r;
}

async function audit(db, entry) {
  await db.collection(MC.AUDIT_COLLECTION).add(Object.assign({}, entry, { at: FieldValue.serverTimestamp() }));
}

async function handleManageMessagingControls(request) {
  const auth = assertOwner(request);
  const data = request.data || {};
  const action = typeof data.action === 'string' ? data.action : '';
  const db = getFirestore();

  if (action === 'get') {
    const controls = await MC.readControls(db, { force: true });
    const owner = await MC.readOwnerContact(db, { force: true });
    return {
      controls,
      internal: { internalAlertsEnabled: owner.internalAlertsEnabled, ownerPhoneSet: !!owner.phone, ownerEmailSet: !!owner.email },
    };
  }

  if (action === 'set') {
    const reason = reasonOf(data);
    const patch = data.patch && typeof data.patch === 'object' ? data.patch : {};
    const next = {};
    for (const k of Object.keys(patch)) {
      if (CONTROL_FIELDS.indexOf(k) === -1) throw new HttpsError('invalid-argument', 'Unknown control: ' + k);
      if (typeof patch[k] !== 'boolean') throw new HttpsError('invalid-argument', k + ' must be true or false');
      next[k] = patch[k];
    }
    if (Object.keys(next).length === 0) throw new HttpsError('invalid-argument', 'Nothing to change');
    const before = await MC.readControls(db, { force: true });
    await db.doc(MC.GLOBAL_DOC).set(Object.assign({}, next, { updatedAt: FieldValue.serverTimestamp(), updatedBy: auth.uid }), { merge: true });
    MC._resetCache();
    const after = await MC.readControls(db, { force: true });
    await audit(db, { kind: 'controls', byUid: auth.uid, reason, patch: next, before: pick(before), after: pick(after) });
    logger.info('messaging_controls_changed', { byUid: auth.uid, patch: next, reason });
    return { ok: true, controls: after };
  }

  if (action === 'setInternal') {
    const reason = reasonOf(data);
    const patch = data.patch && typeof data.patch === 'object' ? data.patch : {};
    const next = {};
    if ('internalAlertsEnabled' in patch) {
      if (typeof patch.internalAlertsEnabled !== 'boolean') throw new HttpsError('invalid-argument', 'internalAlertsEnabled must be true or false');
      next.internalAlertsEnabled = patch.internalAlertsEnabled;
    }
    if ('ownerPhone' in patch) {
      const p = MC.normPhone(patch.ownerPhone);
      if (!p) throw new HttpsError('invalid-argument', 'ownerPhone must be a 10-digit US number');
      next.ownerPhone = p;
    }
    if ('ownerEmail' in patch) {
      const e = MC.normEmail(patch.ownerEmail);
      if (!e) throw new HttpsError('invalid-argument', 'ownerEmail is not a valid address');
      next.ownerEmail = e;
    }
    if (Object.keys(next).length === 0) throw new HttpsError('invalid-argument', 'Nothing to change');
    await db.doc(MC.INTERNAL_DOC).set(Object.assign({}, next, { updatedAt: FieldValue.serverTimestamp(), updatedBy: auth.uid }), { merge: true });
    MC._resetCache();
    // Never write the phone / email themselves into the audit log or app log.
    const shown = {};
    if ('internalAlertsEnabled' in next) shown.internalAlertsEnabled = next.internalAlertsEnabled;
    if (next.ownerPhone) shown.ownerPhone = maskPhone(next.ownerPhone);
    if (next.ownerEmail) shown.ownerEmail = '(set)';
    await audit(db, { kind: 'internal', byUid: auth.uid, reason, patch: shown });
    logger.info('messaging_internal_changed', { byUid: auth.uid, patch: shown, reason });
    const owner = await MC.readOwnerContact(db, { force: true });
    return { ok: true, internal: { internalAlertsEnabled: owner.internalAlertsEnabled, ownerPhoneSet: !!owner.phone, ownerEmailSet: !!owner.email } };
  }

  throw new HttpsError('invalid-argument', 'Unknown action');
}

function pick(c) {
  return { customerSendsEnabled: c.customerSendsEnabled, smsEnabled: c.smsEnabled, emailEnabled: c.emailEnabled, otpEnabled: c.otpEnabled, canary: c.canary };
}

exports.manageMessagingControls = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 15,
    memory: '256MiB', // never below 256MiB: a 128MiB gen2 fails its startup healthcheck
  },
  handleManageMessagingControls
);

exports._test = { handleManageMessagingControls, CONTROL_FIELDS };
