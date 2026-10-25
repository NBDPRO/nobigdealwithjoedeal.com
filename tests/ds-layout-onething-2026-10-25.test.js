/**
 * tests/ds-layout-onething-2026-10-25.test.js
 *
 * The One Thing layout: the Today bar as one big "do this next" card. Pins the pure picker (onething-logic.js: order, skipping,
 * the done card), the renderer (onething-ui.js in a vm, with the real check-in and wrap-up state rules), the Today-bar branch in
 * app.js, the ready flag, the scripts and the scoped CSS.
 *
 * Run: node tests/ds-layout-onething-2026-10-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const DS = path.join(__dirname, '..', 'docs', 'pro', 'daily-success');
const L = require(path.join(DS, 'js', 'layout-logic.js'));
const O = require(path.join(DS, 'js', 'onething-logic.js'));
const read = (p) => fs.readFileSync(path.join(DS, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('js/app.js'), CSS = read('css/layouts.css'), INDEX = read('index.html'), UI = read('js/onething-ui.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }
const floors = [{ id: 'sleep', label: 'Sleep 7+ hrs', met: true }, { id: 'task', label: '1 Big Task', met: false }, { id: 'journal', label: 'Journaled', met: false }];

console.log('\n1. nextThing');
{
  const r = O.nextThing({ isToday: true, checkin: 'ask', floors, workout: false, eod: 'link' });
  ok('the morning check-in comes first while it is still asking', r.thing.kind === 'checkin' && r.thing.button === 'Check in');
  ok('the queue is check-in, the two open floors, the workout; 4 open', r.queue.join() === 'checkin,floor:task,floor:journal,workout' && r.left === 4);
  const r2 = O.nextThing({ isToday: true, checkin: 'done', floors, workout: false, eod: 'link' });
  ok('check-in done: the first unmet floor, with its id for the toggle and its place in the list', r2.thing.kind === 'floor' && r2.thing.floorId === 'task' && r2.thing.title === '1 Big Task' && /Floor 2 of 3/.test(r2.thing.sub) && /1 more after this/.test(r2.thing.sub));
  const r3 = O.nextThing({ isToday: true, checkin: 'done', floors: floors.map((f) => Object.assign({}, f, { met: true })), workout: false, eod: 'link' });
  ok('every floor met: the workout', r3.thing.kind === 'workout' && r3.left === 1);
  const r4 = O.nextThing({ isToday: true, checkin: 'done', floors: floors.map((f) => Object.assign({}, f, { met: true })), workout: true, eod: 'prompt' });
  ok('workout in and it is evening: the wrap-up', r4.thing.kind === 'eod' && r4.thing.button === 'Wrap up');
  const r5 = O.nextThing({ isToday: true, checkin: 'done', floors: floors.map((f) => Object.assign({}, f, { met: true })), workout: true, eod: 'saved' });
  ok('all done: the rest card, nothing open, no button', r5.thing.kind === 'done' && r5.left === 0 && r5.thing.button === '');
  ok('"not now" sends a thing to the back of the line (the next one leads, the skipped one is last)', (() => { const s = O.nextThing({ isToday: true, checkin: 'ask', floors, workout: false, eod: 'link', skipped: ['checkin'] }); return s.thing.id === 'floor:task' && s.queue[s.queue.length - 1] === 'checkin' && s.left === 4; })());
  ok('skipping everything still shows the first skipped thing, never the done card', O.nextThing({ isToday: true, checkin: 'done', floors, workout: true, eod: 'link', skipped: ['floor:task', 'floor:journal'] }).thing.id === 'floor:task');
  ok('another day (not today): no check-in, no wrap-up, floors and workout only', O.nextThing({ isToday: false, checkin: 'ask', floors, workout: false, eod: 'prompt' }).queue.join() === 'floor:task,floor:journal,workout');
  ok('a skipped or hidden check-in is not a thing', O.nextThing({ isToday: true, checkin: 'skipped', floors: [], workout: true }).thing.kind === 'done' && O.nextThing({ isToday: true, checkin: 'hidden', floors: [], workout: true }).thing.kind === 'done');
  ok('the last open floor says so', /the last one/.test(O.nextThing({ isToday: true, checkin: 'done', floors: [floors[0], floors[1]], workout: true }).thing.sub));
  ok('no input at all does not throw: the workout is the one thing', O.nextThing().thing.kind === 'workout' && O.nextThing(null).left === 1);
}

console.log('\n2. the card markup (real check-in and wrap-up rules)');
{
  const K = require(path.join(DS, 'js', 'checkin-logic.js'));
  const E = require(path.join(DS, 'js', 'eod-logic.js'));
  const store = {};
  const sandbox = { window: { NBDOneThing: O, NBDCheckin: K, NBDEod: E, addEventListener() {} }, document: { addEventListener() {}, querySelector() { return null; } }, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }, console, Date };
  vm.createContext(sandbox);
  vm.runInContext(UI, sandbox);
  const html = (o) => sandbox.window.NBDOneThingUI.html(o);
  const TODAY = '2026-10-25';
  const h = html({ floors, workout: false, dk: TODAY, today: TODAY });
  const hour = new Date().getHours();
  const expectCheckin = hour < K.ASK_UNTIL;
  ok('today before ' + K.ASK_UNTIL + ':00 the card is the check-in, later it is the first open floor (now ' + hour + ':00)', expectCheckin ? /class="ot-card checkin"/.test(h) && /data-onething="checkin"/.test(h) : /class="ot-card floor"/.test(h));
  store.nbd_ds_coach_ready = JSON.stringify({ [TODAY]: { sleep: 2, sore: 2, energy: 2 } });
  const h2 = html({ floors, workout: false, dk: TODAY, today: TODAY });
  ok('check-in done: the floor card, its button carries the toggle-floor action app.js handles', /class="ot-card floor"/.test(h2) && /<button type="button" class="ot-btn" data-action="toggle-floor" data-floor-id="task">Done<\/button>/.test(h2));
  ok('the eyebrow, a big title, the sub line, "Not now" and the open count', /Do this next/.test(h2) && /<h2 class="ot-title">1 Big Task<\/h2>/.test(h2) && /data-onething="skip" data-id="floor:task"/.test(h2) && /3 things open today/.test(h2));
  const allMet = floors.map((f) => Object.assign({}, f, { met: true }));
  const h3 = html({ floors: allMet, workout: false, dk: TODAY, today: TODAY });
  ok('the workout card opens the coach and has no "Not now" when it is the only thing', /class="ot-card workout"/.test(h3) && /data-onething="workout"/.test(h3) && !/data-onething="skip"/.test(h3));
  const h4 = html({ floors: allMet, workout: true, dk: TODAY, today: TODAY });
  ok('everything done (and no wrap-up due, or the wrap-up): the rest card or the wrap-up, never a floor', /class="ot-card (done|eod)"/.test(h4));
  ok('no inline style attribute', !/style="/.test(h) && !/style="/.test(h2));
  ok('floor labels are escaped', (() => { const e = html({ floors: [{ id: 'x', label: '<img src=x onerror=1>', met: false }], workout: true, dk: '2026-01-01', today: TODAY }); return !/<img src=x/.test(e) && /&lt;img/.test(e); })());
}

console.log('\n3. wiring');
{
  ok('One Thing is ready to pick; Classic still the default', L.byId('onething').ready === true && L.DEFAULT === 'classic' && L.normLayout('onething') === 'onething');
  ok('updateTodayBar renders the card only in the One Thing layout and toggles the class', /onething=ui==='onething'/.test(APP) && /bar\.classList\.toggle\('today-onething',onething\)/.test(APP) && /if\(onething&&window\.NBDOneThingUI\)/.test(APP));
  ok('it hands the card the floors with met flags, the workout, the page date and today', /NBDOneThingUI\.html\(\{floors:fl2\.map\(f=>\(\{id:f\.id,label:f\.label,met:pd2\['floormet-'\+f\.id\]==='1'\}\)\),workout:s\.workout,dk:p&&p\.dk,today:todayKey\(\)\}\)/.test(APP));
  ok('onething-logic and onething-ui load deferred', ['onething-logic.js', 'onething-ui.js'].every((f) => new RegExp('<script src="/pro/daily-success/js/' + f.replace('.', '\\.') + '\\?v=\\d+" defer></script>').test(INDEX)));
  const ot = CSS.slice(CSS.indexOf('One Thing:'), CSS.indexOf('Quest:'));
  const rules = ot.split('\n').filter((l) => /\{/.test(l));
  ok('every One Thing rule is scoped to [data-ui="onething"]', rules.length >= 8 && rules.every((l) => /^\[data-ui="onething"\]/.test(l.trim())), rules.filter((l) => !/^\[data-ui="onething"\]/.test(l.trim())).join(' | '));
  ok('the big button is 56 px, "Not now" 44 px, the card static', /\.ot-btn \{[^}]*min-height: 56px/.test(ot) && /\.ot-skip \{[^}]*min-height: 44px/.test(ot) && /today-onething \{ position: static;/.test(ot));
  ok('no font under 11 px', !/font-size: (10|9|8)px/.test(ot));
  ok('layouts.css cache version bumped', /layouts\.css\?v=7/.test(INDEX));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
