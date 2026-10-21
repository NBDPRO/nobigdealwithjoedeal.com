/**
 * tests/coach-balance-2026-10-20.test.js
 *
 * Workout Coach muscle/pattern balance nudge (tracker ideas #1). Hard sets per
 * muscle group over the last 7 days, flagged when a group is at zero or low,
 * plus a push:pull tilt, shown on the coach card; "Switch it up" leans toward
 * the groups that are behind. Pins the real logic and the real screen.
 *
 * Run: node tests/coach-balance-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const TODAY = '2026-10-20';

let _n = 0;
// exs: [exId, nSets] or [exId, nSets, {warm:true}] -> n identical 135 x 8 sets
function sess(date, split, exs) {
  return {
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, n, flag], i) => ({
      exId, name: (C.BY_ID[exId] || {}).name || exId, slot: i,
      sets: Array.from({ length: n }, () => Object.assign({ weight: 135, reps: 8, rpe: 8, done: true }, flag && flag.warm ? { warm: true } : {})),
    })),
  };
}

console.log('\n1. every exercise carries a primary-muscle tag');
{
  ok('every exercise has a known muscle', C.EXERCISES.every((e) => C.MUSCLES.includes(e.muscle)));
  ok('every muscle has a label and at least one exercise', C.MUSCLES.every((m) => C.MUSCLE_LABELS[m] && C.EXERCISES.some((e) => e.muscle === m)));
  const m = (id) => C.BY_ID[id].muscle;
  ok('spot checks', m('bb_bench') === 'chest' && m('ohp') === 'shoulders' && m('bb_row') === 'back' && m('pullup') === 'back' && m('rdl') === 'hams' && m('back_squat') === 'quads' && m('pushdown') === 'triceps' && m('hammer') === 'biceps' && m('calf_standing') === 'calves' && m('pallof') === 'core');
}

console.log('\n2. balance() counts hard sets in the last 7 days');
{
  const week = [
    sess('2026-10-19', 'push', [['bb_bench', 4], ['incline_db', 3], ['ohp', 3], ['pushdown', 3]]),
    sess('2026-10-14', 'pull', [['pullup', 4], ['bb_row', 3], ['hammer', 2]]),   // age 6: inside
  ];
  const b = C.balance(week, TODAY);
  ok('chest = 7, shoulders = 3, triceps = 3', b.byMuscle.chest === 7 && b.byMuscle.shoulders === 3 && b.byMuscle.triceps === 3, JSON.stringify(b.byMuscle));
  ok('back = 7, biceps = 2, legs = 0', b.byMuscle.back === 7 && b.byMuscle.biceps === 2 && b.byMuscle.quads === 0 && b.byMuscle.hams === 0);
  ok('total and session count', b.total === 22 && b.sessions === 2);
  const old = week.concat([sess('2026-10-13', 'legs', [['back_squat', 5]])]);       // age 7: outside
  ok('control: a session 7 days ago is outside the window', C.balance(old, TODAY).byMuscle.quads === 0);
  ok('control: ...but 6 days ago is inside', C.balance(week.concat([sess('2026-10-14', 'legs', [['back_squat', 5]])]), TODAY).byMuscle.quads === 5);
  ok('a future-dated session is ignored', C.balance(week.concat([sess('2026-10-25', 'legs', [['back_squat', 5]])]), TODAY).byMuscle.quads === 0);
  const unfinished = Object.assign(sess('2026-10-19', 'legs', [['back_squat', 5]]), { finishedAt: 0 });
  ok('an unfinished session is ignored', C.balance(week.concat([unfinished]), TODAY).byMuscle.quads === 0);
  ok('a deleted session is ignored', C.balance(week.concat([Object.assign(sess('2026-10-19', 'legs', [['back_squat', 5]]), { deleted: true })]), TODAY).byMuscle.quads === 0);

  const withWarm = [sess('2026-10-19', 'push', [['bb_bench', 4], ['bb_bench', 3, { warm: true }]])];
  ok('warm-ups are not hard sets', C.balance(withWarm, TODAY).byMuscle.chest === 4);
  const noFlag = [sess('2026-10-19', 'push', [['bb_bench', 4], ['bb_bench', 3]])];
  ok('control: the same sets unflagged would count', C.balance(noFlag, TODAY).byMuscle.chest === 7);
  const odd = sess('2026-10-19', 'push', [['not_a_lift', 5], ['bb_bench', 4]]);
  ok('an exercise the library does not know is skipped, not crashed on', C.balance([odd], TODAY).byMuscle.chest === 4);
}

console.log('\n3. zero / low, and the "nothing to read yet" guard');
{
  const pushOnly = [sess('2026-10-19', 'push', [['bb_bench', 4], ['incline_db', 3], ['pushdown', 3], ['db_lateral', 2]])];
  const b = C.balance(pushOnly, TODAY);
  ok('untouched groups are zero', ['back', 'biceps', 'quads', 'hams', 'calves', 'core'].every((m) => b.zero.includes(m)), JSON.stringify(b.zero));
  ok('2 sets of shoulders is low, 3 triceps is low', b.low.includes('shoulders') && b.low.includes('triceps'), JSON.stringify(b.low));
  ok('7 sets of chest is neither', !b.zero.includes('chest') && !b.low.includes('chest'));
  ok('neglected lists zero groups first, then low (fewest first)', b.neglected.slice(0, b.zero.length).every((m) => b.zero.includes(m)) && b.neglected.slice(-2)[0] === 'shoulders');
  const four = [sess('2026-10-19', 'push', [['bb_bench', 4], ['bb_row', 4], ['pushdown', 4]])];
  ok('boundary: exactly 4 sets is not low (LOW_SETS = ' + C.LOW_SETS + ')', C.LOW_SETS === 4 && !C.balance(four, TODAY).low.includes('chest'));
  const three = [sess('2026-10-19', 'push', [['bb_bench', 3], ['bb_row', 4], ['pushdown', 4]])];
  ok('control: 3 sets IS low', C.balance(three, TODAY).low.includes('chest'));

  const tiny = [sess('2026-10-19', 'push', [['bb_bench', 3], ['pushdown', 2]])];
  const t = C.balance(tiny, TODAY);
  ok('5 sets total: not enough to read, nothing flagged', t.enough === false && t.neglected.length === 0 && t.zero.length === 0 && t.tilt === null);
  const six = [sess('2026-10-19', 'push', [['bb_bench', 3], ['pushdown', 3]])];
  ok('control: 6 sets total is enough and flags', C.balance(six, TODAY).enough === true && C.balance(six, TODAY).neglected.length > 0);
  ok('no sessions this week: silent', C.balance([sess('2026-09-01', 'push', [['bb_bench', 9]])], TODAY).neglected.length === 0 && C.balance([], TODAY).enough === false);
}

console.log('\n4. push : pull');
{
  const tilt = (exs) => C.balance([sess('2026-10-19', 'x', exs)], TODAY).tilt;
  ok('14 push vs 6 pull -> push-heavy', tilt([['bb_bench', 6], ['ohp', 4], ['pushdown', 4], ['bb_row', 6]]) === 'push');
  ok('6 push vs 14 pull -> pull-heavy', tilt([['bb_bench', 6], ['bb_row', 6], ['pullup', 4], ['hammer', 4]]) === 'pull');
  ok('control: 8 vs 8 is even', tilt([['bb_bench', 4], ['pushdown', 4], ['bb_row', 4], ['hammer', 4]]) === null);
  ok('control: 9 vs 6 (1.5x) is not flagged', tilt([['bb_bench', 5], ['pushdown', 4], ['bb_row', 6]]) === null);
  ok('all push, no pull is flagged', tilt([['bb_bench', 6], ['ohp', 4]]) === 'push');
  const lat = C.balance([sess('2026-10-19', 'x', [['bb_bench', 3], ['bb_row', 3], ['db_lateral', 12]])], TODAY);
  ok('lateral raises are neutral (not counted either side)', lat.push === 3 && lat.pull === 3 && lat.tilt === null, JSON.stringify([lat.push, lat.pull, lat.tilt]));
  ok('legs are not in the ratio', C.balance([sess('2026-10-19', 'x', [['back_squat', 9], ['bb_bench', 3], ['bb_row', 3]])], TODAY).tilt === null);
  ok('under 6 push+pull sets: no verdict', tilt([['bb_bench', 3], ['back_squat', 9]]) === null);
}

console.log('\n5. groups Jo cannot train are never flagged');
{
  const week = [sess('2026-10-19', 'push', [['bb_bench', 4], ['incline_db', 3], ['pushdown', 3]])];
  ok('control: quads are flagged normally', C.balance(week, TODAY).zero.includes('quads'));
  const noQuads = C.balance(week, TODAY, { avoid: { patterns: ['squat', 'lunge', 'quad_iso'] } });
  ok('avoiding every quad pattern drops quads from the nudge', !noQuads.zero.includes('quads') && !noQuads.neglected.includes('quads'));
  ok('avoiding only one quad pattern does not', C.balance(week, TODAY, { avoid: { patterns: ['squat'] } }).zero.includes('quads'));
  const bar = C.balance(week, TODAY, { equip: ['barbell'] });
  ok('barbell-only: calves (all machines) are not flagged, quads still are', !bar.zero.includes('calves') && bar.zero.includes('quads'));
}

console.log('\n6. "Switch it up" leans toward the groups that are behind');
{
  const slot0 = (bias, seed) => C.buildSession('full', [], { today: TODAY, seed, reroll: true, bias }).exercises[0];
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
  ok('bias hams: the squat/hinge anchor is always a hinge', seeds.every((s) => C.BY_ID[slot0(['hams'], s).exId].pattern === 'hinge'));
  ok('bias quads: it is always a squat', seeds.every((s) => C.BY_ID[slot0(['quads'], s).exId].pattern === 'squat'));
  const free = new Set(seeds.map((s) => C.BY_ID[slot0(undefined, s).exId].pattern));
  ok('control: with no bias both patterns come up across seeds', free.has('squat') && free.has('hinge'));
  const plain = C.buildSession('full', [], { today: TODAY, seed: 4, reroll: true });
  ok('an empty bias changes nothing (same build, same order)', same(plain, C.buildSession('full', [], { today: TODAY, seed: 4, reroll: true, bias: [] })));
  ok('a bias that only matches single-muscle slots changes nothing (core)', same(plain, C.buildSession('full', [], { today: TODAY, seed: 4, reroll: true, bias: ['core'] })));
  ok('slots with one possible muscle are untouched by bias', same(
    C.buildSession('push', [], { today: TODAY, seed: 9, reroll: true }).exercises.map((x) => x.exId),
    C.buildSession('push', [], { today: TODAY, seed: 9, reroll: true, bias: ['calves'] }).exercises.map((x) => x.exId)));
  ok('splitsFor: hams are trained on legs / lower / full', ['legs', 'lower', 'full'].every((k) => C.splitsFor('hams').includes(k)) && !C.splitsFor('hams').includes('push'));
  ok('splitsFor: back is pull / upper / full', ['pull', 'upper', 'full'].every((k) => C.splitsFor('back').includes(k)));
}

console.log('\n7. the real screen');
{
  const hist = [sess('2026-10-19', 'push', [['bb_bench', 4], ['incline_db', 3], ['pushdown', 3], ['db_lateral', 2]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: TODAY, fitness: true });
  const card = h.card();
  ok('the coach card shows the 7-day strip', /class="wc-bal"/.test(card) && /Hard sets, last 7 days/.test(card));
  ok('chips carry the counts, zero ones flagged', /wc-bal-chip">Chest 7</.test(card) && /wc-bal-chip none">Back 0</.test(card) && /wc-bal-chip low">Shoulders 2</.test(card), card.slice(card.indexOf('wc-bal'), card.indexOf('wc-bal') + 400));
  ok('it says which day covers the gap', /Behind this week: [^<]*Back \(Pull day\)/.test(card), (card.match(/Behind this week[^<]*/) || [''])[0]);
  ok('push-heavy week gets the plain-English line', /Pushing 12 sets vs pulling 0/.test(card) || /Pushing \d+ sets vs pulling 0 — add some pulling/.test(card), (card.match(/Pushing[^<]*/) || [''])[0]);
  const quiet = makeHarness({ storage: { nbd_ds_workouts: [] }, today: TODAY, fitness: true }).card();
  ok('control: with no history the card has no balance strip at all', !/wc-bal/.test(quiet));
  ok('the original fitness section is still there after the card', /fit-orig/.test(card));

  h.click('start');
  ok('the logger says what is behind', /class="wc-hint wc-behind">Behind this week:/.test(h.html()));

  // reroll leans toward the neglected group
  const full = (storage) => { const x = makeHarness({ storage: { nbd_ds_workouts: storage }, today: TODAY }); x.click('set-rotation', { val: 'full' }); x.click('start'); return x; };
  const hamsGap = [sess('2026-10-19', 'full', [['bb_bench', 5], ['back_squat', 6], ['bb_row', 5], ['pushdown', 2]])];
  const a = full(hamsGap);
  const pats = [];
  for (let i = 0; i < 6; i++) { a.click('reroll'); pats.push(C.BY_ID[a.live().exercises[0].exId].pattern); }
  ok('quads done, hams at zero: six re-rolls all give a hinge anchor', pats.every((p) => p === 'hinge'), pats.join(','));
  const quadGap = [sess('2026-10-19', 'full', [['bb_bench', 5], ['rdl', 6], ['bb_row', 5], ['pushdown', 2]])];
  const b2 = full(quadGap);
  const pats2 = [];
  for (let i = 0; i < 6; i++) { b2.click('reroll'); pats2.push(C.BY_ID[b2.live().exercises[0].exId].pattern); }
  ok('control: hams done, quads at zero: six re-rolls all give a squat anchor', pats2.every((p) => p === 'squat'), pats2.join(','));
  ok('screen escapes label text', /esc\(C\(\)\.MUSCLE_LABELS\[m\]\)/.test(UI));
  ok('no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
