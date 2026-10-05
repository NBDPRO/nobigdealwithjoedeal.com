/**
 * functions/handlers/monitoring.js — CSP / browser-monitoring endpoints.
 *
 * Step 4c extraction. Moved verbatim from functions/index.js:
 *   - cspReport (onRequest, accepts CSP violation reports → logs only)
 *   - clientError (onRequest, 2026-10-04: browser error reports → one log line)
 *
 * No behavioral changes; pure structural move.
 */

'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');

const { httpRateLimit, enforceRateLimit } = require('../integrations/upstash-ratelimit');

// ═════════════════════════════════════════════════════════════
// F-09: CSP violation report receiver.
//
// The Report-Only CSP in firebase.json is currently a no-op because
// violations have nowhere to go. This endpoint accepts both the
// classic `application/csp-report` body shape (report-uri) and the
// newer `application/reports+json` array shape (Reporting API /
// report-to) and logs a bounded subset of fields.
//
// We accept unauthenticated POSTs — the browser fires these without
// credentials. Per-IP rate limit and hard size cap protect against
// log-flooding. Firestore is intentionally NOT written; logs are
// enough and cheaper.
// ═════════════════════════════════════════════════════════════
// Browsers post CSP reports as application/csp-report (report-uri) or
// application/reports+json (report-to). The JSON body parser only reads
// application/json, so req.body arrived as {} and all 38 reports after the
// 10-02 invoker fix logged with every field blank (2026-10-03 audit). Parse
// the raw body ourselves when the parsed one is empty, and skip blanks.
function parseCspBody(body, raw) {
  let b = body;
  const isEmptyObj = (x) => x && typeof x === 'object' && !Array.isArray(x) && !Buffer.isBuffer(x) && Object.keys(x).length === 0;
  if ((b == null || isEmptyObj(b) || Buffer.isBuffer(b) || typeof b === 'string') && raw && raw.length) {
    try { b = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)); } catch (_) { b = {}; }
  } else if (typeof b === 'string') {
    try { b = JSON.parse(b); } catch (_) { b = {}; }
  }
  const list = Array.isArray(b)
    ? b.map((r) => r && r.body).filter(Boolean)
    : b && b['csp-report'] ? [b['csp-report']] : [b || {}];
  return list.filter((r) => r && typeof r === 'object' && Object.keys(r).length > 0);
}

exports.cspReport = onRequest(
  {
    region: 'us-central1',
    // Declared, not defaulted (2026-10-02): the live service had no allUsers
    // run.invoker binding, so all 261 reports in a week were 403'd by Cloud
    // Run before reaching this handler. CSP monitoring was blind.
    invoker: 'public',
    cors: false,
    maxInstances: 5,
    concurrency: 80,
    timeoutSeconds: 5,
    // 256MiB (was 128MiB): every Gen2 container cold-loads the entire
    // index.js module graph (~175 fns + firebase-admin), and at 128MiB
    // the throttled CPU made that load intermittently miss the container
    // startup healthcheck — "Container Healthcheck failed … failed to
    // start and listen on PORT=8080" — failing THIS function's deploy
    // (turning the whole deploy job RED) while every 256MiB fn succeeded.
    // 256MiB is the codebase default and is proven for this exact
    // full-graph cold start across ~97 other functions.
    memory: '256MiB'
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    try {
      // Hard size cap — bounded-budget log ingestion.
      const raw = req.rawBody;
      if (raw && Buffer.isBuffer(raw) && raw.length > 8192) {
        res.status(413).end(); return;
      }
      // Per-IP rate limit — 60/min/IP. Normal reporting is well below
      // this; a page stuck in a CSP loop could exceed. httpRateLimit sends
      // the 429 itself and returns FALSE when limited (it does not throw) —
      // until 2026-08-10 the boolean was ignored, so a limited IP still got
      // its full body parsed and every entry logged (the exact flood the
      // limit exists to stop) followed by a second response on an already-
      // sent request. Limiter-BACKEND errors still fail open: dropping
      // violation reports because the limiter broke isn't worth it.
      let allowed = true;
      try {
        allowed = await httpRateLimit(req, res, 'cspReport:ip', 60, 60_000);
      } catch (_) { /* fail open on limiter backend error */ }
      if (!allowed) return;

      // `report-uri` shape: { "csp-report": { ... } }
      // `report-to` shape: [ { type: 'csp-violation', body: { ... } } ]
      const reports = parseCspBody(req.body, raw);
      for (const r of reports) {
        logger.warn('csp_violation', {
          documentURI:        String(r['document-uri']       || r.documentURL || '').slice(0, 400),
          blockedURI:         String(r['blocked-uri']        || r.blockedURL  || '').slice(0, 400),
          violatedDirective:  String(r['violated-directive'] || r.effectiveDirective || '').slice(0, 200),
          originalPolicy:     String(r['original-policy']    || r.originalPolicy     || '').slice(0, 500),
          disposition:        String(r.disposition || '').slice(0, 20),
          sourceFile:         String(r['source-file']        || r.sourceFile || '').slice(0, 400),
          lineNumber:         Number(r['line-number']        || r.lineNumber || 0) || null,
          statusCode:         Number(r['status-code']        || r.statusCode || 0) || null,
          userAgent:          String(req.headers['user-agent'] || '').slice(0, 200)
        });
      }
      res.status(204).end();
    } catch (e) {
      logger.warn('cspReport error', { err: e.message });
      res.status(204).end();  // Never signal failure to the browser — it'll retry.
    }
  }
);

// ═════════════════════════════════════════════════════════════
// clientError — browser error reports from the CRM (2026-10-04).
//
// The dashboard's window 'error' / 'unhandledrejection' handlers only
// console.error'd, so an error on Jo's iPhone never reached anyone.
// docs/pro/js/client-error-reporter.js now posts one small JSON report per
// distinct error (deduped by signature, capped per session) to
// /api/client-error, which the hosting rewrite routes here.
//
// Public on purpose: an error can happen before sign-in, or BECAUSE auth
// broke. Guards, in order: POST only, a 4 KiB body cap, 30/min per IP and
// 30/min per uid-hash through the existing limiter, then
// client-error-logic.js parseReport (bounded, re-scrubbed fields; the
// signature is recomputed here, never trusted from the client).
//
// Output is ONE structured ERROR log line, written with logger.write so its
// message is exactly 'client_error' plus event: 'client_error'.
// logger.error(msg, …) would NOT do: firebase-functions replaces an ERROR
// message with new Error(msg).stack ("Error: client_error" + a stack), so an
// exact jsonPayload.message filter never matches it. The alert policies
// (monitoring/alert-client-error-*.json) match jsonPayload.event.
// Nothing is written to Firestore per error (the limiter's own counter doc
// is the only write).
// ═════════════════════════════════════════════════════════════
const clientErrorLogic = require('../client-error-logic');
const CLIENT_ERROR_IP_LIMIT = 30;
const CLIENT_ERROR_UID_LIMIT = 30;

function makeClientErrorHandler(deps) {
  const log = deps.logger;
  return async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    try {
      const raw = req.rawBody;
      if (raw && raw.length > clientErrorLogic.MAX_BODY_BYTES) {
        res.status(413).end(); return;
      }
      let allowed = true;
      try {
        allowed = await deps.httpRateLimit(req, res, 'clientError:ip', CLIENT_ERROR_IP_LIMIT, 60_000);
      } catch (_) { /* limiter backend down: fail open, the body cap still bounds us */ }
      if (!allowed) return;

      const parsed = clientErrorLogic.parseReport(req.body, raw);
      if (!parsed.ok) {
        const status = parsed.reason === 'too_large' ? 413 : 400;
        log.warn('client_error_rejected', { reason: parsed.reason });
        res.status(status).end(); return;
      }
      const e = parsed.entry;
      if (e.uidHash) {
        try {
          await deps.enforceRateLimit('clientError:uid', e.uidHash, CLIENT_ERROR_UID_LIMIT, 60_000);
        } catch (err) {
          if (err && err.rateLimited) { res.status(429).end(); return; }
        }
      }
      const { message, ...rest } = e;
      log.write({ severity: 'ERROR', message: 'client_error', event: 'client_error', errorMessage: message, ...rest });
      res.status(204).end();
    } catch (err) {
      log.warn('clientError handler error', { err: String(err && err.message || err).slice(0, 200) });
      res.status(204).end();
    }
  };
}

exports.clientError = onRequest(
  {
    region: 'us-central1',
    invoker: 'public',
    cors: false,          // same-origin via the /api/client-error hosting rewrite
    maxInstances: 5,
    concurrency: 80,
    timeoutSeconds: 10,
    memory: '256MiB'      // see cspReport above: 128MiB fails the cold start
  },
  makeClientErrorHandler({ logger, httpRateLimit, enforceRateLimit })
);

// Test hook (exported by name from index.js, so this never deploys).
exports._test = { parseCspBody, makeClientErrorHandler };
