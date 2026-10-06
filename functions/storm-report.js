/**
 * stormReport — public storm-history proxy for the /storm-report page.
 *
 * The frontend can't pull this directly: IEM's Local Storm Reports feed
 * has no bounding-box filter and caps at 10k features, so a 5-year query
 * is multi-MB and truncated client-side. This function queries IEM
 * SERVER-side in yearly chunks (each well under the 10k cap), filters to
 * a radius around the property, and caches the small clean result in
 * Firestore per rounded lat/lon — exactly the getGoogleReviews pattern.
 *
 * Public + free: IEM needs no API key. No secrets. Additive — this file
 * is required into index.js and shares nothing with CRM functions.
 *
 * Data source: NWS Local Storm Reports via Iowa Environmental Mesonet
 * (mesonet.agron.iastate.edu) — NOAA/NWS-sourced, already CSP-allowed.
 */
const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { httpRateLimit } = require('./integrations/upstash-ratelimit');
const { gustsForTopStormDays } = require('./integrations/asos-gust');
const GUST = require('./asos-gust-logic');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;     // storm history changes slowly
const YEARS = 5;
const RADIUS_MI = 30;
const STATES = 'OH,KY,IN';
const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function normType(t) {
  t = String(t || '').toUpperCase();
  if (t.includes('HAIL')) return 'hail';
  if (t.includes('TORNADO')) return 'tornado';
  if (t.includes('WND') || t.includes('WIND')) return 'wind';
  return null;
}
function iso(d) { return d.toISOString().slice(0, 16) + 'Z'; }

// "Wind measured nearby" (2026-10-06): the nearest ASOS station's strongest
// gust on each of the top storm days. Computed per request from its OWN
// station+date cache (integrations/asos-gust.js), deliberately NOT stored in
// the 24 h storm_* doc — so a non-final "today" reading never rides a 24 h
// cache, and old storm_* docs need no shape bump. Only station + date go to
// IEM. Any failure → [] (the page hides the block). Never throws.
async function withWindGusts(report, lat, lon, db) {
  let windGusts = [];
  try {
    windGusts = await gustsForTopStormDays(lat, lon, (report && report.events) || [], { db, logger });
  } catch (e) { logger.warn('stormReport: wind gusts skipped', { err: e && e.message }); windGusts = []; }
  return Object.assign({}, report, {
    windGusts,
    windGustSource: windGusts.length ? GUST.GUST_SOURCE_LINE : null,
    windGustContext: windGusts.length ? GUST.GUST_CONTEXT_LINE : null,
  });
}

async function fetchYear(startISO, endISO) {
  const url = 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson?sts=' +
    startISO + '&ets=' + endISO + '&states=' + STATES;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('IEM HTTP ' + res.status);
  const j = await res.json();
  return (j && j.features) || [];
}

async function buildReport(lat, lon) {
  const events = [];
  const now = new Date();
  for (let y = 0; y < YEARS; y++) {
    const end = new Date(Date.UTC(now.getUTCFullYear() - y, now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(Date.UTC(now.getUTCFullYear() - y - 1, now.getUTCMonth(), now.getUTCDate()));
    let feats;
    try { feats = await fetchYear(iso(start), iso(end)); }
    catch (e) { logger.warn('stormReport: year fetch failed', { y, err: e.message }); continue; }
    for (const f of feats) {
      const c = f.geometry && f.geometry.coordinates; const p = f.properties || {};
      const kind = normType(p.typetext || p.type);
      if (!c || !kind) continue;
      const mi = haversineMi(lat, lon, c[1], c[0]);
      if (mi > RADIUS_MI) continue;
      const mag = (p.magf != null && p.magf !== '') ? Number(p.magf) : null;
      events.push({
        date: p.valid || p.utc_valid || '',
        type: kind,
        magnitude: mag,                                   // hail inches OR wind mph
        unit: kind === 'hail' ? 'in' : (kind === 'wind' ? 'mph' : ''),
        distanceMi: Math.round(mi * 10) / 10,
        severity: kind === 'hail'
          ? (mag >= 2 ? 'severe' : mag >= 1 ? 'significant' : 'minor')
          : (mag >= 70 ? 'severe' : mag >= 58 ? 'significant' : 'minor'),
        city: p.city || '', lat: c[1], lon: c[0],
      });
    }
  }
  events.sort((a, b) => (b.date > a.date ? 1 : -1));
  const byType = { hail: 0, wind: 0, tornado: 0 };
  const days = new Set();
  for (const e of events) { byType[e.type]++; if (e.date) days.add(String(e.date).slice(0, 10)); }
  return {
    lat, lon, radiusMi: RADIUS_MI, years: YEARS,
    counts: { total: events.length, stormDays: days.size, ...byType },
    maxHail: events.filter(e => e.type === 'hail' && e.magnitude).reduce((m, e) => Math.max(m, e.magnitude), 0) || null,
    events: events.slice(0, 200),                          // cap payload
    source: 'NWS Local Storm Reports (NOAA) via Iowa Environmental Mesonet',
  };
}

exports.stormReport = onRequest(
  { region: 'us-central1', cors: CORS_ORIGINS, maxInstances: 5, timeoutSeconds: 120, memory: '256MiB' },
  async (req, res) => {
    // Phase-5.2: per-IP rate limit. Results are cached per location, but
    // a distinct-location flood would otherwise tie up the (maxInstances:5)
    // pool with slow uncached IEM fetches + pollute public_cache. 30/min/IP
    // is ample for a homeowner checking storm history.
    if (!(await httpRateLimit(req, res, 'stormReport:ip', 30, 60_000))) return;
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    if (!isFinite(lat) || !isFinite(lon) || lat < 24 || lat > 50 || lon < -130 || lon > -60) {
      return res.status(400).json({ error: 'Valid US lat/lon required' });
    }
    const key = GUST.stormReportCacheKey(lat, lon);
    const db = getFirestore();
    const ref = db.doc('public_cache/' + key);
    const now = Date.now();

    let cached = null;
    try { const s = await ref.get(); if (s.exists) cached = s.data(); }
    catch (e) { logger.warn('stormReport: cache read failed', e); }

    if (cached && cached.fetchedAt && now - cached.fetchedAt < CACHE_TTL_MS) {
      res.set('Cache-Control', 'public, max-age=3600');
      const out = await withWindGusts(cached.data, lat, lon, db);
      return res.status(200).json({ ...out, cached: true, stale: false, fetchedAt: cached.fetchedAt });
    }
    try {
      const fresh = await buildReport(lat, lon);
      await ref.set({ data: fresh, fetchedAt: now }, { merge: true });
      res.set('Cache-Control', 'public, max-age=3600');
      const out = await withWindGusts(fresh, lat, lon, db);
      return res.status(200).json({ ...out, cached: false, stale: false, fetchedAt: now });
    } catch (err) {
      logger.error('stormReport: build failed', err);
      if (cached && cached.data) {
        const out = await withWindGusts(cached.data, lat, lon, db);
        return res.status(200).json({ ...out, cached: true, stale: true, fetchedAt: cached.fetchedAt || 0 });
      }
      return res.status(200).json({
        lat, lon, radiusMi: RADIUS_MI, years: YEARS,
        counts: { total: 0, stormDays: 0, hail: 0, wind: 0, tornado: 0 },
        maxHail: null, events: [], source: 'NWS LSR via IEM', empty: true, fetchedAt: now,
      });
    }
  }
);
