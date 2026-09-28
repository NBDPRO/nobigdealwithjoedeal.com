/**
 * integrations/measurement.js — aerial roof measurement adapter
 *
 * The #1 cost for a roofer today: $30–50/property for HOVER or
 * EagleView measurements. Integrating those APIs turns this from
 * a cost center into a margin opportunity — we can pass-through
 * bill and mark it up on the estimate.
 *
 * Supported providers (selected via NBD_MEASUREMENT_PROVIDER env):
 *   - instantroofer (default) — AI measure from coordinates, synchronous
 *                     10–20 s, plus a ~1 h Human Certified Report that
 *                     arrives by webhook (integrations/instantroofer-logic.js;
 *                     runbooks/INSTANTROOFER-SETUP.md)
 *   - hover               — cleanest API, best mobile UX
 *   - eagleview           — most coverage, older/stricter API
 *   - nearmap             — best for storm verification (temporal imagery)
 *
 * SETUP (pick one):
 *   firebase functions:secrets:set INSTANTROOFER_API_KEY
 *   firebase functions:secrets:set INSTANTROOFER_WEBHOOK_SECRET   # human reports only
 *   firebase functions:secrets:set HOVER_API_KEY
 *   firebase functions:secrets:set EAGLEVIEW_API_KEY
 *   firebase functions:secrets:set NEARMAP_API_KEY
 *
 * History worth knowing (2026-09-06): HOVER/EagleView/Nearmap have been wired
 * since April but none was ever configured — all three prod secrets are the
 * deploy's `__unset__` stub — so every click on the CRM's auto-measure and
 * D2D "order roof report" buttons has returned "not configured". Instant
 * Roofer is the first provider with a real key.
 *
 * CALLABLE: requestMeasurement({ address, leadId, lat, lng, reportType })
 *   Creates a Firestore `measurements/{jobId}` doc with status
 *   'pending', fires the async vendor job, then returns {jobId}.
 *   Synchronous providers (Instant Roofer AI, Nearmap) write the doc
 *   already 'ready' with `measurements` populated. A separate onRequest
 *   webhook endpoint receives vendor callbacks and updates the doc to
 *   'ready' + populates measurement fields.
 *
 * The V2 estimate builder reads from `measurements/{jobId}` to
 * pre-fill rawSqft, ridge, eave, hip, valley, pitch.
 */

'use strict';

const { onCall, HttpsError, onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { getSecret, hasSecret, secretValue, PROVIDERS, notConfigured, SECRETS } = require('./_shared');
const IR = require('./instantroofer-logic');
const geocodeHandlers = require('../handlers/geocode');
const { assertNotViewer } = require('../shared');

// Bare param that predates the SECRETS registry — declared the same way in
// handlers/geocode.js. Read ONLY through secretValue() so the deploy stub
// counts as unset (tests/secret-stub-guard.test.js).
const GOOGLE_GEOCODING_API_KEY = defineSecret('GOOGLE_GEOCODING_API_KEY');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app'
];

// A ready Instant Roofer measurement under the same coordinate key is reused
// for this long instead of billing the vendor again. Roofs do not change in
// 90 days; a rep re-opening an estimate should not cost a second report.
const REUSE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// Instant Roofer's published account limit is 5 requests/minute (API
// dashboard, read 2026-09-06). We meter it here so a burst of clicks gets a
// clean resource-exhausted instead of the vendor's 429.
const INSTANTROOFER_PER_MINUTE = 5;

// ─── Provider adapters ─────────────────────────────────────
// Each returns a shape {ok, jobId, estimatedMinutes} or
// {ok:false, reason}. We ALWAYS write a Firestore row first so the
// UI has something to poll — the vendor call can fill it in later.

async function requestHOVER(address, callerUid) {
  if (!hasSecret('HOVER_API_KEY')) return notConfigured('hover');
  const apiKey = getSecret('HOVER_API_KEY');
  try {
    const res = await fetch('https://api.hover.to/v2/jobs', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        address,
        measurement_type: 'roof',
        webhook_url: `https://us-central1-nobigdeal-pro.cloudfunctions.net/measurementWebhook?provider=hover`,
        reference_id: callerUid
      })
    });
    if (!res.ok) {
      const t = await res.text();
      logger.warn('HOVER job create failed', { status: res.status, body: t.slice(0, 200) });
      return { ok: false, reason: 'vendor-error', status: res.status };
    }
    const data = await res.json();
    return {
      ok: true,
      jobId: data.id || data.job_id,
      estimatedMinutes: data.estimated_turnaround_minutes || 30,
      provider: 'hover'
    };
  } catch (e) {
    logger.error('HOVER request error:', e.message);
    return { ok: false, reason: 'network' };
  }
}

async function requestEagleView(address, callerUid) {
  if (!hasSecret('EAGLEVIEW_API_KEY')) return notConfigured('eagleview');
  const apiKey = getSecret('EAGLEVIEW_API_KEY');
  try {
    const res = await fetch('https://apis.eagleview.com/property-measurements/v3/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        address,
        product: 'premium_residential',
        deliveryMethod: 'webhook',
        webhookUrl: `https://us-central1-nobigdeal-pro.cloudfunctions.net/measurementWebhook?provider=eagleview`,
        customerReference: callerUid
      })
    });
    if (!res.ok) {
      return { ok: false, reason: 'vendor-error', status: res.status };
    }
    const data = await res.json();
    return { ok: true, jobId: data.orderId, estimatedMinutes: 240, provider: 'eagleview' };
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
}

async function requestNearmap(address, callerUid) {
  if (!hasSecret('NEARMAP_API_KEY')) return notConfigured('nearmap');
  // Nearmap AI Feature Pack doesn't have a "job" concept the way
  // HOVER does — it's synchronous. Call the AI endpoint directly.
  const apiKey = getSecret('NEARMAP_API_KEY');
  try {
    const res = await fetch(
      `https://api.nearmap.com/ai/features/v4/features.json?address=${encodeURIComponent(address)}&apikey=${apiKey}`,
      { method: 'GET' }
    );
    if (!res.ok) return { ok: false, reason: 'vendor-error', status: res.status };
    const data = await res.json();
    // Nearmap returns features directly — mint our own jobId so the
    // downstream shape is consistent.
    return {
      ok: true,
      jobId: 'nearmap-' + Date.now(),
      estimatedMinutes: 0,
      provider: 'nearmap',
      synchronousData: data
    };
  } catch (e) {
    return { ok: false, reason: 'network' };
  }
}

/**
 * Instant Roofer — POST {latitude, longitude} to v5.instantroofer.com/v2.
 *
 * ctx: { lat, lng, address, reportType: 'ai'|'human', customerName, contractorName }
 * deps.fetchImpl / deps.now exist for tests; production callers pass none.
 *
 * AI (default): synchronous, 10–20 s, returns the normalized `measurements`
 * straight away (no webhook, no polling). The jobId is minted locally like
 * Nearmap's because the vendor returns no id for an AI measure.
 *
 * Human ("reportType":"human"): the vendor queues a drawing-team report and
 * answers {requestId, humanReportId}; the file URL arrives ~60 min later on
 * measurementWebhook?provider=instantroofer. requestId is the externalJobId
 * the webhook matches on.
 */
async function requestInstantRoofer(ctx, deps) {
  deps = deps || {};
  if (!hasSecret('INSTANTROOFER_API_KEY')) return notConfigured('instantroofer');
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || Date.now;
  const apiKey = getSecret('INSTANTROOFER_API_KEY');
  const reportType = ctx.reportType === 'human' ? 'human' : 'ai';
  const body = IR.buildRequestBody(ctx.lat, ctx.lng, {
    reportType,
    address: ctx.address,
    customerName: ctx.customerName,
    contractorName: ctx.contractorName
  });

  let res;
  try {
    res = await fetchImpl(IR.ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(body),
      // The callable has 60 s; leave room for the Firestore writes after.
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(45000) : undefined
    });
  } catch (e) {
    logger.error('Instant Roofer request error:', e && e.message);
    return { ok: false, reason: 'network', provider: 'instantroofer' };
  }

  if (!res.ok) {
    const err = IR.classifyHttpError(res.status);
    let text = '';
    try { text = String(await res.text()).slice(0, 300); } catch (_) {}
    logger.warn('Instant Roofer request failed', {
      status: res.status, reason: err.reason, reportType, body: text
    });
    return {
      ok: false, provider: 'instantroofer',
      reason: err.reason, status: res.status, code: err.code, message: err.message
    };
  }

  let data;
  try { data = await res.json(); } catch (e) {
    logger.warn('Instant Roofer: non-JSON body on 2xx', { reportType });
    return { ok: false, reason: 'bad-json', provider: 'instantroofer' };
  }

  if (reportType === 'human') {
    const acc = IR.parseHumanAccepted(data);
    if (!acc) {
      logger.warn('Instant Roofer: human order ack had no requestId', { keys: Object.keys(data || {}) });
      return { ok: false, reason: 'bad-ack', provider: 'instantroofer' };
    }
    return {
      ok: true,
      provider: 'instantroofer',
      reportType: 'human',
      jobId: acc.externalJobId,
      humanReportId: acc.humanReportId,
      estimatedMinutes: 60
    };
  }

  const measurements = IR.normalizeAiResponse(data);
  if (measurements.rawSqft === null) {
    // A 200 with no area is a vendor-side miss (they document 404 for "no
    // roof", but be defensive) — do not write a 'ready' doc with nothing in it.
    logger.warn('Instant Roofer: 2xx without a roof area', { keys: Object.keys(data || {}) });
    return { ok: false, reason: 'no-measurement', provider: 'instantroofer' };
  }
  return {
    ok: true,
    provider: 'instantroofer',
    reportType: 'ai',
    jobId: 'instantroofer-' + now(),
    estimatedMinutes: 0,
    measurements,
    // Kept for the audit trail minus the two blobs (base64 image, LiDAR
    // points) that would blow the 1 MiB doc cap — see stripVendorBlobs().
    synchronousData: stripVendorBlobs(data)
  };
}

function stripVendorBlobs(data) {
  if (!data || typeof data !== 'object') return null;
  const out = Object.assign({}, data);
  if (out.imagery) out.imagery = { mapWithOutline: out.imagery.mapWithOutline ? '[stripped]' : null };
  if (out.lidar) out.lidar = { facets: out.lidar.facets || null, roofPointsFacetedXYZK: '[stripped]' };
  return out;
}

// Provider registry. `needsCoords` providers locate the roof from a point;
// the legacy three take the address string. Unknown values return null so
// the callable fails loudly — the old `return requestHOVER; // default`
// meant a typo in NBD_MEASUREMENT_PROVIDER silently billed the wrong vendor.
function selectProvider() {
  const p = PROVIDERS.measurement;
  if (p === 'instantroofer') return { name: p, needsCoords: true,  run: requestInstantRoofer };
  if (p === 'hover')         return { name: p, needsCoords: false, run: (ctx) => requestHOVER(ctx.address, ctx.uid) };
  if (p === 'eagleview')     return { name: p, needsCoords: false, run: (ctx) => requestEagleView(ctx.address, ctx.uid) };
  if (p === 'nearmap')       return { name: p, needsCoords: false, run: (ctx) => requestNearmap(ctx.address, ctx.uid) };
  return null;
}

// ─── Coordinates ───────────────────────────────────────────
// Instant Roofer locates the roof from a point ("make sure your
// latitude/longitude is in the center of a building"), so an address alone
// is not enough. Resolution order, most rooftop-accurate first:
//   1. explicit {lat,lng} from the caller — a D2D knock pin, or the
//      public wizard's geocode
//   2. the lead doc: lead.lat/lead.lng (CRM Nominatim at save time), then
//      lead.parcel.center (Regrid parcel centroid)
//   3. server forward geocode — Google (ROOFTOP only) → Regrid → Nominatim,
//      each only when configured. In prod today only Nominatim is (the
//      Google and Regrid keys are the deploy stub), and Nominatim is
//      street-interpolated wherever OSM lacks the building footprint, so
//      the doc records coordSource/coordPrecision and the UI can ask the
//      rep to confirm the outlined building before pricing off it.
// Nominatim results are cached in geocode_cache/ like handlers/geocode.js.
const NOMINATIM_UA = 'NoBigDealCRM/1.0 (+https://nobigdealwithjoedeal.com)';

function leadCoords(lead) {
  if (!lead || typeof lead !== 'object') return null;
  const direct = IR.validateCoords(lead.lat, lead.lng);
  if (direct.ok) return { lat: direct.lat, lng: direct.lng, source: 'lead', precision: 'geocoded' };
  const c = lead.parcel && lead.parcel.center;
  const parcel = c ? IR.validateCoords(c.lat, c.lng) : { ok: false };
  if (parcel.ok) return { lat: parcel.lat, lng: parcel.lng, source: 'parcel', precision: 'parcel-centroid' };
  return null;
}

async function geocodeNominatim(address, deps) {
  const fetchImpl = (deps && deps.fetchImpl) || fetch;
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&q='
    + encodeURIComponent(address);
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': NOMINATIM_UA, 'Accept': 'application/json' },
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
  });
  if (!res.ok) return null;
  const rows = await res.json();
  const row = Array.isArray(rows) && rows[0];
  if (!row) return null;
  const v = IR.validateCoords(row.lat, row.lon);
  if (!v.ok) return null;
  return {
    lat: v.lat, lng: v.lng, source: 'nominatim',
    // OSM has the building → the point is on it; otherwise it was
    // interpolated along the street and may sit on the neighbour.
    precision: row.class === 'building' || row.category === 'building' ? 'building' : 'interpolated',
    displayName: row.display_name || null
  };
}

async function resolveCoords({ lat, lng, lead, address, db }, deps) {
  deps = deps || {};
  if (lat !== undefined && lat !== null && lng !== undefined && lng !== null) {
    const v = IR.validateCoords(lat, lng);
    if (v.ok) return { lat: v.lat, lng: v.lng, source: 'client', precision: 'client' };
  }
  const fromLead = leadCoords(lead);
  if (fromLead) return fromLead;
  if (!address) return null;

  // Both legs are injectable so a test can exercise the fallback ladder
  // without the global fetch — otherwise a machine that HAS these keys makes
  // real outbound calls from the unit suite and the cache assertion is a lie.
  const googleForward = deps.googleForward || geocodeHandlers._googleForward;
  const regridAddress = deps.regridAddress || geocodeHandlers._regridAddress;
  const gKey = secretValue(GOOGLE_GEOCODING_API_KEY);
  if (gKey && gKey.startsWith('AIza')) {
    try {
      const g = await googleForward(address, gKey);
      if (g && g.precision === 'ROOFTOP' && IR.validateCoords(g.lat, g.lng).ok) {
        return { lat: g.lat, lng: g.lng, source: 'google', precision: 'rooftop' };
      }
    } catch (e) { logger.warn('google forward (measurement)', e && e.message); }
  }
  if (hasSecret('REGRID_API_TOKEN')) {
    try {
      const r = await regridAddress(address, getSecret('REGRID_API_TOKEN'));
      if (r && IR.validateCoords(r.lat, r.lng).ok) {
        return { lat: r.lat, lng: r.lng, source: 'regrid', precision: 'parcel-centroid' };
      }
    } catch (e) { logger.warn('regrid address (measurement)', e && e.message); }
  }

  const cacheKey = 'fwd-nominatim:' + address.toLowerCase().replace(/\s+/g, ' ');
  if (db) {
    const cached = await geocodeHandlers._readCache(db, cacheKey);
    if (cached && IR.validateCoords(cached.lat, cached.lng).ok) return Object.assign({ cached: true }, cached);
  }
  try {
    const n = await geocodeNominatim(address, deps);
    if (n) {
      if (db) await geocodeHandlers._writeCache(db, cacheKey, n);
      return n;
    }
  } catch (e) { logger.warn('nominatim forward (measurement)', e && e.message); }
  return null;
}

// ─── Reuse: same roof, same tenant, last 90 days ───────────
// Equality filters only — Firestore serves those from the automatic
// single-field indexes (CI never deploys firestore.indexes.json, so no
// composite), and an equality-only query cannot carry an orderBy without one.
// That matters: the rows come back in document-ID order, which is random, so
// the limit is a BLIND window — anything past it is invisible and we re-bill.
// The population is therefore kept at ~one doc per roof per tenant: only
// vendor-billed originals carry `coordKey`, reuse copies deliberately do not
// (see the copy below), so N does not grow by one on every cache hit.
// Age is measured from `measuredAt` — when the vendor was actually called —
// NOT from createdAt. A reuse copy is itself a candidate for the next reuse,
// so stamping the copy's own creation time would restamp the roof as fresh on
// every hit and the 90-day window would never expire.
function measuredAtMs(d) {
  const t = d.measuredAt || d.createdAt;
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null;
}

async function findReusableMeasurement(db, { coordKey, uid, companyId, reportType }) {
  const snap = await db.collection('measurements')
    .where('coordKey', '==', coordKey)
    .where('provider', '==', 'instantroofer')
    .limit(50)
    .get();
  const cutoff = Date.now() - REUSE_WINDOW_MS;
  const rows = snap.docs
    .map(d => ({ id: d.id, data: d.data() || {}, at: measuredAtMs(d.data() || {}) }))
    .filter(({ data: d, at }) =>
      d.status === 'ready'
      && (d.reportType || 'ai') === reportType
      && d.measurements && d.measurements.rawSqft
      && (d.ownerId === uid || (companyId && d.companyId === companyId))
      && at !== null && at > cutoff);
  rows.sort((a, b) => b.at - a.at);
  return rows[0] || null;
}

// ─── Attach a ready measurement to its lead ────────────────
// Shared by the synchronous path and the webhook so a same-second Instant
// Roofer result lights the kanban chip exactly like an hours-later HOVER
// callback. The task goes on leads/{leadId}/tasks — the collection every
// task UI reads; the top-level `tasks` write this used to make has had no
// reader since migration 006-unify-tasks.
async function attachMeasurementToLead(db, { leadId, ownerId, address, provider, reportType, measurementJobId, measurements, dedupeKey }) {
  if (!leadId || !ownerId) return false;
  const addr = address || '(address unknown)';
  const providerLabel = provider === 'instantroofer'
    ? (reportType === 'human' ? 'Instant Roofer (human certified)' : 'Instant Roofer (AI)')
    : String(provider || 'provider').toUpperCase();
  const m = measurements || {};
  const summary = (m.rawSqft ? Math.round(m.rawSqft) + ' SF roof, ' : '')
    + (m.pitch ? 'pitch ' + m.pitch + ', ' : '')
    + (m.ridge ? m.ridge + ' LF ridge' : '')
    + (m.confidence && m.confidence.label ? ' (' + m.confidence.label.toLowerCase() + ' confidence)' : '');

  // Deterministic id so repeat Auto-measure clicks on the same roof collapse
  // into ONE task instead of stacking identical rows in the lead's task list.
  const taskId = 'measure-' + crypto.createHash('sha1')
    .update(String(dedupeKey || measurementJobId)).digest('hex').slice(0, 20);
  // dueDate is the field every task surface reads — docs/pro/js/tasks.js and
  // notif-bell.js both do `t.dueDate ? new Date(t.dueDate + 'T23:59:59') : null`
  // and return early on null, so the '' this used to write meant the alert
  // never appeared in Today's Tasks or the bell. dueAt has no reader at all.
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().slice(0, 10);
  await db.doc(`leads/${leadId}/tasks/${taskId}`).set({
    userId: ownerId,
    leadId,
    title: 'Aerial measurement ready — ' + addr,
    text: 'Aerial measurement ready — ' + addr,
    notes: providerLabel + ' returned measurements for this property. Open the V2 Builder to load into an estimate.',
    source: 'measurement',
    provider,
    measurementJobId,
    dueDate: today,
    dueAt: Timestamp.now(),
    createdAt: FieldValue.serverTimestamp(),
    done: false
  }, { merge: true });

  // Activity: structured timeline entry on the lead. Rules
  // already allow the rep to read this subcollection. Same deterministic id,
  // so a re-measure updates the entry rather than adding a duplicate row.
  await db.doc(`leads/${leadId}/activity/${taskId}`).set({
    userId: ownerId,
    type: 'measurement_ready',
    source: 'webhook',
    label: providerLabel + ' measurement ready',
    provider,
    measurementJobId,
    reportUrl: m.reportUrl || null,
    summary: summary.replace(/,\s*$/, '') || null,
    createdAt: FieldValue.serverTimestamp()
  }, { merge: true });

  // Also bump a lead field so the kanban card can show
  // "📐 Measurement ready" without a join query.
  await db.doc(`leads/${leadId}`).set({
    measurementReady: true,
    measurementJobId,
    measurementProvider: provider,
    measurementReadyAt: FieldValue.serverTimestamp()
  }, { merge: true });
  return true;
}

// ─── Callable: requestMeasurement ──────────────────────────
exports.requestMeasurement = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    // Instant Roofer answers in 10–20 s; the old 30 s left no room for the
    // lead read, a geocode and the Firestore writes after a paid call.
    timeoutSeconds: 60,
    memory: '256MiB',
    secrets: [
      SECRETS.HOVER_API_KEY, SECRETS.EAGLEVIEW_API_KEY, SECRETS.NEARMAP_API_KEY,
      SECRETS.INSTANTROOFER_API_KEY, SECRETS.INSTANTROOFER_WEBHOOK_SECRET,
      SECRETS.REGRID_API_TOKEN, GOOGLE_GEOCODING_API_KEY
    ]
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    const token = request.auth.token || {};
    // 2026-09-25 (decision B): a viewer is read-only. This places a PAID
    // provider order and writes the result onto the lead, and the lead check
    // below admits any same-company member — refused before any spend.
    assertNotViewer(token);

    // D1: measurement jobs cost real money per provider API call.
    // Cap at 20/hour/uid so a runaway loop or malicious caller
    // can't $-bomb us.
    const { enforceRateLimit } = require('./upstash-ratelimit');
    try {
      await enforceRateLimit('callable:requestMeasurement:uid', uid, 20, 60 * 60_000);
    } catch (e) {
      if (e.rateLimited) {
        throw new HttpsError('resource-exhausted',
          'Measurement rate limit — try again in an hour (or contact support).');
      }
      throw e;
    }

    const data = request.data || {};
    const address = typeof data.address === 'string' ? data.address.trim() : '';
    if (address && (address.length < 5 || address.length > 500)) {
      throw new HttpsError('invalid-argument', 'Valid address required');
    }
    const leadId = typeof data.leadId === 'string' ? data.leadId : null;
    const reportType = data.reportType === 'human' ? 'human' : 'ai';

    let clientCoords = null;
    if (data.lat != null || data.lng != null) {
      const v = IR.validateCoords(data.lat, data.lng);
      if (!v.ok) throw new HttpsError('invalid-argument', 'Valid lat/lng required');
      clientCoords = { lat: v.lat, lng: v.lng };
    }
    if (!address && !clientCoords) {
      throw new HttpsError('invalid-argument', 'Address or coordinates required');
    }

    const provider = selectProvider();
    if (!provider) {
      throw new HttpsError('failed-precondition',
        `Unknown measurement provider '${PROVIDERS.measurement}' — check NBD_MEASUREMENT_PROVIDER.`);
    }
    if (!provider.needsCoords && !address) {
      throw new HttpsError('invalid-argument', 'Valid address required');
    }

    const db = getFirestore();

    // Verify the caller owns (or is same-tenant staff for) the lead BEFORE
    // spending a paid measurement — the webhook later writes measurementReady +
    // an activity entry onto leads/{leadId} via the admin SDK (bypassing rules),
    // so an unchecked leadId let a rep stamp a spoofed measurement onto another
    // tenant's lead. Mirrors the est.userId===uid check in sendEstimateForSignature.
    let lead = null;
    if (leadId) {
      const leadSnap = await db.doc(`leads/${leadId}`).get();
      if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
      lead = leadSnap.data() || {};
      const owns = lead.userId === uid
        || (token.companyId && lead.companyId && token.companyId === lead.companyId)
        || token.role === 'admin';
      if (!owns) throw new HttpsError('permission-denied', 'Not your lead');
    }

    const ctx = {
      uid,
      address: address || (lead && lead.address) || '',
      reportType,
      customerName: lead ? [lead.firstName, lead.lastName].filter(Boolean).join(' ') : null,
      contractorName: token.companyName || null
    };

    let coords = null;
    if (provider.needsCoords) {
      if (reportType === 'human') {
        // Their dashboard refuses the order too, but fail here with the
        // reason: a report we cannot receive is $10 for nothing. Use the
        // RECEIVER's definition of configured — hasSecret() alone would pass a
        // 12-character token that verifyBearer then rejects as unconfigured,
        // answering 503 to every delivery of a report we had already paid for.
        if (!webhookSecretReady()) {
          throw new HttpsError('failed-precondition',
            'Human Certified Reports need the Instant Roofer webhook configured first — set INSTANTROOFER_WEBHOOK_SECRET to the token from their Webhook Delivery form (at least '
            + IR.MIN_WEBHOOK_SECRET_LEN + ' characters).');
        }
        // $10 a call, and the 90-day reuse guard above is AI-only, so this is
        // the only spend cap on the expensive path. Two per hour per rep is
        // well above real use (a rep orders one when a quote is going out) and
        // well below what a runaway loop or a console-driven abuse costs.
        try {
          await enforceRateLimit('callable:requestMeasurement:human:uid', uid, 2, 60 * 60_000);
          await enforceRateLimit('callable:requestMeasurement:human:account', 'account', 20, 24 * 60 * 60_000);
        } catch (e) {
          if (e.rateLimited) {
            throw new HttpsError('resource-exhausted',
              'Human Certified Report limit reached (2/hour per rep, 20/day per company). Contact support to raise it.');
          }
          throw e;
        }
      }
      coords = await resolveCoords({
        lat: clientCoords && clientCoords.lat,
        lng: clientCoords && clientCoords.lng,
        lead, address: ctx.address, db
      });
      if (!coords) {
        throw new HttpsError('failed-precondition',
          'Could not place this address on a map — open the lead on the map, drop the pin on the roof, and try again.');
      }
      ctx.lat = coords.lat;
      ctx.lng = coords.lng;
      ctx.coordKey = IR.coordKey(coords.lat, coords.lng);

      // Same roof, same tenant, last 90 days → copy instead of re-billing.
      // The copy is a fresh doc owned by the caller because measurements/
      // rules are uid-scoped (firestore.rules), so a colleague's job can't
      // simply be pointed at.
      if (reportType === 'ai') {
        const prior = await findReusableMeasurement(db, {
          coordKey: ctx.coordKey, uid, companyId: token.companyId || null, reportType
        });
        if (prior) {
          const copy = {
            ownerId: uid,
            companyId: token.companyId || null,
            leadId,
            address: ctx.address || null,
            provider: 'instantroofer',
            reportType,
            externalJobId: prior.data.externalJobId || null,
            status: 'ready',
            estimatedMinutes: 0,
            lat: coords.lat, lng: coords.lng,
            // Deliberately NO coordKey: a copy must not become a reuse
            // candidate itself, or the blind window above fills with copies
            // and the original becomes unfindable. lat/lng + reusedFrom keep
            // the audit trail.
            coordSource: coords.source, coordPrecision: coords.precision || null,
            reusedFrom: prior.id,
            // We were not billed for this one (it is a copy of a measurement
            // already paid for), but the customer receives the same work, so
            // it stays pass-through eligible.
            billed: false,
            passThruEligible: true,
            passThruHasDocument: false,
            measurements: prior.data.measurements,
            createdAt: FieldValue.serverTimestamp(),
            // Inherited, never restamped — see measuredAtMs().
            measuredAt: prior.data.measuredAt || prior.data.createdAt || null
          };
          const ref = await db.collection('measurements').add(copy);
          await attachMeasurementToLead(db, {
            leadId, ownerId: uid, address: ctx.address, provider: 'instantroofer', reportType,
            measurementJobId: ref.id, measurements: prior.data.measurements,
            dedupeKey: leadId + '|' + ctx.coordKey
          });
          return {
            jobId: ref.id, externalJobId: copy.externalJobId, provider: 'instantroofer',
            status: 'ready', estimatedMinutes: 0, reportType, cached: true,
            passThruEligible: true, passThruHasDocument: false,
            coordSource: coords.source, coordPrecision: coords.precision || null,
            measurements: prior.data.measurements
          };
        }
      }

      // Vendor-side limit is 5/min per account; meter it before we hit it.
      try {
        await enforceRateLimit('callable:requestMeasurement:instantroofer', 'account', INSTANTROOFER_PER_MINUTE, 60_000);
      } catch (e) {
        if (e.rateLimited) {
          throw new HttpsError('resource-exhausted',
            'Instant Roofer allows 5 measurements a minute — wait a moment and try again.');
        }
        throw e;
      }
    }

    const result = await provider.run(ctx);

    if (!result.ok) {
      if (result.configured === false) {
        throw new HttpsError('failed-precondition',
          `Measurement provider '${result.provider}' not configured. Contact support.`);
      }
      if (result.code && result.message) {
        // Classified vendor error (Instant Roofer): surface the real reason.
        throw new HttpsError(result.code, result.message);
      }
      throw new HttpsError('internal', 'Measurement request failed: ' + (result.reason || 'unknown'));
    }

    const measurements = result.measurements
      || (result.synchronousData && !result.measurements ? (parseSync(result.synchronousData).measurements || null) : null);
    const status = measurements ? 'ready' : 'pending';

    const doc = {
      ownerId: uid,
      companyId: token.companyId || null,
      leadId: leadId,
      address: ctx.address || null,
      provider: result.provider,
      reportType: result.reportType || 'ai',
      externalJobId: result.jobId,
      status,
      estimatedMinutes: result.estimatedMinutes,
      createdAt: FieldValue.serverTimestamp(),
      // When the vendor was actually called. Reuse ages off this, so a copy
      // inherits it instead of looking freshly measured.
      measuredAt: FieldValue.serverTimestamp(),
      ...(coords ? {
        lat: coords.lat, lng: coords.lng, coordKey: ctx.coordKey,
        coordSource: coords.source, coordPrecision: coords.precision || null
      } : {}),
      ...(result.humanReportId ? { humanReportId: result.humanReportId } : {}),
      // Every measurement is pass-through eligible (Jo, 2026-09-06 — the
      // measurement is work performed for the customer whether or not a
      // document changes hands). What DOES differ is the wording on the line:
      // an AI measure produces no document, so the client bills it as a
      // service performed rather than a "report" the homeowner could ask to
      // see. Read by the V2 builder and admin analytics.
      passThruEligible: true,
      // Drives the line-item wording client-side. True only when the vendor
      // actually hands us a document (HOVER/EagleView PDF, human report).
      passThruHasDocument: !(result.provider === 'instantroofer' && (result.reportType || 'ai') === 'ai'),
      ...(measurements ? { measurements } : {}),
      ...(result.synchronousData && result.provider === 'instantroofer' ? { vendorResponse: result.synchronousData } : {})
    };
    const ref = await db.collection('measurements').add(doc);

    if (status === 'ready') {
      await attachMeasurementToLead(db, {
        leadId, ownerId: uid, address: ctx.address, provider: result.provider,
        reportType: doc.reportType, measurementJobId: ref.id, measurements,
        dedupeKey: ctx.coordKey ? leadId + '|' + ctx.coordKey : null
      });
    }

    return {
      jobId: ref.id,
      externalJobId: result.jobId,
      provider: result.provider,
      status,
      estimatedMinutes: result.estimatedMinutes,
      reportType: doc.reportType,
      cached: false,
      passThruEligible: doc.passThruEligible,
      passThruHasDocument: doc.passThruHasDocument,
      ...(coords ? { coordSource: coords.source, coordPrecision: coords.precision || null } : {}),
      ...(measurements ? { measurements } : {})
    };
  }
);

// Normalize synchronous provider data (Nearmap) into our own shape.
function parseSync(data) {
  if (!data || !Array.isArray(data.features)) return {};
  const roof = data.features.find(f => f.classId && /roof/i.test(f.classId)) || {};
  return {
    measurements: {
      rawSqft: roof.areaSqft || null,
      pitch:   roof.pitch    || null,
      // Nearmap doesn't always return ridge/eave separately.
      source: 'nearmap-ai'
    }
  };
}

// ─── Webhook: provider pushes completed job ─────────────────
// Configure each vendor to POST back to
//   https://us-central1-nobigdeal-pro.cloudfunctions.net/measurementWebhook?provider=hover
//   https://us-central1-nobigdeal-pro.cloudfunctions.net/measurementWebhook?provider=instantroofer
//
// F-02: vendor signatures are now VERIFIED. Previously the endpoint
// accepted any POST that named a provider, letting an attacker forge
// roof-measurement updates against any known externalJobId. Fail
// closed unless the webhook secret for the provider is set AND the
// signature matches.
//
// Per-provider verification:
//   HOVER         — HMAC SHA-256 of rawBody with HOVER_WEBHOOK_SECRET,
//                   hex in X-Hover-Signature.
//   EAGLEVIEW     — HMAC SHA-256 of rawBody with EAGLEVIEW_WEBHOOK_SECRET,
//                   hex in X-EV-Signature. (EagleView docs describe a JWT
//                   variant; if/when we negotiate that, swap in a JWKS
//                   fetch here — HMAC is the baseline both vendors support.)
//   INSTANTROOFER — no HMAC on offer; a bearer token WE mint and paste into
//                   their dashboard, sent as `Authorization: Bearer …`,
//                   compared constant-time against INSTANTROOFER_WEBHOOK_SECRET.
function verifyWebhookHmac(provider, rawBody, headerValue) {
  const secretName = provider === 'hover'
    ? 'HOVER_WEBHOOK_SECRET'
    : provider === 'eagleview'
      ? 'EAGLEVIEW_WEBHOOK_SECRET'
      : null;
  if (!secretName) return { ok: false, reason: 'unknown-provider' };
  if (!hasSecret(secretName)) return { ok: false, reason: 'secret-not-configured' };
  if (!rawBody || !Buffer.isBuffer(rawBody)) return { ok: false, reason: 'missing-raw-body' };
  if (typeof headerValue !== 'string' || headerValue.length < 8) {
    return { ok: false, reason: 'missing-signature' };
  }
  // Some vendors send "sha256=<hex>"; tolerate both shapes.
  const provided = headerValue.replace(/^sha256=/i, '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return { ok: false, reason: 'malformed-signature' };
  const expected = crypto
    .createHmac('sha256', getSecret(secretName))
    .update(rawBody)
    .digest('hex');
  // Constant-time compare — both are 64-byte hex so length is fixed.
  const a = Buffer.from(provided, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'length-mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature-mismatch' };
  return { ok: true };
}

// One definition of "the webhook is configured", used by both the receiver and
// the callable's human-order gate.
function webhookSecretReady() {
  if (!hasSecret('INSTANTROOFER_WEBHOOK_SECRET')) return false;
  const s = getSecret('INSTANTROOFER_WEBHOOK_SECRET');
  return typeof s === 'string' && s.length >= IR.MIN_WEBHOOK_SECRET_LEN;
}

function verifyInstantRooferBearer(headerValue) {
  if (!hasSecret('INSTANTROOFER_WEBHOOK_SECRET')) return { ok: false, reason: 'secret-not-configured' };
  return IR.verifyBearer(headerValue, getSecret('INSTANTROOFER_WEBHOOK_SECRET'));
}

// Vendor payload → { externalJobId, status, measurements, human } or null
// when the provider is unknown. Pure; exercised directly by the tests.
function normalizeWebhookPayload(provider, body) {
  body = body || {};
  if (provider === 'hover') {
    return {
      externalJobId: body.job_id || body.id,
      status: body.status === 'completed' ? 'ready' : 'pending',
      measurements: body.measurements ? {
        rawSqft: body.measurements.total_facets_area_sqft,
        ridge:   body.measurements.ridge_linear_feet,
        eave:    body.measurements.eave_linear_feet,
        hip:     body.measurements.hip_linear_feet,
        valley:  body.measurements.valley_linear_feet,
        rake:    body.measurements.rake_linear_feet,
        pitch:   body.measurements.predominant_pitch,
        reportUrl: body.report_url || null
      } : null
    };
  }
  if (provider === 'eagleview') {
    const m = body.measurementReport || {};
    return {
      externalJobId: body.orderId,
      status: body.status === 'Completed' ? 'ready' : 'pending',
      measurements: m ? {
        rawSqft: m.totalRoofArea,
        ridge:   m.totalRidges,
        eave:    m.totalEaves,
        hip:     m.totalHips,
        valley:  m.totalValleys,
        rake:    m.totalRakes,
        pitch:   m.predominantPitch,
        reportUrl: body.documentUrl || null
      } : null
    };
  }
  if (provider === 'instantroofer') {
    const wh = IR.parseHumanWebhook(body);
    if (!wh) return { externalJobId: null, status: 'pending', measurements: null, human: null };
    // The human-report payload carries a file URL per format, never the
    // numbers; those stay whatever the AI measure (if any) already wrote.
    return { externalJobId: wh.externalJobId, status: wh.status, measurements: null, human: wh };
  }
  return null;
}

exports.measurementWebhook = onRequest(
  {
    region: 'us-central1',
    secrets: [SECRETS.HOVER_WEBHOOK_SECRET, SECRETS.EAGLEVIEW_WEBHOOK_SECRET, SECRETS.INSTANTROOFER_WEBHOOK_SECRET],
    maxInstances: 10,
    timeoutSeconds: 15,
    memory: '256MiB'
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    const provider = String(req.query.provider || '');

    // Signature verification is now mandatory and happens against
    // the raw body. If the runtime didn't preserve rawBody we refuse
    // rather than fall through — otherwise an attacker can force a
    // parsed-body path that can't be signature-checked.
    const sigHeader = provider === 'hover'
      ? (req.headers['x-hover-signature'] || '')
      : provider === 'eagleview'
        ? (req.headers['x-ev-signature'] || '')
        : '';
    const sigResult = provider === 'instantroofer'
      ? verifyInstantRooferBearer(req.headers['authorization'] || '')
      : verifyWebhookHmac(provider, req.rawBody, sigHeader);
    if (!sigResult.ok) {
      logger.warn('measurementWebhook: signature rejected', {
        provider, reason: sigResult.reason
      });
      // Fail closed. If the secret is unset the provider effectively
      // loses webhook write access until ops provisions it — correct
      // behaviour for an unconfigured trust relationship.
      res.status(sigResult.reason === 'secret-not-configured' ? 503 : 401)
         .json({ error: 'Unauthorized' });
      return;
    }

    const body = req.body || {};

    // Normalize to our fields.
    const norm = normalizeWebhookPayload(provider, body);
    if (!norm) { res.status(400).json({ error: 'Unknown provider' }); return; }
    const { externalJobId, measurements, human } = norm;
    let status = norm.status;

    if (!externalJobId) { res.status(400).json({ error: 'Missing job id' }); return; }

    try {
      const db = getFirestore();
      const snap = await db.collection('measurements')
        .where('externalJobId', '==', externalJobId)
        .limit(1)
        .get();
      if (snap.empty) {
        logger.warn('measurementWebhook: no matching job', { externalJobId, provider });
        res.status(200).json({ ok: true, matched: false }); // ack to stop retries
        return;
      }
      const measurementDoc = snap.docs[0];
      const measurementData = measurementDoc.data() || {};

      const update = { updatedAt: FieldValue.serverTimestamp() };
      if (measurements) update.measurements = measurements;
      let mergedMeasurements = measurements || measurementData.measurements || null;

      if (human) {
        // One completed report fires one delivery PER ENABLED FORMAT and
        // retries redeliver, so merge the per-format URLs idempotently and
        // never regress a 'ready' doc on a later format's arrival.
        const reportUrls = Object.assign({}, measurementData.reportUrls || {});
        // Key by format when the payload names one, else under 'report'. Their
        // documented MINIMUM payload is {requestID, url, status} with no
        // report_type, and the field list is configured in their dashboard —
        // requiring reportType here threw away the $10 report's only URL while
        // still flipping the doc to 'ready'.
        const urlKey = human.reportType || 'report';
        if (human.reportUrl) reportUrls[urlKey] = human.reportUrl;
        const headline = IR.preferredReportUrl(reportUrls);
        // One completed report fires one delivery PER ENABLED FORMAT, and those
        // arrive concurrently: a whole-object write would let the PDF and CSV
        // handlers each read {} and the later write erase the other's URL. A
        // dotted field path merges server-side, so both survive.
        if (human.reportUrl) update['reportUrls.' + urlKey] = human.reportUrl;
        if (human.humanReportId) update.humanReportId = human.humanReportId;
        if (human.failureReason) update.failureReason = human.failureReason;
        if (headline) {
          mergedMeasurements = Object.assign({}, measurementData.measurements || {}, {
            reportUrl: headline,
            source: (measurementData.measurements && measurementData.measurements.source) || 'instantroofer-human'
          });
          update.measurements = mergedMeasurements;
        }
        if (measurementData.status === 'ready' && status !== 'failed') status = 'ready';
        // A human doc that ends up with neither a URL nor numbers is not
        // 'ready' — flipping it would tell the rep to open a report that does
        // not exist, and both pollers require `measurements` so nothing would
        // ever render. Leave it pending and make the gap visible in logs.
        if (status === 'ready' && !headline && !mergedMeasurements) {
          logger.warn('measurementWebhook: instantroofer completion carried no report URL', {
            externalJobId, reportType: human.reportType, keys: Object.keys(body)
          });
          status = 'pending';
        }
      }
      update.status = status;
      await measurementDoc.ref.update(update);

      // ─── Auto-attach to lead on ready ────────────────────
      // If the measurement was requested from a specific lead and
      // the vendor just flipped it to 'ready', drop a task on the
      // rep's list + write an activity entry so the rep sees the
      // alert inside the CRM without polling the V2 Builder.
      //
      // Idempotent: the update above fires only once per job, and
      // we guard on a previousStatus snapshot so retried webhooks
      // don't duplicate the task.
      const wasReadyAlready = measurementData.status === 'ready';
      if (status === 'ready' && !wasReadyAlready && measurementData.leadId && measurementData.ownerId) {
        await attachMeasurementToLead(db, {
          leadId: measurementData.leadId,
          ownerId: measurementData.ownerId,
          address: measurementData.address,
          provider,
          reportType: measurementData.reportType || null,
          measurementJobId: measurementDoc.id,
          measurements: mergedMeasurements
        });
        logger.info('measurementWebhook: attached to lead', {
          leadId: measurementData.leadId, measurementJobId: measurementDoc.id, provider
        });
      }

      res.status(200).json({ ok: true, matched: true });
    } catch (e) {
      logger.error('measurementWebhook error:', e.message);
      res.status(500).json({ error: 'write failed' });
    }
  }
);

// Shared with integrations/public-measure.js, which measures a public
// estimate lead's roof when the CRM lead is created. These are production
// exports, not test seams — the RHS is a bare identifier, so the deploy
// workflow's `^exports.NAME = (onCall|onRequest|onDocument...)` allowlist grep
// does not mistake them for deployable functions.
exports.requestInstantRoofer     = requestInstantRoofer;
exports.findReusableMeasurement  = findReusableMeasurement;
exports.attachMeasurementToLead  = attachMeasurementToLead;

// Repo _test convention: pure/injectable pieces for tests/instantroofer-measurement.test.js.
exports._test = {
  requestInstantRoofer,
  selectProvider,
  resolveCoords,
  leadCoords,
  geocodeNominatim,
  parseSync,
  stripVendorBlobs,
  normalizeWebhookPayload,
  measuredAtMs,
  attachMeasurementToLead,
  findReusableMeasurement,
  webhookSecretReady,
  verifyInstantRooferBearer,
  verifyWebhookHmac,
  REUSE_WINDOW_MS,
  INSTANTROOFER_PER_MINUTE
};

module.exports = exports;
