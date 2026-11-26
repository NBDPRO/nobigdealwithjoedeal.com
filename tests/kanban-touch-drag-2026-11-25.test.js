/**
 * kanban-touch-drag-2026-11-25.test.js — hold, then drag a pipeline card by touch.
 *
 * Joe's pick (2026-11-25): on any touch screen showing the Board, hold a card
 * ~0.3 s to lift it, drag it over another column and let go to move it; let go
 * without moving and the 0.5 s card menu opens as before. This suite RUNS
 * docs/pro/js/kanban-touch-drag.js in a VM with a fake board (two columns, one
 * card), a fake clock and real-shaped touch events, and checks what reaches
 * moveCard().
 *
 * Run: node tests/kanban-touch-drag-2026-11-25.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const K = require('./lib/src-kit');
const t = K.suite();

const FILE = path.join(K.ROOT, 'docs/pro/js/kanban-touch-drag.js');
const SRC = fs.readFileSync(FILE, 'utf8');
const P = require(FILE);

t.section('pure helpers');
t.ok('edgeStep: 0 in the middle, negative near the start, positive near the end, capped', P.edgeStep(200, 400) === 0 && P.edgeStep(0, 400) === -18 && P.edgeStep(400, 400) === 18 && P.edgeStep(24, 400) < 0 && P.edgeStep(24, 400) > -18);
t.ok('edgeStep: an empty box never scrolls', P.edgeStep(5, 0) === 0);
t.ok('columnKey reads kbody-<key> and nothing else', P.columnKey({ id: 'kbody-inspected' }) === 'inspected' && P.columnKey({ id: 'kanbanBoard' }) === '' && P.columnKey(null) === '');
t.ok('beyondSlop: 10 px is still a hold, 11 px is a move', !P.beyondSlop(0, 0, 10, 0) && P.beyondSlop(0, 0, 11, 0));
t.ok('the hold is shorter than the card menu\'s 500 ms', P.HOLD_MS < 500);

// ── a fake board ───────────────────────────────────────────────────────────
function harness(opts) {
  opts = opts || {};
  let now = 0, seq = 0; const timers = new Map();
  const listeners = {};
  function el(tag, props) {
    const e = Object.assign({
      tagName: tag.toUpperCase(), id: '', attrs: {}, style: {}, children: [], parentNode: null, isConnected: true,
      scrollLeft: 0, scrollTop: 0, rect: { left: 0, top: 0, width: 100, height: 100 }, _ls: {},
      classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      removeAttribute(k) { delete this.attrs[k]; },
      getBoundingClientRect() { return this.rect; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; },
      contains(x) { for (let n = x; n; n = n.parentNode) if (n === this) return true; return false; },
      closest(sel) { for (let n = this; n; n = n.parentNode) if (n.matches && n.matches(sel)) return n; return null; },
      matches(sel) { return sel.split(',').some((s) => { s = s.trim(); if (s[0] === '.') return this.classList.contains(s.slice(1)); if (s[0] === '#') return this.id === s.slice(1); return this.tagName.toLowerCase() === s; }); },
      querySelector(sel) { const all = []; (function w(n) { n.children.forEach((c) => { all.push(c); w(c); }); })(this); return all.find((n) => n.matches(sel)) || null; },
      addEventListener(type, fn, o) { (this._ls[type] = this._ls[type] || []).push({ fn, once: o && o.once }); },
      removeEventListener(type, fn) { this._ls[type] = (this._ls[type] || []).filter((l) => l.fn !== fn); },
      cloneNode() { return el(tag, { classes: [...this.classList.set] }); },
    }, props || {});
    (props && props.classes || []).forEach((c) => e.classList.add(c));
    return e;
  }
  const body = el('body');
  const board = el('div', { id: 'kanbanBoard', rect: { left: 0, top: 0, width: 400, height: 800 } });
  const col1 = el('div', { classes: ['kcol'] }); const b1 = el('div', { id: 'kbody-new', classes: ['kcol-body'], rect: { left: 0, top: 100, width: 200, height: 600 } });
  const col2 = el('div', { classes: ['kcol'] }); const b2 = el('div', { id: 'kbody-inspected', classes: ['kcol-body'], rect: { left: 200, top: 100, width: 200, height: 600 } });
  const card = el('div', { classes: ['k-card'], rect: { left: 10, top: 120, width: 180, height: 90 } });
  card.attrs = { 'data-id': 'L1', draggable: 'true' };
  const btn = el('button');
  body.appendChild(board); board.appendChild(col1); board.appendChild(col2); col1.appendChild(b1); col2.appendChild(b2); b1.appendChild(card); card.appendChild(btn);
  if (opts.listMode) body.classList.add('crm-list-mode');
  const moves = []; let menu = false;
  const document = {
    body, readyState: 'complete',
    getElementById: (id) => ({ kanbanBoard: board, 'kbody-new': b1, 'kbody-inspected': b2 })[id] || null,
    elementFromPoint: (x) => (x >= 200 ? b2 : b1),
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const window = {
    document, navigator: {},
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? opts.coarse !== false : false }),
    moveCard: (id, key, o) => moves.push([id, key, o && o.isDrag, o && o.jobId]),
    KanbanContextMenu: { isOpen: () => menu },
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
  };
  const ctx = vm.createContext({ window, document, setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout: (id) => timers.delete(id), Object, Math, String, console });
  vm.runInContext(SRC, ctx);
  const fire = (type, target, x, y) => {
    let prevented = false;
    const ev = { type, target, cancelable: true, preventDefault() { prevented = true; }, touches: x == null ? [] : [{ clientX: x, clientY: y }] };
    (listeners[type] || []).forEach((fn) => fn(ev));
    return prevented;
  };
  const advance = (ms) => { now += ms; [...timers].filter(([, v]) => v.at <= now).forEach(([id, v]) => { timers.delete(id); v.fn(); }); };
  return { fire, advance, card, btn, b1, b2, body, moves, setMenu: (v) => { menu = v; }, window };
}

t.section('hold, drag, let go');
{
  const h = harness();
  h.fire('touchstart', h.card, 50, 150);
  t.ok('a touched card stops being natively draggable for that touch', h.card.getAttribute('draggable') === 'false');
  h.advance(310);
  const blocked = h.fire('touchmove', h.card, 260, 160);
  t.ok('once lifted, moving the finger does not scroll the page', blocked === true);
  t.ok('the card is shown as dragging and a ghost follows the finger', h.card.classList.contains('dragging') && h.body.children.some((c) => c.classList.contains('k-touch-ghost')));
  t.ok('the column under the finger is highlighted', h.b2.classList.contains('drag-over'));
  h.fire('touchend', h.card);
  t.ok('letting go over another column moves the card there, as a drag', JSON.stringify(h.moves) === JSON.stringify([['L1', 'inspected', true, null]]), JSON.stringify(h.moves));
  t.ok('afterwards: no ghost, no highlight, draggable restored', !h.body.children.some((c) => c.classList.contains('k-touch-ghost')) && !h.b2.classList.contains('drag-over') && h.card.getAttribute('draggable') === 'true');
  t.ok('…and the click that follows the lift is eaten once (the card does not open)', (h.card._ls.click || []).length === 1);
}
{
  const h = harness();
  h.fire('touchstart', h.card, 50, 150); h.advance(310);
  h.fire('touchmove', h.card, 90, 160); h.fire('touchend', h.card);
  t.ok('dropping back on its own column still goes through moveCard (which no-ops a same-column drag)', h.moves.length === 1 && h.moves[0][1] === 'new');
}

t.section('what must NOT start a drag');
{
  const h = harness();
  h.fire('touchstart', h.card, 50, 150);
  const prevented = h.fire('touchmove', h.card, 50, 190); // a 40 px swipe before the hold
  h.advance(400); h.fire('touchmove', h.card, 260, 190); h.fire('touchend', h.card);
  t.ok('a swipe before the hold is a scroll: never blocked, nothing moves', prevented === false && h.moves.length === 0 && h.card.getAttribute('draggable') === 'true');
}
{
  const h = harness();
  h.fire('touchstart', h.card, 50, 150); h.advance(200); h.fire('touchend', h.card);
  t.ok('a quick tap moves nothing and leaves the click alone (the card opens)', h.moves.length === 0 && !(h.card._ls.click || []).length);
}
{
  const h = harness();
  h.fire('touchstart', h.card, 50, 150); h.advance(510); h.setMenu(true);
  h.fire('touchmove', h.card, 260, 160); h.fire('touchend', h.card);
  t.ok('when the hold became the card menu, the lift is dropped and nothing moves', h.moves.length === 0 && !h.card.classList.contains('dragging'));
}
{
  const h = harness({ listMode: true });
  h.fire('touchstart', h.card, 50, 150); h.advance(310); h.fire('touchmove', h.card, 260, 160); h.fire('touchend', h.card);
  t.ok('the List view (phones\' default) is left alone', h.moves.length === 0 && h.card.getAttribute('draggable') === 'true');
}
{
  const h = harness({ coarse: false });
  h.fire('touchstart', h.card, 50, 150); h.advance(310); h.fire('touchmove', h.card, 260, 160); h.fire('touchend', h.card);
  t.ok('a mouse-first screen keeps the desktop drag only', h.moves.length === 0);
}
{
  const h = harness();
  h.fire('touchstart', h.btn, 50, 150); h.advance(310); h.fire('touchmove', h.btn, 260, 160); h.fire('touchend', h.btn);
  t.ok('a button inside the card keeps its tap (no drag from it)', h.moves.length === 0);
}
{
  const h = harness();
  h.fire('touchstart', h.card, 50, 150); h.advance(310); h.fire('touchmove', h.card, 260, 160); h.fire('touchcancel', h.card);
  t.ok('a cancelled touch moves nothing and cleans up', h.moves.length === 0 && !h.card.classList.contains('dragging') && h.card.getAttribute('draggable') === 'true');
}

t.section('wiring');
const sl = K.read('docs/pro/js/kanban-context-menu.js');
t.ok('the card menu fetches the touch-drag file on touch screens only', /matchMedia\('\(pointer: coarse\)'\)[^\n]*ScriptLoader\.load\('js\/kanban-touch-drag\.js\?v=\d+'\)|matchMedia\('\(pointer: coarse\)'\)\.matches && window\.ScriptLoader[\s\S]{0,160}ScriptLoader\.load\('js\/kanban-touch-drag\.js\?v=\d+'\)/.test(sl));
t.ok('the card menu says when it is open', /isOpen: \(\) => !!menuEl/.test(sl));

t.done();
