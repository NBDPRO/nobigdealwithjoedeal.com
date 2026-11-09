/**
 * tests/nbd-os-kind-streak-2026-11-09.test.js - NBD OS P1 "Daily Success":
 * the kind streak (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md
 * §5.1, Jo's answer to §10: floors count per workday, Mon-Sat).
 *
 * floorStreak (docs/pro/daily-success/js/review-logic.js) is the ONE streak:
 * the Daily Success page (app.js day page + the nbd_streak widget key,
 * review-ui.js card + the published snapshot) and the NBD OS widget and Coach
 * (which read that snapshot) all take it from there, so they cannot disagree.
 *
 *   - Sunday is not required: a Sunday with no page or unmet floors is not a
 *     miss and never breaks a streak; a met Sunday still counts.
 *   - "Two misses in a row" means two WORKDAYS in a row: Saturday then Monday.
 *   - warned = the last finished workday was a miss ("don't miss twice"); on a
 *     Monday that workday is Saturday, and the copy says Saturday, not yesterday.
 *
 * Calendar used: Mon 2026-11-09; Sun 11-08; Sat 11-07; Fri 11-06.
 *
 * Run: node tests/nbd-os-kind-streak-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const R = require(path.join(ROOT, 'docs/pro/daily-success/js/review-logic.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const F = [{ id: 'f1', label: 'Workout' }, { id: 'f2', label: 'Protein' }];
const ALL = ['f1', 'f2'];
const page = (dk, met) => ({ dk, data: Object.fromEntries(F.map((f) => ['floormet-' + f.id, met.includes(f.id) ? '1' : '0'])) });
const S = (pages, today) => R.floorStreak(pages, F, today);
const dow = (dk) => { const [y, m, d] = dk.split('-').map(Number); return new Date(y, m - 1, d).getDay(); };

console.log('\n1. the calendar this suite uses');
ok('2026-11-09 is a Monday, 11-08 a Sunday, 11-07 a Saturday', dow('2026-11-09') === 1 && dow('2026-11-08') === 0 && dow('2026-11-07') === 6);

console.log('\n2. Sunday is not required');
let s = S([page('2026-11-06', ALL), page('2026-11-07', ALL)], '2026-11-09');
ok('Monday morning, no Sunday page: not warned (Sunday is not a miss)', s.count === 2 && !s.warned && !s.broken, J(s));
s = S([page('2026-11-06', ALL), page('2026-11-07', ALL), page('2026-11-08', [])], '2026-11-09');
ok('Monday morning, Sunday opened but floors unmet: still not warned', s.count === 2 && !s.warned && !s.broken, J(s));
s = S([page('2026-11-06', ALL), page('2026-11-07', ALL), page('2026-11-08', ALL)], '2026-11-09');
ok('a met Sunday still counts toward the streak', s.count === 3 && !s.warned, J(s));
s = S([page('2026-11-06', ALL), page('2026-11-07', []), page('2026-11-09', ALL)], '2026-11-10');
ok('missed Saturday + no Sunday is ONE miss: Friday and Monday both count', s.count === 2 && !s.warned && !s.broken, J(s));
s = S([page('2026-11-07', ALL), page('2026-11-08', [])], '2026-11-08');
ok('today is Sunday and unmet: the run stands, nothing warned', s.count === 1 && !s.warned && !s.broken && !s.todayMet, J(s));
s = S([page('2026-11-07', ALL), page('2026-11-08', ALL)], '2026-11-08');
ok('today is Sunday and met: counts, todayMet', s.count === 2 && s.todayMet, J(s));

console.log('\n3. a missed Saturday');
s = S([page('2026-11-06', ALL), page('2026-11-07', ['f1'])], '2026-11-09');
ok('Monday after a missed Saturday: warned (don\'t miss twice today), the streak survives', s.count === 1 && s.warned && !s.broken, J(s));
s = S([page('2026-11-06', ALL), page('2026-11-07', ['f1'])], '2026-11-08');
ok('Sunday after a missed Saturday: warned too (Saturday was yesterday)', s.count === 1 && s.warned && !s.broken, J(s));
s = S([page('2026-11-05', ALL), page('2026-11-06', ALL), page('2026-11-07', []), page('2026-11-09', [])], '2026-11-10');
ok('missed Saturday then missed Monday = two workdays in a row: the streak ends', s.count === 0 && s.broken && !s.warned, J(s));
s = S([page('2026-11-05', ALL), page('2026-11-06', ALL), page('2026-11-07', []), page('2026-11-09', []), page('2026-11-10', ALL)], '2026-11-11');
ok('...and only days after the two misses count again', s.count === 1 && !s.broken && !s.warned, J(s));
s = S([page('2026-11-05', ALL), page('2026-11-06', []), page('2026-11-07', [])], '2026-11-09');
ok('missed Friday and Saturday = two in a row, Sunday does not separate anything', s.count === 0 && s.broken, J(s));

console.log('\n4. week boundaries');
const twoWeeks = [];
for (let dk = '2026-10-26'; dk <= '2026-11-07'; dk = R.addDays(dk, 1)) if (dow(dk) !== 0) twoWeeks.push(page(dk, ALL));
s = S(twoWeeks, '2026-11-09');
ok('two full Mon-Sat weeks with no Sunday pages: 12 days, not warned on Monday', s.count === 12 && !s.warned && !s.broken, J(s));
s = S(twoWeeks.concat([page('2026-11-09', ALL)]), '2026-11-09');
ok('...and Monday met makes 13', s.count === 13 && s.todayMet, J(s));
// the week with the end of daylight saving time (Sunday 2026-11-01)
s = S([page('2026-10-30', ALL), page('2026-10-31', []), page('2026-11-02', ALL)], '2026-11-03');
ok('across the DST Sunday: missed Saturday is one miss, Friday and Monday count', s.count === 2 && !s.warned && !s.broken, J(s));
s = S([page('2026-10-30', ALL), page('2026-10-31', [])], '2026-11-02');
ok('Monday after DST Sunday, missed Saturday: warned', s.count === 1 && s.warned, J(s));

console.log('\n5. weekdays behave as before');
s = S([page('2026-11-03', ALL), page('2026-11-04', ALL), page('2026-11-05', ['f1'])], '2026-11-06');
ok('a missed Thursday warns on Friday', s.count === 2 && s.warned, J(s));
s = S([page('2026-11-02', ALL), page('2026-11-03', ALL), page('2026-11-04', []), page('2026-11-05', [])], '2026-11-06');
ok('two missed weekdays end it', s.count === 0 && s.broken, J(s));
ok('no floors: the same empty result', J(R.floorStreak([page('2026-11-09', ALL)], [], '2026-11-09')) === J({ count: 0, warned: false, broken: false, todayMet: false }));

console.log('\n6. one streak, every surface');
const app = read('docs/pro/daily-success/js/app.js');
const ui = read('docs/pro/daily-success/js/review-ui.js');
const home = read('docs/pro/js/os/home.js');
const coach = require(path.join(ROOT, 'docs/pro/js/os/coach-logic.js'));
ok('the day page and the nbd_streak key both take floorStreak', /window\.NBDReview\.floorStreak\(pages, floors, p\.dk\)/.test(app) && /window\.NBDReview\.floorStreak\(pages,floors,today\)\.count/.test(app));
ok('the review card and the published snapshot take floorStreak', /streak: R\(\)\.floorStreak\(allPages\(\), fl, today\(\)\)/.test(ui));
ok('the day page says Saturday on a Monday warning', /Missed Saturday\. Don't miss twice/.test(app) && /Missed yesterday\. Don't miss twice/.test(app));
ok('the review card says Saturday on a Monday warning', /Missed ' \+ \(new Date\(today\(\) \+ 'T12:00:00'\)\.getDay\(\) === 1 \? 'Saturday' : 'yesterday'\)/.test(ui));
ok('the review-logic header states the workday rule', /Mon[-–]Sat/.test(read('docs/pro/daily-success/js/review-logic.js')));
ok('the OS widget says Saturday on a Monday warning', /Missed Saturday/.test(home));
ok('on a Sunday with floors open, the review card and the OS widget both say Sunday is optional (same words)',
  /getDay\(\) === 0 \? 'Sunday is optional: it never breaks the streak\.'/.test(ui) && /getDay\(\) === 0 \? 'Sunday is optional: it never breaks the streak\.'/.test(home));
const mon = coach.evaluate({ ds: { dk: '2026-11-09', warned: true, broken: false, met: 0, of: 2 } }).filter((r) => r.id === 'ds-warned')[0];
const tue = coach.evaluate({ ds: { dk: '2026-11-10', warned: true, broken: false, met: 0, of: 2 } }).filter((r) => r.id === 'ds-warned')[0];
ok('the Coach line says Saturday on a Monday, yesterday otherwise', !!mon && /Saturday/.test(mon.text) && !!tue && /yesterday/.test(tue.text), J([mon && mon.text, tue && tue.text]));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
