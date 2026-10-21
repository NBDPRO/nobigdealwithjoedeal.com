/**
 * tests/coach-recap-2026-10-21.test.js
 *
 * The workout finish screen's recap: total volume against the last finished session of the same split (up / down %), and each
 * lift's best set. Pins the pure logic (sessionRecap) and drives the real screen through the DOM stub.
 *
 * Run: node tests/coach-recap-2026-10-21.test.js
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

console.log('\n1. sessionRecap');
{
  const old = sess('2026-10-08', 'push', [['bb_bench', 0, [[100, 10], [100, 10]]]]);             // 2000 lb
  const last = sess('2026-10-14', 'push', [['bb_bench', 0, [[135, 8], [135, 8]]]]);               // 2160 lb
  const now = sess('2026-10-21', 'push', [['bb_bench', 0, [[95, 8, true], [135, 10], [135, 9]]]]);  // 2565 lb (warm-up excluded)
  const r = C.sessionRecap(now, [old, last]);
  ok('compares with the MOST RECENT finished session of the same split', !!r.vs && r.vs.date === '2026-10-14' && r.vs.prevLbs === 2160, JSON.stringify(r.vs));
  ok('percent is (now - last) / last, rounded: +19%', r.vs.pct === 19, String(r.vs && r.vs.pct));
  const down = C.sessionRecap(sess('2026-10-21', 'push', [['bb_bench', 0, [[135, 4]]]]), [last]);
  ok('a lighter day is a negative percent', down.vs.pct === -75, String(down.vs && down.vs.pct));
  ok('another split is not a comparison (legs vs push)', C.sessionRecap(sess('2026-10-21', 'legs', [['back_squat', 0, [[225, 5]]]]), [last]).vs === null);
  ok('no earlier session -> no vs line', C.sessionRecap(now, []).vs === null);
  ok('an unfinished earlier session is ignored', C.sessionRecap(now, [Object.assign({}, last, { finishedAt: 0 })]).vs === null);
  ok('the session being finished is never compared with itself', C.sessionRecap(now, [Object.assign({}, now)]).vs === null);
  ok('an earlier session with no volume (bodyweight only) cannot divide by zero', (() => { const z = sess('2026-10-14', 'pull', [['pullup', 0, [[0, 8]]]]); const x = C.sessionRecap(sess('2026-10-21', 'pull', [['pullup', 0, [[0, 9]]]]), [z]); return x.vs === null; })());

  ok('lifts: name, working-set count (warm-ups out), best set by weight x reps', r.lifts.length === 1 && r.lifts[0].sets === 2 && r.lifts[0].top === '135×10', JSON.stringify(r.lifts));
  const mixed = C.sessionRecap(sess('2026-10-21', 'push', [['bb_bench', 0, [[135, 5], [115, 12]]]]), []);
  ok('best set is by weight x reps, not heaviest (115x12 = 1380 > 135x5 = 675)', mixed.lifts[0].top === '115×12', JSON.stringify(mixed.lifts));
  const bw = C.sessionRecap(sess('2026-10-21', 'pull', [['pullup', 0, [[0, 8], [0, 11], [0, 9]]]]), []);
  ok('bodyweight lifts pick the most reps and read "11 reps"', bw.lifts[0].top === '11 reps', JSON.stringify(bw.lifts));
  ok('a lift with only warm-ups is left out', C.sessionRecap(sess('2026-10-21', 'push', [['bb_bench', 0, [[45, 8, true]]]]), []).lifts.length === 0);
  ok('control: empty / missing input does not throw', (() => { try { const e = C.sessionRecap(undefined, undefined); return e.vs === null && e.lifts.length === 0; } catch (_) { return false; } })());
}

console.log('\n2. the real screen');
{
  const everySplit = Object.keys(C.SPLITS).map((k, i) => sess('2026-10-' + String(10 + i).padStart(2, '0'), k, [['bb_bench', 0, [[100, 8], [100, 8]]]]));   // 1600 lb each
  const h = makeHarness({ storage: { nbd_ds_workouts: everySplit }, today: '2026-10-21', fitness: true });
  h.click('repeat');
  const live = h.live();
  const wi = live.exercises[0].sets.findIndex((s) => !s.warm);
  const wi2 = live.exercises[0].sets.findIndex((s, j) => !s.warm && j > wi);
  h.field('weight', 0, wi, '135'); h.field('reps', 0, wi, '10'); h.click('done', { i: 0, s: wi });
  h.field('weight', 0, wi2, '135'); h.field('reps', 0, wi2, '10'); h.click('done', { i: 0, s: wi2 });
  h.click('finish');
  const html = h.html();
  ok('the summary shows volume vs last time with an up arrow and the previous total', /class="wc-vs up">▲ \d+% volume vs [^<]*<small>\(1,600 lb\)/.test(html), (html.match(/wc-vs[^]{0,160}/) || [''])[0]);
  ok('...and one line per lift with its sets and best set', /class="wc-lifts"><div><span>[^<]+<\/span><b>2 sets · top 135×10<\/b>/.test(html), (html.match(/wc-lifts[^]{0,200}/) || [''])[0]);
  const dn = makeHarness({ storage: { nbd_ds_workouts: everySplit }, today: '2026-10-21', fitness: true });
  dn.click('repeat');
  const dj = dn.live().exercises[0].sets.findIndex((s) => !s.warm);
  dn.field('weight', 0, dj, '100'); dn.field('reps', 0, dj, '8'); dn.click('done', { i: 0, s: dj }); dn.click('finish');
  ok('a lighter day shows a down arrow in the down colour class (800 vs 1,600 lb = 50%)', /class="wc-vs down">▼ 50% volume vs/.test(dn.html()), (dn.html().match(/wc-vs[^]{0,60}/) || [''])[0]);

  const fresh = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-21' });
  fresh.click('set-freshness', { val: 'steady' }); fresh.click('start');
  const k = fresh.live().exercises[0].sets.findIndex((s) => !s.warm);
  fresh.field('weight', 0, k, '100'); fresh.field('reps', 0, k, '8'); fresh.click('done', { i: 0, s: k }); fresh.click('finish');
  ok('control: a first-ever workout has no vs line but still lists the lift', !/wc-vs/.test(fresh.html()) && /wc-lifts/.test(fresh.html()));
  ok('the rendering helper escapes names (no raw interpolation of stored text)', /esc\(l\.name\)/.test(UI) && /esc\(l\.top\)/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
