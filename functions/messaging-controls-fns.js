/**
 * functions/messaging-controls-fns.js — the owner's handle on the master kill switch
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   manageMessagingControls (onCall, App Check enforced) — { action, ... }
 *
 *     get                         → { controls, automations, internal }
 *     set { patch, reason }       → { ok, controls }
 *         patch: any of customerSendsEnabled, smsEnabled, emailEnabled,
 *         otpEnabled, canary — booleans only. `reason` (3-300 chars) is
 *         required for EVERY change.
 *     setAutomations { patch, reason } → { ok, automations }
 *         patch: any of the MC.AUTOMATION_KEYS (boolean) and maxPerRun (whole
 *         number 0-50). Each AUTOMATED customer send needs its own entry
 *         === true here AND its env flag AND the global switch.
 *     setInternal { patch, reason } → { ok, internal }
 *         patch: internalAlertsEnabled (boolean), ownerPhone, ownerEmail
 *         (canary copies and internal alerts go there; never logged in full).
 *
 * JO ONLY: the caller must be NBD's owner (uid === NBD_OWNER_UID).
 *
 * AUDIT FIRST: an `intent` row (who, why, before, patch) is written to
 * messaging_controls_audit BEFORE the flip, and the flip does not happen if that
 * write fails; the row is completed with the `after` state afterwards. (A flip
 * made directly in the Firebase console bypasses this callable and is NOT
 * audited here: Firestore's own audit logs are the only record of that.)
 *
 * RECENT SIGN-IN: turning customer sends ON (any switch to true, canary to
 * false, an automation to true) and every change to the owner contact needs a
 * sign-in within RECENT_LOGIN_MS (token auth_time), so a stolen idle session
 * cannot open the gates or re-aim the alerts. Turning things OFF never needs it.
 * A change of owner phone/email queues a notice to the PREVIOUS owner email.
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
const RECENT_LOGIN_MS = 15 * 60 * 1000;

function maskPhone(p) { const d = String(p || '').replace(/\D/g, ''); return d ? '***' + d.slice(-2) : ''; }

function assertOwner(request) {
  const auth = request.auth;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  if (auth.uid !== TextingGate.NBD_OWNER_UID) {
    throw new HttpsError('permission-denied', 'Only the owner can change messaging controls');
  }
  return auth;
}

function assertRecentLogin(auth, nowMs) {
  const t = auth && auth.token && Number(auth.token.auth_time);
  if (!Number.isFinite(t) || t <= 0 || (nowMs != null ? nowMs : Date.now()) - t * 1000 > RECENT_LOGIN_MS) {
    throw new HttpsError('failed-precondition', 'Sign in again (within the last 15 minutes) to turn customer messaging on or change the owner contact.');
  }
}

function reasonOf(data) {
  const r = typeof data.reason === 'string' ? data.reason.trim() : '';
  if (r.length < 3) throw new HttpsError('invalid-argument', 'Add a short reason for the change (it is saved in the audit log)');
  if (r.length > 300) throw new HttpsError('invalid-argument', 'Keep the reason under 300 characters');
  return r;
}

/** Write the intent row FIRST. Throws (so the caller does not flip) if it cannot be written. */
async function auditFirst(db, entry) {
  const ref = db.collection(MC.AUDIT_COLLECTION).doc();
  try {
    await ref.set(Object.assign({}, entry, { status: 'intent', at: FieldValue.serverTimestamp() }));
  } catch (e) {
    logger.error('messaging_controls_audit_failed', { err: e && e.message });
    throw new HttpsError('unavailable', 'Could not write the audit log, so nothing was changed. Try again.');
  }
  return ref;
}
async function auditDone(ref, after) {
  try { await ref.set({ status: 'applied', after, appliedAt: FieldValue.serverTimestamp() }, { merge: true }); }
  catch (e) { logger.error('messaging_controls_audit_complete_failed', { err: e && e.message }); }
}

function pick(c) {
  return { customerSendsEnabled: c.customerSendsEnabled, smsEnabled: c.smsEnabled, emailEnabled: c.emailEnabled, otpEnabled: c.otpEnabled, canary: c.canary };
}
function internalView(o) {
  return { internalAlertsEnabled: o.internalAlertsEnabled, ownerPhoneSet: !!o.phone, ownerPhone: maskPhone(o.phone), ownerEmailSet: !!o.email };
}

async function handleManageMessagingControls(request) {
  const auth = assertOwner(request);
  const data = request.data || {};
  const action = typeof data.action === 'string' ? data.action : '';
  const db = getFirestore();
  const nowMs = Date.now();

  if (action === 'get') {
    const controls = await MC.readControls(db, { force: true });
    const owner = await MC.readOwnerContact(db, { force: true });
    const automations = await MC.readAutomations(db, { force: true });
    return {
      controls,
      automations: { flags: automations.flags, maxPerRun: automations.maxPerRun },
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
    const opensSends = CONTROL_FIELDS.some((k) => k !== 'canary' && next[k] === true) || next.canary === false;
    if (opensSends) assertRecentLogin(auth, nowMs);
    const before = await MC.readControls(db, { force: true });
    const ref = await auditFirst(db, { kind: 'controls', byUid: auth.uid, reason, patch: next, before: pick(before) });
    await db.doc(MC.GLOBAL_DOC).set(Object.assign({}, next, { updatedAt: FieldValue.serverTimestamp(), updatedBy: auth.uid }), { merge: true });
    MC._resetCache();
    const after = await MC.readControls(db, { force: true });
    await auditDone(ref, pick(after));
    logger.info('messaging_controls_changed', { byUid: auth.uid, patch: next, before: pick(before), after: pick(after), reason });
    return { ok: true, controls: after };
  }

  if (action === 'setAutomations') {
    const reason = reasonOf(data);
    const patch = data.patch && typeof data.patch === 'object' ? data.patch : {};
    const next = {};
    for (const k of Object.keys(patch)) {
      if (k === 'maxPerRun') {
        const n = patch[k];
        if (!Number.isInteger(n) || n < 0 || n > 50) throw new HttpsError('invalid-argument', 'maxPerRun must be a whole number from 0 to 50');
        next.maxPerRun = n;
      } else if (MC.AUTOMATION_KEYS.indexOf(k) !== -1) {
        if (typeof patch[k] !== 'boolean') throw new HttpsError('invalid-argument', k + ' must be true or false');
        next[k] = patch[k];
      } else {
        throw new HttpsError('invalid-argument', 'Unknown automation: ' + k);
      }
    }
    if (Object.keys(next).length === 0) throw new HttpsError('invalid-argument', 'Nothing to change');
    if (Object.keys(next).some((k) => next[k] === true) || (Number.isInteger(next.maxPerRun) && next.maxPerRun > 0)) assertRecentLogin(auth, nowMs);
    const before = await MC.readAutomations(db, { force: true });
    const ref = await auditFirst(db, { kind: 'automations', byUid: auth.uid, reason, patch: next, before: { flags: before.flags, maxPerRun: before.maxPerRun } });
    await db.doc(MC.AUTOMATIONS_DOC).set(Object.assign({}, next, { updatedAt: FieldValue.serverTimestamp(), updatedBy: auth.uid }), { merge: true });
    MC._resetCache();
    const after = await MC.readAutomations(db, { force: true });
    await auditDone(ref, { flags: after.flags, maxPerRun: after.maxPerRun });
    logger.info('messaging_automations_changed', { byUid: auth.uid, patch: next, before: before.flags, after: after.flags, reason });
    return { ok: true, automations: { flags: after.flags, maxPerRun: after.maxPerRun } };
  }

  if (action === 'setInternal') {
    const reason = reasonOf(data);
    assertRecentLogin(auth, nowMs);
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
    const beforeOwner = await MC.readOwnerContact(db, { force: true });
    // Never write the phone / email themselves into the audit log or app log.
    const shown = {};
    if ('internalAlertsEnabled' in next) shown.internalAlertsEnabled = next.internalAlertsEnabled;
    if (next.ownerPhone) shown.ownerPhone = maskPhone(next.ownerPhone);
    if (next.ownerEmail) shown.ownerEmail = '(set)';
    const ref = await auditFirst(db, { kind: 'internal', byUid: auth.uid, reason, patch: shown, before: internalView(beforeOwner) });
    await db.doc(MC.INTERNAL_DOC).set(Object.assign({}, next, { updatedAt: FieldValue.serverTimestamp(), updatedBy: auth.uid }), { merge: true });
    MC._resetCache();
    const owner = await MC.readOwnerContact(db, { force: true });
    await auditDone(ref, internalView(owner));
    logger.info('messaging_internal_changed', { byUid: auth.uid, patch: shown, before: internalView(beforeOwner), after: internalView(owner), reason });
    // Tell the PREVIOUS owner address that the alert/canary contact changed (queued; the email worker sends it).
    if ((next.ownerPhone || next.ownerEmail) && beforeOwner.email) {
      try {
        await db.collection('email_queue').add({
          to: beforeOwner.email, status: 'pending', source: 'messaging-controls-contact-change',
          subject: 'NBD messaging: the owner alert contact was changed',
          bodyPlain: 'The owner phone/email used for NBD lead alerts and canary test copies was changed by ' + auth.uid + ' (reason: ' + reason + ').\n\n'
            + 'If this was not you: in the Firebase console set messaging_controls/global.customerSendsEnabled to false and review messaging_controls_audit.',
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (e) { logger.error('messaging_contact_change_notice_failed', { err: e && e.message }); }
    }
    return { ok: true, internal: internalView(owner) };
  }

  throw new HttpsError('invalid-argument', 'Unknown action');
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

exports._test = { handleManageMessagingControls, CONTROL_FIELDS, RECENT_LOGIN_MS };
