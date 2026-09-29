/**
 * functions/google-calendar-logic.js — the pure half of the Google Calendar
 * sync (calendar hub Phase 2: documentation/projects/
 * CALENDAR-HUB-PLAN-2026-09-29.md).
 *
 * Jo's decisions (2026-09-29): Google Calendar is the hub; almost everything
 * Jo needs to remember goes to Google; ONE "NBD Jobs" calendar, just Jo's;
 * conflicts warn, never block.
 *
 * The events are built from the SAME normalizers as the .ics feed
 * (calendar-feed-logic.js normalizeLead / normalizeAdjusterMeeting), so a job
 * reads identically on the phone's subscribed feed and in Google.
 *
 * No I/O here: google-calendar.js does the reading and writing.
 */
'use strict';

const FEED = require('./calendar-feed-logic');

const TZ = 'America/New_York';
const APP_URL = 'https://nobigdealwithjoedeal.com/pro/customer.html?id=';

/**
 * A stable Google event id per (lead, kind). Google allows base32hex
 * characters [a-v0-9], 5–1024 long; hex is a subset. The same lead always
 * maps to the same id, so an update never makes a duplicate and a retry is a
 * no-op.
 */
function eventIdFor(kind, leadId) {
  const hex = Buffer.from(String(leadId), 'utf8').toString('hex');
  return 'nbd' + (kind === 'adjuster' ? 'a' : 'j') + hex;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * A normalized feed event → a Google Calendar event resource.
 * Timed → dateTime in New York time; all-day → date / exclusive end date.
 * Busy/free (transparency) follows Jo's rule: anything with a time — and a
 * multi-day project, which fills the days — shows BUSY so Cal.com will not
 * offer those hours; a date-only job with no time shows FREE (it is a
 * reminder, not a block), the same choice the .ics feed made.
 */
function toGoogleEvent(ev, lead) {
  if (!ev) return null;
  const isAdj = ev.kind === 'adjuster';
  const name = ev.title || 'Scheduled job';
  const summary = isAdj ? name : ('🔨 ' + name + (ev.windowNote ? ' · ' + ev.windowNote : ''));
  const lines = [];
  if (isAdj) {
    if (ev.carrier) lines.push('Carrier: ' + ev.carrier);
    if (ev.claimNumber) lines.push('Claim #: ' + ev.claimNumber);
    if (ev.adjusterName) lines.push('Adjuster: ' + ev.adjusterName + (ev.adjusterPhone ? ' · ' + ev.adjusterPhone : ''));
  } else {
    if (ev.stage) lines.push('Stage: ' + ev.stage);
    if (ev.phone) lines.push('Homeowner: ' + ev.phone);
  }
  if (lead && lead.customerId) lines.push('Customer # ' + lead.customerId);
  lines.push('Open in NBD Pro: ' + APP_URL + encodeURIComponent(ev.id));
  lines.push('(Managed by NBD Pro — change it in the CRM; edits here are overwritten.)');

  const timed = ev.startMs != null && ev.endMs != null;
  const multiDay = !timed && ev.endExclusive && ev.endExclusive !== FEED.nextDate(ev.date);
  const out = {
    id: eventIdFor(ev.kind, ev.id),
    summary,
    location: ev.location || undefined,
    description: lines.join('\n'),
    start: timed ? { dateTime: iso(ev.startMs), timeZone: TZ } : { date: ev.date },
    end: timed ? { dateTime: iso(ev.endMs > ev.startMs ? ev.endMs : ev.startMs + FEED.DEFAULT_DURATION_MS), timeZone: TZ } : { date: ev.endExclusive },
    transparency: (timed || multiDay || /\d{1,2}:\d{2}/.test(ev.windowNote || '')) ? 'opaque' : 'transparent',
    extendedProperties: { private: { nbdManaged: '1', nbdLeadId: String(ev.id), nbdKind: isAdj ? 'adjuster' : 'job' } },
    source: { title: 'NBD Pro', url: APP_URL + encodeURIComponent(ev.id) },
  };
  if (!out.location) delete out.location;
  return out;
}

/**
 * Every Google event a lead should have right now (0, 1 or 2).
 * Tenant scoping is the caller's job — only the platform tenant's leads come
 * in here.
 */
function desiredEventsForLead(lead) {
  if (!lead || lead.deleted === true) return [];
  const doc = Object.assign({}, lead, { id: lead.id });
  const out = [];
  const job = FEED.normalizeLead(doc);
  if (job) out.push(toGoogleEvent(job, lead));
  else {
    const wk = weekEventFor(doc, lead);
    if (wk) out.push(wk);
  }
  const adj = FEED.normalizeAdjusterMeeting(doc);
  if (adj) out.push(toGoogleEvent(adj, lead));
  return out;
}

/**
 * A job planned to a WEEK but not a day yet (lead.scheduledWeek = that
 * week's Monday, no scheduledDate — Jo, 2026-09-29: "assign them to a week
 * and then refine"). One all-day bar Monday–Friday, FREE, so it never blocks
 * Cal.com or trips the double-booking warning: it is a plan, not a slot. It
 * uses the job's own event id, so setting a real date later updates this
 * event in place instead of leaving a stray.
 */
function weekEventFor(doc, lead) {
  const wk = String((doc && doc.scheduledWeek) || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wk) || (doc && doc.scheduledDate)) return null;
  const friday = new Date(Date.parse(wk + 'T12:00:00Z') + 4 * 86400000).toISOString().slice(0, 10);
  const ev = FEED.normalizeLead(Object.assign({}, doc, {
    scheduledDate: wk, scheduledEndDate: friday, scheduledStart: null, scheduledDurationMin: null,
  }));
  if (!ev) return null;
  const g = toGoogleEvent(Object.assign({}, ev, { windowNote: '' }), lead);
  g.summary = '📆 Week of: ' + (ev.title || 'Scheduled job');
  g.transparency = 'transparent';
  g.description = 'Planned for this week — exact day not set yet. Set the date in NBD Pro (Schedule → Plan Jobs).\n' + g.description;
  return g;
}

/** The two ids a lead can ever own — what to delete when it has none. */
function allIdsForLead(leadId) {
  return [eventIdFor('job', leadId), eventIdFor('adjuster', leadId)];
}

// Only the fields Google shows, compared as a string — "did anything the
// homeowner-facing event carries change?" (ignores Google's own fields).
function eventSignature(e) {
  if (!e) return '';
  const pick = { s: e.summary || '', l: e.location || '', d: e.description || '', t: e.transparency || 'opaque',
    st: (e.start && (e.start.dateTime ? Date.parse(e.start.dateTime) : e.start.date)) || '',
    en: (e.end && (e.end.dateTime ? Date.parse(e.end.dateTime) : e.end.date)) || '' };
  return JSON.stringify(pick);
}

/**
 * desired: Google events we want. existing: managed events Google has (from
 * a list call, filtered to nbdManaged). Returns { upserts, deletes, same }.
 * An existing managed event nobody wants any more is deleted — the lead was
 * unscheduled, deleted, or moved to another tenant.
 */
function planSync(desired, existing) {
  const want = new Map((desired || []).filter(Boolean).map((e) => [e.id, e]));
  const have = new Map((existing || []).filter((e) => e && e.id && e.status !== 'cancelled').map((e) => [e.id, e]));
  const upserts = [], deletes = [];
  let same = 0;
  for (const [id, e] of want) {
    const h = have.get(id);
    if (h && eventSignature(h) === eventSignature(e)) same++;
    else upserts.push(e);
  }
  for (const [id] of have) if (!want.has(id)) deletes.push(id);
  return { upserts, deletes, same };
}

/** Did a lead write change anything the calendar shows? (cheap trigger gate) */
const WATCHED = ['scheduledDate', 'scheduledWeek', 'scheduledStart', 'scheduledDurationMin', 'scheduledEndDate', 'adjusterMeetingDate',
  'adjusterMeetingStart', 'adjusterName', 'adjusterPhone', 'firstName', 'lastName', 'address', 'deleted', 'stage', 'phone',
  'customerId', 'insCarrier', 'insuranceCarrier', 'claimNumber', 'companyId', 'userId'];
function calendarFieldsChanged(before, after) {
  const a = before || {}, b = after || {};
  return WATCHED.some((k) => JSON.stringify(a[k] === undefined ? null : a[k]) !== JSON.stringify(b[k] === undefined ? null : b[k]));
}

/** Busy blocks from a freeBusy response, merged and sorted. */
function busyBlocks(fb) {
  const all = [];
  const cals = (fb && fb.calendars) || {};
  for (const id of Object.keys(cals)) {
    for (const b of (cals[id].busy || [])) all.push({ startMs: Date.parse(b.start), endMs: Date.parse(b.end), calendar: id, title: b.title || null });
  }
  all.sort((x, y) => x.startMs - y.startMs);
  const merged = [];
  for (const b of all) {
    const last = merged[merged.length - 1];
    if (last && b.startMs < last.endMs) { last.endMs = Math.max(last.endMs, b.endMs); last.calendars.add(b.calendar); if (b.title) last.titles.add(b.title); }
    else merged.push({ startMs: b.startMs, endMs: b.endMs, calendars: new Set([b.calendar]), titles: new Set(b.title ? [b.title] : []) });
  }
  return merged.map((m) => ({ startMs: m.startMs, endMs: m.endMs, calendars: [...m.calendars], titles: [...m.titles] }));
}

/**
 * NBD Jobs events in a window → busy entries (freeBusy shape + title),
 * skipping FREE (transparent) events and the lead being edited — its own
 * current event must not warn about itself. All-day events cover whole New
 * York days (localToUtcMs from schedule-window.js).
 */
function jobsBusy(events, excludeLeadId, localToUtcMs) {
  const out = [];
  for (const e of events || []) {
    if (!e || e.status === 'cancelled' || e.transparency === 'transparent') continue;
    const p = (e.extendedProperties && e.extendedProperties.private) || {};
    if (excludeLeadId && p.nbdLeadId === String(excludeLeadId)) continue;
    const s = e.start || {}, en = e.end || {};
    const startMs = s.dateTime ? Date.parse(s.dateTime) : (s.date ? localToUtcMs(s.date, '00:00', TZ) : NaN);
    const endMs = en.dateTime ? Date.parse(en.dateTime) : (en.date ? localToUtcMs(en.date, '00:00', TZ) : NaN);
    if (!isFinite(startMs) || !isFinite(endMs)) continue;
    out.push({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), title: e.summary || 'NBD job' });
  }
  return out;
}

/** Blocks overlapping [startMs, endMs) — the conflict warning. */
function conflictsWith(blocks, startMs, endMs, ignoreEventCalendar) {
  return (blocks || []).filter((b) => b.startMs < endMs && b.endMs > startMs
    && !(ignoreEventCalendar && b.calendars.length === 1 && b.calendars[0] === ignoreEventCalendar));
}

module.exports = {
  TZ, eventIdFor, toGoogleEvent, desiredEventsForLead, allIdsForLead, eventSignature, planSync,
  calendarFieldsChanged, busyBlocks, jobsBusy, conflictsWith, WATCHED, weekEventFor,
};
