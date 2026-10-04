/**
 * functions/rate-limit-policy.js — declarative per-route rate-limit policy.
 *
 * Why this exists
 * ───────────────
 * Each Cloud Function used to call enforceRateLimit('scope', key, N,
 * window) inline at the top of its handler — sometimes per-uid only,
 * sometimes per-IP only, sometimes neither, occasionally with copy-
 * pasted limits that drifted from sibling endpoints. Net result was
 * a defense-in-depth gap: a handler with only per-uid limiting was
 * defenseless against a refresh-bot using fresh anonymous tokens; a
 * handler with only per-IP limiting let one corp NAT throttle every
 * legit user behind it.
 *
 * This module:
 *   1. Declares a single ROUTES table with the canonical limits for
 *      every onCall + onRequest function (per-uid AND per-IP for each).
 *   2. Exports two middleware wrappers:
 *        guardCallable(name)   — onCall handler wrapper
 *        guardHttp(name)       — onRequest handler wrapper
 *      Each enforces both per-uid (when authed) AND per-IP automatically,
 *      using the limits from ROUTES. Handlers stop hand-rolling the
 *      enforceRateLimit calls.
 *   3. Surfaces the ROUTES table to ops via getRateLimitMatrix() — no
 *      runtime consumer yet (2026-08-10: the smoke suite pins the table by
 *      source scan, not through this accessor; integrationStatus does not
 *      call it). Kept as the intended ops surface.
 *
 * If a handler is missing from ROUTES, the wrapper applies a SAFE
 * DEFAULT (60 req/min per IP, 300 req/min per uid) and logs a warning
 * so the gap shows up in Cloud Logging instead of going un-policed.
 *
 * Per-uid limits sit ABOVE per-IP limits on purpose: a single user
 * making heavy legit use shouldn't burn the IP budget for the rest of
 * an office or PWA cluster.
 */

'use strict';

// The same limiter entry point the handlers require (Firestore-backed since
// the unused Upstash adapter was removed 2026-10-04). Keep requiring it rather
// than ./rate-limit, so a future backend swap there covers these routes too.
const { enforceRateLimit, clientIp, hashKey } = require('./integrations/upstash-ratelimit');
// Pure key derivation (no I/O, provider-independent): buckets IPv6 callers by
// /64 prefix so one allocation can't rotate addresses past the cap. Same
// keying the hand-rolled gates in handlers/integrations.js use.
const { rateLimitIpKey } = require('./rate-limit');
let _logger;
function logger() {
  if (_logger) return _logger;
  try { _logger = require('firebase-functions/v2').logger; }
  catch (_) { _logger = { warn: (...a) => console.warn(...a), info: (...a) => console.log(...a), error: (...a) => console.error(...a) }; }
  return _logger;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR   = 60 * MINUTE;

/**
 * Per-route policy. Tune these by watching the rate_limit_denied
 * structured logs (the Cloud Monitoring alert in
 * monitoring/alert-rate-limit-spike.json fires when any single
 * namespace exceeds the baseline).
 *
 * Limits are intentionally generous — the goal is "drop a bot, not
 * a customer." A real signed-in user almost never hits these.
 */
const ROUTES = {
  // ── AI / token-burning surfaces (lowest ceilings, highest abuse risk).
  // (2026-08-07: dropped the vestigial `uid: 60 / MINUTE * MINUTE, ip: 20`
  //  keys — the expression was a no-op that read like a real limit; only the
  //  uidLimit/ipLimit shape is consumed.)
  //
  // claudeProxy is WIRED (2026-08-10 pilot): handlers/ai.js wraps the
  // handler in guardHttp('claudeProxy'); the uid ceiling below IS the prod
  // limit (formerly CLAUDE_PER_MIN_LIMIT=20 hand-rolled inline — same
  // namespace 'claudeProxy:uid', so live counters carried over). The ip
  // ceiling is the NEW backstop layer: 3× the uid limit so an office NAT of
  // heavy legit users never trips it before their individual uid limits do,
  // while a bot rotating fresh tokens from one allocation gets clamped.
  claudeProxy:        { uidLimit:  20, uidWindow: MINUTE, ipLimit:  60, ipWindow: MINUTE },
  // adminAI WIRED (2026-08-10): guardHttp('adminAI') in handlers/ai.js. uid
  // ceiling matches the old inline gate (60/hr); ip backstop is new. (The
  // old inline call keyed its scope on the uid, so counters start fresh.)
  adminAI:            { uidLimit:  60, uidWindow: HOUR,   ipLimit: 180, ipWindow: HOUR    },
  // RECORD-ONLY: hand-rolled in handlers/ai.js (httpRateLimit
  // 'publicVisualizerAI:ip', 5/HOUR). Synced 2026-08-10 — the old entry
  // here claimed 3/min (~36x looser per hour than the real gate).
  publicVisualizerAI: { uidLimit:   0, uidWindow: MINUTE, ipLimit:   5, ipWindow: HOUR   },

  // ── Auth / billing — fraud-adjacent, low burst legit need.
  // validateAccessCode is WIRED (2026-08-10 pilot): handlers/portal.js wraps
  // the handler in guardCallable('validateAccessCode'). The ip ceiling
  // matches the previous hand-rolled gate exactly (5 attempts / 5 min,
  // namespace 'validateAccessCode:ip' — counters carried over); the uid
  // layer is new defense-in-depth (callable may be invoked pre-auth, in
  // which case guardCallable skips it by design).
  // (resetSubscriptionByEmail entry deleted 2026-08-10: no such export
  //  exists anywhere in functions/ — it was a phantom route.)
  validateAccessCode: { uidLimit:  10, uidWindow: HOUR,    ipLimit:   5, ipWindow: 5*MINUTE },
  // revokeMySessions WIRED (2026-09-08): guardCallable('revokeMySessions')
  // in handlers/auth.js — the self-service "Sign Out Everywhere" path.
  // Burst need is genuinely one click: a user rotating credentials after a
  // suspected compromise presses it once, and each call is an Admin SDK
  // write, so the uid ceiling is tight. The ip ceiling is 4x the uid one on
  // purpose — a whole office rotating after a breach is the exact moment
  // this button matters most, and one NAT must not wedge the fifth person.
  revokeMySessions:   { uidLimit:   5, uidWindow: HOUR,    ipLimit:  20, ipWindow: HOUR     },

  // ── Public lead intake — stripped of auth, gate hard on IP.
  // submitPublicLead is NOT wrapper-wired on purpose: its hand-rolled gate in
  // handlers/integrations.js is richer than guardHttp — on limiter-backend
  // error it deliberately fails OPEN to the Firestore limiter rather than
  // dropping a legitimate lead, and it interleaves with Turnstile/honeypot.
  // This entry is the canonical RECORD of that gate's limits (kept in sync by
  // the smoke suite) so the ops matrix doesn't lie about the fleet.
  submitPublicLead:   { uidLimit:   0, uidWindow: MINUTE, ipLimit:  20, ipWindow: MINUTE },
  // RECORD-ONLY: hand-rolled in handlers/monitoring.js (60/min — synced
  // 2026-08-10; the old entry here claimed 100/min).
  cspReport:          { uidLimit:   0, uidWindow: MINUTE, ipLimit:  60, ipWindow: MINUTE },

  // ── Authenticated CRM — generous; legit reps make hundreds of writes/day.
  // RECORD-ONLY: hand-rolled in handlers/photo.js (300/min uid + 300/min ip
  // — synced 2026-08-10; the old entry here claimed 600/hr + 1500/hr).
  signImageUrl:       { uidLimit: 300, uidWindow: MINUTE, ipLimit: 300, ipWindow: MINUTE  },
  // (imageProxy entry deleted 2026-08-10: retired to a 410 stub in
  //  handlers/photo.js — no auth, no limiter, nothing to police.)
  // RECORD-ONLY, UNVERIFIED against handlers (no hand-rolled gate found for
  // setStorageCors / integrationStatus; getAdminAnalytics's real gate is
  // callableRateLimit 30/hr uid in handlers/admin.js). Wire these through
  // guardCallable/guardHttp or sync them in the next pilot increment.
  setStorageCors:     { uidLimit:  10, uidWindow: HOUR,   ipLimit:  20, ipWindow: HOUR    },
  integrationStatus:  { uidLimit: 120, uidWindow: HOUR,   ipLimit: 300, ipWindow: HOUR    },
  getAdminAnalytics:  { uidLimit:  30, uidWindow: HOUR,   ipLimit: 120, ipWindow: HOUR    },
  // getGoogleReviews WIRED (2026-08-10): guardHttp in google-reviews.js —
  // was the only public onRequest endpoint with NO limiter (billable Places
  // API behind a 6h cache). Anonymous widget → uid 0, per-IP only.
  getGoogleReviews:   { uidLimit:   0, uidWindow: MINUTE, ipLimit:  60, ipWindow: MINUTE  },

  // ── Migration runner — admin-only, runs rarely.
  runMigrations:      { uidLimit:  10, uidWindow: HOUR,   ipLimit:  10, ipWindow: HOUR    },
};

const DEFAULT_POLICY = { uidLimit: 300, uidWindow: MINUTE, ipLimit: 60, ipWindow: MINUTE };

function policyFor(name) {
  if (ROUTES[name]) return ROUTES[name];
  logger().warn('rate_limit_no_policy', { route: name, applying: 'default' });
  return DEFAULT_POLICY;
}

/**
 * Wrap an onCall handler. Reads uid from req.auth and IP from the
 * forwarded headers via clientIp(); enforces both ceilings before
 * the wrapped handler runs. Throws HttpsError('resource-exhausted')
 * with retry hint when over limit.
 *
 * Handlers using this no longer need to call enforceRateLimit
 * themselves. The Cloud Function code shrinks AND gains uniform
 * per-IP defense in depth.
 *
 * @param {string} name     Route name (must match a key in ROUTES).
 * @param {Function} handler Original onCall handler (req) => result.
 */
function guardCallable(name, handler) {
  const policy = policyFor(name);
  return async function (req) {
    // Per-IP first — cheaper to deny obviously bad traffic without
    // touching auth. IPv6 keyed on the /64 prefix (rateLimitIpKey).
    if (policy.ipLimit > 0) {
      try {
        await enforceRateLimit(name + ':ip', rateLimitIpKey(clientIp(req.rawRequest || {}) || 'unknown'), policy.ipLimit, policy.ipWindow);
      } catch (e) {
        if (e.rateLimited) {
          const HttpsError = require('firebase-functions/v2/https').HttpsError;
          // Human-readable message — clients surface e.message; machine
          // consumers read details.reason / the 'resource-exhausted' code.
          throw new HttpsError('resource-exhausted', 'Too many attempts. Try again in a few minutes.', { reason: 'rate_limited:ip', retryAfterMs: e.retryAfterMs });
        }
        throw e;
      }
    }
    // Per-uid second. Anonymous callers (no req.auth.uid) skip this.
    if (policy.uidLimit > 0 && req.auth?.uid) {
      try {
        await enforceRateLimit(name + ':uid', req.auth.uid, policy.uidLimit, policy.uidWindow);
      } catch (e) {
        if (e.rateLimited) {
          const HttpsError = require('firebase-functions/v2/https').HttpsError;
          throw new HttpsError('resource-exhausted', 'Too many requests. Try again shortly.', { reason: 'rate_limited:uid', retryAfterMs: e.retryAfterMs });
        }
        throw e;
      }
    }
    return handler(req);
  };
}

/**
 * Wrap an onRequest handler. Reads uid from a verified Firebase
 * ID token in the Authorization header (if present) and IP via
 * clientIp(req); enforces both ceilings before calling the wrapped
 * handler. On limit, responds 429 with Retry-After.
 *
 * If verifyIdToken fails (no token / bad token), only the per-IP
 * limit applies — anonymous traffic still gets throttled but doesn't
 * silently bypass uid limits because the user lied about their token.
 */
function guardHttp(name, handler) {
  const policy = policyFor(name);
  return async function (req, res) {
    // Per-IP — IPv6 keyed on the /64 prefix (rateLimitIpKey).
    if (policy.ipLimit > 0) {
      try {
        await enforceRateLimit(name + ':ip', rateLimitIpKey(clientIp(req) || 'unknown'), policy.ipLimit, policy.ipWindow);
      } catch (e) {
        if (e.rateLimited) {
          res.set('Retry-After', Math.ceil((e.retryAfterMs || policy.ipWindow) / 1000));
          res.status(429).json({ error: 'Rate limit exceeded. Try again shortly.', code: 'rate_limited:ip', retryAfterMs: e.retryAfterMs });
          return;
        }
        throw e;
      }
    }
    // Per-uid (best-effort — if token verify fails we don't bail,
    // just skip the uid clamp).
    const authHeader = req.headers?.authorization || '';
    const m = /^Bearer (.+)$/.exec(authHeader);
    if (policy.uidLimit > 0 && m) {
      try {
        const admin = require('firebase-admin');
        const { getAuth } = require('firebase-admin/auth');
        const { getApps } = require('firebase-admin/app');
        if (!getApps().length) admin.initializeApp();
        const decoded = await getAuth().verifyIdToken(m[1]).catch(() => null);
        if (decoded?.uid) {
          await enforceRateLimit(name + ':uid', decoded.uid, policy.uidLimit, policy.uidWindow);
        }
      } catch (e) {
        if (e.rateLimited) {
          res.set('Retry-After', Math.ceil((e.retryAfterMs || policy.uidWindow) / 1000));
          res.status(429).json({ error: 'Rate limit exceeded. Try again in a minute.', code: 'rate_limited:uid', retryAfterMs: e.retryAfterMs });
          return;
        }
        // Token verification errors are non-fatal — just skip uid clamp.
      }
    }
    return handler(req, res);
  };
}

/**
 * Surface the policy matrix to ops paths (e.g. integrationStatus
 * could echo this back). Frozen so callers can't mutate live policy.
 */
function getRateLimitMatrix() {
  const out = {};
  for (const [k, v] of Object.entries(ROUTES)) {
    out[k] = Object.freeze({
      uidLimit:  v.uidLimit,
      uidWindow: v.uidWindow,
      ipLimit:   v.ipLimit,
      ipWindow:  v.ipWindow,
    });
  }
  return Object.freeze(out);
}

module.exports = {
  ROUTES,
  DEFAULT_POLICY,
  guardCallable,
  guardHttp,
  policyFor,
  getRateLimitMatrix,
  // Time constants exported for test parity.
  SECOND,
  MINUTE,
  HOUR,
};
