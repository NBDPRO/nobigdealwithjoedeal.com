/**
 * team-board-logic.js — window.NBDTeamBoard: reading the team aggregate rows
 * (NBD OS P2 Team, 2026-11-09; documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P2).
 *
 * functions/leaderboard-aggregate.js writes leaderboard/{uid} every 30 minutes:
 *   { companyId, uid, name, tz, tzSet, dayKey, weekKey, today:{doors,appts,estimates,deals}, week:{…}, asOfMs }
 * in the company's time zone (companyProfile.timeZone), weeks from Monday.
 * Readers: pages/leaderboard.js (the Leaderboard page) and os/team.js (the
 * owner's Team widget on the NBD OS home).
 *
 * A row's numbers are shown only for the period they were counted in: today's
 * only while the row's dayKey is today in its zone, the week's only while its
 * week is this week. A stale row (the aggregate stopped, or the day turned since
 * it ran) shows nothing for that period, never yesterday's numbers as today's.
 * A number that is not a whole count makes its whole period nothing.
 *
 *   ymdInZone(ms, tz)        'YYYY-MM-DD' of an instant in a zone
 *   mondayOf(ymd)            the Monday on or before it
 *   current(row, nowMs)      { today: metrics|null, week: metrics|null }
 *   board(rows, period, nowMs, field)  [{ uid, name, doors, appts, estimates, deals }] ranked
 *                            by field (default doors), rows current for 'day' | 'week' only
 *   totals(list)             the board's sums
 *   usable(rows, uid, period, tab, nowMs)  the Leaderboard page may rank from the rows:
 *                            Today / This week, Doors / Deals, this member's own row current
 *   asOf(rows)               the newest asOfMs, or 0
 *
 * No DOM, no network. Classic script (window.NBDTeamBoard) and require()-able.
 */
(function (root) {
  'use strict';
  var FIELDS = ['doors', 'appts', 'estimates', 'deals'];
  var DAY = 86400000;
  var fmts = {};

  function okZone(tz) {
    if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymdInZone(ms, tz) {
    var zone = okZone(tz) ? tz : 'America/New_York';
    var f = fmts[zone] || (fmts[zone] = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }));
    var o = {};
    f.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
    return o.year + '-' + o.month + '-' + o.day;
  }
  function mondayOf(ymd) {
    var a = String(ymd).split('-').map(Number);
    var t = Date.UTC(a[0], a[1] - 1, a[2]);
    var d = new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function metrics(m) {
    if (!m || typeof m !== 'object') return null;
    var out = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var v = m[FIELDS[i]];
      if (typeof v !== 'number' || !isFinite(v) || v < 0 || Math.floor(v) !== v) return null;
      out[FIELDS[i]] = v;
    }
    return out;
  }
  var KEY = /^\d{4}-\d{2}-\d{2}$/;
  function current(row, nowMs) {
    var none = { today: null, week: null };
    if (!row || typeof row !== 'object' || !KEY.test(String(row.dayKey)) || !KEY.test(String(row.weekKey))) return none;
    var today = ymdInZone(nowMs, row.tz);
    var thisWeek = mondayOf(today) === mondayOf(row.weekKey);
    return {
      today: thisWeek && row.dayKey === today ? metrics(row.today) : null,
      week: thisWeek ? metrics(row.week) : null,
    };
  }
  function board(rows, period, nowMs, field) {
    var f = FIELDS.indexOf(field) !== -1 ? field : 'doors';
    var out = [];
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      var c = current(r, nowMs);
      var m = period === 'day' ? c.today : period === 'week' ? c.week : null;
      if (!m || !r.uid) return;
      out.push({ uid: String(r.uid), name: String(r.name || ''), doors: m.doors, appts: m.appts, estimates: m.estimates, deals: m.deals });
    });
    out.sort(function (a, b) { return (b[f] - a[f]) || (b.doors - a.doors) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return out;
  }
  function totals(list) {
    var t = { doors: 0, appts: 0, estimates: 0, deals: 0 };
    (list || []).forEach(function (r) { FIELDS.forEach(function (k) { t[k] += r[k] || 0; }); });
    return t;
  }
  function usable(rows, uid, period, tab, nowMs) {
    if ((period !== 'day' && period !== 'week') || (tab !== 'doors' && tab !== 'deals') || !Array.isArray(rows)) return false;
    var mine = null;
    rows.forEach(function (r) { if (r && String(r.uid) === String(uid)) mine = r; });
    if (!mine) return false;
    var c = current(mine, nowMs);
    return !!(period === 'day' ? c.today : c.week);
  }
  function asOf(rows) {
    var t = 0;
    (Array.isArray(rows) ? rows : []).forEach(function (r) { if (r && typeof r.asOfMs === 'number' && r.asOfMs > t) t = r.asOfMs; });
    return t;
  }

  var api = { FIELDS: FIELDS, ymdInZone: ymdInZone, mondayOf: mondayOf, metrics: metrics, current: current, board: board, totals: totals, usable: usable, asOf: asOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDTeamBoard = api;
})(typeof window !== 'undefined' ? window : null);
