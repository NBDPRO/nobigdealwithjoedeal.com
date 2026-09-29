/**
 * tests/workout-coach-2026-09-29.test.js
 *
 * The Workout Coach (tracker revamp Phase 1). Jo's ask: keep the training
 * varied (without a plan the same routines repeat) while tracking reps /
 * weight / intensity and showing what to beat. Pins the pure rules in
 * docs/pro/daily-success/js/workout-coach-logic.js.
 *
 * Run: node tests/workout-coach-2026-09-29.test.js
 */
'use strict';

const path = require('path');
const C = require(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js', 'workout-coach-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// A finished session helper: exs = [[exId, slot, [[weight, reps, rpe], ...]], ...]
let _n = 0;
function sess(date, split, exs) {
  return {
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, slot, sets]) => ({
      exId, name: (C.BY_ID[exId] || {}).name || exId, slot,
      sets: sets.map(([weight, reps, rpe]) => ({ weight, reps, rpe, done: true })),
    })),
  };
}

console.log('\n1. library + splits are sound');
{
  const ids = C.EXERCISES.map((e) => e.id);
  ok('exercise ids are unique', new Set(ids).size === ids.length);
  const pats = new Set(C.EXERCISES.map((e) => e.pattern));
  const missing = [];
  for (const [k, sp] of Object.entries(C.SPLITS)) sp.slots.forEach((sl, i) => [].concat(sl.pattern).forEach((p) => { if (!pats.has(p)) missing.push(k + '#' + i + ':' + p); }));
  ok('every slot pattern has exercises to fill it', missing.length === 0, missing.join(','));
  const thin = [...pats].filter((p) => C.EXERCISES.filter((e) => e.pattern === p).length < 3);
  ok('every pattern has at least 3 options (variety needs choices)', thin.length === 0, thin.join(','));
  ok('rotations only name real days', Object.values(C.ROTATIONS).flat().every((d) => C.SPLITS[d]));
}

console.log('\n2. e1RM + targets (double progression)');
{
  ok('Epley: 225×5 ≈ 262.5', C.e1rm(225, 5) === 262.5);
  ok('a single is the weight itself', C.e1rm(315, 1) === 315);
  ok('nothing lifted is 0', C.e1rm(0, 5) === 0 && C.e1rm(100, 0) === 0);

  const t0 = C.targetFor('bb_bench', [5, 8], []);
  ok('never done → no weight, find one at RPE 7', t0.weight === null && t0.reps === 5 && /RPE 7/.test(t0.note));

  const earned = [sess('2026-09-20', 'push', [['bb_bench', 0, [[185, 8, 8], [185, 8, 8], [185, 8, 8.5]]]])];
  const t1 = C.targetFor('bb_bench', [5, 8], earned);
  ok('hit the top of the range at a sane RPE → add weight, back to the bottom', t1.weight === 190 && t1.reps === 5 && /\+5 lb/.test(t1.note), JSON.stringify(t1));

  const ground = [sess('2026-09-20', 'push', [['bb_bench', 0, [[185, 8, 8], [185, 8, 10], [185, 8, 9]]]])];
  ok('a set at RPE 10 means hold even at the top of the range', C.targetFor('bb_bench', [5, 8], ground).weight === 185);

  const missed = [sess('2026-09-20', 'push', [['bb_bench', 0, [[205, 5, 9], [205, 4, 9], [205, 3, 9]]]])];
  const t2 = C.targetFor('bb_bench', [5, 8], missed);
  ok('under the bottom of the range → hold the weight', t2.weight === 205 && t2.reps === 5 && /Hold/.test(t2.note));

  const mid = [sess('2026-09-20', 'push', [['bb_bench', 0, [[185, 6, 8], [185, 6, 8], [185, 7, 8]]]])];
  const t3 = C.targetFor('bb_bench', [5, 8], mid);
  ok('in the range → same weight, one more rep than the best set', t3.weight === 185 && t3.reps === 8 && /Beat last time/.test(t3.note), JSON.stringify(t3));

  const partial = [sess('2026-09-20', 'push', [['bb_bench', 0, [[185, 8, 8], [185, 7, 9]]]])];
  const t5 = C.targetFor('bb_bench', [5, 8], partial);
  ok('best set at the top but not all of them → every set to the top, same weight (no "beat 185×8" when 185×8 was done)',
    t5.weight === 185 && t5.reps === 8 && /Every set to 8/.test(t5.note) && /185 × 8\/7/.test(t5.note), JSON.stringify(t5));

  const legs = [sess('2026-09-20', 'legs', [['back_squat', 0, [[275, 8, 8], [275, 8, 8], [275, 8, 8], [275, 8, 8]]]])];
  ok('squat jumps by its own increment (10 lb)', C.targetFor('back_squat', [5, 8], legs).weight === 285);

  const bw = [sess('2026-09-20', 'push', [['pushup', 0, [['', 20, 8], ['', 20, 8]]]])];
  const t4 = C.targetFor('pushup', [12, 20], bw);
  ok('bodyweight at the top → add reps, no weight invented', t4.weight === null && t4.reps === 21);

  const newest = [sess('2026-09-10', 'push', [['bb_bench', 0, [[135, 8, 7]]]]), sess('2026-09-20', 'push', [['bb_bench', 0, [[185, 6, 8]]]])];
  ok('the target reads the NEWEST session', C.targetFor('bb_bench', [5, 8], newest).weight === 185);
}

console.log('\n3. variety: least-recent wins, the anchor holds then rotates');
{
  const today = '2026-09-29';
  const s1 = C.buildSession('push', [], { today, seed: 7 });
  ok('a fresh push day fills all 6 slots', s1.exercises.length === 6);
  ok('a first-ever Push day opens on the staple (barbell bench), not a random pick',
    s1.exercises[0].exId === 'bb_bench' && C.buildSession('legs', [], { today, seed: 42 }).exercises[0].exId === 'back_squat');
  ok('...but "Switch it up" on a fresh history can change the main lift',
    [1, 2, 3, 4, 5, 6].some((sd) => C.buildSession('push', [], { today, seed: sd, reroll: true }).exercises[0].exId !== 'bb_bench'));
  ok('no exercise twice in one day', new Set(s1.exercises.map((e) => e.exId)).size === 6);
  ok('each slot is filled from its own pattern',
    s1.exercises.every((e) => [].concat(C.SPLITS.push.slots[e.slot].pattern).includes(C.BY_ID[e.exId].pattern)));

  // Did incline DB press 2 days ago, incline barbell 20 days ago, never the other two.
  const hist = [
    sess('2026-09-09', 'push', [['incline_bb', 1, [[135, 10, 8]]]]),
    sess('2026-09-27', 'push', [['incline_db', 1, [[60, 10, 8]]]]),
  ];
  const pick = C.buildSession('push', hist, { today, seed: 3 }).exercises.find((e) => e.slot === 1);
  ok('a slot picks something NOT done recently (never-done beats 2 days ago)', pick.exId !== 'incline_db' && pick.exId !== 'incline_bb', pick.exId);

  // Anchor: bench three push days running, hold = 3 (mixed) → rotate on the 4th.
  const two = [sess('2026-09-15', 'push', [['bb_bench', 0, [[185, 6, 8]]]]), sess('2026-09-22', 'push', [['bb_bench', 0, [[185, 7, 8]]]])];
  ok('the anchor lift is held while it is progressing (2 in a row, hold 3)',
    C.buildSession('push', two, { today, seed: 1 }).exercises[0].exId === 'bb_bench');
  const three = two.concat([sess('2026-09-26', 'push', [['bb_bench', 0, [[185, 8, 8]]]])]);
  ok('...and rotated after 3 in a row', C.buildSession('push', three, { today, seed: 1 }).exercises[0].exId !== 'bb_bench');
  ok('"fresh" rotates the anchor every session', C.buildSession('push', [two[1]], { today, seed: 1, freshness: 'fresh' }).exercises[0].exId !== 'bb_bench');
  ok('"Switch it up" (reroll) ignores the hold', C.buildSession('push', two, { today, seed: 1, reroll: true }).exercises[0].exId !== 'bb_bench');

  const a = C.buildSession('pull', [], { today, seed: 11 }).exercises.map((e) => e.exId).join();
  const b = C.buildSession('pull', [], { today, seed: 99 }).exercises.map((e) => e.exId).join();
  ok('a different seed gives a different day when nothing is on record', a !== b);
  ok('the same seed gives the same day (stable UI)', a === C.buildSession('pull', [], { today, seed: 11 }).exercises.map((e) => e.exId).join());

  const home = C.buildSession('legs', [], { today, seed: 5, equip: ['dumbbell', 'bodyweight'] });
  ok('equipment filter: a dumbbell-only day uses only dumbbells/bodyweight',
    home.exercises.every((e) => ['dumbbell', 'bodyweight'].includes(C.BY_ID[e.exId].equip)));

  const targeted = C.buildSession('push', [sess('2026-09-26', 'push', [['bb_bench', 0, [[185, 8, 8], [185, 8, 8], [185, 8, 8]]]])], { today, seed: 1 });
  ok('the planned sets are pre-filled with the target weight', targeted.exercises[0].sets.every((s) => s.weight === 190));
}

console.log('\n4. rotation, swaps, PRs, variety, page rows');
{
  ok('first ever session starts the rotation', C.nextSplit([], 'ppl') === 'push');
  ok('after push comes pull', C.nextSplit([sess('2026-09-28', 'push', [])], 'ppl') === 'pull');
  ok('after legs it wraps to push', C.nextSplit([sess('2026-09-27', 'pull', []), sess('2026-09-28', 'legs', [])], 'ppl') === 'push');
  ok('upper/lower alternates', C.nextSplit([sess('2026-09-28', 'upper', [])], 'ul') === 'lower');

  const swaps = C.swapOptions('push', 0, ['bb_bench'], [], { today: '2026-09-29' });
  ok('swap options stay in the slot\'s pattern and exclude what is on the card',
    swaps.length > 0 && swaps.every((e) => e.pattern === 'h_push' && e.id !== 'bb_bench'));

  const before = [sess('2026-09-20', 'push', [['bb_bench', 0, [[185, 8, 8]]]])];
  const now = sess('2026-09-29', 'push', [['bb_bench', 0, [[195, 7, 9]]], ['db_lateral', 3, [[25, 15, 8]]]]);
  const prs = C.detectPRs(now, before);
  ok('a better e1RM is a PR', prs.length === 1 && prs[0].exId === 'bb_bench' && prs[0].e1rm > prs[0].prev);
  ok('a first-ever exercise is not called a PR', !prs.some((p) => p.exId === 'db_lateral'));

  const rep = [
    sess('2026-09-20', 'push', [['bb_bench', 0, [[185, 8]]], ['ohp', 2, [[95, 8]]]]),
    sess('2026-09-27', 'push', [['bb_bench', 0, [[185, 8]]], ['ohp', 2, [[95, 8]]]]),
  ];
  const v = C.variety(rep, '2026-09-29', 28);
  ok('variety: the same 2 lifts twice = 50%', v.total === 4 && v.distinct === 2 && v.pct === 50);
  ok('variety ignores sessions older than the window', C.variety(rep, '2026-12-01', 28).total === 0);

  const rows = C.toPageRows(now);
  ok('finished session → rows for the day page\'s Exercise Log',
    rows.length === 2 && rows[0].name === 'Barbell Bench Press' && rows[0].sets === '1' && rows[0].weight === '195' && rows[0].notes === 'RPE 9');
  const vol = C.volume(now);
  ok('volume counts working sets and pounds moved', vol.sets === 2 && vol.lbs === 195 * 7 + 25 * 15);
  ok('compounds get a longer rest than isolation', C.restFor('bb_bench') > C.restFor('db_lateral'));
  ok('unfinished sets are ignored everywhere',
    C.volume({ exercises: [{ exId: 'bb_bench', sets: [{ weight: 500, reps: 5, done: false }] }] }).sets === 0);
}

console.log('\n5. syncing sessions');
{
  const a = { id: 'w1', date: '2026-09-28', mt: 100, notes: 'local' };
  const b = { id: 'w1', date: '2026-09-28', mt: 50, notes: 'cloud' };
  ok('a newer local session beats the older cloud copy', C.mergeSessions([a], [b])[0].notes === 'local');
  ok('a newer cloud session beats the older local copy', C.mergeSessions([b], [Object.assign({}, a, { notes: 'cloud2' })])[0].notes === 'cloud2');
  ok('a deleted copy on either side removes it',
    C.mergeSessions([a], [{ id: 'w1', deleted: true }]).length === 0 && C.mergeSessions([{ id: 'w1', deleted: true }], [b]).length === 0);
  const m = C.mergeSessions([{ id: 'x', date: '2026-09-01' }], [{ id: 'y', date: '2026-09-20' }]);
  ok('both sides\' sessions survive, newest first', m.map((s) => s.id).join() === 'y,x');
}

console.log('\n6. wiring');
{
  const fs = require('fs');
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  const html = read('docs/pro/daily-success/index.html');
  const ui = read('docs/pro/daily-success/js/workout-coach.js');
  const app = read('docs/pro/daily-success/js/app.js');
  const sync = read('docs/pro/daily-success/ds-firebase-sync.js');
  const rules = read('firestore.rules');
  const iApp = html.indexOf('js/app.js'), iLogic = html.indexOf('js/workout-coach-logic.js'), iUi = html.indexOf('js/workout-coach.js');
  ok('index.html loads app.js → coach logic → coach UI, plus the stylesheet', iApp > -1 && iApp < iLogic && iLogic < iUi && /css\/workout-coach\.css/.test(html));
  ok('no inline handlers in the coach UI (CSP)', !/\son[a-z]+=/i.test(ui.replace(/\/\/.*$/gm, '')));
  ok('every ${…} in the coach UI template text is escaped or a number/constant',
    !/\$\{(x\.name|o\.name|p\.name|r\.label|live\.label|x\.target\.note)\}/.test(ui));
  ok('Finish writes the day page\'s list itself (not the DOM table) and only on the same day',
    /onScreen\.dk !== session\.date\) return false/.test(ui) && /onScreen\.exercises = kept\.concat\(C\(\)\.toPageRows\(session\)\)/.test(ui));
  ok('renderPage does not let the stale ex-N-* copy overwrite a list with content',
    /!\(_exList&&el\.dataset\.k\.startsWith\('ex-'\)\)/.test(app));
  ok('sessions sync to users/{uid}/ds_workouts (rules allow-list names it)',
    /'ds_workouts'/.test(sync) && /syncWorkouts\(\)/.test(sync) && /'ds_pages', 'ds_workouts'/.test(rules));
  ok('coach settings ride the userSettings sync', /key: 'nbd_ds_coach',\s+field: 'dsCoach'/.test(sync));
  ok('the welcome screen no longer claims nothing is synced to a cloud',
    !/Nothing is sent to a server, synced to a cloud/.test(html) && /synced to your private NBD Pro account/.test(html));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
