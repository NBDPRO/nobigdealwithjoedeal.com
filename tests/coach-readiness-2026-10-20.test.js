/**
 * tests/coach-readiness-2026-10-20.test.js
 *
 * Workout Coach one-tap readiness check-in (tracker ideas #6). Three taps at
 * the start of a session (sleep, soreness, energy). A rough day trims one set
 * from lifts with 3+ untouched working sets and holds the weight on any lift
 * that was about to go up; good days change nothing. One record per day,
 * skippable, never blocks starting, always shown and undoable.
 *
 * Run: node tests/coach-readiness-2026-10-20.test.js
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
function sess(date, split, exs) {
  return {
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, slot, sets]) => ({
      exId, name: (C.BY_ID[exId] || {}).name || exId, slot,
      sets: sets.map(([weight, reps, rpe]) => ({ weight, reps, rpe, done: true })),
    })),
  };
}
const benchDay = (date, w) => sess(date, 'push', [['bb_bench', 0, [[w, 8, 7], [w, 8, 7], [w, 8, 7], [w, 8, 7]]]]);
// Bench climbing 175 -> 180 -> 185 at 8 reps / RPE 7: today's target EARNS a bump to 190.
const HIST = [benchDay('2026-10-12', 175), benchDay('2026-10-14', 180), benchDay('2026-10-16', 185),
  sess('2026-10-18', 'legs', [['back_squat', 0, [[225, 5, 8]]]])];
const work = (x) => x.sets.filter((s) => !s.warm);

console.log('\n1. scoring');
{
  const r = (a, b, c) => C.readiness({ sleep: a, sore: b, energy: c });
  ok('1/1/1 = 3 -> low', r(1, 1, 1).total === 3 && r(1, 1, 1).level === 'low');
  ok('1/1/2 = 4 -> low (the cut-off)', r(1, 1, 2).level === 'low' && C.READY_LOW === 4);
  ok('2/2/1 = 5 -> ok', r(2, 2, 1).level === 'ok');
  ok('3/3/1 = 7 -> ok (one bad answer alone is not a rough day)', r(3, 3, 1).level === 'ok');
  ok('3/3/2 = 8 -> good', r(3, 3, 2).level === 'good' && C.READY_GOOD === 8);
  ok('two answers is not a check-in', r(3, 3, undefined).complete === false && r(3, 3, undefined).level === null);
  ok('junk answers are not a check-in', r(0, 5, 'x').complete === false && C.readiness(null).complete === false && C.readiness({}).complete === false);
}

console.log('\n2. applyReadiness (pure)');
{
  const built = C.buildSession('push', HIST, { today: TODAY, seed: 1, freshness: 'steady', warmups: true });
  const bench = built.exercises[0];
  ok('setup: bench earned a bump to 190 and has warm-ups', bench.exId === 'bb_bench' && bench.target.weight === 190 && bench.sets.some((s) => s.warm));
  const before = JSON.stringify(built.exercises);
  const r = C.applyReadiness(built.exercises, 'low', HIST, {});
  ok('the input was not mutated', JSON.stringify(built.exercises) === before);
  const x0 = r.exercises[0];
  ok('bench: weight held at last time (185), not 190', x0.target.weight === 185 && work(x0).every((s) => s.weight === 185) && /Hold 185 lb/.test(x0.target.note), x0.target.note);
  ok('bench: 4 working sets -> 3', work(x0).length === 3);
  ok('warm-ups kept (same count), still flagged, and under the held weight', x0.sets.filter((s) => s.warm).length === bench.sets.filter((s) => s.warm).length && x0.sets.filter((s) => s.warm).every((s) => s.warm === true && s.weight < 185));
  ok('lifts with 3 working sets lose one (3 -> 2)', r.exercises.slice(1, 5).every((x) => work(x).length === 2), r.exercises.map((x) => work(x).length).join(','));
  ok('a 2-set lift is left alone', work(r.exercises[5]).length === 2 && r.exercises[5].ready === undefined);
  ok('counts: 5 trimmed, 1 held', r.trimmed === 5 && r.held === 1 && r.changed === true);
  ok('every touched lift is marked so it cannot be adjusted twice', r.exercises.slice(0, 5).every((x) => x.ready));

  const again = C.applyReadiness(r.exercises, 'low', HIST, {});
  ok('idempotent: applying it again changes nothing', same(again.exercises, r.exercises) && again.changed === false);

  ok('ok level: no change at all', C.applyReadiness(built.exercises, 'ok', HIST, {}).changed === false && C.applyReadiness(built.exercises, 'ok', HIST, {}).exercises === built.exercises);
  ok('good level: no change, and it never adds load', C.applyReadiness(built.exercises, 'good', HIST, {}).exercises[0].target.weight === 190);

  // lifts already started are never touched
  const started = JSON.parse(JSON.stringify(built.exercises));
  started[1].sets[0].done = true;                       // a logged set
  started[2].sets[0].reps = '10';                       // reps typed
  const rs = C.applyReadiness(started, 'low', HIST, {});
  ok('a lift with a logged set is untouched', work(rs.exercises[1]).length === 3 && !rs.exercises[1].ready);
  ok('a lift with reps typed is untouched', work(rs.exercises[2]).length === 3 && !rs.exercises[2].ready);
  ok('the rest still trim', work(rs.exercises[3]).length === 2);

  // a weight Jo typed himself is not overwritten
  const typed = JSON.parse(JSON.stringify(built.exercises));
  typed[0].sets.filter((s) => !s.warm)[1].weight = 200;
  const rt = C.applyReadiness(typed, 'low', HIST, {});
  ok('a hand-typed weight is kept; untouched rows are held', work(rt.exercises[0]).some((s) => s.weight === 200) && work(rt.exercises[0]).some((s) => s.weight === 185));

  // control: a lift that is NOT about to go up is not "held"
  const flat = [benchDay('2026-10-12', 185), benchDay('2026-10-14', 185), benchDay('2026-10-16', 185)].map((s) => Object.assign({}, s));
  flat.forEach((s) => s.exercises[0].sets.forEach((st) => { st.reps = 6; st.rpe = 9; }));
  const b2 = C.buildSession('push', flat.concat([HIST[3]]), { today: TODAY, seed: 1, freshness: 'steady' });
  const r2 = C.applyReadiness(b2.exercises, 'low', flat, {});
  ok('control: when no bump was coming, nothing is held (weight unchanged, still trims)', r2.held === 0 && r2.exercises[0].target.weight === b2.exercises[0].target.weight && r2.exercises[0].ready.held === false);

  // undo
  const undone = C.undoReadiness(r.exercises, {});
  ok('undo puts back every exercise exactly', same(undone, built.exercises), 'diff');
  ok('undo with nothing adjusted is a no-op', same(C.undoReadiness(built.exercises, {}), built.exercises));
}

console.log('\n3. the real screen');
{
  const fresh = (extra) => {
    const h = makeHarness({ storage: Object.assign({ nbd_ds_workouts: HIST }, extra || {}), today: TODAY });
    h.click('set-freshness', { val: 'steady' });
    h.click('start');
    return h;
  };
  let h = fresh();
  ok('the card is there, with Skip', /class="wc-ready"/.test(h.html()) && /data-coach-action="ready-skip"/.test(h.html()));
  ok('no answers yet: bench is the full plan (190, 4 sets)', h.live().exercises[0].target.weight === 190 && work(h.live().exercises[0]).length === 4);

  // never blocks: log a set without answering
  const wi = h.live().exercises[0].sets.findIndex((s) => !s.warm);
  h.field('reps', 0, wi, '8'); h.click('done', { i: 0, s: wi });
  ok('NEVER BLOCKS: a set logs fine with the check-in unanswered', h.live().exercises[0].sets[wi].done === true);
  ok('once a set is logged the question stops being asked', !/class="wc-ready"/.test(h.html()));

  h = fresh();
  h.click('ready-set', { k: 'sleep', v: 1 }); h.click('ready-set', { k: 'sore', v: 1 });
  ok('two answers change nothing yet', work(h.live().exercises[0]).length === 4 && !h.store.has('nbd_ds_coach_ready'));
  h.click('ready-set', { k: 'energy', v: 1 });
  let live = h.live();
  ok('three answers (total 3): the plan is trimmed + held', work(live.exercises[0]).length === 3 && live.exercises[0].target.weight === 185 && work(live.exercises[1]).length === 2);
  ok('...and it SAYS so, with an Undo', /Readiness 3\/9 — rough day\. Dropped a set on 5 lifts and held the weight on 1/.test(h.html()) && /data-coach-action="ready-undo"/.test(h.html()), (h.html().match(/Readiness[^<]*/) || [''])[0]);
  ok('a toast tells him too', h.toasts.some((t) => /Rough day/.test(t)));
  let rec = JSON.parse(h.store.get('nbd_ds_coach_ready'));
  ok('one record for today, with the three answers', Object.keys(rec).length === 1 && same(rec[TODAY], { sleep: 1, sore: 1, energy: 1 }), JSON.stringify(rec));

  h.click('ready-undo');
  live = h.live();
  ok('Undo restores the full plan', work(live.exercises[0]).length === 4 && live.exercises[0].target.weight === 190 && work(live.exercises[0]).every((s) => s.weight === 190) && work(live.exercises[1]).length === 3);
  ok('...and says the plan was left alone', /plan left as it was/.test(h.html()));

  h.click('ready-reset');
  ok('Change brings the question back', /class="wc-ready"/.test(h.html()) && h.live().ready === null);
  h.click('ready-set', { k: 'sleep', v: 3 }); h.click('ready-set', { k: 'sore', v: 3 }); h.click('ready-set', { k: 'energy', v: 3 });
  live = h.live();
  ok('a great day (9/9) changes nothing', work(live.exercises[0]).length === 4 && live.exercises[0].target.weight === 190 && /Readiness 9\/9 — good to go/.test(h.html()));
  rec = JSON.parse(h.store.get('nbd_ds_coach_ready'));
  ok('still ONE record for today (replaced, not added)', Object.keys(rec).length === 1 && same(rec[TODAY], { sleep: 3, sore: 3, energy: 3 }));

  // other days survive, old ones are pruned
  const old = {};
  for (let d = 1; d <= 40; d++) old['2026-09-' + String(d).padStart(2, '0')] = { sleep: 2, sore: 2, energy: 2 };
  delete old['2026-09-31']; delete old['2026-09-32'];
  const prior = { '2026-10-19': { sleep: 2, sore: 2, energy: 2 } };
  const h2 = fresh({ nbd_ds_coach_ready: Object.assign({}, old, prior) });
  h2.click('ready-set', { k: 'sleep', v: 2 }); h2.click('ready-set', { k: 'sore', v: 2 }); h2.click('ready-set', { k: 'energy', v: 2 });
  const rec2 = JSON.parse(h2.store.get('nbd_ds_coach_ready'));
  ok('yesterday\'s record is kept next to today\'s', !!rec2['2026-10-19'] && !!rec2[TODAY]);
  ok('the log is pruned to the last 30 days', Object.keys(rec2).length === 30, Object.keys(rec2).length + ' kept');

  // skip
  const h3 = fresh();
  h3.click('ready-skip');
  ok('Skip hides the question and changes nothing', !/class="wc-ready"/.test(h3.html()) && work(h3.live().exercises[0]).length === 4 && !h3.store.has('nbd_ds_coach_ready'));

  // a second session the same day picks the record up without asking
  const h4 = fresh();
  h4.click('ready-set', { k: 'sleep', v: 1 }); h4.click('ready-set', { k: 'sore', v: 1 }); h4.click('ready-set', { k: 'energy', v: 1 });
  h4.click('discard'); h4.click('discard');
  ok('(discarded the first session)', h4.live() === null);
  h4.click('start');
  const l4 = h4.live();
  ok('new session, same day: already adjusted from today\'s record, no question', work(l4.exercises[0]).length === 3 && l4.exercises[0].target.weight === 185 && /Readiness 3\/9 — rough day/.test(h4.html()) && !/class="wc-ready"/.test(h4.html()));

  // re-roll and swap keep the rough-day plan
  const counts = () => h4.live().exercises.map((x) => work(x).length).join(',');
  h4.click('reroll');
  ok('Switch it up keeps the lighter plan (3,2,2,2,2,2)', counts() === '3,2,2,2,2,2', counts());
  h4.click('swap-to', { i: 0, ex: 'db_bench' });
  ok('swapping the first lift keeps it too', work(h4.live().exercises[0]).length === 3, counts());

  // finishing a lighter day saves exactly what was logged
  const h5 = fresh();
  h5.click('ready-set', { k: 'sleep', v: 1 }); h5.click('ready-set', { k: 'sore', v: 1 }); h5.click('ready-set', { k: 'energy', v: 1 });
  const w5 = h5.live().exercises[0].sets.findIndex((s) => !s.warm);
  h5.field('reps', 0, w5, '8'); h5.click('done', { i: 0, s: w5 }); h5.click('finish');
  const saved = h5.saved()[0];
  ok('the saved session holds the one logged set at the held weight', C.volume(saved).sets === 1 && saved.exercises[0].sets.find((s) => !s.warm).weight === 185 && saved.ready === undefined && saved.exercises[0].ready === undefined);
}

console.log('\n4. wiring');
{
  ok('the record is stored under its own local key', /nbd_ds_coach_ready/.test(UI));
  ok('answers cannot block: no handler gates start or done on live.ready', !/live\.ready[^;\n]*return;[^\n]*start/.test(UI) && !/case 'start'[\s\S]{0,120}ready/.test(UI));
  ok('labels are escaped', /esc\(o\)/.test(UI) && /esc\(msg\)/.test(UI));
  ok('no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
