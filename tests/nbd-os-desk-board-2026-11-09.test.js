/**
 * tests/nbd-os-desk-board-2026-11-09.test.js - NBD OS P1 "Board and drag", the
 * laptop desk board (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md
 * sections 3.2, 3.3, 3.4, 3.5).
 *
 *   1. the desk schema: layoutState['os-home'].desk items are {id,s,x,y,w,h,cfg?};
 *      a P0 ordered list ({id,s}) is placed by board-logic into the first gap in
 *      list order (no migration); cells are clamped; a saved w x h names the size;
 *      the board is gravity-packed and kept in reading order; caps are 24
 *   2. desk ops: move a cell, swap in reading order, S/M/L snap, remove, add into
 *      the first gap; each returns a new list or null, never touching its input;
 *      the live line says "Coach, medium, row 2 column 1"
 *   3. the board on screen (fake DOM, the real os.js + home.js): position classes,
 *      never a style; an old ordered desk home still renders; keyboard moves on the
 *      grid and Shift+arrows resize with the live line; one column below 1100px
 *      swaps in reading order and says "position"
 *   4. pointer drag with capture: a widget follows the pointer cell by cell, the
 *      corner grip snaps S/M/L, one debounced save on release through the layout,
 *      the click that ends a drag never picks the widget up, cancel restores
 *   5. the CSS: 4 columns of 160px rows, one column below 1100px (not hidden),
 *      touch-action:none on edit-mode widgets, the grip, no motion
 *
 * Run: node tests/nbd-os-desk-board-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness');
const { makeWin, fire, click, key, byKey, hw, text, read, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
function G(fn) { try { fn(); } catch (e) { ok('no throw: ' + (e && e.message), false, e && e.stack); } }
const J = (v) => JSON.stringify(v);

let HL = null;
try { HL = require(path.join(H.ROOT, 'docs/pro/js/os/home-logic.js')); } catch (e) { HL = null; }
ok('home-logic has the desk board ops', !!HL && typeof HL.deskBoard === 'function' && typeof HL.deskMoveBy === 'function' && typeof HL.describeDesk === 'function');
if (!HL || typeof HL.deskBoard !== 'function') { console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); }

const cells = (list) => list.map((t) => t.id + '@' + t.x + ',' + t.y + ':' + t.s).join(' ');
const tag = (list) => list.map((t, i) => Object.assign({}, t, { _k: t.id + '-' + (i + 1) }));

console.log('\n1. the desk schema');
G(() => {
  const old = HL.normalize({ desk: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }, { id: 'shortcuts', s: 's' }, { id: 'coach', s: 'l' }] }).desk;
  ok('a P0 ordered desk list is placed in list order, first gap first (M M, then S, then L beside it)',
    cells(old) === 'glance@0,0:m upnext@2,0:m shortcuts@0,1:s coach@1,1:l', cells(old));
  ok('every placed item carries its cells: S 1x1, M 2x1, L 2x2', old.every((t) => J([t.w, t.h]) === J(HL.DESK_CELLS[t.s])) && J(HL.DESK_CELLS) === J({ s: [1, 1], m: [2, 1], l: [2, 2] }));
  ok('normalize is a round trip on a placed board', J(HL.normalize({ desk: old }).desk) === J(old));
  const kept = HL.normalize({ desk: [{ id: 'coach', s: 'm', x: 2, y: 3, w: 2, h: 1 }, { id: 'glance', s: 's', x: 0, y: 0, w: 1, h: 1 }] }).desk;
  ok('saved cells are kept, gravity-packed (a gap above floats up), in reading order', cells(kept) === 'glance@0,0:s coach@2,0:m', cells(kept));
  const mixed = HL.normalize({ desk: [{ id: 'coach', s: 'm', x: 2, y: 0 }, { id: 'glance', s: 'm' }, { id: 'upnext', s: 's' }] }).desk;
  ok('items with a cell are placed first; one without goes into the first gap', cells(mixed) === 'glance@0,0:m coach@2,0:m upnext@0,1:s', cells(mixed));
  const clamp = HL.normalize({ desk: [{ id: 'glance', s: 'm', x: 3, y: 999 }, { id: 'upnext', s: 'l', x: -1, y: 0 }, { id: 'shortcuts', s: 's', x: 1.5, y: '2' }] }).desk;
  ok('x is clamped so the widget fits; y to the last row; a bad cell is auto-placed', clamp.every((t) => t.x >= 0 && t.x + t.w <= 4 && t.y >= 0 && t.y <= HL.DESK_MAX_Y) && clamp.length === 3, cells(clamp));
  const sized = HL.normalize({ desk: [{ id: 'upnext', s: 's', x: 0, y: 0, w: 2, h: 2 }, { id: 'coach', s: 'm', x: 2, y: 0, w: 1, h: 1 }, { id: 'glance', s: 'm', x: 0, y: 2, w: 3, h: 1 }] }).desk;
  ok('a saved w x h that is one of the widget\'s sizes names it (2x2 = L); one it does not offer (Coach S) or no size (3x1) keeps s',
    cells(sized) === 'upnext@0,0:l coach@2,0:m glance@0,2:m', cells(sized));
  ok('caps: 24 a surface (P1)', HL.MAX_ITEMS === 24 && HL.normalize({ desk: Array(40).fill({ id: 'shortcuts', s: 's' }) }).desk.length === 24);
  const full = HL.normalize({ desk: Array(24).fill({ id: 'coach', s: 'l' }) }).desk;
  ok('24 L widgets pack two across inside the row cap', full.length === 24 && full.every((t) => t.y <= HL.DESK_MAX_Y) && Math.max(...full.map((t) => t.y + t.h)) === 24, cells(full.slice(-2)));
  ok('the phone list stays a plain ordered list (no cells)', J(HL.normalize({ phone: [{ id: 'glance', s: 'm', x: 1, y: 1 }] }).phone) === J([{ id: 'glance', s: 'm' }]));
  ok('cfg rides along on the desk', J(HL.normalize({ desk: [{ id: 'coach', s: 'm', cfg: { show: 'personal' } }] }).desk[0]) === J({ id: 'coach', s: 'm', x: 0, y: 0, w: 2, h: 1, cfg: { show: 'personal' } }));
});

console.log('\n2. desk ops');
G(() => {
  const B = tag(HL.normalize({ desk: [{ id: 'glance', s: 'm' }, { id: 'coach', s: 'm' }, { id: 'shortcuts', s: 's' }] }).desk);
  const snap = J(B);
  ok('describeDesk: "Shortcuts, small, row 2 column 1"', HL.describeDesk(B, 2) === 'Shortcuts, small, row 2 column 1', HL.describeDesk(B, 2));
  ok('…and in one column: "position 3 of 3"', HL.describeDesk(B, 2, true) === 'Shortcuts, small, position 3 of 3');
  const r = HL.deskMoveBy(B, 2, 1, 0);
  ok('ArrowRight: one cell right', r && cells(r) === 'glance@0,0:m coach@2,0:m shortcuts@1,1:s', r && cells(r));
  ok('the caller\'s tag rides along', r && r[2]._k === 'shortcuts-3');
  const r2 = HL.deskMoveBy(r, 2, 1, 0), r3 = HL.deskMoveBy(r2, 2, 1, 0);
  ok('…and stops at the right edge (null)', r3 && r3[2].x === 3 && HL.deskMoveBy(r3, 2, 1, 0) === null, r3 && cells(r3));
  const up = HL.deskMoveBy(B, 2, 0, -1);
  ok('ArrowUp onto row 1: the others work around it', up && cells(up) === 'shortcuts@0,0:s coach@2,0:m glance@0,1:m', up && cells(up));
  const down = HL.deskMoveBy(B, 1, 0, 1);
  ok('ArrowDown with nothing under it (gravity would undo it) swaps with the next widget in reading order', down && cells(down) === 'glance@0,0:m shortcuts@2,0:s coach@0,1:m', down && cells(down));
  ok('ArrowUp on the first widget is null', HL.deskMoveBy(B, 0, 0, -1) === null);
  const big = HL.deskResize(B, 1, 1);
  ok('Shift+arrow bigger: M -> L in place (2x2)', big && cells(big) === 'glance@0,0:m coach@2,0:l shortcuts@0,1:s' && big[1].w === 2 && big[1].h === 2, big && cells(big));
  ok('…smaller from M stops at Coach\'s smallest size (no S): null', HL.deskResize(B, 1, -1) === null);
  ok('the chip cycles (0): S -> M for Shortcuts', cells(HL.deskResize(B, 2, 0)) === 'glance@0,0:m coach@2,0:m shortcuts@0,1:m');
  ok('deskSizeTo to a size the widget does not offer is null', HL.deskSizeTo(B, 1, 's') === null);
  const mv = HL.deskMoveTo(B, 2, 3, 0);
  ok('a pointer drop on a cell: there, the others work around it', mv && mv.some((t) => t.id === 'shortcuts' && t.x === 3 && t.y === 0) && mv.every((t) => t.id === 'shortcuts' || !(t.x <= 3 && t.x + t.w > 3 && t.y === 0)), mv && cells(mv));
  const sw = HL.deskSwap(B, 0, 1);
  ok('one column: swap with the next in reading order', sw && cells(sw) === 'coach@0,0:m glance@2,0:m shortcuts@0,1:s', sw && cells(sw));
  const rm = HL.deskRemove(B, 0);
  ok('remove packs the rest up', cells(rm) === 'shortcuts@0,0:s coach@2,0:m', cells(rm));
  const add = HL.deskAdd(HL.deskRemove(B, 0), 'upnext', 'm');
  ok('add drops into the first gap that fits its size (an M needs two free cells)', add && cells(add) === 'shortcuts@0,0:s coach@2,0:m upnext@0,1:m', add && cells(add));
  const add2 = HL.deskAdd(HL.deskRemove(B, 0), 'daily', 's');
  ok('…an S takes the one-cell hole beside Shortcuts', add2 && cells(add2) === 'shortcuts@0,0:s daily@1,0:s coach@2,0:m', add2 && cells(add2));
  ok('add is null when full (24) or unknown', HL.deskAdd(HL.normalize({ desk: Array(24).fill({ id: 'shortcuts', s: 's' }) }).desk, 'coach', 'm') === null && HL.deskAdd(B, 'evil') === null);
  ok('ops never touch their input', J(B) === snap);
  ok('an unplaced list (the board logic missing) is refused by the board ops, not guessed', HL.deskMoveBy([{ id: 'glance', s: 'm' }], 0, 1, 0) === null);
});

console.log('\n3. the board on screen');
const deskCol = (T) => T.document.getElementById('osDesk').querySelector('.os-widgets');
const mountDesk = (home, o) => { const T = makeWin(Object.assign({ surface: 'desktop', home }, o || {})); T.W._impl.mount({ surface: 'desktop' }); return T; };
const ids = (root) => hw(root).map((n) => n.getAttribute('data-oshw'));
const live = (root) => text(root.querySelector('.os-hw-live'));
const pos = (n) => n.className.split(/\s+/).filter((c) => /^os-hw-[xy]\d+$/.test(c)).sort().join(' ');
const homeSaves = (T) => (T.W._saves || []).filter((p) => p && p.layoutState && p.layoutState['os-home']);
G(() => {
  const T = mountDesk({ phone: [], desk: [{ id: 'glance', s: 'm' }, { id: 'coach', s: 'm' }, { id: 'shortcuts', s: 's' }] });
  const col = deskCol(T);
  const list = col.querySelector('.os-hw-list');
  ok('the desk list is the board (os-hw-board)', list && list.classList.contains('os-hw-board'));
  ok('an old ordered desk home still renders, every widget placed', J(ids(col)) === J(['glance-1', 'coach-1', 'shortcuts-1'])
    && pos(byKey(col, 'glance-1')) === 'os-hw-x1 os-hw-y1' && pos(byKey(col, 'coach-1')) === 'os-hw-x3 os-hw-y1' && pos(byKey(col, 'shortcuts-1')) === 'os-hw-x1 os-hw-y2',
    hw(col).map(pos).join(' | '));
  ok('nothing was written just by showing it (migration-free)', homeSaves(T).length === 0);
  click(T.dom, col.querySelector('[data-osdo="homeedit"]'));
  const c = byKey(col, 'coach-1');
  ok('edit mode: the label says the cell', /Coach, medium, row 1 column 3/.test(c.getAttribute('aria-label')), c.getAttribute('aria-label'));
  ok('…a corner grip for the pointer, hidden from assistive tech', !!c.querySelector('[data-oshw-grip]') && c.querySelector('[data-oshw-grip]').getAttribute('aria-hidden') === 'true');
  ok('…the help mentions dragging', /Drag it/.test(text(T.document.getElementById(c.getAttribute('aria-describedby') || 'none'))));
  key(T.dom, byKey(col, 'shortcuts-1'), 'ArrowRight');
  ok('ArrowRight moves Shortcuts a cell right', pos(byKey(col, 'shortcuts-1')) === 'os-hw-x2 os-hw-y2', pos(byKey(col, 'shortcuts-1')));
  ok('…the live line: "Shortcuts, small, row 2 column 2"', /Shortcuts, small, row 2 column 2/.test(live(col)), live(col));
  ok('…focus stays on it', T.document.activeElement === byKey(col, 'shortcuts-1'));
  key(T.dom, byKey(col, 'coach-1'), 'ArrowDown', { shiftKey: true });
  ok('Shift+ArrowDown: Coach to L', byKey(col, 'coach-1').classList.contains('is-l') && /Coach, large, row 1 column 3/.test(live(col)), live(col));
  key(T.dom, byKey(col, 'coach-1'), 'ArrowRight');
  ok('ArrowRight at the edge says so', /Coach is already at the edge/.test(live(col)), live(col));
  T.fire(700);
  const last = homeSaves(T).slice(-1)[0];
  ok('one debounced write with every cell', homeSaves(T).length === 1 && J(last.layoutState['os-home'].desk) === J([
    { id: 'glance', s: 'm', x: 0, y: 0, w: 2, h: 1 }, { id: 'coach', s: 'l', x: 2, y: 0, w: 2, h: 2 }, { id: 'shortcuts', s: 's', x: 1, y: 1, w: 1, h: 1 }]), J(last));
  // one column below 1100px: arrows swap in reading order, the line says position
  T.W.matchMedia = () => ({ matches: true });
  key(T.dom, byKey(col, 'glance-1'), 'ArrowDown');
  ok('one column: ArrowDown swaps with the next in reading order', ids(col)[0] === 'coach-1' && ids(col)[1] === 'glance-1', J(ids(col)));
  ok('…and says the place, not a cell', /Glance, medium, position 2 of 3/i.test(live(col)), live(col));
  ok('…no style attribute anywhere on the board', !/style=/.test(col.innerHTML));
});

console.log('\n4. pointer drag with capture');
G(() => {
  const T = mountDesk({ phone: [], desk: [{ id: 'glance', s: 'm' }, { id: 'coach', s: 'm' }, { id: 'shortcuts', s: 's' }] });
  const col = deskCol(T);
  const list = col.querySelector('.os-hw-list');
  // a 4-column board 636px wide at (100, 50): columns of 150px with 12px gaps, rows of 160px
  list.getBoundingClientRect = () => ({ left: 100, top: 50, width: 636, height: 800 });
  click(T.dom, col.querySelector('[data-osdo="homeedit"]'));
  const sc = byKey(col, 'shortcuts-1');
  sc.getBoundingClientRect = () => ({ left: 100, top: 222, width: 150, height: 160 });
  const caps = [];
  sc.setPointerCapture = (id) => caps.push('set' + id);
  sc.releasePointerCapture = (id) => caps.push('rel' + id);
  fire(T.dom, sc.querySelector('.os-hw-body'), 'pointerdown', { clientX: 160, clientY: 300, pointerId: 7 });
  fire(T.dom, sc, 'pointermove', { clientX: 163, clientY: 301, pointerId: 7 });
  ok('a 4px wobble is still a tap (no capture, no drag)', !caps.length && !sc.classList.contains('is-dragging'));
  fire(T.dom, sc, 'pointermove', { clientX: 160 + 3 * 162, clientY: 300 - 172, pointerId: 7 });
  ok('past 8px: pointer capture and the dragging look', caps[0] === 'set7' && sc.classList.contains('is-dragging'));
  ok('…it follows the pointer cell by cell (row 1, column 4), the others around it', pos(sc) === 'os-hw-x4 os-hw-y1' && pos(byKey(col, 'coach-1')) !== 'os-hw-x3 os-hw-y1', hw(col).map(pos).join(' | '));
  ok('…and nothing is saved while dragging', homeSaves(T).length === 0 && !T.W.__homeNextSeen);
  fire(T.dom, sc, 'pointerup', { clientX: 160 + 3 * 162, clientY: 300 - 172, pointerId: 7 });
  const clk = click(T.dom, sc);
  ok('release: capture let go, the click that ends the drag does not pick it up', caps[1] === 'rel7' && !sc.classList.contains('is-dragging') && !byKey(col, 'shortcuts-1').classList.contains('is-picked') && clk.defaultPrevented);
  ok('…the live line says where it landed', /Shortcuts, small, row 1 column 4/.test(live(col)), live(col));
  T.fire(700);
  const d = homeSaves(T).slice(-1)[0];
  ok('…one write through the layout\'s debounced save, with the dropped cell', homeSaves(T).length === 1 && d.layoutState['os-home'].desk.some((t) => t.id === 'shortcuts' && t.x === 3 && t.y === 0), J(d));
  // the grip: drag the corner out two cells and down two rows -> L
  const g = byKey(col, 'glance-1');
  g.getBoundingClientRect = () => ({ left: 100, top: 50, width: 312, height: 160 });
  fire(T.dom, g.querySelector('[data-oshw-grip]'), 'pointerdown', { clientX: 400, clientY: 200, pointerId: 8 });
  fire(T.dom, g, 'pointermove', { clientX: 410, clientY: 50 + 2 * 172, pointerId: 8 });
  ok('the grip: S/M/L snap while dragging (M -> L at two rows)', g.classList.contains('is-l') && g.classList.contains('is-dragging'), g.className);
  fire(T.dom, g, 'pointerup', { clientX: 410, clientY: 50 + 2 * 172, pointerId: 8 });
  ok('…released: Glance is L and the line says so', byKey(col, 'glance-1').classList.contains('is-l') && /Glance, large/.test(live(col)), live(col));
  fire(T.dom, byKey(col, 'glance-1').querySelector('[data-oshw-grip]'), 'pointerdown', { clientX: 400, clientY: 200, pointerId: 9 });
  fire(T.dom, byKey(col, 'glance-1'), 'pointermove', { clientX: 150, clientY: 120, pointerId: 9 });
  ok('the grip back to one cell: S (Glance offers S)', byKey(col, 'glance-1').classList.contains('is-s'));
  fire(T.dom, byKey(col, 'glance-1'), 'pointercancel', { clientX: 150, clientY: 120, pointerId: 9 });
  ok('a cancelled drag puts it back (L) and saves nothing', byKey(col, 'glance-1').classList.contains('is-l') && !byKey(col, 'glance-1').classList.contains('is-dragging'));
  // the chip and Remove keep their own clicks: a press on them never starts a drag
  const n0 = homeSaves(T).length;
  fire(T.dom, byKey(col, 'coach-1').querySelector('[data-oshw-ed="size"]'), 'pointerdown', { clientX: 10, clientY: 10, pointerId: 10 });
  fire(T.dom, byKey(col, 'coach-1'), 'pointermove', { clientX: 300, clientY: 300, pointerId: 10 });
  ok('a press on the S/M/L chip never drags', !byKey(col, 'coach-1').classList.contains('is-dragging'));
  fire(T.dom, byKey(col, 'coach-1'), 'pointerup', { clientX: 300, clientY: 300, pointerId: 10 });
  // outside edit mode a press never drags
  click(T.dom, col.querySelector('[data-osdo="homedone"]'));
  const k = byKey(col, 'coach-1');
  fire(T.dom, k, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 11 });
  fire(T.dom, k, 'pointermove', { clientX: 300, clientY: 300, pointerId: 11 });
  ok('outside edit mode a pointer never drags a widget', !k.classList.contains('is-dragging'));
  fire(T.dom, k, 'pointerup', { clientX: 300, clientY: 300, pointerId: 11 });
  ok('leaving edit mode wrote the pending change once', homeSaves(T).length === n0 + 1, homeSaves(T).length);
  ok('no Firestore read, no fetch', T.reads.length === 0, J(T.reads));
});

console.log('\n4b. the column scrolls mid-drag (wheel): the board moves, the drag keeps up');
G(() => {
  const T = mountDesk({ phone: [], desk: [{ id: 'glance', s: 'm' }, { id: 'coach', s: 'm' }, { id: 'shortcuts', s: 's' }] });
  const col = deskCol(T);
  const list = col.querySelector('.os-hw-list');
  let top = 50;
  list.getBoundingClientRect = () => ({ left: 100, top, width: 636, height: 800 });
  click(T.dom, col.querySelector('[data-osdo="homeedit"]'));
  // a cell drag: the widget stays under the pointer, so after a scroll it is over the content now under it
  const sc = byKey(col, 'shortcuts-1');
  sc.getBoundingClientRect = () => ({ left: 100, top: 222, width: 150, height: 160 });
  fire(T.dom, sc.querySelector('.os-hw-body'), 'pointerdown', { clientX: 160, clientY: 300, pointerId: 21 });
  fire(T.dom, sc, 'pointermove', { clientX: 160, clientY: 320, pointerId: 21 });
  ok('cell drag before the scroll: row 2', pos(sc) === 'os-hw-x1 os-hw-y2', pos(sc));
  top = 50 + 172;   // scrolled up a row: the board slid down under a still pointer
  fire(T.dom, sc, 'pointermove', { clientX: 160, clientY: 321, pointerId: 21 });
  ok('…after the scroll: the row now under the pointer (row 1)', pos(sc) === 'os-hw-x1 os-hw-y1', pos(sc));
  fire(T.dom, sc, 'pointercancel', { clientX: 160, clientY: 321, pointerId: 21 });
  // the grip: the widget's corner moved with the board, so the size is measured from where it is now
  top = 50;
  const g = byKey(col, 'glance-1');
  g.getBoundingClientRect = () => ({ left: 100, top: 50, width: 312, height: 160 });
  fire(T.dom, g.querySelector('[data-oshw-grip]'), 'pointerdown', { clientX: 400, clientY: 200, pointerId: 22 });
  fire(T.dom, g, 'pointermove', { clientX: 410, clientY: 50 + 2 * 172, pointerId: 22 });
  ok('grip before the scroll: two rows down is L', g.classList.contains('is-l'), g.className);
  top = 50 + 172;   // the board (and Glance with it) slid down a row; the pointer is one row below Glance's top
  fire(T.dom, g, 'pointermove', { clientX: 410, clientY: 50 + 2 * 172 + 1, pointerId: 22 });
  ok('…after the scroll the grip reaches one row from Glance\'s top now: M, not a stale L', g.classList.contains('is-m') && !g.classList.contains('is-l'), g.className);
  fire(T.dom, g, 'pointercancel', { clientX: 410, clientY: 395, pointerId: 22 });
});

console.log('\n4c. a repaint mid-drag keeps the preview');
G(() => {
  const T = mountDesk({ phone: [], desk: [{ id: 'glance', s: 'm' }, { id: 'coach', s: 'm' }, { id: 'shortcuts', s: 's' }] });
  const col = deskCol(T);
  col.querySelector('.os-hw-list').getBoundingClientRect = () => ({ left: 100, top: 50, width: 636, height: 800 });
  click(T.dom, col.querySelector('[data-osdo="homeedit"]'));
  const sc = byKey(col, 'shortcuts-1');
  sc.getBoundingClientRect = () => ({ left: 100, top: 222, width: 150, height: 160 });
  fire(T.dom, sc.querySelector('.os-hw-body'), 'pointerdown', { clientX: 160, clientY: 300, pointerId: 31 });
  fire(T.dom, sc, 'pointermove', { clientX: 160 + 3 * 162, clientY: 300 - 172, pointerId: 31 });
  const before = hw(col).map(pos).join(' | ');
  ok('mid-drag: Shortcuts previewed at row 1 column 4', pos(sc) === 'os-hw-x4 os-hw-y1', before);
  T.fire(3000);   // the layout's app-list refresh repaints the home (update) while the pointer is down
  ok('…a repaint keeps the previewed cells and the lifted look', hw(col).map(pos).join(' | ') === before && sc.classList.contains('is-dragging'), hw(col).map(pos).join(' | '));
  fire(T.dom, sc, 'pointerup', { clientX: 160 + 3 * 162, clientY: 300 - 172, pointerId: 31 });
  ok('…and the release still lands there', pos(byKey(col, 'shortcuts-1')) === 'os-hw-x4 os-hw-y1', pos(byKey(col, 'shortcuts-1')));
});

console.log('\n5. the CSS and the files');
G(() => {
  const css = read('docs/pro/css/os/home.css').replace(/\n/g, ' ');
  const js = read('docs/pro/js/os/home.js');
  ok('the board: 4 columns, 160px rows, 12px gaps (home.js ROW_PX / GAP_PX match)', /\.os-hw-board \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[^}]*grid-auto-rows: 160px;[^}]*gap: 12px/.test(css)
    && /ROW_PX = 160, GAP_PX = 12/.test(js));
  ok('every cell class exists: x1-x4, y1-y48', [1, 2, 3, 4].every((i) => css.indexOf('.os-hw-x' + i + ' { grid-column-start: ' + i + '; }') !== -1)
    && Array.from({ length: 48 }, (_, i) => i + 1).every((i) => css.indexOf('.os-hw-y' + i + ' { grid-row-start: ' + i + '; }') !== -1) && HL.DESK_MAX_Y + 1 === 48);
  ok('below 1100px: one column, never hidden, no grip', /@media \(max-width: 1100px\) \{[^@]*grid-template-columns: 1fr;[^@]*\.os-hw-grip \{ display: none; \}/.test(css) && !/\.os-hw-board[^{]*\{[^}]*display: none/.test(css));
  ok('edit-mode widgets carry touch-action:none before any pointerdown', /\.os-hw\.is-editing \{ touch-action: none; \}/.test(css));
  ok('the grip is a 44px target', /\.os-hw-grip \{[^}]*width: 44px; height: 44px;/.test(css));
  // the Edit Home / Add widget bar is its own row under the board, never over a widget (it was sticky over the
  // last row at 1280, 2026-11-09): the column is a flex column, the board scrolls, the bar does not
  ok('the desk column is a flex column that does not scroll itself; the board is the scroller', /\.os-widgets\.os-hw-desk \{[^}]*display: flex; flex-direction: column;[^}]*overflow: hidden;/.test(css)
    && /\.os-hw-desk > \.os-hw-board \{[^}]*min-height: 0;[^}]*overflow-y: auto;/.test(css), (css.match(/\.os-widgets\.os-hw-desk \{[^}]*\}/) || [''])[0]);
  ok('...the bar takes its own row (no sticky, no flex shrink), so no widget ever sits under it, and nothing needs a scroll margin',
    /\.os-hw-desk > \.os-hw-tools \{[^}]*position: static;[^}]*flex: none;/.test(css) && !/scroll-margin|scroll-padding[a-z-]*:/.test(css));
  ok('...and the drag\'s edge scroll moves the board, the desk\'s scroller', /function scroller\(n\) \{[^}]*closest\('\.os-hw-board'\)/.test(js));
  ok('no transition or animation in the drag rules (cells snap; both reduce-motion switches have nothing to stop)', !/transition|animation/.test(css.slice(css.indexOf('desk (P1)'))));
  ok('no style attribute, no .style. and no setProperty in home.js or home-logic.js', !/style\s*=|\.style\.|setProperty/.test(noComments(js)) && !/style\s*=|\.style\.|setProperty/.test(noComments(read('docs/pro/js/os/home-logic.js'))));
  ok('pointer capture, not a library (no SortableJS)', /setPointerCapture/.test(js) && /releasePointerCapture/.test(js) && !/Sortable/i.test(js));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
