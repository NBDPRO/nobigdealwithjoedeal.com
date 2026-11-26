/**
 * kanban-touch-drag.js — drag pipeline cards between columns by touch (2026-11-25).
 *
 * The board's drag is HTML5 drag-and-drop (crm-pipeline.js), which a touch
 * screen does not drive the same way on every phone: Android Chrome sometimes
 * lifts a draggable card on a long press, an iPhone does not. Joe's pick
 * (2026-11-25): on any touch screen showing the Board,
 *   - hold a card ~0.3 s: it lifts;
 *   - drag it over another column and let go: it moves there, through the
 *     same moveCard(id, columnKey, { isDrag: true }) a desktop drop uses
 *     (so the role guard, stage gates and column-collapse rules all apply);
 *   - let go without moving: nothing here, and the 0.5 s card menu
 *     (kanban-context-menu.js) opens as before. If that menu opens while the
 *     card is lifted, the lift is dropped;
 *   - near the screen's left/right edge the board scrolls sideways, near a
 *     column's top/bottom the column scrolls.
 * A card touched on a touch screen is made non-draggable for that touch, so
 * the browser's own drag never competes: both phones get this one gesture.
 *
 * Loaded with the lazy `kanbanctx` bundle (dashboard-actions.js), so it costs
 * the dashboard boot nothing. Pure helpers are exported for Node tests.
 */
(function (root) {
  'use strict';

  var HOLD_MS = 300;      // under the card menu's 500 ms
  var SLOP_PX = 10;       // a finger may wander this far and still be a hold
  var EDGE_PX = 48;       // auto-scroll zone at each edge
  var MAX_STEP = 18;      // px per frame at the very edge

  // ── pure ────────────────────────────────────────────────────────────────
  /** Scroll step for a position inside a box: negative near the start, positive near the end, 0 in the middle. */
  function edgeStep(pos, size, edge, max) {
    edge = edge || EDGE_PX; max = max || MAX_STEP;
    if (!(size > 0)) return 0;
    if (pos < edge) return -Math.ceil(max * (edge - Math.max(pos, 0)) / edge);
    if (pos > size - edge) return Math.ceil(max * (Math.min(pos, size) - (size - edge)) / edge);
    return 0;
  }
  /** The stage/column key a column body stands for ('kbody-<key>' → '<key>'), or ''. */
  function columnKey(el) {
    var id = el && el.id ? String(el.id) : '';
    return id.indexOf('kbody-') === 0 ? id.slice(6) : '';
  }
  /** Moved further than the slop since the start point? */
  function beyondSlop(x0, y0, x, y, slop) {
    var dx = x - x0, dy = y - y0, s = slop == null ? SLOP_PX : slop;
    return dx * dx + dy * dy > s * s;
  }
  var pure = { edgeStep: edgeStep, columnKey: columnKey, beyondSlop: beyondSlop, HOLD_MS: HOLD_MS, SLOP_PX: SLOP_PX };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; return; }

  // ── browser ─────────────────────────────────────────────────────────────
  var w = root, d = w.document;
  if (!d || w.NBDKanbanTouchDrag) return;

  var INTERACTIVE = 'button, a, input, select, textarea, label, [contenteditable="true"]';
  var s = null; // the touch being tracked

  function touchScreen() {
    try { return !!(w.matchMedia && w.matchMedia('(pointer: coarse)').matches); } catch (_) { return false; }
  }
  function menuOpen() {
    var k = w.KanbanContextMenu;
    return !!(k && typeof k.isOpen === 'function' && k.isOpen());
  }
  function bodyAt(x, y) {
    var el = d.elementFromPoint ? d.elementFromPoint(x, y) : null;
    if (!el || !el.closest) return null;
    var b = el.closest('.kcol-body');
    if (b) return b;
    var col = el.closest('.kcol');
    return col ? col.querySelector('.kcol-body') : null;
  }
  function setOver(body) {
    if (s.over === body) return;
    if (s.over) s.over.classList.remove('drag-over');
    s.over = body;
    if (body && columnKey(body)) body.classList.add('drag-over');
  }

  function cleanup() {
    if (!s) return;
    if (s.holdT) clearTimeout(s.holdT);
    if (s.raf && w.cancelAnimationFrame) w.cancelAnimationFrame(s.raf);
    if (s.ghost && s.ghost.parentNode) s.ghost.parentNode.removeChild(s.ghost);
    if (s.over) s.over.classList.remove('drag-over');
    var c = s.card;
    c.classList.remove('dragging');
    c.style.transform = s.prevTransform; c.style.boxShadow = s.prevShadow;
    if (s.wasDraggable) c.setAttribute('draggable', 'true');
    s = null;
  }

  function lift() {
    if (!s || !s.card.isConnected) { cleanup(); return; }
    s.lifted = true;
    s.card.style.transform = 'scale(1.03)';
    s.card.style.boxShadow = '0 10px 28px rgba(0,0,0,.35)';
    try { if (w.navigator.vibrate) w.navigator.vibrate(10); } catch (_) { /* no haptics on iPhone */ }
  }

  function startDrag() {
    var c = s.card, r = c.getBoundingClientRect();
    var g = c.cloneNode(true);
    g.removeAttribute('id');
    g.setAttribute('aria-hidden', 'true');
    g.classList.add('k-touch-ghost');
    var st = g.style;
    st.position = 'fixed'; st.left = '0'; st.top = '0'; st.width = r.width + 'px'; st.margin = '0';
    st.zIndex = '10060'; st.pointerEvents = 'none'; st.opacity = '.92';
    st.boxShadow = '0 14px 34px rgba(0,0,0,.4)';
    s.offX = s.x0 - r.left; s.offY = s.y0 - r.top;
    d.body.appendChild(g);
    s.ghost = g; s.dragging = true;
    c.classList.add('dragging');
    c.style.transform = s.prevTransform;
    tick();
  }

  function place() {
    s.ghost.style.transform = 'translate(' + (s.x - s.offX) + 'px,' + (s.y - s.offY) + 'px) rotate(1.5deg)';
    setOver(bodyAt(s.x, s.y));
  }

  // auto-scroll while the finger rests near an edge
  function tick() {
    if (!s || !s.dragging) return;
    var board = d.getElementById('kanbanBoard');
    var moved = false;
    if (board) {
      var br = board.getBoundingClientRect();
      var dx = edgeStep(s.x - br.left, br.width);
      if (dx) { var before = board.scrollLeft; board.scrollLeft += dx; moved = moved || board.scrollLeft !== before; }
    }
    if (s.over) {
      var or = s.over.getBoundingClientRect();
      var dy = edgeStep(s.y - or.top, or.height);
      if (dy) { var b4 = s.over.scrollTop; s.over.scrollTop += dy; moved = moved || s.over.scrollTop !== b4; }
    }
    if (moved) place();
    s.raf = w.requestAnimationFrame ? w.requestAnimationFrame(tick) : 0;
  }

  function onStart(e) {
    if (s) cleanup();
    if (!e.touches || e.touches.length !== 1 || !touchScreen()) return;
    if (d.body && d.body.classList.contains('crm-list-mode')) return;
    var t = e.target;
    var card = t && t.closest ? t.closest('.k-card') : null;
    if (!card || !card.getAttribute('data-id') || !d.getElementById('kanbanBoard') || !d.getElementById('kanbanBoard').contains(card)) return;
    if (t.closest(INTERACTIVE) && t.closest(INTERACTIVE) !== card) return; // a button inside the card keeps its tap
    var p = e.touches[0];
    s = {
      card: card, id: card.getAttribute('data-id'), jobId: card.getAttribute('data-job-id') || '',
      x0: p.clientX, y0: p.clientY, x: p.clientX, y: p.clientY,
      lifted: false, dragging: false, ghost: null, over: null, raf: 0,
      prevTransform: card.style.transform, prevShadow: card.style.boxShadow,
      wasDraggable: card.getAttribute('draggable') === 'true',
    };
    // the browser's own drag must not compete with this one
    if (s.wasDraggable) card.setAttribute('draggable', 'false');
    s.holdT = setTimeout(function () { if (s) { s.holdT = 0; lift(); } }, HOLD_MS);
  }

  function onMove(e) {
    if (!s) return;
    var p = e.touches && e.touches[0];
    if (!p) return;
    s.x = p.clientX; s.y = p.clientY;
    if (!s.lifted) {
      if (beyondSlop(s.x0, s.y0, s.x, s.y)) cleanup(); // a scroll, not a hold
      return;
    }
    if (menuOpen()) { cleanup(); return; }            // the hold became the card menu
    if (e.cancelable) e.preventDefault();              // a lifted card does not scroll the page
    if (!s.dragging) {
      if (!beyondSlop(s.x0, s.y0, s.x, s.y)) return;
      startDrag();
    }
    place();
  }

  function onEnd() {
    if (!s) return;
    var done = s.dragging && s.over && columnKey(s.over) ? { id: s.id, key: columnKey(s.over), jobId: s.jobId } : null;
    var card = s.card, dragged = s.dragging;
    cleanup();
    if (dragged) {
      // the click that follows the finger lifting must not open the card
      var eat = function (ev) { ev.preventDefault(); ev.stopPropagation(); };
      card.addEventListener('click', eat, { once: true, capture: true });
      setTimeout(function () { card.removeEventListener('click', eat, { capture: true }); }, 400);
    }
    if (done && typeof w.moveCard === 'function') {
      w.moveCard(done.id, done.key, { isDrag: true, jobId: done.jobId || undefined });
    }
  }

  d.addEventListener('touchstart', onStart, { passive: true, capture: true });
  d.addEventListener('touchmove', onMove, { passive: false, capture: true });
  d.addEventListener('touchend', onEnd, { passive: true, capture: true });
  d.addEventListener('touchcancel', function () { cleanup(); }, { passive: true, capture: true });

  w.NBDKanbanTouchDrag = Object.assign({ active: function () { return !!(s && s.dragging); } }, pure);
})(typeof window !== 'undefined' ? window : this);
