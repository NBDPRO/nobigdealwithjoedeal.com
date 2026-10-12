/**
 * functions/sms-dnc.js — the CRM's handle on a company's texting compliance
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   manageSmsCompliance (onCall, App Check enforced) — { action, ... }
 *
 *     listDnc                 → { entries: [{ key, phone, source, addedAtMs, note,
 *                                  stopLine, liftable, liftBlock, lifted,
 *                                  liftedAtMs, liftReason }] }
 *         Any member of the company (a viewer may read the list).
 *     addDnc    { phone, note? } → { ok, created }
 *         Any member except a viewer / access-code member: "they asked us not
 *         to text them" is something a rep has to be able to record. Re-adding
 *         a lifted number puts it back in force.
 *     liftDnc   { phone, reason } → { ok, result: 'lifted'|'absent'|'not_liftable',
 *                                     why?, stillBlocked? }
 *         Owner or company_admin only (requireTeamAdmin), reason required
 *         (Jo, 2026-10-07): the homeowner said texting is OK again. The entry
 *         is marked lifted with who / when / why and kept, never deleted
 *         (sms-optout.js liftDnc). Only the company's OWN entries lift: a
 *         manual add, or a STOP it recorded from its own phone. A STOP the
 *         homeowner texted to NBD's number never lifts here — only their
 *         START reply does. `removeDnc` is the old name for this action.
 *
 *     getSettings             → { allowed, reason, registered, enabled, needsRegistration }
 *         Any member. The company's texting master switch.
 *     setEnabled { enabled }  → { ok, allowed, ... }
 *         Owner or company_admin. OFF is always allowed; ON only once the
 *         company is registered (NBD is; `registered` is admin-SDK only and
 *         this callable never writes it).
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

  // 'removeDnc' is the pre-2026-10-07 name. It no longer deletes anything:
  // an entry is LIFTED with a reason and its history kept (Jo, 2026-10-07),
  // so an old cached page's Remove (no reason) is refused, not obeyed.
  if (action === 'liftDnc' || action === 'removeDnc') {
    // Owner or company_admin of the caller's own company — server-enforced;
    // a rep or viewer is refused here whatever the page shows.
    const admin = await requireTeamAdmin(request);
    const phone = phoneArg(data);
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    if (!reason) {
      throw new HttpsError('invalid-argument', 'Add a reason: what the homeowner said, and when (reload the page if you see no reason box).');
    }
    if (reason.length > 300) throw new HttpsError('invalid-argument', 'Keep the reason under 300 characters');
    const role = admin && admin.isOwner ? 'owner' : (caller.role || 'owner');
    const r = await OptOut.liftDnc(db, {
      companyId: caller.companyId, phone, byUid: caller.uid, role, reason,
      serverTimestamp: () => FieldValue.serverTimestamp(),
    });
    logger.info('sms_dnc_lift', { companyId: caller.companyId, result: r.result, why: r.why || null, role });
    if (r.result !== 'lifted') return { ok: false, result: r.result, why: r.why || null };
    // Lifting this company's entry does not lift a STOP the homeowner texted
    // to NBD's number (the global register): say so rather than imply the
    // number is textable.
    let stillBlocked = null;
    try {
      const after = await OptOut.isOptedOut(db, phone, { companyId: caller.companyId });
      if (after.optedOut) stillBlocked = after.source === 'register' ? 'stop_reply_line' : (after.source || 'unknown');
    } catch (_) { stillBlocked = 'unknown'; }
    return { ok: true, result: 'lifted', stillBlocked };
  }

  // ── The master switch (sms-texting-gate.js) ──
  if (action === 'getSettings') {
    const s = await TextingGate.textingStatus(db, caller.companyId);
    return {
      allowed: s.allowed, reason: s.reason, registered: s.registered, enabled: s.enabled,
      // The CRM shows "needs registration — coming soon" from this.
      needsRegistration: !s.registered,
    };
  }

  if (action === 'setEnabled') {
    // Owner or company_admin of the caller's own company.
    await requireTeamAdmin(request);
    if (typeof data.enabled !== 'boolean') throw new HttpsError('invalid-argument', 'enabled must be true or false');
    const s = await TextingGate.textingStatus(db, caller.companyId);
    // Turning OFF is always allowed. Turning ON cannot get past registration:
    // `registered` is admin-SDK only and this callable never writes it.
    if (data.enabled && !s.registered) {
      throw new HttpsError('failed-precondition', 'Texting needs registration for your company — coming soon.');
    }
    await db.doc(TextingGate.SETTINGS_COLLECTION + '/' + caller.companyId).set({
      enabled: data.enabled,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: caller.uid,
    }, { merge: true });
    logger.info('sms_texting_switch', { companyId: caller.companyId, enabled: data.enabled });
    const after = await TextingGate.textingStatus(db, caller.companyId);
    return { ok: true, allowed: after.allowed, reason: after.reason, registered: after.registered, enabled: after.enabled };
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
