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
// 10-02 invoker fix logged with every field blank (2026-10-03 audit). The
// raw body is parsed ourselves, and blanks are skipped.
//
// 2026-10-15: parsing, normalizing, dedupe and the sampled denial log moved
// to ../csp-report-logic.js (makeCspReportHandler). WebKit posts a SINGLE
// Reporting API object per request, which the old parser logged as a blank
// report; one iPhone's ~300 of those tripped the per-IP limit, every
// rate_limit_denied WARNING paged Joe, and the Firestore contention on that
// IP's counter doc ran requests into the 5 s timeout (504). See that file.
const cspReportLogic = require('../csp-report-logic');
const rateLimitCore = require('../rate-limit');

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
  // Per-IP rate limit 'cspReport:ip' 60/min (after the per-instance dedupe),
  // 8 KB body cap, and a 204 on every POST path within ~1.5 s. Limiter-
  // BACKEND errors still fail open. Denials log a sampled INFO
  // 'csp_report_rate_limited', never the paging rate_limit_denied WARNING.
  cspReportLogic.makeCspReportHandler({
    logger,
    enforceRateLimit,
    clientIp: rateLimitCore.clientIp,
    rateLimitIpKey: rateLimitCore.rateLimitIpKey,
    hashKey: rateLimitCore.hashKey,
  })
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
exports._test = { parseCspReports: cspReportLogic.parseCspReports, makeClientErrorHandler };
