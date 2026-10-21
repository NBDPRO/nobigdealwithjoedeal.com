/**
 * tests/coach-avoid-list-2026-10-20.test.js
 *
 * Workout Coach "avoid for now" list (tracker ideas #5). Jo marks a movement
 * pattern or a single exercise (sore shoulder, bad knee) and the coach must
 * never build it into a day or offer it as a swap. Pins the real logic in
 * docs/pro/daily-success/js/workout-coach-logic.js and checks the screen file
 * wires it through.
 *
 * Run: node tests/coach-avoid-list-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const UI = fs.readFileSync(path.join(DIR, 'workout-coach.js'), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const patOf = (id) => C.BY_ID[id].pattern;

console.log('\n1. normAvoid cleans whatever was synced');
{
  const n = C.normAvoid({ patterns: ['v_push', 'nonsense', 'v_push'], exercises: ['dips', 'ghost', 5] });
  ok('keeps real patterns, drops unknown + dupes', n.patterns.length === 1 && n.patterns[0] === 'v_push');
  ok('keeps real exercises, drops unknown', n.exercises.length === 1 && n.exercises[0] === 'dips');
  const e = C.normAvoid(undefined);
  ok('undefined -> empty lists', e.patterns.length === 0 && e.exercises.length === 0);
  const g = C.normAvoid({ patterns: 'v_push', exercises: { a: 1 } });
  ok('wrong types -> empty lists', g.patterns.length === 0 && g.exercises.length === 0);
}

console.log('\n2. candidatesFor honours the list');
{
  const slot = C.SPLITS.push.slots[2];            // v_push
  const base = C.candidatesFor(slot, {}).map((e) => e.id);
  ok('control: with no avoid list, overhead press is a candidate', base.includes('ohp'));
  const byPat = C.candidatesFor(slot, { avoid: { patterns: ['v_push'] } });
  ok('avoiding the pattern removes every candidate', byPat.length === 0);
  const byEx = C.candidatesFor(slot, { avoid: { exercises: ['ohp'] } }).map((e) => e.id);
  ok('avoiding one exercise removes only it', !byEx.includes('ohp') && byEx.includes('arnold'));
  const kept = C.candidatesFor(slot, { avoid: { patterns: ['v_push'] }, includeAvoided: true });
  ok('includeAvoided is the explicit override', kept.length === base.length);
}

console.log('\n3. buildSession never builds an avoided lift (any seed, with and without reroll)');
{
  const avoid = { patterns: ['v_push', 'squat'], exercises: ['dips', 'bb_bench'] };
  let leaked = 0, built = 0;
  for (const split of Object.keys(C.SPLITS)) {
    for (let seed = 1; seed <= 40; seed++) {
      for (const reroll of [false, true]) {
        const s = C.buildSession(split, [], { today: '2026-10-20', seed, reroll, avoid });
        for (const x of s.exercises) { built++; if (C.isAvoided(C.BY_ID[x.exId], avoid)) leaked++; }
      }
    }
  }
  ok('built plenty of exercises to check', built > 500, 'built ' + built);
  ok('no avoided pattern or exercise was ever built', leaked === 0, leaked + ' leaked');
  const ctrl = [];
  for (let seed = 1; seed <= 40; seed++) C.buildSession('push', [], { today: '2026-10-20', seed, reroll: true }).exercises.forEach((x) => ctrl.push(x.exId));
  ok('control: without the list the same builds DO include overhead lifts', ctrl.some((id) => patOf(id) === 'v_push'));
  const push = C.buildSession('push', [], { today: '2026-10-20', seed: 3, avoid: { patterns: ['v_push'] } });
  ok('an all-avoided slot is skipped, the rest of the day still builds', push.exercises.length === 5 && !push.exercises.some((x) => patOf(x.exId) === 'v_push'));
}

console.log('\n4. an anchor held from last time is dropped once avoided');
{
  const hist = [{ id: 'h1', date: '2026-10-18', split: 'push', startedAt: 1, finishedAt: 2,
    exercises: [{ exId: 'bb_bench', name: 'Barbell Bench Press', slot: 0, sets: [{ weight: 135, reps: 8, rpe: 8, done: true }] }] }];
  const held = C.buildSession('push', hist, { today: '2026-10-20', seed: 1 });
  ok('control: without the list the bench anchor is held', held.exercises[0].exId === 'bb_bench');
  const swapped = C.buildSession('push', hist, { today: '2026-10-20', seed: 1, avoid: { exercises: ['bb_bench'] } });
  ok('avoiding the bench replaces the held anchor', swapped.exercises[0].exId !== 'bb_bench' && patOf(swapped.exercises[0].exId) === 'h_push');
}

console.log('\n5. swapOptions + the explicit override');
{
  const avoid = { exercises: ['db_bench'], patterns: [] };
  const opts = C.swapOptions('push', 0, ['bb_bench'], [], { today: '2026-10-20', avoid, limit: 20 }).map((e) => e.id);
  ok('swap list omits the avoided exercise', !opts.includes('db_bench') && opts.includes('machine_chest'));
  const ctrl = C.swapOptions('push', 0, ['bb_bench'], [], { today: '2026-10-20', limit: 20 }).map((e) => e.id);
  ok('control: it is there without the list', ctrl.includes('db_bench'));
  const av = C.avoidedOptions('push', 0, ['bb_bench'], { avoid }).map((e) => e.id);
  ok('avoidedOptions lists exactly the avoided fits', av.length === 1 && av[0] === 'db_bench');
  ok('avoidedOptions is empty with no avoid list', C.avoidedOptions('push', 0, [], {}).length === 0);
  ok('equipment still applies to the override list', C.avoidedOptions('push', 0, [], { avoid, equip: ['barbell'] }).length === 0);
}

console.log('\n6. the screen wires it through');
{
  ok('settings() normalises the stored avoid object', /avoid:\s*C\(\)\.normAvoid\(s\.avoid\)/.test(UI));
  ok('new sessions are built with the avoid list', /avoid:\s*s\.avoid,\s*freshness/.test(UI));
  ok('swap panel passes the list to swapOptions', /swapOptions\(live\.split, x\.slot, ids, sessions\(\), \{[^}]*avoid:\s*so\.avoid/.test(UI));
  ok('using an avoided swap needs a second tap', /isAvoided\(ex, settings\(\)\.avoid\) && armed !== 'avoid:'/.test(UI));
  ok('settings chip row is saved through saveSettings', /toggle-avoid-pat[\s\S]{0,300}saveSettings\(s\)/.test(UI));
  ok('wording says "avoiding", not medical advice', /not medical advice/.test(UI) && /Avoiding for now/.test(UI));
  ok('no inline handlers', !/\son[a-z]+=/i.test(UI.replace(/data-coach-[a-z-]+=/g, '')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
