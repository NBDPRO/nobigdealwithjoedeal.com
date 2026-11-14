/**
 * offline-banner-weak-signal-2026-11-14.test.js — the offline banner notices weak signal.
 *
 * Wave-1 field #14 (Joe 2026-11-14): docs/pro/js/offline-banner.js read
 * navigator.onLine only. One bar of LTE is "online", so on a roof the rep saw
 * no banner while saves sat on the phone. Now it also shows:
 *   - when the browser reports a slow link (navigator.connection 2g / rtt)
 *   - when changes have waited to sync for 30 s while "online"
 *     (NBDOfflineSync.pending(), the sync badge's own count): the iPhone path
 * and hides again once nothing is waiting.
 *
 * Runs the real file in the shared fake DOM, driving it through its own
 * listeners and its poll timer, with a fake clock.
 * BANNER_SRC=<file> runs against another copy.
 *
 * Run: node tests/offline-banner-weak-signal-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');

const SRC = fs.readFileSync(process.env.BANNER_SRC || path.join(H.ROOT, 'docs/pro/js/offline-banner.js'), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 200) : '')); }
}

function page(conn) {
  const dom = H.makeDom();
  const winL = {};
  const intervals = [];
  let now = 1_800_000_000_000;
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(now); }
  FakeDate.now = () => now; FakeDate.prototype = RealDate.prototype;
  const sync = { n: 0 };
  const nav = { onLine: true, connection: conn || undefined };
  const W = {
    document: dom.document, navigator: nav, Date: FakeDate, console: { log() {}, warn() {}, error() {} },
    addEventListener(t, fn) { (winL[t] = winL[t] || []).push(fn); },
    setTimeout: (fn) => { fn(); return 0; }, setInterval: (fn) => { intervals.push(fn); return 1; },
    NBDOfflineSync: { pending: () => sync.n },
    Number, String, Object, Array, Math, JSON,
  };
  dom.document.readyState = 'complete';
  const ctx = vm.createContext(W); ctx.window = ctx;
  vm.runInContext(SRC, ctx, { filename: 'offline-banner.js' });
  const banner = () => dom.document.getElementById('nbd-offline-banner');
  const tick = (ms) => { now += ms; intervals.forEach((fn) => fn()); };
  const fire = (t) => (winL[t] || []).forEach((fn) => fn({}));
  return { nav, sync, banner, tick, fire, text: () => (banner() ? H.text(banner()) : '') };
}

console.log('\noffline-banner-weak-signal — weak signal and waiting saves show the banner\n');

let P = page();
P.nav.onLine = false; P.fire('offline');
ok('(offline still shows the offline banner)', !!P.banner() && /You.{1,2}re offline/.test(P.text()), P.text());
P.nav.onLine = true; P.fire('online');
P.tick(300);
ok('(back online with nothing waiting: hidden)', !P.banner() || P.banner().style.opacity === '0');

P = page();
P.sync.n = 2;
P.tick(10000);
ok('online with saves waiting only a few seconds: no banner yet', !P.banner());
P.tick(30000);
ok('saves waiting 30 s while "online": a weak-signal banner', !!P.banner() && /Weak signal/.test(P.text()) && /2 changes are saved on this phone/.test(P.text()), P.text());
P.sync.n = 0;
P.tick(10000);
ok('...and it hides once they have synced', !P.banner() || P.banner().style.opacity === '0');

P = page({ effectiveType: '2g', addEventListener() {} });
P.tick(10000);
ok('a 2g link (Android reports it) shows the weak-signal banner', !!P.banner() && /Weak signal/.test(P.text()), P.text());

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
