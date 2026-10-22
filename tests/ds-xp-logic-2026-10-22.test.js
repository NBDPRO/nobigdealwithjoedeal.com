/**
 * tests/ds-xp-logic-2026-10-22.test.js
 *
 * The pure XP, level and streak rules for the Quest / Arcade layouts (xp-logic.js). Jo's rule: the streak can break, XP is separate
 * and never drops. Pins the level curve, the XP sums (sets, warm-ups, personal records via the real coach logic, floors), the active-day
 * rule and the streak walk (rest-day bridging, today-still-open, best streak, month / year / DST edges).
 *
 * Run: node tests/ds-xp-logic-2026-10-22.test.js
 */
'use strict';

const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const X = require(path.join(DIR, 'xp-logic.js'));
const C = require(path.join(DIR, 'workout-coach-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

let _n = 0;
// sets: [weight, reps, flags?]  flags: 'w' warm-up, 'u' not done
function sess(date, exId, sets, extra) {
  return Object.assign({
    id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: 1000 + (++_n),
    exercises: [{ exId, name: exId, slot: 0, sets: sets.map(([weight, reps, f]) => ({ weight, reps, rpe: 8, done: !(f && f.includes('u')), warm: !!(f && f.includes('w')) })) }],
  }, extra || {});
}
const reps = (n, w) => Array.from({ length: n }, () => [w || 100, 8]);

console.log('\n1. levels');
{
  ok('level n starts at 50*n*(n-1): 0, 100, 300, 600, 1000', [1, 2, 3, 4, 5].map(X.xpForLevel).join() === '0,100,300,600,1000');
  ok('xpForLevel is safe below 1', X.xpForLevel(0) === 0 && X.xpForLevel(-3) === 0);
  ok('0 XP is level 1; 99 is still level 1; 100 is level 2', X.levelFor(0).level === 1 && X.levelFor(99).level === 1 && X.levelFor(100).level === 2);
  ok('299 is level 2 and 300 is level 3 (boundaries are exact)', X.levelFor(299).level === 2 && X.levelFor(300).level === 3);
  const l = X.levelFor(450);
  ok('progress: 450 XP = level 3, 150 into a 300-wide level, halfway, next at 600', l.level === 3 && l.into === 150 && l.need === 300 && l.pct === 0.5 && l.next === 600, JSON.stringify(l));
  ok('negative, NaN, junk and undefined XP are level 1 with no NaN', [-50, NaN, 'abc', undefined, null].every((v) => { const r = X.levelFor(v); return r.level === 1 && r.xp === 0 && r.pct === 0; }));
  ok('fractions floor (149.9 is still level 2)', X.levelFor(299.9).level === 2);
  ok('a big number does not hang or break', X.levelFor(1e7).level > 400 && Number.isFinite(X.levelFor(1e7).pct));
  ok('highWater keeps the best total ever shown', X.highWater(500, 300) === 500 && X.highWater(300, 500) === 500 && X.highWater(undefined, 120) === 120 && X.highWater(NaN, NaN) === 0 && X.highWater(-5, 10) === 10);
}

console.log('\n2. XP from sessions');
{
  const one = X.xpTotals([sess('2026-10-20', 'bb_bench', reps(12))], { coach: C });
  ok('a workout is 100 + 5 per working set (12 sets = 160); the first time a lift appears is not a PR', one.total === 160 && one.workouts === 160 && one.prs === 0, JSON.stringify(one));
  const warm = X.xpTotals([sess('2026-10-20', 'bb_bench', [[45, 10, 'w'], [95, 8, 'w'], [135, 8], [135, 8], [135, 8, 'u']])], { coach: C });
  ok('warm-ups and un-ticked sets earn nothing (2 working sets = 110)', warm.total === 110, String(warm.total));
  ok('the set bonus is capped at 40 sets (100 + 200)', X.xpTotals([sess('2026-10-20', 'bb_bench', reps(60))], {}).total === 300);
  ok('zero-rep sets do not count', X.xpTotals([sess('2026-10-20', 'bb_bench', [[100, 0], [100, 8]])], {}).total === 105);

  const prior = sess('2026-10-10', 'bb_bench', [[135, 8], [135, 8]]);
  const better = sess('2026-10-20', 'bb_bench', [[185, 8], [185, 8]]);
  const pr = X.xpTotals([prior, better], { coach: C });
  ok('a personal record adds 50 (real coach detectPRs, earlier sessions as the baseline)', pr.prs === 1 && pr.total === (100 + 10) + (100 + 10 + 50), JSON.stringify(pr));
  ok('the order the sessions are given in does not matter', X.xpTotals([better, prior], { coach: C }).total === pr.total);
  ok('a session that is not better than before earns no PR', X.xpTotals([better, sess('2026-10-25', 'bb_bench', [[185, 8], [185, 8]])], { coach: C }).prs === 0);
  ok('without the coach logic there is simply no PR bonus (and no crash)', X.xpTotals([prior, better], {}).prs === 0 && X.xpTotals([prior, better]).total === 220);
  ok('a coach whose detectPRs throws earns 0 for that session, never crashes', X.xpTotals([prior, better], { coach: { detectPRs() { throw new Error('x'); } } }).total === 220);

  const junk = X.xpTotals([sess('2026-10-20', 'bb_bench', reps(2), { finishedAt: 0 }), sess('2026-10-21', 'bb_bench', reps(2), { deleted: true }), sess('not-a-date', 'bb_bench', reps(2)), null, undefined, {}], { coach: C });
  ok('unfinished, deleted, bad-date and junk entries earn nothing', junk.total === 0 && Object.keys(junk.byDate).length === 0);
  ok('nothing at all is 0, not NaN', X.xpTotals([], {}).total === 0 && X.xpTotals(undefined, undefined).total === 0);
  ok('byDate sums two sessions on one day', X.xpTotals([sess('2026-10-20', 'bb_bench', reps(2)), sess('2026-10-20', 'ohp', reps(2))], {}).byDate['2026-10-20'] === 220);
  const before = JSON.stringify([prior, better]);
  X.xpTotals([prior, better], { coach: C });
  ok('read-only: the sessions are not mutated or re-sorted in place', JSON.stringify([prior, better]) === before);
}

console.log('\n3. XP from floors');
{
  const f = (days) => X.xpTotals([], { days }).total;
  ok('10 XP per floor met: 3 of 5 = 30', f([{ date: '2026-10-20', met: 3, total: 5 }]) === 30);
  ok('every floor met adds 25: 5 of 5 = 50 + 25', f([{ date: '2026-10-20', met: 5, total: 5 }]) === 75);
  ok('met above total is clamped to the total', f([{ date: '2026-10-20', met: 9, total: 5 }]) === 75);
  ok('no floors met (or none defined) earns nothing, and never the all-met bonus', f([{ date: '2026-10-20', met: 0, total: 5 }, { date: '2026-10-21', met: 0, total: 0 }]) === 0);
  ok('bad dates and junk rows are ignored', f([{ date: 'x', met: 3, total: 5 }, null, {}, { met: 2, total: 5 }]) === 0);
  const both = X.xpTotals([sess('2026-10-20', 'bb_bench', reps(2))], { days: [{ date: '2026-10-20', met: 2, total: 4 }] });
  ok('workout and floors on one day add up and split into the two buckets', both.byDate['2026-10-20'] === 110 + 20 && both.workouts === 110 && both.floors === 20 && both.total === 130);
}

console.log('\n4. active days');
{
  const a = X.activeDays([sess('2026-10-20', 'bb_bench', reps(1)), sess('2026-10-21', 'bb_bench', reps(1), { finishedAt: 0 })], [
    { date: '2026-10-22', met: 2, total: 4 }, { date: '2026-10-23', met: 1, total: 4 }, { date: '2026-10-24', met: 0, total: 0 }, { date: '2026-10-25', met: 3, total: 5 }, { date: '2026-10-26', met: 2, total: 5 },
  ]);
  ok('a finished workout makes a day active; an unfinished one does not', a.has('2026-10-20') && !a.has('2026-10-21'));
  ok('half the floors is enough (2 of 4); less is not (1 of 4); 3 of 5 yes; 2 of 5 no; zero floors defined never', a.has('2026-10-22') && !a.has('2026-10-23') && !a.has('2026-10-24') && a.has('2026-10-25') && !a.has('2026-10-26'));
  ok('junk input gives an empty set, not a crash', X.activeDays(undefined, undefined).size === 0 && X.activeDays([null], [null, {}]).size === 0);
}

console.log('\n5. the streak');
{
  const S = (list, today, rest) => X.streak(new Set(list), today, rest);
  ok('nothing logged: 0 and no best', (() => { const s = S([], '2026-10-22'); return s.current === 0 && s.best === 0 && s.lastActive === null && !s.atRisk; })());
  ok('active today only: 1', S(['2026-10-22'], '2026-10-22').current === 1 && S(['2026-10-22'], '2026-10-22').activeToday === true);
  ok('three days in a row ending today: 3', S(['2026-10-20', '2026-10-21', '2026-10-22'], '2026-10-22').current === 3);
  ok('today empty so far does not break it (the day is not over): ended yesterday = still 2, and not at risk (yesterday was active)', S(['2026-10-20', '2026-10-21'], '2026-10-22').current === 2 && S(['2026-10-20', '2026-10-21'], '2026-10-22').atRisk === false);
  const two = S(['2026-10-20', '2026-10-21'], '2026-10-23');
  ok('one rest day in a row is bridged: still alive, and flagged at risk (one more empty day breaks it)', two.current === 2 && two.atRisk === true);
  ok('two empty days in a row BREAK it (the streak resets, best is kept)', (() => { const s = S(['2026-10-20', '2026-10-21'], '2026-10-24'); return s.current === 0 && s.best === 2 && !s.atRisk; })());
  ok('a rest day between workouts is bridged and does not count: 20, 22 = 2', S(['2026-10-20', '2026-10-22'], '2026-10-22').current === 2);
  ok('a two-day gap between workouts breaks it: 19, 22 = 1 (and best is 1)', (() => { const s = S(['2026-10-19', '2026-10-22'], '2026-10-22'); return s.current === 1 && s.best === 1; })());
  ok('best streak is the best run in history even when the current one is shorter', (() => { const s = S(['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-10-21', '2026-10-22'], '2026-10-22'); return s.current === 2 && s.best === 4; })());
  ok('best counts bridged rest days the same way as current', S(['2026-09-01', '2026-09-03', '2026-09-05', '2026-09-07'], '2026-10-30').best === 4);
  ok('rest = 0: any gap breaks it', S(['2026-10-20', '2026-10-22'], '2026-10-22', 0).current === 1 && S(['2026-10-20', '2026-10-21'], '2026-10-23', 0).current === 0);
  ok('rest = 2: two empty days in a row are still bridged', S(['2026-10-18', '2026-10-21'], '2026-10-21', 2).current === 2 && S(['2026-10-18', '2026-10-22'], '2026-10-22', 2).current === 1);
  ok('bad rest values fall back safely (default 1; negative = 0)', S(['2026-10-20', '2026-10-22'], '2026-10-22', 'abc').current === 2 && S(['2026-10-20', '2026-10-22'], '2026-10-22', -4).current === 1);
  ok('lastActive is the newest active day', S(['2026-10-20', '2026-10-21'], '2026-10-22').lastActive === '2026-10-21');
  ok('an active day AFTER today (clock skew) does not extend or break the streak', S(['2026-10-21', '2026-10-25'], '2026-10-22').current === 1);
  ok('month edge: Oct 31, Nov 1, Nov 2 is a run of 3', S(['2026-10-31', '2026-11-01', '2026-11-02'], '2026-11-02').current === 3);
  ok('year edge: Dec 31 and Jan 1', S(['2026-12-31', '2027-01-01'], '2027-01-01').current === 2);
  ok('DST edges: the fall-back day (Nov 1 2026) and spring-forward day (Mar 8 2026) are not skipped or doubled', S(['2026-10-31', '2026-11-01', '2026-11-02'], '2026-11-02').current === 3 && S(['2026-03-07', '2026-03-08', '2026-03-09'], '2026-03-09').current === 3);
  ok('the day arithmetic is calendar-day exact in any time zone (DST fall-back and spring-forward in New York, Auckland, UTC)', ['America/New_York', 'Pacific/Auckland', 'UTC', 'Europe/London'].every((tz) => {
    const code = "const X=require(process.argv[1]);const S=(l,t)=>X.streak(new Set(l),t).current;process.stdout.write([S(['2026-10-31','2026-11-01','2026-11-02'],'2026-11-02'),S(['2026-03-07','2026-03-08','2026-03-09'],'2026-03-09'),S(['2026-03-28','2026-03-29','2026-03-30'],'2026-03-30'),S(['2026-09-26','2026-09-27','2026-09-28'],'2026-09-28')].join())";
    return require('child_process').execFileSync(process.execPath, ['-e', code, path.join(DIR, 'xp-logic.js')], { env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' }) === '3,3,3,3';
  }));
  ok('an array works as well as a Set', X.streak(['2026-10-21', '2026-10-22'], '2026-10-22').current === 2);
  ok('the real inputs: active days from sessions + floors feed straight in', X.streak(X.activeDays([sess('2026-10-21', 'bb_bench', reps(1))], [{ date: '2026-10-22', met: 3, total: 5 }]), '2026-10-22').current === 2);
}

console.log('\n6. XP is separate from the streak');
{
  const old = [sess('2026-06-01', 'bb_bench', reps(10)), sess('2026-06-03', 'bb_bench', reps(10))];
  const xp = X.xpTotals(old, { coach: C }).total;
  const st = X.streak(X.activeDays(old, []), '2026-10-22');
  ok('months of silence: the streak is 0 but the XP and level are untouched', st.current === 0 && xp === 300 && X.levelFor(xp).level === 3 && st.best === 2);
  ok('more history never lowers XP (adding a session only adds)', X.xpTotals(old.concat([sess('2026-10-21', 'ohp', reps(3))]), {}).total > X.xpTotals(old, {}).total);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
