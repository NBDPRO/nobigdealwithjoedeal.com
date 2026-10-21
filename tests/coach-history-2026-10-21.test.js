/**
 * tests/coach-history-2026-10-21.test.js
 *
 * Workout Coach history screen: a newest-first list of finished workouts with sets / lb moved / minutes and a trophy for
 * the PRs each one set (compared only with the workouts BEFORE it), tap a row to see every working set. Pins the pure
 * list builder and drives the real screen file through the DOM stub.
 *
 * Run: node tests/coach-history-2026-10-21.test.js
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
const T0 = 1760000000000;
function sess(date, split, exs, extra) {
  const id = 's' + (++_n);
  return Object.assign({
    id, date, split, startedAt: T0 + _n * 1e6, finishedAt: T0 + _n * 1e6 + 52 * 60000,
    exercises: exs.map(([exId, slot, sets]) => ({ exId, name: (C.BY_ID[exId] || {}).name || exId, slot, sets: sets.map(([weight, reps, rpe, warm]) => Object.assign({ weight, reps, rpe, done: true }, warm ? { warm: true } : {})) })),
  }, extra || {});
}
const bench = (date, sets, extra) => sess(date, 'push', [['bb_bench', 0, sets]], extra);

console.log('\n1. historyList');
{
  const a = bench('2026-10-10', [[175, 5, 8], [175, 5, 8]]);
  const b = bench('2026-10-14', [[95, 8, 5, true], [185, 5, 8], [185, 5, 8], [190, 5, 9]]);
  const c = sess('2026-10-16', 'legs', [['back_squat', 0, [[225, 5, 8]]]]);
  const list = C.historyList([a, b, c]);
  ok('newest first, one row per finished workout', list.length === 3 && list[0].date === '2026-10-16' && list[2].date === '2026-10-10', list.map((h) => h.date).join(','));
  ok('totals count working sets only (warm-up excluded) and lb moved', list[1].sets === 3 && list[1].lbs === 185 * 5 + 185 * 5 + 190 * 5, JSON.stringify(list[1]));
  ok('label is the split name', list[0].label === C.SPLITS.legs.label && list[1].label === C.SPLITS.push.label);
  ok('minutes come from start/finish (52)', list[1].minutes === 52, String(list[1].minutes));
  ok('control: no real start time -> no minutes (not a bogus number)', C.historyList([bench('2026-10-20', [[100, 5, 8]], { startedAt: 1, finishedAt: 2 })])[0].minutes === null);
  ok('exercise sets are text, warm-ups left out', JSON.stringify(list[1].exercises) === JSON.stringify([{ exId: 'bb_bench', name: C.BY_ID.bb_bench.name, sets: ['185×5', '185×5', '190×5'] }]), JSON.stringify(list[1].exercises));
  ok('a PR is compared only with workouts BEFORE it (the 10-14 bench beat the 10-10 one)', list[1].prCount === 1 && list[1].prs[0].exId === 'bb_bench', JSON.stringify(list[1].prs));
  ok('...and the oldest workout has none (nothing earlier to beat), so an old PR stays an old PR', list[2].prCount === 0);
  ok('control: a later heavier workout does not erase the earlier PR', (function () { const d = bench('2026-10-18', [[205, 5, 8]]); const l = C.historyList([a, b, c, d]); return l.find((h) => h.date === '2026-10-14').prCount === 1 && l[0].prCount === 1; })());
  ok('unfinished and deleted workouts are not in history', C.historyList([a, Object.assign(bench('2026-10-20', [[200, 5, 8]]), { finishedAt: 0 }), Object.assign(bench('2026-10-21', [[200, 5, 8]]), { deleted: true })]).length === 1);
  ok('limit caps the list; empty/garbage input is an empty list', C.historyList([a, b, c], 2).length === 2 && C.historyList(null).length === 0 && C.historyList([]).length === 0);
  ok('a workout with no working sets still appears with zero sets (not dropped, no crash)', (function () { const e = sess('2026-10-22', 'push', [['bb_bench', 0, [[95, 8, 5, true]]]]); const l = C.historyList([e]); return l.length === 1 && l[0].sets === 0 && l[0].exercises.length === 0; })());
}

console.log('\n2. the real screen');
{
  const hist = [bench('2026-10-12', [[185, 5, 8], [185, 5, 8]]), bench('2026-10-16', [[190, 5, 8], [190, 5, 8]]), sess('2026-10-18', 'legs', [['back_squat', 0, [[225, 5, 8]]]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-20', fitness: true });
  ok('the dashboard card offers a History button once something is finished', /data-coach-action="hist-open">Workout history</.test(h.card()));
  ok('control: not before the first finished workout', !/hist-open/.test(makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-20', fitness: true }).card()));
  h.click('hist-open');
  const html = h.html();
  ok('the screen lists three workouts, newest first, with dates and labels', /Workout history/.test(html) && /3 workouts/.test(html) && html.indexOf('Oct 18') > -1 && html.indexOf('Oct 18') < html.indexOf('Oct 16') && html.indexOf('Oct 16') < html.indexOf('Oct 12') && /Legs/.test(html) && /Push/.test(html), (html.match(/wc-hist-main">[^]{0,60}/g) || []).join(' | '));
  ok('rows show sets, lb and minutes', /2 sets · 1,850 lb · 52 min/.test(html) && /1 set · 1,125 lb/.test(html) && !/1 sets/.test(html), (html.match(/wc-hist-sub">[^<]*/g) || []).join(' | '));
  ok('the bench that beat the earlier one has a trophy; the first one does not', (html.match(/wc-hist-pr/g) || []).length === 1);
  ok('rows are collapsed until tapped', !/wc-hist-detail/.test(html) && /aria-expanded="false"/.test(html));
  const firstId = hist[1].id;
  h.click('hist-toggle', { id: firstId });
  const open = h.html();
  ok('tapping a row shows its sets', /wc-hist-detail/.test(open) && /190×5, 190×5/.test(open) && /aria-expanded="true"/.test(open), (open.match(/wc-hist-ex[^]{0,120}/) || [''])[0]);
  ok('...and the PR it set', /est\. 1RM/.test(open) || /reps/.test(open));
  h.click('hist-toggle', { id: firstId });
  ok('tapping again collapses it', !/wc-hist-detail/.test(h.html()));
  h.click('hist-toggle', { id: firstId }); h.click('hist-toggle', { id: hist[0].id });
  ok('only one row is open at a time', (h.html().match(/wc-hist-detail/g) || []).length === 1);
  h.click('close'); h.click('open');
  ok('close leaves the history view: opening the logger afterwards does not show it (no live workout -> empty)', h.html() === '', h.html().slice(0, 80));
  h.click('hist-open');
  ok('reopening starts collapsed (no stale expanded row)', !/wc-hist-detail/.test(h.html()));
  h.click('close'); h.click('start');
  ok('after closing history, Start shows the workout logger, not the history screen', /class="wc-set/.test(h.html()) && !/Workout history/.test(h.html()), h.html().slice(0, 100));
  ok('...and it is a real live workout', !!h.live() && h.live().exercises.length > 0);
  const emptyH = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-20' });
  emptyH.click('hist-open');
  ok('an empty history says so', /No finished workouts yet/.test(emptyH.html()));
}

console.log('\n3. wiring');
{
  ok('history is read-only: nothing in it writes workouts', (function () { const blk = (UI.match(/function historyHtml\(\) \{[\s\S]*?\r?\n  \}\r?\n/) || [''])[0]; return blk.length > 100 && !/writeJson|saveSettings|localStorage/.test(blk); })());
  ok('rows are buttons with 44px minimum height', /\.wc-hist-row \{[^}]*min-height: 44px/.test(fs.readFileSync(path.join(DIR, '..', 'css', 'workout-coach.css'), 'utf8')));
  ok('no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
