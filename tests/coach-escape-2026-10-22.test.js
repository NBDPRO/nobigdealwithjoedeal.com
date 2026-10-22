/**
 * tests/coach-escape-2026-10-22.test.js
 *
 * The coach renders user-typed text (custom lift names, routine names, exercise names stored in history) with innerHTML. The vacuous-test
 * audit found no test that would notice a missing esc(): the earlier checks grepped the source for "esc(l.name)", which a comment
 * decoy satisfies. This renders hostile names through the REAL screen and checks the markup, on every place a name is shown.
 *
 * Run: node tests/coach-escape-2026-10-22.test.js
 */
'use strict';

const path = require('path');
const DIR = path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js');
const C = require(path.join(DIR, 'workout-coach-logic.js'));
const { makeHarness } = require('./helpers/coach-ui-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const EVIL = '"><img src=x onerror=alert(1)>';
const safe = (html) => !/<img src=x/.test(html) && /&lt;img src=x/.test(html);

console.log('\n1. every place a name is shown escapes it');
{
  const hist = [{ id: 'h1', date: '2026-10-10', split: 'push', startedAt: 1, finishedAt: 2,
    exercises: [{ exId: 'my_evil', name: EVIL, slot: 5, sets: [{ weight: 40, reps: 10, done: true }] }] }];
  const storage = {
    nbd_ds_workouts: hist,
    nbd_ds_coach_custom: [{ id: 'my_evil', name: EVIL, pattern: 'chest_iso', equip: 'cable' }],
    nbd_ds_coach_routines: [{ id: 'r1', name: EVIL, split: 'push', lifts: [{ exId: 'my_evil', name: EVIL, slot: 5, sets: 1 }] }],
  };
  const h = makeHarness({ storage, today: '2026-10-21', fitness: true });
  ok('control: the hostile custom lift really is in the library (the checks below are not vacuous)', !!h.sandbox.NBDCoach.BY_ID.my_evil && h.sandbox.NBDCoach.BY_ID.my_evil.name === EVIL);

  ok('the coach card: the routine button', safe(h.card()), (h.card().match(/wc-routine[^]{0,160}/) || [''])[0]);

  h.click('routine-start', { id: 'r1' });
  ok('control: the routine started with that lift', !!h.live() && h.live().exercises.some((e) => e.exId === 'my_evil'));
  ok('the live workout screen: lift name and header', safe(h.html()), (h.html().match(/[^>]{0,40}&lt;img[^]{0,60}/) || [''])[0]);

  h.click('settings');
  const settings = h.html();
  ok('settings: the custom lift row', safe(settings) && !/<b>"><img/.test(settings));
  ok('settings: the routine name input value attribute (a quote must not break out of it)', /value="&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;"/.test(settings) || !/value=""><img/.test(settings), (settings.match(/rt-name[^]{0,40}/) || [''])[0]);
  ok('settings: the Remove button label and data-id attributes', !/aria-label="Remove "><img/.test(settings) && !/data-id=""><img/.test(settings));
  h.click('settings');

  const wi = h.live().exercises.findIndex((e) => e.exId === 'my_evil');
  const si = h.live().exercises[wi].sets.findIndex((s) => !s.warm);
  h.field('weight', wi, si, '40'); h.field('reps', wi, si, '12'); h.click('done', { i: wi, s: si });
  h.click('finish');
  const summary = h.html();
  ok('control: the finish screen is showing', /day done|done ✓|wc-lifts/.test(summary));
  ok('the finish recap: the lift line (and a PR line if one fired)', safe(summary), (summary.match(/wc-lifts[^]{0,200}/) || [''])[0]);

  h.click('hist-open');
  ok('workout history: the session rows', !/<img src=x/.test(h.html()));
  const id = (h.html().match(/data-coach-action="hist-toggle" data-id="([^"]+)"/) || [])[1];
  if (id) h.click('hist-toggle', { id });
  ok('workout history: the opened session shows the exercise name escaped', safe(h.html()), (h.html().match(/wc-hist-ex[^]{0,120}/) || [''])[0]);
}

console.log('\n1b. the REP-PR line (high reps) escapes the name too');
{
  const hist = [{ id: 'h1', date: '2026-10-10', split: 'push', startedAt: 1, finishedAt: 2, exercises: [{ exId: 'my_evil', name: EVIL, slot: 5, sets: [{ weight: 40, reps: 10, done: true }] }] }];
  const h = makeHarness({ storage: { nbd_ds_workouts: hist, nbd_ds_coach_custom: [{ id: 'my_evil', name: EVIL, pattern: 'chest_iso', equip: 'cable' }],
    nbd_ds_coach_routines: [{ id: 'r1', name: 'Plain', split: 'push', lifts: [{ exId: 'my_evil', name: EVIL, slot: 5, sets: 1 }] }] }, today: '2026-10-21', fitness: true });
  h.click('routine-start', { id: 'r1' });
  const wi = h.live().exercises.findIndex((e) => e.exId === 'my_evil');
  const si = h.live().exercises[wi].sets.findIndex((s) => !s.warm);
  h.field('weight', wi, si, '40'); h.field('reps', wi, si, '20'); h.click('done', { i: wi, s: si });
  h.click('finish');
  ok('control: it is a rep PR line (20 reps beats 10 at that weight)', /Rep PR|reps at 40 lb|20 reps/.test(h.html()) || /🏆/.test(h.html()));
  ok('the rep-PR line shows the hostile name as text', safe(h.html()), (h.html().match(/🏆[^]{0,120}/) || [''])[0]);
}

// Not mutation-checked on purpose: data-id attributes for routines and custom lifts. Their ids are reduced to [A-Za-z0-9_] by
// normRoutines / normCustom, so a quote cannot reach them (esc() there is defence in depth, not the guard).

console.log('\n2. a name with a quote or angle bracket typed through the UI is stored as text and shown as text');
{
  const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-10-21' });
  h.click('set-freshness', { val: 'steady' }); h.click('start'); h.click('settings');
  h.field('cx', 0, 0, '<b>Bold</b> fly', { k: 'name' }); h.field('cx', 0, 0, 'chest_iso', { k: 'pattern' }); h.field('cx', 0, 0, 'cable', { k: 'equip' });
  h.click('custom-add');
  ok('typed markup in a custom lift name is shown as text, not rendered', /&lt;b&gt;Bold&lt;\/b&gt; fly/.test(h.html()) && !/<b><b>Bold/.test(h.html()));
  const stored = JSON.parse(h.store.get('nbd_ds_coach_custom'));
  ok('...and stored exactly as typed', stored.length === 1 && stored[0].name === '<b>Bold</b> fly');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
