/**
 * tests/nbd-os-window-polish-2026-11-14.test.js — NBD OS polish pass
 * (2026-11-14, after the close-button fix in
 * tests/nbd-os-close-window-2026-11-14.test.js).
 *
 *   1. Enter in Start opened nothing when the first row was a Visits row
 *      (.os-start-app with no data-osapp): openWin(null), Start closed.
 *   2. Pinning an app from Start closed Start: togglePin rebuilt the list, so
 *      the clicked pin was detached and the outside-click check failed.
 *   3. A view left .active with no window showing it (last window minimised,
 *      a switch to an empty desk, the last window moved to another desk) was
 *      re-opened / pulled back by the next view-class change anywhere.
 *   4. Keyboard focus fell to <body> when the focused window closed or
 *      minimised: it now goes to the window in front, else the Start button.
 *
 * Run: node tests/nbd-os-window-polish-2026-11-14.test.js
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
  // any view's class changing (a view re-rendering, a badge class...) reaches the router observer
  const touch = (id) => { const v = doc.getElementById('view-' + id); if (mo && v) mo.cb([{ target: v }]); settle(); };
  const launch = (id) => { H.click(T.dom, doc.querySelector('[data-osapp="' + id + '"]')); settle(); };
  const win = (id) => doc.querySelector('.os-win[data-win="' + id + '"]');
  const btn = (id, what) => { const w = win(id); return w && w.querySelector('[data-osw="' + what + '"]'); };
  const wins = () => doc.querySelectorAll('.os-win').map((w) => w.getAttribute('data-win'));
  const start = () => doc.querySelector('.os-start');
  const startBtn = () => doc.querySelector('.os-start-btn');
  return { T, W, doc, settle, touch, launch, win, btn, wins, start, startBtn };
}

console.log('1. Enter in Start');
{
  const D = desk();
  H.click(D.T.dom, D.startBtn());
  ok('control: Start is open', D.start() && !D.start().hidden);
  // put a Visits-style row first, as visitStartRows() does for "Record visit"
  const list = D.start().querySelector('.os-start-list');
  const li = D.doc.createElement('li');
  li.className = 'os-start-app os-start-visit';
  list.children.unshift(li); li.parentNode = list;
  const input = D.start().querySelector('input');
  H.key(D.T.dom, input, 'Enter');
  D.settle();
  ok('Enter opens the first APP, skipping a row that is not one', D.wins().length === 1, D.wins().join());
}

console.log('2. pin from Start');
{
  const D = desk();
  H.click(D.T.dom, D.startBtn());
  const pin = D.start().querySelector('[data-ospin]');
  ok('control: a pin button is listed', !!pin);
  H.click(D.T.dom, pin);
  ok('pinning keeps Start open', D.start() && !D.start().hidden);
  const id = pin.getAttribute('data-ospin');
  const pin2 = D.start().querySelector('[data-ospin="' + id + '"]');
  pin2.focus();
  H.click(D.T.dom, pin2);
  const a = D.doc.activeElement;
  ok('keyboard focus stays on that app\'s pin after the list re-renders', !!a && a.isConnected && a.getAttribute('data-ospin') === id, a && (a.className + ' connected=' + a.isConnected));
}

console.log('3. no stale active view');
{
  const D = desk();
  D.launch('crm');
  H.click(D.T.dom, D.btn('crm', 'min'));
  D.touch('money');   // an unrelated view's class changes
  ok('a minimised last window stays minimised', !!D.win('crm') && D.win('crm').classList.contains('is-min'));
  H.click(D.T.dom, D.doc.querySelector('.os-task[data-ostask="crm"]'));
  D.settle();
  ok('…and the taskbar restores it', !D.win('crm').classList.contains('is-min') && D.doc.getElementById('view-crm').classList.contains('active'));
}
{
  const D = desk();
  D.launch('crm');
  H.click(D.T.dom, D.doc.querySelector('[data-osdesk="1"]'));
  D.settle();
  D.touch('money');
  const btnOn = D.doc.querySelector('.os-desk-btn.is-on');
  ok('switching to an empty desk stays there after a view change', btnOn && btnOn.getAttribute('data-osdesk') === '1', btnOn && btnOn.getAttribute('data-osdesk'));
}

console.log('4. focus after close / minimise');
{
  const D = desk();
  D.launch('crm');
  D.launch('money');
  const c = D.btn('money', 'close');
  c.focus();
  H.click(D.T.dom, c);
  D.touch('money');
  const a = D.doc.activeElement;
  ok('closing the focused window moves focus to the window in front', !!a && D.win('crm') && D.win('crm').contains(a), a && a.className);
  const c2 = D.btn('crm', 'close');
  c2.focus();
  H.click(D.T.dom, c2);
  D.touch('crm');
  ok('closing the last one moves focus to Start', D.doc.activeElement === D.startBtn(), D.doc.activeElement && D.doc.activeElement.className);
}
{
  const D = desk();
  D.launch('crm');
  const m = D.btn('crm', 'min');
  m.focus();
  H.click(D.T.dom, m);
  ok('minimising the only window moves focus to Start', D.doc.activeElement === D.startBtn(), D.doc.activeElement && D.doc.activeElement.className);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
