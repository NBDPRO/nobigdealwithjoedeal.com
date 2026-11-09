/**
 * tests/nbd-os-phone-drag-2026-11-09.test.js - NBD OS P1 "Board and drag", the
 * phone's hold-and-drag reorder (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md
 * sections 3.3, 3.4).
 *
 * In edit mode a press-and-drag on a widget (past 8px) captures the pointer,
 * lifts the widget, marks the widget under the finger as the drop place and,
 * on release, puts it there (the same list move and S pairing as tap-place),
 * saving once through the layout's debounced saveHome. Near the top or bottom
 * of page 1 the page scrolls. touch-action:none is on edit-mode widgets in CSS,
 * so it is in force before the pointerdown. Tap-pick-place keeps working. No
 * SortableJS. The real os.js + home.js over the fake DOM.
 *
 * Run: node tests/nbd-os-phone-drag-2026-11-09.test.js
 */
'use strict';
const H = require('./lib/nbd-os-home-harness');
const { makeWin, fire, click, byKey, hw, text, read } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
function G(fn) { try { fn(); } catch (e) { ok('no throw: ' + (e && e.message), false, e && e.stack); } }
const J = (v) => JSON.stringify(v);
const ids = (root) => hw(root).map((n) => n.getAttribute('data-oshw'));
const live = (root) => text(root.querySelector('.os-hw-live'));
const phoneOf = (T) => T.document.getElementById('osPhone');
const homeSaves = (T) => (T.W._saves || []).filter((p) => p && p.layoutState && p.layoutState['os-home']);
const mountPhone = (home, o) => { const T = makeWin(Object.assign({ surface: 'phone', home }, o || {})); T.W._impl.mount({ surface: 'phone' }); return T; };
const longPress = (T, el) => { fire(T.dom, el, 'pointerdown'); T.fire(550); fire(T.dom, el, 'pointerup'); return click(T.dom, el); };

console.log('\n1. press-and-drag reorders, with pointer capture');
G(() => {
  const T = mountPhone({ phone: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }, { id: 'coach', s: 'm' }], desk: [] });
  const ph = phoneOf(T);
  longPress(T, byKey(ph, 'glance-1'));
  ok('edit mode is on', byKey(ph, 'glance-1').classList.contains('is-editing'));
  const help = T.document.getElementById(byKey(ph, 'coach-1').getAttribute('aria-describedby') || 'none');
  ok('the help says a widget can be dragged, or tapped and placed', /Drag it, or tap it/.test(text(help)), text(help));
  const bar = text(ph.querySelector('.os-p-edit span'));
  ok('…and the edit bar on screen says the same: drag a widget, or tap then tap', /^Drag a widget, or tap an app or a widget, then tap where it goes\.$/.test(bar), bar);
  const coach = byKey(ph, 'coach-1');
  const caps = [];
  coach.setPointerCapture = (id) => caps.push('set' + id);
  coach.releasePointerCapture = (id) => caps.push('rel' + id);
  let under = byKey(ph, 'glance-1');
  T.document.elementFromPoint = () => under;
  fire(T.dom, coach, 'pointerdown', { clientX: 200, clientY: 500, pointerId: 3, pointerType: 'touch' });
  fire(T.dom, coach, 'pointermove', { clientX: 202, clientY: 495, pointerId: 3 });
  ok('a small wobble is not a drag', !caps.length && !coach.classList.contains('is-dragging'));
  const mv = fire(T.dom, coach, 'pointermove', { clientX: 200, clientY: 300, pointerId: 3, cancelable: true });
  ok('past 8px: pointer capture, the widget lifts', caps[0] === 'set3' && coach.classList.contains('is-dragging'));
  ok('…the widget under the finger is the drop place', byKey(ph, 'glance-1').classList.contains('is-drop') && mv.defaultPrevented);
  ok('…nothing moves or saves until release', J(ids(ph)) === J(['glance-1', 'upnext-1', 'coach-1']) && homeSaves(T).length === 0);
  under = byKey(ph, 'upnext-1');
  fire(T.dom, coach, 'pointermove', { clientX: 200, clientY: 360, pointerId: 3 });
  ok('moving on: the drop place follows the finger', byKey(ph, 'upnext-1').classList.contains('is-drop') && !byKey(ph, 'glance-1').classList.contains('is-drop'));
  under = byKey(ph, 'glance-1');
  fire(T.dom, coach, 'pointermove', { clientX: 200, clientY: 300, pointerId: 3 });
  fire(T.dom, coach, 'pointerup', { clientX: 200, clientY: 300, pointerId: 3 });
  const clk = click(T.dom, byKey(ph, 'coach-1'));
  ok('release: Coach takes Glance\'s place', J(ids(ph)) === J(['coach-1', 'glance-1', 'upnext-1']), J(ids(ph)));
  ok('…capture let go, the look cleared, and the ending click does not pick it up', caps[1] === 'rel3' && !byKey(ph, 'coach-1').classList.contains('is-dragging')
    && !byKey(ph, 'glance-1').classList.contains('is-drop') && !byKey(ph, 'coach-1').classList.contains('is-picked') && clk.defaultPrevented);
  ok('…the live line says where it went', /Coach, medium, position 1 of 3/.test(live(ph)), live(ph));
  ok('…still the same widget nodes (the keyed reconcile)', byKey(ph, 'coach-1') === coach);
  T.fire(700);
  ok('one write, through the layout\'s debounced save', homeSaves(T).length === 1 && J(homeSaves(T)[0].layoutState['os-home'].phone.map((x) => x.id)) === J(['coach', 'glance', 'upnext']), J(homeSaves(T)));
  // dropping on itself, or on nothing, changes nothing
  under = null;
  const g = byKey(ph, 'glance-1');
  fire(T.dom, g, 'pointerdown', { clientX: 200, clientY: 300, pointerId: 4 });
  fire(T.dom, g, 'pointermove', { clientX: 200, clientY: 400, pointerId: 4 });
  fire(T.dom, g, 'pointerup', { clientX: 200, clientY: 400, pointerId: 4 });
  ok('a drop on no widget leaves the order alone and says so', J(ids(ph)) === J(['coach-1', 'glance-1', 'upnext-1']) && /stays where it is/.test(live(ph)), live(ph));
  under = byKey(ph, 'upnext-1');
  fire(T.dom, g, 'pointerdown', { clientX: 200, clientY: 300, pointerId: 5 });
  fire(T.dom, g, 'pointermove', { clientX: 200, clientY: 400, pointerId: 5 });
  fire(T.dom, g, 'pointercancel', { clientX: 200, clientY: 400, pointerId: 5 });
  ok('a cancelled drag (the system took the touch) changes nothing', J(ids(ph)) === J(['coach-1', 'glance-1', 'upnext-1']) && !byKey(ph, 'upnext-1').classList.contains('is-drop'));
  T.fire(700);
  ok('…and wrote nothing more', homeSaves(T).length === 1, homeSaves(T).length);
});

console.log('\n2. small widgets keep their pairs; page 1 scrolls near its edges');
G(() => {
  const T = mountPhone({ phone: [{ id: 'glance', s: 'm' }, { id: 'shortcuts', s: 's' }, { id: 'daily', s: 's' }, { id: 'upnext', s: 'm' }], desk: [] });
  const ph = phoneOf(T);
  longPress(T, byKey(ph, 'glance-1'));
  const page = ph.querySelector('.os-p-home');
  ok('page 1 holds the widgets', !!page && page.contains(byKey(ph, 'upnext-1')));
  page.scrollTop = 200;
  page.getBoundingClientRect = () => ({ left: 0, top: 100, width: 390, height: 600 });
  const up = byKey(ph, 'upnext-1');
  T.document.elementFromPoint = () => byKey(ph, 'shortcuts-1');
  fire(T.dom, up, 'pointerdown', { clientX: 200, clientY: 600, pointerId: 6 });
  fire(T.dom, up, 'pointermove', { clientX: 200, clientY: 120, pointerId: 6 });
  T.fire(50); T.fire(50);
  ok('a finger within 48px of the top scrolls page 1 up', page.scrollTop === 168, page.scrollTop);
  fire(T.dom, up, 'pointermove', { clientX: 200, clientY: 400, pointerId: 6 });
  T.fire(50);
  ok('…and stops away from the edge', page.scrollTop === 168, page.scrollTop);
  fire(T.dom, up, 'pointermove', { clientX: 200, clientY: 690, pointerId: 6 });
  T.fire(50);
  ok('near the bottom it scrolls down', page.scrollTop === 184, page.scrollTop);
  fire(T.dom, up, 'pointerup', { clientX: 200, clientY: 690, pointerId: 6 });
  ok('dropped on Shortcuts: Up Next goes there and the S pair stays together', J(ids(ph)) === J(['glance-1', 'upnext-1', 'shortcuts-1', 'daily-1']), J(ids(ph)));
  T.fire(50);
  ok('the scroll timer is gone after the drop', page.scrollTop === 184);
});

console.log('\n2b. a refused drop keeps its reason on the live line');
G(() => {
  const T = mountPhone({ phone: [{ id: 'glance', s: 'm' }, { id: 'shortcuts', s: 's' }, { id: 'daily', s: 's' }, { id: 'upnext', s: 'm' }], desk: [] });
  const ph = phoneOf(T);
  longPress(T, byKey(ph, 'glance-1'));
  const up = byKey(ph, 'upnext-1');
  T.document.elementFromPoint = () => byKey(ph, 'daily-1');
  fire(T.dom, up, 'pointerdown', { clientX: 200, clientY: 600, pointerId: 12 });
  fire(T.dom, up, 'pointermove', { clientX: 300, clientY: 300, pointerId: 12 });
  fire(T.dom, up, 'pointerup', { clientX: 300, clientY: 300, pointerId: 12 });
  ok('dropped between an S pair: nothing moves', J(ids(ph)) === J(['glance-1', 'shortcuts-1', 'daily-1', 'upnext-1']), J(ids(ph)));
  ok('…and the live line still says why (the pair), not just that it stayed', /Small widgets sit in pairs, so Up Next stays where it is/.test(live(ph)), live(ph));
});

console.log('\n3. tap-pick-place still works alongside drag');
G(() => {
  const T = mountPhone({ phone: [{ id: 'glance', s: 'm' }, { id: 'upnext', s: 'm' }], desk: [] });
  const ph = phoneOf(T);
  longPress(T, byKey(ph, 'glance-1'));
  fire(T.dom, byKey(ph, 'upnext-1'), 'pointerdown', { clientX: 10, clientY: 10, pointerId: 9 });
  fire(T.dom, byKey(ph, 'upnext-1'), 'pointerup', { clientX: 10, clientY: 10, pointerId: 9 });
  click(T.dom, byKey(ph, 'upnext-1'));
  ok('a tap (no move) picks it up', byKey(ph, 'upnext-1').classList.contains('is-picked'));
  click(T.dom, byKey(ph, 'glance-1'));
  ok('the next tap places it', J(ids(ph)) === J(['upnext-1', 'glance-1']), J(ids(ph)));
  click(T.dom, ph.querySelector('[data-osp="done"]'));
  const u = byKey(ph, 'upnext-1');
  fire(T.dom, u, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 10 });
  fire(T.dom, u, 'pointermove', { clientX: 10, clientY: 300, pointerId: 10 });
  ok('out of edit mode a swipe on a widget never drags it', !u.classList.contains('is-dragging'));
  fire(T.dom, u, 'pointerup', { clientX: 10, clientY: 300, pointerId: 10 });
  ok('no Firestore read, no fetch', T.reads.length === 0, J(T.reads));
});

console.log('\n4. the CSS');
G(() => {
  const css = read('docs/pro/css/os/home.css').replace(/\n/g, ' ');
  ok('touch-action:none rides the edit-mode class, so it is set before pointerdown', /\.os-hw\.is-editing \{ touch-action: none; \}/.test(css));
  ok('the lifted widget and the drop place have their own look, no motion', /\.os-hw\.is-dragging \{[^}]*\}/.test(css) && /\.os-hw\.is-editing\.is-drop \{ outline: 2px solid var\(--orange\); \}/.test(css)
    && !/is-dragging[^}]*(transition|animation)/.test(css));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
