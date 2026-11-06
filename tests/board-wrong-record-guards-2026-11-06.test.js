/**
 * tests/board-wrong-record-guards-2026-11-06.test.js
 *
 * CRM audit 2026-11-06 — pipeline board paths that could act on the wrong lead.
 *
 * PL-F03 (P0) docs/pro/js/kanban-context-menu.js: the long-press menu captured
 *   the card under the finger at touchstart and opened 500 ms later without
 *   checking that card was still on the board. The search re-renders 250 ms
 *   after typing, so a long-press right after typing opened a NAMELESS menu for
 *   the card that USED to be there (the first card of the unfiltered column)
 *   while the rep looked at the filtered one — the past wrong-record incident.
 *   Fix: no menu when the pressed card is gone; the menu names its lead.
 * PL-F05 (P1) docs/pro/js/crm-pipeline.js renderColumnCards: bulk selection
 *   survived a re-render but the fresh cards came back unhighlighted.
 * PL-F04 (P1) docs/pro/js/dashboard-bootstrap.module.js window.drop: a drop on
 *   an EMPTY column (no per-column handler) moved without the dragged job id,
 *   so a customer's second-job card moved their ACTIVE job.
 *
 * Runs the REAL code: kanban-context-menu.js whole, and renderColumnCards /
 * window.drop extracted verbatim from their files, each in a vm with a small
 * fake DOM. Break-test: against main the guarded cases go red, the positive
 * controls stay green.
 *
 * Zero deps. Run: node tests/board-wrong-record-guards-2026-11-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');

let passed = 0, failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// Slice a top-level function / assignment out of a source file, verbatim.
function extract(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error('marker not found: ' + startMarker);
  const e = src.indexOf(endMarker, s);
  if (e < 0) throw new Error('end marker not found after: ' + startMarker);
  return src.slice(s, e + endMarker.length);
}

// ── PL-F03 ─────────────────────────────────────────────────────────────────
function loadMenu() {
  const listeners = {};
  const timers = [];
  const made = [];
  const mkEl = (tag) => {
    const el = { tagName: tag, style: {}, attrs: {}, children: [], innerHTML: '', parentNode: null,
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { c.parentNode = null; }, addEventListener() {}, removeEventListener() {},
      querySelectorAll: () => [], querySelector: () => null,
      getBoundingClientRect: () => ({ width: 200, height: 300, left: 0, top: 0, right: 200, bottom: 300 }),
      contains: () => false, focus() {} };
    made.push(el);
    return el;
  };
  const document = {
    readyState: 'complete',
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    getElementById: () => null,
    createElement: mkEl,
    head: mkEl('head'), body: mkEl('body'),
  };
  const leads = [
    { id: 'lead-pressed', firstName: 'Test', lastName: 'Homeowner 01', stage: 'new' },
    { id: 'lead-filtered', firstName: 'Test', lastName: 'Homeowner 07', stage: 'new' },
  ];
  const win = { _leads: leads, innerWidth: 390, innerHeight: 844, addEventListener() {}, removeEventListener() {},
    normalizeStage: (s) => s };
  const sandbox = { window: win, document, navigator: {}, console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    requestAnimationFrame: (fn) => fn() };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(JS, 'kanban-context-menu.js'), 'utf8'), sandbox, { filename: 'kanban-context-menu.js' });
  const menus = () => made.filter((e) => e.attrs.id === 'nbd-kanban-ctx-menu' || e.id === 'nbd-kanban-ctx-menu');
  return { listeners, timers, made, menus };
}
function longPress(card, connectedAtFire) {
  const m = loadMenu();
  m.listeners.touchstart.forEach((fn) => fn({ target: card, touches: [{ clientX: 50, clientY: 60 }] }));
  card.isConnected = connectedAtFire;
  m.timers.splice(0).forEach((fn) => fn());
  return m;
}
const mkCard = (id) => ({ attrs: { 'data-id': id }, isConnected: true, getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
  closest() { return this; }, addEventListener() {} });

console.log('LONG-PRESS MENU (PL-F03)');
{
  const m = longPress(mkCard('lead-pressed'), true);
  const menu = m.made.find((e) => e.id === 'nbd-kanban-ctx-menu');
  assert('a long-press on a card still on the board opens the menu (positive control)', !!menu);
  assert('…and the menu names its lead', !!menu && /Test Homeowner 01/.test(menu.innerHTML), menu ? menu.innerHTML.slice(0, 160) : 'no menu');
}
{
  const m = longPress(mkCard('lead-pressed'), false);
  const menu = m.made.find((e) => e.id === 'nbd-kanban-ctx-menu');
  assert('no menu when the pressed card was replaced by a re-render before the long-press fired', !menu);
}

// ── PL-F05 ─────────────────────────────────────────────────────────────────
console.log('BULK SELECTION SURVIVES A RE-RENDER (PL-F05)');
{
  const src = fs.readFileSync(path.join(JS, 'crm-pipeline.js'), 'utf8');
  const fn = extract(src, 'function renderColumnCards(body, cards, stageKey) {', '\n}\n'.replace(/\n/g, src.includes('\r\n') ? '\r\n' : '\n'));
  const mkCardEl = (id) => ({ dataset: { id }, classList: { set: new Set(), add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } } });
  let rendered = [];
  const body = {
    set innerHTML(h) { rendered = (h.match(/data-id="([^"]+)"/g) || []).map((x) => mkCardEl(x.slice(9, -1))); },
    querySelectorAll: (sel) => (sel === '.k-card' ? rendered : []), querySelector: () => null,
  };
  const win = { _bulkMode: true };
  const sandbox = { window: win, buildCard: (l) => '<div class="k-card" data-id="' + l.id + '"></div>',
    getBulkSelected: () => new Set(['b', 'c']), KANBAN_RENDER_CAP: 75, _kbShowAll: {} };
  vm.createContext(sandbox);
  vm.runInContext('const KANBAN_RENDER_CAP = 75; const _kbShowAll = {};\n' + fn + '\nglobalThis.renderColumnCards = renderColumnCards;', sandbox);
  sandbox.renderColumnCards(body, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'new');
  const hi = rendered.filter((c) => c.classList.contains('bulk-selected')).map((c) => c.dataset.id);
  assert('cards render (positive control)', rendered.length === 3);
  assert('selected cards b and c are highlighted after the re-render', hi.join(',') === 'b,c', 'highlighted: ' + hi.join(','));
  win._bulkMode = false;
  sandbox.renderColumnCards(body, [{ id: 'a' }, { id: 'b' }], 'new');
  assert('outside bulk mode nothing is highlighted', rendered.every((c) => !c.classList.contains('bulk-selected')));
}

// ── PL-F04 ─────────────────────────────────────────────────────────────────
console.log('DROP ON AN EMPTY COLUMN CARRIES THE JOB (PL-F04)');
{
  const src = fs.readFileSync(path.join(JS, 'dashboard-bootstrap.module.js'), 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const fn = extract(src, 'window.drop = function(event, stageKey) {', eol + '  };');
  const moves = [];
  const win = { _dragId: null, _dragJobId: 'job-2' };
  const sandbox = { window: win, moveCard: (id, stage, opts) => moves.push({ id, stage, opts }) };
  vm.createContext(sandbox);
  vm.runInContext(fn, sandbox);
  const ev = { preventDefault() {}, target: { closest: () => ({ classList: { remove() {} } }) }, currentTarget: null,
    dataTransfer: { getData: (t) => (t === 'text/plain' ? 'lead-1' : t === 'application/x-nbd-job' ? 'job-2' : '') } };
  win.drop(ev, 'inspected');
  assert('the drop moves the dragged lead to the column (positive control)', moves.length === 1 && moves[0].id === 'lead-1' && moves[0].stage === 'inspected');
  assert('…with the dragged job id, so the right job moves', moves[0] && moves[0].opts && moves[0].opts.jobId === 'job-2', JSON.stringify(moves[0] && moves[0].opts));
  assert('…and the drag state is cleared', win._dragId === null && win._dragJobId === null);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
