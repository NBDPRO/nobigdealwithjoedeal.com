/**
 * functions/job-weather.js — the free weather.gov forecast for scheduled job
 * days (production flow, 2026-10-04).
 *
 * Jo roofs in Greater Cincinnati; a wet day moves a job. The forecast shows as
 * a badge on Plan Jobs rows, a line in the morning brief and a line in the
 * job's Google Calendar event. It only ever WARNS — nothing is blocked on it.
 *
 * weather.gov is free and keyless, but asks for an identifying User-Agent
 * (PF.WEATHER_UA) and gentle use. So:
 *   - the forecast URL for a point (one /points lookup) is cached forever;
 *   - the forecast itself is cached for FORECAST_TTL_MS, in memory and in
 *     weather_cache/{gridKey} (admin-SDK only; default-deny for clients);
 *   - neighbours share a cache entry (2-decimal grid ≈ 1 km);
 *   - a failed fetch falls back to the last cached forecast, else nothing.
 *
 * Only jobs with a geocoded point (lead.lat / lead.lng) and a day in the next
 * 7 days get a forecast. Pure rules: production-flow-logic.js.
 *
 * getJobWeather (callable, owner / company_admin / platform admin — the same
 * gate as getBusyTimes): { byLead: { leadId: { 'YYYY-MM-DD': summary } } }
 * for the owner tenant's jobs scheduled in the next 7 days.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const PF = require('./production-flow-logic');
const SW = require('./schedule-window');

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app', 'https://nobigdeal-pro.firebaseapp.com'];
const FORECAST_TTL_MS = 2 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const MAX_POINTS_PER_CALL = 25;
const CACHE = 'weather_cache';

let _fetch = (url, opts) => fetch(url, opts);
const _mem = new Map();

async function getJson(url) {
  const r = await _fetch(url, {
    headers: { 'User-Agent': PF.WEATHER_UA, Accept: 'application/geo+json' },
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined,
  });
  if (!r || !r.ok) throw new Error('weather.gov HTTP ' + (r && r.status));
  return r.json();
}

/**
 * The daily summaries for a point, cached. Never throws: on any failure it
 * returns the last cached summaries, or null.
 */
async function forecastFor(db, lat, lng, nowMs) {
  const key = PF.gridKey(lat, lng);
  if (!key) return null;
  const now = nowMs == null ? Date.now() : nowMs;
  const m = _mem.get(key);
  if (m && now - m.at < FORECAST_TTL_MS) return m.days;
  let cached = null;
  try {
    const s = db ? await db.collection(CACHE).doc(key).get() : null;
    cached = s && s.exists ? s.data() : null;
  } catch (_) { cached = null; }
  if (cached && cached.days && now - Number(cached.fetchedAtMs || 0) < FORECAST_TTL_MS) {
    _mem.set(key, { at: Number(cached.fetchedAtMs), days: cached.days });
    return cached.days;
  }
  try {
    let forecastUrl = cached && typeof cached.forecastUrl === 'string' && cached.forecastUrl.indexOf(PF.WEATHER_HOST + '/') === 0 ? cached.forecastUrl : null;
    if (!forecastUrl) {
      const pt = await getJson(PF.pointsUrl(lat, lng));
      forecastUrl = pt && pt.properties && pt.properties.forecast;
      if (typeof forecastUrl !== 'string' || forecastUrl.indexOf(PF.WEATHER_HOST + '/') !== 0) throw new Error('no forecast url for point');
    }
    const days = PF.dailySummary(PF.slimPeriods(await getJson(forecastUrl)));
    _mem.set(key, { at: now, days });
    if (db) {
      await db.collection(CACHE).doc(key).set({ forecastUrl, days, fetchedAtMs: now }).catch(() => {});
    }
    return days;
  } catch (e) {
    logger.warn('[jobWeather] forecast fetch failed', { key, msg: e && e.message });
    return cached && cached.days ? cached.days : null;
  }
}

/** One lead → { 'YYYY-MM-DD': summary } for its job days in the next 7 days, or null. */
async function weatherByDay(db, lead, nowMs) {
  if (!PF.hasPoint(lead)) return null;
  const today = PF.nyDate(nowMs == null ? Date.now() : nowMs);
  const days = PF.jobDaysWithin(lead, today);
  if (!days.length) return null;
  const all = await forecastFor(db, lead.lat, lead.lng, nowMs);
  if (!all) return null;
  const out = {};
  for (const d of days) if (all[d]) out[d] = all[d];
  return Object.keys(out).length ? out : null;
}

/** Many leads → { leadId: byDay }, at most MAX_POINTS_PER_CALL distinct fetches. */
async function weatherForLeads(db, leads, nowMs) {
  const out = {};
  const points = new Set();
  for (const l of leads || []) {
    if (!l || !l.id || !PF.hasPoint(l)) continue;
    const key = PF.gridKey(l.lat, l.lng);
    if (!points.has(key) && points.size >= MAX_POINTS_PER_CALL) continue;
    points.add(key);
    const w = await weatherByDay(db, l, nowMs);
    if (w) out[String(l.id)] = w;
  }
  return out;
}

// Same gate as getBusyTimes (google-calendar.js requireOwner).
function requireOwner(request, isPlatformAdmin) {
  const a = request.auth;
  if (!a || !a.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const t = a.token || {};
  if (a.uid === OWNER || isPlatformAdmin(t)) return;
  if (t.companyId === OWNER && t.role === 'company_admin') return;
  throw new HttpsError('permission-denied', 'Only the account owner or a company admin can read job weather.');
}

exports.getJobWeather = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 60 },
  async (request) => {
    requireOwner(request, (t) => t.role === 'admin');
    const db = getFirestore();
    const now = Date.now();
    const today = PF.nyDate(now);
    const last = SW.addDays(today, PF.FORECAST_DAYS - 1);
    const seen = new Set();
    const leads = [];
    for (const field of ['companyId', 'userId']) {
      const snap = await db.collection('leads').where(field, '==', OWNER).get();
      snap.forEach((d) => {
        if (seen.has(d.id)) return;
        seen.add(d.id);
        const l = Object.assign({ id: d.id }, d.data());
        const w = SW.normalize(l);
        if (!l.deleted && w && w.date <= last && (w.endDate || w.date) >= today) leads.push(l);
      });
    }
    return { byLead: await weatherForLeads(db, leads, now), today };
  }
);

module.exports.getJobWeather = exports.getJobWeather;
module.exports._internal = {
  forecastFor, weatherByDay, weatherForLeads, FORECAST_TTL_MS,
  setFetch: (f) => { _fetch = f; },
  clearMemory: () => { _mem.clear(); },
};
