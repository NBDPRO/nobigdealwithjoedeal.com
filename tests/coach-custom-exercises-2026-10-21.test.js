/**
 * tests/coach-custom-exercises-2026-10-21.test.js
 *
 * "My exercises": lifts Jo adds himself (Hevy users' most-named gap). They live on this device, join the library (rotation,
 * swap list, targets, avoid list) and survive a reload. Pins the pure logic (normCustom / setCustomExercises) and drives the
 * real settings panel through the DOM stub.
 *
 * Run: node tests/coach-custom-exercises-2026-10-21.test.js
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
const BASE = C.EXERCISES.length;

console.log('\n1. normCustom');
{
  const n = C.normCustom([
    { name: '  Cable   fly ', pattern: 'chest_iso', equip: 'cable' },
    { name: 'Bad pattern', pattern: 'nope', equip: 'cable' },
    { name: 'Bad equip', pattern: 'chest_iso', equip: 'jetpack' },
    { name: '   ', pattern: 'chest_iso', equip: 'cable' },
    { name: 'cable fly', pattern: 'chest_iso', equip: 'cable' },
    null, 'x', 7,
    { name: 'Sled push', pattern: 'squat', equip: 'machine', compound: true, id: 'bb_bench' },
  ]);
  ok('keeps the good ones, trims and collapses the name', n.length === 2 && n[0].name === 'Cable fly', JSON.stringify(n));
  ok('ids are forced into the my_ namespace (a stored id can never overwrite a built-in lift)', n.every((c) => c.id.indexOf('my_') === 0) && n[1].id === 'my_sled_push', JSON.stringify(n.map((c) => c.id)));
  ok('bad pattern, bad equipment, blank name, duplicate name and junk entries are all dropped', n.length === 2);
  ok('compound flag is kept as a boolean', n[1].compound === true && n[0].compound === false);
  ok('non-array input is an empty list', C.normCustom(undefined).length === 0 && C.normCustom('x').length === 0 && C.normCustom({}).length === 0);
  ok('names are capped at 40 characters', C.normCustom([{ name: 'x'.repeat(80), pattern: 'chest_iso', equip: 'cable' }])[0].name.length === 40);
}

console.log('\n2. setCustomExercises joins the library');
{
  const list = [{ name: 'Cable fly', pattern: 'chest_iso', equip: 'cable' }];
  const clean = C.setCustomExercises(list);
  const e = C.BY_ID.my_cable_fly;
  ok('it is in BY_ID and EXERCISES with its muscle group', clean.length === 1 && !!e && e.custom === true && e.muscle === 'chest' && C.EXERCISES.length === BASE + 1);
  ok('replacing the list replaces (no stacking): same list twice -> still one', C.setCustomExercises(list).length === 1 && C.EXERCISES.length === BASE + 1);
  ok('the avoid list works on it (pattern and id)', C.isAvoided(e, { patterns: ['chest_iso'] }) && C.isAvoided(e, { exercises: ['my_cable_fly'] }));
  ok('a target can be built for it (no history yet)', !!C.targetFor('my_cable_fly', [8, 12], [], {}));
  const swaps = C.swapOptions('push', C.SPLITS.push.slots.findIndex((s) => s.pattern === 'chest_iso'), ['bb_bench'], [], { equip: ['cable'] });
  ok('it is offered in the swap list for its slot', swaps.some((x) => x.id === 'my_cable_fly'), JSON.stringify((swaps || []).map((x) => x.id)));
  C.setCustomExercises([]);
  ok('control: emptying the list removes it again, built-ins untouched', !C.BY_ID.my_cable_fly && C.EXERCISES.length === BASE && !!C.BY_ID.bb_bench);
}

console.log('\n3. the real settings panel');
{
  const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-21' });
  h.click('set-freshness', { val: 'steady' });
  h.click('start');
  h.click('settings');
  ok('the settings show My exercises with an add form', /My exercises/.test(h.html()) && /data-coach-action="custom-add"/.test(h.html()) && /None yet\./.test(h.html()));
  h.click('custom-add');
  ok('adding with no name says so and adds nothing', h.toasts.some((t) => /type a name/i.test(t)) && !h.store.get('nbd_ds_coach_custom'));
  h.field('cx', 0, 0, 'Cable fly', { k: 'name' });
  h.field('cx', 0, 0, 'chest_iso', { k: 'pattern' });
  h.field('cx', 0, 0, 'cable', { k: 'equip' });
  h.click('custom-add');
  const stored = JSON.parse(h.store.get('nbd_ds_coach_custom') || '[]');
  ok('it is saved on this device with the chosen movement and equipment', stored.length === 1 && stored[0].id === 'my_cable_fly' && stored[0].pattern === 'chest_iso' && stored[0].equip === 'cable', JSON.stringify(stored));
  ok('the list on screen shows it with a Remove button', /<b>Cable fly<\/b>/.test(h.html()) && /data-coach-action="custom-del" data-id="my_cable_fly"/.test(h.html()));
  ok('the name box is cleared for the next one', !/value="Cable fly"/.test(h.html()));
  h.field('cx', 0, 0, 'cable FLY', { k: 'name' });
  h.click('custom-add');
  ok('adding the same name again is refused and not stored twice', h.toasts.some((t) => /already have/i.test(t)) && JSON.parse(h.store.get('nbd_ds_coach_custom')).length === 1);

  const again = makeHarness({ storage: { nbd_ds_workouts: [], nbd_ds_coach_custom: stored }, today: '2026-10-21' });
  ok('after a reload the lift is back in the library (loaded on boot)', !!again.sandbox.NBDCoach.BY_ID.my_cable_fly && again.sandbox.NBDCoach.BY_ID.my_cable_fly.custom === true);
  ok('control: a fresh page with no saved list does not have it', !makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-21' }).sandbox.NBDCoach.BY_ID.my_cable_fly);
  again.click('set-freshness', { val: 'steady' }); again.click('start'); again.click('settings');
  ok('...and in the list', /<b>Cable fly<\/b>/.test(again.html()));
  again.click('custom-del', { id: 'my_cable_fly' });
  ok('Remove drops it from the list and from storage', !/<b>Cable fly<\/b>/.test(again.html()) && JSON.parse(again.store.get('nbd_ds_coach_custom')).length === 0);

  const junk = makeHarness({ storage: { nbd_ds_workouts: [], nbd_ds_coach_custom: [{ name: 'Bad', pattern: 'nope', equip: 'cable' }, 'x', null] }, today: '2026-10-21' });
  junk.click('set-freshness', { val: 'steady' });
  ok('control: a corrupted stored list is ignored, the coach still starts', (() => { junk.click('start'); return !!junk.live(); })());
  ok('handlers go through the delegated switch (no inline handler)', /case 'custom-add': addCustom\(\); return;/.test(UI) && /case 'custom-del':/.test(UI) && !/onclick=/.test(UI));
}
C.setCustomExercises([]);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
