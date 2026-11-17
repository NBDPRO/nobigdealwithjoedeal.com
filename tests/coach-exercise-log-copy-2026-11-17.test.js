/**
 * tests/coach-exercise-log-copy-2026-11-17.test.js
 *
 * A workout finished where no day page is on screen (the standalone Workout app, another device, or Daily Success while a
 * different day is showing) is copied into that day's Exercise Log by the Daily Success page (Jo, 2026-11-17).
 *
 * The rule (docs/pro/daily-success/js/workout-coach.js): a session carries `inLog`. Finish saves it as false, and true once its
 * lifts are on a day page. The Daily Success page copies every inLog === false session for the day on screen, then marks it.
 *
 *   1. Finish in the Workout app (no day page): the session is saved with inLog false, and nothing else is touched.
 *   2. Finish in Daily Success on today's page: written at once and marked, so it is never copied a second time.
 *   3. The copy: after the rows already there, oldest workout first, marked with a newer mt, sent to the cloud, page redrawn.
 *   4. Never twice; never a session from before this field existed; never another day's; never onto a named page or the Dashboard.
 *   5. A phone that refuses the page save leaves the page and the session as they were (tried again later, not lost, not doubled).
 *   6. A focused field is not redrawn away.
 *   8. The floor prompt: a copied-in workout raises the same nbd-ds-did the coach raises at Finish, once per copy, so Daily Success asks
 *      "Workout done. Tick the floor?" for a workout finished in the Workout app. Nothing copied, nothing asked.
 *   7. The triggers: a day page being drawn, and the sync's refresh(). (Coming back to the app is a third; not covered here.)
 *
 * Runs the real coach in a vm (tests/helpers/coach-ui-harness.js). Run: node tests/coach-exercise-log-copy-2026-11-17.test.js
 */
'use strict';

const { makeHarness } = require('./helpers/coach-ui-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const TODAY = '2026-11-17';
const sess = (id, o) => Object.assign({
  id, date: TODAY, split: 'push', startedAt: 1000, finishedAt: 2000 + id, mt: 5000 + id,
  exercises: [{ exId: 'bench', name: 'Lift ' + id, slot: 'main', sets: [{ reps: 8, weight: 135, rpe: 8, done: true }, { reps: 7, weight: 135, rpe: 9, done: true }] }],
}, o || {});

// The Daily Success page around the coach: day pages, the save, the redraw. Timers are queued and run by hand.
function dsPage(sessions, pageOver, opts) {
  const h = makeHarness({ storage: { nbd_ds_workouts: sessions }, today: TODAY, fitness: true });
  const s = h.sandbox;
  const page = Object.assign({ id: 1, dk: TODAY, data: {}, exercises: [] }, pageOver || {});
  const log = { saves: 0, renders: 0, collects: 0, pushed: [], timers: [], did: [] };
  s.pages = [page]; s.cur = (opts && 'cur' in opts) ? opts.cur : 0;
  s.collectPage = () => { log.collects++; return true; };
  s.savePages = () => { log.saves++; return !(opts && opts.saveFails); };
  s.renderPage = () => { log.renders++; };
  s.setTimeout = (f) => { log.timers.push(f); return log.timers.length; };
  // what floor-tick-ui.js listens for: nbd-ds-did { kind, dk }
  s.CustomEvent = function (type, init) { this.type = type; this.detail = (init && init.detail) || null; };
  s.dispatchEvent = (ev) => { if (ev && ev.type === 'nbd-ds-did') log.did.push(ev.detail.kind + ' ' + ev.detail.dk); return true; };
  s.NBDDsCloud = { pushWorkout: (x) => { log.pushed.push(x); return Promise.resolve(true); } };
  const runTimers = () => { const t = log.timers.splice(0); t.forEach((f) => f()); };
  return { h, s, page, log, runTimers, names: () => page.exercises.map((r) => r.name) };
}

console.log('\n1. Finish in the Workout app (no day page on screen)');
{
  const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: TODAY });
  h.click('start'); h.click('done', { i: 0, s: 0 }); h.click('finish');
  const saved = h.saved();
  ok('the workout is saved, flagged as not yet in an Exercise Log', saved.length === 1 && saved[0].inLog === false, JSON.stringify(saved.map((x) => x.inLog)));
  ok('and it does not claim to be logged to a day page', h.html().indexOf('Logged to today') === -1);
  ok('with no day page there is nothing to copy into', h.sandbox.NBDCoachUI._logPending() === false && h.saved()[0].inLog === false);
}

console.log('\n2. Finish in Daily Success with today\'s page on screen');
{
  const d = dsPage([]);
  d.h.click('start'); d.h.click('done', { i: 0, s: 0 }); d.h.click('finish');
  const saved = d.h.saved();
  ok('the lifts are on the page at once', d.page.exercises.length > 0 && d.log.saves === 1);
  ok('and the session is marked as in the log, with the mark sent to the cloud', saved.length === 1 && saved[0].inLog === true && d.log.pushed.some((x) => x.inLog === true));
  const rows = d.page.exercises.length;
  ok('so nothing copies it again', d.s.NBDCoachUI._logPending() === false && d.page.exercises.length === rows && d.log.saves === 1);
}

console.log('\n3. The copy');
{
  const d = dsPage([sess(2, { inLog: false }), sess(1, { inLog: false })], { exercises: [{ name: 'Typed by hand', sets: '3', reps: '10', weight: '', notes: '' }, { name: '', sets: '', reps: '', weight: '', notes: '' }], data: { 'ex-0-name': 'Typed by hand' } });
  const did = d.s.NBDCoachUI._logPending();
  ok('copies the day\'s pending workouts in', did === true);
  ok('after the rows already there (blank rows dropped), oldest workout first', d.names().join(' | ') === 'Typed by hand | Lift 1 | Lift 2', d.names().join(' | '));
  const row = d.page.exercises[1];
  ok('a row carries sets, reps, top weight and RPE as the coach always wrote them', row.sets === '2' && row.reps === '8/7' && row.weight === '135' && row.notes === 'RPE 9', JSON.stringify(row));
  ok('what was typed on the page is collected first, then one save and one redraw', d.log.collects === 1 && d.log.saves === 1 && d.log.renders === 1);
  ok('the page\'s old ex-N-* mirror is dropped so the redraw reads the new list', !Object.keys(d.page.data).some((k) => k.indexOf('ex-') === 0));
  ok('focus and duration are filled in when blank', d.page.data['fit-focus'] && d.page.data['fit-focus'].length > 0 && typeof d.page.data['fit-dur'] === 'string');
  const saved = d.h.saved();
  ok('both sessions are marked, each with a newer mt (the mark wins every merge)', saved.every((x) => x.inLog === true) && saved.every((x) => x.mt > 5000 + x.id));
  ok('and the marks go to the cloud', d.log.pushed.length === 2 && d.log.pushed.every((x) => x.inLog === true));

  console.log('\n4. What is never copied');
  ok('the same workout a second time', d.s.NBDCoachUI._logPending() === false && d.names().length === 3 && d.log.saves === 1);
}
{
  const old = sess(1); delete old.inLog;
  const d = dsPage([old, sess(2, { inLog: true }), sess(3, { inLog: false, date: '2026-11-16' }), sess(4, { inLog: false, deleted: true })]);
  ok('a session from before the flag existed, one already logged, another day\'s, or a deleted one', d.s.NBDCoachUI._logPending() === false && d.names().length === 0 && d.log.saves === 0);
}
{
  const named = dsPage([sess(1, { inLog: false })], { name: 'Vacation plan' });
  ok('onto a named page that happens to share the date', named.s.NBDCoachUI._logPending() === false && named.names().length === 0);
  const dash = dsPage([sess(1, { inLog: false })], null, { cur: -1 });
  ok('while the Dashboard is on screen', dash.s.NBDCoachUI._logPending() === false && dash.names().length === 0 && dash.h.saved()[0].inLog === false);
}

console.log('\n5. A phone that refuses the save');
{
  const d = dsPage([sess(1, { inLog: false })], { exercises: [{ name: 'Typed by hand', sets: '', reps: '', weight: '', notes: '' }], data: { 'fit-focus': '' } }, { saveFails: true });
  const did = d.s.NBDCoachUI._logPending();
  ok('reports nothing copied and does not redraw', did === false && d.log.renders === 0);
  ok('the page is as it was', d.names().join() === 'Typed by hand' && d.page.data['fit-focus'] === '');
  const s = d.h.saved()[0];
  ok('the session is still pending, unchanged, and nothing was sent', s.inLog === false && s.mt === 5001 && d.log.pushed.length === 0);
}

console.log('\n6. A focused field');
{
  const d = dsPage([sess(1, { inLog: false })]);
  d.h.focusOn({ tagName: 'INPUT' });
  ok('is not redrawn away: nothing is copied while typing', d.s.NBDCoachUI._logPending() === false && d.names().length === 0 && d.h.saved()[0].inLog === false);
  d.h.focusOn(null);
  ok('and it is copied on the next try', d.s.NBDCoachUI._logPending() === true && d.names().join() === 'Lift 1');
}

console.log('\n7. The triggers');
{
  const d = dsPage([sess(1, { inLog: false })]);
  d.s.buildFitnessSection(d.page);
  ok('drawing a day page with a workout waiting queues the copy (it does not write during the draw)', d.log.timers.length === 1 && d.names().length === 0);
  d.runTimers();
  ok('and the queued copy lands', d.names().join() === 'Lift 1' && d.log.renders === 1);
  d.s.buildFitnessSection(d.page);
  ok('the redraw that follows queues nothing more (no loop)', d.log.timers.length === 0);
  d.s.buildFitnessSection({ dk: '2026-11-10', data: {}, exercises: [] });
  ok('a day with nothing waiting queues nothing', d.log.timers.length === 0);
}
{
  const d = dsPage([]);
  d.s.localStorage.setItem('nbd_ds_workouts', JSON.stringify([sess(1, { inLog: false })]));   // the sync merged a workout from the cloud...
  d.s.NBDCoachUI.refresh();                                                                    // ...and calls refresh(), as ds-firebase-sync.js does
  ok('the sync\'s refresh() copies a workout that just arrived', d.names().join() === 'Lift 1');
}
// Not covered here: the visibilitychange trigger (the harness cannot fire document events other than click / input / keydown).

console.log('\n8. The floor prompt for a workout finished elsewhere');
{
  const d = dsPage([sess(1, { inLog: false }), sess(2, { inLog: false })]);
  d.s.NBDCoachUI._logPending();
  ok('copying workouts in raises the workout-done event for that day, once', d.log.did.join(',') === 'workout ' + TODAY, d.log.did.join(','));
  ok('after the page was saved and redrawn (the prompt reads the saved page)', d.log.saves === 1 && d.log.renders === 1);
  d.s.NBDCoachUI._logPending();
  ok('nothing more to copy, nothing more asked', d.log.did.length === 1);
}
{
  const full = dsPage([sess(1, { inLog: false })], null, { saveFails: true });
  full.s.NBDCoachUI._logPending();
  const typing = dsPage([sess(1, { inLog: false })]);
  typing.h.focusOn({ tagName: 'TEXTAREA' });
  typing.s.NBDCoachUI._logPending();
  const none = dsPage([sess(1, { inLog: true })]);
  none.s.NBDCoachUI._logPending();
  ok('a refused save, a focused field or nothing pending asks nothing', full.log.did.length === 0 && typing.log.did.length === 0 && none.log.did.length === 0);
}
{
  const d = dsPage([]);
  d.h.click('start'); d.h.click('done', { i: 0, s: 0 }); d.h.click('finish');
  ok('Finish on today\'s page still asks exactly once (the copy path adds no second question)', d.log.did.join(',') === 'workout ' + TODAY, d.log.did.join(','));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
