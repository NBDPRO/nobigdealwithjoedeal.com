/**
 * tests/notif-bell-merge.test.js — single-owner bell merge (2026-07-07).
 *
 * Exercises notif-bell.js after the fix that made it the SOLE renderer of
 * the header bell and UNIONs two notification sources:
 *   - derived in-memory nags   (window._leads / _taskCache / _estimates,
 *                               read/dismiss state in localStorage)
 *   - server notifications      (window._notifications — the Firestore
 *                               `notifications` feed hydrated by
 *                               crm-snooze.js; read/dismiss state routed
 *                               back to Firestore via window.NBDServerNotifs)
 *
 * Regressions it guards:
 *   1. Server-written notifications (portal / referral / deal-accept /
 *      remote-sign / follow-up engine) were invisible in the opened
 *      dropdown AND unclearable, because notif-bell won the window
 *      bindings but never read window._notifications.
 *   2. The data-nb-action delegate lived in a sibling IIFE that could not
 *      see the `NotifBell` closure — every click threw ReferenceError, so
 *      row-click / × dismiss / inline action buttons were dead. The
 *      delegate now lives inside the module IIFE. This test drives the
 *      per-item actions THROUGH that delegate so the fix is covered.
 *
 * NotifBell is intentionally NOT on window (globals Tranche-0 guard). The
 * dropdown toggle is registry-only since the Tranche 3 map-graduate slice
 * (2026-09-02) — reached via __NBD_CALL_REGISTRY + the click delegate,
 * exactly as the dashboard's _nbdResolveMapped does; the two data-fn
 * handlers keep their window.* bindings.
 *
 * Zero deps. Run: node tests/notif-bell-merge.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

// ── Minimal mock DOM: registered elements by id, innerHTML captured ──
function makeEl() {
  return {
    innerHTML: '', textContent: '', style: {}, dataset: {},
    appendChild() {}, remove() {}, contains() { return false; },
    addEventListener() {}, removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    classList: { add() {}, remove() {}, contains() { return false; } },
  };
}
const els = {};
['notifList', 'notifDismissedList', 'notifDismissedToggle', 'dismissedCount',
 'notifBadge', 'clearAllNotifBtn', 'notifDropdown', 'notifBtn',
 'dismissedToggleLabel'].forEach(id => { els[id] = makeEl(); });

const _ls = {};
const localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
};

const _winHandlers = {};
const win = {
  addEventListener(type, fn) { (_winHandlers[type] = _winHandlers[type] || []).push(fn); },
  removeEventListener() {}, dispatchEvent() {},
  location: { href: '', pathname: '/pro/dashboard' },
};
win.window = win;
function fireWin(type) { (_winHandlers[type] || []).forEach(fn => { try { fn({ type }); } catch (e) {} }); }

// Capture the document 'click' delegate the module registers.
const clickHandlers = [];
const sandbox = {
  window: win,
  document: {
    addEventListener(type, fn) { if (type === 'click') clickHandlers.push(fn); },
    removeEventListener() {},
    getElementById: (id) => els[id] || null,
    querySelector() { return null; }, querySelectorAll() { return []; },
    createElement: () => makeEl(), body: makeEl(), readyState: 'complete',
  },
  localStorage,
  console: { log() {}, warn() {}, error() {} },
  // no-op timers so the deferred init()/setInterval never fire and never
  // keep the event loop alive — we drive render()/mutations directly.
  setTimeout: () => 0, clearTimeout: () => 0, setInterval: () => 0, clearInterval: () => 0,
  Date, Math, JSON, Object, Array, String, Number, Set, Map, encodeURIComponent, Promise,
};

const src = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/notif-bell.js'), 'utf8');
vm.runInNewContext(src, sandbox, { filename: 'notif-bell.js' });

// Fire a synthetic click that the data-nb-action delegate will dispatch.
// `stop` mirrors the real markup: the × dismiss button carries
// data-nb-stop="1"; a row (handleClick) does not.
function clickAction(action, id, stop) {
  const node = {
    dataset: Object.assign({ nbAction: action, nbId: id }, stop ? { nbStop: '1' } : {}),
    closest(sel) {
      if (sel.indexOf('data-nb-stop-self') >= 0) return null;
      if (sel.indexOf('data-nb-action') >= 0) return node;
      return null;
    },
  };
  const ev = { target: node, stopPropagation() {} };
  clickHandlers.forEach(h => h(ev));
}

// ── Capture the Firestore persistence API notif-bell should call ──
const captured = { markRead: [], dismiss: [], markReadMany: [], dismissMany: [], restore: [] };
win.NBDServerNotifs = {
  markRead:     (id)  => { captured.markRead.push(id);      return Promise.resolve(); },
  dismiss:      (id)  => { captured.dismiss.push(id);       return Promise.resolve(); },
  restore:      (id)  => { captured.restore.push(id);       return Promise.resolve(); },
  markReadMany: (ids) => { captured.markReadMany.push(ids); return Promise.resolve(); },
  dismissMany:  (ids) => { captured.dismissMany.push(ids);  return Promise.resolve(); },
};

// ── Controlled data: 1 derived overdue task + 3 server notifs ──
const nowD = new Date();
win._leads = [
  { id: 'L1', firstName: 'Jane', lastName: 'Doe', phone: '555-1212', email: 'j@x.com',
    stage: 'contacted', updatedAt: nowD }, // recent → no stale-lead signal
];
win._taskCache = { L1: [{ id: 't1', text: 'Call Jane', dueDate: '2020-01-01', done: false }] }; // overdue
win._estimates = [];
win._notifications = [
  { id: 'srv1', userId: 'u', type: 'deal_accepted', leadId: 'L1', title: 'Deal accepted! 🎉',
    message: 'Jane accepted the PRO package', read: false, dismissed: false, priority: 'high', createdAt: nowD },
  { id: 'srv2', userId: 'u', type: 'referral_received', title: 'New referral!',
    message: 'Bob referred by a past customer', read: false, dismissed: false, createdAt: nowD },
  { id: 'srv3', userId: 'u', type: 'portal_message', title: 'Portal message',
    message: 'Old dismissed message', read: true, dismissed: true, createdAt: nowD },
];

console.log('NOTIF-BELL SINGLE-OWNER MERGE');
ok('captured the data-nb-action click delegate (no ReferenceError at load)', clickHandlers.length === 1);
ok('registers toggleNotificationDropdown in __NBD_CALL_REGISTRY, off window (Tranche 3)',
  win.__NBD_CALL_REGISTRY && typeof win.__NBD_CALL_REGISTRY.toggleNotificationDropdown === 'function'
    && typeof win.toggleNotificationDropdown === 'undefined');
ok('does NOT leak NotifBell onto window (Tranche-0 guard)', typeof win.NotifBell === 'undefined');

// ── Step 1: open the dropdown → render unions both sources ──
win.__NBD_CALL_REGISTRY.toggleNotificationDropdown();
const derivedTaskId = 'task:L1:t1';
ok('list shows derived overdue task', els.notifList.innerHTML.includes('Overdue task'));
ok('list shows server deal_accepted notif', els.notifList.innerHTML.includes('Deal accepted'));
ok('list shows server referral notif', els.notifList.innerHTML.includes('New referral'));
ok('dismissed server notif NOT in active list', !els.notifList.innerHTML.includes('Old dismissed message'));
ok('badge counts union unread (1 derived + 2 server = 3)', els.notifBadge.textContent === '3');
ok('badge visible', els.notifBadge.style.display === 'block');
ok('dismissed drawer toggle shown for the 1 dismissed server notif', els.notifDismissedToggle.style.display === 'block');
ok('dismissed count = (1)', els.dismissedCount.textContent === '(1)');
ok('dismissed drawer HTML holds the dismissed server notif', els.notifDismissedList.innerHTML.includes('Old dismissed message'));

// ── Step 2: dismiss ONE server notif THROUGH the delegate (× button) ──
clickAction('dismiss', 'server:srv2', true);
ok('delegate dispatched dismiss → NBDServerNotifs.dismiss with raw doc id', captured.dismiss.length === 1 && captured.dismiss[0] === 'srv2');
ok('dismissed server notif left the active list', !els.notifList.innerHTML.includes('New referral'));
ok('badge now 2 (derived + srv1)', els.notifBadge.textContent === '2');
ok('localStorage dismissed set NOT touched for a server item', localStorage.getItem('nbd_notif_dismissed_v1') === null);

// ── Step 3: mark all read → server via Firestore (explicit ids), derived via localStorage ──
win.markAllNotificationsRead();
ok('markAllRead persisted server unread via markReadMany', captured.markReadMany.length === 1);
ok('markReadMany got exactly the unread, non-dismissed server id [srv1]',
   JSON.stringify(captured.markReadMany[0]) === JSON.stringify(['srv1']));
ok('markReadMany did NOT include the dismissed srv2', !captured.markReadMany[0].includes('srv2'));
const readSet = JSON.parse(localStorage.getItem('nbd_notif_read_v1') || '[]');
ok('derived item read state persisted to localStorage', readSet.includes(derivedTaskId));
ok('badge hidden after mark-all-read (0 unread)', els.notifBadge.style.display === 'none');

// ── Step 4: clear all → dismiss remaining active across both sources ──
win.clearAllNotifications();
ok('clearAll persisted remaining active server ids via dismissMany', captured.dismissMany.length === 1);
ok('dismissMany got the still-active server id [srv1]',
   JSON.stringify(captured.dismissMany[0]) === JSON.stringify(['srv1']));
const dismSet = JSON.parse(localStorage.getItem('nbd_notif_dismissed_v1') || '[]');
ok('derived item dismissed state persisted to localStorage', dismSet.includes(derivedTaskId));
ok('active list empty → "All caught up"', els.notifList.innerHTML.includes('All caught up'));

// ── Step 5: row-click a server notif THROUGH the delegate → marks read + navigates ──
win._notifications = [
  { id: 'srv9', userId: 'u', type: 'remote_signature', leadId: 'L1', title: 'Document signed',
    message: 'A homeowner signed remotely', read: false, dismissed: false, priority: 'high', createdAt: nowD },
];
fireWin('nbd:data-refreshed'); // module binds this to invalidateNotifCache
clickAction('handleClick', 'server:srv9', false);
ok('delegate dispatched handleClick → NBDServerNotifs.markRead(srv9)', captured.markRead.includes('srv9'));
ok('handleClick navigated to the lead deep-link', /tab=crm&lead=L1/.test(win.location.href));

// ── Step 6: restore a dismissed SERVER notif from the drawer (↩) ──
win._taskCache = {}; // isolate: no derived items this step
win._notifications = [
  { id: 'srvD', userId: 'u', type: 'portal_message', leadId: 'L1', title: 'Dismissed pending',
    message: 'was dismissed', read: true, dismissed: true, createdAt: nowD },
];
fireWin('nbd:data-refreshed');
clickAction('restore', 'server:srvD', true);
ok('delegate dispatched restore → NBDServerNotifs.restore(srvD)', captured.restore.includes('srvD'));
ok('restored server notif is back in the ACTIVE list', els.notifList.innerHTML.includes('Dismissed pending'));
ok('restored server notif returns UNREAD (badge = 1)', els.notifBadge.textContent === '1');

// ── Step 7: restore a dismissed DERIVED nag (localStorage) ──
// derivedTaskId was dismissed in Step 4; bring the overdue task back.
win._notifications = [];
win._taskCache = { L1: [{ id: 't1', text: 'Call Jane', dueDate: '2020-01-01', done: false }] };
fireWin('nbd:data-refreshed');
ok('derived nag currently dismissed (in drawer)',
   JSON.parse(localStorage.getItem('nbd_notif_dismissed_v1') || '[]').includes(derivedTaskId));
clickAction('restore', derivedTaskId, true);
ok('restore removed derived item from localStorage dismissed set',
   !JSON.parse(localStorage.getItem('nbd_notif_dismissed_v1') || '[]').includes(derivedTaskId));
ok('restored derived nag is back in the ACTIVE list', els.notifList.innerHTML.includes('Overdue task'));

// ── Step 8: same-lead follow_up suppresses redundant derived overdue/stale ──
// Isolate: clear localStorage read/dismissed so nothing else filters.
_ls['nbd_notif_read_v1'] = '[]'; _ls['nbd_notif_dismissed_v1'] = '[]';
const oldDate = new Date(2020, 0, 1); // stale-lead + overdue-task both fire
win._leads = [{ id: 'LX', firstName: 'Sam', lastName: 'Roe', stage: 'contacted', updatedAt: oldDate }];
win._taskCache = { LX: [{ id: 'tX', text: 'Call Sam', dueDate: '2020-01-01', done: false }] };
win._estimates = [];
// forceRender: dismissOne on a nonexistent id rebuilds + renders without mutating state.
const forceRender = () => { fireWin('nbd:data-refreshed'); clickAction('dismiss', '__none__', true); };

// 8a — WITH a same-lead server follow_up: derived rows suppressed, server survives.
win._notifications = [
  { id: 'srvF', userId: 'u', type: 'follow_up', leadId: 'LX', title: 'Overdue Follow-Up — Sam Roe',
    message: '2 days overdue', read: false, dismissed: false, createdAt: nowD },
];
forceRender();
ok('follow_up: server row shows', els.notifList.innerHTML.includes('Overdue Follow-Up — Sam Roe'));
ok('follow_up: derived overdue-task suppressed', !els.notifList.innerHTML.includes('Overdue task'));
ok('follow_up: derived stale-lead suppressed', !els.notifList.innerHTML.includes('going cold'));
ok('follow_up: badge = 1 (only the server follow_up)', els.notifBadge.textContent === '1');

// 8b — control: no follow_up → derived rows show as normal.
win._notifications = [];
forceRender();
ok('no follow_up: derived overdue-task shows', els.notifList.innerHTML.includes('Overdue task'));
ok('no follow_up: derived stale-lead shows', els.notifList.innerHTML.includes('going cold'));

// 8c — a dismissed follow_up does NOT suppress (it's not in the active list anyway).
win._notifications = [
  { id: 'srvFd', userId: 'u', type: 'follow_up', leadId: 'LX', title: 'Overdue Follow-Up — Sam Roe',
    message: 'was dismissed', read: true, dismissed: true, createdAt: nowD },
];
forceRender();
ok('dismissed follow_up does NOT suppress derived overdue-task', els.notifList.innerHTML.includes('Overdue task'));

// 8d — fresh-view (distinct signal) survives even with a same-lead follow_up.
win._estimates = [{ id: 'eX', leadId: 'LX', total: 5000, viewedAt: new Date(Date.now() - 60 * 60 * 1000) }];
win._notifications = [
  { id: 'srvF2', userId: 'u', type: 'follow_up', leadId: 'LX', title: 'Overdue Follow-Up — Sam Roe',
    message: '2 days overdue', read: false, dismissed: false, createdAt: nowD },
];
forceRender();
ok('fresh-view NOT suppressed by follow_up', els.notifList.innerHTML.includes('Customer viewing your estimate'));

// ── Step 9: duplicate follow_up docs collapse to ONE row per lead (2026-10-03) ──
// The follow-up engine once wrote a doc per lead per LOAD — 18,169 follow_up
// docs across 89 leads in the owner tenant, so the bell + badge counted docs,
// not people. The writer is fixed (crm-snooze.js deterministic ids), but the
// old docs remain, so the bell collapses per (type, lead) as defence in depth.
{
  _ls['nbd_notif_read_v1'] = '[]'; _ls['nbd_notif_dismissed_v1'] = '[]';
  win._leads = [{ id: 'LX', firstName: 'Sam', lastName: 'Roe', stage: 'contacted', updatedAt: nowD }];
  win._taskCache = {}; win._estimates = [];
  const at = (minsAgo) => new Date(Date.now() - minsAgo * 60000);
  const fu = (id, lead, mins, extra) => Object.assign({ id, userId: 'u', type: 'follow_up', leadId: lead,
    title: 'Overdue Follow-Up — ' + lead, message: 'overdue', read: false, dismissed: false, createdAt: at(mins) }, extra || {});
  win._notifications = [
    fu('x1', 'LX', 1), fu('x2', 'LX', 5), fu('x3', 'LX', 9), fu('x4', 'LX', 60), fu('x5', 'LX', 600),
    fu('y1', 'LY', 2), fu('y2', 'LY', 30), fu('y3', 'LY', 90, { read: true }),
    { id: 'n1', userId: 'u', type: 'needs_field', leadId: 'LX', title: 'Needs carrier — Sam', message: 'm', read: false, createdAt: at(3) },
    { id: 'n2', userId: 'u', type: 'needs_field', leadId: 'LX', title: 'Needs carrier — Sam', message: 'm', read: false, createdAt: at(4) },
  ];
  captured.markRead.length = 0; captured.markReadMany.length = 0; captured.dismissMany.length = 0; captured.dismiss.length = 0;
  forceRender();
  const rowsFor = (t) => els.notifList.innerHTML.split(t).length - 1;
  ok('collapse: 5 follow_up docs for one lead render ONE row', rowsFor('Overdue Follow-Up — LX') === 1);
  ok('collapse: 3 follow_up docs for another lead render ONE row', rowsFor('Overdue Follow-Up — LY') === 1);
  ok('collapse: needs_field dupes collapse too', rowsFor('Needs carrier — Sam') === 1);
  ok('collapse: badge counts people per nag type (LX fu + LY fu + LX nf = 3), not 9 docs',
    els.notifBadge.textContent === '3', 'badge=' + els.notifBadge.textContent);

  // Opening the collapsed row marks EVERY doc it stands for read.
  clickAction('handleClick', 'server:x1', false);
  const many = captured.markReadMany[captured.markReadMany.length - 1] || [];
  ok('collapse: opening the row marks all 5 LX follow_up docs read (one markReadMany)',
    many.length === 5 && ['x1', 'x2', 'x3', 'x4', 'x5'].every((id) => many.includes(id)), JSON.stringify(many));
  forceRender();
  ok('collapse: badge drops by one person (3 → 2)', els.notifBadge.textContent === '2', 'badge=' + els.notifBadge.textContent);

  // Dismissing a collapsed row dismisses every doc behind it.
  clickAction('dismiss', 'server:y1', true);
  const dm = captured.dismissMany[captured.dismissMany.length - 1] || [];
  ok('collapse: dismissing the LY row dismisses all 3 LY docs', dm.length === 3 && ['y1', 'y2', 'y3'].every((id) => dm.includes(id)), JSON.stringify(dm));

  // Mark-all-read reaches the hidden duplicates too.
  win._notifications.forEach((n) => { if (n.leadId === 'LX' && n.type === 'needs_field') n.read = false; });
  captured.markReadMany.length = 0;
  forceRender();
  win.markAllNotificationsRead();
  const all = captured.markReadMany[0] || [];
  ok('collapse: mark-all-read includes the collapsed needs_field duplicate', all.includes('n1') && all.includes('n2'), JSON.stringify(all));

  // A non-nag type is never collapsed (two portal messages are two messages).
  win._notifications = [
    { id: 'p1', userId: 'u', type: 'portal_message', leadId: 'LX', title: 'Portal msg A', message: 'a', read: false, createdAt: at(1) },
    { id: 'p2', userId: 'u', type: 'portal_message', leadId: 'LX', title: 'Portal msg B', message: 'b', read: false, createdAt: at(2) },
  ];
  forceRender();
  ok('collapse: other types are NOT collapsed', els.notifList.innerHTML.includes('Portal msg A') && els.notifList.innerHTML.includes('Portal msg B'));
}

// ── the notification poll must not fight the live listener ───────────────
// loadNotifications establishes an onSnapshot subscription, and a
// setInterval(loadNotifications, 120000) re-ran it every two minutes — which
// tore that listener down and re-subscribed, re-reading the whole 50-document
// query from the server. A billed read set and a radio wake every two
// minutes, forever, on a phone in a truck, to learn what the listener had
// already pushed.
//
// The poll now exists only for the two states with no live listener: an SDK
// without onSnapshot, and a listener that errored. Both must turn it back on,
// or the badge silently stops updating — which is why the error path is
// asserted as carefully as the happy one.
{
  const snoozeSrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'docs/pro/js/crm-snooze.js'), 'utf8');

  ok('a live subscription stops the poll',
    /_notifLive = true;\s*\n\s*_stopNotifPoll\(\);/.test(snoozeSrc));

  ok('the poll refuses to start while a listener is live',
    /if \(_notifInterval \|\| _notifLive\) return;/.test(snoozeSrc));

  ok('a listener error restarts the poll',
    /_notifLive = false;\s*\n\s*_startNotifPoll\(\);/.test(snoozeSrc));

  ok('the poll is still armed before the listener is established',
    /_startNotifPoll\(\);\s*\n\s*loadNotifications\(\);/.test(snoozeSrc),
    'a failure before subscribing would otherwise leave the badge frozen');

  ok('sign-out stops the poll and clears the live flag',
    /nbd:auth-signed-out[\s\S]{0,200}_stopNotifPoll\(\);[\s\S]{0,80}_notifLive = false/.test(snoozeSrc),
    'a re-auth as a different user must re-arm the poll');

  ok('pagehide still stops the poll',
    /'pagehide'[\s\S]{0,120}_stopNotifPoll\(\)/.test(snoozeSrc));

  ok('the raw 120s setInterval has exactly one site',
    (snoozeSrc.match(/setInterval\(loadNotifications, 120000\)/g) || []).length === 1,
    'two arming sites is how the leak this replaced came back');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:', fails.join(' | ')); process.exit(1); }
