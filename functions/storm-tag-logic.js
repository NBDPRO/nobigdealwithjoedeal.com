/**
 * storm-tag-logic.js — which storm brought this lead in? (2026-10-04)
 *
 * "Results per storm" (the numbers audit): a lead created within N days of a
 * storm in its area — or one whose date of loss was accepted from a storm
 * report — carries a stormId, so Reports can show leads, wins and booked $
 * per storm.
 *
 * A storm is a storm DAY in the service area: every qualifying NWS/IEM Local
 * Storm Report the stormWatch cron stored (storm_events/{key}) on one Eastern
 * calendar day is the same storm. stormId = 'storm-YYYY-MM-DD'. The same id
 * is what the CRM's dol-fill.js stamps when Jo accepts a storm-report date of
 * loss, so both paths group together.
 *
 * Pure: no firebase imports. storm-tag.js does the I/O.
 */
'use strict';

const STORM_WINDOW_DAYS = 14;   // a lead within 14 days AFTER the storm
const STORM_RADIUS_MI = 10;     // …within 10 miles of a report
const DAY_MS = 86400000;

function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return 0; } }
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return 0;
}

// IEM `valid` is UTC, usually without a zone suffix ("2026-06-14T21:30:00").
// One reader for the CRM, the storm page and Storm Watch: storm-time.js.
const { validMs, ymdEt } = require('./storm-time');

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
function stormIdForYmd(ymd) { return isYmd(ymd) ? 'storm-' + ymd : null; }

/**
 * The storm a lead belongs to, or null. Pure.
 * @param {object} lead   { lat, lng, createdAtMs? , createdAt?, dateOfLoss?, dateOfLossSource? }
 * @param {object[]} events storm_events docs { lat, lon, valid, kind, mag, city, st }
 * @param {object} [opts] { nowMs, days, radiusMi }
 * @returns {null | { stormId, stormDate, stormKind, stormDistanceMi, stormPlace, stormTaggedBy }}
 */
function matchStorm(lead, events, opts) {
  const o = opts || {};
  if (!lead) return null;
  // An accepted storm-report date of loss names the storm outright.
  if (isYmd(lead.dateOfLoss) && /storm/i.test(String(lead.dateOfLossSource || ''))) {
    return { stormId: stormIdForYmd(lead.dateOfLoss), stormDate: lead.dateOfLoss, stormKind: null, stormDistanceMi: null, stormPlace: '', stormTaggedBy: 'date_of_loss' };
  }
  const lat = Number(lead.lat), lng = Number(lead.lng != null ? lead.lng : lead.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  const createdMs = toMs(lead.createdAtMs) || toMs(lead.createdAt) || toMs(o.nowMs) || Date.now();
  const days = Number(o.days) > 0 ? Number(o.days) : STORM_WINDOW_DAYS;
  const radius = Number(o.radiusMi) > 0 ? Number(o.radiusMi) : STORM_RADIUS_MI;
  let best = null;
  for (const ev of events || []) {
    if (!ev) continue;
    const t = validMs(ev.valid);
    if (!t || t > createdMs || createdMs - t > days * DAY_MS) continue;
    const eLat = Number(ev.lat), eLon = Number(ev.lon != null ? ev.lon : ev.lng);
    if (!Number.isFinite(eLat) || !Number.isFinite(eLon)) continue;
    const d = haversineMi(lat, lng, eLat, eLon);
    if (d > radius) continue;
    const hail = ev.kind === 'hail' ? 1 : 0;
    const cand = { t, d, hail, ev };
    // Hail beats wind, then closer, then more recent.
    if (!best || cand.hail > best.hail || (cand.hail === best.hail && (cand.d < best.d - 0.01 || (Math.abs(cand.d - best.d) <= 0.01 && cand.t > best.t)))) best = cand;
  }
  if (!best) return null;
  const ymd = ymdEt(best.t);
  return {
    stormId: stormIdForYmd(ymd),
    stormDate: ymd,
    stormKind: best.ev.kind || null,
    stormDistanceMi: Math.round(best.d * 10) / 10,
    stormPlace: [best.ev.city, best.ev.st].filter(Boolean).join(', ').slice(0, 80),
    stormTaggedBy: 'created_after_storm',
  };
}

/** The lead update, or null (already tagged / not taggable). */
function stormTagPatch(lead, events, opts) {
  if (!lead || lead.deleted === true || lead.e2eTestData || lead.isProspect === true) return null;
  if (typeof lead.stormId === 'string' && lead.stormId) return null;
  const m = matchStorm(lead, events, opts);
  if (!m) return null;
  const patch = { stormId: m.stormId, stormDate: m.stormDate, stormTaggedBy: m.stormTaggedBy };
  if (m.stormKind) patch.stormKind = m.stormKind;
  if (m.stormDistanceMi != null) patch.stormDistanceMi = m.stormDistanceMi;
  if (m.stormPlace) patch.stormPlace = m.stormPlace;
  return patch;
}

module.exports = { STORM_WINDOW_DAYS, STORM_RADIUS_MI, haversineMi, validMs, ymdEt, stormIdForYmd, matchStorm, stormTagPatch };
