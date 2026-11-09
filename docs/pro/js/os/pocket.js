/**
 * os/pocket.js — NBD OS P3: Pocket, a drop-down quick note over any app or window
 * (2026-11-09; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #9;
 * i3's scratchpad, Hyprland's special workspace).
 *
 *   toggle({ surface, returnFocus })  open it over whatever is on screen, or close it
 *   open(...) / close() / isOpen()
 *
 * Opened by layouts/os.js: Alt+` on the laptop, the Control Center tile, Spotlight, and
 * the Pocket icon on the phone's page 1. Opening it changes nothing underneath (no
 * window, view, desk or saved layout); it remembers where focus was and puts it back on
 * close (Esc, Close, the scrim, or Alt+` again). Not a modal <dialog>: the lock screen
 * (os/system.js) has to stay above it and reachable, so it traps Tab itself.
 *
 * A typed note is kept on THIS device only (localStorage nbd_os_pocket:<uid>, at most 20,
 * and the unsent draft in nbd_os_pocket_draft:<uid>) until the member files it. Both are
 * nbd_ keys, so sign-out (nbd-auth.js purgeAccountStorage) wipes them on a shared device. "File"
 * hands the text to quick-capture.js (NBDQuickCapture.review): its own Save / link to a
 * lead screen and its own writer; the note leaves this device only when that writer says
 * it saved. "Voice note" opens quick-capture's recorder. Pocket has no writer of its own:
 * no Firestore, no callable, no network.
 *
 * Every value goes in escaped (the draft as a value); no inline handlers, no style
 * attributes; css/os/pocket.css. Loaded with os/pocket-logic.js and css/os/pocket.css as
 * the runtime ScriptLoader bundle `ospocket` (registered by layouts/os.js) on the first
 * toggle, never at boot. window.NBDOSPocket.
 */
(function () {
  'use strict';
  var W = typeof window !== 'undefined' ? window : null;
  var doc = W && W.document;
  if (!W || !doc || W.NBDOSPocket) return;
  var PL = W.NBDOSPocketLogic;
  if (!PL) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function lsGet(k) { if (!k) return null; try { return W.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { if (!k) return false; try { W.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { if (!k) return; try { W.localStorage.removeItem(k); } catch (e) {} }
  function uid() {
    var u = W._user && W._user.uid;
    if (!u && W.auth && W.auth.currentUser) u = W.auth.currentUser.uid;
    return u || '';
  }
  function notesKey() { return PL.key(uid()); }
  function readNotes() { return PL.normalize(lsGet(notesKey())); }
  function writeNotes(list) { return lsSet(notesKey(), JSON.stringify(list)); }
  function qc() { var q = W.NBDQuickCapture; return q && typeof q === 'object' ? q : null; }
  function canFile() { var q = qc(); return !!(q && typeof q.review === 'function'); }
  function canVoice() {
    var q = qc();
    if (!q || typeof q.open !== 'function') return false;
    try { return typeof q.isSupported !== 'function' || q.isSupported() === true; } catch (e) { return false; }
  }
  function clip(s, n) { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  var cur = null;   // { el, back, desk, undo: {note} | null }

  function shellHtml(desk) {
    return '<div class="os-pocket-scrim" data-pocket-scrim=""></div>' +
      '<div class="os-pocket" role="dialog" aria-modal="true" aria-labelledby="osPocketTitle" aria-describedby="osPocketLede">' +
        '<div class="os-pocket-hd"><h2 class="os-pocket-title" id="osPocketTitle">Pocket</h2>' +
          '<button type="button" class="btn btn-ghost os-pocket-x" data-pocket="close" aria-label="Close Pocket">✕</button></div>' +
        '<p class="os-pocket-lede" id="osPocketLede">A quick note over whatever is open. It stays on this device until you file it or sign out.</p>' +
        '<label class="os-pocket-lbl" for="osPocketText">Note</label>' +
        '<textarea class="os-pocket-ta" id="osPocketText" rows="3" maxlength="' + PL.MAX_LEN + '" placeholder="A gate code, a callback, a measurement"></textarea>' +
        '<div class="os-pocket-acts">' +
          '<button type="button" class="btn btn-orange os-pocket-btn" data-pocket="keep">Keep</button>' +
          (canVoice() ? '<button type="button" class="btn btn-ghost os-pocket-btn" data-pocket="voice">Voice note</button>' : '') +
        '</div>' +
        (desk ? '<p class="os-pocket-keys">Alt+` opens and closes Pocket (if your desktop keeps Alt+` for itself, use Control Center or Spotlight). Ctrl+Enter keeps the note.</p>' : '') +
        '<div class="os-pocket-status" role="status" aria-live="polite"></div>' +
        '<div class="os-pocket-kept"></div>' +
      '</div>';
  }
  function keptHtml(list, now) {
    var file = canFile();
    if (!list.length) return '<p class="os-pocket-muted">Nothing kept on this device.</p>';
    return '<h3 class="os-pocket-st">On this device</h3>' +
      (file ? '' : '<p class="os-pocket-muted">Quick Capture is not on this page, so notes can\'t be filed from here. They stay on this device.</p>') +
      '<ul class="os-pocket-list">' + list.map(function (n) {
        var name = esc(clip(n.text, 40));
        return '<li class="os-pocket-row"><div class="os-pocket-txt">' +
          '<p class="os-pocket-note">' + esc(n.text) + '</p>' +
          '<p class="os-pocket-at">' + esc(PL.when(n.at, now)) + '</p></div>' +
          '<div class="os-pocket-ra">' +
            (file ? '<button type="button" class="btn btn-ghost os-pocket-btn" data-pocket="file" data-id="' + esc(n.id) + '" aria-label="File note: ' + name + '">File</button>' : '') +
            '<button type="button" class="btn btn-ghost os-pocket-btn" data-pocket="del" data-id="' + esc(n.id) + '" aria-label="Delete note: ' + name + '">Delete</button>' +
          '</div></li>';
      }).join('') + '</ul>';
  }
  function q(sel) { return cur ? cur.el.querySelector(sel) : null; }
  function area() { return q('#osPocketText'); }
  function paintKept() { var k = q('.os-pocket-kept'); if (k) k.innerHTML = keptHtml(readNotes(), Date.now()); }
  function status(msg, undo) {
    var s = q('.os-pocket-status');
    if (!s) return;
    s.innerHTML = msg ? '<span>' + esc(msg) + '</span>' + (undo ? ' <button type="button" class="btn btn-ghost os-pocket-btn" data-pocket="undo">Undo</button>' : '') : '';
  }
  function focusArea() { var a = area(); if (a) { try { a.focus(); } catch (e) {} } }

  // ── actions ────────────────────────────────────────────────
  function keep() {
    var a = area();
    if (!a) return;
    var r = PL.add(readNotes(), a.value, Date.now());
    if (r.error === 'empty') { status('Type a note first.'); return focusArea(); }
    if (r.error === 'full') { status('Pocket holds ' + PL.MAX_NOTES + ' notes. File or delete one first.'); return focusArea(); }
    if (!writeNotes(r.list)) { status('This device would not store the note. Copy it before you close Pocket.'); return focusArea(); }
    a.value = '';
    lsDel(PL.draftKey(uid()));
    cur.undo = null;
    status('Kept on this device.');
    paintKept();
    focusArea();
  }
  function del(id) {
    var r = PL.remove(readNotes(), id);
    if (!r.removed || !writeNotes(r.list)) return;
    cur.undo = r.removed;
    status('Note deleted.', true);
    paintKept();
    var u = q('[data-pocket="undo"]');
    if (u) { try { u.focus(); } catch (e) {} }
  }
  function undo() {
    var n = cur.undo;
    cur.undo = null;
    if (!n) return status('');
    var r = PL.restore(readNotes(), n);
    if (r.error || !writeNotes(r.list)) status('Pocket holds ' + PL.MAX_NOTES + ' notes, so that one could not come back.');
    else status('Note back.');
    paintKept();
    focusArea();
  }
  function fileNote(id) {
    var note = readNotes().filter(function (n) { return n.id === id; })[0];
    var Q = qc();
    if (!note || !Q || typeof Q.review !== 'function') return;
    var key = notesKey();
    // quick-capture's own screen and writer; the note leaves this device once that writer saved it.
    // false: a voice capture is still in hand there (recording, processing, unsaved), so Pocket stays.
    var shown = false;
    try {
      shown = Q.review(note.text, function () {
        if (!key) return;
        var r = PL.remove(PL.normalize(lsGet(key)), note.id);
        if (r.removed) lsSet(key, JSON.stringify(r.list));
      }) !== false;
    } catch (e) { shown = false; }
    if (!shown) { status('Quick Capture is busy with a voice note. Finish or close it, then file this one.'); return; }
    close();
  }
  function voice() {
    var Q = qc();
    close();
    if (Q && typeof Q.open === 'function') { try { Q.open(); } catch (e) {} }
  }

  // ── events ─────────────────────────────────────────────────
  function onClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-pocket-scrim]')) { ev.preventDefault(); return close(); }
    var b = t.closest('[data-pocket]');
    if (!b) return;
    var what = b.getAttribute('data-pocket');
    var id = b.getAttribute('data-id');
    ev.preventDefault();
    if (what === 'close') return close();
    if (what === 'keep') return keep();
    if (what === 'voice') return voice();
    if (what === 'file') return fileNote(id);
    if (what === 'del') return del(id);
    if (what === 'undo') return undo();
  }
  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return close(); }
    // Alt+` again closes it, from anywhere inside (its own note box included)
    if (ev.code === 'Backquote' && ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); return close(); }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && ev.target === area()) { ev.preventDefault(); return keep(); }
    if (ev.key !== 'Tab') return;
    var panel = q('.os-pocket');
    var f = panel ? panel.querySelectorAll('button, textarea') : [];
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && doc.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && doc.activeElement === last) { ev.preventDefault(); first.focus(); }
  }
  function onInput(ev) {
    if (ev.target !== area()) return;
    var k = PL.draftKey(uid());
    if (ev.target.value) lsSet(k, String(ev.target.value).slice(0, PL.MAX_LEN));
    else lsDel(k);
  }

  // ── open / close ───────────────────────────────────────────
  function open(opts) {
    var o = opts || {};
    if (cur) return focusArea();
    var back = o.returnFocus !== undefined ? o.returnFocus : doc.activeElement;
    var desk = o.surface !== 'phone';
    var el = doc.createElement('div');
    el.id = 'osPocket';
    el.className = 'os-pocket-wrap';
    el.innerHTML = shellHtml(desk);
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
    el.addEventListener('input', onInput);
    cur = { el: el, back: back && back !== doc.body ? back : null, desk: desk, undo: null };
    doc.body.appendChild(el);
    var draft = lsGet(PL.draftKey(uid()));
    if (draft) area().value = String(draft).slice(0, PL.MAX_LEN);
    paintKept();
    focusArea();
  }
  function close() {
    var s = cur;
    if (!s) return;
    cur = null;
    s.el.removeEventListener('click', onClick);
    s.el.removeEventListener('keydown', onKey);
    s.el.removeEventListener('input', onInput);
    if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
    var b = s.back;
    if (b && b.isConnected && typeof b.focus === 'function') { try { b.focus(); } catch (e) {} }
  }
  function toggle(opts) { if (cur) close(); else open(opts); }

  W.NBDOSPocket = { open: open, close: close, toggle: toggle, isOpen: function () { return !!cur; } };
})();
