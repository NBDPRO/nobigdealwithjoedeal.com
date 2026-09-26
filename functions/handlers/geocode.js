/**
 * functions/handlers/geocode.js — authoritative door-number resolver
 *
 * The D2D canvassing tool needs the house number under a rep's finger to be
 * RIGHT — a wrong door number means knocking the wrong house or filing a lead
 * against the wrong address. The browser can reach OSM Nominatim (free, but
 * only rooftop-accurate where OSM has the building) and NOTHING else: the US
 * Census geocoder, Google, and Regrid are all CORS-blocked client-side.
 *
 * This callable is the server-side cross-check. It fans a single point (reverse)
 * or address (forward) out to two authoritative sources and returns both, so
 * the client can score confidence by agreement:
 *   - Google Geocoding — `location_type: ROOFTOP` is the gold-standard "this is
 *     the exact building" signal; RANGE_INTERPOLATED means the number was
 *     guessed along the street.
 *   - Regrid — county-assessor parcel data: the literal legal situs address of
 *     the parcel the point falls in. This is the ground-truth record.
 *
 * Auth + App Check + per-uid rate limit + 30-day Firestore cache, mirroring
 * integrations/parcel.js (lookupParcel) — both bill paid vendors per lookup.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { CORS_ORIGINS } = require('./_shared');
const { assertNotViewer } = require('../shared');

const GOOGLE_GEOCODING_API_KEY = defineSecret('GOOGLE_GEOCODING_API_KEY');
const REGRID_API_TOKEN = defineSecret('REGRID_API_TOKEN');

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — addresses/parcels are stable

// ── Google Geocoding ────────────────────────────────────────────────
function parseGoogleResult(r) {
  if (!r) return null;
  const comp = {};
  (r.address_components || []).forEach(c => {
    const t = c.types || [];
    if (t.includes('street_number')) comp.houseNumber = c.long_name;
    else if (t.includes('route')) comp.street = c.long_name;
    else if (t.includes('locality')) comp.city = c.long_name;
    else if (t.includes('administrative_area_level_1')) comp.state = c.short_name;
    else if (t.includes('postal_code')) comp.zip = c.long_name;
    else if (t.includes('administrative_area_level_2')) comp.county = c.long_name;
  });
  const loc = (r.geometry && r.geometry.location) || {};
  return {
    formatted: r.formatted_address || null,
    houseNumber: comp.houseNumber || null,
    street: comp.street || null,
    city: comp.city || null,
    state: comp.state || null,
    zip: comp.zip || null,
    county: comp.county || null,
    lat: typeof loc.lat === 'number' ? loc.lat : null,
    lng: typeof loc.lng === 'number' ? loc.lng : null,
    precision: (r.geometry && r.geometry.location_type) || null, // ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE
    partialMatch: !!r.partial_match
  };
}

async function googleReverse(lat, lng, key) {
  // result_type=street_address keeps Google from handing back a neighborhood /
  // route centroid; we still fall back to the first result if it must.
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?latlng=' +
    lat + ',' + lng + '&result_type=street_address&key=' + key;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) return null;
  const best = data.results.find(r => r.geometry && r.geometry.location_type === 'ROOFTOP') || data.results[0];
  return parseGoogleResult(best);
}

async function googleForward(address, key) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
    encodeURIComponent(address) + '&key=' + key;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 'OK' || !Array.isArray(data.results) || !data.results.length) return null;
  const best = data.results.find(r => r.geometry && r.geometry.location_type === 'ROOFTOP') || data.results[0];
  return parseGoogleResult(best);
}

// ── Regrid (county parcel records) ──────────────────────────────────
function parseRegridFeature(feat) {
  if (!feat) return null;
  const f = (feat.properties && feat.properties.fields) || {};
  // Prefer Regrid's standardized `address`; otherwise compose from the
  // structured situs-address parts.
  const composed = [f.saddno, f.saddpref, f.saddstr, f.saddsttyp]
    .filter(Boolean).join(' ').trim();
  // Preserve the parcel polygon (Polygon / MultiPolygon only) so the client can
  // snap the pin onto the parcel and draw its outline. Same defensive shape
  // check as integrations/parcel.js.
  let geometry = null;
  if (feat.geometry
      && (feat.geometry.type === 'Polygon' || feat.geometry.type === 'MultiPolygon')
      && Array.isArray(feat.geometry.coordinates)) {
    geometry = { type: feat.geometry.type, coordinates: feat.geometry.coordinates };
  }
  return {
    address: f.address || composed || null,
    houseNumber: f.saddno || null,
    owner: f.owner || null,
    parcelNumber: f.parcelnumb || null,
    lat: f.lat != null ? Number(f.lat) : null,
    lng: f.lon != null ? Number(f.lon) : null,
    city: f.scity || f.city || null,
    state: f.state2 || null,
    zip: f.szip || null,
    county: f.county || null,
    geometry: geometry
  };
}

async function regridPoint(lat, lng, token) {
  const url = 'https://app.regrid.com/api/v2/parcels/point?lat=' + lat +
    '&lon=' + lng + '&limit=1&token=' + encodeURIComponent(token);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const feat = data && data.parcels && data.parcels.features && data.parcels.features[0];
  return parseRegridFeature(feat);
}

async function regridAddress(address, token) {
  const url = 'https://app.regrid.com/api/v2/parcels/address?query=' +
    encodeURIComponent(address) + '&limit=1&token=' + encodeURIComponent(token);
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  const feat = data && data.parcels && data.parcels.features && data.parcels.features[0];
  return parseRegridFeature(feat);
}

// ── Cache ───────────────────────────────────────────────────────────
function cacheHash(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
}
async function readCache(db, key) {
  try {
    const snap = await db.doc('geocode_cache/' + cacheHash(key)).get();
    if (!snap.exists) return null;
    const d = snap.data();
    if (d.cachedAt && d.cachedAt.toMillis && Date.now() - d.cachedAt.toMillis() < CACHE_TTL_MS) {
      return d.payload || null;
    }
  } catch (_) {}
  return null;
}
async function writeCache(db, key, payload) {
  try {
    await db.doc('geocode_cache/' + cacheHash(key)).set(
      { payload, cachedAt: FieldValue.serverTimestamp() }, { merge: true }
    );
  } catch (_) {}
}

// ── Callable: resolveAddress ────────────────────────────────────────
exports.resolveAddress = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 15,
    memory: '256MiB',
    secrets: [GOOGLE_GEOCODING_API_KEY, REGRID_API_TOKEN]
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // 2026-09-25 (decision B, #1780 review): a viewer is refused. Every client
    // call is door verification inside a knock WRITE — the quick-knock sheet
    // (openQuickKnock, which NBDRole.guard() refuses a viewer) and the 🔁 /
    // batch re-verify, which rewrite the knock (rules-refused for a viewer).
    // So each billed Google + Regrid lookup bought a viewer nothing. The
    // client bridge (callResolveAddress) already degrades to its free
    // Nominatim-only path when this call fails.
    assertNotViewer(request.auth.token);

    // Per-uid cap — each uncached call bills Google + Regrid, so an unthrottled
    // rep could enumerate a street. Same limiter family as lookupParcel (60/hr);
    // door verification is higher-volume, so 200/hr.
    const { enforceRateLimit } = require('../integrations/upstash-ratelimit');
    try {
      await enforceRateLimit('callable:resolveAddress:uid', uid, 200, 60 * 60_000);
    } catch (e) {
      if (e.rateLimited) throw new HttpsError('resource-exhausted', 'Too many address checks — try again shortly.');
      throw e;
    }

    const d = request.data || {};
    const mode = d.mode === 'forward' ? 'forward' : 'reverse';
    const gKey = GOOGLE_GEOCODING_API_KEY.value();
    const rToken = REGRID_API_TOKEN.value();
    const hasGoogle = !!(gKey && gKey.startsWith('AIza'));
    const hasRegrid = !!(rToken && rToken.length > 10);
    const db = getFirestore();

    let cacheKey, google = null, regrid = null;

    if (mode === 'reverse') {
      const lat = Number(d.lat), lng = Number(d.lng);
      if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw new HttpsError('invalid-argument', 'Valid lat/lng required');
      }
      cacheKey = 'rev:' + lat.toFixed(6) + ',' + lng.toFixed(6);
      const cached = await readCache(db, cacheKey);
      if (cached) return { ok: true, cached: true, mode, ...cached };
      [google, regrid] = await Promise.all([
        hasGoogle ? googleReverse(lat, lng, gKey).catch(e => { logger.warn('google reverse', e.message); return null; }) : Promise.resolve(null),
        hasRegrid ? regridPoint(lat, lng, rToken).catch(e => { logger.warn('regrid point', e.message); return null; }) : Promise.resolve(null)
      ]);
    } else {
      const address = typeof d.address === 'string' ? d.address.trim() : '';
      if (address.length < 5 || address.length > 300) {
        throw new HttpsError('invalid-argument', 'Valid address required');
      }
      cacheKey = 'fwd:' + address.toLowerCase().replace(/\s+/g, ' ');
      const cached = await readCache(db, cacheKey);
      if (cached) return { ok: true, cached: true, mode, ...cached };
      [google, regrid] = await Promise.all([
        hasGoogle ? googleForward(address, gKey).catch(e => { logger.warn('google forward', e.message); return null; }) : Promise.resolve(null),
        hasRegrid ? regridAddress(address, rToken).catch(e => { logger.warn('regrid address', e.message); return null; }) : Promise.resolve(null)
      ]);
    }

    const payload = { google, regrid, providers: { google: hasGoogle, regrid: hasRegrid } };
    // Only cache a result that actually carries data. A transient Google/Regrid
    // failure returns null indistinguishably from "no address here", and
    // caching that would degrade this pin/address for the whole 30-day TTL —
    // so on a wholly-empty result we skip the cache and re-query next time.
    if (google || regrid) await writeCache(db, cacheKey, payload);
    return { ok: true, cached: false, mode, ...payload };
  }
);

// Reusable geocoder helpers — shared with handlers/reverify-knocks.js so the
// server-side bulk re-verify scores addresses IDENTICALLY to the live path.
exports._googleForward = googleForward;
exports._regridAddress = regridAddress;
exports._parseGoogleResult = parseGoogleResult;
exports._parseRegridFeature = parseRegridFeature;
exports._readCache = readCache;
exports._writeCache = writeCache;

module.exports = exports;
