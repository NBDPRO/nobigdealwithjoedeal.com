/**
 * functions/shared.js — authorization + rate-limit helpers shared
 * across index.js, portal.js, stripe.js (incoming), and the
 * integration modules.
 *
 * Before this module landed, two patterns had silently drifted into
 * duplicate copies:
 *
 *   - `callableRateLimit`: inlined in functions/index.js (L45-57)
 *     AND functions/portal.js (L55-67). L-03 created the second
 *     copy when portal.js peeled off — a deliberate short-term
 *     duplication flagged in that commit's body. This module
 *     closes the loop.
 *
 *   - `requirePaidSubscription`: defined in functions/sms-functions.js
 *     (L149-172) as part of C-02, with a parallel ad-hoc version
 *     inlined in `claudeProxy` (index.js:152-159). Any future
 *     endpoint that bills the caller should read from one place.
 *
 * Design rules:
 *   1. Zero side effects at module load — all helpers are pure or
 *      lazy. This module is safe to require from the smoke-test
 *      harness with no Firebase runtime.
 *   2. Accepts BOTH shapes. onCall callers pass `request.auth.token`
 *      as the claims object; onRequest callers pass the decoded
 *      Bearer token (`await getAuth().verifyIdToken()`). The
 *      fields we consult (`role`, `companyId`, `email_verified`,
 *      `uid`) exist on both — accept either.
 *   3. Never throw `HttpsError` from a helper used by onRequest
 *      handlers; those callers need a `{status, error}` return so
 *      they can `res.status().json()`. Helpers used exclusively
 *      from onCall can throw HttpsError directly.
 */

'use strict';

// ─── Rate-limit adapter (Upstash → Firestore fallback) ──────
// R-01 adapter; no-op when Upstash isn't configured.
const { enforceRateLimit } = require('./integrations/upstash-ratelimit');

// firebase-admin Auth is lazy-loaded for the same reason HttpsError is:
// the smoke-test harness doesn't have firebase-admin on its require
// path for shared.js's sibling modules. Modular getAuth() — firebase-admin
// v14-ready; the legacy admin.auth() accessor is gone.
let _adminAuth;
function getAdminAuth() {
  if (_adminAuth) return _adminAuth;
  _adminAuth = require('firebase-admin/auth').getAuth();
  return _adminAuth;
}

// ─── HttpsError lazy-loaded ─────────────────────────────────
// Avoid forcing the full firebase-functions runtime on callers that
// only need requirePaidSubscription (an onRequest helper).
let _HttpsError;
function HttpsError() {
  if (_HttpsError) return _HttpsError;
  _HttpsError = require('firebase-functions/v2/https').HttpsError;
  return _HttpsError;
}

// ═════════════════════════════════════════════════════════════
// callableRateLimit — per-uid bucket for onCall handlers.
//
// Throws HttpsError('resource-exhausted') on overrun. Silently
// no-ops for unauthenticated callers (they can't have hit a
// callable anyway; the handler's own auth check will reject them).
//
// Usage:
//   await callableRateLimit(request, 'createPortalToken', 30, 60_000);
//
// Canonical key shape: `callable:<name>:uid` — matches the Upstash
// + Firestore limiter namespaces already in use, so rollouts don't
// reset in-flight counters.
// ═════════════════════════════════════════════════════════════
async function callableRateLimit(request, name, limit, windowMs) {
  const uid = request.auth && request.auth.uid;
  if (!uid) return;
  try {
    await enforceRateLimit('callable:' + name + ':uid', uid, limit, windowMs);
  } catch (e) {
    if (e.rateLimited) {
      throw new (HttpsError())('resource-exhausted',
        'Rate limit exceeded — try again in ' + Math.ceil(windowMs / 1000) + 's');
    }
    throw e;
  }
}

// ═════════════════════════════════════════════════════════════
// requirePaidSubscription — billing gate for billable endpoints.
//
// Accepts the decoded Bearer-token shape (onRequest) OR an onCall
// `request.auth.token` object — both carry `role`, `email_verified`,
// and `uid` (on the token directly in onRequest; on the parent
// `request.auth.uid` in onCall — callers pass `{uid, role,
// email_verified}` explicitly if they prefer).
//
// Returns `{ok: true, plan}` on success or
// `{ok: false, status, error}` on any failure. The onRequest caller
// writes `res.status(status).json({error})`. The onCall caller can
// translate to HttpsError (not done automatically — status codes
// don't map cleanly).
//
// Admin is exempt. Fresh email_verified signal is required before
// any billable action (so email-squatters on legitimate addresses
// can't spend budget on those addresses' behalf).
// ═════════════════════════════════════════════════════════════
async function requirePaidSubscription(db, decoded) {
  if (!decoded || typeof decoded !== 'object') {
    return { ok: false, status: 401, error: 'Sign in required.' };
  }
  if (decoded.role === 'admin') return { ok: true, plan: 'admin' };
  if (decoded.email_verified !== true) {
    return {
      ok: false,
      status: 403,
      error: 'Verify your email before using billable features.',
    };
  }
  const uid = decoded.uid;
  if (!uid) return { ok: false, status: 401, error: 'Sign in required.' };
  // Billing key = the COMPANY (companyId claim), not the caller. An invited
  // rep's own uid has no subscriptions doc, so keying on uid gated every rep
  // of a paying tenant as free — a stranger-tenant blocker, same class as the
  // #945 stripe.js / #946 AI-gate fixes. Falls back to uid for a solo owner
  // whose companyId claim == uid. 'trialing' counts as paid: a Growth trial is
  // exactly the window billable features must work (parity with the AI gate).
  const billingKey = decoded.companyId || uid;
  const snap = await db.doc('subscriptions/' + billingKey).get();
  const sub = snap.exists ? snap.data() : null;
  const active = sub
    && (sub.status === 'active' || sub.status === 'trialing')
    && sub.plan
    && sub.plan !== 'free';
  if (!active) {
    return {
      ok: false,
      status: 402,
      error: 'An active paid subscription is required.',
    };
  }
  return { ok: true, plan: sub.plan };
}

// ═════════════════════════════════════════════════════════════
// requireAuth — Bearer-token verification for onRequest handlers.
//
// The onRequest equivalent of the onCall `request.auth.*` surface.
// Returns one of:
//   { decoded }                            — token is valid
//   { error: { status, body: { error } } } — caller should write
//     `res.status(error.status).json(error.body)` and return.
//
// Options:
//   adminOnly: true  — additionally requires `decoded.role === 'admin'`
//                      (returns 403 otherwise). Default false.
//
// `checkRevoked: true` is passed to verifyIdToken so a user whose
// refresh tokens were revoked (H-02 demo flip, GDPR erasure auth
// disable, admin-MFA lockout) can't replay an old token.
// ═════════════════════════════════════════════════════════════
async function requireAuth(req, { adminOnly = false } = {}) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) {
    return { error: { status: 401, body: { error: 'Missing authorization token' } } };
  }
  let decoded;
  try {
    decoded = await getAdminAuth().verifyIdToken(idToken, true);
  } catch (e) {
    if (e.code === 'auth/id-token-expired') {
      return { error: { status: 401, body: { error: 'Token expired — please re-authenticate' } } };
    }
    return { error: { status: 401, body: { error: 'Invalid token' } } };
  }
  if (adminOnly && decoded.role !== 'admin') {
    return { error: { status: 403, body: { error: 'Admin access required' } } };
  }
  return { decoded };
}

// ═════════════════════════════════════════════════════════════
// View-only role guard — assertNotViewer (onCall) / viewOnlyRefusal
// (onRequest). Added 2026-09-25.
//
// WHY: Jo's decision B (2026-09-25, final) — "The 'viewer' role is
// READ-ONLY everywhere: a viewer can read what their company role
// allows but cannot create, update or delete any tenant data —
// including rows under leads they own." firestore.rules and
// storage.rules enforce that for client writes (#1776, notViewer()),
// but a Cloud Function writes with the Admin SDK, which bypasses the
// rules, and most callables checked ownership only — so a viewer's
// browser could still write, text a homeowner, mint a portal / share /
// sign link or order a paid measurement through them. Every callable
// and HTTP function that creates, updates or deletes tenant data,
// sends to a homeowner or third party, mints a token or link, or
// places a paid order now calls one of these at the top of its
// handler. The full sweep (every exported function, with its verdict)
// is documentation/audit/VIEWER-CALLABLES-2026-09-25.md and
// tests/viewer-callables.test.js, which fails on an unclassified one.
//
// Only a POSITIVE role === 'viewer' claim is refused — the same
// expression as the rules' notViewer(). A solo operator carries no
// role claim and must stay allowed; every other role is untouched.
// Accepts either claims shape (design rule 2): onCall passes
// `request.auth.token`, onRequest the decoded Bearer token.
// ═════════════════════════════════════════════════════════════
const VIEW_ONLY_MESSAGE = 'Your role is view-only';

function isViewOnlyRole(claims) {
  return !!claims && typeof claims === 'object' && claims.role === 'viewer';
}

// onCall: throws HttpsError('permission-denied', 'Your role is view-only').
function assertNotViewer(claims) {
  if (isViewOnlyRole(claims)) {
    throw new (HttpsError())('permission-denied', VIEW_ONLY_MESSAGE);
  }
}

// onRequest (design rule 3 — never throw HttpsError at an HTTP handler):
// returns null, or { status: 403, body } for the caller to write with
// `res.status(r.status).json(r.body)` and return — requireAuth's shape.
function viewOnlyRefusal(decoded) {
  if (!isViewOnlyRole(decoded)) return null;
  return { status: 403, body: { error: VIEW_ONLY_MESSAGE, code: 'view-only' } };
}

module.exports = {
  callableRateLimit,
  requirePaidSubscription,
  requireAuth,
  VIEW_ONLY_MESSAGE,
  isViewOnlyRole,
  assertNotViewer,
  viewOnlyRefusal,
};
