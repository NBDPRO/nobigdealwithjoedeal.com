#!/usr/bin/env node
/**
 * tests/bottom-edge-queue-2026-11-19.test.js — one floating thing at the bottom
 * of the phone at a time (phone sweep 2026-11-19, PR A).
 *
 *   A. "Switch to Field App?" waits while a toast or the reminders card is up
 *   B. the reminders card also waits for a toast (it already waited for the banner)
 *   C. the field-tools dial shows on the D2D view only, not on the CRM list
 *   D. Capture inbox has a row in the More drawer (the dial's other tools keep a home)
 *
 * A and B run the shipped functions against a fake page.
 *
 * Run: node tests/bottom-edge-queue-2026-11-19.test.js
 */
const K = require('./lib/src-kit');

let failed = 0;
function check(name, ok) { console.log((ok ? 'ok   ' : 'FAIL ') + name); if (!ok) failed++; }

// ── A. layout offer: check() ──────────────────────────────────────────
const offerBody = K.sliceFn(K.read('docs/pro/js/layout-offer.js'), 'check');
function runOffer(o) {
  const c = { shown: 0, timers: [], selector: null, cleared: 0 };
  const doc = { querySelector: (s) => { c.selector = s; return o.blocked ? {} : null; } };
  const fn = new Function('decide', 'shown', 'banner', 'hide', 'show', 'doc', 'setTimeout', 'clearTimeout', 'waitT',
    offerBody + '; return check;')(
    () => ({ key: 'k', id: 'field' }), o.shown || null, o.shown ? { hidden: false } : null, () => {}, () => c.shown++, doc,
    (f, ms) => { c.timers.push(ms); return 1; }, () => c.cleared++, null);
  fn();
  return c;
}
check('A: nothing else up, the banner shows', (() => { const c = runOffer({}); return c.shown === 1 && c.timers.length === 0; })());
check('A: a toast or the reminders card is up, the banner waits and asks again in 3 s', (() => { const c = runOffer({ blocked: true }); return c.shown === 0 && c.timers.join() === '3000' && /toastContainer \.toast/.test(c.selector) && /nbd-push-optin/.test(c.selector); })());
check('A: a banner already showing is left alone (no re-show, no timer)', (() => { const c = runOffer({ blocked: true, shown: { key: 'k', id: 'field' } }); return c.shown === 0 && c.timers.length === 0; })());

// ── B. reminders card: showWhenCalm ──────────────────────────────────
const pushBody = K.sliceFn(K.read('docs/pro/js/push-registration.js'), 'showWhenCalm');
check('B: the reminders card waits while a toast is up', (() => {
  let sel = '', shown = 0;
  const f = new Function('document', 'Date', 'setTimeout', 'showOptInCard', '_lastIn', pushBody + '; return showWhenCalm;')(
    { hidden: false, querySelector: (s) => { sel = s; return {}; } }, { now: () => 1020000 }, () => 1, () => shown++, 1000000);
  f(1000000);
  return shown === 0 && /#toastContainer \.toast/.test(sel);
})());

// ── C. field-tools dial gating ───────────────────────────────────────
const ui = K.read('docs/pro/js/dashboard-ui.js');
const toggle = (ui.match(/classList\.toggle\('show-field-tools',\s*([^)]*\)?)\)/) || [])[1] || '';
check('C: the dial flag follows the D2D / Map view, not the CRM view', /onMap/.test(toggle) && /onD2d/.test(toggle) && !/onCrm/.test(toggle));

// ── D. Capture inbox in More ─────────────────────────────────────────
const row = K.parseTags(K.read('docs/pro/dashboard.html')).$('#mm-captureinbox');
const at = (row && row.attrs) || {};
check('D: More has a Capture inbox row that opens NBDQuickCaptureInbox and closes the drawer', at['data-action'] === 'module' && at['data-target'] === 'NBDQuickCaptureInbox.open' && 'data-close-more' in at);

if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
