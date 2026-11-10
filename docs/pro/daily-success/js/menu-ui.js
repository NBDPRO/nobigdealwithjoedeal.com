/**
 * menu-ui.js - the header menu and the delete-undo toast (flow batch 3, D6 / audit M4 + M10, 2026-11-09).
 *
 *   - The header holds the sync chip, the search icon and one ⋯ button. The ⋯ button opens #dsMenu: Save, New, Rename, CSV, PDF, Appearance,
 *     Customize, Guide, and Delete last in danger styling. Every item keeps the data-action it always had, so app.js's delegated handler
 *     runs it; this file only opens and closes the menu (outside tap, Escape, an item chosen) and moves focus.
 *   - undoToast(message, pageId): the 8-second "Deleted ... Undo" snackbar app.js's deletePageAt() shows. Undo calls restoreDeleted(id).
 * Classic script after app.js; delegated listeners; every dynamic string is set with textContent.
 */
(function () {
  'use strict';
  if (window.NBDMenuUI) return;
  const UNDO_MS = 8000;
  let undoTimer = null;

  const menu = () => document.getElementById('dsMenu');
  const btn = () => document.getElementById('dsMenuBtn');
  const items = () => [...document.querySelectorAll('#dsMenu .ds-mi')];

  function isOpen() { const m = menu(); return !!m && !m.hidden; }
  function close(refocus) {
    const m = menu(), b = btn();
    if (!m || m.hidden) return;
    // focus on a menu item (a keyboard or tap choice) goes back to the button before the item is hidden; a dialog the choice opened has
    // already taken focus outside the menu, so it is left alone
    const inMenu = m.contains(document.activeElement);
    m.hidden = true;
    if (b) { b.setAttribute('aria-expanded', 'false'); if (refocus || inMenu) b.focus(); }
  }
  function open() {
    const m = menu(), b = btn();
    if (!m) return;
    m.hidden = false;
    if (b) b.setAttribute('aria-expanded', 'true');
    const first = items()[0];
    if (first) first.focus();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-action="menu-toggle"]')) { if (isOpen()) close(false); else open(); return; }
    // choosing an item closes the menu (the item's own data-action is run by app.js's delegate); a tap anywhere else closes it too
    if (isOpen()) close(false);
  });
  document.addEventListener('keydown', (ev) => {
    if (!isOpen()) return;
    if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); close(true); return; }
    if (ev.key === 'Home' || ev.key === 'End') {
      const l = items(); if (!l.length) return;
      ev.preventDefault();
      l[ev.key === 'Home' ? 0 : l.length - 1].focus();
      return;
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      const list = items(); if (!list.length) return;
      const i = list.indexOf(document.activeElement);
      ev.preventDefault();
      list[(i + (ev.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
    }
  });

  // ── the delete-undo toast ────────────────────────────────────────────────────────────────
  // One fixed column holds the undo toast and the floor-tick prompt (floor-tick-ui.js uses the same #dsToasts), so two showing at once stack
  // instead of overlapping when one wraps to several lines.
  function stack() {
    let s = document.getElementById('dsToasts');
    if (!s) { s = document.createElement('div'); s.id = 'dsToasts'; s.className = 'ds-toasts'; document.body.appendChild(s); }
    return s;
  }
  function undoEl() {
    let el = document.getElementById('dsUndo');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'dsUndo';
    el.className = 'ds-undo';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    const msg = document.createElement('span'); msg.className = 'ds-undo-msg';
    const undo = document.createElement('button'); undo.type = 'button'; undo.dataset.undo = 'restore'; undo.textContent = 'Undo';
    const x = document.createElement('button'); x.type = 'button'; x.className = 'ds-undo-x'; x.dataset.undo = 'dismiss'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
    el.appendChild(msg); el.appendChild(undo); el.appendChild(x);
    stack().appendChild(el);
    return el;
  }
  function hideUndo() { clearTimeout(undoTimer); undoTimer = null; const el = document.getElementById('dsUndo'); if (el) { el.hidden = true; delete el.dataset.id; } }
  function undoToast(message, pageId) {
    const el = undoEl();
    el.querySelector('.ds-undo-msg').textContent = String(message || 'Deleted.');
    el.dataset.id = String(pageId);
    el.dataset.ms = String(UNDO_MS);
    el.hidden = false;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(hideUndo, UNDO_MS);
  }
  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-undo]') : null;
    if (!t) return;
    const el = document.getElementById('dsUndo');
    if (t.dataset.undo === 'restore' && el && el.dataset.id) {
      const id = el.dataset.id;
      hideUndo();
      if (typeof window.restoreDeleted === 'function' && window.restoreDeleted(id)) { if (typeof window.toast === 'function') window.toast('Page restored'); }
      else if (typeof window.toastErr === 'function') window.toastErr('That page could not be restored. Check Recently deleted in the Notebook.');
    } else hideUndo();
  });

  window.NBDMenuUI = { open, close, isOpen, undoToast, hideUndo, UNDO_MS };
})();
