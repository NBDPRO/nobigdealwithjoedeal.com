/**
 * tests/nbd-os-home-edit-2026-11-09.test.js - NBD OS P0c step 3: editing the
 * home (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.4, §3.5, §8 P0c).
 *
 *   - ways in: a long-press on a widget (the 550 ms pattern), an "Edit Home"
 *     button on the desk column, and an "Edit Home" Control Center tile
 *     (system layer registerControl, when it is loaded)
 *   - touch: tap-pick then tap-place (one pointer, WCAG 2.5.7), an S/M/L chip
 *     that cycles the widget's own sizes, Remove
 *   - keyboard (Bento's model): arrows move, Shift+arrows resize, Delete
 *     removes, Esc exits; a polite live region says each change; focus stays
 *     on the moved widget
 *   - "Add widget": a native <dialog> (showModal), the catalog grouped, minus
 *     what the member's role hides, with S/M/L chips
 *   - every change: home-logic normalize, then LayoutEngine.saveUser({ layoutState:
 *     { 'os-home': ... } }), nothing else written; the desk column re-reads
 *   - no jiggle (no animation at all), 44px targets
 *   - the phone grid hole (P0b review): pack() orders the widgets so any size
 *     mix fills whole rows and page 1's icons never spill past the page
 *
 * Run: node tests/nbd-os-home-edit-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, byKey, hw, text, click, key, fire, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
const HOME_JS = read('docs/pro/js/os/home.js');
const HOME_CSS = read('docs/pro/css/os/home.css');
const OS_JS = read('docs/pro/js/layouts/os.js');
const SYSTEM_JS = read('docs/pro/js/os/system.js');

const ids = (root) => hw(root).map((n) => n.getAttribute('data-oshw'));
// edits are saved after a short debounce (review nit): run the timer, then read the last os-home write
const SAVE_MS = 700;
const homeSaves = (T) => (T.W._saves || []).filter((p) => p && p.layoutState && p.layoutState['os-home']);
const lastSave = (T) => { T.fire(SAVE_MS); const s = homeSaves(T); return s[s.length - 1]; };
const live = (root) => text(root.querySelector('.os-hw-live'));
const phoneOf = (T) => T.document.getElementById('osPhone');
const deskCol = (T) => T.document.getElementById('osDesk').querySelector('.os-widgets');
const mountPhone = (home, o) => { const T = makeWin(Object.assign({ surface: 'phone', home }, o || {})); T.W._impl.mount({ surface: 'phone' }); return T; };
const mountDesk = (home, o) => { const T = makeWin(Object.assign({ surface: 'desktop', home }, o || {})); T.W._impl.mount({ surface: 'desktop' }); return T; };
const longPress = (T, el) => { fire(T.dom, el, 'pointerdown'); T.fire(550); fire(T.dom, el, 'pointerup'); return click(T.dom, el); };

// CSS grid auto-placement, 4 columns, row flow, NOT dense: where does each item land?
function place(items) {
  const used = new Set();
  let cr = 0, cc = 0, maxRow = 0;
  const free = (r, c, w, h) => { for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) if (x > 3 || used.has(y + ':' + x)) return false; return true; };
  return items.map(([w, h]) => {
    let r = cr, c = cc;
    while (!free(r, c, w, h)) { c++; if (c + w > 4) { c = 0; r++; } }
    for (let y = r; y < r + h; y++) for (let x = c; x < c + w; x++) used.add(y + ':' + x);
    cr = r; cc = c + w;
    maxRow = Math.max(maxRow, r + h);
    return { r, c, w, h, maxRow };
  });
}
const DIM = { s: [2, 1], m: [4, 2], l: [4, 4] };

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. the phone grid hole: pack() + pageRoom never push icons past page 1');
G(() => {
  const sizes = ['s', 'm', 'l'];
  const seqs = [[]];
  for (let n = 1; n <= 6; n++) { const prev = seqs.filter((q) => q.length === n - 1); prev.forEach((q) => sizes.forEach((s) => seqs.push(q.concat(s)))); }
  let worst = null;
  const all = seqs.every((seq) => {
    const items = HL.pack(seq.map((s, i) => ({ id: 'glance', s, n: i })));
    const room = HL.pageRoom(items, 20);
    const cells = seq.reduce((a, s) => a + HL.CELLS[s], 0);
    const placed = place(items.map((it) => DIM[it.s]).concat(Array(room).fill([1, 1])));
    const rows = placed.length ? placed[placed.length - 1].maxRow : 0;
    const good = (cells > 20 ? room === 0 : rows <= 5) && items.length === seq.length;
    if (!good && !worst) worst = J(seq) + ' -> ' + J(items.map((x) => x.s)) + ' room ' + room + ' rows ' + rows;
    return good;
  });
  ok('every mix of up to 6 widgets (1,092 orders): page 1 holds its icons inside 5 rows', all, worst);
  const before = place([[2, 1], [4, 2], [1, 1], [1, 1]]);
  ok('(the bug it fixes: S then M leaves 2 empty cells, so 2 icons spill a row)', before[before.length - 1].maxRow === 4 && HL.pageRoom([{ s: 's' }, { s: 'm' }], 20) === 10);
  ok('pack keeps every widget, and the order of the rest', J(HL.pack([{ id: 'a', s: 's' }, { id: 'b', s: 'm' }, { id: 'c', s: 's' }, { id: 'd', s: 'l' }]).map((x) => x.id)) === J(['a', 'c', 'b', 'd']));
  ok('a lone S with no partner goes after the whole-row widgets', J(HL.pack([{ id: 'a', s: 's' }, { id: 'b', s: 'm' }]).map((x) => x.id)) === J(['b', 'a']));
  ok('an order with no hole is left alone', J(HL.pack([{ id: 'a', s: 'm' }, { id: 'b', s: 's' }, { id: 'c', s: 's' }]).map((x) => x.id)) === J(['a', 'b', 'c']));
  const T = mountPhone({ phone: [{ id: 'shortcuts', s: 's' }, { id: 'glance', s: 'm' }, { id: 'daily', s: 's' }], desk: [] });
  const page1 = phoneOf(T).querySelectorAll('.os-p-page')[0];
  ok('the phone paints in the packed order (DOM order = reading order, no CSS dense)', J(ids(page1)) === J(['shortcuts-1', 'daily-1', 'glance-1']), J(ids(page1)));
  ok('…and page 1 takes exactly the icons that fit (20 - 12 = 8)', page1.querySelectorAll('.os-p-icon').length === Math.min(8, 7), page1.querySelectorAll('.os-p-icon').length);
  ok('no grid-auto-flow: dense anywhere', !/dense/.test(HOME_CSS) && !/dense/.test(read('docs/pro/css/layouts/os.css')));
});

// review nit: an expanded M Coach on the phone is 4 rows tall; page 1 must make room for it
G(() => {
  const DAY = 86400000;
  const leads = [{ id: 'old1', _stageRole: 'new', createdAt: H.NOW - 50 * DAY }];
  const T = mountPhone({ phone: [{ id: 'coach', s: 'm' }], desk: [] }, { leads });
  const page1 = () => phoneOf(T).querySelectorAll('.os-p-page')[0];
  const icons1 = () => page1().querySelectorAll('.os-p-icon').length;
  const fits = () => {
    const c = byKey(phoneOf(T), 'coach-1');
    const tall = c.classList.contains('is-l') || c.classList.contains('is-open') ? [4, 4] : [4, 2];
    const placed = place([tall].concat(Array(icons1()).fill([1, 1])));
    return placed[placed.length - 1].maxRow <= 5;
  };
  ok('collapsed M Coach: page 1\'s icons fit (5 rows)', icons1() === 7 && fits(), icons1());
  click(T.dom, byKey(phoneOf(T), 'coach-1').querySelector('[data-oshw-coach="more"]'));
  ok('expanded (More): page 1 makes room for 4 rows, every icon left on page 1 still fits', byKey(phoneOf(T), 'coach-1').classList.contains('is-open') && fits(), icons1());
  ok('…the icons that no longer fit move to page 2, none dropped', phoneOf(T).querySelectorAll('.os-p-page .os-p-icon').length === 7 && phoneOf(T).querySelectorAll('.os-p-page').length === 2);
  click(T.dom, byKey(phoneOf(T), 'coach-1').querySelector('[data-oshw-coach="more"]'));
  ok('Show less gives page 1 its icons back', icons1() === 7 && phoneOf(T).querySelectorAll('.os-p-page').length === 1);
});

console.log('\n2. the pure edit ops');
G(() => {
  const L = [{ id: 'glance', s: 'm' }, { id: 'coach', s: 'm' }, { id: 'shortcuts', s: 's' }];
  ok('moveBy: one later', J(HL.moveBy(L, 0, 1).map((x) => x.id)) === J(['coach', 'glance', 'shortcuts']));
  ok('moveBy: past the end is null', HL.moveBy(L, 2, 1) === null && HL.moveBy(L, 0, -1) === null);
  const P = [{ id: 'shortcuts', s: 's' }, { id: 'daily', s: 's' }, { id: 'glance', s: 'm' }];
  ok('moveBy on the phone: a step pack() would undo goes one further', J(HL.moveBy(P, 2, -1, true).map((x) => x.id)) === J(['glance', 'shortcuts', 'daily']), J(HL.moveBy(P, 2, -1, true)));
  ok('resize: the chip cycles the widget\'s own sizes (Coach: M -> L -> M)', HL.resize(L, 1, 0)[1].s === 'l' && HL.resize(HL.resize(L, 1, 0), 1, 0)[1].s === 'm');
  ok('resize: Shift+arrow bigger / smaller stops at the ends', HL.resize(L, 0, 1)[0].s === 'l' && HL.resize(L, 2, -1) === null && HL.resize([{ id: 'coach', s: 'm' }], 0, -1) === null);
  ok('remove', J(HL.remove(L, 1).map((x) => x.id)) === J(['glance', 'shortcuts']));
  ok('add drops it at the end at the size asked (or its default)', J(HL.add(L, 'daily', 's').pop()) === J({ id: 'daily', s: 's' }) && HL.add(L, 'coach', 's').pop().s === 'm');
  ok('add is null when the surface is full (12) or the id is unknown', HL.add(Array(12).fill({ id: 'glance', s: 's' }), 'coach') === null && HL.add(L, 'evil') === null);
  ok('ops never touch their input', J(L) === J([{ id: 'glance', s: 'm' }, { id: 'coach', s: 'm' }, { id: 'shortcuts', s: 's' }]));
  ok('describe: "Coach, medium, position 2 of 3"', HL.describe(L, 1) === 'Coach, medium, position 2 of 3');
});

console.log('\n3. phone: long-press a widget, tap-pick then tap-place, the S/M/L chip, Remove');
G(() => {
  const T = mountPhone({ phone: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }, { id: 'shortcuts', s: 's' }, { id: 'daily', s: 's' }], desk: [{ id: 'coach', s: 'm' }] });
  const ph = phoneOf(T);
  const up = byKey(ph, 'upnext-1');
  const link = up.querySelector('a.os-hw-row');
  const ev = longPress(T, link);
  ok('a 550 ms long-press on a widget enters edit mode', byKey(ph, 'upnext-1').classList.contains('is-editing') && !!ph.querySelector('.os-p-edit'));
  ok('…and the click that ends the press is swallowed (the row link is not followed)', ev.defaultPrevented === true);
  const g = byKey(ph, 'glance-1');
  ok('each widget gets its chrome: an S/M/L chip and Remove', !!g.querySelector('[data-oshw-ed="size"]') && !!g.querySelector('[data-oshw-ed="remove"]'));
  ok('the chip shows the size, and says what it does', text(g.querySelector('[data-oshw-ed="size"]')) === 'M' && /medium/i.test(g.querySelector('[data-oshw-ed="size"]').getAttribute('aria-label')));
  ok('the widget\'s own content is inert while editing (no link fires by mistake)', g.querySelector('.os-hw-body').hasAttribute('inert'));
  ok('the edit bar offers Add widget and Done', !!ph.querySelector('[data-osp="homeadd"]') && !!ph.querySelector('[data-osp="done"]'));
  // tap-pick, then tap-place
  click(T.dom, byKey(ph, 'shortcuts-1'));
  ok('tap 1 picks the widget (aria-pressed, a picked class, a spoken hint)', byKey(ph, 'shortcuts-1').classList.contains('is-picked') && /tap where it goes/i.test(live(ph)), live(ph));
  click(T.dom, byKey(ph, 'glance-1'));
  ok('tap 2 places it there (and its S partner packs up beside it: no hole)', J(ids(ph)) === J(['shortcuts-1', 'daily-1', 'glance-1', 'upnext-1']), J(ids(ph)));
  const s1 = lastSave(T);
  ok('…saved through LayoutEngine.saveUser({ layoutState: { \'os-home\' } }) and nothing else',
    s1 && J(Object.keys(s1)) === J(['layoutState']) && J(Object.keys(s1.layoutState)) === J(['os-home']), J(s1));
  ok('…normalised, with the other surface kept as it was', s1 && J(s1.layoutState['os-home']) === J(HL.normalize({ phone: [{ id: 'shortcuts', s: 's' }, { id: 'daily', s: 's' }, { id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }], desk: [{ id: 'coach', s: 'm' }] })), J(s1 && s1.layoutState['os-home']));
  ok('…the live region says where it went', /Shortcuts, small, position 1 of 4/.test(live(ph)), live(ph));
  ok('…still in edit mode, still the same widget nodes', byKey(ph, 'glance-1') === g && g.classList.contains('is-editing'));
  click(T.dom, byKey(ph, 'glance-1').querySelector('[data-oshw-ed="size"]'));
  ok('the chip cycles the size (M -> L) and saves', byKey(ph, 'glance-1').classList.contains('is-l') && lastSave(T).layoutState['os-home'].phone[2].s === 'l');
  click(T.dom, byKey(ph, 'upnext-1').querySelector('[data-oshw-ed="remove"]'));
  ok('Remove takes it off and saves', !byKey(ph, 'upnext-1') && lastSave(T).layoutState['os-home'].phone.length === 3 && /Removed Up Next/.test(live(ph)), live(ph));
  click(T.dom, byKey(ph, 'daily-1'));
  click(T.dom, byKey(ph, 'daily-1'));
  ok('tapping the picked widget again puts it down', !byKey(ph, 'daily-1').classList.contains('is-picked'));
  click(T.dom, ph.querySelector('[data-osp="done"]'));
  ok('Done leaves edit mode: chrome gone, content live again', !ph.querySelector('[data-oshw-ed]') && !byKey(ph, 'glance-1').querySelector('.os-hw-body').hasAttribute('inert'));
  ok('read cost 0 throughout; writes only through saveUser', T.reads.length === 0, J(T.reads));
});

console.log('\n4. keyboard: arrows move, Shift+arrows resize, Delete removes, Esc exits');
G(() => {
  const T = mountDesk({ phone: [], desk: [{ id: 'glance', s: 'm' }, { id: 'coach', s: 'm' }, { id: 'shortcuts', s: 's' }] });
  const col = deskCol(T);
  const edit = col.querySelector('[data-osdo="homeedit"]');
  ok('the desk column has an Edit Home button', !!edit && /Edit Home/.test(text(edit)));
  click(T.dom, edit);
  const c = byKey(col, 'coach-1');
  ok('it enters edit mode; each widget is focusable', c.classList.contains('is-editing') && c.getAttribute('tabindex') === '0');
  ok('…focus goes to the first widget', T.document.activeElement === byKey(col, 'glance-1'));
  ok('…with the keys described for assistive tech', /arrow/i.test(text(T.document.getElementById(c.getAttribute('aria-describedby') || 'none'))));
  key(T.dom, c, 'ArrowUp');
  ok('ArrowUp moves it earlier', J(ids(col)) === J(['coach-1', 'glance-1', 'shortcuts-1']), J(ids(col)));
  ok('…focus stays on it', T.document.activeElement === byKey(col, 'coach-1'));
  ok('…announced politely', col.querySelector('.os-hw-live').getAttribute('aria-live') === 'polite' && /Coach, medium, position 1 of 3/.test(live(col)), live(col));
  key(T.dom, byKey(col, 'coach-1'), 'ArrowRight', { shiftKey: true });
  ok('Shift+ArrowRight makes it bigger', byKey(col, 'coach-1').classList.contains('is-l') && /Coach, large/.test(live(col)));
  key(T.dom, byKey(col, 'coach-1'), 'ArrowLeft', { shiftKey: true });
  ok('Shift+ArrowLeft makes it smaller', byKey(col, 'coach-1').classList.contains('is-m'));
  key(T.dom, byKey(col, 'shortcuts-1'), 'Delete');
  ok('Delete removes it', !byKey(col, 'shortcuts-1') && lastSave(T).layoutState['os-home'].desk.length === 2);
  ok('the desk column re-read the saved home (not the list it mounted with)', J(ids(col)) === J(['coach-1', 'glance-1']));
  const esc = key(T.dom, byKey(col, 'coach-1'), 'Escape');
  ok('Escape leaves edit mode', esc.defaultPrevented && !col.querySelector('.is-editing') && !!col.querySelector('[data-osdo="homeedit"]'));
  ok('…and gives the widgets back their tab order', !byKey(col, 'coach-1').hasAttribute('tabindex'));
  ok('keys do nothing outside edit mode', (() => { const before = J(ids(col)); key(T.dom, byKey(col, 'coach-1'), 'ArrowDown'); return J(ids(col)) === before; })());
});

console.log('\n5. Add widget: a native <dialog>, grouped, minus what the role hides, S/M/L chips');
G(() => {
  const T = mountDesk({ phone: [], desk: [{ id: 'glance', s: 'm' }] });
  const col = deskCol(T);
  click(T.dom, col.querySelector('[data-osdo="homeedit"]'));
  click(T.dom, col.querySelector('[data-osdo="homeadd"]'));
  const dlg = T.document.querySelector('dialog.os-hw-add');
  ok('Add widget opens a native <dialog> with showModal()', dlg && dlg.modal === true && dlg.open === true);
  const groups = dlg.querySelectorAll('.os-hw-add-group').map((g) => text(g.querySelector('h3')));
  ok('grouped by category', J(groups) === J(['Today', 'You', 'Tools']), J(groups));
  ok('each widget offers its own sizes as chips (Coach: M, L)', J(dlg.querySelectorAll('[data-oshw-add="coach"]').map((b) => b.getAttribute('data-size'))) === J(['m', 'l']));
  ok('chips are named for assistive tech', /Add Coach, medium/.test(dlg.querySelector('[data-oshw-add="coach"][data-size="m"]').getAttribute('aria-label')));
  click(T.dom, dlg.querySelector('[data-oshw-add="daily"][data-size="s"]'));
  ok('a chip adds it at the end and saves', J(ids(col)) === J(['glance-1', 'daily-1']) && J(lastSave(T).layoutState['os-home'].desk) === J([{ id: 'glance', s: 'm' }, { id: 'daily', s: 's' }]));
  ok('…closes the sheet and says what was added', dlg.open === false && /Added Daily Success, small/.test(live(col)), live(col));
  ok('the closed sheet leaves the page', !T.document.querySelector('dialog.os-hw-add'));
  // role: a member whose sidebar hides the CRM never gets the Coach
  const T2 = mountDesk({ phone: [], desk: [] });
  const crm = T2.document.querySelector('.sidebar [data-target="crm"]');
  crm.hidden = true;
  crm.setAttribute('hidden', '');
  click(T2.dom, deskCol(T2).querySelector('[data-osdo="homeedit"]'));
  click(T2.dom, deskCol(T2).querySelector('[data-osdo="homeadd"]'));
  const d2 = T2.document.querySelector('dialog.os-hw-add');
  ok('a widget about a view the role hides is not offered', d2 && !d2.querySelector('[data-oshw-add="coach"]') && !!d2.querySelector('[data-oshw-add="glance"]'));
  const full = []; for (let i = 0; i < 12; i++) full.push({ id: 'shortcuts', s: 's' });
  const T3 = mountDesk({ phone: [], desk: full });
  click(T3.dom, deskCol(T3).querySelector('[data-osdo="homeedit"]'));
  click(T3.dom, deskCol(T3).querySelector('[data-osdo="homeadd"]'));
  const d3 = T3.document.querySelector('dialog.os-hw-add');
  ok('full (12): the chips are disabled and the sheet says why', d3.querySelectorAll('[data-oshw-add]').every((b) => b.hasAttribute('disabled')) && /full/i.test(text(d3)));
  const T4 = mountPhone({ phone: [{ id: 'glance', s: 'm' }], desk: [] });
  longPress(T4, byKey(phoneOf(T4), 'glance-1'));
  click(T4.dom, phoneOf(T4).querySelector('[data-osp="homeadd"]'));
  ok('the phone\'s edit bar opens the same sheet', !!T4.document.querySelector('dialog.os-hw-add'));
  const esc = key(T4.dom, T4.document.querySelector('dialog.os-hw-add .os-hw-add-chip'), 'Escape');
  ok('Escape closes the sheet (even when a page-wide key handler would swallow the dialog\'s cancel)', !T4.document.querySelector('dialog.os-hw-add') && esc.defaultPrevented);
  ok('…and edit mode stays on underneath', byKey(phoneOf(T4), 'glance-1').classList.contains('is-editing'));
  // review nit: a tap on the sheet's own padding (target === the <dialog>) is not a backdrop tap
  click(T4.dom, phoneOf(T4).querySelector('[data-osp="homeadd"]'));
  const d4 = T4.document.querySelector('dialog.os-hw-add');
  fire(T4.dom, d4, 'click', { clientX: 20, clientY: 30 });
  ok('a tap on the sheet\'s padding or a gap between groups keeps it open', d4.open === true && !!T4.document.querySelector('dialog.os-hw-add'));
  fire(T4.dom, d4, 'click', { clientX: 2000, clientY: 30 });
  ok('…a tap outside its box (the backdrop) closes it', d4.open === false && !T4.document.querySelector('dialog.os-hw-add'));
});

console.log('\n6. the Control Center tile (system layer, when loaded)');
G(() => {
  const T = mountPhone({ phone: [{ id: 'glance', s: 'm' }], desk: [] }, { system: true });
  const c = (T.W.controls || []).filter((x) => x.id === 'os-home-edit')[0];
  ok('registers an "Edit Home" control through NBDOS.registerControl', c && c.label === 'Edit Home' && typeof c.run === 'function', J(T.W.controls));
  c.run();
  ok('…which enters edit mode', byKey(phoneOf(T), 'glance-1').classList.contains('is-editing'));
  T.W._impl.unmount();
  ok('…and is taken down with the layout (unregisterControl)', !(T.W.controls || []).some((x) => x.id === 'os-home-edit'));
  ok('system.js offers unregisterControl', /function unregisterControl\(id\)/.test(SYSTEM_JS) && /unregisterControl: unregisterControl/.test(SYSTEM_JS));
  const T2 = mountPhone({ phone: [], desk: [] });
  ok('no system layer: nothing breaks (it is optional)', !!phoneOf(T2) && !T2.W.controls);
});

console.log('\n6b. focus is never dropped (review nits)');
G(() => {
  const DAY = 86400000;
  const leads = [{ id: 'old1', _stageRole: 'new', createdAt: H.NOW - 50 * DAY }];
  const act = (T) => T.document.activeElement;
  const live = (T, el) => !!el && el.isConnected;
  [['phone', mountPhone, phoneOf], ['desk', mountDesk, (T) => deskCol(T)]].forEach(([name, mount, root]) => {
    const home = name === 'phone' ? { phone: [{ id: 'coach', s: 'm' }], desk: [] } : { phone: [], desk: [{ id: 'coach', s: 'm' }] };
    const T = mount(home, { leads });
    const card = () => byKey(root(T), 'coach-1');
    click(T.dom, card().querySelector('[data-oshw-coach="more"]'));
    ok(name + ': More repaints the Coach and focus lands on its toggle (now "Show less")', live(T, act(T)) && act(T) === card().querySelector('[data-oshw-coach="more"]') && /Show less/.test(text(act(T))), act(T) && act(T).tagName);
    click(T.dom, card().querySelector('[data-oshw-coach="more"]'));
    ok(name + ': Show less keeps focus on the toggle', live(T, act(T)) && act(T) === card().querySelector('[data-oshw-coach="more"]') && /More/.test(text(act(T))));
    click(T.dom, card().querySelector('[data-oshw-coach="snooze"]'));
    ok(name + ': Later keeps focus inside the Coach (the next rule\'s Later)', live(T, act(T)) && card().contains(act(T)) && act(T).getAttribute('data-oshw-coach') === 'snooze', act(T) && act(T).getAttribute('data-oshw-coach'));
    click(T.dom, card().querySelector('[data-oshw-coach="dismiss"]'));
    ok(name + ': Not today keeps focus inside the Coach', live(T, act(T)) && card().contains(act(T)), act(T) && act(T).tagName);
  });
  // the last rule hidden: no control left, so the widget itself takes focus
  const quiet = { total: 0, promises: [], promised: [], stalled: [], estimates: [], calls: [], appointments: [] };
  const T2 = mountDesk({ phone: [], desk: [{ id: 'coach', s: 'm' }] }, { leads, plan: quiet });
  click(T2.dom, byKey(deskCol(T2), 'coach-1').querySelector('[data-oshw-coach="dismiss"]'));
  ok('Not today on the last rule: focus goes to the Coach widget', act(T2) === byKey(deskCol(T2), 'coach-1') && act(T2).getAttribute('tabindex') === '-1', act(T2) && act(T2).tagName);
  // removing the last widget
  const T3 = mountDesk({ phone: [], desk: [{ id: 'glance', s: 'm' }] });
  click(T3.dom, deskCol(T3).querySelector('[data-osdo="homeedit"]'));
  click(T3.dom, byKey(deskCol(T3), 'glance-1').querySelector('[data-oshw-ed="remove"]'));
  ok('desk: removing the last widget moves focus to Add widget, not the page', act(T3) && act(T3).getAttribute('data-osdo') === 'homeadd' && live(T3, act(T3)), act(T3) && act(T3).tagName);
  const T4 = mountPhone({ phone: [{ id: 'glance', s: 'm' }], desk: [] });
  longPress(T4, byKey(phoneOf(T4), 'glance-1'));
  key(T4.dom, byKey(phoneOf(T4), 'glance-1'), 'Delete');
  ok('phone: removing the last widget moves focus to Add widget', act(T4) && act(T4).getAttribute('data-osp') === 'homeadd' && live(T4, act(T4)), act(T4) && act(T4).tagName);
  // the desk long-press focuses the pressed widget
  const T5 = mountDesk({ phone: [], desk: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }] });
  longPress(T5, byKey(deskCol(T5), 'upnext-1'));
  ok('desk long-press: edit mode, focus on the pressed widget (not the first)', byKey(deskCol(T5), 'upnext-1').classList.contains('is-editing') && act(T5) === byKey(deskCol(T5), 'upnext-1'), act(T5) && act(T5).getAttribute('data-oshw'));
  const T6 = mountPhone({ phone: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }], desk: [] });
  longPress(T6, byKey(phoneOf(T6), 'upnext-1'));
  ok('phone long-press: focus on the pressed widget too', act(T6) === byKey(phoneOf(T6), 'upnext-1'));
});

console.log('\n6c. the save is debounced, applied at once, and never lost (review nit)');
G(() => {
  const T = mountDesk({ phone: [], desk: [{ id: 'glance', s: 'm' }, { id: 'coach', s: 'm' }, { id: 'shortcuts', s: 's' }] });
  const col = deskCol(T);
  click(T.dom, col.querySelector('[data-osdo="homeedit"]'));
  key(T.dom, byKey(col, 'shortcuts-1'), 'ArrowUp');
  key(T.dom, byKey(col, 'shortcuts-1'), 'ArrowUp');
  key(T.dom, byKey(col, 'coach-1'), 'ArrowRight', { shiftKey: true });
  ok('three quick keystrokes: the home changes at once', J(ids(col)) === J(['shortcuts-1', 'glance-1', 'coach-1']) && byKey(col, 'coach-1').classList.contains('is-l'), J(ids(col)));
  ok('…but nothing is written yet (no setDoc per keystroke)', homeSaves(T).length === 0, homeSaves(T).length);
  T.fire(SAVE_MS);
  ok('…then one write, with the final state', homeSaves(T).length === 1 && J(homeSaves(T)[0].layoutState['os-home'].desk) === J([{ id: 'shortcuts', s: 's' }, { id: 'glance', s: 'm' }, { id: 'coach', s: 'l' }]), J(homeSaves(T)));
  key(T.dom, byKey(col, 'glance-1'), 'Delete');
  ok('a pending change is still shown to the next edit (the list re-reads it)', J(ids(col)) === J(['shortcuts-1', 'coach-1']));
  key(T.dom, byKey(col, 'coach-1'), 'Escape');
  ok('leaving edit mode writes the pending change at once', homeSaves(T).length === 2 && homeSaves(T)[1].layoutState['os-home'].desk.length === 2, homeSaves(T).length);
  T.fire(SAVE_MS);
  ok('…and only once', homeSaves(T).length === 2);
  // pagehide and unmount flush too
  const T2 = mountPhone({ phone: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }], desk: [] });
  longPress(T2, byKey(phoneOf(T2), 'glance-1'));
  key(T2.dom, byKey(phoneOf(T2), 'glance-1'), 'ArrowDown');
  ok('phone: nothing written mid-edit', homeSaves(T2).length === 0);
  const T3 = mountPhone({ phone: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }], desk: [] });
  longPress(T3, byKey(phoneOf(T3), 'glance-1'));
  key(T3.dom, byKey(phoneOf(T3), 'glance-1'), 'ArrowDown');
  click(T3.dom, phoneOf(T3).querySelector('[data-osp="done"]'));
  ok('phone Done writes the pending change at once', homeSaves(T3).length === 1, homeSaves(T3).length);
  T2.W.dispatchEvent({ type: 'pagehide' });
  ok('pagehide writes the pending change', homeSaves(T2).length === 1 && homeSaves(T2)[0].layoutState['os-home'].phone[0].id === 'upnext', J(homeSaves(T2)));
  key(T2.dom, byKey(phoneOf(T2), 'glance-1'), 'Delete');
  T2.W._impl.unmount();
  ok('unmount writes the pending change', homeSaves(T2).length === 2 && homeSaves(T2)[1].layoutState['os-home'].phone.length === 1, J(homeSaves(T2)));
  ok('the debounce reuses the window state\'s SAVE_MS idea', /SAVE_MS/.test(OS_JS) && /pagehide/.test(OS_JS));
});

console.log('\n7. CSS: 44px targets, no jiggle, CSP');
G(() => {
  ok('the chip and Remove are 44px targets', /\.os-hw-ed \{[^}]*min-width: 44px;[^}]*min-height: 44px/.test(HOME_CSS));
  ok('the sheet\'s chips and Close are 44px targets', /\.os-hw-add-chip \{[^}]*min-width: 44px;[^}]*min-height: 44px/.test(HOME_CSS) && /\.os-hw-add-close \{[^}]*min-height: 44px/.test(HOME_CSS));
  ok('no jiggle: no animation at all (so nothing moves under either reduced-motion switch)', !/@keyframes|animation\s*:/.test(HOME_CSS));
  ok('the live region is visually hidden, never a grid cell', /\.os-hw-live \{[^}]*position: absolute/.test(HOME_CSS));
  ok('widgets are never text-selected or called out by a long-press', /\.os-hw \{[^}]*user-select: none/.test(HOME_CSS) && /-webkit-touch-callout: none/.test(HOME_CSS));
  ok('no style="" and no inline handlers in home.js / os.js', !/style="/.test(HOME_JS + OS_JS) && !/\son[a-z]+=["']/i.test(noComments(HOME_JS)));
  ok('the dialog is built from escaped strings', /function esc\(/.test(HOME_JS) && /os-hw-add/.test(HOME_JS));
  ok('home.js sends nothing itself: edits go through the layout\'s onChange', !/LayoutEngine\.saveUser|setDoc|updateDoc/.test(noComments(HOME_JS)) && /saveUser\(\{ layoutState: \{ 'os-home'/.test(OS_JS));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
