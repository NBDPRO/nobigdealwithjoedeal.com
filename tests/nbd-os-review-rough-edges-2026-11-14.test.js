/**
 * tests/nbd-os-review-rough-edges-2026-11-14.test.js — the eleven rough edges
 * (items 7-17) from the 2026-11-14 independent NBD OS review, each verified
 * against the code first.
 *
 *    7. Show desktop restored every window, including ones minimised before.
 *    8. A reopened app forgot its size / place; a new window landed exactly
 *       on an open one (the cascade slot was the window count).
 *    9. The minimum window size was a fraction (22%): ~170px on a tablet.
 *   10. Right-click silently pinned / unpinned; the 8-pin limit was silent.
 *   11. Start: Enter with no match opened search but dropped the text; no
 *       arrow keys through the results.
 *   12. A move / resize was lost if the tab closed within the 700 ms save.
 *   13. A touchscreen laptop (fine primary pointer) got mouse-size targets.
 *   14. The Start button's mark was a blank orange square.
 *   15. The app list was read once, 3 s after mount.
 *   16. The desk menu: Escape dropped focus; no arrow keys; no aria-expanded.
 *   17. Do Not Disturb kept holding toasts after the kill switch.
 *
 * Run: node tests/nbd-os-review-rough-edges-2026-11-14.test.js
 */
'use strict';
const H = require('./lib/nbd-os-home-harness.js');
const vm = require('vm');
const WM = require('../docs/pro/js/layouts/os-wm-logic.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}
const CSS = H.read('docs/pro/css/layouts/os.css');

function desk(opts) {
  const o = opts || {};
  const T = H.makeWin({ surface: 'desktop', home: { desk: [], phone: [] } });
  const W = T.W, doc = T.document;
  let mo = null;
  W.MutationObserver = function (cb) { mo = this; this.cb = cb; this.observe = () => {}; this.disconnect = () => { if (mo === this) mo = null; }; };
  W.location = { hash: '', pathname: '/pro/dashboard.html', search: '' };
  W.history = { replaceState: () => {} };
  W.goTo = (id) => {
    W.goTos.push(id);
    const views = doc.querySelectorAll('.view');
    views.forEach((v) => v.classList.remove('active'));
    const v = doc.getElementById('view-' + id);
    if (v) v.classList.add('active');
    if (mo) mo.cb(views.map((x) => ({ target: x })));
  };
  if (o.os) {
    const prefs = W.LayoutEngine.prefs;
    W.LayoutEngine.prefs = function () { const p = prefs.call(this); p.user.layoutState.os = o.os; return p; };
  }
  if (o.before) o.before(W, doc);
  W._impl.mount({ surface: 'desktop' });
  const settle = () => T.fire(0);
  const touch = (id) => { const v = doc.getElementById('view-' + id); if (mo && v) mo.cb([{ target: v }]); settle(); };
  const launch = (id) => { H.click(T.dom, doc.querySelector('.os-icon[data-osapp="' + id + '"]') || doc.querySelector('[data-osapp="' + id + '"]')); settle(); };
  const win = (id) => doc.querySelector('.os-win[data-win="' + id + '"]');
  const btn = (id, what) => { const w = win(id); return w && w.querySelector('[data-osw="' + what + '"]'); };
  const wins = () => doc.querySelectorAll('.os-win').map((w) => w.getAttribute('data-win'));
  const spy = () => doc.querySelectorAll('.os-win').forEach((el) => {
    el.__geo = el.__geo || {};
    el.style.setProperty = (k, v) => { el.__geo[k] = Number(v); };
  });
  const lastOs = () => { T.fire(700); const s = (W._saves || []).filter((x) => x.layoutState && x.layoutState.os); return s.length ? s[s.length - 1].layoutState.os : null; };
  return { T, W, doc, settle, touch, launch, win, btn, wins, spy, lastOs };
}

console.log('7. Show desktop puts back only what it hid');
{
  const D = desk();
  D.launch('crm'); D.launch('money'); D.launch('photos');
  H.click(D.T.dom, D.btn('money', 'min'));
  const show = D.doc.querySelector('[data-osdo="desktop"]');
  H.click(D.T.dom, show);
  ok('control: Show desktop hides every window', ['crm', 'money', 'photos'].every((id) => D.win(id).classList.contains('is-min')));
  H.click(D.T.dom, show);
  ok('pressing it again restores the two it hid', !D.win('crm').classList.contains('is-min') && !D.win('photos').classList.contains('is-min'));
  ok('…and the one minimised before stays minimised', D.win('money').classList.contains('is-min'));
  // per desk: Show desktop on desk 2 doesn't overwrite desk 1's memory
  H.click(D.T.dom, show);   // desk 1: hide crm + photos
  H.click(D.T.dom, D.doc.querySelector('[data-osdesk="1"]'));
  D.launch('calls');
  H.click(D.T.dom, show);   // desk 2: hide calls
  H.click(D.T.dom, D.doc.querySelector('[data-osdesk="0"]'));
  H.click(D.T.dom, D.doc.querySelector('[data-osdesk="0"]') && show);
  ok('Show desktop remembers each desk on its own', !D.win('crm').classList.contains('is-min') && !D.win('photos').classList.contains('is-min') && D.win('money').classList.contains('is-min'),
    ['crm', 'photos', 'money'].map((id) => id + ':' + D.win(id).classList.contains('is-min')).join(' '));
}

console.log('8. windows remember their place; new ones never stack exactly');
{
  const D = desk();
  D.launch('crm'); D.launch('money');
  D.spy();
  H.key(D.T.dom, D.win('money'), 'ArrowLeft', { ctrlKey: true, altKey: true });   // snap, then drag-free: use a resize to set a custom rect
  H.key(D.T.dom, D.win('money'), 'ArrowRight', { ctrlKey: true, altKey: true });  // back to free
  const grip = D.win('money').querySelector('[data-osw="grip"]');
  H.fire(D.T.dom, grip, 'pointerdown', { clientX: 900, clientY: 700, pointerId: 3 });
  H.fire(D.T.dom, grip, 'pointermove', { clientX: 800, clientY: 600, pointerId: 3 });
  H.fire(D.T.dom, grip, 'pointerup', { clientX: 800, clientY: 600, pointerId: 3 });
  const sized = Object.assign({}, D.win('money').__geo);
  H.click(D.T.dom, D.btn('money', 'close'));
  D.touch('money');
  D.launch('money');
  D.spy();
  H.click(D.T.dom, D.btn('money', 'max')); H.click(D.T.dom, D.btn('money', 'max'));   // repaint for the spy
  const back = D.win('money').__geo;
  ok('a reopened app comes back at the size it was closed at', Math.abs(back['--ww'] - sized['--ww']) < 0.002 && Math.abs(back['--wh'] - sized['--wh']) < 0.002, JSON.stringify({ sized, back }));
  const os = D.lastOs();
  ok('…and is saved with the layout', !!(os && os.rects && os.rects.money), JSON.stringify(os && os.rects));
  // reload: the saved rect is read back
  const D2 = desk({ os: Object.assign({}, os, { wins: [], focus: null, idle: true }) });
  D2.launch('money');
  D2.spy();
  H.click(D2.T.dom, D2.btn('money', 'max')); H.click(D2.T.dom, D2.btn('money', 'max'));
  const g = D2.win('money').__geo;
  ok('…and a reload opens it at that size (read back, not just written)', Math.abs(g['--ww'] - sized['--ww']) < 0.002, JSON.stringify({ sized, g }));
  // a phone visit carries them
  const T = H.makeWin({ surface: 'phone', home: { desk: [], phone: [] } });
  T.W.location = { hash: '', pathname: '/', search: '' }; T.W.history = { replaceState() {} };
  const prefs = T.W.LayoutEngine.prefs;
  T.W.LayoutEngine.prefs = function () { const p = prefs.call(this); p.user.layoutState.os = os; return p; };
  let pmo = null;
  T.W.MutationObserver = function (cb) { pmo = this; this.cb = cb; this.observe = () => {}; this.disconnect = () => {}; };
  T.W._impl.mount({ surface: 'phone' });
  // the router opens an app on the phone (phoneOpen saves the recents)
  const pv = T.document.getElementById('view-crm');
  pv.classList.add('active');
  if (pmo) pmo.cb([{ target: pv }]);
  T.fire(0); T.fire(700);
  const ph = (T.W._saves || []).filter((x) => x.layoutState && x.layoutState.os).map((x) => x.layoutState.os);
  ok('…and a phone visit keeps them (the phone saves the whole os key)', ph.length > 0 && ph.every((x) => x.rects && x.rects.money), JSON.stringify(ph.map((x) => x.rects)));
}
{
  // the newest rect is kept at the 40 cap
  let rects = {};
  for (let i = 0; i < 40; i++) rects = WM.rememberRect(rects, 'app' + i, { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
  rects = WM.rememberRect(rects, 'newest', { x: 0.2, y: 0.2, w: 0.4, h: 0.4 });
  ok('at the cap, the newest app\'s rect is kept', !!rects.newest && Object.keys(rects).length === 40, Object.keys(rects).length);
}
{
  const D = desk();
  D.launch('crm'); D.launch('money');
  H.click(D.T.dom, D.btn('crm', 'close'));
  D.touch('crm');
  D.launch('photos');
  D.spy();
  ['money', 'photos'].forEach((id) => { H.click(D.T.dom, D.btn(id, 'max')); H.click(D.T.dom, D.btn(id, 'max')); });
  const a = D.win('money').__geo, b = D.win('photos').__geo;
  ok('close A, open C: C does not land exactly on B', !(Math.abs(a['--wx'] - b['--wx']) < 0.001 && Math.abs(a['--wy'] - b['--wy']) < 0.001), JSON.stringify({ a, b }));
}

console.log('9. a pixel floor on window size');
{
  ok('minFrac exists', typeof WM.minFrac === 'function');
  const m = typeof WM.minFrac === 'function' ? WM.minFrac({ w: 820, h: 1000 }) : {};
  ok('on an 820px tablet the minimum width is >= 320px', m.w * 820 >= 319.5, JSON.stringify(m));
  const m2 = typeof WM.minFrac === 'function' ? WM.minFrac({ w: 1920, h: 1080 }) : {};
  ok('control: on a big screen the fraction still rules (22%)', Math.abs(m2.w - 0.22) < 0.001, JSON.stringify(m2));
  const D = desk();
  D.launch('crm');
  D.spy();
  const grip = D.win('crm').querySelector('[data-osw="grip"]');
  H.fire(D.T.dom, grip, 'pointerdown', { clientX: 900, clientY: 700, pointerId: 4 });
  H.fire(D.T.dom, grip, 'pointermove', { clientX: 0, clientY: 0, pointerId: 4 });
  H.fire(D.T.dom, grip, 'pointerup', { clientX: 0, clientY: 0, pointerId: 4 });
  const g = D.win('crm').__geo;
  ok('a size drag stops at the floor (1280px desk: max(22%, 320px) wide)', g['--ww'] * 1280 >= 319.5, JSON.stringify(g));
  // the floor is applied to the drawn rect (not CSS min-width, which ignores --wx and clipped
  // a right-edge window's buttons): a tiny saved window at the far right is drawn 320px wide, inside
  const D2 = desk({ os: { v: 1, wins: [{ id: 'crm', x: 0.9, y: 0.1, w: 0.1, h: 0.2, z: 1, min: false, zone: null, desk: 0 }], focus: 'crm', icons: [], dock: [], recent: [], desk: 0, pins: [] } });
  D2.spy();
  H.click(D2.T.dom, D2.btn('crm', 'max')); H.click(D2.T.dom, D2.btn('crm', 'max'));
  const g2 = D2.win('crm').__geo;
  ok('a tiny window at the right edge is drawn >= 320px wide and fully on the desk', g2['--ww'] * 1280 >= 319.5 && g2['--wx'] + g2['--ww'] <= 1.0001, JSON.stringify(g2));
  ok('…no CSS min-width that ignores the window\'s place', !/\.os-win\s*\{[^}]*min-width:\s*min\(/.test(CSS));
}

console.log('10. right-click is a menu, and the pin limit says so');
{
  const D = desk();
  D.launch('crm');
  const icon = D.doc.querySelector('.os-icon[data-osapp="money"]');
  H.fire(D.T.dom, icon, 'contextmenu');
  const menu = D.doc.querySelector('.os-ctxmenu');
  ok('right-click on an icon opens a menu, it does not pin', !!menu && menu.getAttribute('role') === 'menu' && D.doc.querySelectorAll('.os-task.is-pinned').length === 0, menu && menu.textContent);
  const items = menu ? menu.querySelectorAll('[role="menuitem"]').map((b) => b.textContent.trim()) : [];
  ok('…with Open and Pin to taskbar', items.indexOf('Open') !== -1 && items.indexOf('Pin to taskbar') !== -1, items.join('|'));
  ok('…focus is in the menu', !!D.doc.activeElement && menu && menu.contains(D.doc.activeElement));
  const pinItem = menu && menu.querySelectorAll('[role="menuitem"]').filter((b) => b.textContent.trim() === 'Pin to taskbar')[0];
  if (pinItem) H.click(D.T.dom, pinItem);
  ok('Pin to taskbar pins it and closes the menu', !!D.doc.querySelector('.os-task.is-pinned[data-ostask="money"]') && !D.doc.querySelector('.os-ctxmenu'));
  ok('…and focus goes back to the icon (not <body>)', D.doc.activeElement === icon, D.doc.activeElement && D.doc.activeElement.className);
  const out = D.doc.createElement('div'); D.doc.querySelector('.os-desk').appendChild(out);
  const ev = H.fire(D.T.dom, out, 'contextmenu');
  ok('right-click on desk space that is not an app keeps the browser\'s own menu', !ev.defaultPrevented && !D.doc.querySelector('.os-ctxmenu'));
  const task = D.doc.querySelector('.os-task[data-ostask="crm"]');
  H.fire(D.T.dom, task, 'contextmenu');
  const m2 = D.doc.querySelector('.os-ctxmenu');
  const it2 = m2 ? m2.querySelectorAll('[role="menuitem"]').map((b) => b.textContent.trim()) : [];
  ok('a running app\'s taskbar menu offers Close', it2.indexOf('Close') !== -1, it2.join('|'));
  key(D, 'Escape');
  ok('Escape closes the menu and returns focus to what was right-clicked', !D.doc.querySelector('.os-ctxmenu') && D.doc.activeElement && D.doc.activeElement.getAttribute && D.doc.activeElement.getAttribute('data-ostask') === 'crm', D.doc.activeElement && D.doc.activeElement.className);
}
function key(D, k, extra) { H.key(D.T.dom, D.doc.activeElement || D.doc.body, k, extra); }
{
  // the pin limit: eight pinned, then a ninth from Start
  const T = H.makeWin({ surface: 'desktop', nav: ['storm', 'maps'], home: { desk: [], phone: [] } });
  const W = T.W, doc = T.document;
  W.location = { hash: '', pathname: '/', search: '' }; W.history = { replaceState() {} };
  const prefs = W.LayoutEngine.prefs;
  W.LayoutEngine.prefs = function () { const p = prefs.call(this); p.user.layoutState.os = { v: 1, wins: [], focus: null, icons: [], dock: [], recent: [], desk: 0, pins: ['home', 'crm', 'schedule', 'calls', 'money', 'photos', 'settings', 'storm'] }; return p; };
  W._impl.mount({ surface: 'desktop' });
  ok('control: eight pinned (the limit)', doc.querySelectorAll('.os-task.is-pinned').length === 8, doc.querySelectorAll('.os-task.is-pinned').length);
  H.click(T.dom, doc.querySelector('.os-start-btn'));
  const pin = doc.querySelector('.os-start [data-ospin="maps"]');
  W.toasts.length = 0;
  if (pin) H.click(T.dom, pin);
  ok('pinning a ninth says the taskbar is full (a toast), not nothing', W.toasts.some((t) => /taskbar/i.test(t.msg) && /8|full/i.test(t.msg)), JSON.stringify(W.toasts));
  ok('…as a warning, which Do Not Disturb never holds', W.toasts.some((t) => /taskbar/i.test(t.msg) && t.kind === 'warning'), JSON.stringify(W.toasts));
}

console.log('11. Start search keeps the text; arrow keys move');
{
  const D = desk({ before: (W, doc) => {
    W.NBDCommand = { open: () => { W.searches++; const i = doc.createElement('input'); i.setAttribute('id', 'nbd-cmd-input'); i.id = 'nbd-cmd-input'; i.value = ''; i.events = []; i.dispatchEvent = (e) => { i.events.push(e.type); return true; }; doc.body.appendChild(i); } };
    W.Event = function (type) { this.type = type; };
  } });
  H.click(D.T.dom, D.doc.querySelector('.os-start-btn'));
  const input = D.doc.querySelector('.os-start input');
  input.value = 'zzqx roof';
  H.fire(D.T.dom, input, 'input');
  input.focus();
  H.key(D.T.dom, input, 'Enter');
  D.settle();
  const cmd = D.doc.getElementById('nbd-cmd-input');
  ok('control: no app matched, so search opened', D.W.searches === 1);
  ok('…with what was typed in its box', !!cmd && cmd.value === 'zzqx roof' && cmd.events.indexOf('input') !== -1, cmd && JSON.stringify({ v: cmd.value, e: cmd.events }));
}
{
  const D = desk();
  H.click(D.T.dom, D.doc.querySelector('.os-start-btn'));
  const input = D.doc.querySelector('.os-start input');
  input.focus();
  H.key(D.T.dom, input, 'ArrowDown');
  const a = D.doc.activeElement;
  ok('ArrowDown from the box moves to the first app', !!a && a.classList && a.classList.contains('os-start-app'), a && a.className);
  H.key(D.T.dom, a, 'ArrowDown');
  const b = D.doc.activeElement;
  ok('…and on to the next one', !!b && b !== a && b.classList.contains('os-start-app'), b && b.className);
  H.key(D.T.dom, b, 'ArrowUp');
  ok('ArrowUp goes back', D.doc.activeElement === a);
}

console.log('12. a pending save is written on pagehide');
{
  const D = desk();
  D.launch('crm');
  D.W._saves = [];
  H.click(D.T.dom, D.btn('crm', 'max'));
  ok('control: nothing written yet (700 ms debounce)', D.W._saves.filter((x) => x.layoutState && x.layoutState.os).length === 0);
  const ph = (D.T.winListeners.pagehide || []);
  ph.forEach((f) => f({ type: 'pagehide' }));
  const s = D.W._saves.filter((x) => x.layoutState && x.layoutState.os);
  ok('pagehide writes the window state at once', s.length === 1 && s[0].layoutState.os.wins[0].zone === 'max', JSON.stringify(s));
}
{
  const D = desk();
  D.launch('crm');
  D.W._saves = [];
  H.click(D.T.dom, D.btn('crm', 'max'));
  D.doc.visibilityState = 'hidden';
  (D.doc.listeners.visibilitychange || []).forEach((f) => f({ type: 'visibilitychange' }));
  const s = D.W._saves.filter((x) => x.layoutState && x.layoutState.os);
  ok('the tab going hidden writes it too (pagehide is often skipped on iOS)', s.length === 1, s.length);
}

console.log('13. touch targets on a touchscreen laptop');
ok('touch sizing keys on any-pointer: coarse (a touchscreen laptop has a fine primary pointer)', /@media \(any-pointer: coarse\)/.test(CSS) && !/@media \(pointer: coarse\)/.test(CSS));
ok('Start\'s pin is visible without hover on a touch screen', /@media \(any-pointer: coarse\)\s*\{[^@]*\.os-start-pin\s*\{[^}]*opacity:\s*\.8/.test(CSS));

console.log('14. the Start button wears a real mark');
{
  const D = desk();
  const mark = D.doc.querySelector('.os-start-btn .os-start-mark');
  ok('the Start mark is an image (the NBD Pro icon), not an empty orange span', !!mark && !!mark.querySelector('img'), mark && JSON.stringify(mark.children.map((c) => c.tagName)));
  ok('…and the CSS has no orange fill behind an image mark', !/\.os-start-mark\s*\{[^}]*background:\s*var\(--orange\)/.test(CSS));
  // the system layer comes up later with the company's letters: the Start button follows
  D.W.NBDOS = { mark: () => ({ kind: 'text', text: 'OR' }), registerControl() {}, unregisterControl() {} };
  D.W.dispatchEvent(new D.W.CustomEvent('nbd:os-system-ready'));
  const m2 = D.doc.querySelector('.os-start-btn .os-start-mark');
  ok('when the system layer comes up, the Start mark shows the company mark', !!m2 && /OR/.test(m2.textContent), m2 && m2.textContent);
}

console.log('15. the app list follows the claims');
{
  const T = H.makeWin({ surface: 'desktop', claims: null, home: { desk: [], phone: [] } });
  const W = T.W, doc = T.document;
  W._userClaims = undefined;
  W.location = { hash: '', pathname: '/', search: '' }; W.history = { replaceState() {} };
  W._impl.mount({ surface: 'desktop' });
  // the sidebar fills in per role after auth: a new app appears
  const b = doc.createElement('button');
  b.setAttribute('data-action', 'goTo'); b.setAttribute('data-target', 'storm'); b.setAttribute('aria-label', 'STORM');
  doc.querySelector('.sidebar').appendChild(b);
  const v = doc.createElement('div'); v.className = 'view'; v.id = 'view-storm'; v.setAttribute('id', 'view-storm');
  doc.querySelector('.content').appendChild(v);
  W._userClaims = { role: 'owner', companyId: 'c1' };
  T.fire(500);
  ok('when the claims land, the new app is on the desktop (not only after the 3 s read)', !!doc.querySelector('.os-icon[data-osapp="storm"]'));
}

console.log('16. the desk menu');
{
  const D = desk();
  D.launch('crm');
  const anchor = D.btn('crm', 'desk');
  anchor.focus();
  H.click(D.T.dom, anchor);
  ok('⧉ says the menu is open (aria-expanded)', anchor.getAttribute('aria-expanded') === 'true');
  const first = D.doc.activeElement;
  key(D, 'ArrowDown');
  ok('ArrowDown moves through the menu', D.doc.activeElement !== first && D.doc.activeElement.getAttribute('role') === 'menuitem', D.doc.activeElement && D.doc.activeElement.className);
  key(D, 'Escape');
  ok('Escape closes it and returns focus to ⧉', !D.doc.querySelector('.os-deskmenu') && D.doc.activeElement === anchor && anchor.getAttribute('aria-expanded') === 'false', D.doc.activeElement && D.doc.activeElement.className);
}

console.log('17. Do Not Disturb after the kill switch');
{
  const T = H.makeWin({ surface: 'desktop', home: { desk: [], phone: [] } });
  const W = T.W;
  const shown = [];
  W.showToast = (m) => { shown.push(m); };
  vm.runInContext(H.read('docs/pro/js/os/system-logic.js'), W, { filename: 'system-logic.js' });
  vm.runInContext(H.read('docs/pro/js/os/system.js'), W, { filename: 'system.js' });
  T.fire(0); T.fire(50);
  W.NBDOS.setDnd(true);
  W.showToast('held while on');
  ok('control: Do Not Disturb holds a toast', shown.indexOf('held while on') === -1);
  W.NBDOS.off();
  W.showToast('after the kill switch');
  ok('after the kill switch a toast shows again', shown.indexOf('after the kill switch') !== -1, JSON.stringify(shown));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
