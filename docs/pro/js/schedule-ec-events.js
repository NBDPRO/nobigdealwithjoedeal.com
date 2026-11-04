/**
 * schedule-ec-events.js — leads + appointments → EventCalendar events, pure.
 *
 * Calendar-engine trial (2026-11-04,
 * documentation/projects/CALENDAR-ENGINE-TRIAL-2026-11-04.md). EventCalendar
 * (docs/assets/vendor/event-calendar/, vkurko/calendar, MIT) takes events
 * whose start/end are WALL-CLOCK strings — 'YYYY-MM-DD' for all-day,
 * 'YYYY-MM-DD HH:MM' for timed — with no timezone of their own. So every
 * instant here (a Cal.com startTime, a timed job's start) is turned into
 * America/New_York wall-clock time ONCE, in nyWall(), and never through
 * `new Date('YYYY-MM-DD')` (the UTC-midnight trap schedule-window.js
 * describes).
 *
 * Which docs become events, and their days and times, follow the .ics feed
 * and the Google sync exactly (functions/calendar-feed-logic.js:
 * normalizeLead, normalizeLeadWeek, normalizeAdjusterMeeting,
 * normalizeAppointment). tests/schedule-ec-events-2026-11-04.test.js runs the
 * same fixtures through both and fails if they disagree, so the board can
 * never show a job on a different day than Jo's phone does.
 *
 * Every title is plain text: the page renders it with textContent (never the
 * library's `html` content option), so a customer name cannot inject markup.
 *
 * Browser: window.NBDScheduleEcEvents (needs window.NBDScheduleWindow loaded
 * first). Node: module.exports.
 */
(function () {
  'use strict';

  var SW = (typeof window !== 'undefined' && window.NBDScheduleWindow) ||
    (typeof require === 'function' ? require('./schedule-window.js') : null);

  var YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
  var HOUR_MS = 60 * 60 * 1000;

  // Firestore Timestamp | Date | number | ISO string → ms, or null.
  // Same rules as calendar-feed-logic.js toMs().
  function toMs(t) {
    if (t == null) return null;
    if (typeof t === 'number') return isFinite(t) ? t : null;
    if (t instanceof Date) return isFinite(t.getTime()) ? t.getTime() : null;
    if (typeof t.toMillis === 'function') { var v = t.toMillis(); return isFinite(v) ? v : null; }
    if (typeof t.toDate === 'function') { var d = t.toDate(); return d && isFinite(d.getTime()) ? d.getTime() : null; }
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    if (typeof t === 'string') { var p = Date.parse(t); return isFinite(p) ? p : null; }
    return null;
  }

  var _fmt = {};
  // Epoch ms → 'YYYY-MM-DD HH:MM' wall clock in tz.
  function nyWall(ms, tz) {
    var zone = tz || SW.DEFAULT_TZ;
    var f = _fmt[zone] || (_fmt[zone] = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }));
    var parts = {};
    f.formatToParts(new Date(ms)).forEach(function (x) { parts[x.type] = x.value; });
    var h = parts.hour === '24' ? '00' : parts.hour;
    return parts.year + '-' + parts.month + '-' + parts.day + ' ' + h + ':' + parts.minute;
  }

  function personName(doc) {
    return ((doc.firstName || '') + ' ' + (doc.lastName || '')).trim();
  }
  function jobSuffix(doc) {
    return typeof doc._jobTitle === 'string' && doc._jobTitle ? ' — ' + doc._jobTitle : '';
  }
  function leadLabel(doc, fallback) {
    return (personName(doc) || String(doc.address || '') || fallback) + jobSuffix(doc);
  }

  // The crew lane a job sits in on the Crews (resource timeline) view: the
  // lead's sub, else "No crew yet" — the lane the crew layout keeps last.
  var NO_CREW = 'no-crew';
  function crewOf(doc) {
    return String(doc.subId || '') || NO_CREW;
  }

  // A lead's job (day, week plan) → one event, or null.
  function leadEvent(doc, tz) {
    if (!doc || typeof doc !== 'object' || doc.deleted === true) return null;
    var id = String(doc.id || '');
    var ymd = String(doc.scheduledDate || '');
    if (YMD_RE.test(ymd)) {
      var w = SW.normalize(doc);
      var ics = w ? SW.toIcsTimes(doc, tz) : null;
      var base = {
        id: 'lead-' + id,
        title: leadLabel(doc, 'Scheduled job'),
        resourceIds: [crewOf(doc)],
        extendedProps: { kind: 'job', leadId: id, stage: String(doc.stage || ''), note: '' }
      };
      if (ics && !ics.allDay) {
        base.start = nyWall(ics.startMs, tz);
        base.end = nyWall(ics.endMs, tz);
        base.allDay = false;
        return base;
      }
      // All-day: EventCalendar's all-day end is exclusive, like the .ics.
      // A contradictory window falls back to the plain day (the feed's rule).
      base.start = ymd;
      base.end = SW.addDays((w && w.endDate) || ymd, 1);
      base.allDay = true;
      if (w) {
        base.extendedProps.note = [SW.timeLabel(w), w.days > 1 ? w.days + '-day job' : '']
          .filter(Boolean).join(' · ');
      }
      return base;
    }
    var monday = SW.mondayOf(String(doc.scheduledWeek || ''));
    if (!monday) return null;
    return {
      id: 'lead-' + id,
      title: 'Week of: ' + leadLabel(doc, 'Scheduled job'),
      resourceIds: [crewOf(doc)],
      start: monday,
      end: SW.addDays(monday, 5),
      allDay: true,
      extendedProps: { kind: 'week', leadId: id, stage: String(doc.stage || ''), note: '' }
    };
  }

  // A lead's adjuster meeting → one event, or null. An hour when timed.
  function adjusterEvent(doc, tz) {
    if (!doc || typeof doc !== 'object' || doc.deleted === true) return null;
    var ymd = String(doc.adjusterMeetingDate || '');
    if (!SW.parseYmd(ymd)) return null;
    var id = String(doc.id || '');
    var ev = {
      id: 'adj-' + id,
      title: 'Adjuster meeting · ' + leadLabel(doc, 'Claim'),
      extendedProps: { kind: 'adjuster', leadId: id, note: '' }
    };
    var startMs = doc.adjusterMeetingStart ? SW.localToUtcMs(ymd, String(doc.adjusterMeetingStart), tz) : null;
    if (startMs == null) {
      ev.start = ymd; ev.end = SW.addDays(ymd, 1); ev.allDay = true;
    } else {
      ev.start = nyWall(startMs, tz); ev.end = nyWall(startMs + HOUR_MS, tz); ev.allDay = false;
    }
    return ev;
  }

  // appointments/{bookingId} → one event, or null. Cancelled drops out; a
  // missing or backwards end becomes an hour (normalizeAppointment's rule).
  function appointmentEvent(doc, tz) {
    if (!doc || typeof doc !== 'object' || doc.status === 'cancelled') return null;
    var startMs = toMs(doc.startTime);
    if (startMs == null) return null;
    var endMs = toMs(doc.endTime);
    if (endMs == null || endMs <= startMs) endMs = startMs + HOUR_MS;
    return {
      id: 'appt-' + String(doc.bookingId || doc.id || ''),
      title: String(doc.title || doc.attendeeName || 'Appointment'),
      start: nyWall(startMs, tz),
      end: nyWall(endMs, tz),
      allDay: false,
      extendedProps: { kind: 'appointment', leadId: doc.leadId || null, note: '' }
    };
  }

  // { leads, appointments, tz } → events[], in a stable order.
  function toEvents(input) {
    var o = input || {};
    var out = [];
    (o.leads || []).forEach(function (doc) {
      var a = leadEvent(doc, o.tz);
      if (a) out.push(a);
      var b = adjusterEvent(doc, o.tz);
      if (b) out.push(b);
    });
    (o.appointments || []).forEach(function (doc) {
      var c = appointmentEvent(doc, o.tz);
      if (c) out.push(c);
    });
    return out;
  }

  var API = {
    NO_CREW: NO_CREW,
    toMs: toMs,
    nyWall: nyWall,
    leadEvent: leadEvent,
    adjusterEvent: adjusterEvent,
    appointmentEvent: appointmentEvent,
    toEvents: toEvents
  };

  if (typeof window !== 'undefined') window.NBDScheduleEcEvents = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
