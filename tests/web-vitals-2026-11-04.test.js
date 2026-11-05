/**
 * tests/web-vitals-2026-11-04.test.js — real-visitor speed measurement (2026-11-04).
 *
 * 1. docs/assets/js/web-vitals.js (public site → GA4), run for real in a vm with a fake PerformanceObserver:
 *    LCP is the last candidate before the first input; CLS is the largest session window (and 0 when nothing shifts);
 *    INP is the slowest interaction; a prerendered page is timed from activationStart; every event is rated,
 *    tagged phone/desktop and non_interaction; it sends once, on the first hide; it never throws when the APIs or
 *    gtag are missing.
 * 2. Wiring: the three GA init files load it, so it rides every GA page without a tag of its own.
 * 3. docs/pro/js/sentry-init.js (CRM → Sentry), run for real against a fake Sentry SDK: a tracing integration is
 *    on, page loads are sampled at 100 % and everything else at 5 %, no trace headers are added to any request, and a
 *    transaction loses its query strings before it leaves.
 *
 * Zero deps. Run: node tests/web-vitals-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const VITALS = read('docs/assets/js/web-vitals.js');

function run(opts = {}) {
  const observers = {};
  const listeners = {};
  const events = [];
  function PO(cb) { this.cb = cb; }
  PO.prototype.observe = function (o) { observers[o.type] = this; };
  PO.prototype.disconnect = function () { this.off = true; };
  PO.prototype.takeRecords = function () { return []; };
  const emit = (type, entries) => { const o = observers[type]; if (o && !o.off) o.cb({ getEntries: () => entries }); };
  const doc = { visibilityState: 'visible' };
  const win = {
    innerWidth: opts.width || 390,
    gtag: opts.noGtag ? undefined : function (kind, name, params) { if (kind === 'event') events.push({ name, ...params }); },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
  };
  const ctx = vm.createContext({
    window: win, document: doc, addEventListener: win.addEventListener,
    PerformanceObserver: opts.noPO ? undefined : PO,
    performance: { getEntriesByType: (t) => (t === 'navigation' ? [{ responseStart: opts.ttfb || 300, activationStart: opts.activation || 0 }] : []) },
    Math, Date, isFinite, Object,
  });
  win.window = win;
  vm.runInContext(VITALS, ctx);
  const fire = (t) => (listeners[t] || []).slice().forEach((f) => f());
  const hide = () => { doc.visibilityState = 'hidden'; fire('visibilitychange'); };
  return { emit, fire, hide, events, win };
}
const by = (events) => Object.fromEntries(events.map((e) => [e.name, e]));

console.log('\n1. web-vitals.js');
{
  const r = run({ width: 390 });
  r.emit('paint', [{ name: 'first-contentful-paint', startTime: 900 }]);
  r.emit('largest-contentful-paint', [{ startTime: 1200 }]);
  r.emit('largest-contentful-paint', [{ startTime: 2700 }]);
  r.fire('pointerdown');                                                // LCP stops here
  r.emit('largest-contentful-paint', [{ startTime: 9000 }]);           // ignored: after the first input
  r.emit('layout-shift', [{ value: 0.05, startTime: 1000 }, { value: 0.04, startTime: 1500 }]); // window 1 = 0.09
  r.emit('layout-shift', [{ value: 0.2, startTime: 9000, hadRecentInput: true }]);               // ignored
  r.emit('layout-shift', [{ value: 0.03, startTime: 4000 }]);                                     // new window 0.03
  r.emit('event', [{ interactionId: 1, duration: 120 }, { interactionId: 2, duration: 560 }, { interactionId: 0, duration: 900 }]);
  r.hide();
  const e = by(r.events);
  ok('POSITIVE CONTROL: five metrics are sent on hide', ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'].every((k) => e[k]), Object.keys(e).join(','));
  ok('LCP is the last candidate before the first input (2700, not 9000)', e.LCP && e.LCP.value === 2700 && e.LCP.metric_rating === 'needs-improvement', JSON.stringify(e.LCP));
  ok('CLS is the largest session window, ignoring shifts after input (0.09 → value 90)', e.CLS && e.CLS.value === 90 && e.CLS.metric_value === 0.09 && e.CLS.metric_rating === 'good', JSON.stringify(e.CLS));
  ok('INP is the slowest real interaction (560 ms → poor; interactionId 0 ignored)', e.INP && e.INP.value === 560 && e.INP.metric_rating === 'poor', JSON.stringify(e.INP));
  ok('FCP and TTFB are rated', e.FCP.value === 900 && e.FCP.metric_rating === 'good' && e.TTFB.value === 300 && e.TTFB.metric_rating === 'good');
  ok('every event is non_interaction, tagged phone, and shares one metric_id', r.events.every((x) => x.non_interaction === true && x.device === 'phone' && x.metric_id === r.events[0].metric_id));
  r.hide(); r.fire('pagehide');
  ok('it sends once (a second hide / pagehide adds nothing)', r.events.length === 5, String(r.events.length));
}
{
  const r = run({ width: 1280, activation: 1000, ttfb: 1100 });
  r.emit('paint', [{ name: 'first-contentful-paint', startTime: 1400 }]);
  r.emit('largest-contentful-paint', [{ startTime: 1600 }]);
  r.fire('pagehide');
  const e = by(r.events);
  ok('a prerendered page is timed from activationStart (FCP 400, LCP 600, TTFB 100)', e.FCP.value === 400 && e.LCP.value === 600 && e.TTFB.value === 100, JSON.stringify([e.FCP, e.LCP, e.TTFB].map((x) => x && x.value)));
  ok('a page that never shifts sends CLS 0; wide screens are "desktop"', e.CLS && e.CLS.value === 0 && e.CLS.device === 'desktop');
}
{
  let threw = false;
  try { const r = run({ noPO: true }); r.hide(); ok('no PerformanceObserver → nothing sent', r.events.length === 0); } catch (e) { threw = true; }
  try { const r = run({ noGtag: true }); r.hide(); } catch (e) { threw = true; }
  ok('never throws when the APIs or gtag are missing', !threw);
}

console.log('\n2. wiring');
for (const f of ['docs/assets/js/inline/2a90205f1b.js', 'docs/assets/js/inline/57b8cb69f9.js', 'docs/assets/js/storm-check-ga.js']) {
  const t = read(f);
  ok(`${f.split('/').pop()} still configures GA4 and loads web-vitals.js`, t.includes('G-8PG7N9Q3DL') && /src\s*=\s*'\/assets\/js\/web-vitals\.js\?v=\d+'/.test(t));
}

console.log('\n3. sentry-init.js (CRM)');
{
  let opts = null;
  const doc = {
    createElement: () => { const el = {}; return el; },
    head: { appendChild(el) { el.onload && el.onload(); } },
  };
  const Sentry = {
    browserTracingIntegration: () => ({ name: 'BrowserTracing' }),
    init: (o) => { opts = o; },
    setUser() {}, setTag() {},
  };
  const win = { __NBD_SENTRY_DSN: 'https://x@o1.ingest.us.sentry.io/1', __NBD_RELEASE: 'web@test', Sentry };
  win.window = win;
  const ctx = vm.createContext({ window: win, document: doc, location: { hostname: 'nobigdealwithjoedeal.com' }, console: { warn() {}, log() {} }, setInterval: () => 0, clearInterval() {} });
  vm.runInContext(read('docs/pro/js/sentry-init.js'), ctx);
  ok('POSITIVE CONTROL: Sentry.init ran', !!opts);
  ok('a browser tracing integration is turned on', opts && Array.isArray(opts.integrations) && opts.integrations.some((i) => i && i.name === 'BrowserTracing'));
  ok('page loads are sampled at 100 %, everything else at 5 %', opts && opts.tracesSampler({ transactionContext: { op: 'pageload' } }) === 1 && opts.tracesSampler({ transactionContext: { op: 'navigation' } }) === 0.05);
  ok('no trace headers are added to any request', opts && Array.isArray(opts.tracePropagationTargets) && opts.tracePropagationTargets.length === 0);
  const tx = opts.beforeSendTransaction({ transaction: '/pro/customer?id=ABC', request: { url: 'https://nobigdealwithjoedeal.com/pro/customer?id=ABC#x' }, spans: [{ description: 'GET /api/x?token=T', data: { url: '/api/x?token=T' } }] });
  ok('a transaction loses its query strings before it leaves', !JSON.stringify(tx).includes('?') && !JSON.stringify(tx).includes('ABC') && !JSON.stringify(tx).includes('token'), JSON.stringify(tx));
  ok('the existing error scrubber (beforeSend) is still there', typeof opts.beforeSend === 'function');
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
