/**
 * integrations/hail.js — hail / storm swath data source
 *
 * Two providers, both free and keyless:
 *   swdi      (free)       — NCEI Severe Weather Data Inventory nx3hail:
 *                            radar-derived hail size per storm cell, keyless,
 *                            no quota; the range is chunked into ≤31-day
 *                            windows (integrations/swdi-hail.js). Selected
 *                            with NBD_HAIL_PROVIDER=swdi.
 *   noaa      (free)       — IEM Local Storm Reports (ground-truth spotter
 *                            reports of hail size); only where someone
 *                            filed a report.
 *
 * NOAA is the default. SWDI is the radar algorithm's own estimate for every
 * cell, reports or not. Select via NBD_HAIL_PROVIDER. Whatever is preferred,
 * a failure falls back to NOAA (see lookupHail).
 *
 * The paid HailTrace and Swath providers were removed 2026-10-04
 * (documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md, Lane C): neither
 * key was ever set (both are the deploy's `__unset__` stub) and prod sets no
 * NBD_HAIL_PROVIDER, so prod runs NOAA. NBD_HAIL_PROVIDER=hailtrace
 * or =swath now selects NOAA, exactly as an unset key always did.
 *
 * Used for the D2D pitch: "your neighborhood had verified 1.5"+ hail
 * 6 weeks ago — here's the polygon and the timestamp."
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { PROVIDERS } = require('./_shared');
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

// ─── Shared lookup — provider selection + NOAA fallback ───
// Extracted so both getHailHistory (below) and the server-side attachStormProof
// callable (handlers/storm-proof.js, idea #1 Phase 2) resolve hail the same
// way. Returns { provider, hits, count, maxSizeInches }. Throws on total
// failure (caller maps to an HttpsError). getHailHistory routes through this
// too, so provider selection and the NOAA fallback live in one place.
const HAIL_FETCHERS = {
  swdi:      fetchSwdiHail,
  noaa:      fetchNoaaHail,
};

function preferredHailProvider() {
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
      // Keep the historical 'noaa-fallback' label — client code only
      // distinguishes fallback-vs-not.
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
    memory: '256MiB'
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

    // Per-uid cap: the upstream feeds are free but shared, so one runaway
    // client must not exhaust them for everyone.
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

    // Route through the shared lookupHail so provider selection + the NOAA
    // fallback live in exactly one place.
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
