/**
 * integrations/hail.js — hail / storm swath data source
 *
 * Four providers, all live:
 *   hailtrace (premium)    — paid subscription, polygon swaths per storm
 *   swath     (metered)    — swathapi.com radar-measured events + swath
 *                            polygons (integrations/swath.js; Firestore-
 *                            cached because the free plan hard-stops at
 *                            100 credits/month)
 *   swdi      (free)       — NCEI Severe Weather Data Inventory nx3hail:
 *                            radar-derived hail size per storm cell, keyless,
 *                            no quota; the range is chunked into ≤31-day
 *                            windows (integrations/swdi-hail.js). Selected
 *                            with NBD_HAIL_PROVIDER=swdi — no key to check.
 *   noaa      (free)       — IEM Local Storm Reports (ground-truth spotter
 *                            reports of hail size); only where someone
 *                            filed a report.
 *
 * NOAA is the default so the feature works out-of-the-box. HailTrace
 * provides real-time within ~15 min of storm end; Swath is
 * measured-events-only (never forecasts); SWDI is the radar algorithm's own
 * estimate for every cell, reports or not. Select via NBD_HAIL_PROVIDER.
 * Whatever is preferred, a failure falls back to NOAA (see lookupHail).
 *
 * Used for the D2D pitch: "your neighborhood had verified 1.5"+ hail
 * 6 weeks ago — here's the polygon and the timestamp."
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getSecret, hasSecret, PROVIDERS, SECRETS } = require('./_shared');
const { fetchSwathHail } = require('./swath');
const { fetchSwdiHail } = require('./swdi-hail');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app'
];

// Per-provider fetch cap (2026-10-03). getHailHistory has a 20s function
// timeout and attachStormProof 30s, and lookupHail runs the preferred
// provider THEN the NOAA fallback serially — so each leg gets 8s, leaving
// room for both plus the callable's own work. Without a cap a hung provider
// held the whole callable until the platform killed it, and the NOAA
// fallback never ran.
const HAIL_FETCH_TIMEOUT_MS = 8000;

// NOAA Storm Events CSV endpoint. Per-year files. We query by
// lat/lng bounding box + event type `Hail` then filter by distance.
// For a demo/zero-cost deployment, keep a rolling 12-month window.
async function fetchNoaaHail(lat, lng, radiusMi, daysBack) {
  // The NOAA Storm Events DB isn't a query-by-location API — it's
  // a bulk CSV. For real-time-ish use we hit their newer endpoint:
  // https://api.weather.gov is preferred for active alerts. For
  // hail history, use the IEM (Iowa Environmental Mesonet) JSON
  // service which wraps NWS Storm Events data.
  const tsEnd = new Date();
  const tsStart = new Date(tsEnd.getTime() - daysBack * 86_400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  // Build a small bbox (degrees) approximately matching radiusMi.
  // Rough: 1deg lat ≈ 69mi, 1deg lng ≈ 69 * cos(lat) mi.
  const latDelta = radiusMi / 69;
  const lngDelta = radiusMi / (69 * Math.cos(lat * Math.PI / 180));

  const url = 'https://mesonet.agron.iastate.edu/geojson/lsr.php?'
    + 'sts=' + encodeURIComponent(fmt(tsStart) + 'T00:00')
    + '&ets=' + encodeURIComponent(fmt(tsEnd) + 'T23:59')
    + '&type%5B%5D=H'  // hail
    + '&minlat=' + (lat - latDelta).toFixed(4)
    + '&maxlat=' + (lat + latDelta).toFixed(4)
    + '&minlon=' + (lng - lngDelta).toFixed(4)
    + '&maxlon=' + (lng + lngDelta).toFixed(4);

  const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(HAIL_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error('NOAA/IEM ' + res.status);
  const geo = await res.json();
  const features = (geo && geo.features) || [];
  return features.map(f => {
    const p = f.properties || {};
    const g = f.geometry && f.geometry.coordinates; // [lng,lat]
    return {
      at:   p.valid || p.utc_valid || null,
      lat:  Array.isArray(g) ? g[1] : null,
      lng:  Array.isArray(g) ? g[0] : null,
      sizeInches: parseFloat(p.magnitude) || null,
      source: p.source || 'noaa',
      remark: p.remark || null
    };
  }).filter(h => h.lat != null && h.lng != null);
}

async function fetchHailTrace(lat, lng, radiusMi, daysBack) {
  const key = getSecret('HAILTRACE_API_KEY');
  const url = 'https://api.hailtrace.com/v1/hail/query?'
    + 'lat=' + encodeURIComponent(lat)
    + '&lon=' + encodeURIComponent(lng)
    + '&radius_mi=' + encodeURIComponent(radiusMi)
    + '&days=' + encodeURIComponent(daysBack);
  const res = await fetch(url, { headers: { 'Authorization': 'Bearer ' + key }, signal: AbortSignal.timeout(HAIL_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error('HailTrace ' + res.status);
  const data = await res.json();
  // Normalize — HailTrace returns `events`, each with
  // { start_time, end_time, polygon, max_size, storm_id }.
  return (data.events || []).map(e => ({
    at: e.start_time,
    lat: (e.centroid && e.centroid.lat) || null,
    lng: (e.centroid && e.centroid.lng) || null,
    sizeInches: e.max_size || null,
    polygon: e.polygon || null,
    source: 'hailtrace',
    stormId: e.storm_id
  }));
}

// ─── Shared lookup — provider selection + NOAA fallback ───
// Extracted so both getHailHistory (below) and the server-side attachStormProof
// callable (handlers/storm-proof.js, idea #1 Phase 2) resolve hail the same
// way. Returns { provider, hits, count, maxSizeInches }. Throws on total
// failure (caller maps to an HttpsError). getHailHistory now routes through
// this too (Swath wiring, 2026-08-06) — three providers × two inline copies
// was drift waiting to happen.
const HAIL_FETCHERS = {
  hailtrace: fetchHailTrace,
  swath:     fetchSwathHail,
  swdi:      fetchSwdiHail,
  noaa:      fetchNoaaHail,
};

function preferredHailProvider() {
  if (PROVIDERS.hail === 'hailtrace' && hasSecret('HAILTRACE_API_KEY')) return 'hailtrace';
  if (PROVIDERS.hail === 'swath' && hasSecret('SWATH_API_KEY')) return 'swath';
  // Keyless — the env switch alone selects it. Both its failure modes (NCEI
  // down, a window rejected) throw, and lookupHail then falls back to NOAA.
  if (PROVIDERS.hail === 'swdi') return 'swdi';
  return 'noaa';
}

async function lookupHail(lat, lng, radiusMi, daysBack) {
  const preferredProvider = preferredHailProvider();
  let hits;
  let provider = preferredProvider;
  try {
    hits = await HAIL_FETCHERS[preferredProvider](lat, lng, radiusMi, daysBack);
  } catch (e) {
    if (preferredProvider !== 'noaa') {
      // Keep the historical 'noaa-fallback' label regardless of which paid
      // provider failed — client code only distinguishes fallback-vs-not.
      hits = await fetchNoaaHail(lat, lng, radiusMi, daysBack); // fallback (may throw → caller handles)
      provider = 'noaa-fallback';
    } else {
      throw e;
    }
  }
  hits = Array.isArray(hits) ? hits : [];
  return {
    provider,
    hits,
    count: hits.length,
    maxSizeInches: hits.reduce((m, h) => Math.max(m, h.sizeInches || 0), 0),
  };
}
exports.lookupHail = lookupHail;

// ─── Callable: getHailHistory ─────────────────────────────
exports.getHailHistory = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 20,
    memory: '256MiB',
    secrets: [SECRETS.HAILTRACE_API_KEY, SECRETS.SWATH_API_KEY]
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

    // Per-uid cap: when HailTrace is the active provider this bills the shared
    // key per call, and there was no limit (unlike the sibling paid callables).
    const { enforceRateLimit } = require('./upstash-ratelimit');
    try {
      await enforceRateLimit('callable:getHailHistory:uid', uid, 60, 60 * 60_000);
    } catch (e) {
      if (e.rateLimited) throw new HttpsError('resource-exhausted', 'Too many hail lookups — try again in an hour.');
      throw e;
    }

    const lat = parseFloat(request.data && request.data.lat);
    const lng = parseFloat(request.data && request.data.lng);
    const radiusMi = Math.min(50, Math.max(0.5, parseFloat(request.data && request.data.radiusMi) || 3));
    const daysBack = Math.min(730, Math.max(7, parseInt(request.data && request.data.daysBack) || 365));

    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new HttpsError('invalid-argument', 'Valid lat/lng required');
    }

    // Swath wiring (2026-08-06): route through the shared lookupHail so the
    // three-provider selection + NOAA fallback lives in exactly one place.
    // Behavior notes vs the old inline block: identical selection and
    // fallback order; the fallback response now also carries maxSizeInches
    // (the inline copy dropped it on that path — additive fix).
    try {
      const result = await lookupHail(lat, lng, radiusMi, daysBack);
      return {
        success: true,
        provider: result.provider,
        lat, lng, radiusMi, daysBack,
        hits: result.hits,
        count: result.count,
        maxSizeInches: result.maxSizeInches
      };
    } catch (e) {
      logger.warn('getHailHistory failed:', e.message);
      throw new HttpsError('unavailable', 'Hail lookup failed');
    }
  }
);

module.exports = exports;
