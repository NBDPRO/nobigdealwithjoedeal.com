/**
 * integrations/upstash-ratelimit.js — the rate-limit entry point every
 * handler requires. Now a thin re-export of the Firestore limiter
 * (../rate-limit.js).
 *
 * HISTORY (keep the filename — ~40 modules and ~20 test stubs address the
 * limiter by this path, so renaming it is churn with no behaviour gain):
 * this file used to be an Upstash Redis REST adapter, selected by
 * NBD_RATE_LIMIT_PROVIDER=upstash plus the UPSTASH_REDIS_REST_URL/_TOKEN
 * secrets. Neither was ever provisioned — the env var was never set and both
 * secrets held the deploy's `__unset__` stub — so every call already took the
 * Firestore branch below. The Upstash code and its two secrets were removed
 * 2026-10-04 (documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md, Lane C).
 * Behaviour is unchanged: the same Firestore limiter answers every call, with
 * the same keys and the same 429 contract.
 *
 * If Firestore's per-doc write ceiling ever becomes the bottleneck (R-01:
 * hot keys under carrier-NAT load), add the new backend HERE so the callers
 * don't change.
 */

'use strict';

const crypto = require('crypto');
const firestoreLimiter = require('../rate-limit');

// Kept byte-identical to the old adapter's hashKey: rate-limit-policy.js
// derives bucket keys with it, and changing the digest length would reset
// every policy-guarded counter on deploy.
function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 40);
}

// R-01: the active backend, surfaced by integrationStatus for admins.
function provider() {
  return 'firestore';
}

// Late-bound (looked up per call, as the old adapter did) so a test that
// patches the Firestore limiter after this module loads still takes effect.
function enforceRateLimit(namespace, keyRaw, limit, windowMs) {
  return firestoreLimiter.enforceRateLimit(namespace, keyRaw, limit, windowMs);
}
function httpRateLimit(req, res, namespace, limit, windowMs) {
  return firestoreLimiter.httpRateLimit(req, res, namespace, limit, windowMs);
}

module.exports = {
  enforceRateLimit,
  httpRateLimit,
  clientIp: firestoreLimiter.clientIp,
  hashKey,
  provider,                      // R-01: always 'firestore'
};
