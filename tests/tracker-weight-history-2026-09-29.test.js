/**
 * tests/tracker-weight-history-2026-09-29.test.js
 *
 * Tracker revamp Phase 3 + 4 (docs/pro/daily-success/js/tracker-history-logic.js):
 * the weight trend from the day pages' weight box, and importing old Exercise
 * Log rows into Workout Coach sessions. Synthetic data only.
 *
 * Run: node tests/tracker-weight-history-2026-09-29.test.js
 */
'use strict';

const path = require('path');
const H = require(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js', 'tracker-history-logic.js'));
const C = require(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js', 'workout-coach-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const dk = (d) => { const t = new Date(2026, 8, 29); t.setDate(t.getDate() - d); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };
const page = (d, extra) => Object.assign({ id: 1000 + d, dk: dk(d), data: {}, exercises: [] }, extra);

console.log('\n1. weight');
{
  const pages = [];
  for (let d = 40; d >= 0; d--) pages.push(page(d, { data: { 'bm-wt': String(220 - (40 - d) * 0.2) } }));
  pages.push(page(3, { data: { 'bm-wt': '2150' } }));   // a typo on a second page that day
  pages.push(page(5, { data: { 'bm-wt': '' } }));
  const s = H.weightSeries(pages);
  ok('one reading per day; typos (2150) and blanks are not weigh-ins', s.length === 41 && !s.some((x) => x.lbs > 700));
  const t = H.weightTrend(s, dk(0));
  ok('latest is today\'s reading', t.latest === 212 && t.latestDk === dk(0));
  ok('7-day average of the last week', t.avg7 === 212.6, 'avg7=' + t.avg7);
  ok('down ~1.4 lb vs the week before (0.2 lb/day)', t.change7 === -1.4, 'change7=' + t.change7);
  ok('down ~6 lb vs a month ago', t.change30 === -6, 'change30=' + t.change30);
  ok('the chart points carry their own 7-day average', t.points.length > 30 && t.points[t.points.length - 1].avg7 === t.avg7);
  ok('a sparkline is drawn from the averages', /<svg[^>]*class="wt-spark"/.test(H.sparkline(t.points)) && /polyline/.test(H.sparkline(t.points)));
  const one = H.weightTrend(H.weightSeries([page(0, { data: { 'bm-wt': '205 lbs' } })]), dk(0));
  ok('a single reading: latest + avg, no change yet (never a fake 0)', one.latest === 205 && one.avg7 === 205 && one.change7 === null && one.change30 === null);
  ok('no readings → empty trend', H.weightTrend([], dk(0)).latest === null && H.sparkline([]) === '');
}

console.log('\n2. matching what people type to the coach library');
{
  const lib = C.EXERCISES;
  const m = (n) => H.matchExercise(n, lib).exId;
  ok('"Bench" / "bench press" / "BB Bench" → barbell bench', m('Bench') === 'bb_bench' && m('bench press') === 'bb_bench' && m('BB Bench') === 'bb_bench');
  ok('"Squats" (plural) → back squat; "Deadlifts" → deadlift', m('Squats') === 'back_squat' && m('Deadlifts') === 'deadlift');
  ok('"Pull-ups" / "Pull Ups" → pull-ups', m('Pull-ups') === 'pullup' && m('Pull Ups') === 'pullup');
  ok('the library\'s own name matches exactly', m('Seated Cable Row') === 'cable_row');
  ok('word overlap: "incline dumbbell press" → incline dumbbell', m('incline dumbbell press') === 'incline_db');
  ok('an unknown exercise is not guessed', m('Sled push') === null && m('') === null);
  ok('"Press" alone is ambiguous → not guessed', m('Press') === null);
}

console.log('\n3. reps text');
{
  ok('"10" × 3 sets → [10,10,10]', H.parseReps('10', '3').join() === '10,10,10');
  ok('"10/8/6" → per set', H.parseReps('10/8/6', '3').join() === '10,8,6');
  ok('"3x10" → 3 sets of 10', H.parseReps('3x10', '').join() === '10,10,10');
  ok('"8-10" → the middle, per set', H.parseReps('8-10', '2').join() === '9,9');
  ok('junk → nothing', H.parseReps('heavy', '3').length === 0);
}

console.log('\n4. the import dry run');
{
  const pages = [
    page(10, { exercises: [{ name: 'Bench', sets: '3', reps: '8', weight: '185', notes: 'felt strong' }, { name: 'Sled push', sets: '2', reps: '40', weight: '' }, { name: '', sets: '', reps: '', weight: '' }] }),
    page(8, { exercises: [{ name: 'Squats', sets: '4', reps: '5', weight: '275 lbs' }, { name: 'Sled push', sets: '1', reps: '40', weight: '' }] }),
    page(5, { exercises: [] }),
    page(3, { exercises: [{ name: 'Curls', sets: '', reps: '', weight: '30' }] }),
  ];
  const plan = H.planImport(pages, [], C.EXERCISES, 1790000000000);
  ok('two days with real lifts become two sessions (empty day and a set-less row skipped)', plan.days === 2 && plan.sessions.length === 2, JSON.stringify({ d: plan.days }));
  const bench = plan.sessions.find((s) => s.date === dk(10)).exercises.find((e) => e.exId === 'bb_bench');
  ok('Bench → 3 sets of 8 at 185, library name, marked done', bench && bench.sets.length === 3 && bench.sets.every((st) => st.reps === 8 && st.weight === 185 && st.done) && bench.name === 'Barbell Bench Press');
  ok('the unmatched name is kept under its own name (history not lost)', plan.sessions[0].exercises.some((e) => e.exId === null && e.name === 'Sled push'));
  ok('the preview lists unmatched names with counts, most first', plan.unmatched.length === 1 && plan.unmatched[0].name === 'Sled push' && plan.unmatched[0].count === 2);
  ok('lift / matched counts for the preview', plan.lifts === 5 && plan.matched === 3, JSON.stringify({ l: plan.lifts, m: plan.matched }));
  ok('sessions are tagged imported and dated on their day', plan.sessions.every((s) => s.imported === true && s.split === 'imported' && s.finishedAt > 0));
  const again = H.planImport(pages, plan.sessions, C.EXERCISES, 1);
  ok('running it again imports nothing new', again.days === 0 && again.skipped === 2);
  // Imported history drives the coach.
  const t = C.targetFor('bb_bench', [5, 8], plan.sessions);
  ok('the coach now knows last time: 185 × 8 → "Earned it: +5 lb"', t.weight === 190 && /Earned it/.test(t.note), JSON.stringify(t));
  ok('...and next rotation still works with imported sessions around', ['push', 'pull', 'legs'].includes(C.nextSplit(plan.sessions, 'ppl')));
}

console.log('\n5. wiring');
{
  const fs = require('fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'index.html'), 'utf8');
  const at = (s) => html.indexOf(s);
  ok('logic + UI load after app.js and the coach (they wrap its functions)',
    at('js/app.js') > 0 && at('js/workout-coach.js') > at('js/app.js') &&
    at('js/tracker-history-logic.js') > at('js/workout-coach.js') && at('js/tracker-history-ui.js') > at('js/tracker-history-logic.js'));
  const ui = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js', 'tracker-history-ui.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('no inline handlers in the UI (CSP)', !/\son[a-z]+=/.test(ui));
  ok('unmatched names (free text) are escaped before innerHTML', /esc\(u\.name\)/.test(ui));
  ok('import never runs without the Import tap', /a === 'import-go'\) doImport/.test(ui) && !/doImport\(\)/.test(ui));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
