/**
 * tests/nbd-os-review-fixes-2026-11-08.test.js — three NBD OS fixes from the
 * 2026-11-08 fresh-code review of #2989 (documentation/audit/CRM-POWER-SESSION-AUDIT-2026-11-08.md):
 *
 *   1. Do Not Disturb and the object form of showToast. ui.js takes both
 *      showToast('msg', 'type') and showToast({ message, type, undoAction }).
 *      The DND wrapper read only the first form, so an object toast had no type
 *      (held as 'info'), its undo was dropped, and the history showed
 *      "[object Object]". Now: both forms are read, a toast that carries an
 *      undo is never held (it is an action, not a notice), the history keeps
 *      the message text.
 *   2. Phones: the tray is the clock alone, and its dots covered warn/alert
 *      tones only. DND (tone quiet) is saved across sessions, so a phone showed
 *      no sign that toasts were being held. Now the clock carries a quiet dot
 *      and names DND in its label.
 *   3. Phone bar: a long-press on the bar opens the app switcher, but the
 *      release's click reached the Record visit button first (and bubbled to
 *      the recorder's document delegate), so a recording started under the
 *      switcher; a long-press on bar padding left the swallow flag set, eating
 *      the next tap. Now the swallow runs first, stops propagation, and clears
 *      itself if no click follows.
 *
 * Run: node tests/nbd-os-review-fixes-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}
const L = require(path.join(ROOT, 'docs/pro/js/os/system-logic.js'));
const DOM = read('docs/pro/js/os/system.js');
const CSS = read('docs/pro/css/os/system.css');
const OS = read('docs/pro/js/layouts/os.js');

console.log('\n1. DND reads both showToast signatures');
{
  ok('toastEntry exists', typeof L.toastEntry === 'function');
  const a = L.toastEntry('Lead saved', 'success');
  ok('string form: message + type', a && a.message === 'Lead saved' && a.type === 'success' && a.undo === false, JSON.stringify(a));
  const b = L.toastEntry('Saved');
  ok('string form with no type reads as info', b && b.type === 'info', JSON.stringify(b));
  const c = L.toastEntry({ message: 'Moved 12 leads', type: 'success', undoAction: function () {} });
  ok('object form: message, type and the undo are read', c && c.message === 'Moved 12 leads' && c.type === 'success' && c.undo === true, JSON.stringify(c));
  const d = L.toastEntry({ message: 'Upload failed', type: 'error' });
  ok('object form without undo', d && d.type === 'error' && d.undo === false, JSON.stringify(d));
  const e = L.toastEntry({ type: 'info' });
  ok('an object with no message gives an empty message (nothing in the history), never "[object Object]"', e && e.message === '' && !/object/i.test(e.message), JSON.stringify(e));
  ok('junk in: still an entry', L.toastEntry(null).message === '' && L.toastEntry(undefined).type === 'info' && L.toastEntry(42).message === '42');

  ok('DND still holds a plain info or success toast', L.holdToast('info', true) && L.holdToast('success', true) && L.holdToast(undefined, true));
  ok('DND never holds a warning or an error', !L.holdToast('warning', true) && !L.holdToast('error', true));
  ok('DND never holds a toast that carries an undo (hasUndo third argument)', !L.holdToast('success', true, true) && !L.holdToast('info', true, true));
  ok('DND off holds nothing, undo or not', !L.holdToast('info', false) && !L.holdToast('info', false, true));
  ok('history stores the message text of an object toast', L.pushHistory([], L.toastEntry({ message: 'Moved 12 leads', type: 'success', undoAction: () => {} }))[0].message === 'Moved 12 leads');

  const wrap = DOM.slice(DOM.indexOf('function wrapToast'), DOM.indexOf('function wrapToast') + 900);
  ok('system.js: the wrapper goes through toastEntry and passes the undo flag to holdToast', /L\.toastEntry\(/.test(wrap) && /L\.holdToast\(\w+\.type, state\.dnd, \w+\.undo\)/.test(wrap), wrap.slice(0, 300));
  ok('system.js: the history gets the normalised entry, not the raw first argument', !/message: message, type: type/.test(wrap));
  ok('system.js: the original showToast still receives the original arguments', /orig\.apply\(this, arguments\)/.test(wrap));
}

console.log('\n2. phones: the clock shows DND');
{
  ok('clockAlerts exists', typeof L.clockAlerts === 'function');
  const items = L.trayItems({ online: false, pending: 0, unread: 3, storm: { active: true, warnings: 1 }, away: { on: true }, dnd: true });
  const al = L.clockAlerts(items).map((it) => it.id);
  ok('offline, storm, away and DND reach the clock; unread (its own bell) does not', al.join() === 'sync,storm,away,dnd', al.join());
  const calm = L.clockAlerts(L.trayItems({ online: true, pending: 0, unread: 0, storm: { active: false }, away: { on: false }, dnd: false }));
  ok('a calm tray puts no dot on the clock', calm.length === 0, JSON.stringify(calm));
  ok('the DND alert keeps its quiet tone and its label for the clock\'s aria-label', L.clockAlerts(items).some((it) => it.id === 'dnd' && it.tone === 'quiet' && /Do Not Disturb/.test(it.label)));
  ok('system.js: paintTray uses clockAlerts for the dots and the label', /var alerts = L\.clockAlerts\(items\);/.test(DOM) && !/it\.tone === 'warn' \|\| \(it\.tone === 'alert'/.test(DOM));
  ok('system.css: a quiet clock dot has a colour (a token, no hex)', /\.os-clock-dot\.os-tone-quiet \{ background: var\(--[a-z0-9-]+\); \}/.test(CSS));
}

console.log('\n3. phone bar: a long-press never also taps');
{
  const i = OS.indexOf('function onPhoneClick(ev) {');
  const fn = OS.slice(i, OS.indexOf('\n  }\n', i) + 5);
  ok('control: found onPhoneClick', fn.length > 100);
  const iGuard = fn.indexOf('if (S.barSwiped)'), iVisit = fn.indexOf("closest('[data-osvisit]')");
  ok('the swallow guard runs before the visit-button branch', iGuard > 0 && iVisit > 0 && iGuard < iVisit, iGuard + ' vs ' + iVisit);
  ok('the swallowed click stops propagating, so the recorder\'s document delegate never sees it', /if \(S\.barSwiped\) \{[^}]*stopPropagation\(\)/.test(fn), fn.slice(iGuard, iGuard + 160));
  ok('the swallow flag clears itself when no click follows a swipe or a long-press (a stale flag used to eat the next tap)', /function armSwallow\(\)/.test(OS) && /S\.barSwiped = false/.test(OS.slice(OS.indexOf('function armSwallow'), OS.indexOf('function armSwallow') + 300)) && /clearTimeout\(S\.swallowT\)/.test(OS));
  ok('both the long-press and the swipe arm the swallow the same way', (OS.match(/armSwallow\(\)/g) || []).length >= 3);
  ok('unmount clears the swallow timer too', /clearTimeout\(st\.swallowT\)/.test(OS));

  // run the real onPhoneClick with stubs: a long-press on Record must not start a recording
  const body = fn.replace(/^function onPhoneClick\(ev\) \{/, '').replace(/\n  \}\n$/, '');
  const calls = [];
  const S = { barSwiped: false, longPressed: false, editing: false, switcherEl: null, phoneOpen: null };
  const stubs = { onVisitTap: () => calls.push('visit'), editTap: () => calls.push('edit'), phoneOpen: () => calls.push('open'), phoneHome: () => calls.push('home'), openSwitcher: () => calls.push('switcher'), closeSwitcher: () => calls.push('close'), openSearch: () => calls.push('search'), removeRecent: () => calls.push('remove'), paintSwitcher: () => calls.push('paintsw'), phonePaint: () => calls.push('paint'), save: () => calls.push('save'), safe: (f) => f(), W: {} };
  // eslint-disable-next-line no-new-func -- runs this repo's own source
  const run = new Function('S', 'ev', ...Object.keys(stubs), body);
  const mkEv = (attrs) => { const el = { getAttribute: (k) => attrs[k] == null ? null : attrs[k] }; const ev = { target: { closest: (sel) => (sel === '[data-osvisit]' && attrs['data-osvisit']) || (sel === '[data-osp]' && attrs['data-osp']) ? el : null }, stopped: false, prevented: false }; ev.stopPropagation = () => { ev.stopped = true; }; ev.preventDefault = () => { ev.prevented = true; }; return ev; };
  S.barSwiped = true;
  let ev = mkEv({ 'data-osvisit': 'record', 'data-nbd-record-visit': '' });
  run(S, ev, ...Object.values(stubs));
  ok('after a long-press on Record: no visit tap, the click is stopped and the flag is consumed', calls.length === 0 && ev.stopped && ev.prevented && S.barSwiped === false, calls.join() + ' stopped=' + ev.stopped);
  ev = mkEv({ 'data-osvisit': 'record' });
  run(S, ev, ...Object.values(stubs));
  ok('the next plain tap on Record reaches the visit handler and is not stopped (the recorder delegate gets it)', calls.join() === 'visit' && !ev.stopped, calls.join());
  S.barSwiped = true;
  ev = mkEv({});
  run(S, ev, ...Object.values(stubs));
  ok('a long-press on bar padding: the flag is consumed by the release click even though nothing was tapped', S.barSwiped === false && ev.stopped);
  ev = mkEv({ 'data-osp': 'home' });
  run(S, ev, ...Object.values(stubs));
  ok('...and the following Home tap works', calls.slice(-1)[0] === 'home');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
