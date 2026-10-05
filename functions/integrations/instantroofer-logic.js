/**
 * functions/integrations/instantroofer-logic.js — pure (firebase-free) logic
 * for the Instant Roofer measurement provider.
 *
 * Split from measurement.js the same way thumbtack-logic.js is split from
 * thumbtack.js: the adapter owns fetch + Firestore, everything here is a pure
 * function of its inputs so it unit-tests with zero deps
 * (tests/instantroofer-measurement.test.js).
 *
 * ── THE API (read verbatim 2026-09-06 from instantroofer.com/api-instruction,
 *    "AI Instant Measure Reports API (June 2026)") ─────────────────────────
 *
 *   POST https://v5.instantroofer.com/v2
 *   Authorization: Bearer <key>          Content-Type: application/json
 *
 *   { latitude, longitude [, resultOptions] }
 *       → synchronous AI measure, 10–20 s, JSON body (normalizeAiResponse)
 *   { latitude, longitude, reportType: "human" [, contractorName, customerName,
 *     originalAddress] }
 *       → { ok, code: "HUMAN_QUEUED", requestId, humanReportId, … } and the
 *         report arrives ~60 min later via webhook (parseHumanWebhook)
 *
 * Coordinates are the ONLY locator — there is no address parameter, and the
 * point has to sit on the building: "404 — Roof not found. Please make sure
 * your latitude/longitude is in the center of a building." The adapter is
 * responsible for turning an address into a rooftop point BEFORE calling.
 *
 * ── WHY THE NORMALIZER IS DEFENSIVE ────────────────────────────────
 * The docs publish an example response and a field reference, but two things
 * are only described in prose: whether `complexityWaste` is a fraction or a
 * percentage, and whether a human-report webhook's `status` is the string
 * "completed" or the numeric `order.status_code` (their "minimum payload"
 * table maps `status` → `order.status_code`). Both are tolerated here.
 *
 * VERIFIED against a live AI measure on 2026-09-06 (their own documentation
 * example coordinates, 32.865378/-111.677416):
 *   - `complexityWaste` came back as **11** — a percent, not a fraction. The
 *     tolerant read below handles both and lands on 11 either way.
 *   - `resultOptions` with explicit `false` values is ACCEPTED, and it works:
 *     `imagery` came back empty and `lidar` carried only `facets`, so the
 *     base64 image and the LiDAR point cloud never reach Firestore. Whole
 *     response: 1,536 bytes.
 *   - The response carries an UNDOCUMENTED top-level `coordinates` echo of the
 *     point actually measured. It rides along in `vendorResponse`.
 * STILL UNVERIFIED: the human-report webhook's `status` shape — no human
 * report has been ordered yet. Keep both branches until one arrives
 * (runbooks/INSTANTROOFER-SETUP.md, "first-use").
 */

'use strict';

const crypto = require('crypto');

const ENDPOINT = 'https://v5.instantroofer.com/v2';
const PROVIDER = 'instantroofer';

// What we ask the AI measure to include. The three keys are the documented
// ones ("If resultOptions is omitted, mapWithOutlineFromImageModel, facetMeta,
// and facetPoints default to true"). The outline image is a base64 PNG and the
// facet points are a LiDAR point cloud — both far too big for a Firestore doc
// and unused by the estimate builder, so they are off until a surface needs
// them (the public-wizard slice will want the outline, client-side only).
const AI_RESULT_OPTIONS = Object.freeze({
  mapWithOutlineFromImageModel: false,
  facetMeta: true,
  facetPoints: false
});

// measurements.complexity — "0 = Low, 1 = Moderate, 2 = High, 3 = Extreme".
const COMPLEXITY_LABEL = ['Low', 'Moderate', 'High', 'Extreme'];

// Documented confidence buckets (used only when the API omits its own
// customer-facing label): Low < 0.24, Medium 0.24–0.34, High >= 0.35.
function confidenceLabel(score) {
  if (typeof score !== 'number' || !isFinite(score)) return null;
  if (score >= 0.35) return 'High';
  if (score >= 0.24) return 'Medium';
  return 'Low';
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function intOrNull(v) {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

// "5/12" | "5:12" | "5" | 5 | "5.5/12" → 5 (the rise over 12). Null when it
// can't be read. Mirrors what the V2 builder's <select> accepts.
function parsePitchRise(pitch) {
  if (pitch === null || pitch === undefined) return null;
  const s = String(pitch).trim();
  const m = /^(\d+(?:\.\d+)?)\s*(?:[/:]\s*(\d+(?:\.\d+)?))?/.exec(s);
  if (!m) return null;
  const rise = Number(m[1]);
  const run = m[2] ? Number(m[2]) : 12;
  if (!isFinite(rise) || !isFinite(run) || run <= 0) return null;
  return run === 12 ? rise : (rise / run) * 12;
}

// Slope factor: pitched area = footprint × sqrt(1 + (rise/12)^2).
function pitchFactor(pitch) {
  const rise = parsePitchRise(pitch);
  if (rise === null) return null;
  return Math.sqrt(1 + Math.pow(rise / 12, 2));
}

// complexityWaste is "estimated waste percentage". Live responses send a
// percent (verified 2026-09-06: 11), but the docs only say "percentage", so a
// value <= 1 is still read as a fraction (0.15 → 15) and anything larger as
// already-percent (11 → 11). Do not narrow this without a second sample: the
// two readings differ by 100x on the waste line of every estimate.
function wastePercent(v) {
  const n = num(v);
  if (n === null || n < 0) return null;
  return n <= 1 ? Math.round(n * 1000) / 10 : Math.round(n * 10) / 10;
}

function validateCoords(lat, lng) {
  const la = num(lat), ln = num(lng);
  if (la === null || ln === null) return { ok: false, reason: 'not-numbers' };
  if (Math.abs(la) > 90 || Math.abs(ln) > 180) return { ok: false, reason: 'out-of-range' };
  if (la === 0 && ln === 0) return { ok: false, reason: 'null-island' };
  return { ok: true, lat: la, lng: ln };
}

// Dedup key for "the same roof". 5 decimals ≈ 1.1 m — tight enough that two
// townhomes (≈6 m wide) never share a key, loose enough that the same stored
// point always does. The adapter reuses a recent ready measurement under the
// same key instead of billing again.
function coordKey(lat, lng) {
  return PROVIDER + ':' + Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5);
}

function buildRequestBody(lat, lng, opts) {
  opts = opts || {};
  const body = { latitude: Number(lat), longitude: Number(lng) };
  if (opts.reportType === 'human') {
    body.reportType = 'human';
    // Optional job context — "appear in our team drawing queue and help the
    // drawing team identify the correct order". Length caps are theirs.
    if (opts.contractorName) body.contractorName = String(opts.contractorName).slice(0, 255);
    if (opts.customerName)   body.customerName   = String(opts.customerName).slice(0, 255);
    if (opts.address)        body.originalAddress = String(opts.address).slice(0, 1000);
  } else {
    body.resultOptions = Object.assign({}, AI_RESULT_OPTIONS);
    // The outline image, on request only (2026-10-04: the auto-order shows it
    // in the Draw tool as a cross-check). The caller stores it in Storage —
    // never in Firestore, where a base64 PNG would crowd the 1 MiB doc cap.
    if (opts.outline) body.resultOptions.mapWithOutlineFromImageModel = true;
  }
  return body;
}

/**
 * The outline image from an AI response, as bytes ready for Storage, or null.
 * Tolerates a bare base64 string and a `data:image/...;base64,` URL. The
 * content type is read from the bytes' own signature (PNG / JPEG / WebP),
 * never trusted from the vendor string, and anything else is refused.
 */
function outlineImage(body) {
  const raw = body && body.imagery && body.imagery.mapWithOutline;
  if (typeof raw !== 'string' || raw.length < 16) return null;
  const b64 = raw.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 8 || buf.length > 8 * 1024 * 1024) return null;
  let contentType = null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) contentType = 'image/png';
  else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) contentType = 'image/jpeg';
  else if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') contentType = 'image/webp';
  if (!contentType) return null;
  return { buffer: buf, contentType };
}

/**
 * AI measure response → the `measurements` shape every consumer already reads
 * (estimate-v2-ui applyMeasurementResult, d2d renderMeasurement, the lead
 * activity summary). Field semantics:
 *
 *   rawSqft       = sqft.measured — footprint with the predominant pitch
 *                   applied, i.e. the roof surface. This is what HOVER's
 *                   total_facets_area_sqft meant to those consumers; they add
 *                   their own waste on top, so it must NOT already carry waste.
 *   suggestedSqft = sqft.suggested / squares — the vendor's material figure,
 *                   waste included. Kept separately for comparison.
 *
 * Never throws; an empty/garbage body yields a shape of nulls with source set,
 * and the adapter decides whether that counts as a failure (rawSqft null).
 */
function normalizeAiResponse(body) {
  const m  = (body && typeof body === 'object' && body.measurements) || {};
  const sq = (m && typeof m.sqft === 'object' && m.sqft) || {};
  const bp = (body && typeof body === 'object' && body.buildingPredictions) || {};
  const conf = (m && typeof m.confidence === 'object' && m.confidence) || {};

  const pitch = m.pitch === null || m.pitch === undefined ? null : String(m.pitch);
  const footprint = num(sq.aerial);
  let measured = num(sq.measured);
  if (measured === null && footprint !== null) {
    const f = pitchFactor(pitch);
    if (f !== null) measured = Math.round(footprint * f);
  }

  const complexity = intOrNull(m.complexity !== undefined ? m.complexity : bp.complexityClass);
  const score = num(conf.score);
  const labelFromApi = conf.display && typeof conf.display.value === 'string' ? conf.display.value : null;

  return {
    rawSqft:        measured,
    footprintSqft:  footprint,
    suggestedSqft:  num(sq.suggested),
    squares:        num(m.squares),
    pitch:          pitch,
    perimeterLf:    num(m.perimeter),
    facets:         intOrNull(m.facets),
    stories:        intOrNull(m.stories),      // beta field per the docs — an estimate
    complexity:     complexity,
    complexityLabel: complexity !== null && COMPLEXITY_LABEL[complexity] ? COMPLEXITY_LABEL[complexity] : null,
    wastePct:       wastePercent(bp.complexityWaste),
    confidence:     score === null && !labelFromApi ? null : {
      score: score,
      label: labelFromApi || confidenceLabel(score)
    },
    isTownhome:     typeof bp.isTownhome === 'boolean' ? bp.isTownhome : null,
    isCommercial:   typeof bp.isCommercial === 'boolean' ? bp.isCommercial : null,
    reportUrl:      null,                       // AI reports have no document
    source:         PROVIDER + '-ai'
  };
}

// Human-report order acknowledgement: { ok, code:"HUMAN_QUEUED", requestId,
// humanReportId, … }. requestId is what the webhook echoes back, so it is our
// externalJobId.
function parseHumanAccepted(body) {
  if (!body || typeof body !== 'object') return null;
  const requestId = body.requestId || body.request_id || body.requestID || null;
  if (!requestId) return null;
  return {
    externalJobId: String(requestId),
    humanReportId: body.humanReportId ? String(body.humanReportId) : null,
    code: body.code || null
  };
}

// Documented HTTP errors → our reason + the HttpsError code the callable
// throws. `retryable` is for the caller's UX copy only; nothing auto-retries a
// paid call.
const HTTP_ERRORS = Object.freeze({
  400: { reason: 'invalid-coords', code: 'invalid-argument',    retryable: false,
         message: 'Instant Roofer rejected the coordinates.' },
  401: { reason: 'auth',           code: 'failed-precondition', retryable: false,
         message: 'Instant Roofer API key missing, expired or invalid — rotate INSTANTROOFER_API_KEY.' },
  402: { reason: 'quota',          code: 'resource-exhausted',  retryable: false,
         message: 'Instant Roofer Human Certified Report limit reached for this key.' },
  403: { reason: 'not-enabled',    code: 'failed-precondition', retryable: false,
         message: 'This Instant Roofer key is not enabled for v2 (or for Human Certified Reports).' },
  404: { reason: 'roof-not-found', code: 'not-found',           retryable: false,
         message: 'No roof at that point — put the pin on the centre of the building and try again.' },
  409: { reason: 'duplicate',      code: 'already-exists',      retryable: false,
         message: 'A Human Certified Report for these coordinates was ordered recently — wait for it instead of ordering again.' },
  422: { reason: 'unmeasurable',   code: 'failed-precondition', retryable: false,
         message: 'Instant Roofer could not measure this roof (too large or irregular) — measure manually or order a Human Certified Report.' },
  429: { reason: 'rate-limited',   code: 'resource-exhausted',  retryable: true,
         message: 'Instant Roofer rate limit — try again in a minute.' }
});
const VENDOR_ERROR = Object.freeze({
  reason: 'vendor-error', code: 'unavailable', retryable: true,
  message: 'Instant Roofer had an internal error — try again shortly.'
});

function classifyHttpError(status) {
  const s = intOrNull(status);
  if (s !== null && HTTP_ERRORS[s]) return Object.assign({ status: s }, HTTP_ERRORS[s]);
  return Object.assign({ status: s }, VENDOR_ERROR);
}

/**
 * Human-report completion/failure webhook. The payload keys are configured in
 * THEIR dashboard (each outgoing key maps to a static value or one of their
 * `order.*` / `report.*` dynamics), so this accepts both their documented
 * example (camelCase) and the snake_case dynamic names, and reads `status` as
 * either the string ("completed"/"failed") or the numeric `order.status_code`
 * their minimum-payload table maps it to.
 *
 * One completed report fires one webhook PER ENABLED FORMAT (csv/pdf/html/xml)
 * and retries can redeliver — the adapter merges `reportUrls` idempotently and
 * prefers the PDF as the headline `reportUrl`.
 */
function parseHumanWebhook(body) {
  if (!body || typeof body !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      if (body[k] !== undefined && body[k] !== null && body[k] !== '') return body[k];
    }
    return null;
  };
  const externalJobId = pick('requestId', 'request_id', 'requestID');
  if (!externalJobId) return null;

  const event = String(pick('event') || '').toLowerCase();
  const rawStatus = pick('status', 'order_status');
  const statusCode = intOrNull(pick('statusCode', 'status_code'));
  const reportUrl = pick('reportUrl', 'report_url', 'url');
  const failureReason = pick('failureReason', 'failure_reason');

  let status = 'pending';
  const statusStr = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : null;
  const statusNum = typeof rawStatus === 'number' ? rawStatus : null;
  if (statusStr === 'failed' || statusStr === 'rejected' || /\.failed$/.test(event)
      || (statusNum !== null && statusNum >= 400)
      || (statusCode !== null && statusCode >= 400 && !reportUrl)) {
    status = 'failed';
  } else if (statusStr === 'completed' || statusStr === 'complete' || /\.completed$/.test(event)
      || (statusNum !== null && statusNum >= 200 && statusNum < 300)
      || (statusStr === null && statusNum === null && reportUrl)) {
    status = 'ready';
  }

  const safeUrl = typeof reportUrl === 'string' && /^https:\/\//i.test(reportUrl) ? reportUrl : null;
  const reportType = String(pick('reportType', 'report_type') || '').toLowerCase() || null;

  return {
    externalJobId: String(externalJobId),
    humanReportId: pick('humanReportId', 'human_report_id', 'orderId', 'order_id'),
    status,
    reportType: reportType && /^(pdf|csv|html|xml)$/.test(reportType) ? reportType : null,
    reportUrl: safeUrl,
    failureReason: failureReason ? String(failureReason).slice(0, 500) : null
  };
}

// Headline URL for the merged per-format map: PDF first, then whatever came.
function preferredReportUrl(reportUrls) {
  if (!reportUrls || typeof reportUrls !== 'object') return null;
  if (reportUrls.pdf) return reportUrls.pdf;
  for (const k of ['html', 'csv', 'xml']) if (reportUrls[k]) return reportUrls[k];
  const first = Object.values(reportUrls).find(Boolean);
  return first || null;
}

// The webhook auth is a bearer token WE choose and paste into their dashboard
// ("If the token does not start with Bearer, Instant Roofer automatically
// prefixes it"). Constant-time compare; fails closed on anything malformed.
//
// A secret shorter than this is treated as NOT CONFIGURED, not as a wrong
// token — the receiver would answer 503 forever. measurement.js applies the
// same rule (webhookSecretReady) before letting anyone order a $10 human
// report, so the two sides cannot disagree about what "configured" means.
const MIN_WEBHOOK_SECRET_LEN = 16;

function verifyBearer(headerValue, secret) {
  if (typeof secret !== 'string' || secret.length < MIN_WEBHOOK_SECRET_LEN) return { ok: false, reason: 'secret-not-configured' };
  if (typeof headerValue !== 'string' || !headerValue) return { ok: false, reason: 'missing-authorization' };
  const provided = headerValue.replace(/^\s*Bearer\s+/i, '').trim();
  if (!provided) return { ok: false, reason: 'missing-token' };
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'token-mismatch' };
  return crypto.timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'token-mismatch' };
}

module.exports = {
  ENDPOINT,
  PROVIDER,
  MIN_WEBHOOK_SECRET_LEN,
  AI_RESULT_OPTIONS,
  COMPLEXITY_LABEL,
  HTTP_ERRORS,
  buildRequestBody,
  outlineImage,
  normalizeAiResponse,
  parseHumanAccepted,
  parseHumanWebhook,
  preferredReportUrl,
  classifyHttpError,
  validateCoords,
  coordKey,
  parsePitchRise,
  pitchFactor,
  wastePercent,
  confidenceLabel,
  verifyBearer
};
