/**
 * tests/nbd-os-review-nice-to-haves-2026-11-14.test.js — items 18-20 of the
 * 2026-11-14 independent NBD OS review, each verified against the code first.
 *
 *   18. No keyboard shortcut to cycle or close windows, no "close all", no
 *       middle-click close on the taskbar. Conventional, browser-safe picks
 *       (Ctrl+Alt is already the OS layer's chord): Ctrl+Alt+] / [ cycle windows
 *       forward / back (Alt+backquote is Pocket's), Ctrl+Alt+W closes the focused one, "Close all windows"
 *       is a Cmd+K entry, middle-click on a taskbar button closes it.
 *   19. Performance: the router observer watched the whole .content subtree
 *       (every class change in every view's content); a window drag repainted
 *       on every pointermove; the Control Center tiles polled for 30 s though
 *       system.js fires nbd:os-system-ready.
 *   20. A press in a background window routed (goTo) on pointerdown, so a view
 *       that re-renders on route could swallow that first click. The window is
 *       raised at once; the route waits until the press is over.
 *
 * Run: node tests/nbd-os-review-nice-to-haves-2026-11-14.test.js
 */
'use strict';
const H = require('./lib/nbd-os-home-harness.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}

function desk(o) {
  o = o || {};
  const T = H.makeWin({ surface: 'desktop', system: o.system, home: { desk: [], phone: [] } });
  const W = T.W, doc = T.document;
  const observed = [];
  let mo = null;
  W.MutationObserver = function (cb) { mo = this; this.cb = cb; this.observe = (target, opts) => { observed.push({ target, opts }); }; this.disconnect = () => { if (mo === this) mo = null; }; };
  W.location = { hash: '', pathname: '/', search: '' }; W.history = { replaceState() {} };
  W.goTo = (id) => {
    W.goTos.push(id);
    const views = doc.querySelectorAll('.view');
    views.forEach((v) => v.classList.remove('active'));
    const v = doc.getElementById('view-' + id);
    if (v) v.classList.add('active');
    if (mo) mo.cb(views.map((x) => ({ target: x })));
  };
  if (o.raf) { W.__frames = []; W.requestAnimationFrame = (fn) => { W.__frames.push(fn); return W.__frames.length; }; W.cancelAnimationFrame = () => {}; }
  const regs = [];
  W.NBDCommand = { open() {}, registerAction(a) { regs.push(a); }, unregisterAction() {} };
  if (o.before) o.before(W, doc);
  W._impl.mount({ surface: 'desktop' });
  const settle = () => T.fire(0);
  const launch = (id) => { H.click(T.dom, doc.querySelector('.os-icon[data-osapp="' + id + '"]')); settle(); };
  const win = (id) => doc.querySelector('.os-win[data-win="' + id + '"]');
  const wins = () => doc.querySelectorAll('.os-win').map((w) => w.getAttribute('data-win'));
  const front = () => { const f = doc.querySelector('.os-win.is-focus'); return f && f.getAttribute('data-win'); };
  const chord = (k, code, shift) => { H.key(T.dom, doc.activeElement || doc.body, k, { ctrlKey: true, altKey: true, shiftKey: !!shift, code }); settle(); };
  return { T, W, doc, settle, launch, win, wins, front, chord, observed, regs };
}

console.log('18. window shortcuts');
{
  const D = desk();
  D.launch('crm'); D.launch('money'); D.launch('photos');
  ok('control: photos is in front', D.front() === 'photos', D.front());
  D.chord(']', 'BracketRight');
  ok('Ctrl+Alt+] brings the next window forward', D.front() !== 'photos' && !!D.front(), D.front());
  const second = D.front();
  D.chord(']', 'BracketRight');
  ok('…pressing it again moves on (not back and forth between two)', D.front() !== second && D.front() !== 'photos', D.front());
  D.chord('[', 'BracketLeft');
  ok('Ctrl+Alt+[ goes back', D.front() === second, D.front());
  // holding the chord (key repeat) closes nothing more
  const before = D.wins().length;
  H.key(D.T.dom, D.doc.activeElement || D.doc.body, 'w', { ctrlKey: true, altKey: true, code: 'KeyW', repeat: true });
  ok('a repeated Ctrl+Alt+W (key held down) closes nothing', D.wins().length === before, D.wins().join());
  // AltGr (Ctrl+Alt on Windows) typing a character is not a shortcut
  H.key(D.T.dom, D.doc.activeElement || D.doc.body, 'w', { ctrlKey: true, altKey: true, code: 'KeyW', getModifierState: (m) => m === 'AltGraph' });
  ok('AltGr+W closes nothing', D.wins().length === before, D.wins().join());
  const f = D.front();
  D.chord('w', 'KeyW');
  ok('Ctrl+Alt+W closes the window in front', !D.win(f) && D.wins().length === 2, D.wins().join());
  const all = D.regs.filter((a) => /close all/i.test(a.label))[0];
  ok('"Close all windows" is a Cmd+K entry', !!all);
  if (all) { all.run(); D.settle(); }
  ok('…and it closes every window on the desk', D.wins().length === 0, D.wins().join());
}
{
  const D = desk();
  D.launch('crm');
  const task = D.doc.querySelector('.os-task[data-ostask="crm"]');
  H.fire(D.T.dom, task, 'auxclick', { button: 1 });
  D.settle();
  ok('middle-click on a taskbar button closes that window', !D.win('crm'), D.wins().join());
}
{
  const D = desk();
  const input = D.doc.createElement('input');
  D.doc.body.appendChild(input);
  D.launch('crm');
  input.focus();
  H.key(D.T.dom, input, 'w', { ctrlKey: true, altKey: true, code: 'KeyW' });
  ok('control: the shortcut never fires while typing in a field', !!D.win('crm'));
}

console.log('19. performance');
{
  const D = desk();
  const subtreeOnContent = D.observed.some((x) => x.opts && x.opts.subtree && x.target && x.target.classList && x.target.classList.contains('content'));
  ok('the router observer no longer watches the whole .content subtree', !subtreeOnContent, JSON.stringify(D.observed.map((x) => [x.target && x.target.className, x.opts && x.opts.subtree])));
  const allViews = D.doc.querySelectorAll('.content .view');
  const watched = D.observed.filter((x) => x.target && x.target.classList && x.target.classList.contains('view') && x.opts && x.opts.attributeFilter && x.opts.attributeFilter[0] === 'class' && !x.opts.subtree).map((x) => x.target);
  ok('…it watches each view\'s own class, every one of them', allViews.length > 0 && allViews.every((v) => watched.indexOf(v) !== -1), watched.length + ' of ' + allViews.length);
}
{
  const D = desk({ raf: true });
  D.launch('crm');
  const el = D.win('crm');
  let writes = 0;
  el.style.setProperty = () => { writes++; };
  const bar = el.querySelector('[data-osw="bar"]');
  H.fire(D.T.dom, bar, 'pointerdown', { clientX: 300, clientY: 100, pointerId: 5 });
  writes = 0;
  for (let i = 1; i <= 5; i++) H.fire(D.T.dom, bar, 'pointermove', { clientX: 300 + i * 20, clientY: 100, pointerId: 5 });
  ok('five pointermoves inside one frame write no layout yet', writes === 0, writes);
  ok('…one frame is queued', D.W.__frames.length === 1, D.W.__frames.length);
  const fr = D.W.__frames.shift(); if (fr) fr();
  ok('…and the frame paints the latest position once', writes > 0 && writes <= 12, writes);
  H.fire(D.T.dom, bar, 'pointermove', { clientX: 500, clientY: 100, pointerId: 5 });
  H.fire(D.T.dom, bar, 'pointerup', { clientX: 500, clientY: 100, pointerId: 5 });
  const s = (D.W._saves || []);
  D.T.fire(700);
  const os = (D.W._saves || []).filter((x) => x.layoutState && x.layoutState.os).pop();
  ok('pointerup applies a move still waiting for its frame (nothing lost)', !!os && os.layoutState.os.wins[0].x > 0.2, os && JSON.stringify(os.layoutState.os.wins[0]));
}
{
  const D = desk({ system: true, before: (W) => { W.NBDOS.registerControl = function (def) { W.controls = W.controls.filter((c) => c.id !== def.id).concat([def]); }; } });
  ok('control: tiles registered when the system layer was already up', D.W.controls.length > 0, D.W.controls.length);
}
{
  const T = H.makeWin({ surface: 'desktop', home: { desk: [], phone: [] } });
  const W = T.W;
  W.location = { hash: '', pathname: '/', search: '' }; W.history = { replaceState() {} };
  W._impl.mount({ surface: 'desktop' });
  const pending = T.timers.filter((t) => t.fn && t.ms === 1500).length;
  ok('no 1.5 s poll waits for the system layer', pending === 0, pending);
  W.controls = [];
  W.NBDOS = { registerControl(def) { W.controls.push(def); }, unregisterControl() {} };
  W.dispatchEvent(new W.CustomEvent('nbd:os-system-ready'));
  ok('nbd:os-system-ready registers the tiles', W.controls.length > 0, W.controls.length);
}

console.log('20. the first click into a background window');
{
  const D = desk();
  D.launch('crm'); D.launch('money');
  ok('control: money in front', D.front() === 'money');
  const n = D.W.goTos.length;
  const body = D.win('crm').querySelector('.os-win-body');
  H.fire(D.T.dom, body, 'pointerdown', { clientX: 200, clientY: 300, pointerId: 9 });
  ok('pressing in a background window raises it at once', D.front() === 'crm', D.front());
  ok('…but does not route while the button is down', D.W.goTos.length === n, D.W.goTos.slice(n).join());
  H.fire(D.T.dom, body, 'pointerup', { clientX: 200, clientY: 300, pointerId: 9 });
  H.fire(D.T.dom, body, 'click', { clientX: 200, clientY: 300 });
  D.settle();
  ok('…it routes once the press (and its click) is over', D.W.goTos.slice(n).join() === 'crm', D.W.goTos.slice(n).join());
}
{
  // a touch press that turns into a scroll ends in pointercancel: the route still happens
  const D = desk();
  D.launch('crm'); D.launch('money');
  const n = D.W.goTos.length;
  const body = D.win('crm').querySelector('.os-win-body');
  H.fire(D.T.dom, body, 'pointerdown', { clientX: 200, clientY: 300, pointerId: 11 });
  H.fire(D.T.dom, body, 'pointercancel', { pointerId: 11 });
  D.settle();
  ok('a press that ends in pointercancel (touch scroll) still routes', D.W.goTos.slice(n).join() === 'crm', D.W.goTos.slice(n).join());
}
{
  // cycling with nothing in front: back goes to the last window, not one before it
  const D = desk();
  D.launch('crm'); D.launch('money'); D.launch('photos');
  ['crm', 'money', 'photos'].forEach((id) => H.click(D.T.dom, D.win(id).querySelector('[data-osw="min"]')));
  H.click(D.T.dom, D.doc.querySelector('.os-task[data-ostask="crm"]')); D.settle();
  H.click(D.T.dom, D.doc.querySelector('.os-task[data-ostask="money"]')); D.settle();
  H.click(D.T.dom, D.doc.querySelector('.os-task[data-ostask="photos"]')); D.settle();
  H.click(D.T.dom, D.win('photos').querySelector('[data-osw="min"]'));
  ok('control: money is in front after photos is minimised', D.front() === 'money', D.front());
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
