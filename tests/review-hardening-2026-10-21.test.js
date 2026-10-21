/**
 * tests/review-hardening-2026-10-21.test.js
 *
 * Closes behaviour gaps the vacuous-test audit found in the 2026-10-21 tests: mutations of
 * real logic that left every existing check green. Each check here fails when that line is
 * broken. Logic only (no source-regex pins).
 *
 * Run: node tests/review-hardening-2026-10-21.test.js
 */
'use strict';

const path = require('path');
const J = path.join(__dirname, '..', 'docs', 'pro', 'js');
const D = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const FX = require(path.join(J, 'call-center-filters-logic.js'));
const C = require(path.join(D, 'workout-coach-logic.js'));
const L = require(path.join(D, 'day-layout-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('\n1. Call Center filters: validation and wording');
{
  ok('an unknown direction falls back to all (not an active filter)', FX.normalize({ dir: 'sideways' }).dir === FX.defaults().dir && !FX.isActive(FX.normalize({ dir: 'sideways' }), 'x'));
  ok('an unknown sort falls back to the default', FX.normalize({ sort: 'random' }).sort === FX.defaults().sort);
  ok('a valid direction and sort survive', FX.normalize({ dir: 'in', sort: 'old' }).dir === 'in' && FX.normalize({ dir: 'in', sort: 'old' }).sort === 'old');
  ok('describe: Yesterday', FX.describe({ range: 'yesterday' }, '2026-10-21')[0] === 'Yesterday');
  ok('describe: Last 24 hours / 7 / 30 days', FX.describe({ range: '24h' })[0] === 'Last 24 hours' && FX.describe({ range: '7d' })[0] === 'Last 7 days' && FX.describe({ range: '30d' })[0] === 'Last 30 days');
  ok('describe: direction words', FX.describe({ dir: 'in' }).indexOf('They called') > -1 && FX.describe({ dir: 'out' }).indexOf('You called') > -1);
  ok('describe: nothing active -> nothing', FX.describe(FX.defaults()).length === 0);
}

console.log('\n2. Coach PR selection');
{
  const hist = (sets) => [{ id: 'h', date: '2026-10-01', split: 'push', startedAt: 1, finishedAt: 2, exercises: [{ exId: 'bb_bench', name: 'Bench', slot: 0, sets: sets.map(([weight, reps]) => ({ weight, reps, done: true })) }] }];
  const prior = hist([[135, 10]]);
  const tick = (weight, reps, extra) => Object.assign({ weight, reps, done: true }, extra || {});
  const lp = C.livePR({ exId: 'bb_bench', sets: [tick(135, 14), tick(135, 20), tick(135, 16)] }, prior);
  ok('live: the rep-PR set with the MOST reps wins', !!lp && lp.kind === 'reps' && lp.reps === 20 && lp.index === 1, JSON.stringify(lp));
  ok('live: a set with no done flag earns nothing', C.livePR({ exId: 'bb_bench', sets: [{ weight: 135, reps: 20 }] }, prior) === null);
  const session = { exercises: [{ exId: 'bb_bench', name: 'Bench', sets: [tick(135, 14), tick(135, 20), tick(135, 16)] }] };
  const prs = C.detectPRs(session, prior);
  ok('summary: the rep-PR set with the MOST reps wins', prs.length === 1 && prs[0].kind === 'reps' && prs[0].reps === 20, JSON.stringify(prs));
  ok('summary: a first-ever lift claims no PR (nothing to beat)', C.detectPRs(session, []).length === 0);
  ok('summary: a first-ever heavy set claims no e1RM PR either', C.detectPRs({ exercises: [{ exId: 'bb_bench', name: 'Bench', sets: [tick(185, 5)] }] }, []).length === 0);
  ok('previous sets skip warm-ups wherever they sit', JSON.stringify(C.previousSets('bb_bench', hist([[135, 10]]).map((s) => { s.exercises[0].sets.splice(0, 0, { weight: 95, reps: 8, warm: true, done: true }); s.exercises[0].sets.push({ weight: 135, reps: 8, done: true }); return s; }))) === '[{"weight":135,"reps":10},{"weight":135,"reps":8}]');
}

console.log('\n3. Today bar');
{
  ok('floors percent rounds to nearest (2 of 3 = 67, not 66)', L.todaySummary({ hit: 2, total: 3 }).floorsPct === 67 && L.todaySummary({ hit: 1, total: 3 }).floorsPct === 33);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
