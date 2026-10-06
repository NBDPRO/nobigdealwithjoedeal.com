/**
 * integrations/asos-gust.js — measured wind gusts from the nearest ASOS
 * weather station, for the storm report (public /storm-report + its
 * follow-up email) and the CRM storm proof. Pure rules live in
 * ../asos-gust-logic.js; this file is the I/O: one keyless IEM GET per
 * station-day, cached in Firestore.
 *
 *   Cache:  public_cache/gust_{STATION}_{YYYYMMDD}  (admin-SDK only; the
 *           public_cache rule is read/write:false for clients)
 *           { stationId, date, gustKnots|null, final, fetchedAt }
 *           A past day (ended ≥3 h ago) is cached FINAL and never expires.
 *           Today is cached non-final with a 30-min TTL. Keyed by station +
 *           date, not address, so every neighbour shares one entry.
 *   Polite: ≤1 request in flight per instance with a ≥350 ms gap, an 8 s
 *           timeout per request, and the caller stops after the first error.
 *   Privacy: IEM receives ONLY the station code and the date.
 *   Fail-closed: any error (network, timeout, HTTP, parse, Firestore) means
 *           "no line" — never a 0, never a guess. Errors are never cached.
 *
 * $0: IEM is public domain and keyless. No secret, no CSP change (server-side).
 */
'use strict';

const L = require('../asos-gust-logic');

const FETCH_TIMEOUT_MS = 8000;
const MIN_GAP_MS = 350;
let _lastRequestAt = 0;
let _chain = Promise.resolve();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Serialise IEM requests per instance and keep a gap between them.
function polite(fn) {
  const run = _chain.then(async () => {
    const wait = _lastRequestAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    _lastRequestAt = Date.now();
    return fn();
  });
  _chain = run.catch(() => {});
  return run;
}

// Max gust (knots) for one station's local day straight from IEM, or null
// when the station has no reading. Throws on transport / HTTP failure.
async function fetchStationDayKnots(stationId, date, opts) {
  const o = opts || {};
  const fetchImpl = o.fetchImpl || fetch;
  const url = L.buildAsosUrl(stationId, date);
  return polite(async () => {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(o.timeoutMs || FETCH_TIMEOUT_MS) });
    if (!res || !res.ok) throw new Error('IEM ASOS HTTP ' + (res && res.status));
    const body = await res.text();
    return L.parseMaxGustKnots(body);
  });
}

// { gustKnots|null, final } for a station-day, cache first. Throws on a
// fetch failure (callers map that to "hide"); a cache READ/WRITE failure
// alone never throws — it just means an uncached fetch.
async function stationDayKnots(stationId, date, deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now() : Date.now();
  const ref = d.db ? d.db.doc('public_cache/' + L.cacheKey(stationId, date)) : null;
  if (ref) {
    try {
      const snap = await ref.get();
      if (snap && snap.exists) {
        const c = snap.data();
        if (L.cacheFresh(c, now)) {
          return { gustKnots: (c.gustKnots === null || c.gustKnots === undefined) ? null : Number(c.gustKnots), final: c.final === true, cached: true };
        }
      }
    } catch (e) { if (d.logger) d.logger.warn('asosGust: cache read failed', { err: e && e.message }); }
  }
  const gustKnots = await fetchStationDayKnots(stationId, date, d);
  const final = L.isFinalDay(date, now);
  if (ref) {
    try { await ref.set({ stationId, date, gustKnots, final, fetchedAt: now }); }
    catch (e) { if (d.logger) d.logger.warn('asosGust: cache write failed', { err: e && e.message }); }
  }
  return { gustKnots, final, cached: false };
}

// The gust line for ONE address and ONE local date, from the nearest station
// only. Returns { stationId, stationName, distanceMi, gustMph, date, line }
// or null (= hide the line). Never throws.
async function gustForAddressDay(lat, lng, date, deps) {
  try {
    const st = L.nearestStation(lat, lng);
    if (!st || !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
    const r = await stationDayKnots(st.id, date, deps);
    const gustMph = L.knotsToMph(r.gustKnots);
    if (gustMph === null) return null;
    const out = { stationId: st.id, stationName: st.name, distanceMi: st.distanceMi, gustMph, date };
    out.line = L.gustLine(out);
    return out.line ? out : null;
  } catch (e) {
    if (deps && deps.logger) deps.logger.warn('asosGust: lookup failed — line hidden', { date, err: e && e.message });
    if (deps && typeof deps.onError === 'function') deps.onError(e);
    return null;
  }
}

// Gust lines for the top storm days of a storm-report events[] list. Stops
// after the first IEM failure (fail-closed: what we have so far, or []).
async function gustsForTopStormDays(lat, lng, events, deps) {
  const st = L.nearestStation(lat, lng);
  if (!st) return [];
  const out = [];
  for (const date of L.pickTopStormDays(events, L.TOP_STORM_DAYS)) {
    let failed = false;
    const g = await gustForAddressDay(lat, lng, date, Object.assign({}, deps, { onError: () => { failed = true; } }));
    if (g) out.push(g);
    if (failed) break;
  }
  return out;
}

function _resetPoliteForTests() { _lastRequestAt = 0; _chain = Promise.resolve(); }

module.exports = { fetchStationDayKnots, stationDayKnots, gustForAddressDay, gustsForTopStormDays, FETCH_TIMEOUT_MS, MIN_GAP_MS, _resetPoliteForTests };
