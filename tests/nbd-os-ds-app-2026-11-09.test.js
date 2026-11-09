/**
 * tests/nbd-os-ds-app-2026-11-09.test.js - NBD OS P1 "Daily Success": the
 * tracker becomes an OS app (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md
 * §2 "Apps the sidebar can't express", §8 P1).
 *
 * Daily Success is a page of its own (/pro/daily-success/, X-Frame-Options
 * DENY, so never a window or an iframe). It joins the OS app list as a LINK
 * app (layouts/os-wm-logic.js LINK_APPS): a phone icon, a desktop icon, a
 * Start entry, pinnable to the taskbar and placeable in the phone dock. A tap
 * opens it in the same tab with window.open(href, '_self'), the call
 * widgets.js openDailyTracker makes and the demo's window.open wrapper remaps.
 * The member gets it only when the sidebar's own item (#nav-daily) passes
 * readNav's hidden test. The dock keeps its four defaults: Daily Success goes
 * there only when the member puts it there.
 *
 * Run: node tests/nbd-os-ds-app-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const WM = require(path.join(ROOT, 'docs/pro/js/layouts/os-wm-logic.js'));
const OS = noComments(read('docs/pro/js/layouts/os.js'));

/** A window with the sidebar's Success Tracker item (as dashboard.html has it), optionally hidden, and a saved OS session. */
function boot(opts) {
  const o = opts || {};
  const T = makeWin({ surface: o.surface || 'phone', home: { phone: [], desk: [] } });
  const W = T.W;
  if (o.nav !== false) {
    const n = T.document.createElement('div');
    n.setAttribute('id', 'nav-daily'); n.setAttribute('data-action', 'windowOpen'); n.setAttribute('data-target', '/pro/daily-success/');
    n.setAttribute('class', 'ni' + (o.navClass ? ' ' + o.navClass : ''));
    if (o.navAria) n.setAttribute('aria-hidden', 'true');
    T.document.querySelector('.sidebar').appendChild(n);
  }
  W.opened = [];
  W.open = (url, target) => { W.opened.push([url, target]); return null; };
  if (o.os) {
    const prefs = W.LayoutEngine.prefs;
    W.LayoutEngine.prefs = () => { const p = prefs(); p.user.layoutState.os = o.os; return p; };
  }
  W._impl.mount({ surface: o.surface === 'desktop' ? 'desktop' : 'phone' });
  return T;
}
const phoneIcon = (T, id) => T.document.querySelector('#osPhone .os-p-icon[data-id="' + id + '"]');
const dockBtn = (T, id) => T.document.querySelector('.os-bar .os-bar-btn[data-id="' + id + '"]');

console.log('\n1. the link-app list (pure)');
G(() => {
  ok('Daily Success is a link app with its own page and the sidebar item that gates it',
    J(WM.LINK_APPS) === J([{ id: 'daily-success', label: 'Daily Success', icon: '📅', nav: 'nav-daily', href: '/pro/daily-success/' }]), J(WM.LINK_APPS));
  ok('linkApps: shown -> the app (no nav field leaks into the app)', J(WM.linkApps(() => true)) === J([{ id: 'daily-success', label: 'Daily Success', icon: '📅', href: '/pro/daily-success/' }]));
  ok('linkApps: hidden, missing or no test -> none', J(WM.linkApps(() => false)) === '[]' && J(WM.linkApps()) === '[]' && J(WM.linkApps(() => 'yes')) === '[]');
  ok('the id is a valid OS app id (dock, icons and pins keep it)', /^[a-z][a-z0-9-]{0,31}$/.test(WM.LINK_APPS[0].id)
    && J(WM.normalizeState({ dock: ['daily-success'], icons: ['daily-success'], pins: ['daily-success'] }, ['daily-success']).dock) === J(['daily-success']));
});

console.log('\n2. phone: an icon that opens the tracker in the same tab');
G(() => {
  const T = boot();
  const icon = phoneIcon(T, 'daily-success');
  ok('a Daily Success icon on the home screen', !!icon && /Daily Success/.test(icon.textContent), T.document.querySelector('#osPhone') && T.document.querySelector('#osPhone').innerHTML.slice(0, 300));
  ok('...after the view apps', (() => { const all = T.document.querySelectorAll('#osPhone .os-p-icon'); return all.length > 1 && all[all.length - 1].getAttribute('data-id') === 'daily-success'; })());
  click(T.dom, icon);
  ok('a tap opens /pro/daily-success/ in the same tab (window.open _self, openDailyTracker\'s call)', J(T.W.opened) === J([['/pro/daily-success/', '_self']]), J(T.W.opened));
  ok('...and never routes a CRM view or opens an app screen', T.W.goTos.length === 0 && !T.document.documentElement.getAttribute('data-os-app'), J(T.W.goTos));
  ok('the dock keeps its defaults (four, and Daily Success is not pushed into it)', !dockBtn(T, 'daily-success') && T.document.querySelectorAll('.os-bar .os-bar-btn[data-id]').length === 4);
  ok('nothing read, nothing fetched', T.reads.length === 0, J(T.reads));
});

console.log('\n3. role gating: only when the sidebar item is shown');
G(() => {
  ok('no #nav-daily: no icon', !phoneIcon(boot({ nav: false }), 'daily-success'));
  ok('#nav-daily hidden by the customizer (.dn): no icon', !phoneIcon(boot({ navClass: 'dn' }), 'daily-success'));
  ok('#nav-daily aria-hidden: no icon', !phoneIcon(boot({ navAria: true }), 'daily-success'));
});

console.log('\n4. phone dock: the member can put it there');
G(() => {
  const T = boot({ os: { dock: ['daily-success', 'crm'] } });
  const b = dockBtn(T, 'daily-success');
  ok('a saved dock with Daily Success shows it', !!b);
  click(T.dom, b);
  ok('tapping it in the dock opens the tracker in the same tab', J(T.W.opened) === J([['/pro/daily-success/', '_self']]), J(T.W.opened));
  ok('it never lands in Recents (it is not an app screen)', T.document.querySelectorAll('.os-sw-card').length === 0);
});

console.log('\n5. desktop: icon, Start and a taskbar pin, never a window');
G(() => {
  const T = boot({ surface: 'desktop', os: { pins: ['daily-success'] } });
  const desk = T.document.getElementById('osDesk');
  const icon = desk && desk.querySelector('.os-icon[data-osapp="daily-success"]');
  ok('a desktop icon', !!icon && /Daily Success/.test(icon.textContent));
  click(T.dom, icon);
  ok('a click opens the tracker in the same tab', J(T.W.opened) === J([['/pro/daily-success/', '_self']]), J(T.W.opened));
  ok('...and builds no window (the page cannot be framed)', !desk.querySelector('.os-win[data-win="daily-success"]'));
  const task = desk.querySelector('[data-ostask="daily-success"]');
  ok('a pinned Daily Success shows on the taskbar', !!task);
  T.W.opened.length = 0;
  click(T.dom, task);
  ok('the pin opens it too', J(T.W.opened) === J([['/pro/daily-success/', '_self']]), J(T.W.opened));
  const startBtn = desk.querySelector('[data-osdo="start"]');
  if (startBtn) click(T.dom, startBtn);
  const row = desk.querySelector('.os-start-app[data-osapp="daily-success"]');
  ok('Start lists it', !!row);
  T.W.opened.length = 0;
  if (row) click(T.dom, row);
  ok('Start opens it', J(T.W.opened) === J([['/pro/daily-success/', '_self']]), J(T.W.opened));
});

console.log('\n6. the source');
G(() => {
  ok('os.js opens a link app with window.open(href, \'_self\'), never a new tab', /W\.open\(a\.href, '_self'\)/.test(OS) && !/_blank/.test(OS));
  ok('openWin and phoneOpen both hand a link app to openLink first', /function openWin\(id, opts\) \{\s*var o = opts \|\| \{\};\s*if \(openLink\(id\)\) return;/.test(OS)
    && /function phoneOpen\(id, opts\) \{\s*var o = opts \|\| \{\};\s*if \(S && openLink\(id\)\) return;/.test(OS));
  ok('the demo remaps /pro/daily-success/ for window.open (sample account stays in the sample)',
    /daily-success\(\\\/\(index\\\.html\)\?\)\?\$\//.test(read('docs/pro/js/demo-mode.js')) && /window\.open = function/.test(read('docs/pro/js/demo-mode.js')));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
