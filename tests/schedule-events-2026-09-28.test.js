/**
 * tests/schedule-events-2026-09-28.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * The customer page's "Add Event" writes a task with type:'event' and an
 * eventAt time. The Schedule view only read the `appointments` collection, so
 * those events never appeared on the rep's day. smart-calendar.js now merges
 * today's events from window._taskCache. The failure modes this pins:
 *   - yesterday's/tomorrow's events leaking into today;
 *   - done events, or plain tasks, showing up as appointments;
 *   - another rep's event on a lead that isn't theirs showing up;
 *   - startTime passed as a Date (smart-calendar's _toMs reads numbers,
 *     strings and Timestamps, not Dates — the row rendered no time and the
 *     gap line read "497402h gap");
 *   - a zero-length event printing its start time twice.
 *
 * Pure-Node, no network. Run: node tests/schedule-events-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const noop = () => {};
const win = { addEventListener: noop, fetch: async () => { throw new Error('network disabled'); }, sessionStorage: null, CSS: { escape: (s) => s } };
const doc = { addEventListener: noop, getElementById: () => null };
const ctx = { window: win, document: doc, console, setTimeout, clearTimeout, Date, Number, Math, JSON, Array, String, Set, Promise, isFinite, Error, Intl };
ctx.getComputedStyle = () => ({ display: 'none' });
vm.createContext(ctx);
vm.runInContext(read('docs/pro/js/smart-calendar.js'), ctx, { filename: 'smart-calendar.js' });
const S = win.NBDSchedule;

console.log('\nschedule events');
ok('NBDSchedule helpers are exposed', S && typeof S.todaysEvents === 'function' && typeof S.renderApptRow === 'function');

const now = new Date(2026, 8, 28, 9, 0, 0).getTime();
const at = (h, m, dayOff) => new Date(2026, 8, 28 + (dayOff || 0), h, m || 0).toISOString();
const leads = [{ id: 'L1', userId: 'me' }, { id: 'L2', userId: 'other' }];
const cache = {
  L1: [
    { id: 'e1', type: 'event', title: 'Adjuster walk-through', eventAt: at(14, 30), userId: 'me' },
    { id: 'e2', type: 'event', title: 'Tomorrow thing', eventAt: at(10, 0, 1), userId: 'me' },
    { id: 'e3', type: 'event', title: 'Yesterday thing', eventAt: at(10, 0, -1), userId: 'me' },
    { id: 'e4', type: 'event', title: 'Done already', eventAt: at(11, 0), userId: 'me', done: true },
    { id: 't1', type: 'task', title: 'Plain task', dueDate: '2026-09-28', userId: 'me' },
    { id: 'e5', type: 'event', title: 'No time', userId: 'me' },
  ],
  L2: [
    { id: 'e6', type: 'event', title: 'Someone else', eventAt: at(15, 0), userId: 'other' },
    { id: 'e7', type: 'event', title: 'Mine on their lead', eventAt: at(16, 0), userId: 'me' },
  ],
  L9: [
    { id: 'e8', type: 'event', title: 'Orphan lead', eventAt: at(12, 0), userId: 'other' },
  ],
};
const out = S.todaysEvents('me', leads, now, cache);
const titles = out.map((e) => e.title.replace(/^\S+\s/, ''));
ok('only today\'s open events that are mine', JSON.stringify(titles.slice().sort()) === JSON.stringify(['Adjuster walk-through', 'Mine on their lead']), JSON.stringify(titles));
const e1 = out.find((e) => /Adjuster/.test(e.title));
ok('startTime is numeric ms (not a Date)', e1 && typeof e1.startTime === 'number' && e1.startTime === new Date(at(14, 30)).getTime());
ok('event carries its leadId', e1 && e1.leadId === 'L1');
ok('event ids are stable and namespaced', e1 && e1.id === 'event:L1:e1');
ok('no uid → nothing', S.todaysEvents('', leads, now, cache).length === 0);
ok('empty cache is safe', S.todaysEvents('me', leads, now, {}).length === 0);

console.log('\nrow rendering');
const html = S.renderApptRow(e1);
const times = (html.match(/\d{1,2}:\d{2}\s?[AP]M/g) || []);
ok('a zero-length event prints its time once', times.length === 1, JSON.stringify(times));
const appt = { id: 'a1', title: 'Inspection', startTime: new Date(at(10, 0)).getTime(), endTime: new Date(at(11, 0)).getTime() };
const t2 = (S.renderApptRow(appt).match(/\d{1,2}:\d{2}\s?[AP]M/g) || []);
ok('a real appointment still prints start and end', t2.length === 2, JSON.stringify(t2));

console.log('\nwiring');
const src = read('docs/pro/js/smart-calendar.js');
ok('loadSmartCalendar merges today\'s events', /appts\s*=\s*appts\.concat\(_todaysEvents\(/.test(src));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
