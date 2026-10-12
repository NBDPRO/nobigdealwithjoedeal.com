/**
 * schedule-window.js — the arrival window on a lead, pure.
 *
 * Jo's model (2026-09-29, documentation/projects/CALENDAR-HUB-PLAN-2026-09-29.md
 * "Jo's answers" §1). The window depends on the job:
 *   • a large project starts early (about 7 am) and runs one or two days;
 *   • a repair or an inspection takes minutes to hours, at almost any time.
 * So the lead carries a start time plus EITHER a length OR a last day:
 *
 *   scheduledDate        'YYYY-MM-DD'  the day the job starts. Unchanged, and
 *                                      still the single source for the day.
 *   scheduledStart       'HH:MM'       24h local, optional.
 *   scheduledDurationMin number        minutes, optional — short jobs.
 *   scheduledEndDate     'YYYY-MM-DD'  optional — multi-day projects; never
 *                                      before scheduledDate.
 *
 * All three new fields empty is "All day / no time", which is exactly what
 * every lead was before this file existed.
 *
 * THE trap: never `new Date('2026-10-06')`. That parses as UTC midnight, so
 * in America/New_York it is Monday Oct 5, 8 pm — the wrong day AND the wrong
 * weekday (docs/pro/js/portal.js _scheduleLine has the long version). Every
 * date below is built from its parts with Date.UTC and read back with the
 * getUTC* accessors, which makes the arithmetic identical in every timezone
 * the code runs in (a phone in Ohio, a Cloud Function in UTC, a CI runner).
 * The ONE place a real timezone enters is localToUtcMs(), which turns a
 * wall-clock time in America/New_York into an instant for the .ics feed.
 *
 * Browser: window.NBDScheduleWindow. Node: module.exports. The Cloud Functions
 * copy (functions/schedule-window.js) must stay byte-identical to this file —
 * functions/ deploys on its own and cannot require docs/;
 * tests/schedule-window-2026-09-29.test.js fails the moment they drift.
 */
(function () {
  'use strict';

  var YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
  var DAY_MS = 86400000;
  var MAX_DURATION_MIN = 24 * 60;
  // A project longer than two weeks is a typo, not a roof.
  var MAX_PROJECT_DAYS = 14;
  var DEFAULT_TZ = 'America/New_York';

  // The UI presets (Jo's answers §1). "Full project" pre-fills 7:00 am and one
  // or two days; "Repair / inspection" asks for a time and one of these
  // lengths.
  var PRESETS = {
    project: { start: '07:00', days: [1, 2, 3] },
    repair: { durations: [30, 60, 90, 120, 180, 240] }
  };

  // Why a window was rejected, in words a rep can act on.
  var ERRORS = {
    'no-date': 'Pick the scheduled day first.',
    'bad-start': 'Start time must look like 07:00.',
    'bad-duration': 'Length must be between 1 minute and 24 hours.',
    'bad-end': 'The last day is not a real date.',
    'end-before-start': 'The last day can’t be before the start day.',
    'too-long': 'A job can span at most ' + MAX_PROJECT_DAYS + ' days.',
    'length-and-end': 'Pick a length OR a last day, not both.',
    'length-needs-start': 'A length needs a start time.'
  };

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isBlank(v) { return v == null || (typeof v === 'string' && v.trim() === ''); }

  // 'YYYY-MM-DD' → { y, m, d, day } where day is days since 1970-01-01, or
  // null. Rejects a date the calendar does not have (2026-02-30).
  function parseYmd(s) {
    var mt = YMD_RE.exec(typeof s === 'string' ? s : '');
    if (!mt) return null;
    var y = +mt[1], m = +mt[2], d = +mt[3];
    var t = Date.UTC(y, m - 1, d);
    var back = new Date(t);
    if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
    return { y: y, m: m, d: d, day: Math.round(t / DAY_MS) };
  }

  function ymdOfDay(day) {
    var t = new Date(day * DAY_MS);
    return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
  }

  function addDays(ymd, n) {
    var p = parseYmd(ymd);
    return p ? ymdOfDay(p.day + n) : null;
  }

  // The Monday of the week holding ymd (Mon–Sun weeks), or null. A job
  // planned to a week stores this as lead.scheduledWeek (2026-09-29).
  function mondayOf(ymd) {
    var p = parseYmd(ymd);
    if (!p) return null;
    var dow = new Date(p.day * DAY_MS).getUTCDay();   // 0 = Sunday
    return ymdOfDay(p.day - ((dow + 6) % 7));
  }

  // 'HH:MM' → minutes after midnight, or null.
  function parseHm(s) {
    var mt = HM_RE.exec(typeof s === 'string' ? s : '');
    return mt ? (+mt[1]) * 60 + (+mt[2]) : null;
  }
  function hmOf(min) { return pad2(Math.floor(min / 60)) + ':' + pad2(min % 60); }

  // Validate the four lead fields. { ok:true, window } or { ok:false, error }
  // where error is a key of ERRORS. The window:
  //   { date, start, durationMin, endDate, days, kind }
  // kind: 'allday'  — a date and nothing else (the pre-2026-09-29 lead)
  //       'timed'   — a start time, with or without a length
  //       'project' — a last day (1+ days), with or without a start time
  function check(fields) {
    var f = fields || {};
    var start = parseYmd(f.scheduledDate);
    if (!start) return { ok: false, error: 'no-date' };

    var startMin = null;
    if (!isBlank(f.scheduledStart)) {
      startMin = parseHm(f.scheduledStart);
      if (startMin == null) return { ok: false, error: 'bad-start' };
    }

    var dur = null;
    if (!isBlank(f.scheduledDurationMin)) {
      dur = Number(f.scheduledDurationMin);
      if (!isFinite(dur) || Math.floor(dur) !== dur || dur < 1 || dur > MAX_DURATION_MIN) {
        return { ok: false, error: 'bad-duration' };
      }
    }

    var endDate = null, days = 1;
    if (!isBlank(f.scheduledEndDate)) {
      var end = parseYmd(f.scheduledEndDate);
      if (!end) return { ok: false, error: 'bad-end' };
      if (end.day < start.day) return { ok: false, error: 'end-before-start' };
      days = end.day - start.day + 1;
      if (days > MAX_PROJECT_DAYS) return { ok: false, error: 'too-long' };
      endDate = f.scheduledEndDate;
    }

    if (dur != null && days > 1) return { ok: false, error: 'length-and-end' };
    if (dur != null && startMin == null) return { ok: false, error: 'length-needs-start' };

    return {
      ok: true,
      window: {
        date: f.scheduledDate,
        start: startMin == null ? null : hmOf(startMin),
        durationMin: dur,
        endDate: endDate,
        days: days,
        kind: endDate ? 'project' : (startMin != null ? 'timed' : 'allday')
      }
    };
  }

  // The validated window, or null (no date, or fields that contradict).
  function normalize(fields) {
    var r = check(fields);
    return r.ok ? r.window : null;
  }

  // 450 → '7:30 am'. 0 → '12:00 am', 720 → '12:00 pm'.
  function fmtTime12(min) {
    var m = ((min % MAX_DURATION_MIN) + MAX_DURATION_MIN) % MAX_DURATION_MIN;
    var h = Math.floor(m / 60);
    return (h % 12 || 12) + ':' + pad2(m % 60) + ' ' + (h < 12 ? 'am' : 'pm');
  }

  // '2:30–3:30 pm' when both ends share am/pm on the same day, else both
  // suffixes ('11:30 am–12:30 pm', '11:00 pm–1:00 am').
  function fmtRange(startMin, endMin) {
    var a = fmtTime12(startMin), b = fmtTime12(endMin);
    var sameDay = Math.floor(startMin / MAX_DURATION_MIN) === Math.floor(endMin / MAX_DURATION_MIN);
    if (sameDay && a.slice(-2) === b.slice(-2)) a = a.slice(0, -3);
    return a + '–' + b;
  }

  // The time part alone, no date: '7:00 am', '2:30–3:30 pm', or ''.
  function timeLabel(w) {
    if (!w || w.start == null) return '';
    var s = parseHm(w.start);
    return w.durationMin ? fmtRange(s, s + w.durationMin) : fmtTime12(s);
  }

  function daysLabel(w) { return w && w.days > 1 ? w.days + '-day job' : ''; }

  // Rep-facing one-liner: 'Tue, Oct 6 · 7:00 am · 2-day job',
  // 'Tue, Oct 6 · 2:30–3:30 pm', 'Tue, Oct 6'. todayYmd (optional) turns
  // today into 'Today' and adds the year when it differs from today's.
  function formatWindow(fields, todayYmd) {
    var w = normalize(fields);
    if (!w) return '';
    var p = parseYmd(w.date);
    var today = parseYmd(todayYmd);
    var dow = new Date(p.day * DAY_MS).getUTCDay();
    var label = (today && today.day === p.day)
      ? 'Today'
      : DOW[dow] + ', ' + MON[p.m - 1] + ' ' + p.d + (today && today.y !== p.y ? ', ' + p.y : '');
    return [label, timeLabel(w), daysLabel(w)].filter(Boolean).join(' · ');
  }

  // Homeowner-facing phrase that follows the date on the portal:
  // 'arriving around 7:00 am · 2-day job', '2:30–3:30 pm', '2-day job', or ''.
  // A length is a real window, so it is stated as one; a bare start time is
  // only ever "around" — crews run early and late.
  function portalPhrase(fields) {
    var w = normalize(fields);
    if (!w) return '';
    var t = w.start == null ? '' : (w.durationMin ? timeLabel(w) : 'arriving around ' + timeLabel(w));
    return [t, daysLabel(w)].filter(Boolean).join(' · ');
  }

  // Where the job ends, local: { date, time } (time null for a whole day).
  // A start with no length ends when it starts — a point, never a made-up
  // block that would manufacture a conflict.
  function endsAt(fields) {
    var w = normalize(fields);
    if (!w) return null;
    if (w.kind === 'allday') return { date: w.date, time: null };
    if (w.kind === 'project' && (w.days > 1 || w.start == null)) return { date: w.endDate, time: null };
    var s = parseHm(w.start) + (w.durationMin || 0);
    return { date: addDays(w.date, Math.floor(s / MAX_DURATION_MIN)), time: hmOf(s % MAX_DURATION_MIN) };
  }

  // Is ymd one of the job's days? (A 2-day project is on the board both days.)
  function coversDay(fields, ymd) {
    var w = normalize(fields);
    var p = parseYmd(ymd);
    if (!w || !p) return false;
    var s = parseYmd(w.date).day;
    return p.day >= s && p.day <= s + w.days - 1;
  }

  // Offset of tz from UTC at an instant, in ms (NY: -4h in summer, -5h in winter).
  var _fmtCache = {};
  function tzOffsetMs(utcMs, tz) {
    var f = _fmtCache[tz] || (_fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }));
    var parts = {};
    f.formatToParts(new Date(utcMs)).forEach(function (x) { parts[x.type] = x.value; });
    var h = +parts.hour === 24 ? 0 : +parts.hour;
    var asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, h, +parts.minute, +parts.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  }

  // Wall-clock 'YYYY-MM-DD' + 'HH:MM' in tz → epoch ms. Two passes so a time
  // on a DST-change day lands on the right side of the change.
  function localToUtcMs(ymd, hm, tz) {
    var p = parseYmd(ymd), m = parseHm(hm);
    if (!p || m == null) return null;
    var zone = tz || DEFAULT_TZ;
    var guess = p.day * DAY_MS + m * 60000;
    var off = tzOffsetMs(guess, zone);
    var t = guess - off;
    var off2 = tzOffsetMs(t, zone);
    return off2 === off ? t : guess - off2;
  }

  // The .ics times for a lead's job.
  //   All-day (no start, or a multi-day project):
  //     { allDay:true, start:'YYYYMMDD', end:'YYYYMMDD' } — end is EXCLUSIVE,
  //     the day after the last day (RFC 5545 §3.6.1).
  //   Timed (a start on a single day):
  //     { allDay:false, startMs, endMs, tz } — instants; the feed writes them
  //     as UTC so it needs no VTIMEZONE block (functions/calendar-feed-logic.js).
  // A multi-day project stays all-day even with a start time: a timed event
  // spanning two days renders as one bar from 7 am to midnight the next day.
  function toIcsTimes(fields, tz) {
    var w = normalize(fields);
    if (!w) return null;
    if (w.start == null || w.days > 1) {
      return {
        allDay: true,
        start: w.date.replace(/-/g, ''),
        end: addDays(w.endDate || w.date, 1).replace(/-/g, '')
      };
    }
    var zone = tz || DEFAULT_TZ;
    var startMs = localToUtcMs(w.date, w.start, zone);
    return { allDay: false, startMs: startMs, endMs: startMs + (w.durationMin || 0) * 60000, tz: zone };
  }

  // Deal room → lead (plan Phase 0 §2). The homeowner's accepted install date
  // fills the lead's scheduledDate ONLY when the lead has none — a date Jo
  // typed is never overwritten. Returns the date to write, or null.
  function installDateFill(leadScheduledDate, dealInstallDate) {
    if (!isBlank(leadScheduledDate)) return null;
    return parseYmd(dealInstallDate) ? dealInstallDate : null;
  }

  var API = {
    PRESETS: PRESETS,
    ERRORS: ERRORS,
    DEFAULT_TZ: DEFAULT_TZ,
    MAX_DURATION_MIN: MAX_DURATION_MIN,
    MAX_PROJECT_DAYS: MAX_PROJECT_DAYS,
    parseYmd: parseYmd,
    addDays: addDays,
    mondayOf: mondayOf,
    check: check,
    normalize: normalize,
    fmtTime12: fmtTime12,
    timeLabel: timeLabel,
    formatWindow: formatWindow,
    portalPhrase: portalPhrase,
    endsAt: endsAt,
    coversDay: coversDay,
    localToUtcMs: localToUtcMs,
    toIcsTimes: toIcsTimes,
    installDateFill: installDateFill
  };

  if (typeof window !== 'undefined') window.NBDScheduleWindow = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
