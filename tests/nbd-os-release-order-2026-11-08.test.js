/**
 * tests/nbd-os-release-order-2026-11-08.test.js - OS-RELEASE-ORDER (P3):
 * releasing a view from an NBD OS window could change Classic's view order.
 *
 * adopt() recorded a view's next sibling and release() put the view back
 * before it, or APPENDED it when that sibling was itself still inside another
 * window. Close Home then Jobs, or switch back to Classic (unmount releases in
 * adoption order), and .content's children came back in a different order.
 *
 * Now the layout learns Classic's order of .content's children as it adopts
 * (NBDOSWm.mergeOrder) and a released view goes back before the first child
 * after it that is home (NBDOSWm.restoreIndex), so the order is restored
 * whatever order the windows open and close in.
 *
 *   1. the pure helpers in layouts/os-wm-logic.js
 *   2. the REAL adopt()/release() of layouts/os.js, lifted into a tiny fake
 *      .content (breadcrumb first, the layout's desk last, windows inside it):
 *      the finding's close order, the reverse open order, the unmount walk,
 *      every open x close permutation of three windows, late siblings
 *   3. wiring (static)
 *
 * Run: node tests/nbd-os-release-order-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const WM = require(path.join(ROOT, 'docs/pro/js/layouts/os-wm-logic.js'));
const OS = read('docs/pro/js/layouts/os.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 300) : '')); }
}
const J = JSON.stringify;

console.log('1. pure helpers (os-wm-logic.js)');
{
  ok('mergeOrder and restoreIndex are exported', typeof WM.mergeOrder === 'function' && typeof WM.restoreIndex === 'function');
  const m = (o, n) => (typeof WM.mergeOrder === 'function' ? WM.mergeOrder(o, n) : null);
  const r = (o, i, n) => (typeof WM.restoreIndex === 'function' ? WM.restoreIndex(o, i, n) : null);
  ok('mergeOrder: an empty order learns the children as they stand', J(m([], ['a', 'b', 'c'])) === J(['a', 'b', 'c']), J(m([], ['a', 'b', 'c'])));
  ok('mergeOrder: children away in windows keep their place', J(m(['a', 'b', 'c', 'd'], ['a', 'c'])) === J(['a', 'b', 'c', 'd']));
  ok('mergeOrder: a new child goes in ahead of the first known child after it', J(m(['a', 'b', 'c'], ['a', 'n', 'c'])) === J(['a', 'b', 'n', 'c']), J(m(['a', 'b', 'c'], ['a', 'n', 'c'])));
  ok('mergeOrder: a new last child goes last; two new ones keep their own order', J(m(['a', 'b'], ['a', 'b', 'y', 'z'])) === J(['a', 'b', 'y', 'z']));
  ok('mergeOrder: garbage in, an array out, and the given order is not mutated', (() => { const o = ['a']; const out = m(o, null); return J(out) === J(['a']) && out !== o && J(m(undefined, undefined)) === '[]'; })());
  ok('restoreIndex: before the first home child that follows it', r(['a', 'b', 'c', 'd'], 'b', ['a', 'c', 'd']) === 1);
  ok('restoreIndex: first in Classic goes first even when its old next sibling is away', r(['a', 'b', 'c', 'd'], 'a', ['c', 'd']) === 0);
  ok('restoreIndex: nothing after it home -> append (now.length)', r(['a', 'b', 'c', 'd'], 'd', ['a', 'b']) === 2);
  ok('restoreIndex: an item the order never learned appends', r(['a', 'b', 'c'], 'x', ['a', 'b']) === 2);
  ok('restoreIndex: a home child the order never learned is skipped, not jumped over', r(['a', 'b', 'c'], 'b', ['u', 'a', 'c']) === 2);
  ok('restoreIndex: garbage in -> 0 / now.length, no throw', r(null, 'a', null) === 0 && r(['a'], 'a', 'x') === 0);
}

// ── the real adopt()/release(), run in a tiny fake .content ─────────────────
const i0 = OS.indexOf('  // ── views in and out of windows');
const i1 = OS.indexOf('  // opt-in system sounds', i0);
const body = i0 >= 0 && i1 > i0 ? OS.slice(i0, i1) : '';
ok('control: found adopt() and release()', /function adopt\(/.test(body) && /function release\(/.test(body));

function el(id) {
  const e = { id, children: [], parentNode: null, classes: new Set(), connected: false };
  e.classList = { add: (c) => e.classes.add(c), remove: (c) => e.classes.delete(c), contains: (c) => e.classes.has(c) };
  Object.defineProperty(e, 'isConnected', { get() { let n = e; while (n.parentNode) n = n.parentNode; return !!n.connected; } });
  Object.defineProperty(e, 'nextSibling', { get() { const p = e.parentNode; return p ? p.children[p.children.indexOf(e) + 1] || null : null; } });
  const detach = (c) => { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = null; };
  e.appendChild = (c) => { detach(c); c.parentNode = e; e.children.push(c); return c; };
  e.insertBefore = (c, ref) => {
    const i = ref ? e.children.indexOf(ref) : -1;
    if (ref && i < 0) throw new Error('insertBefore: ' + ref.id + ' is not a child of ' + e.id);   // the browser throws too
    detach(c);
    c.parentNode = e;
    if (i < 0) e.children.push(c); else e.children.splice(e.children.indexOf(ref), 0, c);
    return c;
  };
  return e;
}
/** .content as the dashboard has it: the breadcrumb, the views, then the desk the layout appended at mount. */
function world(ids) {
  const content = el('content'); content.connected = true;
  content.appendChild(el('crumbs'));
  const views = {};
  ids.forEach((id) => { views[id] = el('view-' + id); content.appendChild(views[id]); });
  const desk = el('osDesk'); content.appendChild(desk);
  const S = { origins: {}, viewOrder: [] };
  // eslint-disable-next-line no-new-func -- runs this repo's own source, not input
  const api = new Function('WM', 'byId', 'getS', 'var S = getS();\n' + body + '\nreturn { adopt: adopt, release: release };')(
    WM, (id) => views[id.slice(5)] || null, () => S);
  const order = () => content.children.map((c) => c.id).join(',');
  const open = (id) => { const win = el('win-' + id); desk.appendChild(win); api.adopt(id, win); return win; };
  const close = (id) => api.release(id);
  return { content, views, desk, S, open, close, order, adopt: api.adopt, addView: (id) => { views[id] = el('view-' + id); return views[id]; } };
}
const BASE = 'crumbs,view-a,view-b,view-c,view-d,osDesk';

console.log('2. the real adopt()/release()');
{
  const w = world(['a', 'b', 'c', 'd']);
  ok('control: Classic order before any window', w.order() === BASE, w.order());
  w.open('a'); w.open('b');
  ok('two windows: both views are out of .content, marked in-window', w.order() === 'crumbs,view-c,view-d,osDesk' && w.views.a.classes.has('os-in-win'));
  w.close('a');
  ok('the finding: closing Home while its next sibling is still in another window puts it back in place, not at the end',
    w.order() === 'crumbs,view-a,view-c,view-d,osDesk', w.order());
  w.close('b');
  ok('...and closing the other restores Classic exactly', w.order() === BASE && !w.views.a.classes.has('os-in-win') && !w.views.b.classes.has('os-in-win'), w.order());
  ok('origins are cleared as views go home', Object.keys(w.S.origins).length === 0);
}
{
  const w = world(['a', 'b', 'c', 'd']);
  w.open('b'); w.open('a');
  w.close('b'); w.close('a');
  ok('opened b then a, closed b then a (a\'s siblings at adopt time were c, d): Classic exactly', w.order() === BASE, w.order());
}
{
  const w = world(['a', 'b', 'c', 'd']);
  ['a', 'b', 'c', 'd'].forEach(w.open);
  ok('control: every view in a window', w.order() === 'crumbs,osDesk');
  Object.keys(w.S.origins).forEach(w.close);   // what unmount() does: the recorded order
  ok('unmount\'s walk (adoption order) restores Classic exactly', w.order() === BASE, w.order());
}
{
  const perms = (xs) => (xs.length < 2 ? [xs] : xs.flatMap((x, i) => perms(xs.slice(0, i).concat(xs.slice(i + 1))).map((p) => [x].concat(p))));
  const bad = [];
  perms(['a', 'b', 'c']).forEach((openOrd) => perms(['a', 'b', 'c']).forEach((closeOrd) => {
    const w = world(['a', 'b', 'c', 'd']);
    openOrd.forEach(w.open); closeOrd.forEach(w.close);
    if (w.order() !== BASE) bad.push(openOrd.join('') + '/' + closeOrd.join('') + '=' + w.order());
  }));
  ok('every open x close order of three windows (36) restores Classic exactly', bad.length === 0, bad.slice(0, 3).join(' | '));
}
{
  const w = world(['a', 'b', 'c', 'd']);
  w.open('a'); w.close('a'); w.open('a'); w.open('c'); w.close('c'); w.close('a');
  ok('re-opening a closed view and closing again: Classic exactly', w.order() === BASE, w.order());
  w.open('d'); w.close('d');
  ok('the last view goes back before the desk, not after it', w.order() === BASE, w.order());
}
{
  const w = world(['a', 'b', 'c', 'd']);
  w.open('a');
  const banner = el('banner'); w.content.insertBefore(banner, w.views.c);   // something else put a child in the middle later
  w.open('c'); w.close('c');
  ok('a sibling added after the first window opened keeps its place when the view after it comes home', w.order() === 'crumbs,view-b,banner,view-c,view-d,osDesk', w.order());
  w.close('a');
  ok('...and the first view still goes back first', w.order() === 'crumbs,view-a,view-b,banner,view-c,view-d,osDesk', w.order());
  const late = w.addView('e'); w.content.appendChild(late);
  w.open('e'); w.open('b'); w.close('e'); w.close('b');
  ok('a view added at the end later goes back where it was added (the end)', w.order() === 'crumbs,view-a,view-b,banner,view-c,view-d,osDesk,view-e', w.order());
}
{
  const w = world(['a', 'b']);
  const win = w.open('a');
  w.content.connected = false;
  w.close('a');
  ok('a parent no longer in the document: the view stays where it is (as before), the origin is dropped', w.views.a.parentNode === win && !('a' in w.S.origins));
  const v = world(['a', 'b']);
  let threw = null;
  try { v.close('zzz'); v.close('a'); } catch (e) { threw = e; }
  ok('releasing a view that was never adopted, or an unknown id, does nothing and never throws', !threw && v.order() === 'crumbs,view-a,view-b,osDesk', threw && threw.message);
  const same = world(['a', 'b']);
  const win2 = same.open('a');
  same.adopt('a', win2);
  ok('adopting into the window it is already in records nothing new', same.views.a.parentNode === win2 && Object.keys(same.S.origins).join() === 'a' && same.S.viewOrder.length === 4);
}

console.log('3. wiring');
{
  ok('mount state carries viewOrder', /origins: \{\}, unbind: \[\],[^\n]*viewOrder: \[\]/.test(OS) || /viewOrder: \[\]/.test(OS));
  ok('adopt learns Classic\'s order through NBDOSWm.mergeOrder, before the view moves', /S\.viewOrder = WM\.mergeOrder\(S\.viewOrder, [^\n]*v\.parentNode\.children\)\);/.test(OS) && OS.indexOf('WM.mergeOrder(') < OS.indexOf('host.appendChild(v);'));
  ok('release places through NBDOSWm.restoreIndex, not the recorded next sibling', /WM\.restoreIndex\(S\.viewOrder, v, kids\)/.test(OS) && !/next: v\.nextSibling/.test(OS) && !/insertBefore\(v, o\.next\)/.test(OS));
  ok('the pure module lists both helpers in its header', /mergeOrder\(order, now\)/.test(read('docs/pro/js/layouts/os-wm-logic.js')) && /restoreIndex\(order, item, now\)/.test(read('docs/pro/js/layouts/os-wm-logic.js')));
  const manifest = JSON.parse(read('tests/ci-manifest.json'));
  ok('this suite is in the node bucket', manifest.node.indexOf(path.basename(__filename)) !== -1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
