/**
 * tests/push-notification-actions.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Two bugs, both silent, both found on 2026-09-05 while adding action buttons:
 *
 * 1. docs/pro/firebase-messaging-sw.js's notificationclick handler never
 *    looked at `event.action`. getNotificationActions had been declaring a
 *    "Dismiss" button since it shipped, and pressing it NAVIGATED, exactly
 *    like tapping the notification body.
 *
 * 2. The same handler called `client.navigate(clickUrl)`. This worker is
 *    registered at scope '/pro/firebase-cloud-messaging-push-scope' —
 *    deliberately NOT '/pro/', which sw.js owns (push-registration.js:11,46).
 *    A worker may only navigate clients its own registration controls, so the
 *    call ALWAYS rejected: with the CRM already open, tapping a push did
 *    nothing whatsoever, and the rejection died inside waitUntil where nobody
 *    would ever see it.
 *
 * Neither had a test, and neither produces an error a user could report — the
 * notification just sits there. So the decision is now a pure function and
 * every branch is pinned here, along with the invariant that the worker's
 * button list and the server's stay identical (they are rendered by different
 * things depending on the push, and drift means the same alert shows different
 * buttons).
 *
 * Pure Node — the worker is loaded in a vm with stubbed service-worker
 * globals. Run: node tests/push-notification-actions.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// Strip LINE comments FIRST, then block comments — not the other way round.
// push-functions.js contains the line comment "// /pro/images/* does NOT
// exist"; that `/*` opens a fake block comment for the usual
// block-then-line stripper, which then swallows ~20 lines of real code up to
// the next `*/`. Assertions over the result silently pass or fail on text that
// was never a comment. (Found 2026-09-05 while writing this file.)
const codeOnly = (s) => s.replace(/^\s*\/\/.*$/mg, '').replace(/\/\*[\s\S]*?\*\//g, '');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Load the service worker with service-worker globals stubbed ──────────
const SW_PATH = path.join(ROOT, 'docs', 'pro', 'firebase-messaging-sw.js');
const swSrc = fs.readFileSync(SW_PATH, 'utf8');

const listeners = {};
const sandbox = {
  importScripts() {},                       // gstatic imports — no network in a test
  firebase: {
    initializeApp() {},
    messaging: () => ({ onBackgroundMessage() {} }),
  },
  console: { log() {}, warn() {}, error() {} },
  clients: {},                              // replaced per-case below
  JSON, String, Object, Array, Promise, Date, RegExp, Error,
};
sandbox.self = {
  addEventListener: (ev, fn) => { listeners[ev] = fn; },
  registration: { showNotification() {} },
  skipWaiting() {},
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(swSrc, sandbox, { filename: 'firebase-messaging-sw.js' });

const resolve = sandbox.resolveNotificationAction;
const swActions = sandbox.getNotificationActions;

console.log('\nLOADS');
ok('the worker evaluates outside a service-worker runtime', typeof resolve === 'function');
ok('it registered a notificationclick handler', typeof listeners.notificationclick === 'function');
ok('getNotificationActions is present', typeof swActions === 'function');

console.log('\nTHE DECISION — every branch of a notification tap');
{
  const data = { clickUrl: '/pro/dashboard.html?tab=leads&leadId=L1', leadId: 'L1', phone: '(513) 555-1234' };

  ok('tapping the BODY navigates to the click URL',
     same(resolve('', data), { kind: 'navigate', url: data.clickUrl }));
  ok('"view" navigates the same way',
     same(resolve('view', data), { kind: 'navigate', url: data.clickUrl }));

  // Bug 1. Before this fix, "Dismiss" navigated.
  ok('"dismiss" closes and does NOTHING else', same(resolve('dismiss', data), { kind: 'close' }));

  const call = resolve('call', data);
  ok('"call" dials the lead', call.kind === 'call');
  ok('...with punctuation stripped from the number', call.phone === '5135551234');
  ok('...and keeps the lead URL as its fallback', call.url === data.clickUrl);
  ok('"call" with no phone on the payload opens the lead rather than doing nothing',
     same(resolve('call', { clickUrl: '/pro/x' }), { kind: 'navigate', url: '/pro/x' }));
  ok('a phone in +E.164 form survives', resolve('call', { phone: '+15135551234' }).phone === '+15135551234');

  const snooze = resolve('snooze', data);
  ok('"snooze" carries the lead id (the worker has no auth session to write with)',
     snooze.kind === 'snooze' && snooze.leadId === 'L1');

  ok('an unknown action falls back to navigating, never to nothing',
     same(resolve('somethingNew', data), { kind: 'navigate', url: data.clickUrl }));
  ok('missing data still yields a usable default',
     same(resolve('', undefined), { kind: 'navigate', url: '/pro/dashboard.html' }));
}

(async () => {
console.log('\nTHE HANDLER — never client.navigate(), because it always rejects here');
{
  const src = codeOnly(swSrc);
  // Bug 2, pinned at the source: this worker's scope is not the app's scope,
  // so navigate() on an app window can only ever reject.
  ok('client.navigate is gone from the worker entirely', !/\.navigate\s*\(/.test(src));
  ok('an open window is asked to route itself by postMessage', /postMessage\(\{/.test(src) && /NBD_PUSH_ACTION/.test(src));
  ok('a closed app is handled with openWindow (which is scope-safe)', /clients\.openWindow\(/.test(src));

  // Drive the real handler with a fake clients registry.
  async function click(action, data, windows) {
    const calls = { opened: [], posted: [], focused: 0 };
    sandbox.clients = {
      matchAll: async () => (windows || []).map((url) => ({
        url,
        focus: async () => { calls.focused++; },
        postMessage: (m) => calls.posted.push(m),
      })),
      openWindow: async (u) => { calls.opened.push(u); return { url: u }; },
    };
    let waited = null;
    await listeners.notificationclick({
      action,
      notification: { data, close() { calls.closed = true; } },
      waitUntil: (p) => { waited = p; },
    });
    if (waited) await waited;
    return calls;
  }

  const D = { clickUrl: '/pro/dashboard.html?leadId=L1', leadId: 'L1', phone: '5135551234' };

  const openApp = await click('', D, ['https://x/pro/dashboard.html']);
  ok('the notification is always closed first', openApp.closed === true);
  ok('with the app open: it focuses and posts, and opens no new window',
     openApp.focused === 1 && openApp.opened.length === 0 && openApp.posted.length === 1);
  ok('...the message tells the page where to go',
     openApp.posted[0].type === 'NBD_PUSH_ACTION' && openApp.posted[0].action === 'navigate'
     && openApp.posted[0].url === D.clickUrl);

  const closedApp = await click('', D, []);
  ok('with nothing open: it opens the lead', same(closedApp.opened, [D.clickUrl]));

  const dismissed = await click('dismiss', D, ['https://x/pro/dashboard.html']);
  ok('"dismiss" opens nothing and posts nothing',
     dismissed.opened.length === 0 && dismissed.posted.length === 0 && dismissed.closed === true);

  const called = await click('call', D, ['https://x/pro/dashboard.html']);
  ok('"call" opens a tel: URL even when the app is already open',
     called.opened[0] === 'tel:5135551234');

  const snoozedOpen = await click('snooze', D, ['https://x/pro/dashboard.html']);
  ok('"snooze" with the app open hands the lead id to the page',
     snoozedOpen.posted[0].action === 'snooze' && snoozedOpen.posted[0].leadId === 'L1');
  const snoozedClosed = await click('snooze', D, []);
  ok('"snooze" with nothing open carries the intent in the URL',
     /pushAction=snooze/.test(snoozedClosed.opened[0]));
  ok('...appended with & when the URL already has a query',
     snoozedClosed.opened[0].indexOf('?leadId=L1&pushAction=snooze') > 0);

  // A window that is not the CRM must not be hijacked.
  const otherSite = await click('', D, ['https://example.com/other']);
  ok('a non-/pro/ window is ignored, and a new one is opened instead',
     otherSite.posted.length === 0 && same(otherSite.opened, [D.clickUrl]));

  // focus() rejecting must not swallow the whole click.
  sandbox.clients = {
    matchAll: async () => [{
      url: 'https://x/pro/dashboard.html',
      focus: async () => { throw new Error('not allowed'); },
      postMessage: (m) => { sandbox.__posted = m; },
    }],
    openWindow: async () => null,
  };
  let waited2 = null;
  await listeners.notificationclick({
    action: '', notification: { data: D, close() {} }, waitUntil: (p) => { waited2 = p; },
  });
  await waited2;
  ok('a rejected focus() still delivers the message (it is advisory)',
     sandbox.__posted && sandbox.__posted.action === 'navigate');
}

console.log('\nBUTTON LISTS — worker and server must not drift');
{
  // Requiring push-functions runs getFirestore() at module load.
  // push-functions.js calls getFirestore() at module load, so an app must
  // exist first. `admin.apps` was REMOVED in firebase-admin v12+ (the same
  // accessor removal that broke two scripts on 2026-09-01), so initialize
  // defensively rather than probing for it.
  const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
  try { admin.initializeApp({ projectId: 'demo-nbd' }); }
  catch (e) { /* already initialized — fine */ }
  const push = require(path.join(ROOT, 'functions', 'push-functions.js'));
  const serverActions = push.notificationActionsFor;
  ok('the server exports its action list', typeof serverActions === 'function');

  for (const type of ['newLead', 'appointmentReminder', 'followUpDue', 'claimUpdate', 'teamActivity', undefined]) {
    ok('worker and server agree for ' + (type || '(default)'),
       same(swActions(type), serverActions(type)),
       JSON.stringify({ sw: swActions(type), server: serverActions(type) }));
  }

  const nl = serverActions('newLead');
  ok('a new lead offers Call first — the roofer\'s actual first move',
     nl[0].action === 'call' && nl[0].title === 'Call');
  ok('every action has both an id and a visible title',
     [].concat(nl, serverActions('followUpDue'), serverActions('x'))
       .every((a) => a.action && a.title));
  // Chrome renders at most two on most surfaces, but declaring three is legal
  // and degrades by truncation rather than by breaking.
  ok('no list exceeds three buttons',
     [nl, serverActions('followUpDue'), serverActions('x')].every((l) => l.length <= 3));
}

console.log('\nSERVER PAYLOAD — the parts a wrong value makes silently fail');
{
  // The server half of this block was five regexes over
  // functions/push-functions.js, and each could pass with its behaviour
  // broken. One did: /phone: String\(leadData\.phone/ matched the line whose
  // `[^d+]` deleted every digit from the Call button's number (#1541). The rest
  // match text the same way — `data: { ...stringData, ...data }` still counts
  // two spreads while sending the raw undefineds, and
  // `actions: notificationActionsFor(data.type)` matches whichever object of
  // the message it is written in.
  //
  // tests/push-lead-call-phone.test.js is the gate now. It runs onNewLead and
  // sendCustomNotification with Firestore and FCM stubbed, validates what they
  // send with firebase-admin's own validateMessage, and checks the message:
  // the Call number, string coercion in both data blocks, null/undefined
  // dropped, and the buttons on webpush.notification. This assertion only
  // keeps that pointer from rotting into a comment about a file CI never runs.
  const payloadGate = 'push-lead-call-phone.test.js';
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'ci-manifest.json'), 'utf8'));
  ok('the server payload is gated by executing it (' + payloadGate + ', in the node bucket)',
     fs.existsSync(path.join(__dirname, payloadGate)) && (manifest.node || []).includes(payloadGate));

  const reg = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'push-registration.js'), 'utf8');
  ok('the worker is still registered off the app scope (the reason navigate() fails)',
     /SW_SCOPE = '\/pro\/firebase-cloud-messaging-push-scope'/.test(reg));

  const dash = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  ok('the bridge is loaded by the dashboard with defer',
     /<script defer src="js\/push-actions\.js/.test(dash));
}

console.log('\nTHE PAGE BRIDGE — a tap may only ever land inside this app');
{
  // This was two regexes over push-actions.js. The origin one was
  // /location\.origin/ || ..., which passes if that text appears anywhere in
  // the file, whether or not safePath() runs before location.assign — the same
  // shape that let #1541's digit-deleting phone regex pass. So the bridge is
  // run instead: loaded in a vm, handed the message the worker posts, and
  // judged by what it did to window.location.
  //
  // It listens on navigator.serviceWorker, which only delivers messages from a
  // service worker of this origin, so there is no event.origin check to test.
  // The URL inside the message is the untrusted part, and safePath() is the
  // only thing between it and location.assign.
  const ORIGIN = 'https://nobigdealwithjoedeal.com';
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'push-actions.js'), 'utf8');
  const rec = { assigned: [], opened: [], snoozed: [] };
  const swListeners = {};
  const winListeners = {};
  const on = (bag) => (ev, fn) => { (bag[ev] = bag[ev] || []).push(fn); };
  const win = {
    location: {
      origin: ORIGIN, pathname: '/pro/dashboard.html', search: '', hash: '',
      assign: (u) => { rec.assigned.push(u); },
    },
    history: { replaceState() {} },
    addEventListener: on(winListeners),
    showToast() {},
    openCardDetailModal: (id) => { rec.opened.push(id); },
    // The app's real snooze API (lead-snooze.js). window.snoozeLead, which
    // this stub used to provide, never existed in the app (2026-10-03).
    db: {},
    LeadSnooze: { snooze: async (id) => { rec.snoozed.push(id); } },
  };
  const ctx = {
    window: win,
    navigator: { serviceWorker: { addEventListener: on(swListeners) } },
    // Node globals, not V8 builtins: a bare vm context has neither, and
    // safePath's try/catch would then reject every absolute URL for the wrong
    // reason. The same-origin absolute case below fails if that happens.
    URL, URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(bridgeSrc, ctx, { filename: 'push-actions.js' });

  const onMessage = (swListeners.message || [])[0];
  ok('the bridge listens for worker messages on navigator.serviceWorker',
     (swListeners.message || []).length === 1 && typeof onMessage === 'function');

  function tap(url) {
    rec.assigned.length = 0; rec.opened.length = 0;
    if (onMessage) onMessage({ data: { type: 'NBD_PUSH_ACTION', action: 'navigate', url } });
    return { assigned: rec.assigned.slice(), opened: rec.opened.slice() };
  }

  const inApp = tap('/pro/customer.html?leadId=L1');
  ok('an app path on another page navigates there',
     same(inApp.assigned, ['/pro/customer.html?leadId=L1']) && inApp.opened.length === 0,
     JSON.stringify(inApp));
  const absolute = tap(ORIGIN + '/pro/customer.html?leadId=L2#notes');
  ok('a same-origin absolute URL navigates by its path, not the full URL',
     same(absolute.assigned, ['/pro/customer.html?leadId=L2#notes']), JSON.stringify(absolute));

  for (const url of ['https://evil.example/pro/x', '//evil.example/pro/x', '/\\evil.example/pro/x', 'javascript:alert(1)']) {
    const r = tap(url);
    ok('refuses to navigate to ' + url, r.assigned.length === 0 && r.opened.length === 0, JSON.stringify(r));
  }
  const offApp = tap(ORIGIN + '/index.html');
  ok('refuses a same-origin page outside /pro/', offApp.assigned.length === 0, JSON.stringify(offApp));

  const samePage = tap('/pro/dashboard.html?leadId=L1');
  ok('the page already open opens the lead in place instead of reloading',
     same(samePage.opened, ['L1']) && samePage.assigned.length === 0, JSON.stringify(samePage));

  // Nothing should be listening on window: a window 'message' can come from
  // any origin that holds a reference to this tab, and a snooze is a Firestore
  // write. Passes trivially today, and fails if a listener moves there.
  rec.assigned.length = 0; rec.snoozed.length = 0;
  for (const fn of (winListeners.message || [])) {
    const from = { origin: 'https://evil.example', source: {} };
    fn({ ...from, data: { type: 'NBD_PUSH_ACTION', action: 'navigate', url: '/pro/customer.html?leadId=L9' } });
    fn({ ...from, data: { type: 'NBD_PUSH_ACTION', action: 'snooze', leadId: 'L9' } });
  }
  await new Promise((r) => setImmediate(r));   // a snooze lands after a microtask now
  ok('a window message from another origin neither navigates nor snoozes',
     rec.assigned.length === 0 && rec.snoozed.length === 0);
  if (onMessage) onMessage({ data: { type: 'NBD_PUSH_ACTION', action: 'snooze', leadId: 'L3' } });
  await new Promise((r) => setImmediate(r));   // snooze() awaits LeadSnooze readiness first
  ok('control: the same snooze from the worker does reach LeadSnooze.snooze', same(rec.snoozed, ['L3']));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error('test crashed:', e); process.exit(1); });
