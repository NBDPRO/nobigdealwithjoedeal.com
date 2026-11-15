/**
 * tests/nbd-os-close-window-2026-11-14.test.js — closing an NBD OS window
 * re-opened it, re-centred (Joe, 2026-11-14: "apps can only be minimized;
 * close just re-centers the window").
 *
 * closeWin() (layouts/os.js) dropped the window record and put the view back,
 * but when no other visible window was left on the desk to take focus, the
 * CRM's `.view.active` stayed on the closed view. release() also changes that
 * view's class, which the router observer (watchViews) reads as "the CRM
 * routed here": onViewChange found the active view with no window and called
 * openWin(), a fresh record at the first cascade slot. The S.routing guard
 * can't help: it is reset synchronously, before the observer runs.
 * With two windows open, focus moved to the other one first, so it worked.
 *
 * The harness (tests/lib/nbd-os-home-harness.js) has no MutationObserver, so
 * this suite installs one that delivers the same class-change records a
 * browser would (goTo's .active swap, release()'s os-in-win removal), and a
 * goTo that moves .active like dashboard-actions.js does.
 *
 *   1. one window: close removes the window and its taskbar entry, and it
 *      stays closed after the router observer runs
 *   2. the closed app opens again from the sidebar (goTo) and the launcher
 *   3. minimise stays separate: the window and its taskbar entry remain
 *   4. control: two windows, close the top one -> the other keeps focus
 *   5. the closed window is not saved as open
 *
 * Run: node tests/nbd-os-close-window-2026-11-14.test.js
 */
'use strict';
const H = require('./lib/nbd-os-home-harness.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}

function desk() {
  const T = H.makeWin({ surface: 'desktop', home: { desk: [], phone: [] } });
  const W = T.W, doc = T.document;
  let mo = null;
  W.MutationObserver = function (cb) { mo = this; this.cb = cb; this.observe = () => {}; this.disconnect = () => { if (mo === this) mo = null; }; };
  // dashboard-actions.js goTo: every .active off, the target's on (class records on each view)
  W.goTo = (id) => {
    W.goTos.push(id);
    const views = doc.querySelectorAll('.view');
    views.forEach((v) => v.classList.remove('active'));
    const v = doc.getElementById('view-' + id);
    if (v) v.classList.add('active');
    if (mo) mo.cb(views.map((x) => ({ target: x })));
  };
  W._impl.mount({ surface: 'desktop' });
  const settle = () => T.fire(0);
  // what the browser's observer sees after a layout call touched a view's class
  const observe = (id) => { const v = doc.getElementById('view-' + id); if (mo && v) mo.cb([{ target: v }]); settle(); };
  const launch = (id) => { H.click(T.dom, doc.querySelector('[data-osapp="' + id + '"]')); settle(); };
  const win = (id) => doc.querySelector('.os-win[data-win="' + id + '"]');
  const btn = (id, what) => { const w = win(id); return w && w.querySelector('[data-osw="' + what + '"]'); };
  const task = (id) => doc.querySelector('.os-task[data-ostask="' + id + '"].is-running');
  const wins = () => doc.querySelectorAll('.os-win').map((w) => w.getAttribute('data-win'));
  return { T, W, doc, settle, observe, launch, win, btn, task, wins, hasObserver: () => !!mo };
}

console.log('one window: close closes it');
{
  const D = desk();
  ok('control: the layout watches the router (observer installed)', D.hasObserver());
  D.launch('crm');
  ok('control: launching CRM opens one window with a taskbar entry', D.wins().join() === 'crm' && !!D.task('crm'), D.wins().join());
  H.click(D.T.dom, D.btn('crm', 'close'));
  ok('the window is gone right after the click', !D.win('crm'), D.wins().join());
  D.observe('crm');   // release() removed os-in-win from #view-crm
  ok('THE BUG: it stays closed after the router observer runs (not re-opened)', !D.win('crm'), D.wins().join());
  ok('…no window is left on the desk', D.wins().length === 0, D.wins().join());
  ok('…its taskbar entry is gone', !D.task('crm'));
  D.T.fire(700);   // layouts/os.js SAVE_MS: the debounced writeState
  const saves = (D.W._saves || []).filter((x) => x.layoutState && x.layoutState.os);
  const os = saves.length ? saves[saves.length - 1].layoutState.os : null;
  ok('control: the layout saved after the close', !!os, saves.length);
  ok('…and it is not saved as an open window', !!os && !(os.wins || []).some((w) => w.id === 'crm'), JSON.stringify(os));

  console.log('the closed app opens again');
  D.W.goTo('crm');
  D.settle();
  ok('from the sidebar (the CRM router)', !!D.win('crm') && !!D.task('crm'), D.wins().join());
  H.click(D.T.dom, D.btn('crm', 'close'));
  D.observe('crm');
  ok('control: closed again', !D.win('crm'), D.wins().join());
  D.launch('crm');
  ok('from the launcher', !!D.win('crm'), D.wins().join());
}

console.log('minimise stays separate');
{
  const D = desk();
  D.launch('schedule');
  H.click(D.T.dom, D.btn('schedule', 'min'));   // touches no view's class: no observer record
  ok('minimise keeps the window (hidden) and its taskbar entry', !!D.win('schedule') && D.win('schedule').classList.contains('is-min') && !!D.task('schedule'));
  H.click(D.T.dom, D.btn('schedule', 'close'));
  D.observe('schedule');
  ok('a minimised window closes too', !D.win('schedule') && !D.task('schedule'), D.wins().join());
}

console.log('control: two windows');
{
  const D = desk();
  D.launch('crm');
  D.launch('money');
  H.click(D.T.dom, D.btn('money', 'close'));
  D.observe('money');
  ok('closing the top one leaves only the other', D.wins().join() === 'crm', D.wins().join());
  ok('…which keeps focus', D.win('crm').classList.contains('is-focus'));
  H.click(D.T.dom, D.btn('crm', 'close'));
  D.observe('crm');
  ok('…then closing the last one leaves an empty desk', D.wins().length === 0, D.wins().join());
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
