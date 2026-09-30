/**
 * functions/calendar-feed-logic.js — VCALENDAR serialization, pure.
 *
 * No firebase, no network, no clock of its own — every input is plain data and
 * `nowMs` is passed in. That is what lets tests/calendar-feed.test.js assert on
 * the exact bytes, which matters more here than in most places: iOS Calendar
 * does not report a parse error. A feed with one malformed line is a feed that
 * silently shows nothing, or silently drops every event it had already saved.
 *
 * The rules that actually bite (RFC 5545):
 *   §3.1  content lines are CRLF-terminated and at most 75 OCTETS; longer ones
 *         are folded with CRLF + a single leading space. Octets, not
 *         characters — a name with an em dash or an é must not be split
 *         mid-codepoint or the whole calendar fails to parse.
 *   §3.3.5 DATE-TIME in UTC is YYYYMMDDTHHMMSSZ. Using UTC throughout means no
 *         VTIMEZONE block is needed at all.
 *   §3.6.1 an all-day event's DTEND is EXCLUSIVE — a job on the 5th ends on
 *         the 6th. Get this wrong and every scheduled job renders as two days.
 *   §3.3.11 TEXT values escape backslash, semicolon, comma and newline.
 *
 * America/New_York enters in exactly two places: deciding which local calendar
 * DAY an appointment falls on, for the lead/appointment dedup; and turning a
 * lead's wall-clock arrival time (scheduledStart, 2026-09-29) into an instant,
 * which schedule-window.js does. Everything a calendar client renders is UTC
 * or a bare date, so there is still no VTIMEZONE block to get wrong.
 */

'use strict';

// Byte-identical copy of docs/pro/js/schedule-window.js (functions/ deploys on
// its own and cannot require docs/). tests/schedule-window-2026-09-29.test.js
// holds the two equal.
const SW = require('./schedule-window');

const PRODID = '-//NBD Pro//Calendar Feed//EN';
const UID_DOMAIN = 'nobigdealwithjoedeal.com';
// A rep with more than this in the window has a data problem, not a schedule.
const MAX_EVENTS = 1000;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

// ─── primitives ──────────────────────────────────────────────────

function escapeText(s) {
  return String(s == null ? '' : s)
    // Backslash first, or every escape below gets double-escaped.
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
    // Remaining C0 controls are illegal in a value and make iOS reject the
    // whole calendar rather than the one property.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Fold one logical line to physical lines of at most 75 octets.
 * Continuation lines carry a single leading space, which counts toward the 75,
 * so they may hold 74 octets of payload. Iterating the string with for..of
 * walks CODE POINTS, so a multibyte character is never cut in half.
 */
function foldLine(line) {
  const s = String(line == null ? '' : line);
  if (Buffer.byteLength(s, 'utf8') <= 75) return s;
  const parts = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of s) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    const limit = parts.length === 0 ? 75 : 74;
    if (curBytes + chBytes > limit) {
      parts.push(cur);
      cur = ch;
      curBytes = chBytes;
    } else {
      cur += ch;
      curBytes += chBytes;
    }
  }
  parts.push(cur);
  return parts[0] + parts.slice(1).map((p) => '\r\n ' + p).join('');
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** ms → 'YYYYMMDDTHHMMSSZ' */
function fmtUtc(ms) {
  const d = new Date(ms);
  return String(d.getUTCFullYear()) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate())
    + 'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' → 'YYYYMMDD' (null when the input is not a bare date) */
function fmtDate(ymd) {
  return YMD_RE.test(String(ymd || '')) ? String(ymd).replace(/-/g, '') : null;
}

/** 'YYYY-MM-DD' → the next calendar day, for the exclusive DTEND. */
function nextDate(ymd) {
  if (!YMD_RE.test(String(ymd || ''))) return null;
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + 86_400_000;
  const n = new Date(t);
  return String(n.getUTCFullYear()) + '-' + pad2(n.getUTCMonth() + 1) + '-' + pad2(n.getUTCDate());
}

// House convention for New-York-local formatting (portal.js, lead-digest.js):
// Intl with an explicit timeZone. 'en-CA' yields YYYY-MM-DD directly.
const NY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
/** ms → the America/New_York calendar date, 'YYYY-MM-DD'. Dedup key only. */
function nyDateOf(ms) {
  return NY_FMT.format(new Date(ms));
}

// ─── normalization ───────────────────────────────────────────────

/** Firestore Timestamp | Date | number | ISO string → ms, or null. */
function toMs(t) {
  if (t == null) return null;
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  if (t instanceof Date) return Number.isFinite(t.getTime()) ? t.getTime() : null;
  if (typeof t.toMillis === 'function') { const v = t.toMillis(); return Number.isFinite(v) ? v : null; }
  if (typeof t.toDate === 'function') { const d = t.toDate(); return d && Number.isFinite(d.getTime()) ? d.getTime() : null; }
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  if (typeof t === 'string') { const v = Date.parse(t); return Number.isFinite(v) ? v : null; }
  return null;
}

/**
 * appointments/{bookingId} → the fields the feed needs, or null when the doc
 * cannot become an event. Cancelled appointments are dropped (the same choice
 * smart-calendar.js makes) so a cancelled slot disappears from the phone.
 */
function normalizeAppointment(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.status === 'cancelled') return null;
  const startMs = toMs(doc.startTime);
  if (startMs == null) return null;              // nothing to place on a calendar
  let endMs = toMs(doc.endTime);
  if (endMs == null || endMs <= startMs) endMs = startMs + DEFAULT_DURATION_MS;
  return {
    kind: 'appointment',
    id: String(doc.bookingId || doc.id || ''),
    startMs,
    endMs,
    title: String(doc.title || doc.attendeeName || 'Appointment'),
    location: String(doc.location || ''),
    description: String(doc.description || ''),
    attendeeName: String(doc.attendeeName || ''),
    attendeeEmail: String(doc.attendeeEmail || ''),
    attendeePhone: String(doc.attendeePhone || ''),
    leadId: doc.leadId || null,
    updatedMs: toMs(doc.updatedAt),
  };
}

/**
 * leads/{id} → an event, or null. A rep-typed Scheduled Date is a date-only
 * string; anything that is not exactly YYYY-MM-DD is skipped rather than
 * guessed at, because a malformed DTSTART makes iOS drop the whole feed.
 *
 * The arrival window (2026-09-29, schedule-window.js) decides the shape:
 *   - no start time, or a multi-day project → all-day, spanning every day of
 *     the job (DTEND the day after scheduledEndDate);
 *   - a start time on a single day → timed, start + length (or a point in
 *     time when there is no length).
 * A window whose fields contradict each other (an end before the start) falls
 * back to the plain all-day event on scheduledDate — the day is still right,
 * and a feed that drops a job is worse than one that shows it without a time.
 */
// Multi-job (2026-09-30): a customer's other job is fed in as the lead with
// that job's fields laid over it, id `leadId/jobId`, and `_jobTitle` — so two
// jobs for one customer read apart. A plain lead has no `_jobTitle`.
function jobSuffix(doc) {
  return doc && typeof doc._jobTitle === 'string' && doc._jobTitle ? ' — ' + doc._jobTitle : '';
}

function normalizeLead(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.deleted === true) return null;
  const ymd = String(doc.scheduledDate || '');
  if (!YMD_RE.test(ymd)) return null;
  const name = `${doc.firstName || ''} ${doc.lastName || ''}`.trim();
  const w = SW.normalize(doc);
  const ics = w ? SW.toIcsTimes(doc) : null;
  return {
    kind: 'lead',
    id: String(doc.id || ''),
    date: ymd,
    // Exclusive all-day end ('YYYY-MM-DD'), or null for a timed job.
    endExclusive: ics && !ics.allDay ? null : nextDate((w && w.endDate) || ymd),
    startMs: ics && !ics.allDay ? ics.startMs : null,
    endMs: ics && !ics.allDay ? ics.endMs : null,
    // "7:00 am · 2-day job" — rides in the title of an all-day project so the
    // start time is not lost when the event itself cannot carry one.
    windowNote: w && ics && ics.allDay ? [SW.timeLabel(w), w.days > 1 ? w.days + '-day job' : ''].filter(Boolean).join(' · ') : '',
    title: (name || String(doc.address || '') || 'Scheduled job') + jobSuffix(doc),
    location: String(doc.address || ''),
    stage: String(doc.stage || ''),
    phone: String(doc.phone || ''),
    updatedMs: toMs(doc.updatedAt),
  };
}

/**
 * leads/{id} planned to a WEEK but no day yet → an all-day Mon–Fri event, or
 * null (2026-09-29: Jo books a week first and "walks down" the day later).
 * scheduledWeek is that week's Monday; it only counts while scheduledDate is
 * empty. Same kind ('lead') and so the same UID / Google event id as the
 * day-level job, so setting the day later turns this event into it in place
 * instead of leaving a stray week bar. All-day → free (TRANSPARENT), a plan
 * not a slot. Shared by the .ics feed and the Google sync.
 */
function normalizeLeadWeek(doc) {
  if (!doc || typeof doc !== 'object' || doc.deleted === true) return null;
  if (YMD_RE.test(String(doc.scheduledDate || ''))) return null;
  const monday = SW.mondayOf(String(doc.scheduledWeek || ''));
  if (!monday) return null;
  const name = `${doc.firstName || ''} ${doc.lastName || ''}`.trim();
  return {
    kind: 'lead',
    weekPlan: true,
    id: String(doc.id || ''),
    date: monday,
    endExclusive: SW.addDays(monday, 5),            // Saturday — the bar covers Mon–Fri
    startMs: null,
    endMs: null,
    windowNote: '',
    title: 'Week of: ' + (name || String(doc.address || '') || 'Scheduled job') + jobSuffix(doc),
    location: String(doc.address || ''),
    stage: String(doc.stage || ''),
    phone: String(doc.phone || ''),
    updatedMs: toMs(doc.updatedAt),
  };
}

/**
 * leads/{id} → the adjuster meeting as its own event, or null (2026-09-29).
 * adjusterMeetingDate is 'YYYY-MM-DD', adjusterMeetingStart optional 'HH:MM'
 * America/New_York. Timed meetings default to an hour — the carrier never
 * says how long; all-day ones are TRANSPARENT like a date-only job.
 */
function normalizeAdjusterMeeting(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.deleted === true) return null;
  const ymd = String(doc.adjusterMeetingDate || '');
  if (!SW.parseYmd(ymd)) return null;
  const start = String(doc.adjusterMeetingStart || '');
  const startMs = start ? SW.localToUtcMs(ymd, start) : null;
  const name = `${doc.firstName || ''} ${doc.lastName || ''}`.trim();
  return {
    kind: 'adjuster',
    id: String(doc.id || ''),
    date: ymd,
    endExclusive: startMs == null ? nextDate(ymd) : null,
    startMs,
    endMs: startMs == null ? null : startMs + DEFAULT_DURATION_MS,
    title: 'Adjuster meeting · ' + (name || String(doc.address || '') || 'Claim') + jobSuffix(doc),
    location: String(doc.address || ''),
    adjusterName: String(doc.adjusterName || ''),
    adjusterPhone: String(doc.adjusterPhone || ''),
    carrier: String(doc.insCarrier || doc.insuranceCarrier || ''),
    claimNumber: String(doc.claimNumber || ''),
    updatedMs: toMs(doc.updatedAt),
  };
}

/**
 * Drop a lead's all-day event when one of its own appointments already sits on
 * the same New York day — otherwise the rep sees the job twice, once timed and
 * once all-day. smart-calendar.js does this for today only; the feed spans a
 * window, so it compares per lead per DAY.
 */
function dedupLeads(leads, appts) {
  const taken = new Set();
  for (const a of appts) {
    if (a && a.leadId) taken.add(a.leadId + '@' + nyDateOf(a.startMs));
  }
  return leads.filter((l) => !taken.has(l.id + '@' + l.date));
}

// ─── serialization ───────────────────────────────────────────────

function eventLines(ev, nowStamp) {
  const out = [];
  out.push('BEGIN:VEVENT');
  if (ev.kind === 'appointment') {
    out.push('UID:' + ev.id + '@' + UID_DOMAIN);
    out.push('DTSTAMP:' + nowStamp);
    out.push('DTSTART:' + fmtUtc(ev.startMs));
    out.push('DTEND:' + fmtUtc(ev.endMs));
    out.push('SUMMARY:' + escapeText(ev.title));
    if (ev.location) out.push('LOCATION:' + escapeText(ev.location));
    const desc = [
      ev.attendeeName ? 'With: ' + ev.attendeeName : '',
      ev.attendeePhone ? 'Phone: ' + ev.attendeePhone : '',
      ev.attendeeEmail ? 'Email: ' + ev.attendeeEmail : '',
      ev.description || '',
    ].filter(Boolean).join('\n');
    if (desc) out.push('DESCRIPTION:' + escapeText(desc));
    out.push('STATUS:CONFIRMED');
  } else if (ev.kind === 'adjuster') {
    // Its own UID namespace: the same lead can carry an install day AND an
    // adjuster meeting, and a shared UID would make iOS keep only one.
    out.push('UID:adj-' + ev.id + '@' + UID_DOMAIN);
    out.push('DTSTAMP:' + nowStamp);
    if (ev.startMs != null) {
      out.push('DTSTART:' + fmtUtc(ev.startMs));
      out.push('DTEND:' + fmtUtc(ev.endMs));
    } else {
      out.push('DTSTART;VALUE=DATE:' + fmtDate(ev.date));
      out.push('DTEND;VALUE=DATE:' + fmtDate(ev.endExclusive));
    }
    out.push('SUMMARY:' + escapeText(ev.title));
    if (ev.location) out.push('LOCATION:' + escapeText(ev.location));
    const desc = [
      ev.adjusterName ? 'Adjuster: ' + ev.adjusterName : '',
      ev.adjusterPhone ? 'Adjuster phone: ' + ev.adjusterPhone : '',
      ev.carrier ? 'Carrier: ' + ev.carrier : '',
      ev.claimNumber ? 'Claim #: ' + ev.claimNumber : '',
    ].filter(Boolean).join('\n');
    if (desc) out.push('DESCRIPTION:' + escapeText(desc));
    if (ev.startMs == null) out.push('TRANSP:TRANSPARENT');
  } else {
    out.push('UID:lead-' + ev.id + '@' + UID_DOMAIN);
    out.push('DTSTAMP:' + nowStamp);
    if (ev.startMs != null) {
      // A start time Jo set is a commitment: timed, and OPAQUE (the default —
      // no TRANSP line), so it reads as busy.
      out.push('DTSTART:' + fmtUtc(ev.startMs));
      out.push('DTEND:' + fmtUtc(ev.endMs));
    } else {
      // All-day: a bare DATE, and an EXCLUSIVE end the day after the job's
      // last day (the following day for a one-day job).
      out.push('DTSTART;VALUE=DATE:' + fmtDate(ev.date));
      out.push('DTEND;VALUE=DATE:' + fmtDate(ev.endExclusive || nextDate(ev.date)));
    }
    out.push('SUMMARY:' + escapeText(ev.title + (ev.windowNote ? ' · ' + ev.windowNote : '') + (ev.stage ? ' · ' + ev.stage : '')));
    if (ev.location) out.push('LOCATION:' + escapeText(ev.location));
    if (ev.phone) out.push('DESCRIPTION:' + escapeText('Phone: ' + ev.phone));
    // A date-only job is a plan, not a commitment to be busy all day.
    if (ev.startMs == null) out.push('TRANSP:TRANSPARENT');
  }
  if (ev.updatedMs) out.push('LAST-MODIFIED:' + fmtUtc(ev.updatedMs));
  out.push('END:VEVENT');
  return out;
}

/**
 * Build the whole calendar. Deterministic: events sort by start then UID, so
 * two fetches a second apart differ only in DTSTAMP.
 *
 * @param {object} o
 * @param {object[]} o.appointments raw appointment docs
 * @param {object[]} o.leads        raw lead docs
 * @param {number}   o.nowMs        clock, injected
 * @param {string}   [o.calName]    X-WR-CALNAME shown as the subscription title
 * @returns {string} the VCALENDAR, CRLF-terminated
 */
function buildCalendar(o) {
  const opts = o || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : 0;
  const nowStamp = fmtUtc(nowMs);
  const calName = String(opts.calName || 'NBD Schedule');

  const appts = (Array.isArray(opts.appointments) ? opts.appointments : [])
    .map(normalizeAppointment).filter(Boolean);
  const rawLeads = Array.isArray(opts.leads) ? opts.leads : [];
  // A lead with no day but a planned week shows as its week bar.
  const leads = dedupLeads(rawLeads.map((d) => normalizeLead(d) || normalizeLeadWeek(d)).filter(Boolean), appts);
  // Adjuster meetings are never deduped against appointments: a Cal.com
  // booking on the lead is the homeowner's visit, not the carrier's.
  const adjusters = rawLeads.map(normalizeAdjusterMeeting).filter(Boolean);

  const events = appts.concat(leads, adjusters).sort((a, b) => {
    const as = a.startMs != null ? a.startMs : Date.parse(a.date + 'T00:00:00Z');
    const bs = b.startMs != null ? b.startMs : Date.parse(b.date + 'T00:00:00Z');
    if (as !== bs) return as - bs;
    return String(a.id).localeCompare(String(b.id));
  }).slice(0, MAX_EVENTS);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:' + PRODID,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + escapeText(calName),
    // Advisory only — iOS polls on its own schedule regardless.
    'X-PUBLISHED-TTL:PT15M',
    'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
  ];
  for (const ev of events) lines.push(...eventLines(ev, nowStamp));
  lines.push('END:VCALENDAR');

  // Fold every line, join with CRLF, and terminate the last line too.
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = {
  escapeText,
  foldLine,
  fmtUtc,
  fmtDate,
  nextDate,
  nyDateOf,
  toMs,
  normalizeAppointment,
  normalizeLead,
  normalizeLeadWeek,
  normalizeAdjusterMeeting,
  dedupLeads,
  buildCalendar,
  PRODID,
  UID_DOMAIN,
  MAX_EVENTS,
  DEFAULT_DURATION_MS,
};
