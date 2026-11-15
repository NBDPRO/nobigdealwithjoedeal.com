/**
 * field-onsite-offline-2026-11-14.test.js — "I'm on site" never freezes offline.
 *
 * Wave-1 phone finding #6, verified in docs/pro/js/layouts/field.js
 * confirmOnSite: it waited up to 8 s for GPS before showing anything, then
 * on an addDoc that never settles offline, so S.stamping stayed true (the
 * slide could never be used again) and the screen never re-rendered.
 *
 * Runs the real field.js (stub layout kit) with a slow GPS and an addDoc
 * that never acknowledges. FIELD_SRC=<file> runs it against another copy.
 *
 * Run: node tests/field-onsite-offline-2026-11-14.test.js
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
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

function app(online) {
  const K = require(path.join(ROOT, 'docs/pro/js/layouts/kit.js'));
  const ls = {};
  const gps = { cb: null };
  const writes = [];
  const toasts = [];
  const win = {
    NBDLayoutKit: K, LayoutEngine: { implement() {} }, addEventListener() {}, removeEventListener() {},
    showToast: (m, t) => toasts.push([t, m]),
    _user: { uid: 'u1' }, _userClaims: { companyId: 'c1' }, _leads: [{ id: 'L1', name: 'Ann' }],
    db: {}, collection: (...a) => a.slice(1).join('/'), serverTimestamp: () => 'TS',
    addDoc: (col, d) => { writes.push([col, d]); return online ? Promise.resolve({ id: 'a1' }) : new Promise(() => {}); },
    NBDOfflineSync: { settle: (p) => (online ? Promise.resolve(p).then(() => 'synced') : Promise.resolve('queued')) },
  };
  const ctx = {
    window: win,
    document: { documentElement: { classList: { contains: () => false, toggle() {}, add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} }, getElementById: () => null },
    navigator: { onLine: online, geolocation: { getCurrentPosition: (okCb) => { gps.cb = okCb; } } },
    console: { log() {}, info() {}, warn() {}, error() {} },
    JSON, Math, Date, Object, Array, String, Number, Promise,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(process.env.FIELD_SRC || path.join(ROOT, 'docs/pro/js/layouts/field.js'), 'utf8'), ctx);
  const arrived = () => {
    for (const k of Object.keys(ls)) { try { const d = JSON.parse(ls[k]); if (d && d.arrived && d.arrived['stop1']) return d.arrived['stop1']; } catch (_) {} }
    return null;
  };
  return { F: win.NBDFieldApp, gps, writes, toasts, arrived };
}

(async () => {
  console.log('\nfield-onsite-offline — the on-site slide never freezes\n');
  const T = app(false);
  ok('(field.js exposes confirmOnSite for this check)', T.F && typeof T.F._confirmOnSite === 'function');
  if (!T.F || typeof T.F._confirmOnSite !== 'function') { console.log('\n' + passed + ' passed, ' + failed + ' failed\n'); process.exit(1); }
  T.F._state.stopKey = 'stop1'; T.F._state.leadId = 'L1';
  T.F._confirmOnSite();
  await flush();
  const early = T.arrived();
  ok('the arrival time shows at once, before GPS answers', !!early && typeof early.at === 'number', JSON.stringify(early));
  T.gps.cb({ coords: { latitude: 39.1, longitude: -84.5, accuracy: 14 } });   // GPS answers late
  await flush();
  ok('offline: the timeline write was made', T.writes.length === 1 && /activity$/.test(T.writes[0][0]));
  ok('offline: the slide is usable again (stamping cleared)', T.F._state.stamping === false, 'stamping=' + T.F._state.stamping);
  const done = T.arrived();
  ok('...and the stop says it is saved on this phone', done && done.saved === 'queued' && done.acc === 14, JSON.stringify(done));
  ok('...with no "did not save" warning', !T.toasts.some(([, m]) => /did not save/.test(String(m))));

  const O = app(true);
  O.F._state.stopKey = 'stop1'; O.F._state.leadId = 'L1';
  O.F._confirmOnSite();
  await flush();
  O.gps.cb({ coords: { latitude: 39.1, longitude: -84.5, accuracy: 9 } });
  await flush();
  ok('online: saved to the timeline (saved === true)', O.arrived() && O.arrived().saved === true && O.F._state.stamping === false);

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
