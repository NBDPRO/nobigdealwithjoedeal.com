/**
 * tests/nbd-os-layout-2026-11-06.test.js — NBD OS phases 2-3, the "os" layout.
 *
 *   1. layouts/os-wm-logic.js (pure): rect clamping and fraction maths, edge
 *      and corner snap zones, keyboard snapping, the window cascade, z-order,
 *      focus after close/minimise, icon order, the saved-state guard
 *      (unknown apps dropped, bounded, under the registry's 12 KB cap), and
 *      the phone helpers (pages, recent apps, dock).
 *   2. wiring (static): the layout is registered behind `osLayout` (on unless set false, 2026-11-07), its
 *      needs load the shared logic first, os.js escapes every value it puts in
 *      markup, positions through CSS custom properties only, follows the CRM
 *      router instead of replacing it, puts every view back on unmount, and
 *      never snaps a window while the member is typing in a field.
 *
 * Run: node tests/nbd-os-layout-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const WM = require(path.join(ROOT, 'docs/pro/js/layouts/os-wm-logic.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const J = JSON.stringify;

console.log('geometry');
let f = WM.clampFrac({ x: 0.9, y: -1, w: 0.5, h: 2 });
ok('a rect pushed off screen comes back fully on it', f.x === 0.5 && f.y === 0 && f.w === 0.5 && f.h === 1, J(f));
f = WM.clampFrac({ x: 0.1, y: 0.1, w: 0.01, h: 0.01 });
ok('never smaller than the minimum', f.w === WM.MIN_W && f.h === WM.MIN_H, J(f));
ok('garbage becomes a sane default', J(WM.clampFrac('x')) === J({ x: 0, y: 0, w: 0.5, h: 0.6 }), J(WM.clampFrac('x')));
const desk = { w: 1000, h: 600 };
ok('fractions to px', J(WM.toPx({ x: 0.1, y: 0.5, w: 0.5, h: 0.5 }, desk)) === J({ x: 100, y: 300, w: 500, h: 300 }));
ok('px back to fractions (round trip)', J(WM.toFrac({ x: 100, y: 300, w: 500, h: 300 }, desk)) === J({ x: 0.1, y: 0.5, w: 0.5, h: 0.5 }));
ok('a zero-size desk never divides by zero', J(WM.toFrac({ x: 1, y: 1, w: 1, h: 1 }, { w: 0, h: 0 })) === J(WM.clampFrac(null)));

console.log('snap zones');
ok('left edge', WM.snapZone({ x: 4, y: 300 }, desk) === 'left');
ok('right edge', WM.snapZone({ x: 996, y: 300 }, desk) === 'right');
ok('top edge maximises', WM.snapZone({ x: 500, y: 2 }, desk) === 'max');
ok('corners are quarters', WM.snapZone({ x: 2, y: 2 }, desk) === 'tl' && WM.snapZone({ x: 998, y: 598 }, desk) === 'br' &&
  WM.snapZone({ x: 998, y: 3 }, desk) === 'tr' && WM.snapZone({ x: 3, y: 597 }, desk) === 'bl');
ok('the middle and the bottom edge do not snap', WM.snapZone({ x: 500, y: 300 }, desk) === null && WM.snapZone({ x: 500, y: 599 }, desk) === null);
ok('outside the desk does not snap', WM.snapZone({ x: -5, y: 300 }, desk) === null && WM.snapZone({ x: 500, y: 700 }, desk) === null);
ok('zone rects', J(WM.zoneFrac('right')) === J({ x: 0.5, y: 0, w: 0.5, h: 1 }) && J(WM.zoneFrac('max')) === J({ x: 0, y: 0, w: 1, h: 1 }) && WM.zoneFrac('nope') === null);
ok('keyboard: left, then up = top-left quarter', WM.keySnap(WM.keySnap(null, 'ArrowLeft'), 'ArrowUp') === 'tl');
ok('keyboard: up from free = maximise; down from left = bottom-left', WM.keySnap(null, 'ArrowUp') === 'max' && WM.keySnap('left', 'ArrowDown') === 'bl');
ok('keyboard: right from left = back to free', WM.keySnap('left', 'ArrowRight') === null);
ok('keyboard: down from free = no change', WM.keySnap(null, 'ArrowDown') === null);

console.log('windows');
const c0 = WM.cascadeFrac(0), c1 = WM.cascadeFrac(1), c6 = WM.cascadeFrac(6);
ok('new windows cascade down-right and wrap every 6', c1.x > c0.x && c1.y > c0.y && J(c6) === J(c0));
ok('a cascade window is on screen', c0.x + c0.w <= 1 && WM.cascadeFrac(5).y + WM.cascadeFrac(5).h <= 1);
let wins = [{ id: 'a', z: 3 }, { id: 'b', z: 1 }, { id: 'c', z: 7 }];
wins = WM.front(wins, 'b');
ok('front() raises one window, renumbers 1..n keeping the rest in order', wins.map((w) => w.id + w.z).join(',') === 'a1,c2,b3', wins.map((w) => w.id + w.z).join(','));
ok('front() does not mutate its input', (() => { const x = [{ id: 'a', z: 5 }]; WM.front(x, 'a'); return x[0].z === 5; })());
ok('next focus after closing the top window is the next highest', WM.nextFocus(wins, 'b') === 'c');
ok('minimised windows never get focus; none left = desktop', WM.nextFocus([{ id: 'a', z: 1, min: true }], null) === null);
ok('icons: saved order first, new apps appended, removed apps dropped',
  WM.orderApps([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['c', 'gone', 'a', 'c']).map((x) => x.id).join('') === 'cab');

console.log('saved state guard');
const big = { wins: [], icons: [], recent: [], dock: [], junk: 'x'.repeat(50000), focus: 'zz' };
for (let i = 0; i < 40; i++) big.wins.push({ id: 'app' + i, x: 2, y: 2, w: 9, h: 9, zone: 'weird', min: 'yes', extra: 'x'.repeat(500) });
const known = big.wins.map((w) => w.id);
const ns = WM.normalizeState(big, known);
ok('at most MAX_WINS windows kept', ns.wins.length === WM.MAX_WINS);
ok('unknown keys and junk dropped', ns.junk === undefined && ns.wins.every((w) => w.extra === undefined));
ok('rects clamped, bad zone and min flags cleaned', ns.wins.every((w) => w.x + w.w <= 1 && w.zone === null && w.min === false));
ok('a focus that is not an open window falls back', ns.focus === ns.wins[ns.wins.length - 1].id);
ok('fits the registry\'s 12 KB per-layout cap', J(ns).length <= R.MAX_STATE_JSON, J(ns).length);
const ns2 = WM.normalizeState({ wins: [{ id: 'admin' }, { id: 'crm' }, { id: 'crm' }, { id: 'Bad' }], icons: ['admin', 'crm'], dock: ['crm', 'crm', 'x'] }, ['crm']);
ok('windows / icons / dock only for apps this member has (role-gated stay gone)', ns2.wins.map((w) => w.id).join() === 'crm' && ns2.icons.join() === 'crm' && ns2.dock.join() === 'crm');
ok('no state at all is a clean empty desk', J(WM.normalizeState(null, [])) === J({ v: 1, wins: [], focus: null, icons: [], dock: [], recent: [], desk: 0, pins: [] }));

console.log('phase 5: desks, pins, overview, button styles');
ok('desk numbers clamp to 0..3', WM.deskIndex(2) === 2 && WM.deskIndex(4) === 0 && WM.deskIndex(-1) === 0 && WM.deskIndex('x') === 0 && WM.DESKS === 4);
const ns5 = WM.normalizeState({ wins: [{ id: 'crm', desk: 2 }, { id: 'est', desk: 9 }], desk: 3, pins: ['crm', 'crm', 'gone', 'est'] }, ['crm', 'est']);
ok('each window keeps its desk; a bad desk is desk 0; the current desk is kept', ns5.wins.map((w) => w.id + w.desk).join() === 'crm2,est0' && ns5.desk === 3);
ok('pins: known apps only, no repeats', ns5.pins.join() === 'crm,est');
ok('desk counts', J(WM.deskCounts([{ desk: 0 }, { desk: 2 }, { desk: 2 }, { desk: 7 }])) === J([2, 0, 2, 0]));
const ti = WM.taskItems([{ id: 'crm', desk: 0 }, { id: 'est', desk: 1, min: true }, { id: 'home', desk: 0 }], ['est', 'photos'], 0, ['home', 'crm', 'est']);
ok('shelf: pinned first (running or not), then this desk\'s windows in open order', ti.map((t) => t.id).join() === 'est,photos,home,crm', ti.map((t) => t.id).join());
ok('shelf flags: pinned est runs on another desk, photos is not running', ti[0].pinned && ti[0].running && !ti[0].here && ti[0].min && !ti[1].running);
ok('windows on other desks are not on this desk\'s shelf unless pinned', WM.taskItems([{ id: 'crm', desk: 1 }], [], 0, []).length === 0);
let pins = WM.togglePin([], 'crm'); pins = WM.togglePin(pins, 'est'); pins = WM.togglePin(pins, 'crm');
ok('toggle pin adds and removes, keeping order', pins.join() === 'est');
let many = []; for (let i = 0; i < 12; i++) many = WM.togglePin(many, 'app' + i);
ok('at most MAX_PINS pins', many.length === WM.MAX_PINS);
ok('a bad id is never pinned', WM.togglePin([], '<x>').length === 0);
const slots = WM.overviewSlots(5, { w: 1200, h: 700 }, 20);
ok('overview: one slot per window, all inside the desk', slots.length === 5 && slots.every((s) => s.x >= 0 && s.y >= 0 && s.x + s.w <= 1200 && s.y + s.h <= 700), J(slots));
ok('overview: no overlapping slots', slots.every((a, i) => slots.every((b, j) => i === j || a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)));
ok('overview: nothing to show, or no desk, is no slots', WM.overviewSlots(0, { w: 1, h: 1 }).length === 0 && WM.overviewSlots(3, { w: 0, h: 0 }).length === 0);
const fit = WM.fitInto({ x: 100, y: 50, w: 800, h: 600 }, { x: 0, y: 0, w: 400, h: 400 });
ok('fit: scaled down to the slot and centred in it', fit.s === 0.5 && fit.tx === -100 && fit.ty === 0, J(fit));
ok('fit: a small window is never enlarged', WM.fitInto({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 400, h: 400 }).s === 1);
ok('button styles: chrome by default, mac and linux allowed', WM.buttonStyle('mac') === 'mac' && WM.buttonStyle('linux') === 'linux' && WM.buttonStyle('bogus') === 'chrome' && WM.buttonStyle() === 'chrome');

console.log('phone helpers');
const apps = 'abcdefghijklmnopqrstuvwxy'.split('').map((ch) => ({ id: ch }));
const pg = WM.pages(apps, 20);
ok('pages of 20', pg.length === 2 && pg[0].length === 20 && pg[1].length === 5);
ok('no apps is one empty page', J(WM.pages([], 20)) === '[[]]');
let rec = [];
['a', 'b', 'a', 'c'].forEach((id) => { rec = WM.pushRecent(rec, id); });
ok('recent apps: newest first, no repeats', rec.join('') === 'cab');
for (let i = 0; i < 20; i++) rec = WM.pushRecent(rec, 'x' + i);
ok('recent apps capped', rec.length === WM.MAX_RECENT);
ok('bad ids are ignored', WM.pushRecent(['a'], '<script>').join() === 'a');
const dock = WM.dockApps([{ id: 'home' }, { id: 'crm' }, { id: 'photos' }, { id: 'schedule' }, { id: 'est' }], ['photos', 'nope']);
ok('dock: wanted first, then defaults, four slots', dock.map((d) => d.id).join() === 'photos,home,crm,schedule', dock.map((d) => d.id).join());
ok('dock tops up from any app when defaults are missing', WM.dockApps([{ id: 'a' }, { id: 'b' }], []).length === 2);

console.log('wiring');
const SYS = read('docs/pro/js/layout-system.js');
const OS = read('docs/pro/js/layouts/os.js');
const CSS = read('docs/pro/css/layouts/os.css');
const def = R.get('os');
ok('registered as "os", every surface, dark behind osLayout', !!def && def.flag === 'osLayout' && def.surfaces.join() === 'phone,tablet,desktop');
ok('needs load the shared logic (js/os is an allowed needs path)', def && def.needs.script.join() === 'js/os/system-logic.js,js/layouts/os-wm-logic.js');
ok('hidden from the picker while the flag is off', R.forSurface('desktop').every((d) => d.id !== 'os'));
ok('implements through the engine', /W\.LayoutEngine\.implement\('os', \{ mount: mount, unmount: unmount \}\)/.test(OS));
// esc(...) calls, and *Html strings built from esc() pieces, are the only things spliced in
const raw = OS.match(/' \+ (?!esc\(|\(|\w+Html \+|'|String\()[a-zA-Z_.]+ \+ '/g) || [];
ok('no unescaped value is spliced into markup', raw.length === 0, raw.join(' | '));
ok('no inline handlers', !/\son[a-z]+=/i.test(OS.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('positions only through custom properties (no left/top/width writes)', !/\.style\.(left|top|width|height|zIndex)\s*=/.test(OS) && /style\.setProperty\('--wx'/.test(OS));
ok('follows the CRM router: a view made active opens its window', /S\.mo\.observe\(/.test(OS) && /function onViewChange\(\)/.test(OS) && /openWin\(id, \{ route: false \}\)/.test(OS));
ok('opening an app goes through goTo (the one router)', /W\.goTo\(id\)/.test(OS));
ok('unmount releases every view back to where it was', /Object\.keys\(st\.origins\)\.forEach\(function \(id\) \{ release\(id\); \}\)/.test(OS) && /o\.parent\.insertBefore\(v, kids\[WM\.restoreIndex\(S\.viewOrder, v, kids\)\] \|\| null\)/.test(OS));
ok('no snapping while typing in a field', /\/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(tag\)/.test(OS));
ok('saves through LayoutEngine.saveUser, normalised, and unmount flushes a pending save', /saveUser\(\{ layoutState: \{ os: st \} \}\)/.test(OS) && /WM\.normalizeState\(\{ wins: src\.wins/.test(OS) &&
  /if \(saveT\) \{ clearTimeout\(saveT\); saveT = null; writeState\(st\); \}/.test(OS));
ok('stylesheet: no hex colours', !/#[0-9a-fA-F]{3,8}\b/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('stylesheet: no transition: all, durations from tokens', !/transition:\s*all/.test(CSS) && (CSS.match(/transition:[^;]+/g) || []).every((s) => !/\d+m?s/.test(s.replace(/var\([^)]*\)/g, ''))));
ok('stylesheet: windowed views show, the rest stay hidden', /\.os-win-body > \.view\.os-in-win \{ display: flex !important;/.test(CSS) && /\.content > \.view \{ display: none !important; \}/.test(CSS));
ok('touch screens get the 44px floor on window controls', /@media \(pointer: coarse\)[\s\S]*?\.os-win-btn \{ width: 44px; height: 44px; \}/.test(CSS));

const has = (src, s) => src.indexOf(s) !== -1;
ok('phone: #mobile-nav hidden (the bar replaces it)', has(CSS, '[data-os-surface="phone"] #mobile-nav { display: none !important; }'));
ok('phone: the bar is 62px + safe area, like #mobile-nav (FAB ladder clearance)', has(CSS, 'height: calc(62px + env(safe-area-inset-bottom, 0px)); padding: 0 2px env(safe-area-inset-bottom, 0px);'));
ok('phone: home screen hides views; an open app hides the home screen',
  has(CSS, ':not([data-os-app]) .content > .view { display: none !important; }') && has(CSS, '[data-os-app] .os-phone { display: none; }'));
ok('phone: opening an app records it in recents and routes through goTo', has(OS, 'S.recent = WM.pushRecent(S.recent, id);') && has(OS, 'if (o.route !== false) goToView(id);'));
ok('phone: the switcher is a modal dialog and Esc closes it', has(OS, "setAttribute('aria-modal', 'true')") && has(OS, 'if (S.switcherEl) { ev.preventDefault(); closeSwitcher(); }'));
ok('crossing the phone breakpoint remounts the right shape', /unmount\(\);\s+mount\(\{ surface: now \}\);/.test(OS));
ok('nothing loops: no infinite animations', !/infinite/.test(CSS));

console.log('phase 5 wiring');
ok('the router watcher reacts only to a VIEW\'s class changing (never the layout\'s own window classes)', has(OS, "routed = !!(t && t.classList && t.classList.contains('view'));") && has(OS, 'if (!routed || pending) return;'));
ok('windows on another desk are not drawn', has(OS, "el.classList.toggle('is-offdesk', WM.deskIndex(rec.desk) !== S.desk);") && has(CSS, '.os-win.is-offdesk { display: none; }'));
ok('opening a window that lives on another desk goes to that desk', has(OS, 'if (WM.deskIndex(rec.desk) !== S.desk) { S.desk = WM.deskIndex(rec.desk); paintDeskBtns(); }'));
ok('focus fallbacks stay on the current desk', has(OS, 'var next = WM.nextFocus(here(), id);'));
ok('moving the front window away routes the CRM to the window left in front', has(OS, 'if (S.focus) focusWin(S.focus); else save();'));
ok('overview moves the real windows by transform only, and a press never drags there',
  has(CSS, 'transform: translate(var(--otx, 0px), var(--oty, 0px)) scale(var(--os, 1));') && has(OS, 'if (S.overview) return;   // in the overview'));
ok('desk / overview keys never fire while typing', has(OS, 'if (ev.ctrlKey && ev.altKey && !ev.metaKey && !typing) {'));
ok('desk and overview are Spotlight entries, removed on unmount', has(OS, "id: 'os:overview'") && has(OS, 'unregisterDeskSpotlight();'));
ok('pinning: Start menu toggle is a pressed button, right-click on shelf/icon also toggles', has(OS, 'data-ospin=') && has(OS, "aria-pressed=\"' + (pinned ? 'true' : 'false')") && has(OS, "on(desk, 'contextmenu'"));
ok('button styles: mac / chrome / linux from one attribute; coarse pointers keep the 44px floor',
  has(CSS, 'html[data-os-buttons="mac"]') && has(CSS, 'html[data-os-buttons="linux"]') && /@media \(pointer: coarse\) \{\n  html\[data-os-buttons="mac"\] \.os-win-btns \.os-win-btn \{ width: 44px; height: 44px; \}/.test(CSS));

R._reset();
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
