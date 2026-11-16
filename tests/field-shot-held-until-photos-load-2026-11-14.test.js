/**
 * field-shot-held-until-photos-load-2026-11-14.test.js — a Field photo is never thrown away.
 *
 * Wave-1 phone finding #9, verified in docs/pro/js/layouts/field.js: the
 * Field camera saves through photo-engine.js, which arrives with the lazy
 * `photos` bundle. saveShot already waited for that load, but when the load
 * FAILED (no signal and the bundle not cached yet) the blob was discarded
 * with "The photo tools are still loading. Try again in a moment." — the
 * roof photo was gone.
 *
 * Runs the real field.js with a stub layout kit, a ScriptLoader whose first
 * load fails, then succeeds:
 *   - the shot is held (not dropped) and the rep is told to keep NBD Pro open
 *   - once the bundle loads, the held shot goes to the durable queue with the
 *     slope and hit count from the moment of the shutter
 *
 * Run: node tests/field-shot-held-until-photos-load-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 400) : '')); failed++; }
}
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

function fieldApp() {
  const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
  const toasts = [];
  const listeners = {};
  const ls = {};
  const win = {
    NBDLayoutKit: K, LayoutEngine: { implement() {} },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    showToast: (m, t) => toasts.push([t, String(m)]),
    _user: { uid: 'u1' },
    _leads: [{ id: 'L1', stage: 'inspected', name: 'Ann Lee' }],
    loads: 0,
    ScriptLoader: { loadBundle() { win.loads++; return Promise.resolve(); } }, // loads, but PhotoEngine never appears
  };
  const ctx = {
    window: win,
    document: {
      documentElement: { classList: { contains: () => false, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} },
      getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      addEventListener() {},
    },
    navigator: { onLine: true, geolocation: { getCurrentPosition: (okCb) => okCb({ coords: { latitude: 39.1, longitude: -84.5, accuracy: 9 } }) } },
    console: { log() {}, info() {}, warn() {}, error() {} },
    JSON, Math, Date, Object, Array, String, Number, Promise, Blob,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
  };
  vm.createContext(ctx);
  // FIELD_SRC=<file> runs it against another copy (e.g. the pre-fix file).
  vm.runInContext(process.env.FIELD_SRC ? fs.readFileSync(process.env.FIELD_SRC, 'utf8') : read('docs/pro/js/layouts/field.js'), ctx);
  return { F: win.NBDFieldApp, win, toasts, fire: (t) => (listeners[t] || []).forEach((fn) => fn({})) };
}

(async () => {
  console.log('\nfield-shot-held — a Field shot survives a photos bundle that will not load\n');
  const T = fieldApp();
  const F = T.F;
  ok('field.js exposes its shot saver for this check', F && typeof F._saveShot === 'function');
  if (!F || typeof F._saveShot !== 'function') { console.log('\n' + passed + ' passed, ' + failed + ' failed\n'); process.exit(1); }

  F._state.leadId = 'L1';
  F._state.slope = F._slopes[1].id;
  F._state.hits = {}; F._state.hits[F._slopes[1].id] = 9;
  await F._saveShot(new Blob([Buffer.alloc(50, 1)], { type: 'image/jpeg' }));
  await flush();
  ok('the photos bundle could not load: the shot is HELD, not dropped', F._heldCount() === 1, 'held=' + F._heldCount());
  ok('the rep is told it is kept and to keep NBD Pro open', T.toasts.some(([, m]) => /kept on this screen/i.test(m) && /keep NBD Pro open/i.test(m)), JSON.stringify(T.toasts));
  ok('...and NOT told to "try again" (the old message for a discarded shot)', !T.toasts.some(([, m]) => /Try again in a moment/.test(m)));

  // The rep moves to another slope before signal returns.
  F._state.slope = F._slopes[0].id;

  // Signal back: the bundle loads and PhotoEngine appears.
  const queued = [];
  T.win.PhotoEngine = {
    enqueueForRetry: async (item) => { queued.push(item); return { queued: true, durable: true }; },
    flushUploadQueue() {}, queuedPhotoCountDurable: async () => 0,
  };
  T.fire('online');
  await flush();
  ok('once the photo tools load, the held shot goes to the durable queue', queued.length === 1 && F._heldCount() === 0, 'queued=' + queued.length + ' held=' + F._heldCount());
  const it = queued[0] || {};
  ok('...for the same customer', it.leadId === 'L1');
  ok('...tagged with the slope and hit count from the shutter, not from now',
    Array.isArray(it.tags) && it.tags.indexOf(F._slopes[1].tag) !== -1 && /: 9 hits/.test(it.description || ''),
    JSON.stringify({ tags: it.tags, d: it.description }));

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
