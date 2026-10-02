#!/usr/bin/env node
/**
 * Jo's operating system, Build 1 (2026-10-02): "don't miss twice" floor
 * streaks and the Sunday review (docs/pro/daily-success/js/review-logic.js,
 * review-ui.js).
 *
 * Run: node tests/tracker-sunday-review-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const R = require(path.join(ROOT, 'docs/pro/daily-success/js/review-logic.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const F = [{ id: 'f1', label: 'Workout done' }, { id: 'f2', label: 'Protein hit' }];
const page = (dk, met) => ({ dk, data: Object.fromEntries(F.map((f) => ['floormet-' + f.id, met.includes(f.id) ? '1' : '0'])) });
const ALL = ['f1', 'f2'];
// Day strings back from Friday 2026-10-02.
const d = (n) => R.addDays('2026-10-02', -n);

console.log('\n── "don\'t miss twice" streak');
let s = R.floorStreak([page(d(3), ALL), page(d(2), ALL), page(d(1), ALL), page(d(0), [])], F, d(0));
ok('today in progress is not a miss (old streak read "broken" every morning)', s.count === 3 && !s.warned && !s.broken, JSON.stringify(s));
s = R.floorStreak([page(d(3), ALL), page(d(2), ALL), page(d(1), ALL), page(d(0), ALL)], F, d(0));
ok('today met counts', s.count === 4 && s.todayMet);
s = R.floorStreak([page(d(4), ALL), page(d(3), ALL), page(d(2), ALL), page(d(1), ['f1']), page(d(0), [])], F, d(0));
ok('one miss yesterday: streak survives with a warning', s.count === 3 && s.warned && !s.broken, JSON.stringify(s));
s = R.floorStreak([page(d(5), ALL), page(d(4), ['f2']), page(d(3), ALL), page(d(2), []), page(d(1), ALL), page(d(0), [])], F, d(0));
ok('single misses that never touch survive (met, miss, met, miss, met)', s.count === 3 && !s.warned, JSON.stringify(s));
s = R.floorStreak([page(d(5), ALL), page(d(4), ALL), page(d(3), []), page(d(2), []), page(d(1), ALL), page(d(0), [])], F, d(0));
ok('two misses in a row end it: only days after count', s.count === 1, JSON.stringify(s));
s = R.floorStreak([page(d(4), ALL), page(d(3), ALL), page(d(2), []), page(d(1), []), page(d(0), [])], F, d(0));
ok('two misses with nothing since → broken, count 0', s.count === 0 && s.broken, JSON.stringify(s));
s = R.floorStreak([page(d(4), ALL), page(d(3), ALL), page(d(1), ['f1']), page(d(0), [])], F, d(0));
ok('a day with NO page is a miss (d2 missing + d1 missed = two in a row)', s.count === 0 && s.broken, JSON.stringify(s));
s = R.floorStreak([page(d(2), ALL), page(d(1), ['f1']), page(d(1), ['f2']), page(d(0), [])], F, d(0));
ok('two pages the same day merge their floors', s.count === 2 && !s.warned, JSON.stringify(s));
ok('no floors set → no streak, no warning', JSON.stringify(R.floorStreak([page(d(0), ALL)], [], d(0))) === JSON.stringify({ count: 0, warned: false, broken: false, todayMet: false }));
s = R.floorStreak(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map((k) => page(k, ALL)), F, '2026-11-02');
ok('a daylight-saving week does not skip or repeat a day', s.count === 4, JSON.stringify(s));
ok('addDays across DST end', R.addDays('2026-11-01', 1) === '2026-11-02' && R.addDays('2026-11-02', -1) === '2026-11-01' && R.addDays('2026-03-09', -1) === '2026-03-08');

console.log('\n── the week');
const wkPages = [page(d(7), ALL), page(d(6), ALL), page(d(5), ['f1']), page(d(4), ALL), page(d(2), ['f2']), page(d(1), ALL), page(d(0), [])];
const w = R.weekFloors(wkPages, F, d(0), 500);
ok('window is the 7 finished days before today', w.from === d(7) && w.to === d(1), w.from + '..' + w.to);
ok('hits per floor out of 7 (missing day d3 counts as missed)', w.rows[0].hit === 5 && w.rows[1].hit === 5 && w.rows[0].of === 7, JSON.stringify(w.rows));
ok('misses, % and full days', w.misses === 4 && w.possible === 14 && w.pct === 71 && w.fullDays === 4, JSON.stringify([w.misses, w.pct, w.fullDays]));
ok('miss tax is $5 per missed floor', w.missTaxCents === 2000);
ok('today never enters the week', !R.weekFloors([page(d(0), [])], F, d(0)).rows.some((r) => r.hit));

console.log('\n── Sunday weigh-in rule');
ok('no data → says so, no advice', R.weightRule({ change7: null }, 2400).verdict === 'no-data');
ok('down 0.5 or more → keep the plan', R.weightRule({ change7: -0.6 }, 2400).verdict === 'on-track' && R.weightRule({ change7: -0.5 }, 2400).verdict === 'on-track');
const adj = R.weightRule({ change7: -0.2 }, 2400);
ok('down less than 0.5 → cut 200 from the set target', adj.verdict === 'adjust' && adj.newCalories === 2200 && /2400 → 2200/.test(adj.text), JSON.stringify(adj));
const up = R.weightRule({ change7: 0.8 }, null);
ok('no calorie target → never invents one', up.verdict === 'adjust' && up.newCalories === null && /Set a daily calorie target/.test(up.text) && /Up 0\.8/.test(up.text));
const g = R.goalProgress({ avg7: 237.5 }, 375, 220);
ok('goal progress from the 7-day average', g && g.left === 17.5 && Math.abs(g.pct - (137.5 / 155)) < 1e-9, JSON.stringify(g));
ok('no goal set → no bar', R.goalProgress({ avg7: 237 }, 375, null) === null);

console.log('\n── review records + scorecard');
const reviews = { '2026-09-27': { scary: 'Call the bank about the house', scaryDue: '2026-10-02' }, '2026-10-04': { pct: 80 } };
ok('Sunday is review day; a saved review clears it', R.reviewDue('2026-10-04', {}).due === true && R.reviewDue('2026-10-04', reviews).due === false && R.reviewDue('2026-10-02', {}).sunday === false);
const last = R.lastReview(reviews, '2026-10-04');
ok('last week\'s review is found for the accountability step', last && last.dk === '2026-09-27' && /bank/.test(last.scary));
const card = R.scorecardText({ from: w.from, to: w.to, floors: w, taxMoved: false, streak: { count: 3, warned: true }, weight: adj, goal: g,
  lastScary: { text: 'Call the bank about the house', done: false }, kept: 'Lifted 5 days', bailed: 'Skipped meal prep', scary: 'Cancel 2 subscriptions', scaryDue: '2026-10-10' });
ok('scorecard: floors, per-floor lines, tax NOT moved', /Floors: 10\/14 \(71%\)/.test(card) && /Workout done: 5\/7/.test(card) && /Miss tax: \$20 — NOT moved yet/.test(card), card);
ok('scorecard: streak warning, weight, goal, last hard thing NOT DONE, audit, next hard thing', /Streak: 3 \(missed yesterday\)/.test(card) && /2400 → 2200/.test(card) && /17\.5 to go/.test(card) && /NOT DONE/.test(card) && /Bailed: Skipped meal prep/.test(card) && /by 2026-10-10/.test(card));

console.log('\n── wiring');
const app = read('docs/pro/daily-success/js/app.js');
ok('the day-page streak uses the new rule', /window\.NBDReview\.floorStreak\(pages, floors, p\.dk\)/.test(app) && /Missed yesterday\. Don't miss twice/.test(app));
ok('the widget streak (nbd_streak) uses the new rule', /window\.NBDReview\.floorStreak\(pages,floors,today\)\.count/.test(app));
const idx = read('docs/pro/daily-success/index.html');
const at = (s) => idx.indexOf(s);
ok('review-logic loads before app.js; review-ui after the food card; css linked',
  at('js/review-logic.js?v=1') > -1 && at('js/review-logic.js?v=1') < at('/js/app.js"') && at('js/review-ui.js?v=1') > at('js/food-log.js?v=1') && at('css/review.css?v=1') > -1);
ok('reviews ride the userSettings sync (survive sign-out)', /\{ key: 'nbd_ds_reviews',\s+field: 'dsReviews' \}/.test(read('docs/pro/daily-success/ds-firebase-sync.js')));
const ui = read('docs/pro/daily-success/js/review-ui.js');
ok('every typed value reaching the sheet is escaped', /value="' \+ esc\(saved\.scary/.test(ui) && />' \+ esc\(saved\.kept/.test(ui) && /esc\(r\.label\)/.test(ui) && /esc\(x\.last\.scary\)/.test(ui) && !/innerHTML\s*=\s*[^;]*\+\s*saved\.(kept|bailed|scary)\b/.test(ui));
ok('the calorie cut writes the Food card target and syncs it', /f\.targets = Object\.assign\(\{\}, f\.targets, \{ calories: x\.weight\.newCalories \}\)/.test(ui) && /dsSettingsChanged\(FOOD\)/.test(ui));
ok('no money is moved by the app — Jo ticks that he moved the miss tax', /I moved it to savings/.test(ui) && !/stripe|transfer\(|fetch\(/i.test(ui));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
