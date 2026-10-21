/**
 * tests/coach-set-kinds-2026-10-21.test.js
 *
 * Set tags (Strong-style): tap a working set's number to mark it a drop set (D) or a set taken to failure (F). Stored on the
 * set, shown in the row and in history, and a drop set never earns a PR trophy. Pins the pure logic and drives the real screen.
 *
 * Run: node tests/coach-set-kinds-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8').replace(/\r\n/g, '\n');
const CSS = fs.readFileSync(path.join(DIR, '..', 'css', 'workout-coach.css'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

let _n = 0;
function bench(date, sets) {
  return {
    id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: ++_n,
    exercises: [{ exId: 'bb_bench', name: 'Bench', slot: 0, sets: sets.map(([weight, reps, kind]) => Object.assign({ weight, reps, rpe: 8, done: true }, kind ? { kind } : {})) }],
  };
}
const tick = (weight, reps, kind) => Object.assign({ weight, reps, done: true }, kind ? { kind } : {});

console.log('\n1. the cycle');
{
  ok('normal -> drop -> fail -> normal', C.nextSetKind('') === 'drop' && C.nextSetKind('drop') === 'fail' && C.nextSetKind('fail') === '');
  ok('a missing or unknown kind starts the cycle (never sticks)', C.nextSetKind(undefined) === 'drop' && C.nextSetKind('weird') === 'drop');
  ok('labels: D, F, nothing', C.setKindLabel('drop') === 'D' && C.setKindLabel('fail') === 'F' && C.setKindLabel('') === '' && C.setKindLabel(undefined) === '');
  ok('control: warm-ups are not in the cycle', C.SET_KINDS.indexOf('warm') === -1);
}

console.log('\n2. PRs: a drop set never earns one, a failure set still can');
{
  const prior = [bench('2026-10-10', [[135, 8]])];
  const ex = (sets) => ({ exId: 'bb_bench', sets });
  ok('live: a normal 185x5 beats the 1RM -> PR', !!C.livePR(ex([tick(185, 5)]), prior));
  ok('live: the same set marked drop -> no PR', C.livePR(ex([tick(185, 5, 'drop')]), prior) === null);
  ok('live: marked to failure -> still a PR', !!C.livePR(ex([tick(185, 5, 'fail')]), prior));
  const sess = (kind) => ({ exercises: [{ exId: 'bb_bench', name: 'Bench', sets: [tick(185, 5, kind)] }] });
  ok('summary: normal -> PR, drop -> none, fail -> PR', C.detectPRs(sess(''), prior).length === 1 && C.detectPRs(sess('drop'), prior).length === 0 && C.detectPRs(sess('fail'), prior).length === 1);
  ok('control: a drop set does not hide the real top set next to it', C.detectPRs({ exercises: [{ exId: 'bb_bench', name: 'Bench', sets: [tick(185, 5), tick(135, 12, 'drop')] }] }, prior).length === 1);
}

console.log('\n3. history shows the tag');
{
  const h = [bench('2026-10-15', [[135, 8], [115, 10, 'drop'], [95, 12, 'fail']])];
  const list = C.historyList(h, '2026-10-21');
  const sets = list && list[0] && list[0].exercises[0].sets;
  ok('history lists D and F after the set', !!sets && /135×8$/.test(sets[0]) && /115×10 D$/.test(sets[1]) && /95×12 F$/.test(sets[2]), JSON.stringify(sets));
}

console.log('\n4. the real screen');
{
  const hist = [bench('2026-10-10', [[135, 8], [135, 8]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist, nbd_ds_coach: { warmups: true } }, today: '2026-10-21' });
  h.click('set-freshness', { val: 'steady' });
  h.click('start');
  const lv = () => h.live().exercises[0].sets;
  const wi = lv().findIndex((s) => !s.warm);
  ok('every working set number is a button', /<button class="wc-n wc-kind"[^>]*data-coach-action="kind"/.test(h.html()));
  h.click('kind', { i: 0, s: wi });
  ok('first tap marks a drop set (D shown, stored, class on)', lv()[wi].kind === 'drop' && /k-drop[^>]*>1D</.test(h.html()), (h.html().match(/wc-kind[^>]*>[^<]*</g) || []).slice(0, 2).join('|'));
  h.click('kind', { i: 0, s: wi });
  ok('second tap: to failure (F)', lv()[wi].kind === 'fail' && /k-fail[^>]*>1F</.test(h.html()));
  h.click('kind', { i: 0, s: wi });
  ok('third tap clears it (no leftover key)', !('kind' in lv()[wi]) && !/k-drop|k-fail/.test(h.html()));
  // a repeated workout has weights, so warm-up rows exist: they stay plain text, not buttons
  const everySplit = Object.keys(C.SPLITS).map((k, i) => Object.assign(bench('2026-10-' + String(10 + i).padStart(2, '0'), [[135, 8], [145, 6]]), { split: k }));
  const w = makeHarness({ storage: { nbd_ds_workouts: everySplit, nbd_ds_coach: { warmups: true } }, today: '2026-10-21', fitness: true });
  w.click('repeat');
  const wj = w.live().exercises[0].sets.findIndex((s) => s.warm);
  ok('control: the repeated workout really has a warm-up set', wj > -1);
  ok('warm-up rows (W) are plain text, not buttons', /<span class="wc-n">W<\/span>/.test(w.html()) && !/wc-kind[^>]*>W</.test(w.html()));
  w.click('kind', { i: 0, s: wj });
  ok('tapping a warm-up does nothing', !('kind' in w.live().exercises[0].sets[wj]));
  ok('the aria-label says what it is and what a tap does', /aria-label="Set 1\. Tap to change the set type"/.test(h.html()));

  h.click('kind', { i: 0, s: wi });
  h.field('weight', 0, wi, '115'); h.field('reps', 0, wi, '10'); h.click('done', { i: 0, s: wi });
  h.click('finish');
  const saved = h.saved()[0];
  const set = saved.exercises[0].sets.find((s) => !s.warm);
  ok('finishing keeps the tag on the saved set', set && set.kind === 'drop', JSON.stringify(set));
  ok('control: an untagged set saves no kind key', (() => { const g = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-21' }); g.click('set-freshness', { val: 'steady' }); g.click('start'); const k = g.live().exercises[0].sets.findIndex((s) => !s.warm); g.field('reps', 0, k, '8'); g.click('done', { i: 0, s: k }); g.click('finish'); return !('kind' in g.saved()[0].exercises[0].sets.find((s) => !s.warm)); })());
  ok('wired through the delegated switch, no inline handler', /case 'kind': \{/.test(UI) && !/onclick=/.test(UI));
  ok('the number button is a 44px target with D / F colours', /button\.wc-kind \{[^}]*min-height: 44px/.test(CSS) && /k-drop/.test(CSS) && /k-fail/.test(CSS));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
