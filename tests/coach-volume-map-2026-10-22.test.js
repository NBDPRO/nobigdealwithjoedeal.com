/**
 * tests/coach-volume-map-2026-10-22.test.js
 *
 * Roadmap phase 3: the weekly volume map. Hard sets per muscle, this week against last week, with the 10-20 band. Pins the pure
 * logic (volumeMap) and the real screen (SVG bars, no inline style, nothing when there is no week to read).
 *
 * Run: node tests/coach-volume-map-2026-10-22.test.js
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
const TODAY = '2026-10-22';

let _n = 0;
function sess(date, exs, extra) {
  return Object.assign({
    id: 's' + (++_n), date, split: 'push', startedAt: 1, finishedAt: ++_n,
    exercises: exs.map(([exId, n, warm], i) => ({
      exId, name: exId, slot: i,
      sets: Array.from({ length: n }, () => Object.assign({ weight: 135, reps: 8, done: true }, warm ? { warm: true } : {})),
    })),
  }, extra || {});
}
const row = (v, m) => v.rows.find((r) => r.muscle === m);

console.log('\n1. volumeMap');
{
  const hist = [
    sess('2026-10-21', [['bb_bench', 12]]),                       // this week: chest 12
    sess('2026-10-17', [['bb_bench', 4], ['incline_db', 3]]),     // this week: chest +7 -> 19 (incl. incline)
    sess('2026-10-12', [['bb_bench', 5]]),                        // LAST week (age 10): chest 5
    sess('2026-10-01', [['bb_bench', 9]]),                        // two weeks+ ago: neither
  ];
  const v = C.volumeMap(hist, TODAY, {});
  const chestNow = row(v, 'chest').now;
  ok('this week counts the last 7 days only (age 0-6)', chestNow === 19, String(chestNow));
  ok('last week counts the 7 days before that, and nothing older', row(v, 'chest').prev === 5, String(row(v, 'chest').prev));
  ok('delta is now minus last week', row(v, 'chest').delta === 14);
  ok('19 sets is inside the 10-20 band', row(v, 'chest').status === 'in');
  ok('over the band reads over', C.volumeMap([sess('2026-10-21', [['bb_bench', 21]])], TODAY, {}).rows.find((r) => r.muscle === 'chest').status === 'over');
  ok('under the band but above zero reads under', C.volumeMap([sess('2026-10-21', [['bb_bench', 6]])], TODAY, {}).rows.find((r) => r.muscle === 'chest').status === 'under');
  ok('zero reads none', row(v, 'quads').status === 'none');
  ok('boundaries: exactly 10 and exactly 20 are in the band', ['10', '20'].every((n) => C.volumeMap([sess('2026-10-21', [['bb_bench', Number(n)]])], TODAY, {}).rows.find((r) => r.muscle === 'chest').status === 'in'));
  ok('totals and enough', v.nowTotal === 19 && v.prevTotal === 5 && v.enough === true);
  ok('warm-ups never count', row(C.volumeMap([sess('2026-10-21', [['bb_bench', 12, true], ['bb_bench', 6]])], TODAY, {}), 'chest').now === 6);
  ok('an unfinished session is not counted', C.volumeMap([sess('2026-10-21', [['bb_bench', 12]], { finishedAt: 0 })], TODAY, {}).nowTotal === 0);
  ok('a session dated AFTER today is in neither week', C.volumeMap([sess('2026-10-25', [['bb_bench', 12]])], TODAY, {}).nowTotal === 0);
  ok('crosses a month edge: Oct 1 is 7 days before Oct 8 (last week), not this week', (() => {
    const w = C.volumeMap([sess('2026-10-01', [['bb_bench', 8]])], '2026-10-08', {});
    return w.nowTotal === 0 && w.prevTotal === 8;
  })());
  ok('crosses a year edge', C.volumeMap([sess('2025-12-29', [['bb_bench', 8]])], '2026-01-03', {}).nowTotal === 8);
  ok('the band is exposed and is 10-20', C.VOLUME_BAND.min === 10 && C.VOLUME_BAND.max === 20);
  ok('nothing logged -> not enough, no crash', C.volumeMap([], TODAY, {}).enough === false && C.volumeMap(undefined, TODAY, {}).rows.length > 0);
  ok('a thin week (under 6 sets) is not enough to draw', C.volumeMap([sess('2026-10-21', [['bb_bench', 3]])], TODAY, {}).enough === false);
  const db = C.volumeMap(hist, TODAY, { equip: ['dumbbell'] });
  ok('with dumbbells only, triceps and calves have no lift and are left off the map; chest stays', !db.rows.some((r) => r.muscle === 'triceps' || r.muscle === 'calves') && db.rows.some((r) => r.muscle === 'chest'), db.rows.map((r) => r.muscle).join());
  ok('control: with everything, both are on the map', row(v, 'triceps') && row(v, 'calves'));
  const edge = C.volumeMap([sess('2026-10-16', [['bb_bench', 2]]), sess('2026-10-15', [['bb_bench', 3]]), sess('2026-10-09', [['bb_bench', 5]]), sess('2026-10-08', [['bb_bench', 7]])], TODAY, {});
  ok('window edges: age 6 is this week, age 7 is last week, age 13 is last week, age 14 is neither', row(edge, 'chest').now === 2 + 0 && edge.prevTotal === 3 + 5 && row(edge, 'chest').prev === 8, JSON.stringify([row(edge, 'chest').now, edge.prevTotal]));
  const noPress = C.volumeMap(hist, TODAY, { avoid: { exercises: C.EXERCISES.filter((e) => e.muscle === 'calves').map((e) => e.id) } });
  ok('control: avoiding every calf lift removes calves, chest stays', !noPress.rows.some((r) => r.muscle === 'calves') && noPress.rows.some((r) => r.muscle === 'chest'));
}

console.log('\n2. the real screen');
{
  const hist = [sess('2026-10-21', [['bb_bench', 12], ['pushdown', 3]]), sess('2026-10-14', [['bb_bench', 4]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: TODAY, fitness: true });
  const card = h.card();
  ok('the card shows the volume map under the balance strip', /class="wc-vol"/.test(card) && /Volume map, sets this week/.test(card));
  ok('one row per trainable muscle', (card.match(/class="wc-vol-row"/g) || []).length === C.MUSCLES.length, String((card.match(/class="wc-vol-row"/g) || []).length));
  ok('chest row: label, in-band colour class, and the number', /Chest<\/span><svg[^>]*>.*?wc-vol-fill in".*?<\/svg><span class="wc-vol-n">12</.test(card.replace(/\n/g, '')), (card.match(/Chest<\/span>.{0,400}/) || [''])[0]);
  ok('the screen reader label says the sets and the change vs last week', /aria-label="Chest 12 sets, \+8 vs last week"/.test(card), (card.match(/aria-label="Chest[^"]*"/) || [''])[0]);
  ok('the band and last-week tick are drawn', /wc-vol-band" x="/.test(card) && /wc-vol-prev" x="/.test(card));
  ok('no inline style anywhere in the map (strict CSP)', !/style=/.test(card.slice(card.indexOf('wc-vol'))));
  ok('a muscle with no sets reads none', /wc-vol-fill none" x="0" y="2" width="0"/.test(card));
  const quiet = makeHarness({ storage: { nbd_ds_workouts: [] }, today: TODAY, fitness: true }).card();
  ok('control: with no history there is no map', !/wc-vol/.test(quiet));
  const thin = makeHarness({ storage: { nbd_ds_workouts: [sess('2026-10-21', [['bb_bench', 3]])] }, today: TODAY, fitness: true }).card();
  ok('control: a thin week draws no map either', !/wc-vol/.test(thin));
  ok('the map is wired into balanceHtml and labels go through esc()', /\$\{volumeHtml\(\)\}/.test(UI) && /esc\(r\.label\)/.test(UI) && !/style="/.test(UI.slice(UI.indexOf('function volumeHtml'), UI.indexOf('function balanceHtml'))));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
