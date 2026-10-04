/**
 * integrations/solar-measure.js — Google Solar API roof measurement adapter
 *
 * WHY THIS EXISTS (documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md, Lane G)
 * An Instant Roofer AI measure costs ~$3. Jo runs 20+ measures a month, and
 * every public /estimate lead buys one. Google's Solar API
 * (buildingInsights:findClosest) returns the same roof geometry — every roof
 * plane's pitch, azimuth and area — for a per-call price in cents (VERIFY the
 * current "Solar API Building Insights" SKU price on
 * https://developers.google.com/maps/billing-and-pricing/pricing before
 * relying on that). This file maps that response into the exact `measurements`
 * shape Instant Roofer's normalizer produces (instantroofer-logic.js
 * normalizeAiResponse), so the estimate wizard, the D2D card, the kanban chip
 * and the public wizard read it with no changes.
 *
 * PROVIDER SWITCH — NBD_MEASUREMENT_PROVIDER (integrations/_shared.js PROVIDERS)
 *   instantroofer (default) — unchanged; this file is never called
 *   solar                   — Google Solar only; LOW imagery is returned but
 *                             flagged for a manual check
 *   auto                    — Solar first; Instant Roofer when Solar fails,
 *                             is not configured, or its imagery is LOW
 * Human Certified Reports are an Instant Roofer product, so a
 * reportType:'human' request always goes to Instant Roofer.
 *
 * ACCURACY GUARD — a satellite measure becomes a price, so:
 *   - every result carries satelliteEstimate:true and
 *     accuracyNote 'Satellite estimate — confirm on site';
 *   - needsManualCheck + manualCheckReasons flag complex roofs (more than 8
 *     segments), mixed pitches, low-slope planes, LOW imagery, old imagery,
 *     and a building centre far from the requested point (findClosest can
 *     pick the neighbour's house);
 *   - nothing here bypasses the rep's existing confirm step — the result
 *     pre-fills the builder, the rep still reviews before pricing.
 *
 * COST + LIMITS
 *   - 180-day cache per company + roof point in `solar_measure_cache/`
 *     (server-only; firestore.rules' catch-all deny covers it);
 *   - a per-company daily cap in `solar_measure_usage/` (default 40/day,
 *     NBD_SOLAR_DAILY_CAP overrides). A cache hit does not count. At the cap
 *     the call is REFUSED — not handed to Instant Roofer, which costs more.
 *
 * KEY: SOLAR_API_KEY (Secret Manager). Server-side only; never sent to a
 * client. Create a key restricted to solar.googleapis.com and set it:
 *   firebase functions:secrets:set SOLAR_API_KEY
 *
 * No network in tests: every outbound call goes through deps.fetchImpl.
 */

'use strict';

const crypto = require('crypto');
const { hasSecret, getSecret, notConfigured } = require('./_shared');

const PROVIDER = 'solar';
const ENDPOINT = 'https://solar.googleapis.com/v1/buildingInsights:findClosest';
// Standard Google API partial-response parameter. solarPanelConfigs and the
// financial analyses are most of a buildingInsights body (hundreds of panel
// layouts) and nothing here reads them.
const RESPONSE_FIELDS = 'name,center,imageryDate,imageryQuality,solarPotential.wholeRoofStats,solarPotential.roofSegmentStats';

const SQFT_PER_M2 = 10.7639104;
const CACHE_COLLECTION = 'solar_measure_cache';
const USAGE_COLLECTION = 'solar_measure_usage';
const CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_CAP = 40;

const ACCURACY_NOTE = 'Satellite estimate — confirm on site';
const COMPLEX_SEGMENT_THRESHOLD = 8;     // more than this → manual check
const MIXED_PITCH_SPREAD = 3;            // rise/12 spread across significant planes
const SIGNIFICANT_SHARE = 0.05;          // a plane under 5% of the roof is a dormer cheek, not a pitch
const LOW_SLOPE_RISE = 2;                // under 2/12 needs low-slope material, not shingles
const MAX_BUILDING_OFFSET_M = 25;        // building centre this far from the pin → maybe the neighbour
const OLD_IMAGERY_YEARS = 5;

const COMPLEXITY_LABEL = ['Low', 'Moderate', 'High', 'Extreme'];
const QUALITY_LABEL = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low' };

// ─── Pure conversions ──────────────────────────────────────

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Pitch angle in degrees → rise over a 12" run. 26.57° → 6.0.
function degreesToRise(deg) {
  const d = num(deg);
  if (d === null || d < 0 || d >= 90) return null;
  return 12 * Math.tan(d * Math.PI / 180);
}

// Rise → the 'x/12' string every consumer parses. Rounded to the nearest
// whole rise (the V2 builder's pitch control offers whole numbers only).
function riseToPitch(rise) {
  const r = num(rise);
  if (r === null || r < 0) return null;
  return Math.round(r) + '/12';
}

function m2ToSqft(m2) {
  const a = num(m2);
  return a === null || a < 0 ? null : a * SQFT_PER_M2;
}

// 1 roofing square = 100 sq ft. Two decimals.
function sqftToSquares(sqft) {
  const s = num(sqft);
  return s === null ? null : Math.round(s) / 100;
}

function azimuthToCompass(deg) {
  const d = num(deg);
  if (d === null) return null;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((d % 360) + 360) % 360) / 45) % 8];
}

function imageryDateString(d) {
  if (!d || typeof d !== 'object' || !num(d.year)) return null;
  const pad = (n) => String(n || 1).padStart(2, '0');
  return d.year + '-' + pad(d.month) + '-' + pad(d.day);
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// More planes = more cuts at hips/valleys = more waste. The common field
// rule: a simple gable ~10%, a hip roof ~12–15%, a cut-up roof 15%+. Mixed
// pitches add 2 points (more starter/transition cuts).
function suggestWastePct(segmentCount, mixedPitch) {
  const n = num(segmentCount) || 0;
  let pct = n <= 2 ? 10 : n <= 4 ? 12 : n <= 8 ? 14 : n <= 14 ? 16 : 18;
  if (mixedPitch) pct += 2;
  return pct;
}

function complexityIndex(segmentCount) {
  const n = num(segmentCount) || 0;
  return n <= 4 ? 0 : n <= COMPLEX_SEGMENT_THRESHOLD ? 1 : n <= 14 ? 2 : 3;
}

// ─── Response mapper ───────────────────────────────────────

/**
 * buildingInsights body → { measurements, quality, buildingName } or
 * { measurements: null, reason }. Never throws.
 *
 * Field semantics match normalizeAiResponse so consumers add their waste the
 * same way:
 *   rawSqft       = sloped roof surface, NO waste (sum of roof planes)
 *   footprintSqft = ground area under the roof
 *   suggestedSqft = rawSqft × (1 + wastePct)   (material figure)
 *   squares       = suggestedSqft / 100        (as Instant Roofer's `squares`)
 *   roofSquares   = rawSqft / 100              (no waste)
 */
function mapBuildingInsights(body, opts) {
  opts = opts || {};
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  if (!body || typeof body !== 'object') return { measurements: null, reason: 'empty-body' };
  const sp = body.solarPotential || {};
  const rawSegs = Array.isArray(sp.roofSegmentStats) ? sp.roofSegmentStats : [];

  const segments = rawSegs.map((s) => {
    const st = (s && s.stats) || {};
    const sqft = m2ToSqft(st.areaMeters2);
    const rise = degreesToRise(s && s.pitchDegrees);
    return {
      pitchDegrees: num(s && s.pitchDegrees) === null ? null : Math.round(num(s.pitchDegrees) * 10) / 10,
      rise: rise === null ? null : Math.round(rise * 10) / 10,
      pitch: riseToPitch(rise),
      azimuthDegrees: num(s && s.azimuthDegrees) === null ? null : Math.round(num(s.azimuthDegrees)),
      direction: azimuthToCompass(s && s.azimuthDegrees),
      sqft: sqft === null ? null : Math.round(sqft),
      squares: sqftToSquares(sqft),
      groundSqft: m2ToSqft(st.groundAreaMeters2) === null ? null : Math.round(m2ToSqft(st.groundAreaMeters2))
    };
  }).filter((s) => s.sqft !== null && s.sqft > 0);

  const whole = sp.wholeRoofStats || {};
  const segSum = segments.reduce((a, s) => a + s.sqft, 0);
  const wholeSqft = m2ToSqft(whole.areaMeters2);
  // Prefer the plane sum (it is what the pitches describe); fall back to the
  // whole-roof figure when Google returned no usable planes.
  const rawSqft = segSum > 0 ? segSum : (wholeSqft ? Math.round(wholeSqft) : null);
  if (!rawSqft) return { measurements: null, reason: 'no-roof-area' };

  const footprintSqft = m2ToSqft(whole.groundAreaMeters2) !== null
    ? Math.round(m2ToSqft(whole.groundAreaMeters2))
    : (segments.length ? segments.reduce((a, s) => a + (s.groundSqft || 0), 0) || null : null);

  // Predominant pitch: the whole-number rise covering the most roof area.
  const byRise = {};
  for (const s of segments) {
    if (s.rise === null) continue;
    const k = Math.round(s.rise);
    byRise[k] = (byRise[k] || 0) + s.sqft;
  }
  let predominantRise = null, best = -1;
  for (const k of Object.keys(byRise)) {
    if (byRise[k] > best) { best = byRise[k]; predominantRise = Number(k); }
  }

  const significant = segments.filter((s) => s.rise !== null && s.sqft >= SIGNIFICANT_SHARE * rawSqft);
  const rises = significant.map((s) => s.rise);
  const spread = rises.length ? Math.max(...rises) - Math.min(...rises) : 0;
  const mixedPitch = rises.length > 1 && spread >= MIXED_PITCH_SPREAD;
  const lowSlope = significant.some((s) => s.rise < LOW_SLOPE_RISE);

  const segmentCount = segments.length;
  const wastePct = suggestWastePct(segmentCount, mixedPitch);
  const suggestedSqft = Math.round(rawSqft * (1 + wastePct / 100));
  const complexity = complexityIndex(segmentCount);

  const quality = typeof body.imageryQuality === 'string' ? body.imageryQuality.toUpperCase() : null;
  const imageryDate = imageryDateString(body.imageryDate);
  const imageryAgeYears = imageryDate
    ? Math.round(((now - Date.parse(imageryDate + 'T00:00:00Z')) / (365.25 * 24 * 3600 * 1000)) * 10) / 10
    : null;

  let buildingOffsetM = null;
  const c = body.center || {};
  if (num(opts.lat) !== null && num(opts.lng) !== null && num(c.latitude) !== null && num(c.longitude) !== null) {
    buildingOffsetM = Math.round(haversineM(num(opts.lat), num(opts.lng), num(c.latitude), num(c.longitude)));
  }

  const reasons = [];
  if (segmentCount > COMPLEX_SEGMENT_THRESHOLD) reasons.push('complex roof: ' + segmentCount + ' roof planes');
  if (mixedPitch) reasons.push('mixed pitches: ' + riseToPitch(Math.min(...rises)) + ' to ' + riseToPitch(Math.max(...rises)));
  if (lowSlope) reasons.push('a low-slope section (under 2/12) needs low-slope material');
  if (quality === 'LOW') reasons.push('low-quality satellite imagery');
  if (!quality) reasons.push('imagery quality not reported');
  if (imageryAgeYears !== null && imageryAgeYears > OLD_IMAGERY_YEARS) reasons.push('imagery is ' + imageryAgeYears + ' years old (' + imageryDate + ')');
  if (buildingOffsetM !== null && buildingOffsetM > MAX_BUILDING_OFFSET_M) reasons.push('matched building is ' + buildingOffsetM + ' m from the pin — check it is this house');
  if (!segmentCount) reasons.push('no roof planes returned — pitch unknown');

  const measurements = {
    rawSqft,
    footprintSqft,
    suggestedSqft,
    squares: Math.round(suggestedSqft / 10) / 10,
    roofSquares: sqftToSquares(rawSqft),
    pitch: predominantRise === null ? null : predominantRise + '/12',
    perimeterLf: null,            // Solar returns planes, not edges
    facets: segmentCount,
    stories: null,                // not reported; never overwrite the rep's storey count
    complexity,
    complexityLabel: COMPLEXITY_LABEL[complexity],
    wastePct,
    confidence: quality && QUALITY_LABEL[quality] ? { score: null, label: QUALITY_LABEL[quality] } : null,
    isTownhome: null,
    isCommercial: null,
    reportUrl: null,              // no document
    source: 'google-solar',
    satelliteEstimate: true,
    accuracyNote: ACCURACY_NOTE,
    needsManualCheck: reasons.length > 0,
    manualCheckReasons: reasons,
    mixedPitch,
    imagery: { date: imageryDate, quality: quality, ageYears: imageryAgeYears },
    buildingOffsetM,
    segments: segments.map((s) => ({
      pitch: s.pitch, pitchDegrees: s.pitchDegrees, azimuthDegrees: s.azimuthDegrees,
      direction: s.direction, sqft: s.sqft, squares: s.squares
    }))
  };
  return { measurements, quality, buildingName: typeof body.name === 'string' ? body.name : null };
}

// ─── HTTP ──────────────────────────────────────────────────

function classifyHttpError(status) {
  if (status === 404) return { reason: 'no-building', code: 'not-found', message: 'Google has no 3D roof data for this point — measure manually or use another provider.' };
  if (status === 403) return { reason: 'forbidden', code: 'failed-precondition', message: 'Google Solar API refused the key (API disabled, billing off, or the key is not allowed for solar.googleapis.com).' };
  if (status === 400) return { reason: 'bad-request', code: 'invalid-argument', message: 'Google Solar API rejected the location.' };
  if (status === 429) return { reason: 'quota', code: 'resource-exhausted', message: 'Google Solar API quota reached — try again later.' };
  return { reason: 'vendor-error', code: 'unavailable', message: 'Google Solar API error (' + status + ') — try again.' };
}

function buildUrl(lat, lng, apiKey) {
  return ENDPOINT
    + '?location.latitude=' + encodeURIComponent(Number(lat).toFixed(7))
    + '&location.longitude=' + encodeURIComponent(Number(lng).toFixed(7))
    // LOW = accept any quality; the adapter decides what LOW means (flag in
    // 'solar' mode, fall back in 'auto').
    + '&requiredQuality=LOW'
    + '&fields=' + encodeURIComponent(RESPONSE_FIELDS)
    + '&key=' + encodeURIComponent(apiKey);
}

/**
 * One Solar call. ctx: {lat, lng}. deps: {fetchImpl, now, apiKey}.
 * Returns the requestInstantRoofer result shape: {ok, provider, reportType,
 * jobId, estimatedMinutes, measurements, quality} or {ok:false, reason, code, message}.
 */
async function requestSolar(ctx, deps) {
  deps = deps || {};
  const apiKey = deps.apiKey || (hasSecret('SOLAR_API_KEY') ? getSecret('SOLAR_API_KEY') : null);
  if (!apiKey) return Object.assign({ ok: false }, notConfigured(PROVIDER));
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || Date.now;
  let res;
  try {
    res = await fetchImpl(buildUrl(ctx.lat, ctx.lng, apiKey), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined
    });
  } catch (e) {
    return { ok: false, provider: PROVIDER, reason: 'network', code: 'unavailable', message: 'Could not reach Google Solar API — try again.' };
  }
  if (!res.ok) {
    return Object.assign({ ok: false, provider: PROVIDER, status: res.status }, classifyHttpError(res.status));
  }
  let body;
  try { body = await res.json(); } catch (e) {
    return { ok: false, provider: PROVIDER, reason: 'bad-json', code: 'unavailable', message: 'Google Solar API sent an unreadable reply.' };
  }
  const mapped = mapBuildingInsights(body, { lat: ctx.lat, lng: ctx.lng, now: now() });
  if (!mapped.measurements) {
    return { ok: false, provider: PROVIDER, reason: mapped.reason || 'no-measurement', code: 'not-found', message: 'Google returned no roof area for this point.' };
  }
  return {
    ok: true,
    provider: PROVIDER,
    reportType: 'ai',
    jobId: 'solar-' + now(),
    estimatedMinutes: 0,
    quality: mapped.quality,
    buildingName: mapped.buildingName,
    measurements: mapped.measurements
  };
}

// ─── Cache + daily cap (Firestore, company-scoped) ─────────

function cacheScope(ctx) {
  if (ctx && ctx.companyId) return 'c_' + String(ctx.companyId);
  if (ctx && ctx.uid) return 'u_' + String(ctx.uid);
  return null;
}

function cacheDocId(scope, lat, lng) {
  return crypto.createHash('sha1')
    .update(scope + '|' + Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5))
    .digest('hex').slice(0, 32);
}

async function readCache(db, scope, lat, lng, nowMs) {
  if (!db || !scope) return null;
  const snap = await db.collection(CACHE_COLLECTION).doc(cacheDocId(scope, lat, lng)).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  if (d.scope !== scope) return null;                 // belt and braces: never cross tenants
  if (!d.measurements || !d.measurements.rawSqft) return null;
  if (typeof d.fetchedAtMs !== 'number' || nowMs - d.fetchedAtMs > CACHE_TTL_MS) return null;
  return d;
}

async function writeCache(db, scope, lat, lng, result, nowMs, address) {
  if (!db || !scope) return;
  await db.collection(CACHE_COLLECTION).doc(cacheDocId(scope, lat, lng)).set({
    scope,
    lat: Number(lat), lng: Number(lng),
    address: address ? String(address).slice(0, 500) : null,
    buildingName: result.buildingName || null,
    quality: result.quality || null,
    measurements: result.measurements,
    fetchedAtMs: nowMs,
    expiresAtMs: nowMs + CACHE_TTL_MS
  });
}

function dailyCap(env) {
  const n = parseInt((env || process.env).NBD_SOLAR_DAILY_CAP, 10);
  return isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

// Atomically take one unit of today's (UTC) allowance. false at the cap.
async function reserveDailyQuota(db, scope, nowMs, cap) {
  if (!db || !scope) return { ok: false, reason: 'no-scope' };
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const ref = db.collection(USAGE_COLLECTION).doc(scope + '_' + day);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? Number((snap.data() || {}).count) || 0 : 0;
    if (count >= cap) return { ok: false, reason: 'daily-cap', count, cap };
    tx.set(ref, { scope, day, count: count + 1, cap, updatedAtMs: nowMs }, { merge: true });
    return { ok: true, count: count + 1, cap };
  });
}

// ─── Provider entry point (selected from measurement.js) ───

/**
 * ctx:  {lat, lng, address, uid, companyId, db, reportType, ...IR fields}
 * deps: {mode: 'solar'|'auto', instantRoofer: (ctx) => Promise<result>,
 *        fetchImpl, now, apiKey, cap}
 */
async function runSolarProvider(ctx, deps) {
  ctx = ctx || {};
  deps = deps || {};
  const mode = deps.mode === 'auto' ? 'auto' : 'solar';
  const now = deps.now || Date.now;
  const ir = typeof deps.instantRoofer === 'function' ? deps.instantRoofer : null;

  // Human Certified Reports exist only at Instant Roofer.
  if (ctx.reportType === 'human') {
    return ir ? ir(ctx) : Object.assign({ ok: false }, notConfigured('instantroofer'));
  }

  async function fallback(reason, solarResult) {
    if (mode !== 'auto' || !ir) return solarResult || null;
    const r = await ir(Object.assign({}, ctx, { reportType: 'ai' }));
    if (r && r.ok) return Object.assign({}, r, { fallbackFrom: { provider: PROVIDER, reason } });
    // Instant Roofer failed too: a flagged LOW-quality Solar measure is better
    // than nothing (the rep confirms on site regardless).
    return solarResult || r;
  }

  const keyReady = !!deps.apiKey || hasSecret('SOLAR_API_KEY');
  if (!keyReady) {
    const fb = await fallback('not-configured', null);
    return fb || Object.assign({ ok: false }, notConfigured(PROVIDER));
  }

  const scope = cacheScope(ctx);
  const db = ctx.db || null;
  const nowMs = now();

  // 1. Cache — free, and does not count against the cap.
  let cached = null;
  try { cached = await readCache(db, scope, ctx.lat, ctx.lng, nowMs); } catch (_) { cached = null; }
  if (cached) {
    const hit = {
      ok: true, provider: PROVIDER, reportType: 'ai',
      jobId: 'solar-cache-' + nowMs, estimatedMinutes: 0,
      quality: cached.quality || null, buildingName: cached.buildingName || null,
      solarCached: true,
      measurements: Object.assign({}, cached.measurements, { solarCachedAtMs: cached.fetchedAtMs })
    };
    if (hit.quality === 'LOW') return (await fallback('low-imagery-quality', hit)) || hit;
    return hit;
  }

  // 2. Daily cap per company. Refused, not escalated to the pricier vendor.
  const cap = deps.cap || dailyCap();
  if (db && scope) {
    const q = await reserveDailyQuota(db, scope, nowMs, cap);
    if (!q.ok) {
      return {
        ok: false, provider: PROVIDER, reason: 'daily-cap', code: 'resource-exhausted',
        message: 'Daily satellite-measure limit reached (' + cap + ' per company). Measure manually or try tomorrow.'
      };
    }
  }

  // 3. The call.
  const result = await requestSolar(ctx, deps);
  if (!result.ok) {
    if (result.configured === false) return (await fallback('not-configured', null)) || result;
    return (await fallback(result.reason || 'solar-error', null)) || result;
  }

  try { await writeCache(db, scope, ctx.lat, ctx.lng, result, nowMs, ctx.address); } catch (_) { /* cache is best-effort */ }

  if (result.quality === 'LOW') return (await fallback('low-imagery-quality', result)) || result;
  return result;
}

module.exports = {
  runSolarProvider,
  requestSolar,
  mapBuildingInsights,
  PROVIDER,
  ACCURACY_NOTE,
  _test: {
    degreesToRise, riseToPitch, m2ToSqft, sqftToSquares, azimuthToCompass,
    imageryDateString, haversineM, suggestWastePct, complexityIndex,
    classifyHttpError, buildUrl, cacheScope, cacheDocId, readCache, writeCache,
    reserveDailyQuota, dailyCap,
    CACHE_COLLECTION, USAGE_COLLECTION, CACHE_TTL_MS, DEFAULT_DAILY_CAP,
    COMPLEX_SEGMENT_THRESHOLD, ENDPOINT, RESPONSE_FIELDS
  }
};
