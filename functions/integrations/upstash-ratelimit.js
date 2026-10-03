/**
 * integrations/upstash-ratelimit.js — drop-in adapter for rate-limit.js
 *
 * The current rate limiter stores counters in Firestore under
 * rate_limits/{hash}. Firestore caps around 500 writes/sec/doc — at
 * 10k users/hour with busy keys (claudeProxy:uid, publicLead:ip),
 * that's the next bottleneck. Upstash Redis over REST has no
 * per-key throughput ceiling that matters at our scale and response
 * latency is sub-20ms from us-central1 to the closest edge.
 *
 * This adapter exposes the SAME signatures as rate-limit.js's
 * enforceRateLimit + httpRateLimit, so index.js requires this
 * module instead when NBD_RATE_LIMIT_PROVIDER=upstash is set.
 *
 * SETUP:
 *   1. console.upstash.com → create Redis DB (global, regional near us-central1).
 *   2. Copy UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 *   3. firebase functions:secrets:set UPSTASH_REDIS_REST_URL
 *      firebase functions:secrets:set UPSTASH_REDIS_REST_TOKEN
 *   4. Set env var NBD_RATE_LIMIT_PROVIDER=upstash on the functions.
 *
 * If any secret is missing we FALL BACK to the Firestore limiter —
 * never crash, never silently let traffic through.
 */

'use strict';

const crypto = require('crypto');
const { getSecret, hasSecret, PROVIDERS } = require('./_shared');
const firestoreLimiter = require('../rate-limit'); // existing Firestore-backed limiter

// Lazy-loaded v2 logger (same pattern as rate-limit.js). Falls through
// to console when loaded in the smoke-test harness.
let _logger;
function logger() {
  if (_logger) return _logger;
  try { _logger = require('firebase-functions/v2').logger; }
  catch (_) {
    _logger = {
      info:  (...a) => console.log ('[info]',  ...a),
      warn:  (...a) => console.warn('[warn]',  ...a),
      error: (...a) => console.error('[error]', ...a),
    };
  }
  return _logger;
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 40);
}

function upstashConfigured() {
  return hasSecret('UPSTASH_REDIS_REST_URL') && hasSecret('UPSTASH_REDIS_REST_TOKEN');
}

// R-01: the active provider string the rate-limiter would use RIGHT
// NOW for a fresh call. `firestore` under two conditions:
//   - NBD_RATE_LIMIT_PROVIDER env isn't 'upstash' (ops missed the flip)
//   - secrets are unset (ops missed the provisioning step)
// 'upstash' only when both signals line up. Exported so
// integrationStatus can surface it to admins without them having to
// grep Cloud Logging.
function provider() {
  if (PROVIDERS.rateLimit === 'upstash' && upstashConfigured()) {
    return 'upstash';
  }
  return 'firestore';
}

// R-01: emit a cold-start WARN when the adapter is about to route to
// Firestore despite the env var saying Upstash was intended. This is
// the silent-misconfiguration signal ops cares about: a deploy that
// *should* have flipped to Upstash but didn't (secrets missed, env
// var drifted, Upstash org was deleted) logs identically to a healthy
// one without this. Structured fields mean a log-based metric can
// drive an alert in Cloud Monitoring.
//
// Runs once per cold start (module load). Re-logs per instance so
// every fresh Gen-2 container surfaces its own posture.
(function coldStartReport() {
  const envPref = (PROVIDERS.rateLimit || 'firestore').toLowerCase();
  const configured = upstashConfigured();
  const active = (envPref === 'upstash' && configured) ? 'upstash' : 'firestore';

  if (envPref === 'upstash' && !configured) {
    logger().warn('rate_limit_provider_drift', {
      message: 'NBD_RATE_LIMIT_PROVIDER=upstash but UPSTASH_REDIS_REST_URL or '
             + 'UPSTASH_REDIS_REST_TOKEN is unset — falling back to Firestore '
             + 'limiter. Under carrier-NAT load this is the documented R-01 '
             + 'hot-doc contention path.',
      envPref,
      upstashConfigured: false,
      active,
    });
    return;
  }
  if (envPref !== 'upstash') {
    // Quieter notice — intentional during dev / pre-launch.
    logger().info('rate_limit_provider_info', {
      envPref,
      upstashConfigured: configured,
      active,
      hint: 'Set NBD_RATE_LIMIT_PROVIDER=upstash + provision secrets for production.',
    });
    return;
  }
  logger().info('rate_limit_provider_info', {
    envPref,
    upstashConfigured: true,
    active,
  });
})();

// Upstash supports fixed-window limiting via atomic INCR + EXPIRE.
// We do them as a single Lua-ish pipeline:
//   MULTI; INCR key; EXPIRE key windowSec NX; EXEC
// Upstash REST accepts array-of-commands as a pipeline.
// Upstash answers in tens of ms; a hung request used to hang the CALLER
// (every rate-limited endpoint) instead of reaching the fail-open-to-
// Firestore path below, because fetch has no default timeout. 2.5s keeps the
// fallback well inside the tightest caller (thursdayCallerLookup, 10s).
const UPSTASH_TIMEOUT_MS = 2500;
async function upstashIncr(key, windowSec) {
  const url = getSecret('UPSTASH_REDIS_REST_URL');
  const token = getSecret('UPSTASH_REDIS_REST_TOKEN');
  const res = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, String(windowSec), 'NX']
    ]),
    signal: AbortSignal.timeout(UPSTASH_TIMEOUT_MS)
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error('Upstash ' + res.status + ': ' + body.slice(0, 200));
  }
  const data = await res.json();
  // data = [{result: <count>}, {result: 0|1}]
  const count = Array.isArray(data) && data[0] && typeof data[0].result === 'number'
    ? data[0].result : 0;
  return count;
}

/**
 * Count + enforce semantics match rate-limit.js:
 *   - resolve: under limit
 *   - reject:  { rateLimited: true }
 * Caller is expected to wrap with try/catch just like today.
 */
async function enforceRateLimit(namespace, keyRaw, limit, windowMs) {
  if (PROVIDERS.rateLimit !== 'upstash' || !upstashConfigured()) {
    return firestoreLimiter.enforceRateLimit(namespace, keyRaw, limit, windowMs);
  }
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));
  const key = 'rl:' + namespace + ':' + hashKey(keyRaw);
  try {
    const count = await upstashIncr(key, windowSec);
    if (count > limit) {
      const err = new Error('Rate limit exceeded');
      err.rateLimited = true;
      throw err;
    }
    return { count, limit, windowMs };
  } catch (e) {
    if (e.rateLimited) throw e;
    // On Upstash error, fail OPEN to Firestore limiter rather than
    // locking all callers out. The Firestore limiter is slower but
    // gives a correct answer.
    return firestoreLimiter.enforceRateLimit(namespace, keyRaw, limit, windowMs);
  }
}

/**
 * HTTP helper signature matches rate-limit.js — sets 429 + returns
 * false when over limit, returns true otherwise.
 */
async function httpRateLimit(req, res, namespace, limit, windowMs) {
  if (PROVIDERS.rateLimit !== 'upstash' || !upstashConfigured()) {
    return firestoreLimiter.httpRateLimit(req, res, namespace, limit, windowMs);
  }
  // /64-keyed to match the Firestore limiter — a raw IPv6 address lets one
  // allocation rotate through 2^64 buckets and defeat the cap entirely.
  const ip = firestoreLimiter.rateLimitIpKey(firestoreLimiter.clientIp(req));
  try {
    await enforceRateLimit(namespace, ip, limit, windowMs);
    return true;
  } catch (e) {
    if (e.rateLimited) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      res.status(429).json({ error: 'Rate limit exceeded' });
      return false;
    }
    // Unknown error — fail open to Firestore limiter.
    return firestoreLimiter.httpRateLimit(req, res, namespace, limit, windowMs);
  }
}

module.exports = {
  enforceRateLimit,
  httpRateLimit,
  clientIp: firestoreLimiter.clientIp,
  hashKey,
  provider,                      // R-01: 'upstash' | 'firestore'
  _upstashConfigured: upstashConfigured
};
