/**
 * tests/nbd-os-review-bugs-2026-11-14.test.js — the six bugs from the
 * 2026-11-14 independent NBD OS review (side-session notes,
 * nbd-os-review-20-findings-2026-11-14.md), each verified against the code
 * before the fix.
 *
 *   1. An empty desktop is not remembered: with every window closed, a reload
 *      opened a Home window (view-home ships .active and the restore fell back
 *      to the active view). A real deep link (#/crm) still opens its app.
 *   2. The resize grip on a half / quarter snapped window did nothing and
 *      overwrote the saved free size. Now a resize starts from the snapped
 *      rect and leaves the snap (Windows' behaviour).
 *   3. Resizing past the right / bottom edge slid the window left / up
 *      (clampFrac caps w, then moves x). A resize now caps the size instead.
 *   4. The Control Center rebuilt its body on every toggle (and every
 *      refresh), so keyboard focus fell to <body> and the Tab trap leaked.
 *   5. Opening or switching to a window left keyboard focus behind (on
 *      <body>, a hidden Start input or a re-rendered taskbar button).
 *   6. A phone in landscape (coarse pointer, short screen) got the windowed
 *      desktop; the taskbar had no safe-area inset.
 *
 * Run: node tests/nbd-os-review-bugs-2026-11-14.test.js
 */
'use strict';
const H = require('./lib/nbd-os-home-harness.js');
const vm = require('vm');
const R = require('../docs/pro/js/layout-system.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}
const CSS = H.read('docs/pro/css/layouts/os.css');

/** opts: os (saved layoutState.os), active (view id active before mount), hash */
function desk(opts) {
  const o = opts || {};
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
    W.location.hash = '#/' + id;   // dashboard-actions.js goTo writes the hash
    if (mo) mo.cb(views.map((x) => ({ target: x })));
  };
  W.location = { hash: o.hash || '', pathname: '/pro/dashboard.html', search: '' };
  W.history = { replaceState: (s, t, url) => { W.location.hash = String(url).indexOf('#') >= 0 ? String(url).slice(String(url).indexOf('#')) : ''; } };
  if (o.os) {
    const prefs = W.LayoutEngine.prefs;
    W.LayoutEngine.prefs = function () { const p = prefs.call(this); p.user.layoutState.os = o.os; return p; };
  }
  if (o.active) doc.getElementById('view-' + o.active).classList.add('active');
  W._impl.mount({ surface: 'desktop' });
  const settle = () => T.fire(0);
  const touch = (id) => { const v = doc.getElementById('view-' + id); if (mo && v) mo.cb([{ target: v }]); settle(); };
  const launch = (id) => { H.click(T.dom, doc.querySelector('[data-osapp="' + id + '"]')); settle(); };
  const win = (id) => doc.querySelector('.os-win[data-win="' + id + '"]');
  const btn = (id, what) => { const w = win(id); return w && w.querySelector('[data-osw="' + what + '"]'); };
  const wins = () => doc.querySelectorAll('.os-win').map((w) => w.getAttribute('data-win'));
  const lastOs = () => { T.fire(700); const s = (W._saves || []).filter((x) => x.layoutState && x.layoutState.os); return s.length ? s[s.length - 1].layoutState.os : null; };
  return { T, W, doc, settle, touch, launch, win, btn, wins, lastOs };
}
// window geometry the layout wrote (--wx/--wy/--ww/--wh)
function geo(el) { return el && el.__geo; }

console.log('1. an empty desktop is remembered');
{
  const D = desk({ active: 'home' });
  D.launch('crm');
  ok('control: Home (the active view) and CRM are open, the URL names CRM', D.wins().sort().join() === 'crm,home' && D.W.location.hash === '#/crm', D.wins().join() + ' ' + D.W.location.hash);
  H.click(D.T.dom, D.btn('crm', 'close'));
  D.touch('crm');
  H.click(D.T.dom, D.btn('home', 'close'));
  D.touch('home');
  const os = D.lastOs();
  ok('control: closing the last window saves an empty desk', !!os && os.wins.length === 0, JSON.stringify(os));
  ok('…and drops the closed app from the URL (a reload is not a deep link to it)', D.W.location.hash === '', D.W.location.hash);
  const D2 = desk({ os, active: 'home' });
  ok('THE BUG: a reload with that state opens no window (not Home)', D2.wins().length === 0, D2.wins().join());
  D2.touch('money');
  ok('…and the next view-class change does not open Home either', D2.wins().length === 0, D2.wins().join());
  const D3 = desk({ os, active: 'crm', hash: '#/crm' });
  ok('a real deep link (#/crm) still opens its app on an empty desk', D3.wins().join() === 'crm', D3.wins().join());
  const D4 = desk({ active: 'home' });
  ok('control: no saved state at all (first use) still opens the active view', D4.wins().join() === 'home', D4.wins().join());
  // from the silent-failure review of this fix:
  const D5 = desk({ os, active: 'crm', hash: '#crm' });
  ok('a deep link in the router\'s other form (#crm) also opens its app', D5.wins().join() === 'crm', D5.wins().join());
  const D6 = desk({ os, active: 'home', hash: '#section-2' });
  ok('an idle mount keeps a fragment that is not a route', D6.W.location.hash === '#section-2' && D6.wins().length === 0, D6.W.location.hash + ' ' + D6.wins().join());
  const saved = { v: 1, wins: [{ id: 'money', x: 0.1, y: 0.1, w: 0.5, h: 0.5, z: 1, min: false, zone: null, desk: 0 }], focus: 'money', icons: [], dock: [], recent: [], desk: 0, pins: [] };
  const D7 = desk({ os: saved, active: 'crm', hash: '#/crm' });
  const front = D7.doc.querySelector('.os-win.is-focus');
  ok('a deep link wins over the saved front window', !!front && front.getAttribute('data-win') === 'crm', D7.wins().join());
}
{
  // a save made on the phone surface never marks the desktop idle
  const T = H.makeWin({ surface: 'phone', home: { desk: [], phone: [] } });
  T.W.location = { hash: '', pathname: '/', search: '' }; T.W.history = { replaceState() {} };
  // the phone surface has no window in front by design: writeState must not read that as an empty desk
  ok('a phone save is never idle', /idle: src\.surface !== 'phone' && !src\.focus/.test(H.read('docs/pro/js/layouts/os.js')));
}

// geometry spy: placeWin writes --wx/--wy/--ww/--wh with style.setProperty
function spyGeo(D) {
  D.doc.querySelectorAll('.os-win').forEach((el) => {
    el.__geo = el.__geo || {};
    el.style.setProperty = (k, v) => { el.__geo[k] = Number(v); };
  });
}

console.log('2. the grip on a snapped window');
{
  const D = desk();
  D.launch('crm');
  spyGeo(D);
  H.key(D.T.dom, D.win('crm'), 'ArrowLeft', { ctrlKey: true, altKey: true });
  ok('control: Ctrl+Alt+Left snaps it to the left half', D.win('crm').classList.contains('is-snapped'));
  const grip = D.win('crm').querySelector('[data-osw="grip"]');
  H.fire(D.T.dom, grip, 'pointerdown', { clientX: 640, clientY: 800, pointerId: 7 });
  H.fire(D.T.dom, grip, 'pointermove', { clientX: 540, clientY: 700, pointerId: 7 });
  H.fire(D.T.dom, grip, 'pointerup', { clientX: 540, clientY: 700, pointerId: 7 });
  const g = geo(D.win('crm'));
  ok('resizing a snapped window leaves the snap', !D.win('crm').classList.contains('is-snapped'));
  ok('…and resizes from the snapped rect (left half, now ~100px narrower)', g && Math.abs(g['--wx']) < 0.001 && Math.abs(g['--ww'] - (540 / 1280)) < 0.01, JSON.stringify(g));
}

console.log('3. resizing past the edge');
{
  const D = desk();
  D.launch('crm');
  spyGeo(D);
  const before = Object.assign({}, geo(D.win('crm')));
  H.click(D.T.dom, D.btn('crm', 'max'));   // paint once so the spy has the start
  H.click(D.T.dom, D.btn('crm', 'max'));
  const g0 = Object.assign({}, geo(D.win('crm')));
  const grip = D.win('crm').querySelector('[data-osw="grip"]');
  H.fire(D.T.dom, grip, 'pointerdown', { clientX: 900, clientY: 700, pointerId: 8 });
  H.fire(D.T.dom, grip, 'pointermove', { clientX: 1600, clientY: 1100, pointerId: 8 });
  H.fire(D.T.dom, grip, 'pointerup', { clientX: 1600, clientY: 1100, pointerId: 8 });
  const g = geo(D.win('crm'));
  ok('control: the window had a left edge', g0['--wx'] > 0.01, JSON.stringify(g0));
  ok('dragging the grip past the right edge keeps the left edge where it was', g && Math.abs(g['--wx'] - g0['--wx']) < 0.001, JSON.stringify({ g0, g }));
  ok('…and the top edge', g && Math.abs(g['--wy'] - g0['--wy']) < 0.001, JSON.stringify({ g0, g }));
  ok('…the size stops at the desk edge', g && Math.abs(g['--wx'] + g['--ww'] - 1) < 0.002 && Math.abs(g['--wy'] + g['--wh'] - 1) < 0.002, JSON.stringify(g));
}

console.log('4. Control Center keeps keyboard focus');
{
  const T = H.makeWin({ surface: 'desktop', home: { desk: [], phone: [] } });
  const W = T.W, doc = T.document;
  W.nbdSetModePref = () => {};
  W.nbdComfortSet = () => {};
  vm.runInContext(H.read('docs/pro/js/os/system-logic.js'), W, { filename: 'system-logic.js' });
  vm.runInContext(H.read('docs/pro/js/os/system.js'), W, { filename: 'system.js' });
  T.fire(0); T.fire(50);
  ok('control: the system layer is up', !!W.NBDOS && typeof W.NBDOS.open === 'function');
  W.NBDOS.open('control');
  const sw = doc.querySelector('#osSheetBody [data-os="set"][data-key="motion"]');
  ok('control: a Reduce motion switch is listed', !!sw);
  sw.focus();
  H.click(T.dom, sw);
  T.fire(30); T.fire(50);
  const a = doc.activeElement;
  ok('THE BUG: after the toggle repaint, focus is on the same switch (not <body>)', !!a && a.isConnected && a.getAttribute('data-key') === 'motion', a && (a.className + ' connected=' + a.isConnected));
  W.NBDOS.refresh(); T.fire(50);
  const b = doc.activeElement;
  ok('…and after a background refresh too', !!b && b.isConnected && b.getAttribute('data-key') === 'motion', b && b.className);
}

console.log('5. focus follows the window you open');
{
  const D = desk();
  H.click(D.T.dom, D.doc.querySelector('.os-start-btn'));
  const input = D.doc.querySelector('.os-start input');
  input.focus();
  H.key(D.T.dom, input, 'Enter');
  D.settle();
  const id = D.wins()[0];
  const a = D.doc.activeElement;
  ok('opening from Start puts focus in the new window', !!id && !!a && a.isConnected && D.win(id).contains(a), a && a.className);
  D.launch('money');
  H.click(D.T.dom, D.btn('money', 'min'));
  const task = D.doc.querySelector('.os-task[data-ostask="money"]');
  task.focus();
  H.click(D.T.dom, task);
  D.settle();
  const b = D.doc.activeElement;
  ok('restoring from the taskbar puts focus in that window', !!b && b.isConnected && D.win('money').contains(b), b && (b.className + ' connected=' + b.isConnected));
}
{
  // control: the mount's own restore never steals focus from what the page focused
  const D = desk({ os: { v: 1, wins: [{ id: 'crm', x: 0.1, y: 0.1, w: 0.5, h: 0.5, z: 1, min: false, zone: null, desk: 0 }], focus: 'crm', icons: [], dock: [], recent: [], desk: 0, pins: [] } });
  ok('control: restoring a saved window on load does not move focus', D.doc.activeElement === null, D.doc.activeElement && D.doc.activeElement.className);
}

console.log('6. a phone in landscape is a phone');
// third argument: the device screen's SHORT side (min(screen.width, screen.height))
ok('iPhone landscape (844 wide, 390 screen short side, touch) -> phone', R.surfaceFor(844, true, 390) === 'phone', R.surfaceFor(844, true, 390));
ok('an iPad in portrait with the keyboard up (810 wide; its SCREEN short side is still 810) stays tablet', R.surfaceFor(810, true, 810) === 'tablet', R.surfaceFor(810, true, 810));
ok('big phone landscape (932x430, touch) -> phone', R.surfaceFor(932, true, 430) === 'phone', R.surfaceFor(932, true, 430));
ok('control: iPad landscape (1180x820, touch) -> tablet', R.surfaceFor(1180, true, 820) === 'tablet');
ok('control: a short laptop window (1280x400, mouse) -> desktop', R.surfaceFor(1280, false, 400) === 'desktop');
ok('control: old two-argument calls still work', R.surfaceFor(700, false) === 'phone' && R.surfaceFor(1000, true) === 'tablet');
const LS = H.read('docs/pro/js/layout-system.js');
ok('the live surface passes the screen\'s short side, not the viewport height',
  /R\.surfaceFor\(window\.innerWidth[^;]*screenShort\(\)/.test(LS) && /Math\.min\(s\.width, s\.height\)/.test(LS));
{
  // the two pre-paint copies of the rule agree with surfaceFor (else a landscape phone flashes the desktop first)
  const I = require('../docs/pro/js/layouts/island-job.js');
  const cache = { byDevice: { phone: 'island' } };
  ok('island-job wantsIsland agrees: a landscape phone is a phone', I.wantsIsland && I.wantsIsland(cache, 844, true, 390) === true);
  ok('control: …and an iPad landscape is not', I.wantsIsland && I.wantsIsland(cache, 1180, true, 820) === false);
  const PRE = H.read('docs/pro/js/shape-preboot.js');
  ok('shape-preboot mirrors the landscape-phone rule', /coarse && hh > 0 && hh <= 500 && w <= 1000/.test(PRE));
}
ok('the taskbar clears the home indicator (safe-area inset)', /\.os-taskbar[^{]*\{[^}]*safe-area-inset-bottom/.test(CSS));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
