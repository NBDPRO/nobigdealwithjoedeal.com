/**
 * tests/nbd-os-wallpaper-glance-2026-11-09.test.js - NBD OS P0c step 4
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.6, §8 P0c).
 *
 *   Wallpaper: a Control Center tile (system layer registerControl) and a
 *   desk-column button that call NBDMySkinBoot.load() and then open My Skin's
 *   existing background picker (Settings, Appearance, the My Skin panel). No
 *   new wallpaper storage, no new read, no request of its own (the demo stays
 *   zero-network: My Skin is a same-origin bundle).
 *
 *   Glance wording: with no appointment still to come but jobs on Today, At a
 *   Glance says "No more appointments · N jobs today" (N counted by code), not
 *   a bare "No more appointments today" next to a 7:00 am job in Up Next.
 *
 * Run: node tests/nbd-os-wallpaper-glance-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, NOW, byKey, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
const OS_JS = read('docs/pro/js/layouts/os.js');

const appt = (min, extra) => Object.assign({ key: 'a' + min, leadId: 'L' + min, name: 'Ben', address: '1 Elm St, X', timeLabel: '7:00 AM', sortMs: NOW + min * 60000, allDay: false }, extra || {});
const glanceText = (plan, size) => {
  const T = makeWin({ surface: 'phone', plan, home: { phone: [{ id: 'glance', s: size || 'm' }], desk: [] } });
  T.W._impl.mount({ surface: 'phone' });
  return text(byKey(T.document.getElementById('osPhone'), 'glance-1'));
};

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. At a Glance: no more appointments, but jobs today');
G(() => {
  ok('noMoreLine: jobs on Today -> "No more appointments · N jobs today"', HL.noMoreLine({ appointments: [appt(-360), appt(-120)] }) === 'No more appointments · 2 jobs today');
  ok('…one job: singular', HL.noMoreLine({ appointments: [appt(-360)] }) === 'No more appointments · 1 job today');
  ok('…none at all: the plain line', HL.noMoreLine({ appointments: [] }) === 'No more appointments today' && HL.noMoreLine({}) === 'No more appointments today');
  const past = glanceText({ total: 2, appointments: [appt(-366), appt(-200, { allDay: true })], calls: [], promises: [], promised: [], estimates: [], money: [], stalled: [] });
  ok('the widget: the 7:00 am job is past -> "No more appointments · 2 jobs today"', /No more appointments · 2 jobs today/.test(past), past);
  ok('…the count is the plan\'s own appointment count (every number from code)', (past.match(/(\d+) jobs? today/) || [])[1] === '2');
  const soon = glanceText({ total: 1, appointments: [appt(-300), appt(55)] });
  ok('an appointment still to come: "Next" as before', /Next 7:00 AM/.test(soon) && !/No more/.test(soon), soon);
  const none = glanceText({ total: 0, appointments: [] });
  ok('no jobs at all: "No more appointments today"', /No more appointments today/.test(none), none);
  const s = glanceText({ total: 1, appointments: [appt(-300)] }, 's');
  ok('S says it too (no name, no place)', /No more appointments · 1 job today/.test(s) && !/Ben|Elm/.test(s), s);
});

console.log('\n2. Wallpaper: the Control Center tile and the desk button open My Skin\'s picker');
G(() => {
  const T = makeWin({ surface: 'phone', system: true, home: { phone: [{ id: 'glance', s: 'm' }], desk: [] } });
  T.W._impl.mount({ surface: 'phone' });
  const c = (T.W.controls || []).filter((x) => x.id === 'os-wallpaper')[0];
  ok('a "Wallpaper" Control Center tile is registered', c && c.label === 'Wallpaper' && typeof c.run === 'function', J(T.W.controls));
  c.run();
  ok('…it loads My Skin (NBDMySkinBoot.load())', T.W.skinLoads === 1);
  ok('…and opens Settings, Appearance, at the My Skin panel (the system layer\'s settingsTab)', J(T.W.settingsTabs) === J(['appearance#myskinPanel']), J(T.W.settingsTabs));
  T.W._impl.unmount();
  ok('…and is taken down with the layout', !(T.W.controls || []).some((x) => x.id === 'os-wallpaper'));

  const D = makeWin({ surface: 'desktop', home: { phone: [], desk: [{ id: 'glance', s: 'm' }] } });
  D.W._impl.mount({ surface: 'desktop' });
  const col = D.document.getElementById('osDesk').querySelector('.os-widgets');
  const b = col.querySelector('[data-osdo="wallpaper"]');
  ok('the desk column has a Wallpaper button next to Edit Home', b && /Wallpaper/.test(text(b)) && !!col.querySelector('[data-osdo="homeedit"]'));
  click(D.dom, b);
  ok('…it loads My Skin', D.W.skinLoads === 1);
  ok('…with no system layer: goTo(settings), then the Appearance tab', D.W.goTos.indexOf('settings') !== -1, J(D.W.goTos));
  D.fire(250);
  ok('…switched to Appearance once Settings is up', J(D.W.settingsTabs) === J(['appearance']), J(D.W.settingsTabs));
  ok('no new storage, no read, no request: nothing but My Skin\'s own loader', D.reads.length === 0 && T.reads.length === 0, J(D.reads));
  ok('no wallpaper store of its own in os.js (no getBlob, no storage ref, no new key)', !/getBlob|storageRef|ref\(\s*window\.storage|nbd_wallpaper|wallpaper:/.test(noComments(OS_JS)));
  const N = makeWin({ surface: 'desktop', home: { phone: [], desk: [{ id: 'glance', s: 'm' }] } });
  delete N.W.NBDMySkinBoot;
  N.W._impl.mount({ surface: 'desktop' });
  click(N.dom, N.document.getElementById('osDesk').querySelector('[data-osdo="wallpaper"]'));
  ok('My Skin\'s loader missing: Settings still opens, nothing throws', N.W.goTos.indexOf('settings') !== -1);
  const E = makeWin({ surface: 'desktop', home: { phone: [], desk: [{ id: 'glance', s: 'm' }] } });
  E.W._impl.mount({ surface: 'desktop' });
  click(E.dom, E.document.getElementById('osDesk').querySelector('[data-osdo="homeedit"]'));
  ok('in edit mode the column offers Add widget and Done instead', !E.document.getElementById('osDesk').querySelector('[data-osdo="wallpaper"]') && !!E.document.getElementById('osDesk').querySelector('[data-osdo="homeadd"]'));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
