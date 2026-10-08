/**
 * storm-time.js — what day (and time) a storm report happened, in Eastern
 * time (2026-10-06, review round 4 R4-6-1 / R4-6-8).
 *
 * NWS/IEM Local Storm Reports carry `valid` as UTC, usually WITHOUT a zone
 * suffix ("2026-06-14T21:30:00" = 5:30pm EDT Jun 14). Read as a local time
 * and then cut to its UTC date, every storm from 4pm to midnight Eastern
 * became the NEXT day: the date of loss the CRM suggested (and saved, with
 * a stormId), the public storm-history page, the D2D storm popup, and the
 * Storm Watch alert. This file is the one reader.
 *
 * Byte-identical copies: functions/storm-time.js (storm-tag-logic.js,
 * storm-watch.js) and docs/pro/js/storm-time.js (window.NBDStormTime:
 * dol-fill.js, d2d-storm-layer.js, the public storm-report page).
 * tests/storm-time-et-2026-10-06.test.js holds them equal.
 */
(function () {
  'use strict';

  var ZONE = 'America/New_York';

  /** IEM `valid` (UTC, zone suffix optional) → epoch ms, or 0. */
  function validMs(valid) {
    var s = String(valid || '').trim();
    if (!s) return 0;
    var withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z';
    var t = Date.parse(withZone);
    return isFinite(t) ? t : 0;
  }

  /** Epoch ms → its Eastern calendar date "YYYY-MM-DD". */
  function ymdEt(ms) {
    try {
      var p = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
      var g = function (t) { for (var i = 0; i < p.length; i++) if (p[i].type === t) return p[i].value; return ''; };
      return g('year') + '-' + g('month') + '-' + g('day');
    } catch (_) {
      return new Date(ms).toISOString().slice(0, 10);
    }
  }

  /** IEM `valid` → "Jun 14, 2026" (Eastern), or '' when unreadable. */
  function dateTextEt(valid) {
    var t = validMs(valid);
    if (!t) return '';
    return new Date(t).toLocaleDateString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', year: 'numeric' });
  }

  /** IEM `valid` → "Jun 14, 5:30 PM ET", or the raw string when unreadable. */
  function whenTextEt(valid) {
    var t = validMs(valid);
    if (!t) return String(valid || '');
    return new Date(t).toLocaleString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
  }

  var API = { ZONE: ZONE, validMs: validMs, ymdEt: ymdEt, dateTextEt: dateTextEt, whenTextEt: whenTextEt };
  if (typeof window !== 'undefined') window.NBDStormTime = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
