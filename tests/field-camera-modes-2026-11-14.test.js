/**
 * field-camera-modes-2026-11-14.test.js — Field shots are job photos unless the
 * rep picks the hail test square.
 *
 * Wave-1 field #10 (Joe 2026-11-14): docs/pro/js/layouts/field.js saved every
 * Field camera shot as a hail test square (tags hail + test_square + a slope,
 * "Test square, S: 0 hits counted in 10 ft x 10 ft"), even a gutter or a
 * siding photo. Now:
 *   - 'photo' (default): no hail / slope tags, no square overlay or counter;
 *     tagging happens in Photo Review, like burst shots
 *   - 'square': exactly the test-square behaviour as before
 *   - the mode is a per-device choice (localStorage), read at the shutter
 *
 * Runs the real field.js with a stub layout kit and a stub PhotoEngine.
 * FIELD_SRC=<file> runs against another copy.
 *
 * Run: node tests/field-camera-modes-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 300) : '')); failed++; }
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function app(store) {
  const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
  const ls = store || {};
  const win = { NBDLayoutKit: K, LayoutEngine: { implement() {} }, addEventListener() {}, removeEventListener() {},
    showToast() {}, _user: { uid: 'u1' }, _leads: [{ id: 'L1', name: 'Ann Lee', stage: 'inspected' }] };
  const ctx = {
    window: win,
    document: { documentElement: { classList: { contains: () => false } }, getElementById: () => null },
    navigator: { onLine: true, geolocation: { getCurrentPosition: (a, b) => b && b() } },
    console: { log() {}, info() {}, warn() {}, error() {} }, JSON, Math, Date, Object, Array, String, Number, Promise,
    setTimeout: (f) => { f(); return 1; }, clearTimeout() {}, setInterval: () => 1,
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(process.env.FIELD_SRC || path.join(ROOT, 'docs/pro/js/layouts/field.js'), 'utf8'), ctx);
  return { F: win.NBDFieldApp, ls };
}
function engine() {
  const queued = [];
  return { queued, P: { enqueueForRetry: async (it) => { queued.push(it); return { queued: true, durable: true }; }, flushUploadQueue() {}, queuedPhotoCountDurable: async () => 0 } };
}

(async () => {
  console.log('\nfield-camera-modes — a Field shot is a job photo unless the rep picks the test square\n');
  let T = app();
  ok('(field.js exposes its shot saver and capture screen for this check)', T.F && typeof T.F._saveShotWith === 'function' && typeof T.F._renderCapture === 'function');
  if (!(T.F && T.F._saveShotWith && T.F._renderCapture)) { console.log('\n' + passed + ' passed, ' + failed + ' failed\n'); process.exit(1); }

  // Default: a job photo.
  T.F._state.leadId = 'L1';
  let html = T.F._renderCapture();
  ok('default camera is Photo: no test-square overlay or hit counter', !/fa-sq-box/.test(html) && !/id="faN"/.test(html) && /aria-pressed="true">Photo</.test(html), html.slice(0, 200));
  let E = engine();
  await T.F._saveShotWith(E.P, new Blob([Buffer.alloc(9)]), 'L1', T.F._camMode());
  await flush();
  const p = E.queued[0] || {};
  ok('a Photo-mode shot carries no hail / test-square / slope tags', Array.isArray(p.tags) && p.tags.length === 0, JSON.stringify(p.tags));
  ok('...and no "Test square, S: 0 hits" description', p.description === '' && p.location === '', JSON.stringify({ d: p.description, l: p.location }));

  // Test square, as before.
  T = app({ nbd_field_cam_mode: 'square' });
  T.F._state.leadId = 'L1';
  T.F._state.slope = 'W'; T.F._state.hits = { W: 7 };
  html = T.F._renderCapture();
  ok('Test square mode keeps the overlay, slope chips and counter', /fa-sq-box/.test(html) && /id="faN"/.test(html) && /aria-label="Slope"/.test(html));
  E = engine();
  await T.F._saveShotWith(E.P, new Blob([Buffer.alloc(9)]), 'L1', T.F._camMode());
  await flush();
  const q = E.queued[0] || {};
  ok('a Test-square shot is tagged hail + test_square + its slope with the hit count', JSON.stringify(q.tags) === JSON.stringify(['hail', 'test_square', 'west_slope']) && /: 7 hits counted/.test(q.description || ''), JSON.stringify(q));

  // The toggle is wired and kept per device.
  const SRC = fs.readFileSync(process.env.FIELD_SRC || path.join(ROOT, 'docs/pro/js/layouts/field.js'), 'utf8');
  ok('the mode chips save the choice on this device', /if \(a === 'cam-mode'\) \{ lsSet\(CAM_MODE_KEY/.test(SRC) && /data-fa="cam-mode" data-id="photo"/.test(SRC));

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
