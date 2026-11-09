/**
 * tests/nbd-os-privacy-2026-11-09.test.js — NBD OS P3, the privacy lock (design
 * §6 #11): docs/pro/js/os/privacy.js (the lazy `osprivacy` bundle, loaded by
 * layouts/os.js) calling the system layer's lock() (os/system.js).
 *
 * Checks:
 *   - pure: the stored corner (top left refused: the runner's), the corner box
 *     for each corner, the Ctrl+Alt+L test (Shift / Meta / repeat / AltGr and
 *     composed letters refused), tap and double-tap timing and distance;
 *   - laptop, the REAL desk + system layer in the fake DOM: the hot corner is
 *     off by default and costs nothing; once a corner is picked, a 250 ms
 *     dwell locks; leaving early, a touch pointer, a held button, a window or
 *     a control in the corner, and the runner's top-left corner never lock;
 *     after a lock the pointer must leave the corner first;
 *   - the keyboard path: Ctrl+Alt+L locks (also from inside a field), a bare L
 *     or AltGr+L never does;
 *   - a dirty form in a window: it still locks, and the window, the field, what
 *     was typed and the focus are all there after unlock;
 *   - the a11y announcement: a polite status line inside the lock screen says
 *     how it locked;
 *   - the Control Center tile "Privacy lock" and its sheet: corners offered
 *     (never top left), the pick is stored on this device, the status line
 *     says it; unmount takes the tile and every listener down;
 *   - phone: double-tap is off by default; once on, a double tap on an empty
 *     spot of the home pages locks; taps on a widget or an icon, in edit mode,
 *     with an app open, a drag, a slow pair, a long press or a pinch never do;
 *   - loading: nothing loads at mount until an opt-in is on (this device's
 *     keys); the first Ctrl+Alt+L or the tile loads the bundle;
 *   - wiring: lazy (no new script tag), no style attributes, no inline
 *     handlers, no Firestore / network, css tokens only, no motion, floors.
 *
 * Zero deps. Run: node tests/nbd-os-privacy-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

const FILE = 'docs/pro/js/os/privacy.js';
const CSSF = 'docs/pro/css/os/privacy.css';
if (!fs.existsSync(path.join(ROOT, FILE))) {
  ok('os/privacy.js exists', false, FILE + ' is missing');
  console.log('\nFAILED ' + failed);
  process.exit(1);
}

// ── pure ───────────────────────────────────────────────────────────────
console.log('\nNBD OS privacy lock: pure');
const P = require(path.join(ROOT, FILE))._pure;
ok('a stored corner: tr / br / bl kept; top left (the runner\'s) and junk are off',
  P.normCorner('tr') === 'tr' && P.normCorner('br') === 'br' && P.normCorner('bl') === 'bl' &&
  P.normCorner('tl') === '' && P.normCorner('x') === '' && P.normCorner(null) === '' && P.CORNERS.indexOf('tl') === -1);
ok('top right: within 2px of the top-right only', P.inCorner('tr', 1279, 0, 1280, 800) && P.inCorner('tr', 1277, 2, 1280, 800) &&
  !P.inCorner('tr', 1276, 0, 1280, 800) && !P.inCorner('tr', 1279, 3, 1280, 800));
ok('bottom right', P.inCorner('br', 1279, 799, 1280, 800) && !P.inCorner('br', 1279, 790, 1280, 800) && !P.inCorner('br', 0, 799, 1280, 800));
ok('bottom left', P.inCorner('bl', 0, 799, 1280, 800) && P.inCorner('bl', 2, 797, 1280, 800) && !P.inCorner('bl', 3, 799, 1280, 800));
ok('the top-left corner is never a lock corner, whatever is stored', !P.inCorner('tl', 0, 0, 1280, 800) && !P.inCorner('tr', 0, 0, 1280, 800));
ok('no viewport or off-screen points: never', !P.inCorner('br', 0, 0, 0, 0) && !P.inCorner('br', -1, 799, 1280, 800) && !P.inCorner('br', 1281, 799, 1280, 800));
const K = (extra) => Object.assign({ ctrlKey: true, altKey: true, code: 'KeyL', key: 'l' }, extra || {});
ok('Ctrl+Alt+L is the lock key', P.isLockKey(K(), false));
ok('…on a Mac too (Control+Option+L may report a different key, the code is L)', P.isLockKey(K({ key: '¬' }), false));
ok('…without a code, the letter L', P.isLockKey({ ctrlKey: true, altKey: true, key: 'L' }, false));
ok('Shift, Meta, a held-down repeat or a missing modifier: no',
  !P.isLockKey(K({ shiftKey: true }), false) && !P.isLockKey(K({ metaKey: true }), false) && !P.isLockKey(K({ repeat: true }), false) &&
  !P.isLockKey(K({ ctrlKey: false }), false) && !P.isLockKey(K({ altKey: false }), false) && !P.isLockKey({ key: 'l', code: 'KeyL' }, false));
ok('another key: no', !P.isLockKey(K({ code: 'KeyO', key: 'o' }), false));
ok('AltGr (Ctrl+Alt on Windows) writing a letter: no', !P.isLockKey(K({ key: 'ł', getModifierState: (m) => m === 'AltGraph' }), true) &&
  !P.isLockKey(K({ key: 'ł' }), true));
ok('a tap: short and still', P.isTap({ x: 10, y: 10, t: 0 }, { x: 14, y: 12, t: 120 }) && !P.isTap({ x: 10, y: 10, t: 0 }, { x: 30, y: 10, t: 100 }) &&
  !P.isTap({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 600 }));
ok('a double tap: within 300 ms and 30 px of the first', P.isDouble({ x: 10, y: 10, t: 0 }, { x: 20, y: 18, t: 250 }) &&
  !P.isDouble({ x: 10, y: 10, t: 0 }, { x: 10, y: 10, t: 400 }) && !P.isDouble({ x: 10, y: 10, t: 0 }, { x: 80, y: 10, t: 100 }) && !P.isDouble(null, { x: 1, y: 1, t: 1 }));
ok('the dwell is 250 ms', P.DWELL_MS === 250);

// ── the real layout + system layer ──────────────────────────────────────
function boot(surface, store) {
  const T = H.makeWin({ surface, loader: true, store });
  T.W.innerWidth = surface === 'phone' ? 390 : 1280;
  T.W.innerHeight = surface === 'phone' ? 844 : 800;
  vm.runInContext(read('docs/pro/js/os/system.js'), T.W, { filename: 'docs/pro/js/os/system.js' });
  const reg = T.W.NBDOS.registerControl, unreg = T.W.NBDOS.unregisterControl;
  T.tiles = [];
  T.W.NBDOS.registerControl = (d) => { T.tiles = T.tiles.filter((x) => x.id !== d.id).concat([d]); return reg(d); };
  T.W.NBDOS.unregisterControl = (id) => { T.tiles = T.tiles.filter((x) => x.id !== id); return unreg(id); };
  T.W._impl.mount({ surface });
  return T;
}
const tile = (T) => T.tiles.filter((t) => t.id === 'os-privacy')[0];
const isLocked = (T) => T.W.NBDOS.isLocked() && !!T.document.getElementById('osLock');
const moves = (T) => (T.document.listeners.pointermove || []).length;
const flush = () => new Promise((r) => setImmediate(r));

function desk() {
  console.log('\nNBD OS privacy lock: laptop desk (hot corner, keys, a dirty form)');
  const T = boot('desktop');
  const W = T.W, D = T.document;
  const deskEl = D.getElementById('osDesk');
  const body = D.body;
  const key = (target, k, mods) => H.fire(T.dom, target, 'keydown', Object.assign({ key: k }, mods || {}));
  let pm0 = 0, moveFn = null;
  return flush().then(() => {
    ok('nothing switched on: mount loads nothing (no osprivacy bundle)', W.ScriptLoader.calls.indexOf('osprivacy') === -1 && !W.NBDOSPrivacy, W.ScriptLoader.calls.join());
    const t = tile(T);
    ok('the Control Center has a "Privacy lock" tile (layouts/os.js)', !!t && t.label === 'Privacy lock');
    ok('…whose hint names the key', !!t && t.hint() === 'Ctrl+Alt+L');
    key(body, 'l');
    ok('a bare L loads nothing and never locks (WCAG 2.1.4)', !isLocked(T) && !W.NBDOSPrivacy);
    return flush();
  }).then(() => {
    key(body, 'l', { ctrlKey: true, altKey: true, code: 'KeyL' });
    return flush();
  }).then(() => {
    ok('the first Ctrl+Alt+L loads the osprivacy bundle (runtime, from layouts/os.js) and locks', W.ScriptLoader.calls.indexOf('osprivacy') >= 0 && !!W.NBDOSPrivacy && isLocked(T));
    ok('the bundle brings its stylesheet', (W.ScriptLoader.bundles.osprivacy || []).some((s) => /css\/os\/privacy\.css/.test(s)));
    T.fire(150);
    ok('…and the lock screen says so (a11y announcement)', H.text(D.querySelector('#osLock .os-pv-sr')) === P.MSG.key);
    W.NBDOS.unlock();
    const ev = key(body, 'l', { ctrlKey: true, altKey: true, code: 'KeyL' });
    ok('once attached, Ctrl+Alt+L locks at once, the key taken', isLocked(T) && ev.defaultPrevented === true);
    W.NBDOS.unlock();
    key(body, 'ł', { ctrlKey: true, altKey: true, code: 'KeyL', getModifierState: (m) => m === 'AltGraph' });
    ok('AltGr+L (a Polish ł) never locks', !isLocked(T));
    const T2 = boot('desktop');
    H.fire(T2.dom, T2.document.body, 'keydown', { key: 'ł', ctrlKey: true, altKey: true, code: 'KeyL', getModifierState: (m) => m === 'AltGraph' });
    return flush().then(() => {
      ok('…nor as the first key, before the bundle is in', !isLocked(T2));
      T2.W._impl.unmount();
    });
  }).then(() => {
    const mv = (x, y, extra, target) => H.fire(T.dom, target || body, 'pointermove', Object.assign({ clientX: x, clientY: y, pointerType: 'mouse', buttons: 0 }, extra || {}));
    pm0 = moves(T);
    let reads = 0;
    const gi = W.localStorage.getItem;
    W.localStorage.getItem = (k) => { if (k === P.CORNER_KEY) reads++; return gi(k); };
    [[1279, 0], [1279, 799], [0, 799], [0, 0]].forEach(([x, y]) => { mv(x, y); T.fire(250); });
    ok('the hot corner is off by default: no corner locks', !isLocked(T));
    ok('…and costs nothing while off: no listener of its own, no storage read per move', moves(T) === pm0 && reads <= 1, moves(T) + ' / ' + reads);

    W.NBDOSPrivacy.corner.set('br');
    ok('picking a corner adds the one pointermove listener', moves(T) === pm0 + 1);
    moveFn = T.document.listeners.pointermove[T.document.listeners.pointermove.length - 1];
    ok('the pick is stored on this device', T.store[P.CORNER_KEY] === 'br');
    ok('the tile\'s hint names the corner', tile(T).hint() === 'Corner: bottom right');
    mv(1279, 799); mv(600, 400); T.fire(250);
    ok('leaving the corner before 250 ms cancels it', !isLocked(T));
    mv(1279, 799, { pointerType: 'touch' }); T.fire(250);
    ok('a touch pointer never locks', !isLocked(T));
    mv(1279, 799, { buttons: 1 }); T.fire(250);
    ok('a held button (a drag into the corner) never locks', !isLocked(T));
    mv(0, 0); T.fire(250);
    ok('the runner\'s top-left corner never locks', !isLocked(T));
    const win = D.createElement('div'); win.className = 'os-win';
    const winBtn = D.createElement('button'); win.appendChild(winBtn);
    deskEl.querySelector('.os-wins').appendChild(win);
    mv(1279, 799, null, winBtn); T.fire(250);
    mv(1279, 799, null, win); T.fire(250);
    ok('the pointer over a window or a control in the corner never locks', !isLocked(T));
    const reads0 = reads;
    mv(1278, 798, null, deskEl.querySelector('.os-taskbar'));
    T.fire(250);
    ok('resting 250 ms in the chosen corner (the taskbar\'s bare edge) locks', isLocked(T));
    ok('the setting is cached: no storage read per move', reads === reads0, reads - reads0);
    const sr = D.querySelector('#osLock .os-pv-sr');
    ok('a status line inside the lock screen (role=status, polite), empty at first', !!sr && sr.getAttribute('role') === 'status' && sr.getAttribute('aria-live') === 'polite' && sr.textContent === '');
    T.fire(150);
    ok('…then says how it locked (a11y announcement)', !!sr && sr.textContent === P.MSG.corner, sr && sr.textContent);
    ok('the lock screen shows counts only (no names): the system layer\'s cover', /Unlock/.test(H.text(D.getElementById('osLock'))));
    W.NBDOS.unlock();
    mv(1279, 799, null, deskEl.querySelector('.os-taskbar')); T.fire(250);
    ok('after unlock, staying in the corner does not lock again', !isLocked(T));
    mv(500, 500); mv(1279, 799, null, deskEl.querySelector('.os-taskbar')); T.fire(250);
    ok('leaving the corner and coming back locks again', isLocked(T));
    W.NBDOS.unlock();

    // a dirty form in a window: it still locks, nothing is lost
    const fwin = D.createElement('div'); fwin.className = 'os-win';
    const form = D.createElement('form'); const field = D.createElement('textarea'); field.value = 'half a note about the roof';
    form.appendChild(field); fwin.appendChild(form); deskEl.querySelector('.os-wins').appendChild(fwin);
    field.focus();
    key(field, 'l', { ctrlKey: true, altKey: true, code: 'KeyL' });
    ok('a dirty form in a window: Ctrl+Alt+L from inside the field still locks', isLocked(T));
    ok('…and the window and its field stay where they were, as typed', fwin.isConnected && field.isConnected && field.value === 'half a note about the roof');
    W.NBDOS.unlock();
    ok('after unlock: the same field, the same text, focus back in it', field.isConnected && field.value === 'half a note about the roof' && D.activeElement === field);
    key(body, 'l', { ctrlKey: true, altKey: true, code: 'KeyL' });
    const lk = D.getElementById('osLock');
    key(body, 'l', { ctrlKey: true, altKey: true, code: 'KeyL' });
    ok('Ctrl+Alt+L while locked does nothing more (one cover, one status line)', D.getElementById('osLock') === lk && D.querySelectorAll('#osLock .os-pv-sr').length === 1);
    W.NBDOS.unlock();

    // the settings sheet
    W.NBDOSPrivacy.corner.set('');
    ok('the corner off again takes the listener away', moves(T) === pm0);
    tile(T).run();
    return flush();
  }).then(() => {
    const mv = (x, y, extra, target) => H.fire(T.dom, target || body, 'pointermove', Object.assign({ clientX: x, clientY: y, pointerType: 'mouse', buttons: 0 }, extra || {}));
    const dlg = D.querySelector('dialog.os-pv');
    if (dlg) { const base = dlg.matches.bind(dlg); dlg.matches = (sel) => (sel === ':modal' ? !!dlg.open : base(sel)); }   // the fake DOM's :modal
    ok('the tile opens the Privacy lock sheet (a native modal dialog)', !!dlg && dlg.open === true && dlg.getAttribute('aria-label') === 'Privacy lock');
    const radios = dlg ? dlg.querySelectorAll('input[data-pv="corner"]') : [];
    const vals = radios.map((r) => r.getAttribute('value'));
    ok('it offers Off, top right, bottom right, bottom left: never top left', vals.join() === ',tr,br,bl', vals.join());
    ok('Off is checked while no corner is set, and has focus', radios[0] && radios[0].hasAttribute('checked') && D.activeElement === radios[0]);
    ok('it names the key path', /Ctrl\+Alt\+L locks any time/.test(H.text(dlg)));
    const tr = radios[1];
    tr.value = 'tr';
    H.fire(T.dom, tr, 'change');
    ok('picking top right stores it and says so', W.NBDOSPrivacy.corner.get() === 'tr' && T.store[P.CORNER_KEY] === 'tr' && H.text(dlg.querySelector('.os-pv-msg')) === 'Hot corner: top right.');
    ok('…and turns the corner on', moves(T) === pm0 + 1);
    mv(1279, 1, null, D.querySelector('.content')); T.fire(250);
    ok('the new corner locks', isLocked(T));
    ok('the lock cover sits inside the open sheet (the top layer), so Unlock works', D.getElementById('osLock').parentNode === dlg);
    W.NBDOS.unlock();
    dlg.close();
    ok('closing the sheet removes it', !D.querySelector('dialog.os-pv'));

    // unmount
    W._impl.unmount();
    ok('unmount takes the tile down', !tile(T));
    ok('…and the corner listener', (T.document.listeners.pointermove || []).indexOf(moveFn) === -1);
    key(body, 'l', { ctrlKey: true, altKey: true, code: 'KeyL' });
    ok('…and the key: Ctrl+Alt+L does nothing once the OS layout is gone', !isLocked(T));
    W.NBDOSPrivacy.corner.set('');
  });
}

function phone() {
  console.log('\nNBD OS privacy lock: phone (double-tap an empty spot)');
  const T = boot('phone');
  const W = T.W, D = T.document;
  const home = D.getElementById('osPhone');
  let clock = 1000;
  const tap = (target, x, y, opt) => {
    const o = Object.assign({ hold: 60, move: 0 }, opt || {});
    clock += o.gap == null ? 120 : o.gap;
    H.fire(T.dom, target, 'pointerdown', { clientX: x, clientY: y, timeStamp: clock, isPrimary: o.isPrimary !== false, pointerType: 'touch' });
    clock += o.hold;
    H.fire(T.dom, target, 'pointerup', { clientX: x + o.move, clientY: y, timeStamp: clock, isPrimary: o.isPrimary !== false, pointerType: 'touch' });
  };
  const dbl = (target, opt) => { tap(target, 150, 600, Object.assign({ gap: 1000 }, opt)); tap(target, 152, 603, opt); };
  let page = null;
  return flush().then(() => {
    ok('nothing switched on: the phone loads nothing at mount', !W.NBDOSPrivacy && W.ScriptLoader.calls.indexOf('osprivacy') === -1);
    const t = tile(T);
    ok('the phone has the "Privacy lock" tile', !!t && t.label === 'Privacy lock');
    page = home.querySelector('.os-p-page');
    ok('the home has pages', !!page && !!home.querySelector('.os-p-pages'));
    dbl(page);
    ok('double-tap to lock is off by default', !isLocked(T));
    ok('…and no html class (the pages keep their touch behaviour)', !D.documentElement.classList.contains('os-dtap'));
    t.run();
    return flush();
  }).then(() => {
    ok('opening the tile loads the osprivacy bundle', !!W.NBDOSPrivacy && W.ScriptLoader.calls.indexOf('osprivacy') >= 0);
    const t = tile(T);
    const dlg = D.querySelector('dialog.os-pv');
    const box = dlg && dlg.querySelector('input[data-pv="dtap"]');
    ok('the phone sheet has one switch, off', !!box && !box.hasAttribute('checked') && !dlg.querySelector('input[data-pv="corner"]'));
    box.checked = true;
    H.fire(T.dom, box, 'change');
    ok('turning it on stores it and says so', W.NBDOSPrivacy.dtap.on() && T.store[P.DTAP_KEY] === '1' && H.text(dlg.querySelector('.os-pv-msg')) === 'Double-tap to lock is on.');
    ok('…and the pages stop double-tap zoom (html.os-dtap → touch-action: manipulation)', D.documentElement.classList.contains('os-dtap'));
    ok('the tile\'s hint says it is on', t.hint() === 'Double-tap: on');
    dlg.close();

    dbl(page);
    ok('a double tap on an empty spot of the home page locks', isLocked(T));
    T.fire(150);
    ok('…and the lock screen says so (a11y)', H.text(D.querySelector('#osLock .os-pv-sr')) === P.MSG.dtap);
    W.NBDOS.unlock();
    dbl(home.querySelector('.os-p-pages'));
    ok('the pages strip itself is empty space too', isLocked(T));
    W.NBDOS.unlock();

    // never
    const w = home.querySelector('.os-hw') || (() => { const x = D.createElement('section'); x.className = 'os-hw os-hw-glance'; page.appendChild(x); return x; })();
    const inner = D.createElement('span'); w.appendChild(inner);
    dbl(inner);
    ok('a double tap on a widget never locks', !isLocked(T));
    const icon = home.querySelector('.os-p-icon');
    ok('the home has an icon to tap', !!icon);
    if (icon) { dbl(icon); }
    ok('a double tap on an app icon never locks', !isLocked(T));
    tap(page, 150, 600, { gap: 1000 }); tap(icon || inner, 152, 603);
    ok('one tap on empty space and one on an icon: no lock', !isLocked(T));
    const S = W.NBDOSLayout.state();
    S.editing = true;
    dbl(page);
    ok('in edit mode a double tap never locks', !isLocked(T));
    S.editing = false;
    if (S.home && typeof S.home.setEditing === 'function') {
      S.home.setEditing(true);
      dbl(page);
      ok('while the widgets are in edit mode, never', !isLocked(T));
      S.home.setEditing(false);
    }
    S.iconDrag = { id: 'crm' };
    dbl(page);
    ok('during an icon drag, never', !isLocked(T));
    S.iconDrag = null;
    S.phoneOpen = 'crm';
    dbl(page);
    ok('with an app open over the home, never', !isLocked(T));
    S.phoneOpen = null;
    dbl(page, { move: 25 });
    ok('a swipe (the finger moves) is not a tap: never', !isLocked(T));
    tap(page, 150, 600, { gap: 1000 }); tap(page, 152, 603, { gap: 420 });
    ok('two taps too far apart in time: never', !isLocked(T));
    dbl(page, { hold: 600 });
    ok('long presses: never', !isLocked(T));
    dbl(page, { isPrimary: false });
    ok('a second finger (a pinch): never', !isLocked(T));
    tap(page, 150, 600, { gap: 1000 }); H.fire(T.dom, page, 'pointercancel', {}); tap(page, 152, 603, { gap: 5 });
    ok('a cancelled press (the pager scrolled) breaks the pair', !isLocked(T));
    dbl(page);
    ok('…and a clean double tap still locks after all that', isLocked(T));
    W.NBDOS.unlock();

    W.NBDOSPrivacy.dtap.set(false);
    dbl(page);
    ok('switched off again: a double tap does nothing', !isLocked(T) && !D.documentElement.classList.contains('os-dtap'));
    W.NBDOSPrivacy.dtap.set(true);
    W._impl.unmount();
    ok('unmount takes the tile and the html class down', !tile(T) && !D.documentElement.classList.contains('os-dtap'));
    W.NBDOSPrivacy.dtap.set(false);
  });
}

/** The fake document runs its listeners after the elements': give it a capture phase (as the runner suite does). */
function withDocCapture(T) {
  const D = T.document, cap = {};
  const add = D.addEventListener, rem = D.removeEventListener;
  const isCap = (o) => o === true || !!(o && o.capture);
  D.addEventListener = (t, f, o) => { if (isCap(o)) (cap[t] = cap[t] || []).push(f); else add(t, f, o); };
  D.removeEventListener = (t, f, o) => { if (isCap(o)) cap[t] = (cap[t] || []).filter((x) => x !== f); else rem(t, f, o); };
  return function fireDoc(target, type, extra) {
    const ev = Object.assign({
      type, target, defaultPrevented: false, stopped: false, clientX: 10, clientY: 10,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; },
    }, extra || {});
    const chain = [];
    for (let n = target; n && n.attrs; n = n.parentNode) chain.push(n);
    const run = (fns) => (fns || []).slice().forEach((f) => { if (!ev.stopped) f(ev); });
    run(cap[type]);
    for (let i = chain.length - 1; i >= 0 && !ev.stopped; i--) run(chain[i].capture[type]);
    for (let i = 0; i < chain.length && !ev.stopped; i++) run(chain[i].listeners[type]);
    if (!ev.stopped) run(D.listeners[type]);
    return ev;
  };
}

function stored() {
  console.log('\nNBD OS privacy lock: a member who switched one on');
  const Td = boot('desktop', { nbd_os_lock_corner_v1: 'bl' });
  const Tp = boot('phone', { nbd_os_lock_dtap_v1: '1' });
  const fireDoc = withDocCapture(Tp);   // before the bundle attaches (it loads on the next tick)
  return flush().then(() => {
    ok('a stored hot corner: the bundle loads at mount and the corner is live', Td.W.ScriptLoader.calls.indexOf('osprivacy') >= 0 &&
      Td.W.NBDOSPrivacy.corner.get() === 'bl' && tile(Td).hint() === 'Corner: bottom left');
    H.fire(Td.dom, Td.document.querySelector('.content'), 'pointermove', { clientX: 0, clientY: 799, pointerType: 'mouse', buttons: 0 });
    Td.fire(250);
    ok('…and locks on the dwell', isLocked(Td));
    ok('a stored double tap: the bundle loads at mount', Tp.W.ScriptLoader.calls.indexOf('osprivacy') >= 0 && Tp.document.documentElement.classList.contains('os-dtap'));
    const page = Tp.document.querySelector('.os-p-page');
    [[1000, 1060], [1200, 1250]].forEach(([d, u]) => {
      H.fire(Tp.dom, page, 'pointerdown', { clientX: 100, clientY: 500, timeStamp: d, pointerType: 'touch' });
      H.fire(Tp.dom, page, 'pointerup', { clientX: 101, clientY: 500, timeStamp: u, pointerType: 'touch' });
    });
    ok('…and a double tap on empty space locks', isLocked(Tp));
    const ub = Tp.document.querySelector('#osLock .os-lock-btn');
    const ev = fireDoc(ub, 'click');
    ok('the second tap\'s click, landing on Unlock under the finger, is swallowed: still locked', isLocked(Tp) && ev.defaultPrevented === true);
    Tp.fire(700);
    fireDoc(ub, 'click');
    ok('a real tap on Unlock after that unlocks', !isLocked(Tp));
    const vis = Tp.document.querySelector('.os-p-visits');
    ok('the home has a Visits row', !!vis);
    if (vis) {
      [[3000, 3060], [3200, 3250]].forEach(([d, u]) => {
        H.fire(Tp.dom, vis, 'pointerdown', { clientX: 300, clientY: 90, timeStamp: d, pointerType: 'touch' });
        H.fire(Tp.dom, vis, 'pointerup', { clientX: 300, clientY: 90, timeStamp: u, pointerType: 'touch' });
      });
      ok('the Visits row\'s empty space (beside its icons) is home screen too: locks', isLocked(Tp));
      Tp.W.NBDOS.unlock();
      const vi = vis.querySelector('.os-p-icon');
      if (vi) {
        [[4000, 4060], [4200, 4250]].forEach(([d, u]) => {
          H.fire(Tp.dom, vi, 'pointerdown', { clientX: 30, clientY: 90, timeStamp: d, pointerType: 'touch' });
          H.fire(Tp.dom, vi, 'pointerup', { clientX: 30, clientY: 90, timeStamp: u, pointerType: 'touch' });
        });
      }
      ok('…but a double tap on a visit icon never locks', !!vi && !isLocked(Tp));
    }
    const sheetT = tile(Tp);
    sheetT.run();
    return flush().then(() => {
      ok('the phone sheet does not talk about a keyboard', !/Ctrl\+Alt\+L/.test(H.text(Tp.document.querySelector('dialog.os-pv'))));
    });
  });
}

function wiring() {
  console.log('\nNBD OS privacy lock: wiring');
  const js = read(FILE), css = read(CSSF), os = read('docs/pro/js/layouts/os.js');
  const dash = read('docs/pro/dashboard.html');
  ok('no <script> tag for it in dashboard.html (lazy only)', !/os\/privacy\.js/.test(dash) && !/os\/privacy\.css/.test(dash));
  ok('layouts/os.js registers the osprivacy bundle (css + js)', /SL\.bundles\.osprivacy\s*=\s*PRIVACY_SRC/.test(os) && /'css\/os\/privacy\.css\?v=1', 'js\/os\/privacy\.js\?v=1'/.test(os));
  ok('layout-system.js is untouched: not in needs.script', !/privacy/.test(read('docs/pro/js/layout-system.js')));
  const code = strip(js);
  ok('no style attributes or style injection', !/style=|\.style\.|cssText/.test(code));
  ok('no inline handlers', !/\son[a-z]+\s*=/.test(code.replace(/'[^']*'/g, (m) => (/\son[a-z]+=/.test(m) ? m : "''"))) && !/\son[a-z]+=/.test(code));
  ok('no Firestore, callable or network', !/firestore|getDoc|setDoc|updateDoc|onSnapshot|httpsCallable|fetch\(|XMLHttpRequest/.test(code));
  ok('only nbd_ device keys', (code.match(/'nbd_[a-z_0-9]+'/g) || []).length === 2 && !/localStorage\.setItem\('(?!nbd_)/.test(code));
  ok('innerHTML only from the escaped sheet', (code.match(/innerHTML\s*=/g) || []).length === 1 && /innerHTML = sheetHtml\(\)/.test(code));
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
  ok('css: no hex colours (theme tokens only)', !/#[0-9a-fA-F]{3,8}\b/.test(cssCode));
  ok('css: no motion (no animation or transition)', !/animation|transition/.test(cssCode));
  const fonts = (cssCode.match(/font-size:\s*[^;]+/g) || []);
  ok('css: no text under 11px', fonts.every((f) => { const m = /(\d+(?:\.\d+)?)px/.exec(f); return !m || Number(m[1]) >= 11; }), fonts.join(' | '));
  ok('css: 44px targets for the options and Done', /\.os-pv-opt \{[^}]*min-height: 48px/.test(cssCode) && /\.os-pv-done \{[^}]*min-height: 44px/.test(cssCode));
  ok('css: the pages stop double-tap zoom only while it is on', /html\.os-dtap \.os-p-pages \{ touch-action: manipulation; \}/.test(cssCode));
}

desk().then(phone).then(stored).then(wiring).then(() => {
  console.log('\n' + (failed ? 'FAILED ' + failed + ' / ' : 'ok ') + (passed + failed));
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
