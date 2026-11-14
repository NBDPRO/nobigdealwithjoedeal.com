/**
 * safe-reload-on-deploy-2026-11-14.test.js — a deploy must not wipe work.
 *
 * Wave-1 phone finding #3: dashboard-sw-bootstrap.js (dashboard) and
 * offline-manager.js (customer page) both called location.reload() as soon
 * as a new service worker took over. The update check runs every 60 s, so a
 * deploy wiped a half-typed lead or note on a rep's phone and cut a live
 * voice note.
 *
 * This suite RUNS both real files in a VM with a small fake DOM, fires the
 * real SW signals (SW_UPDATE_AVAILABLE message, controllerchange) and checks
 * what happens to location.reload():
 *   - idle page            → reloads (the stale-code protection still works)
 *   - modal open           → no reload, a "tap to reload" bar instead
 *   - typed text in a field→ no reload
 *   - recording held       → no reload; release + page hidden → reloads
 *   - tapping the bar      → reloads
 *
 * Run: node tests/safe-reload-on-deploy-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SAFE = read('docs/pro/js/safe-reload.js');
const BOOT = read('docs/pro/js/dashboard-sw-bootstrap.js');
const OFFM = read('docs/pro/js/offline-manager.js');

// ── a fake DOM just big enough for these three files ────────────────────
function makeEl(tag, opts) {
  opts = opts || {};
  const listeners = {};
  const el = {
    tagName: String(tag).toUpperCase(), type: opts.type || '', value: opts.value || '',
    defaultValue: opts.defaultValue || '', isConnected: true, _visible: opts.visible !== false,
    _matches: opts.matches || [], children: [], style: {}, attrs: {}, textContent: '',
    isContentEditable: false, id: '', className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    getClientRects() { return this._visible && this.isConnected ? [{}] : []; },
    closest() { return null; },
    contains(x) { return x === el || el.children.includes(x); },
    appendChild(c) { el.children.push(c); c.isConnected = true; c.parentNode = el; return c; },
    removeChild(c) { el.children = el.children.filter((x) => x !== c); c.isConnected = false; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute(k, v) { el.attrs[k] = v; }, getAttribute(k) { return el.attrs[k]; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    _fire(t, ev) { (listeners[t] || []).forEach((fn) => fn(ev || {})); },
  };
  return el;
}

function makeEnv(pathname) {
  const docListeners = {}, winListeners = {}, swListeners = {};
  const modals = [];
  const body = makeEl('body');
  const reloads = [];
  const timers = [];
  const document = {
    body, documentElement: body, visibilityState: 'visible', readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => body.children.find((c) => c.id === id) || null,
    querySelector: () => null,
    querySelectorAll: (sel) => (/modal-bg/.test(sel) ? modals.filter((m) => m.isConnected) : []),
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener() {},
    head: makeEl('head'),
  };
  const sw = {
    controller: null,
    addEventListener(t, fn) { (swListeners[t] = swListeners[t] || []).push(fn); },
    register: () => Promise.resolve({ scope: '/pro/', update() {} }),
    getRegistrations: () => Promise.resolve([]),
  };
  const fakeIdb = {
    open() {
      const req = {};
      setImmediate(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => ({
            objectStore: () => {
              const r = {}; setImmediate(() => { r.result = 0; r.onsuccess && r.onsuccess(); });
              return { count: () => r, getAll: () => { const g = {}; setImmediate(() => { g.result = []; g.onsuccess && g.onsuccess(); }); return g; } };
            },
          }),
        };
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
  const window = {
    location: { pathname, search: '', reload: () => reloads.push(Date.now()) },
    addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  const ctx = {
    window, document, console: { log() {}, warn() {}, error() {}, info() {}, table() {} },
    navigator: { serviceWorker: sw, onLine: true },
    location: window.location, localStorage: window.localStorage,
    URLSearchParams, Set, Map, Promise, Date, JSON, Math, Object, Array, String, Error,
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    fetch: () => Promise.resolve({ ok: false }),
    indexedDB: fakeIdb, caches: { keys: () => Promise.resolve([]) },
  };
  // Stand-in for the browser's MediaRecorder: start/stop flip .state.
  function FakeRecorder() { this.state = 'inactive'; }
  FakeRecorder.prototype.start = function () { this.state = 'recording'; };
  FakeRecorder.prototype.stop = function () { this.state = 'inactive'; };
  ctx.MediaRecorder = FakeRecorder;
  window.MediaRecorder = FakeRecorder;
  window.window = window; window.document = document; window.navigator = ctx.navigator;
  vm.createContext(ctx);
  const env = {
    ctx, window, document, body, modals, reloads,
    run(src, name) { vm.runInContext(src, ctx, { filename: name }); },
    flushTimers() { while (timers.length) timers.shift()(); },
    fireSw(t, ev) { (swListeners[t] || []).forEach((fn) => fn(ev || {})); },
    fireWin(t, ev) { (winListeners[t] || []).forEach((fn) => fn(ev || {})); },
    fireDoc(t, ev) { (docListeners[t] || []).forEach((fn) => fn(ev || {})); },
    addModal(open) { const m = makeEl('div', { visible: open }); body.appendChild(m); modals.push(m); return m; },
    typeInto(el) { body.appendChild(el); env.fireDoc('input', { target: el }); },
    bar() { return body.children.find((c) => c.id === 'nbdUpdateBar'); },
  };
  return env;
}

const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }

async function dashboard(setup) {
  const env = makeEnv('/pro/dashboard.html');
  env.run(SAFE, 'safe-reload.js');
  env.run(BOOT, 'dashboard-sw-bootstrap.js');
  await settle();
  if (setup) setup(env);
  return env;
}

async function customerPage(setup) {
  const env = makeEnv('/pro/customer.html');
  env.run(SAFE, 'safe-reload.js');
  env.run(OFFM, 'offline-manager.js');
  await settle();
  if (setup) setup(env);
  return env;
}

(async function main() {
  console.log('\nsafe-reload-on-deploy — a new version never wipes work\n');

  // Positive control: an idle dashboard still reloads onto the new code.
  let env = await dashboard();
  env.fireSw('message', { data: { type: 'SW_UPDATE_AVAILABLE', version: 'v99' } });
  env.flushTimers(); env.flushTimers();
  ok('dashboard: idle page reloads on SW_UPDATE_AVAILABLE', env.reloads.length === 1, 'reloads=' + env.reloads.length);

  env = await dashboard();
  env.fireSw('controllerchange');
  env.flushTimers(); env.flushTimers();
  ok('dashboard: idle page reloads on controllerchange', env.reloads.length === 1, 'reloads=' + env.reloads.length);

  env = await dashboard((e) => e.addModal(true));
  env.fireSw('message', { data: { type: 'SW_UPDATE_AVAILABLE' } });
  env.fireSw('controllerchange');
  env.flushTimers(); env.flushTimers();
  ok('dashboard: open modal → no reload', env.reloads.length === 0, 'reloads=' + env.reloads.length);
  ok('dashboard: open modal → "tap to reload" bar shown', !!env.bar());

  env = await dashboard((e) => e.addModal(false));
  env.fireSw('controllerchange');
  env.flushTimers(); env.flushTimers();
  ok('dashboard: a CLOSED modal does not block the reload', env.reloads.length === 1);

  env = await dashboard((e) => e.typeInto(makeEl('textarea', { value: 'Roof leaks over the gar' })));
  env.fireSw('controllerchange');
  env.flushTimers(); env.flushTimers();
  ok('dashboard: half-typed text → no reload', env.reloads.length === 0);

  env = await dashboard((e) => e.typeInto(makeEl('input', { type: 'text', value: 'x', visible: false })));
  env.fireSw('controllerchange');
  env.flushTimers(); env.flushTimers();
  ok('dashboard: text in a hidden (closed) form does not block', env.reloads.length === 1);

  env = await dashboard((e) => e.window.NBDSafeReload.hold('voice-note'));
  env.fireSw('controllerchange');
  env.flushTimers(); env.flushTimers();
  ok('dashboard: recording held → no reload', env.reloads.length === 0);
  env.document.visibilityState = 'hidden'; env.fireDoc('visibilitychange');
  env.flushTimers();
  ok('dashboard: hidden while STILL recording → still no reload', env.reloads.length === 0);
  env.window.NBDSafeReload.release('voice-note');
  env.fireDoc('visibilitychange');
  env.flushTimers();
  ok('dashboard: released + hidden → reloads onto the new version', env.reloads.length === 1);

  // Any MediaRecorder on the page (six modules record audio) holds the reload.
  env = await dashboard((e) => {
    const rec = new e.ctx.MediaRecorder();
    rec.start(1000);
    e.rec = rec;
  });
  env.fireSw('controllerchange');
  env.flushTimers(); env.flushTimers();
  ok('dashboard: a live MediaRecorder → no reload', env.reloads.length === 0);
  env.rec.stop();
  env.document.visibilityState = 'hidden'; env.fireDoc('visibilitychange');
  env.flushTimers();
  ok('dashboard: recorder stopped + hidden → reloads', env.reloads.length === 1);

  env = await dashboard((e) => e.addModal(true));
  env.fireSw('controllerchange');
  env.flushTimers();
  const bar = env.bar();
  const btn = bar && bar.children.find((c) => c.tagName === 'BUTTON');
  ok('bar has a 44px Reload button', !!btn && /min-height:44px/.test(btn.style.cssText || ''));
  if (btn) { btn._fire('click'); env.flushTimers(); }
  ok('tapping Reload reloads', env.reloads.length === 1);

  // Customer page (offline-manager.js) — the page where notes are typed.
  env = await customerPage();
  env.fireSw('message', { data: { type: 'SW_UPDATE_AVAILABLE' } });
  env.flushTimers(); env.flushTimers();
  ok('customer page: idle page reloads on SW_UPDATE_AVAILABLE', env.reloads.length === 1, 'reloads=' + env.reloads.length);

  env = await customerPage((e) => e.typeInto(makeEl('textarea', { value: 'Customer wants Duration in Driftwood' })));
  env.fireSw('message', { data: { type: 'SW_UPDATE_AVAILABLE' } });
  env.fireSw('controllerchange');
  env.flushTimers(); env.flushTimers();
  ok('customer page: half-typed note → no reload', env.reloads.length === 0, 'reloads=' + env.reloads.length);
  ok('customer page: bar shown', !!env.bar());

  // Every page that loads either registration file loads the guard first.
  const pages = ['docs/pro/dashboard.html', 'docs/pro/customer.html', 'docs/pro/login.html',
    'docs/pro/leaderboard.html', 'docs/pro/roof-rep.html', 'docs/pro/daily-success/index.html'];
  pages.forEach((p) => {
    const html = read(p);
    const reg = html.search(/js\/(dashboard-sw-bootstrap|offline-manager)\.js/);
    if (reg < 0) return;
    const guard = html.search(/js\/safe-reload\.js/);
    ok(p + ' loads safe-reload.js before the SW registration script', guard >= 0 && guard < reg);
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
