/**
 * tests/escape-layering-2026-11-06.test.js — PR steward review of #2952.
 *
 * Escape belongs to the layer opened LAST. nbd-modal.js handles Escape on
 * document (bubble) and stops it; overlay-a11y.js listens on window, which
 * comes after document in the bubble path. So an nbdOverlay dialog opened OVER
 * an nbdModal (the duplicate-customer prompt over Add Lead) never saw the key:
 * Escape closed Add Lead and left the prompt up. Both now stamp an open order
 * from one shared counter, and nbdModal steps aside when an overlay layer
 * opened after its top modal. The other order (a confirm over an overlay
 * dialog) must keep closing the confirm first.
 *
 * Loads the REAL nbd-modal.js and overlay-a11y.js into one fake page and
 * dispatches Escape the way a browser does: document listeners, then window
 * listeners unless propagation was stopped. Zero deps.
 * Run: node tests/escape-layering-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const MODAL = fs.readFileSync(path.join(JS, 'nbd-modal.js'), 'utf8');
const OVERLAY = fs.readFileSync(path.join(JS, 'overlay-a11y.js'), 'utf8');

function page() {
  const docL = {}, winL = {};
  function el(cls) {
    const set = new Set(cls ? cls.split(' ') : []);
    const attrs = {};
    return {
      nodeType: 1, isConnected: true, hidden: false, tabIndex: 0, tagName: 'DIV',
      classList: { contains: (c) => set.has(c), add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) },
      setAttribute(k, v) { attrs[k] = String(v); }, getAttribute: (k) => (k in attrs ? attrs[k] : null), hasAttribute: (k) => k in attrs, removeAttribute(k) { delete attrs[k]; },
      matches: () => false, closest: () => null, contains: () => false,
      querySelector: () => null, querySelectorAll: () => [], getClientRects: () => [1],
      focus() { doc.activeElement = this; },
    };
  }
  const body = el(''); body.isConnected = true;
  const doc = {
    activeElement: body, body,
    getElementById: () => null,
    addEventListener: (t, f) => { (docL[t] = docL[t] || []).push(f); },
    contains: () => true,
  };
  const win = {
    document: doc,
    addEventListener: (t, f) => { (winL[t] = winL[t] || []).push(f); },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  win.window = win;
  const sb = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, Map, Array, Promise };
  vm.createContext(sb);
  vm.runInContext(MODAL, sb, { filename: 'nbd-modal.js' });
  vm.runInContext(OVERLAY, sb, { filename: 'overlay-a11y.js' });
  function escape() {
    let stopped = false;
    const ev = { key: 'Escape', stopPropagation() { stopped = true; }, preventDefault() {}, isComposing: false };
    (docL.keydown || []).forEach((f) => { if (!stopped) f(ev); });
    if (!stopped) (winL.keydown || []).forEach((f) => f(ev));
  }
  return { win, el, escape };
}

console.log('AN OVERLAY DIALOG OPENED OVER A MODAL (the duplicate prompt over Add Lead)');
{
  const p = page();
  ok('both helpers load (positive control)', !!p.win.nbdModal && !!p.win.nbdOverlay);
  const leadModal = p.el('modal-bg');
  p.win.nbdModal.open(leadModal);
  const prompt = p.el('');
  let promptOpen = true, cancelled = 0;
  p.win.nbdOverlay.attach(prompt, { isOpen: () => promptOpen, close: () => { promptOpen = false; cancelled++; } });
  p.escape();
  ok('Escape cancels the duplicate prompt (the top layer)', cancelled === 1, 'cancelled=' + cancelled);
  ok('…and Add Lead stays open underneath', leadModal.classList.contains('open'));
  p.escape();
  ok('the next Escape closes Add Lead (positive control)', !leadModal.classList.contains('open'));
}

console.log('A CONFIRM OPENED OVER AN OVERLAY DIALOG (unchanged)');
{
  const p = page();
  const dialog = p.el('');
  let dialogOpen = true, dialogClosed = 0;
  p.win.nbdOverlay.attach(dialog, { isOpen: () => dialogOpen, close: () => { dialogOpen = false; dialogClosed++; } });
  const confirmBg = p.el('modal-bg');
  p.win.nbdModal.open(confirmBg);
  p.escape();
  ok('Escape closes the confirm first', !confirmBg.classList.contains('open'));
  ok('…and the dialog under it stays open', dialogClosed === 0 && dialogOpen === true);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
