/**
 * tests/calendar-job-booking-conflict-2026-10-22.test.js
 *
 * Calendar hub, Jo's answer #4 (2026-09-29), the reverse direction: a JOB
 * saved or moved onto an existing Cal.com booking must never be silent. The
 * lead / job calendar triggers ask alertJobOverlapsBookings, which writes one
 * bell row per (job start, booking). Warn only: nothing is blocked, nothing is
 * sent to the customer. Synthetic data; a fake Firestore serves the bookings.
 * Dates are fixed strings, so nothing here depends on the clock.
 *
 * Run: node tests/calendar-job-booking-conflict-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
process.env.NBD_OWNER_UID = 'OWNER';
const G = require(path.join(__dirname, '..', 'functions', 'google-calendar-logic.js'));
const M = require(path.join(__dirname, '..', 'functions', 'google-calendar.js'));
const SW = require(path.join(__dirname, '..', 'functions', 'schedule-window.js'));
const { Timestamp } = require(require.resolve('firebase-admin/firestore', { paths: [path.join(__dirname, '..', 'functions')] }));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

const lead = (id, f) => Object.assign({ id, companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: id, address: id + ' ZZQA St', stage: 'contract_signed' }, f);
const at = (iso) => Date.parse(iso);
const appt = (id, startIso, endIso, extra) => Object.assign({ userId: 'OWNER', attendeeName: 'Pat ' + id, status: 'booked',
  startTime: Timestamp.fromMillis(at(startIso)), endTime: Timestamp.fromMillis(at(endIso)) }, extra);

// Oct 6, 7-11am New York = 11:00-15:00Z (EDT)
const install = G.desiredEventsForLead(lead('Install', { scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledDurationMin: 240 }));
const reminder = G.desiredEventsForLead(lead('Reminder', { scheduledDate: '2026-10-06' }));
const project = G.desiredEventsForLead(lead('Project', { scheduledDate: '2026-10-12', scheduledStart: '07:00', scheduledEndDate: '2026-10-13' }));

function fakeDb(appts, opts) {
  const o = opts || {};
  const created = [], queries = [];
  const ids = new Set(o.existingIds || []);
  return {
    created, queries,
    collection: (name) => {
      const q = { name, wheres: [] };
      const api = {
        where: (f, op, v) => { q.wheres.push([f, op, v]); return api; },
        limit: (n) => { q.limit = n; return api; },
        get: async () => {
          queries.push(q);
          if (o.readFails) throw new Error('boom');
          return { forEach: (fn) => Object.keys(appts).forEach((k) => fn({ id: k, data: () => appts[k] })) };
        },
      };
      return api;
    },
    doc: (p) => ({
      create: async (d) => {
        if (ids.has(p)) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; }
        ids.add(p); created.push({ path: p, data: d });
      },
    }),
  };
}

(async () => {
  console.log('\n1. pure overlap rule (jobBookingOverlaps)');
  const A = (id, s, e) => ({ id, name: 'Pat ' + id, startMs: at(s), endMs: at(e) });
  const run = (evs, list) => G.jobBookingOverlaps(evs, list, SW.localToUtcMs);
  const hit = run(install, [A('in', '2026-10-06T13:00:00Z', '2026-10-06T14:00:00Z')]);
  ok('a booking inside the 7-11 install is flagged and names the job', hit.length === 1 && /Install/.test(hit[0].jobTitle) && hit[0].apptId === 'in', JSON.stringify(hit));
  ok('a booking that straddles the job start is flagged', run(install, [A('s', '2026-10-06T10:30:00Z', '2026-10-06T11:30:00Z')]).length === 1);
  ok('a booking after the job is clear', run(install, [A('late', '2026-10-06T17:00:00Z', '2026-10-06T18:00:00Z')]).length === 0);
  ok('a booking that ends exactly when the job starts is clear (touching is not overlapping)', run(install, [A('t', '2026-10-06T10:00:00Z', '2026-10-06T11:00:00Z')]).length === 0);
  ok('a booking that starts exactly when the job ends is clear', run(install, [A('t2', '2026-10-06T15:00:00Z', '2026-10-06T16:00:00Z')]).length === 0);
  ok('the free date-only reminder never counts', run(reminder, [A('r', '2026-10-06T13:00:00Z', '2026-10-06T14:00:00Z')]).length === 0);
  ok('day 2 of a multi-day project is flagged', run(project, [A('d2', '2026-10-13T15:00:00Z', '2026-10-13T16:00:00Z')]).length === 1);
  ok('a zero-length or backwards booking is ignored', run(install, [A('z', '2026-10-06T13:00:00Z', '2026-10-06T13:00:00Z'), A('b', '2026-10-06T14:00:00Z', '2026-10-06T13:00:00Z')]).length === 0);
  ok('no events, no bookings: nothing', run([], []).length === 0 && run(install, null).length === 0);

  console.log('\n2. the bell row');
  const n = G.jobConflictNotice(run(install, [A('in', '2026-10-06T13:00:00Z', '2026-10-06T14:00:00Z')]));
  ok('names the job, who, and when in New York time', /Install/.test(n.message) && /Pat in/.test(n.message) && /9:00 AM/.test(n.message), n && n.message);
  ok('warns only: tells Jo to reschedule, never says blocked', /reschedule/.test(n.message) && !/block/i.test(n.message));
  ok('no overlaps, no notice', G.jobConflictNotice([]) === null);

  console.log('\n3. alertJobOverlapsBookings');
  const bookings = {
    hit: appt('hit', '2026-10-06T13:00:00Z', '2026-10-06T14:00:00Z'),
    gone: appt('gone', '2026-10-06T13:00:00Z', '2026-10-06T14:00:00Z', { status: 'cancelled' }),
    other: appt('other', '2026-10-06T13:00:00Z', '2026-10-06T14:00:00Z', { userId: 'SOMEONE_ELSE' }),
    after: appt('after', '2026-10-06T17:00:00Z', '2026-10-06T18:00:00Z'),
    nodate: { userId: 'OWNER', status: 'booked' },
  };
  const db1 = fakeDb(bookings);
  const made = await M._internal.alertJobOverlapsBookings(db1, 'LeadA', install);
  ok('exactly one bell row: the live overlapping booking (not cancelled, not another tenant, not after, not undated)',
    made === 1 && db1.created.length === 1 && /job-conflict-LeadA-hit-/.test(db1.created[0].path), JSON.stringify(db1.created));
  const row = db1.created[0] && db1.created[0].data;
  ok('the row is for Jo, high priority, links to Schedule, unread',
    row && row.userId === 'OWNER' && row.type === 'job_conflict' && row.priority === 'high' && row.read === false && /#\/schedule/.test(row.clickUrl));
  const q = db1.queries[0];
  ok('it reads only appointments, bounded by a start-time window and a limit',
    q.name === 'appointments' && q.wheres.length === 2 && q.wheres.every((w) => w[0] === 'startTime') && q.limit > 0, JSON.stringify(q));
  ok('the window opens 12h before the job and closes at its end',
    q.wheres[0][2].toMillis() === at('2026-10-06T11:00:00Z') - 12 * 3600000 && q.wheres[1][2].toMillis() === at('2026-10-06T15:00:00Z'));
  const db2 = fakeDb(bookings, { existingIds: ['notifications/job-conflict-LeadA-hit-' + at('2026-10-06T11:00:00Z')] });
  ok('editing the same job again does not re-alert (row already exists)',
    (await M._internal.alertJobOverlapsBookings(db2, 'LeadA', install)) === 0 && db2.created.length === 0);
  const two = Object.assign({}, bookings, { hit2: appt('hit2', '2026-10-06T14:00:00Z', '2026-10-06T14:30:00Z') });
  const db2b = fakeDb(two, { existingIds: ['notifications/job-conflict-LeadA-hit-' + at('2026-10-06T11:00:00Z')] });
  ok('an already-alerted booking does not stop the next overlapping booking from being alerted',
    (await M._internal.alertJobOverlapsBookings(db2b, 'LeadA', install)) === 1 && db2b.created.length === 1 && /-hit2-/.test(db2b.created[0].path), JSON.stringify(db2b.created));
  const db3 = fakeDb(bookings);
  ok('a free date-only job never reads the bookings at all',
    (await M._internal.alertJobOverlapsBookings(db3, 'LeadR', reminder)) === 0 && db3.queries.length === 0);
  ok('a job with no events never reads the bookings', (await M._internal.alertJobOverlapsBookings(fakeDb(bookings), 'LeadN', [])) === 0);

  console.log('\n4. it can never hurt the save');
  ok('a Firestore read failure returns 0 instead of throwing',
    (await M._internal.alertJobOverlapsBookings(fakeDb(bookings, { readFails: true }), 'LeadA', install)) === 0);
  const db4 = fakeDb(bookings);
  db4.doc = () => ({ create: async () => { throw new Error('write denied'); } });
  ok('a notification write failure returns 0 instead of throwing', (await M._internal.alertJobOverlapsBookings(db4, 'LeadA', install)) === 0);
  process.env.GOOGLE_CALENDAR_SYNC_DISABLED = 'true';
  const db5 = fakeDb(bookings);
  ok('the kill switch silences it', (await M._internal.alertJobOverlapsBookings(db5, 'LeadA', install)) === 0 && db5.queries.length === 0);
  delete process.env.GOOGLE_CALENDAR_SYNC_DISABLED;

  console.log('\n5. both triggers are wired to it');
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'google-calendar.js'), 'utf8').replace(/\r\n/g, '\n');
  const iLead = src.indexOf('exports.onLeadCalendarWrite'), iJob = src.indexOf('exports.onJobCalendarWrite');
  const iNext = src.indexOf('exports.', iJob + 10);
  const leadTrig = src.slice(iLead, iJob), jobTrig = src.slice(iJob, iNext);
  ok('onLeadCalendarWrite alerts for the owner\'s live lead, after the sync',
    /alertJobOverlapsBookings\(db, event\.params\.leadId, G\.desiredEventsForLead/.test(leadTrig) && /isOwnerLead\(after\) && after\.deleted !== true/.test(leadTrig));
  ok('onJobCalendarWrite alerts for the owner\'s other job',
    /alertJobOverlapsBookings\(db, leadId, G\.desiredEventsForJob/.test(jobTrig) && /isOwnerLead\(lead\)/.test(jobTrig));
  ok('the bell id is deterministic and written with create() (once), not set()',
    /notifications\/job-conflict-' \+ leadId \+ '-' \+ h\.apptId \+ '-' \+ h\.jobStartMs\)\.create\(/.test(src));

  console.log('\n6. the REAL trigger handlers (not source text): they alert, and Google cannot stop them');
  const snap = (d) => ({ exists: !!d, data: () => d });
  const handlerDb = (docs, appts) => {
    const base = fakeDb(appts);
    base.doc = ((orig) => (p) => Object.assign(orig(p), { get: async () => snap(docs[p]) }))(base.doc);
    const coll = base.collection;
    base.collection = (name) => {
      if (name === 'leads') return { doc: (id) => ({ get: async () => snap(docs['leads/' + id]), collection: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }) }) };
      return coll(name);
    };
    return base;
  };
  const googleUp = { email: async () => null, request: async () => ({ data: { items: [] } }) };
  const googleDown = { email: async () => null, request: async () => { throw new Error('google outage'); } };
  M._internal.setWeather(async () => ({}));
  const cfgDoc = { 'integrations/googleCalendar': { calendarId: 'cal1' } };
  const unscheduled = lead('Install', {});
  const scheduled = lead('Install', { scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledDurationMin: 240 });
  const leadEvt = (before, after) => ({ params: { leadId: 'LeadA' }, data: { before: snap(before), after: snap(after) } });
  const jobEvt = (before, after) => ({ params: { leadId: 'LeadA', jobId: 'J2' }, data: { before: snap(before), after: snap(after) } });

  for (const [label, client] of [['Google up', googleUp], ['Google DOWN', googleDown]]) {
    M._internal.setClient(client);
    const dbL = handlerDb(cfgDoc, bookings);
    M._internal.setDb(dbL);
    await M.onLeadCalendarWrite.run(leadEvt(unscheduled, scheduled));
    ok('lead trigger, ' + label + ': moving a job onto a booking writes the bell row',
      dbL.created.length === 1 && /job-conflict-LeadA-hit-/.test(dbL.created[0].path), JSON.stringify(dbL.created));

    const dbL2 = handlerDb(cfgDoc, bookings);
    M._internal.setDb(dbL2);
    await M.onLeadCalendarWrite.run(leadEvt(scheduled, Object.assign({}, scheduled, { deleted: true })));
    ok('lead trigger, ' + label + ': a deleted lead alerts nothing', dbL2.created.length === 0);

    const dbJ = handlerDb(Object.assign({ 'leads/LeadA': lead('Install', { activeJobId: 'J1' }) }, cfgDoc), bookings);
    M._internal.setDb(dbJ);
    await M.onJobCalendarWrite.run(jobEvt(null, Object.assign({ id: 'J2', title: 'Repair', companyId: 'OWNER', userId: 'OWNER' }, { scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledDurationMin: 240 })));
    ok('job trigger, ' + label + ': another job moved onto a booking writes the bell row',
      dbJ.created.length === 1 && /job-conflict-LeadA-hit-/.test(dbJ.created[0].path), JSON.stringify(dbJ.created));
  }

  M._internal.setClient(googleUp);
  const dbN = handlerDb(cfgDoc, bookings);
  M._internal.setDb(dbN);
  await M.onLeadCalendarWrite.run(leadEvt(unscheduled, lead('Install', { scheduledDate: '2026-10-06', scheduledStart: '15:00', scheduledDurationMin: 60 })));
  ok('lead trigger: a job clear of every booking writes nothing (negative control)', dbN.created.length === 0, JSON.stringify(dbN.created));
  const dbT = handlerDb(cfgDoc, bookings);
  M._internal.setDb(dbT);
  await M.onLeadCalendarWrite.run(leadEvt(unscheduled, Object.assign({}, scheduled, { companyId: 'OTHER', userId: 'OTHER' })));
  ok('lead trigger: another tenant\'s lead alerts nothing', dbT.created.length === 0);
  const dbU = handlerDb(cfgDoc, bookings);
  M._internal.setDb(dbU);
  await M.onLeadCalendarWrite.run(leadEvt(Object.assign({}, scheduled), Object.assign({}, scheduled, { notes: 'x' })));
  ok('lead trigger: an edit that changes nothing the calendar shows alerts nothing', dbU.created.length === 0);
  M._internal.setDb(null);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
