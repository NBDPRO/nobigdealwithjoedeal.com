/**
 * tests/coach-supersets-2026-10-20.test.js
 *
 * Workout Coach supersets (tracker ideas #10). "Pair with next lift" links two
 * exercises; the logger shows their sets as A1, B1, A2, B2 …, and the rest
 * timer runs once per pair (when both lifts' sets of the round are done), for
 * the longer of the two lifts' rests.
 *
 * The risky part is the plain logger: with nothing paired it must behave
 * exactly as before. tests/helpers/coach-golden-script.js drives a fixed
 * 27-step workout through the real screen and hashes every observable
 * non-markup result (live session after each tap, rest-timer text, toasts,
 * the saved session). That digest was recorded on the code BEFORE this change;
 * it is pinned below. The existing workout-coach / coach-* suites also run.
 *
 * Run: node tests/coach-supersets-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const golden = require('./helpers/coach-golden-script.js');
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Recorded from the plain logger before the superset code existed.
const GOLDEN_DIGEST = 'd663f225bf4888e3ff4b9fc35ddb609793c56412';

console.log('\n1. the plain logger is unchanged (nothing paired)');
{
  const a = golden.run();
  ok('27-step workout: every live state, rest text, toast and the saved session hash to the pre-change digest', a.digest === GOLDEN_DIGEST && a.steps === 27, a.digest);
  ok('control: pairing the first two lifts DOES change the digest (the check can fail)', golden.run({ pair: true }).digest !== GOLDEN_DIGEST);
  ok('the run is repeatable', golden.run().digest === a.digest);
}

// ── fixtures
const HIST = golden.HIST;
function fresh(opts) {
  const h = makeHarness(Object.assign({ storage: { nbd_ds_workouts: HIST }, today: '2026-10-20', freeze: true }, opts || {}));
  h.click('set-freshness', { val: 'steady' });
  h.click('set-warmups', { val: 'off' });         // keep the rows simple unless a test wants them
  h.click('start');
  return h;
}
const labels = (h) => { const m = h.html().match(/<div class="wc-ss-rows">([\s\S]*?)<div class="wc-ss-add">/); return m ? [...m[1].matchAll(/<(?:span|button) class="wc-n[^"]*"[^>]*>([^<]*)<\/(?:span|button)>/g)].map((x) => x[1]) : null; };
const restText = (h) => { const m = h.html().match(/<div class="wc-rest"[^>]*>([\s\S]*?)<\/div>/); return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : null; };
const tick = (h, i, s, reps) => { h.field('reps', i, s, reps || '8'); h.click('done', { i, s }); };

console.log('\n2. pairing');
{
  const h = fresh();
  ok('before pairing there is no superset block', !/class="wc-ss"/.test(h.html()));
  ok('every lift but the last offers "Pair with next lift"', (h.html().match(/Pair with next lift/g) || []).length === 5);
  h.click('pair-next', { i: 0 });
  let ex = h.live().exercises;
  ok('pairing sets the flag on the first lift only', ex[0].pair === true && !ex[1].pair);
  ok('the pair renders as one superset block with A and B heads', /class="wc-ss"/.test(h.html()) && /wc-ss-tag">A</.test(h.html()) && /wc-ss-tag">B</.test(h.html()) && (h.html().match(/class="wc-ss"/g) || []).length === 1);
  ok('the B lift offers no pair button of its own (it is the B)', (h.html().match(/Pair with next lift/g) || []).length === 3, String((h.html().match(/Pair with next lift/g) || []).length));
  h.click('pair-next', { i: 1 });
  ok('pairing the B lift is refused with a message', !h.live().exercises[1].pair && h.toasts.some((t) => /already the B/.test(t)));
  h.click('pair-next', { i: 0 });
  ok('Unpair removes it', !h.live().exercises[0].pair && !/class="wc-ss"/.test(h.html()));
  h.click('pair-next', { i: 1 });
  h.click('pair-next', { i: 0 });
  ok('pairing next to an existing pair is refused', !h.live().exercises[0].pair && h.live().exercises[1].pair === true && h.toasts.some((t) => /Unpair the next/.test(t)));
  h.click('pair-next', { i: 5 });
  ok('the last lift cannot be paired (nothing after it)', !h.live().exercises[5].pair);
  const h2 = fresh();
  h2.click('pair-next', { i: 0 });
  ok('it survives a reload (stored in the live session)', h2.live().exercises[0].pair === true);
}

console.log('\n3. the order of the rows: A1 B1 A2 B2 …');
{
  const h = fresh();
  h.click('pair-next', { i: 0 });
  const ex = h.live().exercises;
  const na = ex[0].sets.filter((s) => !s.warm).length, nb = ex[1].sets.filter((s) => !s.warm).length;
  ok('setup: bench 4 sets, second lift 3 sets', na === 4 && nb === 3, na + '/' + nb);
  ok('rows alternate, then the longer lift finishes alone', same(labels(h), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4']), JSON.stringify(labels(h)));
  h.click('add-set', { i: 1 });
  ok('+ set B adds a B round', same(labels(h), ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4', 'B4']));
  ok('the first undone row is marked as next', (h.html().match(/class="wc-set next"/g) || []).length === 1 && /class="wc-set next">\s*<(?:span|button) class="wc-n[^"]*"[^>]*>A1</.test(h.html()));
  h.click('done', { i: 0, s: 0 });
  ok('...and moves to B1 after A1', /class="wc-set next">\s*<(?:span|button) class="wc-n[^"]*"[^>]*>B1</.test(h.html()));
  ok('lifts outside the pair keep plain numbers', /<(?:span|button) class="wc-n[^"]*"[^>]*>1<\/(?:span|button)>/.test(h.html().split('wc-ss-add')[1] || ''));
  const w = fresh();
  w.click('set-warmups', { val: 'on' });
  w.click('discard'); w.click('discard'); w.click('start');
  w.click('pair-next', { i: 0 });
  const lab = labels(w);
  ok('warm-ups come first (W W W W), then the alternating rounds', lab.slice(0, 4).every((l) => l === 'W') && lab[4] === 'A1' && lab[5] === 'B1', JSON.stringify(lab));
  ok('screen-reader labels say which lift (A / B)', /aria-label="Weight, A set 1"/.test(h.html()) && /aria-label="Reps, B set 2"/.test(h.html()));
}

console.log('\n4. one rest per pair');
{
  const h = fresh();
  h.click('pair-next', { i: 0 });
  tick(h, 0, 0);
  ok('A1 done: NO rest yet', restText(h) === null);
  tick(h, 1, 0);
  ok('B1 done: one rest, the longer lift\'s (compound = 2:30), pointing at A2', /^Rest 2:30 next: Barbell Bench Press set 2/.test(restText(h) || ''), restText(h));
  h.click('skip-rest');
  tick(h, 0, 1);
  ok('A2 done: no rest', restText(h) === null);
  tick(h, 1, 1);
  ok('B2 done: rest, pointing at A3', /^Rest 2:30 next: Barbell Bench Press set 3/.test(restText(h) || ''), restText(h));
  h.click('skip-rest');

  // either order
  const r = fresh();
  r.click('pair-next', { i: 0 });
  tick(r, 1, 0);
  ok('B1 done first: no rest', restText(r) === null);
  tick(r, 0, 0);
  ok('...then A1 done: the pair\'s rest starts', /^Rest 2:30/.test(restText(r) || ''));

  // unticking does not start a rest
  const u = fresh();
  u.click('pair-next', { i: 0 });
  tick(u, 0, 0); u.click('done', { i: 0, s: 0 });
  ok('unticking A1 starts nothing', restText(u) === null);

  // a lopsided pair: A has a round with no B
  const l = fresh();
  l.click('pair-next', { i: 0 });
  for (let r2 = 0; r2 < 3; r2++) { tick(l, 0, r2); tick(l, 1, r2); l.click('skip-rest'); }
  tick(l, 0, 3);
  ok('A4 has no B to wait for: rest right away, then "next exercise"', /^Rest 2:30 next exercise/.test(restText(l) || ''), restText(l));

  // two isolation lifts rest 75 s
  const s = fresh();
  s.click('pair-next', { i: 4 });
  tick(s, 4, 0);
  ok('triceps A1: no rest', restText(s) === null);
  tick(s, 5, 0);
  ok('two non-compound lifts: the pair rests 1:15', /^Rest 1:15/.test(restText(s) || ''), restText(s));
  ok('control: an unpaired isolation set rests 1:15 right after itself', (() => { const q = fresh(); tick(q, 4, 0); return /^Rest 1:15/.test(restText(q) || ''); })());
  ok('control: an unpaired compound set rests 2:30 right after itself', (() => { const q = fresh(); tick(q, 0, 0); return /^Rest 2:30/.test(restText(q) || ''); })());

  // an isolation lift paired with a compound rests for the compound's time (the longer of the two)
  const m = fresh();
  m.click('swap-to', { i: 4, ex: 'cgbp' });
  m.click('pair-next', { i: 3 });
  tick(m, 3, 0); tick(m, 4, 0);
  ok('lateral raise (75 s) + close-grip bench (150 s): the pair rests 2:30', /^Rest 2:30/.test(restText(m) || ''), restText(m));

  // warm-ups inside a pair behave as always (60 s after each)
  const w = fresh();
  w.click('set-warmups', { val: 'on' });
  w.click('discard'); w.click('discard'); w.click('start');
  w.click('pair-next', { i: 0 });
  w.click('done', { i: 0, s: 0 });
  ok('a warm-up in a pair still rests 60 s on its own', /^Rest 1:00/.test(restText(w) || ''), restText(w));
}

console.log('\n5. saving + the rest of the logger');
{
  const run = (pair) => {
    const h = fresh();
    if (pair) h.click('pair-next', { i: 0 });
    tick(h, 0, 0, '8'); tick(h, 1, 0, '10'); tick(h, 0, 1, '7'); tick(h, 1, 1, '9');
    h.click('finish');
    return h.saved()[0];
  };
  const p = run(true), n = run(false);
  ok('a paired workout saves the same sets as the unpaired one', same(p.exercises.map((x) => x.sets), n.exercises.map((x) => x.sets)));
  ok('the A lift is marked pair:true, the B lift is not', p.exercises[0].pair === true && p.exercises[1].pair === undefined);
  ok('control: unpaired sessions carry no pair key anywhere', n.exercises.every((x) => !('pair' in x)));
  ok('volume and old-page rows are identical', same(C.volume(p), C.volume(n)) && same(C.toPageRows(p), C.toPageRows(n)));

  const lone = fresh();
  lone.click('pair-next', { i: 0 });
  tick(lone, 0, 0, '8');
  lone.click('finish');
  const sv = lone.saved()[0];
  ok('only A was logged: B is dropped and A is not marked as paired', sv.exercises.length === 1 && sv.exercises[0].pair === undefined);

  const rr = fresh();
  rr.click('pair-next', { i: 0 });
  rr.click('reroll');
  ok('Switch it up keeps the pairing on that slot', rr.live().exercises[0].pair === true && /class="wc-ss"/.test(rr.html()));
  const sw = fresh();
  sw.click('pair-next', { i: 0 });
  sw.click('swap-to', { i: 1, ex: C.swapOptions('push', 1, sw.live().exercises.map((e) => e.exId), HIST, { today: '2026-10-20' })[0].id });
  ok('swapping the B lift keeps the pair', sw.live().exercises[0].pair === true && /class="wc-ss"/.test(sw.html()));
  const sp = fresh();
  sp.click('pair-next', { i: 0 });
  sp.click('split', { split: 'pull' });
  ok('a new split starts unpaired', sp.live().split === 'pull' && !sp.live().exercises.some((x) => x.pair));
}

console.log('\n6. wiring');
{
  ok('no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
  ok('exercise names in the superset heads are escaped', /esc\(x\.name\)/.test(UI));
  ok('the rest rule is only entered for working sets of a pair', /const pr = st\.warm \? null : pairOf\(i\);/.test(UI));
  ok('the plain path keeps its original rest call', /startRest\(st\.warm \? 60 : C\(\)\.restFor\(x\.exId\), nextSet > -1/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
