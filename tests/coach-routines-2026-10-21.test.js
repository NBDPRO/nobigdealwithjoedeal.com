/**
 * tests/coach-routines-2026-10-21.test.js
 *
 * Saved routines (the Strong / Hevy core loop): save a workout's lifts and set counts, start it later with today's targets.
 * Pins the pure logic (normRoutines, routineFromSession, nextRoutineName, buildFromRoutine) and drives the real screen.
 *
 * Run: node tests/coach-routines-2026-10-21.test.js
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
const R = (over) => Object.assign({ id: 'r1', name: 'Push A', split: 'push', lifts: [{ exId: 'bb_bench', name: 'Bench', slot: 0, sets: 3 }, { exId: 'incline_db', name: 'Incline', slot: 1, sets: 3 }] }, over || {});

console.log('\n1. normRoutines');
{
  const n = C.normRoutines([R(), R({ id: 'r1' }), R({ id: 'r2', name: '   ' }), R({ id: '', name: 'x' }), R({ id: 'r3', split: 'nope' }), R({ id: 'r4', lifts: [] }), R({ id: 'r5', lifts: [{ nope: 1 }, null] }), null, 'x', 5,
    R({ id: 'r6 !@#', name: '  Pull   B ' })]);
  ok('keeps the good ones, drops duplicates / blank names / missing ids / unknown splits / empty lifts / junk', n.length === 2 && n[0].id === 'r1' && n[1].id === 'r6', JSON.stringify(n.map((r) => r.id)));
  ok('ids are sanitised and names trimmed and collapsed', n[1].id === 'r6' && n[1].name === 'Pull B');
  ok('non-array input is an empty list', C.normRoutines(undefined).length === 0 && C.normRoutines({}).length === 0 && C.normRoutines('x').length === 0);
  ok('routine names are capped at exactly 40 characters', C.normRoutines([R({ name: 'x'.repeat(60) })])[0].name.length === 40 && C.normRoutines([R({ name: 'y'.repeat(40) })])[0].name.length === 40);
  ok('set counts: more than 10 keep 10 (it used to become 3), none/zero fall back to 3, others kept', C.normRoutines([R({ lifts: [{ exId: 'bb_bench', slot: 0, sets: 99 }, { exId: 'ohp', slot: 2, sets: 0 }, { exId: 'incline_db', slot: 1, sets: 4 }, { exId: 'ohp', slot: 2, sets: 12 }] })])[0].lifts.map((l) => l.sets).join() === '10,3,4,10');
  ok('capped at 30 routines and 20 lifts each', C.normRoutines(Array.from({ length: 40 }, (_, i) => R({ id: 'x' + i, name: 'n' + i }))).length === 30 && C.normRoutines([R({ lifts: Array.from({ length: 30 }, () => ({ exId: 'bb_bench', slot: 0, sets: 3 })) })])[0].lifts.length === 20);
}

console.log('\n2. routineFromSession / nextRoutineName');
{
  const s = sess('2026-10-15', 'push', [['bb_bench', 0, [[45, 8, true], [135, 8], [135, 8], [135, 7]]], ['ohp', 2, [[45, 10, true]]]]);
  const r = C.routineFromSession(s, 'Push A', 'abc');
  ok('lifts with their WORKING set counts (warm-ups out); a lift with only warm-ups is left out', !!r && r.lifts.length === 1 && r.lifts[0].exId === 'bb_bench' && r.lifts[0].sets === 3 && r.lifts[0].slot === 0, JSON.stringify(r));
  ok('it keeps the split, name and id and stores no weights or reps', r.split === 'push' && r.name === 'Push A' && r.id === 'abc' && !('weight' in r.lifts[0]) && !('reps' in r.lifts[0]));
  ok('nothing to save -> null', C.routineFromSession(sess('2026-10-15', 'push', [['bb_bench', 0, [[45, 8, true]]]]), 'x', 'id') === null && C.routineFromSession(undefined, 'x', 'id') === null);
  const label = C.SPLITS.push.label;
  ok('names run A, B, C...', C.nextRoutineName([], 'push') === label + ' A' && C.nextRoutineName([{ name: label + ' A' }], 'push') === label + ' B');
  ok('a deleted A is reused; the check is case-insensitive', C.nextRoutineName([{ name: label.toUpperCase() + ' b' }], 'push') === label + ' A');
}

console.log('\n3. buildFromRoutine');
{
  const hist = [sess('2026-10-10', 'push', [['bb_bench', 0, [[135, 8], [135, 8], [135, 8]]], ['incline_db', 1, [[50, 10], [50, 10], [50, 10]]]])];
  const b = C.buildFromRoutine(R(), hist, { today: '2026-10-21', warmups: false });
  ok('builds today\'s workout: label is the routine name, same lifts and set counts', !!b && b.label === 'Push A' && b.split === 'push' && b.date === '2026-10-21' && b.routineId === 'r1' && b.exercises.length === 2 && b.exercises[0].sets.length === 3, b && JSON.stringify(b.exercises.map((e) => e.sets.length)));
  ok('every lift has the coach\'s normal target (reps range, weight) and the working sets start at its weight', b.exercises.every((e) => e.target && e.target.weight > 0 && e.sets.every((st) => st.weight === e.target.weight && st.reps === '' && st.done === false)), JSON.stringify(b.exercises[0].target));
  ok('the rep range comes from the split slot', JSON.stringify(b.exercises[0].repRange) === JSON.stringify(C.SPLITS.push.slots[0].reps));
  const w = C.buildFromRoutine(R(), hist, { today: '2026-10-21', warmups: true, plates: {} });
  ok('with warm-ups on, the anchor lift gets them regenerated ahead of the working sets', w.exercises[0].sets.some((st) => st.warm) && w.exercises[0].sets.filter((st) => !st.warm).length === 3);
  const sk = C.buildFromRoutine(R({ lifts: R().lifts.concat([{ exId: 'does_not_exist', name: 'Gone', slot: 3, sets: 3 }]) }), hist, { today: '2026-10-21', avoid: { exercises: ['incline_db'] } });
  ok('unknown and avoided lifts are skipped and counted', sk.exercises.length === 1 && sk.skipped === 2, JSON.stringify([sk.exercises.length, sk.skipped]));
  const eq = C.buildFromRoutine(R(), hist, { today: '2026-10-21', equip: ['dumbbell'] });
  ok('equipment Jo does not have is skipped (barbell bench out, dumbbell incline stays)', eq.exercises.length === 1 && eq.exercises[0].exId === 'incline_db' && eq.skipped === 1);
  ok('nothing usable left -> null; unknown split -> null; missing routine -> null', C.buildFromRoutine(R(), hist, { avoid: { patterns: ['h_push', 'incline_push'] } }) === null && C.buildFromRoutine(R({ split: 'nope' }), hist, {}) === null && C.buildFromRoutine(undefined, hist, {}) === null);
  ok('with no history it still builds (no weights yet), not a crash', (() => { const x = C.buildFromRoutine(R(), [], { today: '2026-10-21' }); return !!x && x.exercises.length === 2; })());
}

console.log('\n4. the real screen');
{
  const hist = [sess('2026-10-10', 'push', [['bb_bench', 0, [[135, 8], [135, 8], [135, 8]]], ['incline_db', 1, [[50, 10], [50, 10], [50, 10]]]])];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-21', fitness: true });
  ok('no routines yet: the card has no routine buttons', !/data-coach-action="routine-start"/.test(h.card()));
  h.click('set-freshness', { val: 'steady' }); h.click('start');
  ok('an open workout offers Save as routine', /data-coach-action="routine-save"/.test(h.html()));
  h.click('routine-save');
  const saved = JSON.parse(h.store.get('nbd_ds_coach_routines') || '[]');
  ok('saving stores the lifts and set counts under the next free name', saved.length === 1 && /day [A-Z]$|[A-Z]$/.test(saved[0].name) && saved[0].lifts.length >= 1 && saved[0].lifts.every((l) => l.sets >= 1), JSON.stringify(saved));
  ok('...and says so', h.toasts.some((t) => /Saved as/.test(t)));
  h.click('settings');
  ok('the settings list it with a rename box and Remove', /data-coach-field="rt-name" data-id="/.test(h.html()) && /data-coach-action="routine-del"/.test(h.html()));
  h.field('rt-name', 0, 0, '  My   Push  ', { id: saved[0].id });
  ok('typing a new name renames it (trimmed), without re-rendering', JSON.parse(h.store.get('nbd_ds_coach_routines'))[0].name === 'My Push');
  h.field('rt-name', 0, 0, '   ', { id: saved[0].id });
  ok('a blank name is ignored (the old name stays)', JSON.parse(h.store.get('nbd_ds_coach_routines'))[0].name === 'My Push');
  h.click('discard'); h.click('discard');

  const g = makeHarness({ storage: { nbd_ds_workouts: hist, nbd_ds_coach_routines: [R({ id: 'rx' })] }, today: '2026-10-21', fitness: true });
  ok('with a routine saved, the card lists it under Start', /data-coach-action="routine-start" data-id="rx">▶ Push A/.test(g.card()), (g.card().match(/wc-routine[^<]*/) || [''])[0]);
  g.click('routine-start', { id: 'rx' });
  const lv = g.live();
  ok('tapping it starts a workout named after the routine, with its lifts', !!lv && lv.label === 'Push A' && lv.routineId === 'rx' && lv.exercises.length === 2 && !!lv.id && lv.startedAt > 0);
  ok('while it is in progress the card says Resume and offers no routine buttons', /Resume workout/.test(g.card()) && !/data-coach-action="routine-start"/.test(g.card()));
  const keep = lv.id;
  g.click('close'); g.click('routine-start', { id: 'rx' });
  ok('a second tap while a workout is open resumes it (never replaces it)', g.live().id === keep);
  g.click('discard'); g.click('discard');
  g.click('routine-del', { id: 'rx' });
  ok('Remove deletes it from storage', JSON.parse(g.store.get('nbd_ds_coach_routines')).length === 0);

  const bad = makeHarness({ storage: { nbd_ds_workouts: hist, nbd_ds_coach_routines: [{ junk: true }, 'x', null, R({ id: 'ok' })] }, today: '2026-10-21', fitness: true });
  ok('control: a corrupted stored list keeps only the valid routine', (bad.card().match(/routine-start/g) || []).length === 1);
  const blocked = makeHarness({ storage: { nbd_ds_workouts: hist, nbd_ds_coach_routines: [R({ id: 'rb', lifts: [{ exId: 'bb_bench', name: 'Bench', slot: 0, sets: 3 }] })], nbd_ds_coach: { avoid: { exercises: ['bb_bench'] } } }, today: '2026-10-21', fitness: true });
  blocked.click('routine-start', { id: 'rb' });
  ok('control: a routine whose every lift is now avoided starts nothing and says why', blocked.live() === null && blocked.toasts.some((t) => /Nothing left/i.test(t)), blocked.toasts.join('|'));
  // review fixes: the 31st routine is refused out loud, a failed write is reported and rolled back, another tab's changes are not overwritten
  const many = Array.from({ length: 30 }, (_, i) => R({ id: 'm' + i, name: 'Routine ' + i }));
  const full = makeHarness({ storage: { nbd_ds_workouts: hist, nbd_ds_coach_routines: many }, today: '2026-10-21', fitness: true });
  full.click('set-freshness', { val: 'steady' }); full.click('start'); full.click('routine-save');
  ok('the 31st routine is refused with a message (it used to say "Saved" and drop it)', full.toasts.some((t) => /plenty of routines/i.test(t)) && !full.toasts.some((t) => /^Saved as/.test(t)) && JSON.parse(full.store.get('nbd_ds_coach_routines')).length === 30);

  const fl = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-21', fitness: true });
  fl.click('set-freshness', { val: 'steady' }); fl.click('start');
  const realSet = fl.sandbox.localStorage.setItem;
  fl.sandbox.localStorage.setItem = (k, v) => { if (k === 'nbd_ds_coach_routines') throw new Error('QuotaExceededError'); return realSet(k, v); };
  fl.click('routine-save');
  ok('a failed write says so and does not claim "Saved"', fl.toasts.some((t) => /Couldn't save that/.test(t)) && !fl.toasts.some((t) => /^Saved as/.test(t)));
  fl.sandbox.localStorage.setItem = realSet;
  fl.click('routine-save');
  ok('control: once storage works again the same tap saves it (the failed attempt left nothing behind)', JSON.parse(fl.store.get('nbd_ds_coach_routines') || '[]').length === 1);

  const tab = makeHarness({ storage: { nbd_ds_workouts: hist }, today: '2026-10-21', fitness: true });
  tab.click('set-freshness', { val: 'steady' }); tab.click('start');
  tab.store.set('nbd_ds_coach_routines', JSON.stringify([R({ id: 'other', name: 'From another tab' })]));
  tab.click('routine-save');
  const both = JSON.parse(tab.store.get('nbd_ds_coach_routines'));
  ok('a routine saved in another tab since this page loaded is kept (the list is re-read before every change)', both.length === 2 && both.some((r) => r.id === 'other'), JSON.stringify(both.map((r) => r.name)));

  const big = sess('2026-10-20', 'push', [['bb_bench', 0, Array.from({ length: 12 }, () => [135, 8])]]);
  big.exercises[0].sets.forEach((x) => { x.done = false; x.reps = ''; });
  ok('a lift with 12 planned sets saves as 10, not 3', C.routineFromSession(big, 'Big', 'b1').lifts[0].sets === 10);
  // phone sweep finding: .btn is nowrap and 32px tall, so a long routine name ran out of the coach card (overflow 143px at 360 wide)
  const CSS = fs.readFileSync(path.join(DIR, '..', 'css', 'workout-coach.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (CSS.match(/\.wc-routine \{([^}]*)\}/) || ['', ''])[1];
  ok('a long routine name wraps inside the card (white-space normal, break anywhere, height auto, still a 44px target)', /white-space:\s*normal/.test(rule) && /overflow-wrap:\s*anywhere/.test(rule) && /height:\s*auto/.test(rule) && /min-height:\s*44px/.test(rule), rule);
  ok('control: a commented-out rule would not satisfy that pin', !/white-space:\s*normal/.test('/* .wc-routine { white-space: normal; } */'.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('handlers go through the delegated switch (no inline handler)', /case 'routine-save': saveRoutine\(\); return;/.test(UI) && /case 'routine-start':/.test(UI) && /case 'routine-del':/.test(UI) && !/onclick=/.test(UI));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
