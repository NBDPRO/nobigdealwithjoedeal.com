/**
 * scripts/lib/photo-match.js
 *
 * Pure scoring core for scripts/match-job-photos.js. No I/O, no network.
 * Pinned by tests/match-job-photos-2026-11-09.test.js.
 *
 * A photo is matched to a lead only on evidence that cannot be a coincidence
 * of street names:
 *   high   GPS within 75 m of the lead AND the photo date inside the job window
 *   medium (street key in the file path AND date in window, GPS absent or
 *          within 150 m) OR (GPS within 150 m AND date in window)
 *   low    GPS within 150 m only (date missing or outside the window)
 * Street key alone, or date alone, never matches.
 */
'use strict';

const DAY = 86400000;
const BEFORE_DAYS = 60;   // inspection / tear-off prep photos
const AFTER_DAYS = 14;    // cleanup, final walk-around
const GPS_HIGH_M = 75;
const GPS_MAX_M = 150;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// "1004 Larkspur Dr, Maineville, OH" -> "1004 larkspur dr"
function addrKey(s) {
  const m = norm(s).match(/^(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/);
  return m ? `${m[1]} ${m[2]}` : '';
}

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const ts = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

// { start, end } in ms, from the lead's stage dates; null when none usable.
function jobWindow(stageDates) {
  const sd = stageDates || {};
  const first = ['install_in_progress', 'install_scheduled', 'contract_signed'].map(k => ts(sd[k])).find(v => v != null);
  const last = ['install_complete', 'final_payment', 'closed'].map(k => ts(sd[k])).find(v => v != null);
  const start = first != null ? first : last;
  if (start == null) return null;
  const endBase = last != null && last >= start ? last : start;
  return { start, end: endBase + DAY - 1 };
}

function phaseFor(takenAt, win) {
  const t = ts(takenAt);
  if (t == null || !win) return null;
  if (t >= win.start && t <= win.end) return 'during';
  if (t < win.start && t >= win.start - BEFORE_DAYS * DAY) return 'before';
  if (t > win.end && t <= win.end + AFTER_DAYS * DAY) return 'after';
  return null;
}

function scorePhoto(photo, lead) {
  const win = jobWindow(lead.stageDates);
  const phase = phaseFor(photo.takenAt, win);
  const hasGps = Number.isFinite(photo.lat) && Number.isFinite(photo.lng);
  const leadGps = Number.isFinite(lead.lat) && Number.isFinite(lead.lng);
  const dist = hasGps && leadGps ? distanceM(photo.lat, photo.lng, lead.lat, lead.lng) : null;
  const key = addrKey(lead.address);
  const streetHit = !!key && norm(photo.path).includes(key);

  // GPS says it was shot somewhere else: the filename cannot override that.
  if (dist != null && dist > GPS_MAX_M) return null;

  let confidence = null;
  if (dist != null && dist <= GPS_HIGH_M && phase) confidence = 'high';
  else if (dist != null && phase) confidence = 'medium';
  else if (streetHit && phase) confidence = 'medium';
  else if (dist != null) confidence = 'low';
  if (!confidence) return null;
  return { leadId: lead.id, confidence, phase, distanceM: dist == null ? null : Math.round(dist), streetHit };
}

const RANK = { high: 3, medium: 2, low: 1 };

// Best lead for one photo. ambiguous = another lead scored the same tier.
function bestMatch(photo, leads) {
  const scored = leads.map(l => scorePhoto(photo, l)).filter(Boolean);
  if (!scored.length) return null;
  scored.sort((a, b) => RANK[b.confidence] - RANK[a.confidence] ||
    (a.distanceM == null ? 1e9 : a.distanceM) - (b.distanceM == null ? 1e9 : b.distanceM));
  const top = scored[0];
  return Object.assign({}, top, { ambiguous: scored.some((s, i) => i > 0 && s.confidence === top.confidence) });
}

// CSV cell: quote it and defuse spreadsheet formulas.
function csvCell(v) {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r']/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Script-free local contact sheet. thumb is a relative file path or ''.
function contactSheetHtml(rows) {
  const cards = rows.map(r => `<figure><div class="img">${r.thumb ? `<img src="${esc(r.thumb)}" alt="">` : ''}</div>` +
    `<figcaption><b class="${esc(r.confidence)}">${esc(r.confidence)}</b> ${esc(r.phase || '')}<br>${esc(r.leadLabel)}<br><small>${esc(r.file)}</small></figcaption></figure>`).join('\n');
  return '<!doctype html><meta charset="utf-8"><title>Photo review</title>' +
    '<style>body{font:14px system-ui;margin:16px}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}' +
    'figure{margin:0;border:1px solid #DFE2E7;border-radius:6px;padding:8px}.img{height:160px;background:#F6F7F8}' +
    '.img img{width:100%;height:160px;object-fit:cover}.high{color:#1a7f37}.medium{color:#BD5728}.low{color:#4C4C4D}</style>' +
    `<h1>Photo review (${rows.length})</h1><div class="g">\n${cards}\n</div>`;
}

// Counts only, safe to print: no names, no addresses.
function summarize(rows, scanned, allLeadIds, matchedLeadIds) {
  const byConfidence = { high: 0, medium: 0, low: 0 };
  rows.forEach(r => { byConfidence[r.confidence]++; });
  const matched = new Set(matchedLeadIds);
  return {
    scanned,
    withGps: rows.filter(r => r.hasGps).length,
    matched: rows.length,
    byConfidence,
    jobsWithoutPhotos: allLeadIds.filter(id => !matched.has(id)).length
  };
}

module.exports = { addrKey, distanceM, jobWindow, phaseFor, scorePhoto, bestMatch, csvCell, contactSheetHtml, summarize, norm };
