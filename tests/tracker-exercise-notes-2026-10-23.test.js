/**
 * tests/tracker-exercise-notes-2026-10-23.test.js
 *
 * Daily Success: per-exercise notes in the Workout Coach
 * (exercise-notes-logic.js + noteHtml/onField in workout-coach.js).
 * A note on a lift resurfaces the next time that lift appears.
 *
 * Run: node tests/tracker-exercise-notes-2026-10-23.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const N = require(path.join(DS, 'js', 'exercise-notes-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; }
}
const read = (...p) => fs.readFileSync(path.join(DS, ...p), 'utf8').replace(/\r\n/g, '\n');

console.log('\n1. saving a note');
{
  const m = N.set({}, 'bench', '2026-10-20', '  left shoulder   off at RPE 8 ');
  ok('stored under lift and date, whitespace collapsed', m.bench['2026-10-20'] === 'left shoulder off at RPE 8');
  ok('capped at 160 characters', N.on(N.set({}, 'bench', '2026-10-20', 'x'.repeat(500)), 'bench', '2026-10-20').length === 160 && N.MAX === 160);
  ok('control characters are stripped', N.on(N.set({}, 'bench', '2026-10-20', 'a' + String.fromCharCode(0) + 'b'), 'bench', '2026-10-20') === 'a b');
  ok('does not mutate the old map', (() => { const o = {}; N.set(o, 'bench', '2026-10-20', 'x'); return Object.keys(o).length === 0; })());
  ok('empty text removes only that day (negative control)', (() => {
    let x = N.set({}, 'bench', '2026-10-19', 'old'); x = N.set(x, 'bench', '2026-10-20', 'new');
    x = N.set(x, 'bench', '2026-10-20', '');
    return N.on(x, 'bench', '2026-10-19') === 'old' && N.on(x, 'bench', '2026-10-20') === '';
  })());
  ok('a lift with no notes left disappears from the map', Object.keys(N.set(N.set({}, 'bench', '2026-10-20', 'x'), 'bench', '2026-10-20', '')).length === 0);
  ok('a bad lift id or date is refused', Object.keys(N.set({}, '', '2026-10-20', 'x')).length === 0 && Object.keys(N.set({}, 'bench', 'today', 'x')).length === 0
    && Object.keys(N.set({}, '<img>', '2026-10-20', 'x')).length === 0);
}

console.log('\n2. it resurfaces next time');
{
  let m = N.set({}, 'bench', '2026-10-13', 'elbows flared');
  m = N.set(m, 'bench', '2026-10-20', 'left shoulder off at RPE 8');
  const prev = N.lastBefore(m, 'bench', '2026-10-23');
  ok('next session shows the most recent earlier note', prev && prev.dk === '2026-10-20' && /left shoulder/.test(prev.text));
  ok('today\'s own note is not "last time" (negative control)', N.lastBefore(m, 'bench', '2026-10-20').dk === '2026-10-13');
  ok('a lift with no history shows nothing', N.lastBefore(m, 'squat', '2026-10-23') === null);
  ok('another lift\'s note never leaks', N.lastBefore(N.set({}, 'row', '2026-10-20', 'x'), 'bench', '2026-10-23') === null);
}

console.log('\n3. bounds and corrupt storage');
{
  let m = {};
  for (let i = 0; i < 10; i++) m = N.set(m, 'bench', N.MAX && '2026-10-' + String(10 + i).padStart(2, '0'), 'n' + i);
  ok('six dated notes kept per lift, oldest dropped', Object.keys(m.bench).length === 6 && !m.bench['2026-10-10'] && m.bench['2026-10-19']);
  let many = {};
  for (let i = 0; i < 230; i++) many = N.set(many, 'lift' + i, '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), 'n');
  ok('at most 200 lifts kept', Object.keys(many).length === 200);
  ok('garbage storage normalizes to empty', Object.keys(N.normalize('x')).length === 0 && Object.keys(N.normalize([1])).length === 0 && Object.keys(N.normalize(null)).length === 0);
  ok('malformed entries are dropped, good ones kept', (() => {
    const g = N.normalize({ bench: { '2026-10-20': 'ok', nope: 'x', '2026-10-21': 5 }, '<b>': { '2026-10-20': 'x' } });
    return g.bench['2026-10-20'] === 'ok' && Object.keys(g.bench).length === 2 && !g['<b>'];
  })());
}

console.log('\n4. wiring');
{
  const ui = read('js', 'workout-coach.js');
  const idx = read('index.html');
  ok('the note is escaped before it reaches innerHTML', /esc\(prev\.text\)/.test(ui) && /esc\(N\.on\(map, x\.exId, today\(\)\)\)/.test(ui) && /esc\(x\.exId\)/.test(ui));
  ok('saved on change only, never per keystroke', /exnote'\) \{\s*\n\s*if \(ev\.type !== 'change'/.test(ui));
  ok('the card shows the note just above the sets, after the plate line (the plate-calc test keeps plates near the target line)', ui.indexOf('${platesHtml(x, ex)}\n      ${noteHtml(x)}') > -1);
  ok('notes ride the settings sync', /\{ key: 'nbd_ds_coach_notes', field: 'dsCoachNotes' \}/.test(read('ds-firebase-sync.js')));
  ok('logic loads before the coach screen', idx.indexOf('exercise-notes-logic.js') > -1 && idx.indexOf('exercise-notes-logic.js') < idx.indexOf('workout-coach.js?v='));
  ok('no network or storage in the pure logic', !/fetch\(|localStorage|XMLHttpRequest/.test(read('js', 'exercise-notes-logic.js')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
