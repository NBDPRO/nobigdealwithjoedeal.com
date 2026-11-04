/**
 * tests/schedule-ec-events-2026-11-04.test.js
 *
 * docs/pro/js/schedule-ec-events.js (calendar-engine trial,
 * documentation/projects/CALENDAR-ENGINE-TRIAL-2026-11-04.md) must place every
 * job, week plan, adjuster meeting and appointment on the same day and time as
 * the .ics feed and Google sync (functions/calendar-feed-logic.js). Each
 * fixture runs through BOTH and the results are compared, so a rule change on
 * one side that the other misses reddens here.
 *
 * Pinned to Pacific/Auckland so a stray local-time Date shows up as a wrong
 * day (the house trick from tests/layout-crew-2026-10-12.test.js).
 *
 * Run: node tests/schedule-ec-events-2026-11-04.test.js
 */
'use strict';

process.env.TZ = 'Pacific/Auckland';

const path = require('path');
const ROOT = path.join(__dirname, '..');
const EC = require(path.join(ROOT, 'docs/pro/js/schedule-ec-events.js'));
const FEED = require(path.join(ROOT, 'functions/calendar-feed-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const NY = (ms) => EC.nyWall(ms, 'America/New_York');

// The feed's record → what the board must show for it.
function expectFromFeed(rec) {
  if (!rec) return null;
  if (rec.startMs != null) return { start: NY(rec.startMs), end: NY(rec.endMs), allDay: false };
  return { start: rec.date, end: rec.endExclusive, allDay: true };
}
function same(label, ev, rec) {
  const want = expectFromFeed(rec);
  if (!want) { ok(label + ' (both drop it)', ev == null, ev && JSON.stringify(ev)); return; }
  const got = ev && { start: ev.start, end: ev.end, allDay: ev.allDay };
  ok(label, JSON.stringify(got) === JSON.stringify(want), 'board ' + JSON.stringify(got) + ' vs feed ' + JSON.stringify(want));
}

console.log('\nnyWall — instants to New York wall clock');
ok('summer instant (EDT, -4h)', NY(Date.UTC(2026, 6, 14, 13, 30)) === '2026-07-14 09:30');
ok('winter instant (EST, -5h)', NY(Date.UTC(2026, 11, 2, 13, 30)) === '2026-12-02 08:30');
ok('just after NY midnight stays on its NY day', NY(Date.UTC(2026, 10, 10, 5, 5)) === '2026-11-10 00:05');
ok('the evening before is still the previous NY day', NY(Date.UTC(2026, 10, 10, 4, 55)) === '2026-11-09 23:55');

console.log('\nleads — same day and time as the feed');
const leads = [
  { id: 'a', firstName: 'Ann', lastName: 'Allday', scheduledDate: '2026-11-10' },
  { id: 'b', firstName: 'Bo', scheduledDate: '2026-11-10', scheduledStart: '09:00', scheduledDurationMin: 90 },
  { id: 'c', address: '12 Elm St', scheduledDate: '2026-11-12', scheduledStart: '07:00', scheduledEndDate: '2026-11-13' },
  { id: 'd', firstName: 'Point', scheduledDate: '2026-11-11', scheduledStart: '14:00' },
  { id: 'e', firstName: 'Bad', scheduledDate: '2026-11-14', scheduledEndDate: '2026-11-01' },
  { id: 'f', firstName: 'Gone', scheduledDate: '2026-11-10', deleted: true },
  { id: 'g', firstName: 'Week', scheduledWeek: '2026-11-18' },
  { id: 'h', firstName: 'Nothing' },
  // DST ends 2026-11-01 in New York: a 1:30 am start is the ambiguous hour.
  { id: 'i', firstName: 'Dst', scheduledDate: '2026-11-01', scheduledStart: '01:30', scheduledDurationMin: 60 },
  { id: 'j', firstName: 'Spring', scheduledDate: '2026-03-08', scheduledStart: '08:00', scheduledDurationMin: 30 },
  { id: 'k', firstName: 'Late', scheduledDate: '2026-11-20', scheduledStart: '23:30', scheduledDurationMin: 60 },
];
for (const d of leads) {
  const feed = FEED.normalizeLead(d) || FEED.normalizeLeadWeek(d);
  same('lead ' + d.id, EC.leadEvent(d), feed);
}
ok('two-day project carries its start time in the note', EC.leadEvent(leads[2]).extendedProps.note === '7:00 am · 2-day job',
  JSON.stringify(EC.leadEvent(leads[2]).extendedProps.note));
ok('week plan covers Mon–Fri (exclusive Saturday end)', EC.leadEvent(leads[6]).end === '2026-11-21');
ok('timed job crossing midnight ends the next day', EC.leadEvent(leads[10]).end === '2026-11-21 00:30');

console.log('\nadjuster meetings');
const adj = [
  { id: 'm1', firstName: 'Cara', adjusterMeetingDate: '2026-11-17', adjusterMeetingStart: '10:00' },
  { id: 'm2', firstName: 'Dee', adjusterMeetingDate: '2026-11-18' },
  { id: 'm3', firstName: 'Gone', adjusterMeetingDate: '2026-11-18', deleted: true },
  { id: 'm4', firstName: 'Bad', adjusterMeetingDate: '2026-13-40' },
];
for (const d of adj) same('adjuster ' + d.id, EC.adjusterEvent(d), FEED.normalizeAdjusterMeeting(d));

console.log('\nappointments');
const appts = [
  { bookingId: 'p1', title: 'Roof inspection', startTime: '2026-11-10T15:00:00.000Z', endTime: '2026-11-10T16:00:00.000Z', status: 'booked' },
  { bookingId: 'p2', attendeeName: 'No End', startTime: Date.UTC(2026, 10, 11, 18, 0), status: 'booked' },
  { bookingId: 'p3', title: 'Backwards', startTime: { seconds: Date.UTC(2026, 10, 12, 14, 0) / 1000 }, endTime: { seconds: Date.UTC(2026, 10, 12, 13, 0) / 1000 } },
  { bookingId: 'p4', title: 'Cancelled', startTime: '2026-11-10T15:00:00.000Z', status: 'cancelled' },
  { bookingId: 'p5', title: 'No start' },
];
for (const d of appts) same('appointment ' + d.bookingId, EC.appointmentEvent(d), FEED.normalizeAppointment(d));

console.log('\nCRM-booked appointments (leads/{id}/tasks type event) — same as the feed');
const L1 = { id: 'L1', firstName: 'Eve', lastName: 'Event', address: '1 Main' };
const tasks = [
  [{ id: 't1', type: 'event', title: 'Gutter check', eventAt: '2026-11-12T15:00:00.000Z' }, L1],
  [{ id: 't2', type: 'event', title: 'Walkthrough with Eve Event', eventAt: '2026-11-12T18:00:00.000Z', durationMin: 30 }, L1],
  [{ id: 't3', type: 'event', eventAt: '2026-11-13T14:00:00.000Z', durationMin: 5000 }, L1],
  [{ id: 't4', type: 'event', eventAt: '2026-11-13T14:00:00.000Z', cancelled: true }, L1],
  [{ id: 't5', type: 'task', eventAt: '2026-11-13T14:00:00.000Z' }, L1],
  [{ id: 't6', type: 'event', eventAt: '2026-11-13T14:00:00.000Z' }, Object.assign({}, L1, { deleted: true })],
  [{ id: 't7', type: 'event' }, L1],
];
for (const [t, lead] of tasks) {
  const mine = EC.crmEventToAppointment(t, lead, lead.id, t.id);
  const feed = FEED.leadEventToAppointment(t, lead, lead.id, t.id);
  const pick = (a) => a && { id: a.id, startTime: a.startTime, endTime: a.endTime, title: a.title, leadId: a.leadId };
  ok('task ' + t.id + ' matches the feed', JSON.stringify(pick(mine)) === JSON.stringify(pick(feed)), JSON.stringify(pick(mine)) + ' vs ' + JSON.stringify(pick(feed)));
}
const crmEv = EC.appointmentEvent(EC.crmEventToAppointment(tasks[0][0], L1, 'L1', 't1'));
ok('a CRM event lands on the board at its New York time, an hour long', crmEv && crmEv.start === '2026-11-12 10:00' && crmEv.end === '2026-11-12 11:00', JSON.stringify(crmEv));

console.log('\ntoEvents — the whole board');
const all = EC.toEvents({ leads: leads.concat(adj), appointments: appts });
const ids = all.map((e) => e.id);
ok('one event per placeable doc', ids.length === 9 + 2 + 3, ids.join(','));
ok('ids are unique', new Set(ids).size === ids.length);
ok('deleted, cancelled and undated docs are absent',
  !ids.includes('lead-f') && !ids.includes('lead-h') && !ids.includes('adj-m3') && !ids.includes('appt-p4') && !ids.includes('appt-p5'));
ok('every event carries a kind', all.every((e) => ['job', 'week', 'adjuster', 'appointment'].includes(e.extendedProps.kind)));

console.log('\ntitles stay text');
const x = EC.leadEvent({ id: 'x', firstName: '<img src=x onerror=alert(1)>', scheduledDate: '2026-11-10' });
ok('markup in a name is kept as a plain string title', typeof x.title === 'string' && x.title.indexOf('<img') === 0);
ok('no event ever uses the html content option', all.concat([x]).every((e) => !('html' in e) && typeof e.title === 'string'));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
