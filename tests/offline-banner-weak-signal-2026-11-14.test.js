/**
 * offline-banner-weak-signal-2026-11-14.test.js — the offline banner notices weak signal.
 *
 * Wave-1 field #14 (Joe 2026-11-14): docs/pro/js/offline-banner.js read
 * navigator.onLine only. One bar of LTE is "online", so on a roof the rep saw
 * no banner while saves sat on the phone. Now it also shows:
 *   - when a phone's browser reports a slow link (navigator.connection 2g / rtt)
 *   - when changes have waited 30 s to sync without moving while "online"
 *     (NBDOfflineSync.pending(), the sync badge's own count): the iPhone path
 * and hides again once nothing is waiting.
 * Review round: a banner fading out is brought back, not removed under the
 * new state; steady saving on a good link is not "weak"; a slow-link
 * estimate alone does not trip it on a desktop.
 *
 * Runs the real file in the shared fake DOM, driving it through its own
 * listeners, poll timer and timeouts, with a fake clock.
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

function page(conn, opts) {
  opts = opts || {};
  const dom = H.makeDom();
  const winL = {};
  const intervals = [];
  const timeouts = new Map();
  let tid = 0;
  let now = 1_800_000_000_000;
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(now); }
  FakeDate.now = () => now; FakeDate.prototype = RealDate.prototype;
  const sync = { n: 0 };
  const nav = { onLine: true, connection: conn || undefined };
  const W = {
    document: dom.document, navigator: nav, Date: FakeDate, console: { log() {}, warn() {}, error() {} },
    addEventListener(t, fn) { (winL[t] = winL[t] || []).push(fn); },
    // Timeouts wait until runTimeouts(): the 220 ms fade-out window is real.
    setTimeout: (fn) => { timeouts.set(++tid, fn); return tid; }, clearTimeout: (id) => { timeouts.delete(id); },
    setInterval: (fn) => { intervals.push(fn); return 1; },
    matchMedia: (q) => ({ matches: /coarse/.test(q) ? opts.phone !== false : false }),
    NBDOfflineSync: { pending: () => sync.n },
    Number, String, Object, Array, Math, JSON,
  };
  dom.document.readyState = 'complete';
  const ctx = vm.createContext(W); ctx.window = ctx;
  vm.runInContext(SRC, ctx, { filename: 'offline-banner.js' });
  const runTimeouts = () => { const list = [...timeouts.values()]; timeouts.clear(); list.forEach((fn) => fn()); };
  runTimeouts(); // the boot check
  const banner = () => dom.document.getElementById('nbd-offline-banner');
  const shown = () => !!banner() && banner().style.opacity !== '0';
  const tick = (ms) => { now += ms; intervals.forEach((fn) => fn()); };
  const fire = (t) => (winL[t] || []).forEach((fn) => fn({}));
  return { nav, sync, banner, shown, tick, fire, runTimeouts, text: () => (banner() ? H.text(banner()) : '') };
}

console.log('\noffline-banner-weak-signal — weak signal and waiting saves show the banner\n');

let P = page();
P.nav.onLine = false; P.fire('offline');
ok('(offline still shows the offline banner)', P.shown() && /You.{1,2}re offline/.test(P.text()), P.text());
P.nav.onLine = true; P.fire('online'); P.runTimeouts();
ok('(back online with nothing waiting: hidden)', !P.banner());

P = page();
P.sync.n = 2;
P.tick(10000);
ok('online with saves waiting only a few seconds: no banner yet', !P.banner());
P.tick(30000);
ok('saves waiting 30 s while "online": a weak-signal banner', P.shown() && /Weak signal/.test(P.text()) && /2 changes are saved on this phone/.test(P.text()), P.text());
P.sync.n = 0;
P.tick(10000); P.runTimeouts();
ok('...and it hides once they have synced', !P.banner());

P = page({ effectiveType: '2g', addEventListener() {} });
P.tick(10000);
ok('a 2g link on a phone (Android reports it) shows the weak-signal banner', P.shown() && /Weak signal/.test(P.text()), P.text());

// Review round.
P = page({ effectiveType: '2g', addEventListener() {} }, { phone: false });
P.tick(10000);
ok('a 2g estimate alone on a desktop (VPN, Chrome guess) does not show it', !P.banner());

P = page();
for (let i = 1; i <= 6; i++) { P.sync.n = (i % 2) ? 2 : 1; P.tick(10000); }   // saves keep landing
ok('steady saving on a good link (the count keeps dropping) is not "weak"', !P.banner(), P.text());

P = page();
P.nav.onLine = false; P.fire('offline');
P.nav.onLine = true; P.fire('online');          // fading out...
P.nav.onLine = false; P.fire('offline');        // ...and straight back offline
P.runTimeouts();                                 // the fade-out timer would have fired
ok('a banner caught mid-fade is brought back, not removed', P.shown() && /offline/.test(P.text()), P.banner() ? P.banner().style.opacity : 'gone');

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
