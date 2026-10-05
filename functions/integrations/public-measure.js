/**
 * integrations/public-measure.js — measure a public estimate lead's roof
 *
 * The /estimate wizard's last step ("Verify Your Info to Unlock") captures a
 * name, an SMS-VERIFIED phone and an email, then shows a detailed estimate.
 * Until now that estimate's roof size came from a three-way tile
 * (small/typical/large → 14/20/30 squares) and a prompt asking Claude to
 * *guess* the square footage from the address. This measures the roof instead.
 *
 * ── WHY THE MONEY IS SPENT HERE AND NOWHERE ELSE ───────────────
 * An Instant Roofer AI measure costs $3. Exactly one thing in this file may
 * spend it — `measureNewWebLead`, a Firestore trigger that fires once per
 * created CRM lead. So the paid call is 1:1 with a real lead that carries a
 * verified phone number, and it happens whether or not the visitor sticks
 * around: Joe opens every web lead with real squares and pitch on it.
 *
 * `publicRoofMeasure` — the endpoint the anonymous wizard calls — CANNOT
 * spend. It only reads back what the trigger produced, waiting a few seconds
 * for it. That is deliberate: the public funnel has no CAPTCHA today (no
 * Turnstile widget is rendered on any page and TURNSTILE_SECRET is the deploy
 * stub), so no anonymous request may reach a metered vendor.
 *
 * ── WHY THE RESULT IS COPIED ONTO THE PUBLIC LEAD ──────────────
 * `measurements/{jobId}` is readable only by its owner uid or a platform admin
 * (firestore.rules), and the wizard's visitor is nobody. So the handful of
 * homeowner-safe numbers are copied onto the `estimate_leads/{id}` document as
 * `publicMeasurement`, and `publicRoofMeasure` serves that. Cost basis, vendor
 * payloads and internal ids never cross that line.
 */

'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { SECRETS, PROVIDERS } = require('./_shared');
const IR = require('./instantroofer-logic');
const measurement = require('./measurement');
const SOLAR = require('./solar-measure');
const { isWebLeadMeasureDisabled } = require('./killswitch');
const { bridgeDocId } = require('../lead-bridge-logic');

// ─── Only a lead the BRIDGE created may spend or write back ───
// A lead's publicLeadCollection / publicLeadId / webLead / publicLeadKind are
// plain fields a signed-in client can set on any lead it creates. Trusting them
// let a client (a) trigger the paid measurement for a hand-made lead and
// (b) aim the Admin-SDK write below at ANY `${collection}/${id}` in the
// database. The bridge writes its leads under a deterministic id
// (lead-bridge-logic bridgeDocId), the same proof lead-alert.js uses for
// Thumbtack. So: the collection is fixed, the id is validated, and the lead's
// own doc id must be the bridge id for that public doc. Returns the public
// estimate_leads id, or null.
const ESTIMATE_COLLECTION = 'estimate_leads';
function bridgedEstimateId(lead, leadId) {
  const l = lead || {};
  if (l.webLead !== true || l.publicLeadKind !== 'estimate') return null;
  if (l.publicLeadCollection !== ESTIMATE_COLLECTION) return null;
  const pubId = String(l.publicLeadId || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(pubId)) return null;
  if (String(leadId || '') !== bridgeDocId(ESTIMATE_COLLECTION, pubId)) return null;
  return pubId;
}
const { rateLimitIpKey, clientIp } = require('../rate-limit');

// A ceiling on AUTOMATED spend, independent of the per-rep and per-account
// meters the callable uses. Real volume is roughly one web lead a day (~32
// leads/month across every source, per the 2026-09 lead counters), so 25/day
// is ~25x headroom and still caps a runaway — a bot flood of form submissions,
// or a bug that re-fires the trigger — at $75 rather than unbounded.
const AUTO_MEASURE_DAILY_CAP = 25;

// The wizard shows a ~3.6 s loading animation and then calls the AI for the
// personalised note, so it can afford to wait a little for real numbers. Past
// this it falls back to the tile estimate rather than stalling the reveal.
const PUBLIC_WAIT_MS = 18000;
const PUBLIC_POLL_MS = 1500;

const CORS_ALLOW = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app'
];

function corsOrigin(req) {
  const o = String(req.headers.origin || '');
  return CORS_ALLOW.includes(o) ? o : CORS_ALLOW[0];
}

/**
 * The homeowner-safe subset. Squares and pitch are what the estimate is built
 * from; confidence is shown so a low-confidence roof reads as an approximation
 * rather than a promise. Nothing here reveals cost, provider job ids, or the
 * raw vendor payload.
 */
function publicSummary(m) {
  if (!m || !m.rawSqft) return null;
  return {
    sqft: Math.round(m.rawSqft),
    // Roof squares with waste EXCLUDED, always derived from rawSqft.
    //
    // NOT the vendor's `squares`. That field is `sqft.suggested / 100` — its
    // material-ORDER figure, waste already added (see normalizeAiResponse's
    // field-semantics comment, and the live sample: measured 3483 → 34.83,
    // suggested 4006 → squares 40.1). The public wizard multiplies whatever
    // arrives here by PRICING.roof bands that are themselves built as
    // rate × 1.12 .. rate × 1.25 — the CRM's pitch waste factor, baked in
    // (docs/assets/js/inline/4053149b2f.js:61-76 → tiersFromSquares :1161).
    // Feeding the vendor figure in counted waste twice and overstated the
    // homeowner's quote by ~15% (40.1/34.83): $26,675–$29,875 instead of
    // $23,150–$25,950 on that sample roof — above what the rep's own CRM can
    // quote it for, which is the exact "price jump between screens" the
    // PRICING block exists to prevent.
    //
    // It was also inconsistent three ways: with `sqft` on the same card
    // (3,483 sq ft printed beside "40.1 squares"), with the kanban chip's
    // stored `measurementSqft`, and with this line's own fallback branch —
    // so the same house priced 15% apart depending on whether one optional
    // vendor field happened to be present.
    squares: Math.round((m.rawSqft / 100) * 10) / 10,
    pitch: m.pitch || null,
    stories: m.stories != null ? m.stories : null,
    complexity: m.complexityLabel || null,
    confidence: (m.confidence && m.confidence.label) || null,
    measured: true
  };
}

/**
 * Measure the roof for a freshly bridged web lead, then copy the safe subset
 * back onto the public lead document the wizard can read.
 *
 * Idempotent on three levels: the trigger fires once per created lead;
 * `lead.measurementJobId` short-circuits a retry; and requestInstantRoofer's
 * own 90-day same-roof reuse means even a duplicated call does not re-bill.
 */
async function measureLeadAndPublish(db, { leadId, lead, deps, jobDocId, source, withOutline }) {
  // jobDocId / source / withOutline (2026-10-04): the CRM auto-order
  // (measure-auto-order.js) runs this same path for appointment-set and
  // inspected leads under its own deterministic id, and asks for the outline
  // image so the Draw tool can show it as a cross-check.
  const jobId = jobDocId || ('weblead-' + leadId);
  const jobSource = source || 'web-lead';
  if (!lead) return { ok: false, reason: 'no-lead' };
  if (lead.measurementJobId) return { ok: false, reason: 'already-measured' };

  const coords = IR.validateCoords(lead.lat, lead.lng);
  if (!coords.ok) return { ok: false, reason: 'no-coords' };
  // 'solar' / 'auto' (integrations/solar-measure.js) measure web leads too —
  // the public funnel is where most of the per-measure spend is.
  const mode = PROVIDERS.measurement;
  if (mode !== 'instantroofer' && mode !== 'solar' && mode !== 'auto') return { ok: false, reason: 'provider-unsupported' };

  const ownerId = lead.userId;
  if (!ownerId) return { ok: false, reason: 'no-owner' };

  const coordKey = IR.coordKey(coords.lat, coords.lng);
  const address = String(lead.address || '');

  // Same-roof reuse first — a repeat submission from the same household, or a
  // rep who already measured this address, must not buy a second report.
  let measurements = null;
  let reusedFrom = null;
  let outline = null;
  let provider = 'instantroofer';
  const prior = await measurement.findReusableMeasurement(db, {
    coordKey, uid: ownerId, companyId: lead.companyId || null, reportType: 'ai'
  }).catch(() => null);
  if (prior) {
    measurements = prior.data.measurements;
    reusedFrom = prior.id;
  } else {
    const ctx = {
      lat: coords.lat, lng: coords.lng, reportType: 'ai', address,
      customerName: [lead.firstName, lead.lastName].filter(Boolean).join(' ') || null,
      withOutline: withOutline === true
    };
    const callIR = (c) => measurement.requestInstantRoofer(c, deps || {});
    const result = mode === 'instantroofer'
      ? await callIR(ctx)
      : await SOLAR.runSolarProvider(
        Object.assign({}, ctx, { db, uid: ownerId, companyId: lead.companyId || null }),
        Object.assign({}, deps || {}, { mode, instantRoofer: callIR }));
    if (!result.ok) {
      logger.warn('public-measure: vendor call failed', { leadId, reason: result.reason, status: result.status });
      return { ok: false, reason: result.reason || 'vendor-error' };
    }
    measurements = result.measurements;
    outline = result.outline || null;
    provider = result.provider || 'instantroofer';
  }
  if (!measurements || !measurements.rawSqft) return { ok: false, reason: 'no-measurement' };

  // Deterministic id, written with create(): a Firestore trigger is
  // at-least-once, so a redelivery must collide here rather than buy a second
  // report. ALREADY_EXISTS is the success case for a duplicate.
  const jobRef = db.collection('measurements').doc(jobId);
  const jobDoc = {
    ownerId,
    companyId: lead.companyId || null,
    leadId,
    address: address || null,
    provider,
    reportType: 'ai',
    // provider + the job id: 'instantroofer-weblead-<leadId>' for a web lead
    // (unchanged), 'instantroofer-auto-<leadId>' for the CRM auto-order.
    externalJobId: reusedFrom ? null : (provider + '-' + jobId),
    status: 'ready',
    estimatedMinutes: 0,
    lat: coords.lat, lng: coords.lng,
    coordKey: reusedFrom ? null : coordKey,
    coordSource: 'lead', coordPrecision: 'geocoded',
    source: jobSource,
    ...(reusedFrom ? { reusedFrom, billed: false } : {}),
    // Billable like any other measurement (Jo, 2026-09-06); no document, so
    // the line reads as a service performed rather than a report.
    passThruEligible: true,
    passThruHasDocument: false,
    measurements,
    createdAt: FieldValue.serverTimestamp(),
    measuredAt: reusedFrom ? (prior.data.measuredAt || prior.data.createdAt || null) : FieldValue.serverTimestamp()
  };
  try {
    await jobRef.create(jobDoc);
  } catch (e) {
    if (e && e.code === 6) { // ALREADY_EXISTS — a redelivery got here first
      logger.info('public-measure: measurement already written for this lead', { leadId });
      return { ok: false, reason: 'already-measured' };
    }
    throw e;
  }

  // Light the CRM up exactly like a rep-ordered measurement does.
  await measurement.attachMeasurementToLead(db, {
    leadId, ownerId, address, provider, reportType: 'ai',
    measurementJobId: jobRef.id, measurements, dedupeKey: leadId + '|' + coordKey
  }).catch((e) => logger.warn('public-measure: lead attach failed', { leadId, err: e.message }));

  // The vendor's outline image, when it was asked for — stored under the lead
  // owner's private docs/ path (storage.rules: owner or platform admin read;
  // not under photos/, so the image pipeline never treats it as a job photo).
  // The Draw tool shows it beside the drawn totals as a cross-check.
  let outlinePath = null;
  if (outline && outline.buffer) {
    try {
      const ext = outline.contentType === 'image/png' ? 'png' : (outline.contentType === 'image/webp' ? 'webp' : 'jpg');
      outlinePath = `docs/${ownerId}/measurements/${leadId}-outline.${ext}`;
      const bucket = (deps && deps.bucket) || require('firebase-admin/storage').getStorage().bucket();
      await bucket.file(outlinePath).save(outline.buffer, {
        resumable: false,
        contentType: outline.contentType,
        metadata: { cacheControl: 'private, max-age=3600' }
      });
      await jobRef.set({ outlinePath }, { merge: true });
    } catch (e) {
      outlinePath = null;
      logger.warn('public-measure: outline save failed', { leadId, err: e && e.message });
    }
  }

  // Put the numbers somewhere Joe actually sees them. lead.measurementReady
  // only renders a chip, and leads/{id}/activity has no client reader at all —
  // without this the whole slice would be invisible in the CRM.
  const summary = publicSummary(measurements);
  // Rendered straight into the kanban card's HTML, where no escaper is in
  // scope, so it is built from numbers only and the vendor's pitch string is
  // admitted only in its exact `n/n` shape. The card re-validates the same
  // pattern before printing it (docs/pro/js/crm-pipeline.js) — a value that
  // fails either check degrades to the plain 'Measurement' chip.
  const safePitch = /^[0-9]{1,2}\/[0-9]{1,2}$/.test(String(summary && summary.pitch || '')) ? summary.pitch : null;
  const chip = summary
    ? Number(summary.squares).toFixed(1) + ' sq' + (safePitch ? ' · ' + safePitch : '')
    : null;
  if (chip) {
    await db.doc(`leads/${leadId}`).set({
      measurementSummary: chip,
      measurementSqft: summary.sqft,
      measurementSquares: summary.squares,
      measurementPitch: safePitch,
      measurementConfidence: summary.confidence || null,
      // Draw-tool cross-check (2026-10-04): the vendor footprint + perimeter
      // to compare with what the rep draws, and the outline image if stored.
      measurementFootprintSqft: (measurements.footprintSqft != null && isFinite(measurements.footprintSqft)) ? Math.round(measurements.footprintSqft) : null,
      measurementPerimeterLf: (measurements.perimeterLf != null && isFinite(measurements.perimeterLf)) ? Math.round(measurements.perimeterLf) : null,
      ...(outlinePath ? { measurementOutlinePath: outlinePath } : {})
    }, { merge: true }).catch((e) => logger.warn('public-measure: lead summary write failed', { leadId, err: e.message }));
  }

  // Copy the safe subset where the anonymous wizard can reach it.
  // Fixed collection + a bridge-proven id — never a path read off the lead.
  const pubId = bridgedEstimateId(lead, leadId);
  if (summary && pubId) {
    await db.collection(ESTIMATE_COLLECTION).doc(pubId).set({
      publicMeasurement: summary,
      publicMeasurementAt: FieldValue.serverTimestamp()
    }, { merge: true }).catch((e) => logger.warn('public-measure: public copy failed', { pubId, err: e.message }));
  }

  logger.info('public-measure: measured a web lead', {
    leadId, jobId: jobRef.id, reused: !!reusedFrom, sqft: summary && summary.sqft
  });
  return { ok: true, jobId: jobRef.id, measurements, summary, reused: !!reusedFrom };
}

// ─── The only thing here that spends money ─────────────────
// Fires on every created CRM lead; gated to bridged web leads that carry
// coordinates. A CRM-entered lead, a Thumbtack lead, or a lead whose address
// never geocoded is skipped and costs nothing.
exports.measureNewWebLead = onDocumentCreated(
  {
    document: 'leads/{leadId}',
    region: 'us-central1',
    timeoutSeconds: 60,
    memory: '256MiB',
    retry: false,
    secrets: [SECRETS.INSTANTROOFER_API_KEY, SECRETS.SOLAR_API_KEY]
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const lead = snap.data() || {};
    const leadId = event.params && event.params.leadId;

    if (lead.webLead !== true) return;
    if (lead.publicLeadKind !== 'estimate') return;
    // Paid call: only for a lead the bridge itself created (see bridgedEstimateId).
    if (!bridgedEstimateId(lead, leadId)) {
      logger.warn('public-measure: not a bridged estimate lead — no measurement', { leadId });
      return;
    }
    if (!IR.validateCoords(lead.lat, lead.lng).ok) {
      logger.info('public-measure: web lead has no usable coordinates, skipping', { leadId });
      return;
    }
    try {
      // One write to feature_flags/global stops the spend without a deploy
      // (runbooks/SPEND_KILLSWITCH.md).
      if (await isWebLeadMeasureDisabled()) {
        logger.warn('public-measure: skipped — webLeadMeasureDisabled flag is set', { leadId });
        return;
      }
      // Independent daily ceiling on automated spend. Deliberately NOT the
      // 5/min account meter the rep-facing callable uses: a storm-day burst of
      // web leads must not resource-exhaust the rep standing on a roof
      // pressing Auto-measure.
      const { enforceRateLimit } = require('./upstash-ratelimit');
      try {
        await enforceRateLimit('trigger:measureNewWebLead:daily', 'account', AUTO_MEASURE_DAILY_CAP, 24 * 60 * 60_000);
      } catch (rl) {
        if (rl && rl.rateLimited) {
          logger.error('public-measure: DAILY CAP HIT — web lead not measured', { leadId, cap: AUTO_MEASURE_DAILY_CAP });
          return;
        }
        throw rl;
      }
      const out = await measureLeadAndPublish(getFirestore(), { leadId, lead });
      if (!out.ok) logger.info('public-measure: no measurement written', { leadId, reason: out.reason });
    } catch (e) {
      // Never throw: this trigger must not retry a PAID call, and the lead
      // itself is already safely written.
      logger.error('public-measure: measureNewWebLead threw', { leadId, err: e && e.message });
    }
  }
);

// ─── Read-only endpoint for the anonymous wizard ────────────
// Spends nothing. Given the public lead id that submitPublicLead just
// returned, it waits briefly for the trigger's result and hands back the
// homeowner-safe summary. Anything it cannot answer is `{ ok:true,
// pending:true }` and the wizard quietly keeps its tile estimate.
exports.publicRoofMeasure = onRequest(
  { region: 'us-central1', timeoutSeconds: 30, memory: '256MiB', maxInstances: 10, cors: false },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', corsOrigin(req));
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

    const body = req.body || {};
    const kind = body.kind === 'estimate' ? 'estimate_leads' : null;
    const leadId = typeof body.leadId === 'string' ? body.leadId.trim() : '';
    if (!kind || !/^[A-Za-z0-9_-]{6,64}$/.test(leadId)) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    // No money is at stake, but an open endpoint still deserves a ceiling.
    try {
      const { enforceRateLimit } = require('./upstash-ratelimit');
      // rateLimitIpKey buckets IPv6 by /64 — a raw-address key is no cap at
      // all for a caller on a normal residential v6 allocation.
      await enforceRateLimit('public:roofMeasure:ip', rateLimitIpKey(clientIp(req)) || 'unknown', 60, 60 * 60_000);
    } catch (e) {
      if (e.rateLimited) { res.status(429).json({ error: 'Too many requests' }); return; }
    }

    const db = getFirestore();
    const ref = db.doc(`${kind}/${leadId}`);
    const deadline = Date.now() + PUBLIC_WAIT_MS;
    try {
      for (;;) {
        const snap = await ref.get();
        if (!snap.exists) { res.status(404).json({ error: 'Not found' }); return; }
        const d = snap.data() || {};
        if (d.publicMeasurement && d.publicMeasurement.measured) {
          res.status(200).json({ ok: true, pending: false, measurement: d.publicMeasurement });
          return;
        }
        if (Date.now() + PUBLIC_POLL_MS >= deadline) break;
        await new Promise((r) => setTimeout(r, PUBLIC_POLL_MS));
      }
      res.status(200).json({ ok: true, pending: true });
    } catch (e) {
      logger.error('publicRoofMeasure error', { err: e && e.message });
      // A read failure must never break the wizard's reveal.
      res.status(200).json({ ok: true, pending: true });
    }
  }
);

exports._test = { publicSummary, measureLeadAndPublish, bridgedEstimateId, PUBLIC_WAIT_MS, PUBLIC_POLL_MS, corsOrigin, AUTO_MEASURE_DAILY_CAP };

module.exports = exports;
