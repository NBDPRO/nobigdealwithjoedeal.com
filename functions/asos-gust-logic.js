/**
 * asos-gust-logic.js — pure logic behind the "Wind measured nearby" line on
 * storm reports (2026-10-06, Jo's decisions; research in
 * repo-lab/WIND-GUST-DATA-OPTIONS-2026-10-06.md).
 *
 * Source: NOAA/NWS ASOS airport-station observations served keyless by the
 * Iowa Environmental Mesonet (public domain). One line per storm day, from the
 * NEAREST station only, naming the station, its code and its distance:
 *
 *   "The strongest gust measured at Lunken Airport (LUK), 6 mi from your
 *    address, was 45 mph on May 16, 2026."
 *
 * Rules this module enforces (each has a test in tests/wind-gust-2026-10-06.test.js):
 *   - Missing data is NOT zero. IEM writes 'M' for a missing value; a station
 *     outage (every row 'M', or no rows) and a calm day (no gust group in any
 *     METAR) both mean "no reading" → the line is HIDDEN, never "0 mph" and
 *     never a "no reading" sentence.
 *   - Nearest station only. If the nearest station has no reading that day the
 *     line is hidden; we never fall back to a farther station.
 *   - Only the station code and the date go to IEM — never the homeowner's
 *     address or coordinates (buildAsosUrl takes nothing else).
 *   - Wording guardrail (OH/KY): a station reading is context, not a damage or
 *     coverage call. The line never says "hit your street", "your roof
 *     qualifies", "claimable", or ties a speed to damage, and it always sits
 *     next to GUST_CONTEXT_LINE ("only an inspection can show" / "up to your
 *     insurer").
 *
 * Dependency-free (no firebase) so tests require() it directly.
 */
'use strict';

const STATION_DATA = require('./data/asos-stations.json');

const STATIONS = Object.freeze(STATION_DATA.stations.map((s) => Object.freeze(Object.assign({}, s))));

// A station farther than this from the address is not "nearby" — hide the line.
const MAX_STATION_MI = 30;
// knots → statute mph (1 kt = 1.15078 mph). Rounded to the nearest whole mph,
// the NWS convention (39 kt → 45 mph).
const KT_TO_MPH = 1.15078;
// How many storm days per report get a gust lookup (polite to IEM: at most
// this many uncached requests per address).
const TOP_STORM_DAYS = 3;
// A day's readings are FINAL (cached forever) once the local day ended at
// least this long ago — IEM syncs its archive every ~10 min, so 3 h is ample.
// Today (and the first hours after midnight) is never cached as final.
const FINAL_AFTER_MS = 3 * 60 * 60 * 1000;
// Non-final (today's) cache entries are re-fetched after this.
const NONFINAL_TTL_MS = 30 * 60 * 1000;
const TZ = 'America/New_York';

const GUST_SOURCE_LINE = 'NOAA/NWS weather-station observations via the Iowa Environmental Mesonet (Iowa State University).';
const GUST_CONTEXT_LINE = 'A reading at a weather station is not a reading at your home. Only an inspection can show whether there’s real damage, and whether a claim is approved is up to your insurer.';

const IEM_ASOS_URL = 'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py';

function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8;
  const dLa = (la2 - la1) * Math.PI / 180;
  const dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// The single nearest station to (lat, lng), or null when the point is invalid
// or no station is within maxMi. Returns a copy with distanceMi (1 decimal).
function nearestStation(lat, lng, stations, maxMi) {
  const list = Array.isArray(stations) ? stations : STATIONS;
  const cap = (typeof maxMi === 'number' && isFinite(maxMi)) ? maxMi : MAX_STATION_MI;
  const la = Number(lat), lo = Number(lng);
  if (lat == null || lng == null || !isFinite(la) || !isFinite(lo)) return null;
  let best = null, bestMi = Infinity;
  for (const s of list) {
    if (!s || !isFinite(Number(s.lat)) || !isFinite(Number(s.lng))) continue;
    const mi = haversineMi(la, lo, Number(s.lat), Number(s.lng));
    if (mi < bestMi) { bestMi = mi; best = s; }
  }
  if (!best || bestMi > cap) return null;
  return { id: best.id, name: best.name, lat: best.lat, lng: best.lng, distanceMi: Math.round(bestMi * 10) / 10 };
}

// knots → whole mph. Anything that is not a positive finite number is "no
// reading" (null) — a 0 or negative gust is never shown.
function knotsToMph(kt) {
  if (kt === null || kt === undefined || kt === '') return null;
  const n = Number(kt);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * KT_TO_MPH);
}

// One IEM value cell → knots, or null for 'M' / empty / non-numeric / ≤0.
function cellKnots(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t || t.toUpperCase() === 'M' || t.toUpperCase() === 'T') return null;
  const n = Number(t);
  return (isFinite(n) && n > 0) ? n : null;
}

// Max gust (knots) across the `gust` (METAR gust group) and `peak_wind_gust`
// (METAR "PK WND" remark) columns of an IEM asos.py `format=onlycomma` body.
// Returns null when there is no reading at all (every value missing, no data
// rows, wrong columns, or not CSV) — never 0.
function parseMaxGustKnots(csv) {
  if (typeof csv !== 'string' || !csv.trim()) return null;
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (lines.length < 2) return null;
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const cols = ['gust', 'peak_wind_gust'].map((c) => head.indexOf(c)).filter((i) => i >= 0);
  if (!cols.length) return null;
  let max = null;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    for (const c of cols) {
      const k = cellKnots(cells[c]);
      if (k !== null && (max === null || k > max)) max = k;
    }
  }
  return max;
}

// 'YYYY-MM-DD' calendar date of an instant in America/New_York, or '' when
// the input is not a valid time. LSR `valid` is UTC ('…T00:25:00Z'), so an
// 8:25 pm EDT storm is the PREVIOUS UTC date — this is the homeowner's date.
function localDate(when) {
  const d = when instanceof Date ? when : new Date(when);
  if (!when || isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

function isDateStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')); }

// Rank an event: tornado, hail ≥1", or wind ≥58 mph are the big ones.
function eventScore(e) {
  if (!e) return 0;
  const m = Number(e.magnitude);
  if (e.type === 'tornado') return 3;
  if (e.type === 'hail' && isFinite(m) && m >= 1) return 2;
  if (e.type === 'wind' && isFinite(m) && m >= 58) return 2;
  return 1;
}

// The top storm days (local dates) from a storm-report events[] list: the
// strongest days first (tornado / hail ≥1" / wind ≥58 mph), then newest.
function pickTopStormDays(events, n) {
  const want = (typeof n === 'number' && n > 0) ? n : TOP_STORM_DAYS;
  const byDay = new Map();
  for (const e of (Array.isArray(events) ? events : [])) {
    const day = localDate(e && e.date);
    if (!day) continue;
    byDay.set(day, Math.max(byDay.get(day) || 0, eventScore(e)));
  }
  return Array.from(byDay.entries())
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .slice(0, want)
    .map((x) => x[0]);
}

// The IEM request for one station's local day. Takes ONLY the station code
// and the date — there is deliberately no parameter for the address.
function buildAsosUrl(stationId, date) {
  if (!/^[A-Z0-9]{3,4}$/.test(String(stationId || ''))) throw new Error('bad station');
  if (!isDateStr(date)) throw new Error('bad date');
  const d = new Date(date + 'T12:00:00Z');
  const next = new Date(d.getTime() + 86400000);
  const q = [
    'station=' + stationId,
    'data=gust', 'data=peak_wind_gust',
    'year1=' + d.getUTCFullYear(), 'month1=' + (d.getUTCMonth() + 1), 'day1=' + d.getUTCDate(),
    'year2=' + next.getUTCFullYear(), 'month2=' + (next.getUTCMonth() + 1), 'day2=' + next.getUTCDate(),
    'tz=' + encodeURIComponent(TZ),
    'format=onlycomma', 'latlon=no', 'missing=M',
  ];
  return IEM_ASOS_URL + '?' + q.join('&');
}

// The storm-report cache doc id for a point (public_cache/{this}) — shared by
// stormReport (writer) and stormReportEmail (reader) so the two never drift.
function stormReportCacheKey(lat, lon) {
  return 'storm_' + Number(lat).toFixed(2).replace(/[.-]/g, '_') + '__' + Number(lon).toFixed(2).replace(/[.-]/g, '_');
}

function cacheKey(stationId, date) {
  return 'gust_' + String(stationId) + '_' + String(date).replace(/-/g, '');
}

// Epoch ms of local midnight that ENDS `date` (i.e. 00:00 the next day, ET).
function dayEndMs(date) {
  // Try both possible ET offsets (EDT -4, EST -5); pick the one whose local
  // date at (end - 1 ms) is still `date`.
  const base = Date.parse(date + 'T00:00:00Z') + 86400000;
  for (const off of [4, 5]) {
    const t = base + off * 3600000;
    if (localDate(new Date(t - 1)) === date && localDate(new Date(t)) !== date) return t;
  }
  return base + 5 * 3600000;
}

// True when `date`'s readings will not change any more (day ended ≥3 h ago).
function isFinalDay(date, nowMs) {
  if (!isDateStr(date)) return false;
  return (Number(nowMs) || Date.now()) - dayEndMs(date) >= FINAL_AFTER_MS;
}

// Is a cached gust entry still usable? Final entries never expire; anything
// else is good for NONFINAL_TTL_MS.
function cacheFresh(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.final === true) return true;
  const at = Number(entry.fetchedAt);
  return isFinite(at) && (Number(nowMs) || Date.now()) - at < NONFINAL_TTL_MS;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtDateLong(date) {
  if (!isDateStr(date)) return '';
  const [y, m, d] = date.split('-').map(Number);
  return MONTHS[m - 1] + ' ' + d + ', ' + y;
}

// The homeowner-facing sentence, or '' (= hide) when there is no positive
// reading. Plain text — every caller renders it escaped / via textContent.
function gustLine(g) {
  if (!g) return '';
  const mph = Number(g.gustMph);
  if (!isFinite(mph) || mph <= 0) return '';
  const when = fmtDateLong(g.date);
  if (!when || !g.stationId || !g.stationName) return '';
  const mi = Math.max(1, Math.round(Number(g.distanceMi) || 0));
  return 'The strongest gust measured at ' + g.stationName + ' (' + g.stationId + '), ' +
    mi + ' mi from your address, was ' + Math.round(mph) + ' mph on ' + when + '.';
}

module.exports = {
  STATIONS, MAX_STATION_MI, KT_TO_MPH, TOP_STORM_DAYS, FINAL_AFTER_MS, NONFINAL_TTL_MS,
  GUST_SOURCE_LINE, GUST_CONTEXT_LINE, IEM_ASOS_URL,
  haversineMi, nearestStation, knotsToMph, parseMaxGustKnots, localDate, pickTopStormDays,
  buildAsosUrl, cacheKey, stormReportCacheKey, isFinalDay, cacheFresh, fmtDateLong, gustLine, eventScore,
};
