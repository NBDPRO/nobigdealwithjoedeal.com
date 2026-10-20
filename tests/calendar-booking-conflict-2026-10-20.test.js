/**
 * tests/calendar-booking-conflict-2026-10-20.test.js
 *
 * Calendar hub, Jo's answer #4 (2026-09-29): "warn; don't block". A Cal.com
 * booking that still lands on a job must never be silent — the webhook asks
 * functions/google-calendar.js _internal.bookingConflicts and writes one bell
 * row for Jo. Synthetic data only; a fake Google serves the NBD Jobs events.
 *
 * Run: node tests/calendar-booking-conflict-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
process.env.NBD_OWNER_UID = 'OWNER';
const G = require(path.join(__dirname, '..', 'functions', 'google-calendar-logic.js'));
const M = require(path.join(__dirname, '..', 'functions', 'google-calendar.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

const lead = (id, f) => Object.assign({ id, companyId: 'OWNER', userId: 'OWNER', firstName: 'ZZ_QA', lastName: id, address: id + ' ZZQA St', stage: 'contract_signed' }, f);
const events = [].concat(
  G.desiredEventsForLead(lead('Install', { scheduledDate: '2026-10-06', scheduledStart: '07:00', scheduledDurationMin: 240 })),
  G.desiredEventsForLead(lead('Reminder', { scheduledDate: '2026-10-06' })),
  G.desiredEventsForLead(lead('Project', { scheduledDate: '2026-10-12', scheduledStart: '07:00', scheduledEndDate: '2026-10-13' })));
const client = (fail) => ({ email: async () => null, request: async () => { if (fail) throw new Error('boom'); return { data: { items: events } }; } });
const dbWith = (cfg) => ({ doc: () => ({ get: async () => ({ exists: !!cfg, data: () => cfg }) }) });
const at = (iso) => Date.parse(iso);

(async () => {
  M._internal.setClient(client(false));
  const db = dbWith({ calendarId: 'cal1' });

  console.log('\n1. which bookings overlap a job');
  const hit = await M._internal.bookingConflicts(db, at('2026-10-06T13:00:00Z'), at('2026-10-06T14:00:00Z')); // 9-10am ET
  ok('a 9am booking inside the 7-11 install is flagged and names the job', hit.length === 1 && /Install/.test(hit[0].title), JSON.stringify(hit));
  ok('the free date-only reminder never counts', !hit.some((h) => /Reminder/.test(h.title)));
  ok('a 1pm booking after the job is clear', (await M._internal.bookingConflicts(db, at('2026-10-06T17:00:00Z'), at('2026-10-06T18:00:00Z'))).length === 0);
  ok('a booking that ends exactly when the job starts is clear (touching is not overlapping)',
    (await M._internal.bookingConflicts(db, at('2026-10-06T10:00:00Z'), at('2026-10-06T11:00:00Z'))).length === 0);
  const proj = await M._internal.bookingConflicts(db, at('2026-10-13T15:00:00Z'), at('2026-10-13T16:00:00Z'));
  ok('a booking on day 2 of a multi-day project is flagged', proj.length === 1 && /Project/.test(proj[0].title), JSON.stringify(proj));

  console.log('\n2. the bell row');
  const n = G.bookingConflictNotice('Pat Sample', at('2026-10-06T13:00:00Z'), hit);
  ok('names who, when (New York time) and which job', /Pat Sample/.test(n.message) && /9:00 AM/.test(n.message) && /Install/.test(n.message), n.message);
  ok('warns only: tells Jo to reschedule, never says blocked', /reschedule/.test(n.message) && !/block/i.test(n.message));

  console.log('\n3. it can never hurt the booking');
  ok('Google not set up yet: no conflicts', (await M._internal.bookingConflicts(dbWith(null), at('2026-10-06T13:00:00Z'), at('2026-10-06T14:00:00Z'))).length === 0);
  M._internal.setClient(client(true));
  ok('a Google failure returns no conflicts instead of throwing', (await M._internal.bookingConflicts(db, at('2026-10-06T13:00:00Z'), at('2026-10-06T14:00:00Z'))).length === 0);
  process.env.GOOGLE_CALENDAR_SYNC_DISABLED = 'true';
  M._internal.setClient(client(false));
  ok('the kill switch silences it', (await M._internal.bookingConflicts(db, at('2026-10-06T13:00:00Z'), at('2026-10-06T14:00:00Z'))).length === 0);
  delete process.env.GOOGLE_CALENDAR_SYNC_DISABLED;

  console.log('\n4. the webhook is wired to it, owner only, one row per booking');
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'integrations', 'calcom.js'), 'utf8').replace(/\r\n/g, '\n');
  ok('calcom.js asks bookingConflicts after writing the appointment', /bookingConflicts\(db, startTime\.getTime\(\), endTime\.getTime\(\)\)/.test(src));
  ok('it only runs for the owner\'s own bookings', /repUid === \(process\.env\.NBD_OWNER_UID/.test(src));
  ok('the bell row id is deterministic per booking + start (webhook redelivery cannot double it)', /notifications\/calcom-conflict-\$\{bookingId\}-\$\{startTime\.getTime\(\)\}/.test(src));
  ok('a failure is swallowed (warn log), never a 500', /conflict check skipped/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
