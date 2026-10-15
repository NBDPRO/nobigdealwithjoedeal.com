/**
 * Shared rate limiter for Cloud Functions.
 *
 * Uses a dedicated Firestore collection `_rate_limits_ip/{hashedKey}` that is
 * locked down in firestore.rules (allow read, write: if false — admin SDK only).
 * Replaces the prior user-writable `rate_limits/{uid}` collection that users
 * could reset at will.
 *
 * Keys are sha256-hashed so we never store raw IPs.
 */

const crypto = require('crypto');

// Q1: firebase-admin is loaded lazily. clientIp + hashKey are pure
// helpers that must be importable from test harnesses that don't
// install the functions/ node_modules tree. enforceRateLimit +
// httpRateLimit call getDb() at request time. Modular getFirestore()
// — firebase-admin v14-ready; the legacy admin.firestore() accessor is gone.
let _db;
function getDb() {
  if (_db) return _db;
  _db = require('firebase-admin/firestore').getFirestore();
  return _db;
}

// Lazy-load the v2 logger — this module is also require()'d by unit tests
// that run outside the Firebase Functions runtime, where `firebase-functions`
// is not installed. Fall back to a console shim in that case.
let _logger;
function logger() {
  if (_logger) return _logger;
  try {
    _logger = require('firebase-functions/v2').logger;
  } catch (_) {
    _logger = {
      info: (...a) => console.log('[info]', ...a),
      warn: (...a) => console.warn('[warn]', ...a),
      error: (...a) => console.error('[error]', ...a),
    };
  }
  return _logger;
}

function hashKey(raw) {
  return crypto.createHash('sha256').update(String(raw || 'unknown')).digest('hex').substring(0, 32);
}

// Q1 / F-13: correct X-Forwarded-For parsing on Google LB + Cloud Run.
//
// Google's External HTTP(S) Load Balancer (which fronts Firebase
// Functions Gen 2) appends TWO entries to any inbound XFF:
//   <existing values>,<real-client-ip>,<global-forwarding-rule-ip>
// (See cloud.google.com/load-balancing/docs/https#target-proxies.)
//
// The previous implementation took .split(',')[0] — the LEFT-most
// entry — which is exactly the value an attacker can supply upstream.
// Every per-IP rate-limit bucket in this codebase was spoofable: an
// attacker sending `X-Forwarded-For: 1.2.3.4` would land the LB
// result `1.2.3.4,<real-ip>,<gfr>`, and the buggy parser would then
// bucket the legitimate value `1.2.3.4` rather than their real IP.
//
// Correct algorithm: the real client is at index `length - 2`
// (i.e. one entry to the left of the GFR hop). Expressed more
// generally, `length - 1 - NBD_TRUSTED_PROXY_HOPS`. Default hop
// count is 1 = the Google LB. Put a CDN (Cloudflare, Fastly) in
// front and every additional layer that also appends bumps the
// hop count — set NBD_TRUSTED_PROXY_HOPS=2 in that case.
//
// Chains shorter than expected (1-entry XFF, or missing entirely)
// fall back to the socket IP — we never take the only entry as
// truth, because a single entry means the LB didn't execute its
// normal append path (test harness, direct invocation, or an
// unusual proxy configuration).
const TRUSTED_PROXY_HOPS = (() => {
  const v = Number(process.env.NBD_TRUSTED_PROXY_HOPS);
  // Clamp to [0, 10] so a malformed env can't underflow or absurdly
  // overflow the chain.
  return Number.isFinite(v) && v >= 0 && v <= 10 ? v : 1;
})();

function parseXff(header) {
  if (typeof header !== 'string' || !header.length) return [];
  return header.split(',').map(s => s.trim()).filter(Boolean);
}

function clientIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  const chain = parseXff(xff);
  if (chain.length > 0) {
    // Real client sits to the left of our trusted proxy hops.
    //   chain.length - TRUSTED_PROXY_HOPS - 1
    // is the index. If the caller spoofed N fake IPs, the index
    // still lands on the LB-stamped hop (their real IP) rather than
    // the spoofed prefix.
    const idx = chain.length - TRUSTED_PROXY_HOPS - 1;
    if (idx >= 0) return chain[idx];
    // Chain shorter than trusted hop count → fall through to socket IP.
  }
  // Fallbacks — socket IP on direct invocation / tests.
  return req?.ip || req?.socket?.remoteAddress || req?.rawRequest?.ip || 'unknown';
}

/**
 * Collapse an IPv6 address to its /64 prefix so one allocation can't rotate
 * through its 2^64 addresses to defeat a per-IP cap. IPv4 (no ':') and
 * anything unparseable pass through unchanged — exact canonicalisation isn't
 * needed, only a stable per-customer bucket.
 *
 * This lives here, next to clientIp, because EVERY per-IP limiter needs it:
 * a raw-address key turns an hourly cap into no cap at all for any caller on
 * a normal residential IPv6 allocation. httpRateLimit below applies it for
 * you. handlers/integrations.js previously carried the only copy and applied
 * it by hand in one endpoint, which is why the rest were unprotected.
 *
 * @param {string} ip
 * @returns {string} bucket key
 */
function rateLimitIpKey(ip) {
  const s = String(ip || '');
  if (s.indexOf(':') === -1) return s; // IPv4 / empty — unchanged
  const head = s.split('%')[0];        // strip any zone id
  const sides = head.split('::');
  let groups;
  if (sides.length === 2) {
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    const fill = Array(Math.max(0, 8 - left.length - right.length)).fill('0');
    groups = left.concat(fill, right);
  } else {
    groups = head.split(':');
  }
  return groups.slice(0, 4).join(':') + '::/64';
}

/**
 * Enforce a rolling window per (namespace, key). Throws if over limit.
 *
 * @param {string} namespace e.g. 'validateAccessCode' | 'claudeProxy:ip'
 * @param {string} key raw key (IP or uid)
 * @param {number} limit max requests per window
 * @param {number} windowMs window duration in ms
 * @param {{logDenial?: boolean}} [opts] logDenial:false skips the
 *   rate_limit_denied WARNING (the paging alert's match) for a caller that
 *   logs its own sampled line instead — only cspReport does (2026-10-15).
 */
async function enforceRateLimit(namespace, key, limit, windowMs, opts) {
  const db = getDb();
  const docId = `${namespace}__${hashKey(key)}`;
  const ref = db.collection('_rate_limits_ip').doc(docId);
  const now = Date.now();

  // Transactional increment — protects against burst races.
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    if (!data || now - (data.windowStart || 0) >= windowMs) {
      tx.set(ref, { windowStart: now, count: 1, lastSeenAt: now }, { merge: true });
      return { allowed: true, count: 1, remaining: limit - 1 };
    }
    if ((data.count || 0) >= limit) {
      return { allowed: false, count: data.count, remaining: 0, retryAfterMs: windowMs - (now - data.windowStart) };
    }
    tx.update(ref, { count: (data.count || 0) + 1, lastSeenAt: now });
    return { allowed: true, count: (data.count || 0) + 1, remaining: limit - 1 - (data.count || 0) };
  });

  if (!result.allowed) {
    // Emit a structured warning so Cloud Monitoring can attach a log-based
    // metric to this and alert on spikes. See monitoring/alert-rate-limit-spike.json.
    if (!opts || opts.logDenial !== false) {
      logger().warn('rate_limit_denied', {
        namespace,
        retryAfterMs: result.retryAfterMs,
      });
    }
    const e = new Error('rate_limited');
    e.rateLimited = true;
    e.retryAfterMs = result.retryAfterMs;
    throw e;
  }
  return result;
}

/**
 * Convenience wrapper for HTTP handlers that responds with 429 on limit.
 */
async function httpRateLimit(req, res, namespace, limit, windowMs) {
  try {
    // /64-keyed, not raw — see rateLimitIpKey. Applied here rather than at
    // each call site so no endpoint can be added without it.
    await enforceRateLimit(namespace, rateLimitIpKey(clientIp(req)), limit, windowMs);
    return true;
  } catch (e) {
    if (e.rateLimited) {
      res.set('Retry-After', Math.ceil((e.retryAfterMs || windowMs) / 1000));
      res.status(429).json({ error: 'Too many requests' });
      return false;
    }
    throw e;
  }
}

module.exports = { enforceRateLimit, httpRateLimit, clientIp, rateLimitIpKey, hashKey };
