/**
 * tests/coach-repeat-last-2026-10-21.test.js
 *
 * Workout Coach "Repeat last <split>" (Strong's copy-last-workout loop): the same lifts, set count and per-set weights as the
 * last finished session of that split, reps blank so Previous shows what to beat. Pins the pure logic and drives the real
 * screen through the DOM stub.
 *
 * Run: node tests/coach-repeat-last-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

let _n = 0;
function sess(date, split, exs, extra) {
  return Object.assign({
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, slot, sets]) => ({
      exId, name: (C.BY_ID[exId] || {}).name || exId, slot,
      sets: sets.map(([weight, reps, warm]) => ({ weight, reps, rpe: 8, done: true, warm: !!warm })),
    })),
  }, extra || {});
}
const working = (ex) => ex.sets.filter((s) => !s.warm);

console.log('\n1. repeatSession');
{
  const none = C.repeatSession('push', [sess('2026-10-10', 'legs', [['back_squat', 0, [[225, 5]]]])], {});
  ok('a split that was never finished -> null (nothing to repeat)', none === null);
  ok('an unknown split -> null', C.repeatSession('nope', [], {}) === null);
  const unfinished = sess('2026-10-12', 'push', [['bb_bench', 0, [[135, 8]]]], { finishedAt: 0 });
  ok('an unfinished session is not "last time"', C.repeatSession('push', [unfinished], {}) === null);

  const older = sess('2026-10-08', 'push', [['bb_bench', 0, [[115, 10], [115, 9]]]]);
  const last = sess('2026-10-15', 'push', [['bb_bench', 0, [[95, 8, true], [135, 8], [145, 6], [145, 5]]]]);
  const r = C.repeatSession('push', [older, last], { warmups: false, today: '2026-10-21' });
  ok('it repeats the MOST RECENT finished session of the split', !!r && r.repeatOf === last.id && r.exercises.length === 1);
  const ex = r && r.exercises[0];
  ok('same lift and slot', !!ex && ex.exId === 'bb_bench' && ex.slot === 0);
  ok('three working sets, the per-set weights of last time (135, 145, 145)', !!ex && working(ex).length === 3 && working(ex).map((s) => s.weight).join() === '135,145,145', ex && JSON.stringify(ex.sets));
  ok('reps are blank and nothing is ticked (Previous shows what to beat)', !!ex && working(ex).every((s) => s.reps === '' && s.done === false));
  ok('stamped with the day and label', r.date === '2026-10-21' && r.split === 'push' && r.label === C.SPLITS.push.label);

  const rw = C.repeatSession('push', [last], { warmups: true, plates: {}, today: '2026-10-21' });
  const warm = rw.exercises[0].sets.filter((s) => s.warm);
  ok('with warm-ups on, they are regenerated ahead of the working sets for the first weight', warm.length > 0 && rw.exercises[0].sets.indexOf(warm[0]) === 0 && working(rw.exercises[0]).map((s) => s.weight).join() === '135,145,145', JSON.stringify(rw.exercises[0].sets.map((s) => (s.warm ? 'w' : '') + s.weight)));
  ok('control: warm-ups off -> none', rw && working(r.exercises[0]).length === r.exercises[0].sets.length);

  const avoided = C.repeatSession('push', [last], { avoid: { exercises: ['bb_bench'] }, today: '2026-10-21' });
  ok('a lift that is now on the avoid list is skipped (and with nothing left the answer is null)', avoided === null);
  const two = sess('2026-10-16', 'push', [['bb_bench', 0, [[135, 8]]], ['incline_db', 1, [[50, 10], [50, 9]]]]);
  const twoR = C.repeatSession('push', [two], { avoid: { exercises: ['bb_bench'] }, today: '2026-10-21' });
  ok('...but the other lifts stay', !!twoR && twoR.exercises.length === 1 && twoR.exercises[0].exId === 'incline_db', twoR && twoR.exercises.map((e) => e.exId).join());

  const bw = C.repeatSession('pull', [sess('2026-10-16', 'pull', [['pullup', 0, [[0, 8], [0, 7]]]])], { today: '2026-10-21' });
  ok('bodyweight sets keep weight 0 (not blank, not NaN)', !!bw && working(bw.exercises[0]).every((s) => s.weight === 0));
  ok('the source session is not mutated', last.exercises[0].sets.length === 4 && last.exercises[0].sets[1].reps === 8 && last.exercises[0].sets[1].done === true);
}

console.log('\n2. the real screen');
{
  // one finished session per split, so whichever split is next has something to repeat
  const hist = Object.keys(C.SPLITS).map((k, i) => sess('2026-10-' + String(10 + i).padStart(2, '0'), k, [['bb_bench', 0, [[135, 8], [145, 6]]]]));
  const next = C.nextSplit(hist, undefined);
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-21', fitness: true });
  const card = h.card();
  ok('the card offers "Repeat last <split>" next to Start', /data-coach-action="repeat">Repeat last /.test(card) && card.indexOf(C.SPLITS[next].label) > -1, (card.match(/data-coach-action="repeat"[^<]*/) || [''])[0]);
  h.click('repeat');
  const lv = h.live();
  ok('tapping it starts the workout from last time', !!lv && lv.split === next && lv.exercises.length >= 1 && !!lv.id && lv.startedAt > 0);
  const sets = lv && lv.exercises[0].sets.filter((s) => !s.warm);
  ok('...with last time\'s weights and blank reps', !!sets && sets.map((s) => s.weight).join().indexOf('135') === 0 && sets.every((s) => s.reps === ''), JSON.stringify(sets));
  ok('...and Previous shows what it was (135×8)', /135×8/.test(h.html()), (h.html().match(/wc-prev[^<]*<[^>]*>[^<]*/g) || []).slice(0, 2).join('|'));
  h.click('close');
  ok('with a workout in progress the card says Resume (no second repeat offered)', /Resume workout/.test(h.card()) && !/data-coach-action="repeat"/.test(h.card()));

  const g = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-21', fitness: true });
  g.click('start');
  const keep = g.live().id;
  g.click('close');
  g.click('repeat');
  ok('a stray Repeat tap while a workout is in progress resumes it - it never replaces the live session', g.live() && g.live().id === keep);

  // review fixes: a repeated lift has a real target (history never stores one), so a bare tick keeps the set
  const t = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-21', fitness: true });
  t.click('repeat');
  const tl = t.live();
  const wi = tl.exercises[0].sets.findIndex((s) => !s.warm);
  ok('every repeated lift carries a target with reps, weight and a note', tl.exercises.every((e) => e.target && e.target.reps && e.target.weight > 0 && /Repeat of/.test(e.target.note)), JSON.stringify(tl.exercises[0].target));
  t.click('done', { i: 0, s: wi });
  ok('ticking a set without typing reps fills the target reps (it used to store 0 and vanish from history)', String(t.live().exercises[0].sets[wi].reps) === String(tl.exercises[0].target.reps) && Number(t.live().exercises[0].sets[wi].reps) > 0, JSON.stringify(t.live().exercises[0].sets[wi]));
  t.click('finish');
  ok('...and that set is in the saved history', t.saved().some((s) => s.exercises.some((e) => e.sets.some((x) => x.done && Number(x.reps) > 0 && Number(x.weight) === Number(tl.exercises[0].sets[wi].weight)))));

  const eq = makeHarness({ storage: { nbd_ds_workouts: hist, nbd_ds_coach: { equip: ['dumbbell'] } }, today: '2026-10-21', fitness: true });
  ok('with only dumbbells, a barbell-only last workout offers nothing to repeat (no button)', !/data-coach-action="repeat"/.test(eq.card()));
  ok('...logic: equipment skips the lift and counts it', C.repeatSession(next, hist, { equip: ['dumbbell'] }) === null);
  const mixed = [sess('2026-10-16', 'push', [['bb_bench', 0, [[135, 8]]], ['incline_db', 1, [[50, 10]]]])];
  const mx = C.repeatSession('push', mixed, { equip: ['dumbbell'] });
  ok('a mixed day keeps the dumbbell lift, skips the barbell one and says how many', !!mx && mx.exercises.length === 1 && mx.exercises[0].exId === 'incline_db' && mx.skipped === 1, mx && JSON.stringify([mx.exercises.length, mx.skipped]));
  const av = C.repeatSession('push', mixed, { avoid: { exercises: ['bb_bench'] } });
  ok('an avoided lift counts as skipped too', !!av && av.skipped === 1);

  const rd = makeHarness({ storage: { nbd_ds_workouts: hist, nbd_ds_coach_ready: { '2026-10-21': { sleep: 2, sore: 2, energy: 2 } } }, today: '2026-10-21', fitness: true });
  rd.click('repeat');
  ok('today\'s saved readiness check-in is carried onto a repeated workout (no second prompt)', !!rd.live() && !!rd.live().ready && rd.live().ready.sleep === 2, JSON.stringify(rd.live() && rd.live().ready));

  const fresh = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-21', fitness: true });
  ok('control: with no history there is no Repeat button', !/data-coach-action="repeat"/.test(fresh.card()));
  fresh.click('repeat');
  ok('control: and tapping it anyway starts nothing and says why', fresh.live() === null && fresh.toasts.some((t) => /nothing to repeat/i.test(t)), fresh.toasts.join('|'));
  ok('the handler is wired through the delegated click switch (no inline handler)', /case 'repeat': repeatLast\(\); return;/.test(UI) && !/onclick=/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
