/**
 * tests/nbd-os-drive-off-2026-11-09.test.js - NBD OS P2: "Safe to drive off?",
 * background activity (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6 #8).
 *
 *   - system-logic driveOff: "All synced" only when both real queues are known and
 *     empty; "2 photos still uploading" / "1 change still syncing" from the counts;
 *     null (say nothing) when unknown
 *   - trayItems: a photos item only while the photo upload queue holds some (a dot on
 *     the phone's clock); the existing items unchanged
 *   - system.js over the fake DOM: the counts come from NBDOfflineSync.countPending
 *     (Firestore's own on-device mutation queue, null = unknown) and
 *     NBDPhotoQueueStore.pendingForUid (this member's rows only), never a default; the
 *     Control Center shows the line, the tray shows the photos; nothing when unknown
 *   - lazy: system.js / system-logic.js load at runtime (layout-system.js), no <script> tag
 *
 * Run: node tests/nbd-os-drive-off-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const flush = () => new Promise((r) => setImmediate(r));
async function G(fn) { try { await fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } }

const L = require(path.join(ROOT, 'docs/pro/js/os/system-logic.js'));
const SYS = read('docs/pro/js/os/system.js');

/** The real system.js over the harness DOM, with spied queues. */
function sys(o) {
  o = o || {};
  const T = makeWin({ surface: 'phone', plan: null, home: { phone: [], desk: [] } });
  const W = T.W;
  const header = T.document.createElement('header');
  const hr = T.document.createElement('div'); hr.className = 'hright';
  header.appendChild(hr);
  T.document.body.appendChild(header);
  W.sessionStorage = { getItem: () => '1', setItem() {} };
  W.navigator.onLine = o.online !== false;
  W.queueCalls = [];
  W.NBDOfflineSync = o.noSync ? undefined : {
    countPending: () => { W.queueCalls.push('countPending'); return Promise.resolve(o.writes === undefined ? 0 : o.writes); },
    pending: () => (o.hint || 0),
  };
  W.NBDPhotoQueueStore = o.noPhotos ? undefined : {
    pendingForUid: (uid) => { W.queueCalls.push('pendingForUid:' + uid); return Promise.resolve(o.photos === undefined ? 0 : o.photos); },
    count: () => { W.queueCalls.push('count'); return Promise.resolve(99); },
    lastKnownCount: () => { W.queueCalls.push('lastKnownCount'); return 99; },
  };
  vm.runInContext(SYS, W, { filename: 'system.js' });
  return T;
}
const tray = (T) => T.document.getElementById('osTray');
const sheetBody = (T) => T.document.getElementById('osSheetBody');

(async () => {
  console.log('\n1. driveOff: counts from the real queues, null when unknown');
  await G(async () => {
    ok('driveOff is exported', typeof L.driveOff === 'function');
    if (typeof L.driveOff !== 'function') return;
    ok('both known and zero -> All synced, safe', J(L.driveOff({ online: true, writes: 0, photos: 0 })) === J({ safe: true, tone: 'ok', text: 'All synced', label: 'Safe to drive off: everything is synced.' }));
    const p = L.driveOff({ online: true, writes: 0, photos: 2 });
    ok('2 photos queued -> "2 photos still uploading", not safe', p.safe === false && p.tone === 'warn' && p.text === '2 photos still uploading' && /^Not yet: /.test(p.label), J(p));
    ok('1 change -> "1 change still syncing" (singular)', L.driveOff({ writes: 1, photos: 0 }).text === '1 change still syncing');
    ok('both -> both, photos first', L.driveOff({ writes: 3, photos: 1 }).text === '1 photo still uploading · 3 changes still syncing');
    ok('offline says so, and when they send', /· offline$/.test(L.driveOff({ online: false, writes: 0, photos: 2 }).text) && /when you have signal/.test(L.driveOff({ online: false, photos: 2 }).label));
    ok('both unknown -> null (nothing shown)', L.driveOff({ writes: null, photos: null }) === null && L.driveOff({}) === null);
    ok('writes unknown, photos 0 -> null: never "All synced" on half the facts', L.driveOff({ writes: null, photos: 0 }) === null && L.driveOff({ writes: 0, photos: null }) === null);
    ok('a known count above zero is said even with the other unknown', L.driveOff({ writes: null, photos: 2 }).text === '2 photos still uploading');
    ok('junk counts are unknown, not zero', L.driveOff({ writes: 'x', photos: NaN }) === null && L.driveOff({ writes: -1, photos: 0 }) === null);
  });

  console.log('\n2. trayItems: a photos item only while photos are queued');
  await G(async () => {
    ok('a calm day is unchanged (sync + notifs)', L.trayItems({ online: true, pending: 0, unread: 0, photos: 0 }).map((x) => x.id).join() === 'sync,notifs');
    const t = L.trayItems({ online: true, photos: 2 });
    const ph = t.filter((x) => x.id === 'photos')[0];
    ok('2 photos -> a "2 photos" item labelled "still uploading", tone warn', !!ph && ph.text === '2 photos' && ph.label === '2 photos still uploading' && ph.tone === 'warn', J(ph));
    ok('offline: "waiting for signal"', L.trayItems({ online: false, photos: 1 }).filter((x) => x.id === 'photos')[0].label === '1 photo waiting for signal');
    ok('...and it puts a dot on the phone\'s clock (clockAlerts)', L.clockAlerts(t).some((x) => x.id === 'photos'));
    ok('unknown or junk photos -> no item', !L.trayItems({ photos: null }).some((x) => x.id === 'photos') && !L.trayItems({ photos: 'x' }).some((x) => x.id === 'photos'));
  });

  console.log('\n3. system.js: the line in the Control Center and the tray, from the real queues');
  await G(async () => {
    const T = sys({ writes: 0, photos: 2 });
    await flush(); await flush();
    ok('it asked Firestore\'s mutation queue and this member\'s photo rows (uid u1), never the unfiltered count', T.W.queueCalls.indexOf('countPending') !== -1 && T.W.queueCalls.indexOf('pendingForUid:u1') !== -1 &&
      T.W.queueCalls.indexOf('count') === -1 && T.W.queueCalls.indexOf('lastKnownCount') === -1, J(T.W.queueCalls));
    ok('the tray shows "2 photos"', /2 photos/.test(text(tray(T))) && !!tray(T).querySelector('[data-tray="photos"]'), tray(T) && tray(T).innerHTML.slice(0, 300));
    T.W.NBDOS.open('control');
    await flush(); await flush();
    const cc = sheetBody(T);
    ok('the Control Center says "Safe to drive off?" -> "2 photos still uploading"', /Safe to drive off\?/.test(text(cc)) && /2 photos still uploading/.test(text(cc)), text(cc).slice(0, 200));
    const line = cc.querySelector('.os-cc-drive-line');
    ok('...as a status line; no aria-label on the plain <p> (a generic role cannot be named)', !!cc.querySelector('.os-cc-drive[role="status"]') && !!line && !line.hasAttribute('aria-label'));
    const sr = line && line.querySelector('.os-cc-drive-sr');
    ok('...the full sentence is visually-hidden text a screen reader reads, the short visible text is aria-hidden',
      !!sr && /^Not yet: 2 photos still uploading/.test(text(sr)) && !!line.querySelector('[aria-hidden="true"].os-cc-drive-text') &&
      /\.os-cc-drive-sr \{[^}]*clip: rect\(0 0 0 0\)/.test(read('docs/pro/css/os/system.css')));
    const T0 = sys({ writes: 0, photos: 0 });
    await flush(); await flush();
    T0.W.NBDOS.open('control');
    await flush(); await flush();
    ok('both queues empty -> "All synced"', /All synced/.test(text(sheetBody(T0))) && !tray(T0).querySelector('[data-tray="photos"]'));
    const Tu = sys({ writes: null, photos: 0 });   // a memory cache: Firestore's queue can't be read
    await flush(); await flush();
    Tu.W.NBDOS.open('control');
    await flush(); await flush();
    ok('writes unknown (memory cache) and nothing settle() saw queued: no line at all, never "All synced"', !/Safe to drive off|All synced/.test(text(sheetBody(Tu))), text(sheetBody(Tu)).slice(0, 120));
    const Th = sys({ writes: null, photos: 0, hint: 2 });
    await flush(); await flush();
    Th.W.NBDOS.open('control');
    await flush(); await flush();
    ok('writes settle() saw queued still count when the queue itself can\'t be read', /2 changes still syncing/.test(text(sheetBody(Th))), text(sheetBody(Th)).slice(0, 160));
    const Tn = sys({ noSync: true, noPhotos: true });
    await flush(); await flush();
    Tn.W.NBDOS.open('control');
    await flush(); await flush();
    ok('neither queue module on the page: nothing said', !/Safe to drive off/.test(text(sheetBody(Tn))));
    const To = sys({ writes: 1, photos: 0, online: false });
    await flush(); await flush();
    To.W.NBDOS.open('control');
    await flush(); await flush();
    ok('offline with a queued change: "1 change still syncing · offline"', /1 change still syncing · offline/.test(text(sheetBody(To))), text(sheetBody(To)).slice(0, 160));
  });

  console.log('\n4. wiring and hygiene');
  await G(async () => {
    const ls = read('docs/pro/js/layout-system.js');
    ok('system.js and system-logic.js stay runtime loads (no <script> tag)', /loadScriptPath\('js\/os\/system\.js/.test(ls) && !/os\/system/.test(read('docs/pro/dashboard.html').match(/<script[^>]*>/g).join('')));
    const code = noComments(SYS);
    ok('the drive-off counts never come from pending() alone (it reads 0 for unknown)', /countPending/.test(code) && /pendingForUid/.test(code));
    ok('no style="" or inline handlers in system.js', !/style\s*=\s*"/.test(code) && !/\son[a-z]+=/i.test(code));
    const css = read('docs/pro/css/os/system.css');
    ok('the line is styled with tokens, no text under 11px', /\.os-cc-drive-line \{[^}]*\}/.test(css) && !/font-size:\s*(?:[0-9]|10)(?:\.\d+)?px/.test(css));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
