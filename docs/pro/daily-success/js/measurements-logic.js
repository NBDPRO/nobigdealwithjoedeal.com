/**
 * measurements-logic.js — the pure rules behind the body-measurements card
 * (Daily Success roadmap, Horizon 2 item 4). Waist, chest, arms, thighs and
 * the like, logged weight-independent, with a trend per site.
 *
 *   toMm / fromMm   one canonical unit on disk (whole millimetres), shown in
 *                   inches or centimetres by the user's setting, so flipping
 *                   the unit never drifts a stored number
 *   parseEntry      text box -> millimetres, or null (blank, zero, negative,
 *                   NaN, a body part no human has)
 *   upsert          one value per site per day; re-logging a day replaces it
 *   series / trend  oldest-first points and latest / change since ~4 weeks ago
 *   sparkline       a tiny inline-SVG line (no library)
 *
 * Dates are local YYYY-MM-DD strings, never parsed with new Date('YYYY-MM-DD')
 * (UTC midnight is the day before in New York). Device-local only: the list
 * lives in localStorage and is not part of the cloud-synced pages.
 *
 * Exposed as window.NBDMeasure and module.exports (tests).
 */
(function (root) {
  'use strict';

  const MM_PER_IN = 25.4;
  const MIN_MM = 50;      // 5 cm: below this it is a typo, not a calf
  const MAX_MM = 3000;    // 3 m
  const TREND_DAYS = 28;

  const SITES = [
    { id: 'waist', label: 'Waist' },
    { id: 'chest', label: 'Chest' },
    { id: 'hips', label: 'Hips' },
    { id: 'neck', label: 'Neck' },
    { id: 'arm', label: 'Arm' },
    { id: 'thigh', label: 'Thigh' },
    { id: 'calf', label: 'Calf' },
  ];

  const siteIds = () => SITES.map((s) => s.id);
  const validSite = (s) => siteIds().indexOf(s) !== -1;
  const validYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const validUnit = (u) => u === 'in' || u === 'cm';
  const ymdMs = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const dayDiff = (a, b) => Math.round((ymdMs(b) - ymdMs(a)) / 86400000);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toMm(value, unit) {
    const n = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
    if (!isFinite(n)) return null;
    return Math.round(n * (unit === 'cm' ? 10 : MM_PER_IN));
  }

  function fromMm(mm, unit) {
    if (!isFinite(mm)) return null;
    const v = unit === 'cm' ? mm / 10 : mm / MM_PER_IN;
    return Math.round(v * 10) / 10;
  }

  /** "34.5" in the user's unit -> whole mm, or null when it is not a plausible body measurement. */
  function parseEntry(text, unit) {
    if (text == null || String(text).trim() === '') return null;
    if (!/^\s*\d+([.,]\d+)?\s*$/.test(String(text))) return null;
    const mm = toMm(text, validUnit(unit) ? unit : 'in');
    if (mm == null || mm < MIN_MM || mm > MAX_MM) return null;
    return mm;
  }

  const format = (mm, unit) => {
    const v = fromMm(mm, validUnit(unit) ? unit : 'in');
    return v == null ? '' : v.toFixed(1) + ' ' + (unit === 'cm' ? 'cm' : 'in');
  };

  /** Sanitise whatever came out of storage: only well-formed rows survive. */
  function clean(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((e) => e && validSite(e.site) && validYmd(e.date) && isFinite(e.mm) && e.mm >= MIN_MM && e.mm <= MAX_MM)
      .map((e) => ({ date: e.date, site: e.site, mm: Math.round(e.mm) }));
  }

  /** Returns a new list: one row per (date, site); re-logging replaces. Invalid input returns the list unchanged. */
  function upsert(list, date, site, mm) {
    const base = clean(list);
    if (!validYmd(date) || !validSite(site) || !isFinite(mm) || mm < MIN_MM || mm > MAX_MM) return base;
    const rest = base.filter((e) => !(e.date === date && e.site === site));
    rest.push({ date, site, mm: Math.round(mm) });
    return rest.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.site < b.site ? -1 : 1));
  }

  function remove(list, date, site) {
    return clean(list).filter((e) => !(e.date === date && e.site === site));
  }

  const series = (list, site) => clean(list).filter((e) => e.site === site).sort((a, b) => (a.date < b.date ? -1 : 1));

  /**
   * { count, latest, latestDate, change } — change is latest minus the entry
   * closest to TREND_DAYS before it (the oldest point if the history is
   * shorter than that), in mm; null with fewer than two points.
   */
  function trend(list, site) {
    const s = series(list, site);
    if (!s.length) return { count: 0, latest: null, latestDate: null, change: null, since: null };
    const last = s[s.length - 1];
    if (s.length < 2) return { count: 1, latest: last.mm, latestDate: last.date, change: null, since: null };
    let ref = s[0];
    let best = Infinity;
    for (let i = 0; i < s.length - 1; i++) {
      const gap = Math.abs(dayDiff(s[i].date, last.date) - TREND_DAYS);
      if (gap < best) { best = gap; ref = s[i]; }
    }
    return { count: s.length, latest: last.mm, latestDate: last.date, change: last.mm - ref.mm, since: ref.date };
  }

  /** Tiny line chart for one site's series; '' under two points. */
  function sparkline(points, label) {
    const pts = (points || []).filter((p) => p && isFinite(p.mm));
    if (pts.length < 2) return '';
    const W = 300, H = 60, PAD = 6;
    const xs = pts.map((p) => ymdMs(p.date));
    const x0 = xs[0], x1 = xs[xs.length - 1];
    const lo = Math.min.apply(null, pts.map((p) => p.mm));
    const hi = Math.max.apply(null, pts.map((p) => p.mm));
    const px = (i) => (x1 === x0 ? W / 2 : PAD + ((xs[i] - x0) / (x1 - x0)) * (W - 2 * PAD));
    const py = (v) => (hi === lo ? H / 2 : H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD));
    const line = pts.map((p, i) => px(i).toFixed(1) + ',' + py(p.mm).toFixed(1)).join(' ');
    const last = pts.length - 1;
    return '<svg class="ms-spark" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(label || 'Measurement trend') + '" preserveAspectRatio="none">' +
      '<polyline class="ms-line" fill="none" points="' + line + '"/>' +
      '<circle class="ms-dot" r="3.5" cx="' + px(last).toFixed(1) + '" cy="' + py(pts[last].mm).toFixed(1) + '"/></svg>';
  }

  const api = { SITES, TREND_DAYS, MIN_MM, MAX_MM, validSite, validUnit, validYmd, toMm, fromMm, parseEntry, format, clean, upsert, remove, series, trend, sparkline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDMeasure = api;
})(typeof window !== 'undefined' ? window : null);
