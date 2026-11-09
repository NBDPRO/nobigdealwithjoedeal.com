/**
 * tests/nbd-os-pocket-dom-2026-11-09.test.js - NBD OS P3, Pocket on the real layout
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md section 6 #9, i3's scratchpad).
 *
 * The fake-DOM harness (tests/lib/nbd-os-home-harness.js) runs layouts/os.js and, on the
 * first toggle, the ospocket bundle (os/pocket-logic.js, os/pocket.js):
 *   - lazy: nothing loads at mount; the first Alt+`, tile, Spotlight run or phone tap does
 *   - open / close / focus return: Alt+` opens it over a focused window and focus moves into
 *     it; Esc, Close, the scrim and Alt+` again close it and focus goes back where it was.
 *     The window underneath keeps its place, focus and saved layout (no save, no goTo).
 *   - the shortcut never fires inside a field (Start's search box, a view's input)
 *   - entry points: the Control Center tile (both surfaces), Spotlight, the phone's Pocket
 *     icon on page 1
 *   - no new writer: keeping, deleting and undoing touch localStorage only (per user); no
 *     Firestore, callable or fetch entry point is ever called. Filing and voice hand off to
 *     quick-capture.js (NBDQuickCapture.review / open), and a filed note leaves the device
 *     list only when quick-capture says its own writer saved it.
 *   - escaping: a note's text and a draft are text, never markup
 *   - quick-capture.js review(): its own result screen and writer (users/{uid}/captures),
 *     the typed text escaped, onSaved called with the capture id
 *
 * Run: node tests/nbd-os-pocket-dom-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, makeDom, fire, click, key, text } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 500) : '')); }
}
const J = (v) => JSON.stringify(v);
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
async function G(fn) { try { await fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } }

const EVIL = '<img src=x onerror=alert(1)> & "q" \'s';
const ALT = { code: 'Backquote', altKey: true };

function win(o) {
  const opts = Object.assign({ surface: 'desktop', loader: true, system: true, plan: null }, o || {});
  const T = makeWin(opts);
  const W = T.W;
  W.cmd = [];
  W.NBDCommand = {
    open() {}, registerAction(a) { W.cmd = W.cmd.filter((x) => x.id !== a.id).concat([a]); },
    unregisterAction(id) { W.cmd = W.cmd.filter((x) => x.id !== id); },
  };
  W.qc = { reviews: [], opens: 0 };
  if (opts.qc !== false) {
    W.NBDQuickCapture = {
      isSupported: () => opts.voice !== false,
      open() { W.qc.opens++; },
      review(t, cb) { W.qc.reviews.push(t); W.qc.cb = cb; return true; },
    };
  }
  W._impl.mount({ surface: opts.surface });
  return T;
}
const pocketEl = (T) => T.document.getElementById('osPocket');
const area = (T) => T.document.getElementById('osPocketText');
const loads = (T) => T.W.ScriptLoader.calls.filter((c) => c === 'ospocket').length;
const stored = (T, uid) => { const v = T.store['nbd_os_pocket:' + (uid || 'u1')]; return v ? JSON.parse(v) : null; };
function pk(T, what, id) {
  const p = pocketEl(T);
  return p ? p.querySelector('[data-pocket="' + what + '"]' + (id ? '[data-id="' + id + '"]' : '')) : null;
}
function typeKeep(T, s) {
  const a = area(T);
  a.value = s;
  fire(T.dom, a, 'input');
  click(T.dom, pk(T, 'keep'));
}

(async () => {
  console.log('\n1. lazy: nothing at mount; the first toggle loads the ospocket bundle once');
  await G(async () => {
    const T = win();
    await flush();
    ok('no ospocket load at mount', loads(T) === 0 && !T.W.NBDOSPocket, J(T.W.ScriptLoader.calls));
    ok('no Pocket in the page', !pocketEl(T));
    ok('the Control Center has a Pocket tile', T.W.controls.some((c) => c.id === 'os-pocket' && c.label === 'Pocket'), J(T.W.controls.map((c) => c.id)));
    const tile = T.W.controls.filter((c) => c.id === 'os-pocket')[0];
    ok('...whose hint on the laptop is the shortcut', tile && typeof tile.hint === 'function' && tile.hint() === 'Alt+`', tile && tile.hint && tile.hint());
    ok('Spotlight has "Pocket: a quick note"', T.W.cmd.some((a) => a.id === 'os:pocket' && /Pocket/.test(a.label) && /note/.test(a.keywords)), J(T.W.cmd.map((a) => a.label)));
    key(T.dom, T.document.body, '`', ALT);
    await flush();
    ok('Alt+` loads the bundle and opens Pocket', loads(T) === 1 && !!pocketEl(T), J(T.W.ScriptLoader.calls));
    key(T.dom, area(T), '`', ALT);
    await flush();
    key(T.dom, T.document.body, '`', ALT);
    await flush();
    ok('...once: the next toggles reuse it', loads(T) === 1 && !!pocketEl(T));
  });

  console.log('\n2. open over a window, close, focus goes back; the window keeps its state');
  await G(async () => {
    const T = win();
    await flush();
    T.W.NBDOSLayout.open('crm');
    await flush();
    T.fire(700);   // opening the window saved it (debounced): that save is not Pocket's
    const S = T.W.NBDOSLayout.state();
    const before = J({ wins: S.wins, focus: S.focus, order: S.order, desk: S.desk });
    const saves0 = (T.W._saves || []).length;
    const gotos0 = T.W.goTos.length;
    const btn = T.document.createElement('button');
    T.document.getElementById('view-crm').appendChild(btn);
    btn.focus();
    const ev = key(T.dom, btn, '`', ALT);
    await flush();
    ok('Alt+` takes the key (preventDefault)', ev.defaultPrevented === true);
    ok('Pocket is open, a labelled dialog', pocketEl(T) && pocketEl(T).querySelector('[role="dialog"]') && pocketEl(T).querySelector('[role="dialog"]').getAttribute('aria-labelledby') === 'osPocketTitle');
    ok('focus moves into its note box', T.document.activeElement === area(T));
    const keys = pocketEl(T).querySelector('.os-pocket-keys');
    ok('laptop: the sheet names the shortcut and the way in when the desktop keeps Alt+` (GNOME)',
      keys && /Alt\+`/.test(text(keys)) && /Control Center/.test(text(keys)) && /Spotlight/.test(text(keys)), keys && text(keys));
    ok('NBDOSPocket.isOpen() says so', T.W.NBDOSPocket.isOpen() === true);
    const esc = key(T.dom, area(T), 'Escape');
    ok('Esc closes it', !pocketEl(T) && T.W.NBDOSPocket.isOpen() === false);
    ok('...and goes no further (the desk under it sees no Esc)', esc.stopped === true && esc.defaultPrevented === true);
    ok('focus is back on the button it came from', T.document.activeElement === btn);
    const after = J({ wins: S.wins, focus: S.focus, order: S.order, desk: S.desk });
    ok('the window underneath kept its place, focus and desk', before === after, before + '\n' + after);
    await flush();
    T.fire(700);
    ok('...and nothing saved the layout or routed', (T.W._saves || []).length === saves0 && T.W.goTos.length === gotos0, J(T.W._saves));

    btn.focus();
    key(T.dom, btn, '`', ALT);
    click(T.dom, pk(T, 'close'));
    ok('Close closes it, focus back', !pocketEl(T) && T.document.activeElement === btn);
    btn.focus();
    key(T.dom, btn, '`', ALT);
    const scrim = pocketEl(T).querySelector('.os-pocket-scrim');
    click(T.dom, scrim);
    ok('a tap on the scrim closes it, focus back', !pocketEl(T) && T.document.activeElement === btn);
    btn.focus();
    key(T.dom, btn, '`', ALT);
    const again = key(T.dom, area(T), '`', ALT);
    ok('Alt+` again (from its own note box) closes it, focus back', !pocketEl(T) && T.document.activeElement === btn && again.defaultPrevented === true);
    btn.focus();
    key(T.dom, btn, '`', ALT);
    btn.remove();
    key(T.dom, area(T), 'Escape');
    ok('focus never goes to a node that left the page', !pocketEl(T) && T.document.activeElement !== btn);
  });

  console.log('\n3. the shortcut never fires inside a field');
  await G(async () => {
    const T = win();
    await flush();
    const startInput = T.document.querySelector('.os-start-input');
    const e1 = key(T.dom, startInput, '`', ALT);
    await flush();
    ok('in Start\'s search box: nothing loads, nothing opens', loads(T) === 0 && !pocketEl(T) && e1.defaultPrevented === false);
    const inp = T.document.createElement('input');
    T.document.getElementById('view-crm').appendChild(inp);
    key(T.dom, inp, '`', ALT);
    const ta = T.document.createElement('textarea');
    T.document.getElementById('view-crm').appendChild(ta);
    key(T.dom, ta, '`', ALT);
    const ce = T.document.createElement('div');
    ce.isContentEditable = true;
    T.document.getElementById('view-crm').appendChild(ce);
    key(T.dom, ce, '`', ALT);
    await flush();
    ok('in an input, a textarea or rich text: nothing', loads(T) === 0 && !pocketEl(T));
    key(T.dom, T.document.body, '`', { code: 'Backquote', altKey: true, ctrlKey: true });
    key(T.dom, T.document.body, '`', { code: 'Backquote' });
    await flush();
    ok('Ctrl+Alt+` and a bare ` do nothing', loads(T) === 0 && !pocketEl(T));
    // the lock screen (os/system.js, html.os-locked) hides the desk: Alt+` on its own buttons
    // must not open a Pocket under display:none that reappears after unlock
    const lockBtn = T.document.createElement('button');
    T.document.body.appendChild(lockBtn);
    lockBtn.focus();
    T.document.documentElement.classList.add('os-locked');
    const lk = key(T.dom, lockBtn, '`', ALT);
    await flush();
    ok('locked: Alt+` on the lock screen opens nothing and takes no key', loads(T) === 0 && !pocketEl(T) && lk.defaultPrevented === false);
    T.document.documentElement.classList.remove('os-locked');
    key(T.dom, lockBtn, '`', ALT);
    await flush();
    ok('...and works again once unlocked', !!pocketEl(T));
  });

  console.log('\n4. keep, delete, undo: this device only, per user, escaped');
  await G(async () => {
    const T = win();
    await flush();
    key(T.dom, T.document.body, '`', ALT);
    await flush();
    typeKeep(T, EVIL);
    const s1 = stored(T);
    ok('Keep stores the note under this member\'s key', Array.isArray(s1) && s1.length === 1 && s1[0].text === EVIL, J(s1));
    ok('the note box is empty again and still focused', area(T).value === '' && T.document.activeElement === area(T));
    ok('the draft is cleared', !T.store['nbd_os_pocket_draft:u1']);
    const row = pocketEl(T).querySelector('.os-pocket-row');
    ok('the note shows as text', row && text(row.querySelector('.os-pocket-note')) === EVIL, row && text(row));
    ok('...never as markup (no <img> in the sheet)', pocketEl(T).querySelectorAll('img').length === 0);
    ok('its time comes from the note ("just now")', /just now/.test(text(row.querySelector('.os-pocket-at'))));
    ok('the status says where it went', /on this device/i.test(text(pocketEl(T).querySelector('.os-pocket-status'))), text(pocketEl(T).querySelector('.os-pocket-status')));
    const fileBtn = row.querySelector('[data-pocket="file"]');
    ok('row buttons name the note in their label, escaped as an attribute', fileBtn && fileBtn.getAttribute('aria-label').indexOf('<img src=x') !== -1, fileBtn && fileBtn.getAttribute('aria-label'));
    typeKeep(T, '   ');
    ok('an empty note is not kept', stored(T).length === 1);
    const ta = area(T);
    ta.value = 'second';
    key(T.dom, ta, 'Enter', { ctrlKey: true });
    ok('Ctrl+Enter keeps too', stored(T).length === 2 && stored(T)[0].text === 'second');
    const id = stored(T)[1].id;
    click(T.dom, pk(T, 'del', id));
    ok('Delete takes it off this device', stored(T).length === 1 && stored(T)[0].text === 'second');
    ok('...and offers Undo', !!pk(T, 'undo'));
    click(T.dom, pk(T, 'undo'));
    ok('Undo puts it back', stored(T).length === 2 && stored(T).some((n) => n.id === id));
    ok('no Firestore, callable or fetch entry point was called', T.reads.length === 0, J(T.reads));
    ok('no layout save either', !(T.W._saves || []).length, J(T.W._saves));

    const ta2 = area(T);
    ta2.value = 'half a thought <b>';
    fire(T.dom, ta2, 'input');
    key(T.dom, ta2, 'Escape');
    ok('an unsent draft is kept on close', T.store['nbd_os_pocket_draft:u1'] === 'half a thought <b>');
    key(T.dom, T.document.body, '`', ALT);
    ok('...and back in the box on open (a value, not markup)', area(T).value === 'half a thought <b>' && pocketEl(T).querySelectorAll('b').length === 0);
    key(T.dom, area(T), 'Escape');

    const full = []; for (let i = 0; i < 20; i++) full.push({ id: 'n' + i, text: 't' + i, at: 1e12 + i });
    T.store['nbd_os_pocket:u1'] = JSON.stringify(full);
    key(T.dom, T.document.body, '`', ALT);
    typeKeep(T, 'one too many');
    ok('a full Pocket refuses and says so; the text stays in the box', stored(T).length === 20 && area(T).value === 'one too many' &&
      /holds 20 notes/.test(text(pocketEl(T).querySelector('.os-pocket-status'))), text(pocketEl(T).querySelector('.os-pocket-status')));
    key(T.dom, area(T), 'Escape');

    const U = win({ uid: 'u2' });
    await flush();
    key(U.dom, U.document.body, '`', ALT);
    await flush();
    ok('another member on this device sees none of u1\'s notes', !pocketEl(U).querySelector('.os-pocket-row'));
  });

  console.log('\n5. filing and voice go through quick-capture.js, never a writer of Pocket\'s own');
  await G(async () => {
    const T = win();
    await flush();
    key(T.dom, T.document.body, '`', ALT);
    await flush();
    typeKeep(T, 'Gate code 4471');
    const id = stored(T)[0].id;
    const back = T.document.body;
    click(T.dom, pk(T, 'file', id));
    ok('File closes Pocket and hands the text to NBDQuickCapture.review', !pocketEl(T) && J(T.W.qc.reviews) === J(['Gate code 4471']), J(T.W.qc.reviews));
    ok('...the note stays on the device until quick-capture saves it', stored(T).length === 1);
    T.W.qc.cb('cap123');
    ok('quick-capture saved it: it leaves the device list', stored(T).length === 0, J(stored(T)));
    ok('no Firestore, callable or fetch entry point was called by Pocket', T.reads.length === 0, J(T.reads));

    key(T.dom, T.document.body, '`', ALT);
    ok('Voice note is offered when quick-capture can record', !!pk(T, 'voice'));
    click(T.dom, pk(T, 'voice'));
    ok('Voice note closes Pocket and opens quick-capture\'s recorder', !pocketEl(T) && T.W.qc.opens === 1);

    const N = win({ voice: false });
    await flush();
    key(N.dom, N.document.body, '`', ALT);
    await flush();
    ok('no microphone support: no Voice note button', !pk(N, 'voice'));
    const Q = win({ qc: false });
    await flush();
    key(Q.dom, Q.document.body, '`', ALT);
    await flush();
    typeKeep(Q, 'kept anyway');
    ok('no quick-capture on the page: notes still keep, but no File and no Voice', stored(Q).length === 1 && !pk(Q, 'file') && !pk(Q, 'voice'));
    ok('...and the sheet says filing is not here', /file/i.test(text(pocketEl(Q).querySelector('.os-pocket-kept'))));
  });

  console.log('\n6. the Control Center tile, Spotlight and the phone');
  await G(async () => {
    const T = win();
    await flush();
    T.W.controls.filter((c) => c.id === 'os-pocket')[0].run();
    await flush();
    ok('the tile opens it', !!pocketEl(T));
    key(T.dom, area(T), 'Escape');
    T.W.cmd.filter((a) => a.id === 'os:pocket')[0].run();
    await flush();
    ok('Spotlight opens it', !!pocketEl(T));
    T.W._impl.unmount();
    ok('unmount closes it and takes the tile and the Spotlight row down', !pocketEl(T) && !T.W.controls.some((c) => c.id === 'os-pocket') && !T.W.cmd.some((a) => a.id === 'os:pocket'));

    const P = win({ surface: 'phone', home: { v: 1, phone: [{ id: 'glance', s: 'm' }] } });
    await flush();
    const icon = P.document.getElementById('osPhone').querySelector('[data-osp="pocket"]');
    ok('phone: a Pocket icon on page 1, next to the visit icons', icon && icon.closest('.os-p-toprow') && /Pocket/.test(text(icon)), icon && text(icon));
    ok('...a button that opens a dialog', icon && icon.tagName === 'BUTTON' && icon.getAttribute('aria-haspopup') === 'dialog');
    ok('...not loaded until tapped', loads(P) === 0);
    click(P.dom, icon);
    await flush();
    ok('a tap opens Pocket', !!pocketEl(P) && loads(P) === 1);
    ok('phone: no keyboard hint in the sheet', !pocketEl(P).querySelector('.os-pocket-keys'));
    const tile = P.W.controls.filter((c) => c.id === 'os-pocket')[0];
    ok('phone: the Control Center tile is there too, with no shortcut hint', tile && (!tile.hint || tile.hint() === ''), tile && tile.hint && tile.hint());
    key(P.dom, area(P), 'Escape');
    ok('Esc closes it, focus back on the icon', !pocketEl(P) && P.document.activeElement === P.document.getElementById('osPhone').querySelector('[data-osp="pocket"]'));
  });

  console.log('\n7. Tab stays inside the open sheet');
  await G(async () => {
    const T = win();
    await flush();
    key(T.dom, T.document.body, '`', ALT);
    await flush();
    typeKeep(T, 'x');
    const focusables = pocketEl(T).querySelectorAll('button, textarea');
    const last = focusables[focusables.length - 1];
    last.focus();
    const ev = key(T.dom, last, 'Tab');
    ok('Tab from the last control wraps to the first', ev.defaultPrevented && T.document.activeElement === focusables[0], T.document.activeElement && T.document.activeElement.className);
    const ev2 = key(T.dom, focusables[0], 'Tab', { shiftKey: true });
    ok('Shift+Tab from the first wraps to the last', ev2.defaultPrevented && T.document.activeElement === last);
  });

  console.log('\n8. quick-capture.js review(): its own screen and writer for a typed note');
  await G(async () => {
    const dom = makeDom();
    const writes = [];
    let n = 0;
    const W = {
      document: dom.document, navigator: {}, console: { log() {}, info() {}, warn() {}, error() {} },
      location: { pathname: '/pro/dashboard.html' },
      setTimeout: (f) => 0, clearTimeout() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
      _user: { uid: 'u1' }, db: { name: 'db' },
      collection: (db, ...p) => p.join('/'),
      doc: (db, ...p) => p.join('/'),
      addDoc: (col, data) => { writes.push({ col, data }); return Promise.resolve({ id: 'cap' + (++n) }); },
      updateDoc: (ref, data) => { writes.push({ upd: ref, data }); return Promise.resolve(); },
      serverTimestamp: () => 'TS',
      toasts: [], showToast(m) { W.toasts.push(String(m)); },
    };
    const ctx = vm.createContext(W);
    ctx.window = ctx;
    vm.runInContext(read('docs/pro/js/quick-capture.js'), ctx, { filename: 'quick-capture.js' });
    const QC = ctx.NBDQuickCapture;
    ok('review is exported', QC && typeof QC.review === 'function');
    ok('an empty note opens nothing', QC.review('   ') === false && !dom.document.getElementById('nbd-qc-modal'));
    const saved = [];
    ok('a note opens the result screen', QC.review(EVIL, (id) => saved.push(id)) === true && !!dom.document.getElementById('nbd-qc-modal'));
    const res = dom.document.getElementById('nbd-qc-result');
    ok('the typed text shows as text, never markup', text(res).indexOf(EVIL) !== -1 && res.querySelectorAll('img').length === 0, text(res).slice(0, 200));
    ok('with quick-capture\'s own buttons: Save capture, link to a lead, Discard',
      !!dom.document.getElementById('nbd-qc-act-save') && !!dom.document.getElementById('nbd-qc-act-link') && !!dom.document.getElementById('nbd-qc-act-discard'));
    ok('no "Make N tasks" (a typed note has no action items)', !dom.document.getElementById('nbd-qc-act-tasks'));
    ok('labelled a note: no made-up category, no transcript repeat', /NOTE/.test(text(res)) && !/SUMMARY|other|transcript/i.test(text(res)), text(res).slice(0, 200));
    const modalTxt = text(dom.document.getElementById('nbd-qc-modal'));
    ok('the screen is titled for a typed note, not "Talk it out"', !/Talk it out/.test(modalTxt) && /File this note/.test(modalTxt), modalTxt.slice(0, 120));
    click(dom, dom.document.getElementById('nbd-qc-act-save'));
    await flush();
    ok('Save writes one capture with quick-capture\'s own shape', writes.length === 1 && writes[0].col === 'users/u1/captures' &&
      writes[0].data.transcript === EVIL && writes[0].data.summary === null && writes[0].data.mode === 'quick-capture' && writes[0].data.linkedLeadId === null, J(writes));
    ok('onSaved hears the capture id, then the screen closes', J(saved) === J(['cap1']) && !dom.document.getElementById('nbd-qc-modal'), J(saved));
    QC.review('second', (id) => saved.push(id));
    click(dom, dom.document.getElementById('nbd-qc-act-discard'));
    await flush();
    ok('Discard writes nothing and onSaved never fires', writes.length === 1 && saved.length === 1);
    QC.review('third', (id) => saved.push(id));
    QC.close();
    QC.review('fourth');
    click(dom, dom.document.getElementById('nbd-qc-act-save'));
    await flush();
    ok('a closed review\'s onSaved never fires for a later save', J(saved) === J(['cap1']) && writes.length === 2, J(saved));
  });

  console.log('\n9. quick-capture.js review(): a lead link is labelled a note and keeps the whole text; a recording is never dropped');
  await G(async () => {
    const dom = makeDom();
    const writes = [];
    let n = 0;
    const recs = [];
    function MR() { this.state = 'inactive'; this.ls = {}; recs.push(this); }
    MR.isTypeSupported = () => true;
    MR.prototype.addEventListener = function (t, f) { this.ls[t] = f; };
    MR.prototype.start = function () { this.state = 'recording'; };
    MR.prototype.stop = function () { this.state = 'inactive'; this.stopped = true; };
    const W = {
      document: dom.document, console: { log() {}, info() {}, warn() {}, error() {} },
      navigator: { mediaDevices: { getUserMedia: () => Promise.resolve({ getTracks: () => [] }) } },
      MediaRecorder: MR,
      location: { pathname: '/pro/customer.html' },
      _customerId: 'L1', _leadDoc: { id: 'L1', firstName: 'Ann', lastName: 'Lee' },
      setTimeout: (f) => 0, clearTimeout() {}, cancelAnimationFrame() {}, requestAnimationFrame() { return 0; },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
      _user: { uid: 'u1' }, db: { name: 'db' },
      collection: (db, ...p) => p.join('/'),
      doc: (db, ...p) => p.join('/'),
      addDoc: (col, data) => { writes.push({ col, data }); return Promise.resolve({ id: 'cap' + (++n) }); },
      updateDoc: (ref, data) => { writes.push({ upd: ref, data }); return Promise.resolve(); },
      serverTimestamp: () => 'TS',
      toasts: [], showToast(m) { W.toasts.push(String(m)); },
    };
    const ctx = vm.createContext(W);
    ctx.window = ctx;
    vm.runInContext(read('docs/pro/js/quick-capture.js'), ctx, { filename: 'quick-capture.js' });
    const QC = ctx.NBDQuickCapture;
    const long = 'Gate code 4471. ' + 'x'.repeat(1500) + ' END';
    QC.review(long);
    click(dom, dom.document.getElementById('nbd-qc-act-here'));
    await flush();
    const act = writes.filter((w) => w.col === 'leads/L1/activity')[0];
    ok('linked to the customer: one capture and one lead activity', writes.length === 2 && !!act, J(writes.map((w) => w.col)));
    ok('...the activity is labelled a note, not "Voice capture"', act && act.data.label === 'Note', act && act.data.label);
    ok('...and carries the whole typed text, not its first 200 characters', act && act.data.text === long, act && act.data.text.length);

    // a voice recording in progress: review() refuses, the recording keeps going
    QC.open();
    dom.document.getElementById('nbd-qc-canvas').getContext = () => null;
    click(dom, dom.document.getElementById('nbd-qc-record-btn'));
    await flush();
    const rec = recs[recs.length - 1];
    ok('(a recording is running)', rec && rec.state === 'recording');
    const saved = [];
    ok('review() while recording refuses (returns false)', QC.review('typed over a recording', (id) => saved.push(id)) === false);
    ok('...and the recording was not stopped or dropped', rec.state === 'recording' && !rec.stopped && !!dom.document.getElementById('nbd-qc-modal') && !dom.document.getElementById('nbd-qc-act-save'));
    QC.close();
  });

  console.log('\n10. Pocket: a note quick-capture refuses stays in Pocket, with a reason');
  await G(async () => {
    const T = win();
    T.W.NBDQuickCapture.review = (t) => { T.W.qc.reviews.push(t); return false; };
    await flush();
    key(T.dom, T.document.body, '`', ALT);
    await flush();
    typeKeep(T, 'Gate code 4471');
    const id = stored(T)[0].id;
    click(T.dom, pk(T, 'file', id));
    ok('quick-capture said no: Pocket stays open, the note stays on the device', !!pocketEl(T) && stored(T).length === 1 && T.W.qc.reviews.length === 1);
    ok('...and says why', /Quick Capture is busy/i.test(text(pocketEl(T).querySelector('.os-pocket-status'))), text(pocketEl(T).querySelector('.os-pocket-status')));
  });

  console.log('\n11. Spotlight (command-palette.js) hands focus back on close, so Pocket opened from it returns there');
  await G(async () => {
    const dom = makeDom();
    const timers = [];
    const W = {
      document: dom.document, navigator: {}, console: { log() {}, info() {}, warn() {}, error() {} },
      location: { pathname: '/pro/dashboard.html', hash: '' },
      setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      CustomEvent: function (t, i) { this.type = t; this.detail = i && i.detail; },
    };
    const ctx = vm.createContext(W);
    ctx.window = ctx;
    vm.runInContext(read('docs/pro/js/command-palette.js'), ctx, { filename: 'command-palette.js' });
    const run = () => { while (timers.length) { try { timers.shift()(); } catch (e) {} } };
    run();
    const C = ctx.NBDCommand;
    const btn = dom.document.createElement('button');
    const P = Object.getPrototypeOf(btn);
    if (!('dataset' in P)) Object.defineProperty(P, 'dataset', { configurable: true, get() {   // the fake DOM has none: data-* attributes, camelCased
      const o = {}; Object.keys(this.attrs).forEach((k) => { if (/^data-/.test(k)) o[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = this.attrs[k]; }); return o;
    } });
    dom.document.body.appendChild(btn);
    btn.focus();
    C.open();
    run();
    ok('(the palette is open and its box has focus)', !!dom.document.getElementById('nbd-cmd-modal') && dom.document.activeElement === dom.document.getElementById('nbd-cmd-input'));
    C.close();
    ok('closing it puts focus back where it was', !dom.document.getElementById('nbd-cmd-modal') && dom.document.activeElement === btn, dom.document.activeElement && dom.document.activeElement.tagName);
    let seen = null;
    C.registerAction({ id: 'os:pocket', label: 'Pocket: a quick note', keywords: 'pocket', run: () => { seen = dom.document.activeElement; } });
    btn.focus();
    C.open();
    run();
    const inp = dom.document.getElementById('nbd-cmd-input');
    inp.value = 'Pocket: a quick';
    fire(dom, inp, 'input');
    run();
    key(dom, inp, 'Enter');
    run();
    ok('a row run from it (Pocket) sees focus back on the element, not on <body>', seen === btn, seen && seen.tagName);
    const gone = dom.document.createElement('button');
    dom.document.body.appendChild(gone);
    gone.focus();
    C.open();
    run();
    gone.remove();
    C.close();
    ok('...never on a node that left the page', dom.document.activeElement !== gone);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})();
