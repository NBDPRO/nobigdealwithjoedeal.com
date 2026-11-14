/**
 * functions/ai-gate.js — who may spend NBD's AI keys (2026-11-14).
 *
 * Every AI call in NBD Pro is billed to NBD's own Anthropic / Groq /
 * Replicate keys. Joe's rule (2026-11-14): free accounts get NO AI. Every AI
 * feature needs a paid plan AND a confirmed email. Exempt:
 *   - the platform admin (role 'admin'), and
 *   - the platform tenant (NBD's own uid / company, NBD_OWNER_UID), which
 *     may have no Stripe subscription, so Joe can't lock himself out.
 * Every other tenant follows the plan rule; there is no per-tenant exception.
 *
 * This is the same rule claudeProxy, adminAI (#3039), leadBrief, callBrief
 * and coachLine already apply, in one place for the endpoints that lacked it.
 *
 *   aiEntitlement(db, claims, uid)   → { ok: true } | { ok: false, reason }
 *     claims: a decoded ID token / request.auth.token (role, companyId,
 *     email_verified). reason: 'unverified' | 'plan' | 'plan_check_failed'.
 *   aiEntitlementForUid(db, uid, { getUser }) → same, for triggers that only
 *     know the uploader's uid: claims come from the Auth record.
 *   assertAiEntitled(db, auth)       → throws HttpsError for onCall handlers.
 *
 * A failed plan read fails CLOSED (no AI), never open.
 */
'use strict';

const PLATFORM_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

const MESSAGES = {
  unverified: 'Confirm your email address to use AI features.',
  plan: 'AI features are part of the paid plans. Upgrade to use them.',
  plan_check_failed: 'Could not check your plan. Try again shortly.',
};

function isPaidSubscription(s, nowMs) {
  if (!(s && s.plan && s.plan !== 'free' && (s.status === 'active' || s.status === 'trialing'))) return false;
  // An access-code trial past its trialEndsAt is free (billing.js reads it
  // the same way; nothing ever downgrades the doc itself).
  if (s.source === 'access_code' && s.trialEndsAt && typeof s.trialEndsAt.toMillis === 'function'
    && s.trialEndsAt.toMillis() < (nowMs || Date.now())) return false;
  return true;
}

async function aiEntitlement(db, claims, uid) {
  const t = claims || {};
  const id = uid || t.uid || t.user_id || '';
  if (t.role === 'admin') return { ok: true, exempt: 'platform_admin' };
  if (id === PLATFORM_UID || t.companyId === PLATFORM_UID) return { ok: true, exempt: 'platform_tenant' };
  if (t.email_verified !== true) return { ok: false, reason: 'unverified' };
  const billingId = t.companyId || id;
  if (!billingId) return { ok: false, reason: 'plan' };
  let snap;
  try {
    snap = await db.doc('subscriptions/' + billingId).get();
  } catch (_) {
    return { ok: false, reason: 'plan_check_failed' };
  }
  return isPaidSubscription(snap && snap.exists ? snap.data() : null) ? { ok: true } : { ok: false, reason: 'plan' };
}

// Triggers (Storage / Firestore) have no ID token: read the uploader's Auth
// record, as callBriefAuto does. A failed lookup fails closed.
async function aiEntitlementForUid(db, uid, opts) {
  if (!uid) return { ok: false, reason: 'plan' };
  const getUser = (opts && opts.getUser) || ((u) => require('firebase-admin/auth').getAuth().getUser(u));
  let rec;
  try {
    rec = await getUser(uid);
  } catch (_) {
    return { ok: false, reason: 'plan_check_failed' };
  }
  if (rec && rec.disabled === true) return { ok: false, reason: 'plan' }; // a deactivated account spends nothing
  const c = (rec && rec.customClaims) || {};
  return aiEntitlement(db, { role: c.role, companyId: c.companyId, email_verified: !!(rec && rec.emailVerified) }, uid);
}

async function assertAiEntitled(db, auth) {
  const { HttpsError } = require('firebase-functions/v2/https');
  const r = await aiEntitlement(db, auth && auth.token, auth && auth.uid);
  if (r.ok) return r;
  throw new HttpsError(r.reason === 'plan_check_failed' ? 'unavailable' : 'permission-denied', MESSAGES[r.reason]);
}

module.exports = { aiEntitlement, aiEntitlementForUid, assertAiEntitled, isPaidSubscription, MESSAGES, PLATFORM_UID };
