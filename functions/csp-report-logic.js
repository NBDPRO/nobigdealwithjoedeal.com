/**
 * functions/csp-report-logic.js — the pure parts of the cspReport endpoint
 * (handlers/monitoring.js), 2026-10-15.
 *
 * Why this exists: one iPhone (Brave on iOS 18.7, WebKit) sent ~295 reports
 * in a row that all logged with every field blank, tripped the 60/min per-IP
 * limit, and every `rate_limit_denied` WARNING paged Joe by SMS. WebKit posts
 * ONE Reporting API object per request — {type:'csp-violation', url, body:{…}}
 * — not the array Chrome sends and not the legacy {'csp-report':{…}}, and the
 * old parser only knew the other two shapes, so it logged the wrapper itself.
 * At the same time ~80 concurrent requests from that one browser all ran a
 * Firestore transaction on the same per-IP counter doc; the contention pushed
 * them past the 5 s function timeout (504s logged by Cloud Run as "reached
 * the maximum request timeout").
 *
 * Pieces:
 *   parseCspReports(body, raw) — all three body shapes → normalized reports
 *   createTtlSet()             — per-instance "seen recently" set (dedupe and
 *                                denial-log sampling), bounded in size
 *   makeCspReportHandler(deps) — the request handler, dependency-injected so
 *                                tests drive it without Firestore
 *
 * The dedupe and sampling memory is per instance (maxInstances 5), which is
 * enough: a noisy browser hits a warm instance, and the worst case of the
 * state being split is a handful of extra lines, never a page.
 */
'use strict';

const NAMESPACE = 'cspReport:ip';
const MAX_BODY_BYTES = 8192;
const RATE_LIMIT = 60;              // reports per IP per window (unchanged)
const RATE_WINDOW_MS = 60_000;
const DEDUPE_WINDOW_MS = 10 * 60_000;
const DENIAL_LOG_WINDOW_MS = 10 * 60_000;
const LIMITER_TIMEOUT_MS = 1500;    // the function's own timeout is 5 s
const MAX_TRACKED_KEYS = 5000;      // memory bound for each TTL set

const EXTENSION_RE = /^(chrome|moz|safari|safari-web|ms-browser)-extension:/i;

function str(v, max) {
  return v == null ? '' : String(v).slice(0, max);
}

function decodeBody(body, raw) {
  const isEmptyObj = (x) => x && typeof x === 'object' && !Array.isArray(x) && !Buffer.isBuffer(x) && Object.keys(x).length === 0;
  let b = body;
  if ((b == null || isEmptyObj(b) || Buffer.isBuffer(b) || typeof b === 'string') && raw && raw.length) {
    b = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  } else if (Buffer.isBuffer(b)) {
    b = b.toString('utf8');
  }
  if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (_) { return null; }
  }
  return b && typeof b === 'object' ? b : null;
}

// Reporting API entries carry a type; anything other than a CSP violation
// (deprecation, intervention, …) is not ours to log here.
function isCspType(t) {
  return t == null || t === 'csp-violation';
}

// One parsed body → the list of raw report bodies, each paired with the
// wrapper's `url` (the Reporting API puts the document URL there too).
function rawBodies(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) {
    return parsed
      .filter((r) => r && typeof r === 'object' && isCspType(r.type) && r.body && typeof r.body === 'object')
      .map((r) => ({ body: r.body, url: r.url }));
  }
  if (parsed['csp-report'] && typeof parsed['csp-report'] === 'object') {
    return [{ body: parsed['csp-report'] }];
  }
  if (parsed.body && typeof parsed.body === 'object') {
    return isCspType(parsed.type) ? [{ body: parsed.body, url: parsed.url }] : [];
  }
  return [{ body: parsed }];
}

function normalize({ body: r, url }) {
  return {
    directive:      str(r.effectiveDirective || r['effective-directive'] || r['violated-directive'] || r.violatedDirective, 200),
    blocked:        str(r.blockedURL || r['blocked-uri'] || r.blockedURI, 400),
    document:       str(r.documentURL || r['document-uri'] || r.documentURI || url, 400),
    disposition:    str(r.disposition, 20),
    sourceFile:     str(r.sourceFile || r['source-file'], 400),
    line:           Number(r.lineNumber || r['line-number'] || 0) || null,
    originalPolicy: str(r.originalPolicy || r['original-policy'], 500),
    statusCode:     Number(r.statusCode || r['status-code'] || 0) || null,
  };
}

/**
 * Parse a CSP report request body in any of the three shapes browsers use:
 *   legacy report-uri   {"csp-report": {"violated-directive": …}}
 *   Reporting API array [{type:"csp-violation", url, body:{effectiveDirective, …}}]  (Chrome)
 *   Reporting API object {type:"csp-violation", url, body:{…}}                       (WebKit)
 * Never throws; bad JSON and blank reports come back as [].
 */
function parseCspReports(body, raw) {
  return rawBodies(decodeBody(body, raw))
    .map(normalize)
    .filter((n) => n.directive || n.blocked || n.document);
}

// A violation caused by a browser extension (its own injected script or
// style), not by our pages. Logging it is noise.
function isExtensionReport(n) {
  return EXTENSION_RE.test(n.sourceFile) || EXTENSION_RE.test(n.blocked);
}

function dedupeKey(ip, n) {
  return [ip, n.directive, n.blocked, n.document].join('\n');
}

/**
 * A size-bounded set whose entries expire. `add(key, now)` returns true when
 * the key was NOT already present and live (and records it), false when it
 * was — so `if (set.add(k, t))` reads as "first time in the window".
 * `hits(key)` is how many times add() was refused since the key was recorded.
 */
function createTtlSet(ttlMs, maxKeys) {
  const max = maxKeys || MAX_TRACKED_KEYS;
  const m = new Map(); // key → { until, hits }
  function prune(now) {
    if (m.size < max) return;
    for (const [k, v] of m) if (v.until <= now) m.delete(k);
    while (m.size >= max) m.delete(m.keys().next().value); // oldest first
  }
  return {
    add(key, now) {
      const e = m.get(key);
      if (e && e.until > now) { e.hits++; return false; }
      prune(now);
      m.set(key, { until: now + ttlMs, hits: 0 });
      return true;
    },
    // How many add() calls were refused for `key` in its last window
    // (read BEFORE the add that starts the next window).
    hits(key) { const e = m.get(key); return e ? e.hits : 0; },
    get size() { return m.size; },
  };
}

/**
 * Build the cspReport request handler.
 *
 * deps: logger (warn/info), enforceRateLimit(ns, key, limit, windowMs, opts),
 *       clientIp(req), rateLimitIpKey(ip), hashKey(s), now() (default Date.now),
 *       limiterTimeoutMs (default 1500).
 *
 * Every path ends the response before returning, and none waits longer than
 * the limiter timeout: 405 for a non-POST, 204 for everything else (oversize,
 * bad JSON, duplicate, rate-limited, slow limiter, logged). A CSP report is
 * fire-and-forget for the browser; a non-2xx only makes Reporting API
 * clients retry.
 */
function makeCspReportHandler(deps) {
  const { logger, enforceRateLimit, clientIp, rateLimitIpKey, hashKey } = deps;
  const now = deps.now || Date.now;
  const limiterTimeoutMs = deps.limiterTimeoutMs == null ? LIMITER_TIMEOUT_MS : deps.limiterTimeoutMs;
  const seen = createTtlSet(DEDUPE_WINDOW_MS);
  const denialLogged = createTtlSet(DENIAL_LOG_WINDOW_MS);

  async function checkLimit(ip) {
    let timer;
    const slow = new Promise((resolve) => { timer = setTimeout(() => resolve('slow'), limiterTimeoutMs); });
    const call = Promise.resolve()
      // logDenial:false — the shared limiter's rate_limit_denied WARNING is
      // what the paging alert matches; this endpoint logs its own sampled
      // INFO line instead (below).
      .then(() => enforceRateLimit(NAMESPACE, ip, RATE_LIMIT, RATE_WINDOW_MS, { logDenial: false }))
      .then(() => 'allowed', (e) => (e && e.rateLimited ? 'denied' : 'error'));
    try { return await Promise.race([call, slow]); } finally { clearTimeout(timer); }
  }

  // At most one INFO line per IP per 10 minutes, carrying how many were
  // suppressed since the last one, so sustained abuse stays visible.
  function logSampled(message, ip, t, extra) {
    const key = message + '\n' + ip;
    const suppressed = denialLogged.hits(key);
    if (!denialLogged.add(key, t)) return;
    logger.info(message, Object.assign({
      namespace: NAMESPACE,
      sampled: true,
      suppressedSinceLast: suppressed,
      sampleWindowMinutes: DENIAL_LOG_WINDOW_MS / 60_000,
      ipHash: String(hashKey(ip)).slice(0, 12),
    }, extra || {}));
  }

  return async function cspReportHandler(req, res) {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    try {
      const raw = req.rawBody;
      // Hard size cap — bounded-budget log ingestion. Not parsed, not logged.
      if (raw && raw.length > MAX_BODY_BYTES) { res.status(204).end(); return; }

      const parsed = parseCspReports(req.body, raw);
      const reports = parsed.filter((n) => !isExtensionReport(n));
      if (!reports.length) { res.status(204).end(); return; }

      const ip = rateLimitIpKey(clientIp(req));
      const t = now();
      // Dedupe BEFORE the limiter: a browser re-sending the same violation
      // costs no Firestore write and cannot trip the limit. This is also
      // what removes the hot-document contention behind the 504s.
      const fresh = reports.filter((n) => seen.add(dedupeKey(ip, n), t));
      if (!fresh.length) { res.status(204).end(); return; }

      const verdict = await checkLimit(ip);
      if (verdict === 'denied') {
        logSampled('csp_report_rate_limited', ip, t, { limitPerMinute: RATE_LIMIT, dropped: fresh.length });
        res.status(204).end(); return;
      }
      if (verdict === 'slow') {
        // The limiter transaction is stuck behind contention on this IP's
        // counter — the flood signature. Drop rather than hang to 504.
        logSampled('csp_report_limiter_slow', ip, t, { timeoutMs: limiterTimeoutMs, dropped: fresh.length });
        res.status(204).end(); return;
      }
      // 'allowed', or 'error' (limiter backend broke): fail open — losing
      // violation reports because the limiter failed isn't worth it.
      const userAgent = str(req.headers && req.headers['user-agent'], 200);
      for (const n of fresh) logger.warn('csp_violation', Object.assign({}, n, { userAgent }));
      res.status(204).end();
    } catch (e) {
      logger.warn('cspReport error', { err: e && e.message });
      if (!res.headersSent) res.status(204).end(); // never signal failure to the browser — it'll retry
    }
  };
}

module.exports = {
  parseCspReports,
  isExtensionReport,
  createTtlSet,
  makeCspReportHandler,
  NAMESPACE,
  MAX_BODY_BYTES,
  DEDUPE_WINDOW_MS,
  DENIAL_LOG_WINDOW_MS,
  LIMITER_TIMEOUT_MS,
};
