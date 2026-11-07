/**
 * tests/nbd-os-system-2026-11-06.test.js — NBD OS phase 1, the System layer.
 *
 *   1. os/system-logic.js (pure): the tray (calm day = sync + notifs only,
 *      offline / syncing / storm / away / DND), Do Not Disturb holds only
 *      routine toasts, the toast history cap, Notification Center grouping
 *      (fixed order, unknown types kept, newest first), apps from the sidebar
 *      (role-hidden entries never become apps), the Spotlight entries, clock.
 *   2. wiring (static): the layer is lazy and flag-gated in layout-system.js,
 *      never a <script> tag in dashboard.html; system.js uses no inline
 *      handlers or styles and escapes what it puts in innerHTML; the bell
 *      exposes read-only items; the stylesheet uses tokens, not hex.
 *
 * Run: node tests/nbd-os-system-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const L = require(path.join(ROOT, 'docs/pro/js/os/system-logic.js'));

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const ids = (xs) => xs.map((x) => x.id).join(',');

console.log('tray');
let t = L.trayItems({ online: true, pending: 0, unread: 0 });
ok('a calm day is sync + notifications only', ids(t) === 'sync,notifs', ids(t));
ok('synced reads ok', t[0].tone === 'ok' && t[0].text === 'Synced');
ok('zero unread is quiet', t[1].tone === 'quiet' && t[1].text === '0');
t = L.trayItems({ online: false, pending: 3, unread: 2 });
ok('offline with a queue says how many are saved here', t[0].tone === 'warn' && t[0].text === 'Offline · 3' && /3 items saved/.test(t[0].label), JSON.stringify(t[0]));
ok('unread is an alert', t[1].tone === 'alert' && t[1].text === '2' && t[1].label === '2 unread notifications');
t = L.trayItems({ online: true, pending: 1, unread: 1 });
ok('online with a queue is syncing', t[0].text === '1 syncing' && t[0].label === '1 item still uploading');
ok('one unread is singular', t[1].label === '1 unread notification');
ok('huge unread caps at 99+', L.trayItems({ unread: 400 })[1].text === '99+');
ok('junk counts read as zero', L.trayItems({ pending: 'x', unread: -4 })[1].text === '0' && L.trayItems({ pending: NaN })[0].text === 'Synced');
t = L.trayItems({ storm: { active: true, warnings: 2 }, away: { on: true }, dnd: true });
ok('storm, away and DND appear only when on', ids(t) === 'sync,notifs,storm,away,dnd', ids(t));
ok('storm with warnings counts them', t[2].text === '2 warnings');
ok('storm mode alone says so', L.trayItems({ storm: { active: true } })[2].text === 'Storm mode');
ok('the tray never carries a name (counts only)', JSON.stringify(L.trayItems({ unread: 3, pending: 2, storm: { warnings: 1 } })).indexOf('Smith') === -1);

console.log('Do Not Disturb');
ok('DND off holds nothing', !L.holdToast('info', false) && !L.holdToast('success', false));
ok('DND holds info and success', L.holdToast('info', true) && L.holdToast('success', true) && L.holdToast(undefined, true));
ok('DND never holds a warning or an error', !L.holdToast('warning', true) && !L.holdToast('error', true));

console.log('history');
let h = [];
for (let i = 0; i < 60; i++) h = L.pushHistory(h, { message: 'm' + i, type: 'info', ts: i });
ok('capped at HISTORY_MAX', h.length === L.HISTORY_MAX && L.HISTORY_MAX === 50);
ok('newest first', h[0].message === 'm59' && h[49].message === 'm10');
ok('blank messages are skipped', L.pushHistory([], { message: '  ' }).length === 0 && L.pushHistory([], null).length === 0);
const long = L.pushHistory([], { message: 'x'.repeat(500), type: 'bogus', held: 'yes' })[0];
ok('long text trimmed, unknown type -> info, held only when true', long.message.length === 200 && long.type === 'info' && long.held === false);
ok('the input list is not mutated', (() => { const a = []; L.pushHistory(a, { message: 'a' }); return a.length === 0; })());

console.log('Notification Center groups');
const g = L.groupNotifications([
  { id: 'a', type: 'stale-lead', ts: 1 },
  { id: 'b', type: 'overdue-task', ts: 5, read: true },
  { id: 'c', type: 'task-today', ts: 9 },
  { id: 'd', type: 'portal-reply', server: true, ts: 3 },
  { id: 'e', type: 'brand-new-kind', ts: 2 },
  { id: 'f', type: 'fresh-view', ts: 4 },
  { type: 'no-id' }, null,
]);
ok('fixed section order, empty ones left out', ids(g) === 'tasks,estimates,leads,activity,other', ids(g));
ok('newest first inside a section', g[0].items.map((n) => n.id).join(',') === 'c,b');
ok('unread count per section', g[0].unread === 1);
ok('an unknown kind is kept under Other', g[4].items[0].id === 'e');
ok('a server item lands in Customer activity', g[3].label === 'Customer activity' && g[3].items[0].id === 'd');
ok('no items -> no sections', L.groupNotifications([]).length === 0 && L.groupNotifications(null).length === 0);

console.log('apps from the sidebar');
const apps = L.appsFromNav([
  { id: 'home', label: ' Home ' }, { id: 'crm', label: 'Pipeline' }, { id: 'admin', label: 'Admin', hidden: true },
  { id: 'crm', label: 'Dup' }, { id: 'Bad Id', label: 'x' }, { id: 'est', label: '' }, { id: 'money', label: 'Money\n  Dashboard' },
]);
ok('role-hidden, duplicate, invalid and unlabeled entries are dropped', ids(apps) === 'home,crm,money', ids(apps));
ok('labels trimmed and whitespace collapsed', apps[0].label === 'Home' && apps[2].label === 'Money Dashboard');

console.log('Spotlight entries');
const acts = L.systemActions(apps);
ok('every id is namespaced os:', acts.every((a) => /^os:/.test(a.id)));
ok('one Open <app> per app', acts.filter((a) => a.app).map((a) => a.label).join('|') === 'Open Home|Open Pipeline|Open Money Dashboard');
ok('system panels and DND are there', ['os:control', 'os:notifs', 'os:dnd', 'os:layouts'].every((id) => acts.some((a) => a.id === id)));

console.log('clock');
const c = L.clockText(new Date(2026, 10, 6, 14, 5));
ok('12-hour time with zero-padded minutes', c.time === '2:05 PM', c.time);
ok('short date', c.date === 'Fri, Nov 6', c.date);
ok('midnight is 12 AM', L.clockText(new Date(2026, 0, 1, 0, 0)).time === '12:00 AM');
ok('noon is 12 PM', L.clockText(new Date(2026, 0, 1, 12, 30)).time === '12:30 PM');
ok('bad input -> empty', L.clockText('nope').time === '' && L.clockText(undefined).date === '');

console.log('wiring');
const SYS = read('docs/pro/js/layout-system.js');
const DOM = read('docs/pro/js/os/system.js');
const CSS = read('docs/pro/css/os/system.css');
const HTML = read('docs/pro/dashboard.html');
const BELL = read('docs/pro/js/notif-bell.js');
ok('the engine loads the layer only behind osSystemLayer', /var SYSTEM_FLAG = 'osSystemLayer';/.test(SYS) && /if \(flags\[SYSTEM_FLAG\]\) loadSystemLayer\(\);/.test(SYS));
ok('it starts before the flag read unless the cache says it was turned off (on by default, 2026-11-07)', /cachedFlags\(\)\[SYSTEM_FLAG\] !== false\) loadSystemLayer\(\)/.test(SYS));
ok('logic loads before the DOM half', SYS.indexOf("loadScriptPath('js/os/system-logic.js')") < SYS.indexOf("js/os/system.js?"));
// 2026-11-07 (on for everyone): on a phone the tray clock sat ON the NBD logo mark and squeezed the
// wordmark to 0px (Pro demo walk, wallpaper-chrome: "the wordmark clears 4.5:1"). Measured fix:
{
  const phone = (CSS.match(/@media \(max-width: 480px\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('phones: the tray is a 40px button with the time hidden visually (kept for screen readers), packed at a 2px gap',
    /header \.hright \{ gap: 2px; \}/.test(phone) && /\.os-tray-clock \{ min-width: 40px; padding: 0; \}/.test(phone)
    && /\.os-tray-clock \.os-tray-time \{\s*position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect\(0 0 0 0\)/.test(phone)
    && !/\.os-tray-time[^{]*\{[^}]*display: none/.test(phone), phone.slice(0, 200));
  ok('phones: an empty tray button gets a visible controls glyph in its own ink (no hex, no emoji)',
    /\.os-tray-clock::before \{[\s\S]*?currentColor[\s\S]*?\}/.test(phone) && !/#[0-9a-f]{3,8}\b/i.test(phone));
  ok('under 380px the wordmark is hidden cleanly (the logo mark stays), not clipped mid-word',
    /@media \(max-width: 380px\) \{\s*header \.logo \{ display: none; \}\s*\}/.test(CSS) && !/logo-mark[^{]*\{[^}]*display: none/.test(CSS));
  ok('the time is still in the tray button\'s label', /Control Center, /.test(read('docs/pro/js/os/system.js')) || /Control Center/.test(read('docs/pro/js/os/system.js')));
}
ok('no <script> tag for the layer in dashboard.html', !/js\/os\//.test(HTML));
ok('system.js has no inline handlers', !/\son[a-z]+=/i.test(DOM.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('system.js writes no inline style attributes', !/style=/.test(DOM) && !/\.style\./.test(DOM));
// every dynamic value spliced into an HTML string goes through esc() (or is a number we computed,
// or a *Html string that was itself built from esc() pieces)
const raw = DOM.match(/' \+ (?!esc\(|\(|g\.unread|h \+|'|\w+\(\) \+|\w+Html \+)[a-zA-Z_.]+ \+ '/g) || [];
ok('no unescaped value is spliced into markup', raw.length === 0, raw.join(' | '));
ok('toast text is never innerHTML (escaped into the history only)', /esc\(e\.message\)/.test(DOM));
ok('DND hold goes through the pure rule', /L\.holdToast\(type, state\.dnd\)/.test(DOM));
ok('the bell exposes read-only items with no callbacks', /items: \(\) => buildNotifications\(\)/.test(BELL) && !/onClick: n\.onClick/.test(BELL));
ok('sheets are dialogs with a label and Esc closes them', /role="dialog" aria-modal="true" aria-labelledby="osSheetTitle"/.test(DOM) && /e\.key === 'Escape'/.test(DOM));
ok('the stylesheet uses no hex colours', !/#[0-9a-fA-F]{3,8}\b/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('every transition uses a --ui-dur token', (CSS.match(/transition:[^;]+/g) || []).every((s) => !/\d+m?s/.test(s.replace(/var\([^)]*\)/g, ''))));
ok('no transition: all', !/transition:\s*all/.test(CSS));
// 2026-11-07: the 2px phone gap put the What's New bell under the Settings pill's 44px hit area
// (header-taps visual audit). The real proof is that audit in the Pro demo walk; this pins the rule.
ok('phones: the What\'s New bell keeps 3px clear of the Settings pill (beats its inline -3px)',
  /@media \(max-width: 480px\) \{[\s\S]*?header #nbd-whats-new-bell \{ margin-right: 3px !important; \}/.test(CSS));

console.log('phase 4: session, lock, settings');
ok('auto-lock choices; junk reads as off', L.lockMinutes(5) === 5 && L.lockMinutes('15') === 15 && L.lockMinutes(7) === 0 && L.lockMinutes('x') === 0);
ok('locks only after the chosen idle time', !L.shouldLock(0, 4 * 60000, 5) && L.shouldLock(0, 5 * 60000, 5));
ok('off never locks; a clock that went backwards never locks', !L.shouldLock(0, 1e12, 0) && !L.shouldLock(1e12, 0, 5));
const ll = L.lockLines({ unread: 2, pending: 3, online: false });
ok('lock lines are counts only', ll.join('|') === '2 notifications waiting|Offline · 3 changes saved here', ll.join('|'));
ok('a calm lock screen', L.lockLines({}).join('|') === 'No new notifications');
ok('company mark: two initials, symbols ignored, empty name -> empty',
  L.companyMark('No Big Deal Home Solutions') === 'NB' && L.companyMark('Acme') === 'AC' && L.companyMark('  &  ') === '' && L.companyMark(null) === '');
const bs = L.bootSteps({ signedIn: true, dataReady: false });
ok('boot steps reflect real progress', bs.map((s) => s.id + (s.done ? '+' : '-')).join(',') === 'auth+,data-,ready-');
const sa = L.settingsActions([{ id: 'profile', label: '👤 Profile' }, { id: 'billing', label: '💳 Billing', hidden: true }, { id: 'profile', label: 'dup' }, { id: 'Bad', label: 'x' }, { id: 'help', label: '❓  Help ' }]);
ok('settings entries: role-hidden, duplicate and bad tabs dropped; emoji prefix stripped',
  sa.map((a) => a.label).join('|') === 'Settings: Profile|Settings: Help' && sa.every((a) => /^os:set:/.test(a.id)), sa.map((a) => a.label).join('|'));
ok('Lock screen is a Spotlight entry', L.systemActions([]).some((a) => a.id === 'os:lock'));
ok('lock is a modal dialog that hides the rest from screen readers and restores it', /aria-label', 'Screen locked'/.test(DOM) &&
  /c\.setAttribute\('aria-hidden', 'true'\)/.test(DOM) && /hiddenForLock\.forEach\(function \(c\) \{ c\.removeAttribute\('aria-hidden'\); \}\)/.test(DOM));
ok('lock lines come from the counts-only rule', /L\.lockLines\(\{ unread: unreadCount\(\)/.test(DOM));
ok('boot: once per session, skipped when loaded or with reduced motion, capped at 6 s',
  /if \(seen \|\| dataReady\(\) \|\| motionReducedNow\(\)\) return;/.test(DOM) && /Date\.now\(\) - started > 6000/.test(DOM));
ok('sounds are opt-in (off unless the stored switch is on)', /state\.sounds = lsGet\(SOUND_KEY\) === '1';/.test(DOM) && /if \(!state\.sounds \|\| !TONES\[kind\]\) return;/.test(DOM));
ok('auto-lock is off by default', /state\.lockMin = L\.lockMinutes\(lsGet\(LOCK_KEY\)\);/.test(DOM) && L.lockMinutes(null) === 0);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
