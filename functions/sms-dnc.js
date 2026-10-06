/**
 * functions/sms-dnc.js — the CRM's handle on a company's texting compliance
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   manageSmsCompliance (onCall, App Check enforced) — { action, ... }
 *
 *     listDnc                 → { entries: [{ key, phone, source, addedAtMs, note }] }
 *         Any member of the company (a viewer may read the list).
 *     addDnc    { phone, note? } → { ok, created }
 *         Any member except a viewer / access-code member: "they asked us not
 *         to text them" is something a rep has to be able to record.
 *     removeDnc { phone }       → { ok, result: 'removed'|'absent'|'stop_reply' }
 *         Owner or company_admin only (requireTeamAdmin). A 'stop_reply'
 *         entry never comes off this way: it is the homeowner's own STOP, and
 *         only their START reply lifts it.
 *
 * The list itself is sms_dnc/{companyId}__{key} (functions/sms-optout.js),
 * admin-SDK only — no client reads or writes it directly (firestore.rules).
 * It is ENFORCED in sms-optout.js isOptedOut, which every send path calls.
 *
 * The company is always the caller's own: claims.companyId, or a solo owner's
 * uid (the convention every SMS send uses — sms-texting-gate.js tenantKeyOf).
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const OptOut = require('./sms-optout');
const TextingGate = require('./sms-texting-gate');
const { requireTeamAdmin } = require('./handlers/_shared');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// Roles that may READ but never change anything (Jo's decision B, 2026-09-25)
// plus the access-code member role.
const READ_ONLY_ROLES = new Set(['viewer', 'member']);

function callerOf(request) {
  const auth = request.auth;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const token = auth.token || {};
  const role = typeof token.role === 'string' ? token.role.trim().toLowerCase() : '';
  const companyId = TextingGate.tenantKeyOf({ companyId: token.companyId, uid: auth.uid });
  return { uid: auth.uid, role, companyId };
}

function phoneArg(data) {
  const raw = data && typeof data.phone === 'string' ? data.phone : '';
  const key = OptOut.optOutKey(raw);
  if (!raw || raw.length > 40 || key.length !== 10) {
    throw new HttpsError('invalid-argument', 'Enter a 10-digit US phone number');
  }
  return raw.trim();
}

async function handleManageSmsCompliance(request) {
  const caller = callerOf(request);
  const data = request.data || {};
  const action = typeof data.action === 'string' ? data.action : '';
  const db = getFirestore();

  if (action === 'listDnc') {
    const entries = await OptOut.listDnc(db, caller.companyId, 500);
    return { entries };
  }

  if (action === 'addDnc') {
    if (READ_ONLY_ROLES.has(caller.role)) {
      throw new HttpsError('permission-denied', 'Your role is view-only');
    }
    const phone = phoneArg(data);
    const note = typeof data.note === 'string' ? data.note.trim().slice(0, 200) : '';
    const r = await OptOut.addDnc(db, {
      companyId: caller.companyId, phone, source: 'manual', byUid: caller.uid, note,
    }, () => FieldValue.serverTimestamp());
    logger.info('sms_dnc_add', { companyId: caller.companyId, created: r.created });
    return { ok: true, created: r.created };
  }

  if (action === 'removeDnc') {
    // Owner or company_admin of the caller's own company.
    await requireTeamAdmin(request);
    const phone = phoneArg(data);
    const result = await OptOut.removeDnc(db, caller.companyId, phone);
    logger.info('sms_dnc_remove', { companyId: caller.companyId, result });
    return { ok: result !== 'stop_reply', result };
  }

  throw new HttpsError('invalid-argument', 'Unknown action');
}

exports.manageSmsCompliance = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 15,
    memory: '256MiB', // never below 256MiB: a 128MiB gen2 fails its startup healthcheck
  },
  handleManageSmsCompliance
);

exports._test = { handleManageSmsCompliance };
