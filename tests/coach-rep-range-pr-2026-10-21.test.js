/**
 * tests/coach-rep-range-pr-2026-10-21.test.js
 *
 * Workout Coach rep-range PR. Epley is too rough above ~12 reps, but Jo likes volume
 * days, so a high-rep set must not be dropped - it earns its own "Rep PR" (more reps than
 * ever at that weight or heavier) instead of a bogus estimated-1RM trophy. Pins the real
 * logic and drives the real screen through the DOM stub.
 *
 * Run: node tests/coach-rep-range-pr-2026-10-21.test.js
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

let _n = 0;
function sess(date, split, exs) {
  return {
    id: 's' + (++_n), date, split, startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, slot, sets]) => ({
      exId, name: (C.BY_ID[exId] || {}).name || exId, slot,
      sets: sets.map(([weight, reps]) => ({ weight, reps, rpe: 8, done: true })),
    })),
  };
}
const bench = (date, sets) => sess(date, 'push', [['bb_bench', 0, sets]]);
const tick = (weight, reps, extra) => Object.assign({ weight, reps, done: true }, extra || {});
const ex = (sets) => ({ exId: 'bb_bench', sets });

console.log('\n1. repPRCheck');
{
  const prior = [bench('2026-10-10', [[135, 15]]), bench('2026-10-14', [[135, 18]])];
  ok('more reps than ever at that weight is a rep PR', (C.repPRCheck('bb_bench', 135, 19, prior) || {}).prev === 18);
  ok('equal reps is NOT', C.repPRCheck('bb_bench', 135, 18, prior) === null);
  ok('fewer reps is NOT', C.repPRCheck('bb_bench', 135, 12, prior) === null);
  ok('the same weight within plate rounding counts (137.5)', !!C.repPRCheck('bb_bench', 137.5, 19, prior));
  ok('never trained at that weight -> not a record (lighter back-off set)', C.repPRCheck('bb_bench', 95, 25, prior) === null);
  const heavy = prior.concat([bench('2026-10-16', [[185, 20]])]);
  ok('a heavier set with as many reps dominates it', C.repPRCheck('bb_bench', 135, 19, heavy) === null);
  ok('...but beating the heavier set\'s reps is a record', !!C.repPRCheck('bb_bench', 135, 21, heavy));
  ok('no reps -> nothing', C.repPRCheck('bb_bench', 135, 0, prior) === null && C.repPRCheck('bb_bench', 135, '', prior) === null);
  ok('no history -> nothing', C.repPRCheck('bb_bench', 135, 20, []) === null);
  const warm = [Object.assign(bench('2026-10-10', [[135, 15]]), {})];
  warm[0].exercises[0].sets.push({ weight: 135, reps: 30, warm: true, done: true });
  ok('a warm-up never sets the record to beat', !!C.repPRCheck('bb_bench', 135, 16, warm));
  const bw = [sess('2026-10-10', 'pull', [['pullup', 0, [[0, 8]]]])];
  ok('bodyweight lifts work too (0 lb, more reps)', !!C.repPRCheck('pullup', 0, 9, bw) && C.repPRCheck('pullup', 0, 8, bw) === null);
}

console.log('\n2. livePR with both kinds');
{
  const prior = [bench('2026-10-10', [[135, 15]]), bench('2026-10-14', [[135, 18]])];   // best e1rm 135*(1+18/30)=216
  const r = C.livePR(ex([tick(135, 20)]), prior);
  ok('a 20-rep set earns a REP PR', r && r.kind === 'reps' && r.index === 0 && r.reps === 20 && r.prev === 18, JSON.stringify(r));
  ok('...and not a bogus estimated-1RM PR (20 reps is above the cap)', !(r && r.kind === 'e1rm'));
  ok('control: Epley alone WOULD have flagged it (225 > 216) - the cap is what changed', C.e1rm(135, 20) > C.bestE1rm('bb_bench', prior));
  const both = C.livePR(ex([tick(135, 20), tick(185, 5)]), prior);       // e1rm 215.8 < 216 -> no e1rm; rep PR stays
  ok('a heavy low-rep set below the old 1RM does not hide the rep PR', both && both.kind === 'reps' && both.index === 0, JSON.stringify(both));
  const strength = C.livePR(ex([tick(135, 20), tick(205, 5)]), prior);   // 205*(1+5/30)=239 > 216
  ok('a real strength PR wins the single trophy', strength && strength.kind === 'e1rm' && strength.index === 1, JSON.stringify(strength));
  ok('an unticked high-rep set earns nothing', C.livePR(ex([tick(135, 25, { done: false })]), prior) === null);
  ok('a warm-up earns nothing', C.livePR(ex([tick(135, 25, { warm: true })]), prior) === null);
  ok('equal to the old rep best earns nothing', C.livePR(ex([tick(135, 18)]), prior) === null);
  ok('the 12-rep cap is exported and is 12', C.HIGH_REP === 12);
  const e12 = C.livePR(ex([tick(190, 12)]), [bench('2026-10-14', [[185, 5]])]);
  ok('a 12-rep set still counts for estimated 1RM (cap is above 12)', e12 && e12.kind === 'e1rm');
  const e13 = C.livePR(ex([tick(190, 13)]), [bench('2026-10-14', [[185, 5]])]);
  ok('a 13-rep set does not (no matching weight history -> nothing)', e13 === null, JSON.stringify(e13));
}

console.log('\n3. the end-of-workout summary agrees');
{
  const prior = [bench('2026-10-10', [[135, 15]]), bench('2026-10-14', [[135, 18]])];
  const s = bench('2026-10-20', [[135, 20]]);
  const prs = C.detectPRs(s, prior);
  ok('summary reports the rep PR', prs.length === 1 && prs[0].kind === 'reps' && prs[0].reps === 20 && prs[0].weight === 135 && prs[0].prev === 18, JSON.stringify(prs));
  const s2 = bench('2026-10-20', [[205, 5], [135, 20]]);
  const p2 = C.detectPRs(s2, prior);
  ok('one entry per lift - strength wins', p2.length === 1 && p2[0].kind === 'e1rm' && Math.round(p2[0].e1rm) === 239, JSON.stringify(p2));
  ok('existing e1rm entries keep their shape (e1rm, prev, set)', p2[0].e1rm > 0 && p2[0].prev > 0 && !!p2[0].set);
  ok('no PR when nothing improved', C.detectPRs(bench('2026-10-20', [[135, 10]]), prior).length === 0);
}

console.log('\n4. the real screen');
{
  const hist = [bench('2026-10-12', [[135, 15], [135, 15]]), bench('2026-10-16', [[135, 18], [135, 16]]),
    sess('2026-10-18', 'legs', [['back_squat', 0, [[225, 5]]]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-20' });
  h.click('set-freshness', { val: 'steady' });
  h.click('start');
  const bi = h.live().exercises.findIndex((e) => e.exId === 'bb_bench');
  const wi = h.live().exercises[bi].sets.findIndex((s) => !s.warm);
  h.field('weight', bi, wi, '135'); h.field('reps', bi, wi, '20'); h.click('done', { i: bi, s: wi });
  ok('ticking a 20-rep set shows a Rep PR badge', /class="wc-pr"[^>]*>[^<]*Rep PR</.test(h.html()), (h.html().match(/wc-pr[^<]*</g) || []).join('|'));
  ok('its tooltip names the number to beat', /Most reps you have done at 135 lb or heavier \(was 18\)/.test(h.html()));
  h.field('reps', bi, wi, '5'); h.click('done', { i: bi, s: wi }); h.click('done', { i: bi, s: wi });
  ok('a 5-rep set at 135 is no PR (badge gone)', !/class="wc-pr"/.test(h.html()));
  h.field('reps', bi, wi, '20'); h.click('finish');
  const summary = h.html();
  ok('the summary lists the rep PR', /20 reps at 135 lb <small>\(was 18\)<\/small>/.test(summary), (summary.match(/wc-prs[\s\S]{0,200}/) || [''])[0]);
}

console.log('\n5. wiring');
{
  ok('no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
  ok('the screen reads kind to pick the badge and the summary line', (UI.match(/\.kind === 'reps'/g) || []).length >= 2);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
