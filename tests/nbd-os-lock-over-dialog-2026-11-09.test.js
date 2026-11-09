/**
 * tests/nbd-os-lock-over-dialog-2026-11-09.test.js — NBD OS P3 (privacy lane,
 * design §6 #11): the lock screen covers an open native modal <dialog>.
 *
 * The OS's sheets are native modal <dialog>s (Peek, Shutdown, Add widget,
 * Wallpaper, Workspaces, the goals editor). A modal dialog sits in the browser's
 * top layer and makes everything outside it inert, so a lock cover appended to
 * <body> showed UNDER it (a customer's name in Peek stayed on screen) and its
 * Unlock button could not be pressed (checked in Chromium: a fixed cover in
 * <body>, even promoted to a popover, is inert under a modal dialog; inside
 * the dialog, it covers the viewport and takes the click).
 *
 * Now lock() puts the cover inside the topmost open modal dialog, hides from
 * the accessibility tree everything off the path to the cover, and puts it all
 * back on unlock. The dialog and what was typed in it are kept as they were.
 *
 * While locked, Escape and Tab belong to the cover (capture phase): a sheet's own
 * Escape handler stops propagation and closes its dialog, which used to take the
 * cover with it and leave the lock half-on (no cover, page aria-hidden, no way to
 * lock again). If the host dialog closes or is removed anyway, the cover moves to
 * <body> and the lock holds; a close request on the host is refused while locked.
 *
 * Runs the REAL docs/pro/js/os/system.js over the NBD OS fake DOM
 * (tests/lib/nbd-os-home-harness.js).
 *
 * Run: node tests/nbd-os-lock-over-dialog-2026-11-09.test.js
 */
'use strict';
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

function boot() {
  const T = H.makeWin({ surface: 'desktop' });
  vm.runInContext(H.read('docs/pro/js/os/system.js'), T.W, { filename: 'docs/pro/js/os/system.js' });
  return T;
}
/** A native modal dialog as the fake DOM can show it: matches(':modal') answers while open. */
function modal(T, open) {
  const d = T.document.createElement('dialog');
  d.className = 'os-pk';
  const base = d.matches.bind(d);
  d.matches = (sel) => (sel === ':modal' ? !!d.open && !!d.modal : base(sel));
  const name = T.document.createElement('p'); name.textContent = 'Pat Customer'; d.appendChild(name);
  const input = T.document.createElement('textarea'); input.value = 'half a note'; d.appendChild(input);
  T.document.body.appendChild(d);
  if (open) d.showModal();
  return { d, name, input };
}

console.log('\nNBD OS: the lock screen over an open modal dialog');

{
  const T = boot();
  ok('the system layer is up', !!T.W.NBDOS && typeof T.W.NBDOS.lock === 'function');
  const { d, name, input } = modal(T, true);
  input.focus();
  T.W.NBDOS.lock();
  const lk = T.document.getElementById('osLock');
  ok('locked', T.W.NBDOS.isLocked() && !!lk);
  ok('the cover goes inside the open modal dialog (the top layer), not under it', !!lk && lk.parentNode === d, lk && lk.parentNode && lk.parentNode.tagName);
  ok('the Unlock button is inside the dialog too, so it can be pressed', !!lk && d.contains(lk.querySelector('button')));
  ok('focus moved to Unlock', !!lk && T.document.activeElement === lk.querySelector('button'));
  ok('the dialog stays open (nothing it held is lost)', d.open === true && d.parentNode === T.document.body);
  ok('the dialog\'s own content leaves the accessibility tree', name.getAttribute('aria-hidden') === 'true' && input.getAttribute('aria-hidden') === 'true');
  ok('the path to the cover stays in it (the dialog is not hidden)', d.getAttribute('aria-hidden') !== 'true');
  const content = T.document.querySelector('.content');
  ok('the page behind leaves it too', content.getAttribute('aria-hidden') === 'true');
  T.W.NBDOS.unlock();
  ok('unlock takes the cover away', !T.document.getElementById('osLock') && !T.W.NBDOS.isLocked());
  ok('…and puts the accessibility tree back', name.getAttribute('aria-hidden') === null && input.getAttribute('aria-hidden') === null && content.getAttribute('aria-hidden') === null);
  ok('what was typed in the dialog is still there, and focus is back on it', input.value === 'half a note' && T.document.activeElement === input);
}

{
  const T = boot();
  const { d } = modal(T, false);   // a closed dialog in the page: not a host
  const pre = T.document.createElement('div'); pre.setAttribute('aria-hidden', 'true'); T.document.body.appendChild(pre);
  T.W.NBDOS.lock();
  const lk = T.document.getElementById('osLock');
  ok('no open modal dialog: the cover goes in <body>, as before', !!lk && lk.parentNode === T.document.body);
  ok('a closed dialog is hidden from the accessibility tree like the rest', d.getAttribute('aria-hidden') === 'true');
  T.W.NBDOS.unlock();
  ok('an element that was already aria-hidden stays hidden after unlock', pre.getAttribute('aria-hidden') === 'true' && d.getAttribute('aria-hidden') === null);
}

{
  const T = boot();
  const a = modal(T, true);
  const b = modal(T, true);
  T.W.NBDOS.lock();
  const lk = T.document.getElementById('osLock');
  ok('two open modal dialogs: the cover goes in the topmost (the last shown)', !!lk && lk.parentNode === b.d && a.d.getAttribute('aria-hidden') === 'true');
  T.W.NBDOS.unlock();
  ok('…and unlock restores both', a.d.getAttribute('aria-hidden') === null && b.d.open && a.d.open);
}

// A sheet's own Escape handler (peek.js, shutdown.js, home.js, wallpaper.js, ds-goals.js) sits on
// its dialog, calls stopPropagation and closes the sheet. While locked, the cover is inside that
// dialog: the lock's keys are taken in the capture phase first, so Escape unlocks and the sheet stays.
function sheet(T) {
  const m = modal(T, true);
  const d = m.d;
  m.closed = 0;
  m.tabs = 0;
  d.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); d.close(); }
    if (ev.key === 'Tab') { ev.preventDefault(); ev.stopPropagation(); m.tabs++; m.input.focus(); }
  });
  d.addEventListener('close', () => { m.closed++; if (d.parentNode) d.parentNode.removeChild(d); });
  return m;
}
const consistent = (T, locked) => {
  const D = T.document, lk = D.getElementById('osLock');
  const content = D.querySelector('.content');
  return locked
    ? T.W.NBDOS.isLocked() && !!lk && D.contains(lk) && content.getAttribute('aria-hidden') === 'true' && D.documentElement.classList.contains('os-locked')
    : !T.W.NBDOS.isLocked() && !lk && content.getAttribute('aria-hidden') === null && !D.documentElement.classList.contains('os-locked');
};

{
  const T = boot();
  const m = sheet(T);
  T.W.NBDOS.lock();
  const btn = T.document.querySelector('#osLock button');
  ok('a sheet with its own Escape handler: the cover is inside it', !!btn && m.d.contains(btn) && T.document.activeElement === btn);
  const tab = H.fire(T.dom, btn, 'keydown', { key: 'Tab' });
  ok('Tab while locked stays on Unlock (the sheet\'s own Tab handler never runs)', m.tabs === 0 && T.document.activeElement === btn && tab.defaultPrevented === true);
  const esc = H.fire(T.dom, btn, 'keydown', { key: 'Escape' });
  ok('Escape while locked unlocks (the sheet\'s Escape handler never runs)', esc.defaultPrevented === true && m.closed === 0);
  ok('…and the state is consistent: no cover, nothing aria-hidden, html.os-locked gone', consistent(T, false),
    [T.W.NBDOS.isLocked(), !!T.document.getElementById('osLock'), T.document.querySelector('.content').getAttribute('aria-hidden')].join());
  ok('…and the sheet is still open, as it was', m.d.open === true && m.d.parentNode === T.document.body);
  T.W.NBDOS.lock();
  ok('it locks again', consistent(T, true));
  T.W.NBDOS.unlock();
}

{
  const T = boot();
  const m = sheet(T);
  T.W.NBDOS.lock();
  const cancel = { type: 'cancel', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  (m.d.listeners.cancel || []).forEach((f) => f(cancel));
  ok('a close request on the host sheet while locked (Android back) is refused', cancel.defaultPrevented === true);
  m.d.close();   // the sheet closes itself anyway (a timer, its own code): its close handler removes it
  const lk = T.document.getElementById('osLock');
  ok('the host sheet closing while locked keeps the lock: the cover moves to <body>', !!lk && lk.parentNode === T.document.body && consistent(T, true));
  ok('…with focus on Unlock', !!lk && T.document.activeElement === lk.querySelector('button'));
  H.fire(T.dom, (lk && lk.querySelector('button')) || T.document.body, 'keydown', { key: 'Escape' });
  ok('…and Escape still unlocks cleanly', consistent(T, false));
  const after = { type: 'cancel', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  (m.d.listeners.cancel || []).forEach((f) => f(after));
  ok('unlocked, the host\'s close request is its own again', after.defaultPrevented === false);
}

{
  const T = boot();
  const m = modal(T, true);
  T.W.NBDOS.lock();
  m.d.parentNode.removeChild(m.d);   // the host removed without a close event
  ok('the host removed without a close event: still locked (the state says so)', T.W.NBDOS.isLocked());
  T.W.NBDOS.lock();
  const lk = T.document.getElementById('osLock');
  ok('lock() again puts the cover back (in <body>), the page hidden again', !!lk && lk.parentNode === T.document.body && consistent(T, true));
  T.W.NBDOS.unlock();
  ok('…and unlock is clean', consistent(T, false));
}

console.log('\n' + (failed ? 'FAILED ' + failed + ' / ' : 'ok ') + (passed + failed));
process.exit(failed ? 1 : 0);
