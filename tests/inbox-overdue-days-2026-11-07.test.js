/**
 * tests/inbox-overdue-days-2026-11-07.test.js
 *
 * Triage Inbox: a follow-up's red badge and the line under it disagreed —
 * "Overdue 2d" over "Follow-up was due 3 days ago", and "Overdue 2h 48m" over
 * "Follow-up was due 1 day ago" (CRM walk 2026-11-07, finding 12). The words
 * count calendar days; the badge measured elapsed time from the END of the due
 * day. A day-granular deadline (one that ends at 23:59:59.999 local) now counts
 * calendar days in its badge; hour reply windows keep their hours and minutes.
 * The stalled-follow-up deadline also steps back by calendar days, so it stays
 * an end-of-day across a DST change.
 *
 * Runs the shipped pure logic (layouts/inbox.js exports it). Zero deps.
 * Run: node tests/inbox-overdue-days-2026-11-07.test.js
 */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'docs/pro/js/layouts/inbox.js'));
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const MIN = 60000, HOUR = 3600000;
const endOf = (y, m, d) => new Date(y, m, d, 23, 59, 59, 999).getTime();
const at = (y, m, d, h, mi) => new Date(y, m, d, h, mi, 0, 0).getTime();

// 2026-11-07 02:30 local — the walk's clock.
const NOW = at(2026, 10, 7, 2, 30);

const t3 = L.timer(endOf(2026, 10, 4), 24 * HOUR, NOW);
ok('due Nov 4, seen Nov 7 02:30: "Overdue 3d" (was "Overdue 2d")', t3.label === 'Overdue 3d' && t3.state === 'red', JSON.stringify(t3));
const t1 = L.timer(endOf(2026, 10, 6), 24 * HOUR, at(2026, 10, 7, 2, 48));
ok('due yesterday, seen 02:48: "Overdue 1d" (was "Overdue 2h 48m")', t1.label === 'Overdue 1d', JSON.stringify(t1));
const tEve = L.timer(endOf(2026, 10, 6), 24 * HOUR, at(2026, 10, 7, 23, 0));
ok('due yesterday, seen late today: still "Overdue 1d"', tEve.label === 'Overdue 1d', JSON.stringify(tEve));
const tToday = L.timer(endOf(2026, 10, 7), 24 * HOUR, NOW);
ok('due today, not past: not red', tToday.state !== 'red', JSON.stringify(tToday));

// Hour reply windows are untouched.
const tHour = L.timer(NOW - 90 * MIN, 2 * HOUR, NOW);
ok('an hour window 90 minutes late still says "Overdue 1h 30m"', tHour.label === 'Overdue 1h 30m', JSON.stringify(tHour));
const tHour2 = L.timer(NOW - 26 * HOUR, 2 * HOUR, NOW);
ok('an hour window 26 hours late still says "Overdue 1d"', tHour2.label === 'Overdue 1d', JSON.stringify(tHour2));

// The badge and the words agree on a stalled follow-up, for 1..5 days late.
const lead = { id: 'S1', firstName: 'Sam', lastName: 'Stall', phone: '5135550199', stage: 'contacted', _stageKey: 'contacted' };
let agree = true; const seen = [];
for (let late = 1; late <= 5; late++) {
  const items = L.buildItems({ now: NOW, leads: [lead], plan: { stalled: [{ leadId: 'S1', name: 'Sam Stall', daysLate: late }] } });
  const r = items[0] && items[0].reasons.find((x) => x.kind === 'nudge');
  const words = r && /was due (\d+) day/.exec(r.why);
  const badge = r && /^Overdue (\d+)d$/.exec(r.timer.label);
  seen.push(late + ':' + (r ? r.timer.label + ' / ' + r.why : 'none'));
  if (!words || !badge || words[1] !== String(late) || badge[1] !== String(late)) agree = false;
}
ok('stalled follow-ups 1..5 days late: badge days === "was due N days ago"', agree, seen.join(' | '));

// The stalled deadline is a real end-of-day (calendar step, not late × 24h).
const items = L.buildItems({ now: NOW, leads: [lead], plan: { stalled: [{ leadId: 'S1', name: 'Sam Stall', daysLate: 3 }] } });
const by = items[0].reasons[0].replyByMs;
ok('the 3-days-late deadline is 23:59:59.999 on Nov 4', by === endOf(2026, 10, 4), new Date(by).toString());
// Across the US fall-back (Nov 1 2026) a 24h step lands an hour off end-of-day
// in a DST timezone; the calendar step does not. (UTC CI has no DST: still true.)
const dst = L.buildItems({ now: at(2026, 10, 3, 9, 0), leads: [lead], plan: { stalled: [{ leadId: 'S1', name: 'Sam Stall', daysLate: 3 }] } });
const byDst = dst[0].reasons[0].replyByMs;
ok('across a DST change the deadline is still 23:59:59.999 on the due day (Oct 31)', byDst === endOf(2026, 9, 31), new Date(byDst).toString());

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
