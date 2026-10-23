/**
 * tests/account-switch-purge-fail-closed-2026-10-23.test.js
 *
 * The shared-device purge used to fail OPEN (docs/pro/js/dashboard-bootstrap.module.js,
 * the onAuthStateChanged callback). On an account switch it called
 * window.NBDAuth.purgeAccountStorage() only `if (window.NBDAuth && ...)`, and then
 * ALWAYS wrote nbd_last_uid = the new uid. If NBDAuth was not assigned yet (nbd-auth.js
 * loads separately) or the purge threw, the purge was skipped AND the record of the
 * previous account was erased, so the second defence (Daily Success sync, keyed on
 * nbd_last_uid) saw no switch either: account B read A's cached leads, photos and texts.
 *
 * The REAL code is lifted out of the module: the callback's purge block plus the
 * _settleOwedPurge / _failClosedClear helpers, composed into one tick runner.
 *   1. control: the pre-fix block really does leak (so the harness can see it)
 *   2. NBDAuth present: purge runs, the new uid is recorded
 *   3. NBDAuth assigned LATE: the tick waits, purges, then records the uid
 *   4. NBDAuth never arrives, or its purge throws / rejects: fail closed - the old
 *      account's keys and databases are cleared directly, nbd_last_uid stays on the
 *      OLD uid (the next load retries), and the tick still ends
 *   5. no switch: nothing is purged or cleared
 *   6. structure: the await sits before the rest of boot; nbd_last_uid is written in
 *      exactly the two guarded places
 *
 * Run: node tests/account-switch-purge-fail-closed-2026-10-23.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'dashboard-bootstrap.module.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; fails.push(label); }
}

function closeOf(src, from) {
  const open = src.indexOf('{', from);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/* ---- lift the real code ---- */
const START = "const _lastUid = localStorage.getItem('nbd_last_uid');";
const END = '} catch (_) { /* best-effort; never block boot on a storage error */ }';
const s0 = SRC.indexOf(START);
const t0 = s0 === -1 ? -1 : SRC.lastIndexOf('try {', s0);
const e0 = s0 === -1 ? -1 : SRC.indexOf(END, s0);
ok('extraction: the callback purge block found', s0 !== -1 && t0 !== -1 && s0 - t0 < 40 && e0 !== -1);
const BLOCK = SRC.slice(t0, e0 + END.length);

const H0 = SRC.indexOf('const _PURGE_WAIT_MS');
const hFn = SRC.indexOf('async function _settleOwedPurge(');
const H1 = hFn === -1 ? -1 : closeOf(SRC, hFn);
ok('extraction: the helpers (_failClosedClear, _settleOwedPurge) found', H0 !== -1 && hFn !== -1 && H1 > hFn);
let HELPERS = SRC.slice(H0, H1 + 1);
const waitMs = Number((/const _PURGE_WAIT_MS = (\d+);/.exec(HELPERS) || [])[1]);
ok('the wait is bounded: between 2 and 10 seconds', waitMs >= 2000 && waitMs <= 10000, String(waitMs));
HELPERS = HELPERS.replace(/const _PURGE_WAIT_MS = \d+;/, 'const _PURGE_WAIT_MS = 400;');   // the test must not take 5 s

function runner(helpers, block, after) {
  return new Function('window', 'localStorage',
    helpers + '\nreturn async function (user) {\n' + block + '\n' + (after || '') + '\n};');
}

/* ---- a fake device ---- */
function device(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    m,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] === undefined ? null : [...m.keys()][i],
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
const A_DATA = { nbd_last_uid: 'A', nbd_leads_cache: '[{"name":"A customer"}]', nbd_ds_workouts: '[1]', 'nav-state': 'x', 'plain-key': 'keep' };
function world(opts) {
  opts = opts || {};
  const ls = device(Object.assign({}, A_DATA, opts.storage || {}));
  const idbDeleted = [];
  const win = { indexedDB: { deleteDatabase: (n) => { idbDeleted.push(n); return {}; } } };
  const calls = { purge: 0 };
  const fakeAuth = () => ({
    purgeAccountStorage: () => {
      calls.purge++;
      if (opts.purge === 'throw') throw new Error('boom');
      if (opts.purge === 'reject') return Promise.reject(new Error('boom'));
      for (const k of [...ls.m.keys()]) if (/^(nbd[_-]|nav-)/.test(k) && k !== 'nbd_last_uid') ls.m.delete(k);
      return Promise.resolve();
    },
  });
  if (opts.auth !== 'never' && opts.auth !== 'late') win.NBDAuth = fakeAuth();
  if (opts.auth === 'late') setTimeout(() => { win.NBDAuth = fakeAuth(); }, 150);
  return { ls, win, idbDeleted, calls };
}
const FULL = (w) => runner(HELPERS, 'let _pendingPurge = null;\n' + BLOCK, 'await _settleOwedPurge(user.uid, _pendingPurge);')(w.win, w.ls);
const cleared = (w) => !w.ls.m.has('nbd_leads_cache') && !w.ls.m.has('nbd_ds_workouts') && !w.ls.m.has('nav-state');

(async () => {
  console.log('\n1. control: the pre-fix block leaked');
  {
    const OLD = "try {\n const _lastUid = localStorage.getItem('nbd_last_uid');\n if (_lastUid && _lastUid !== user.uid) {\n if (window.NBDAuth && typeof window.NBDAuth.purgeAccountStorage === 'function') { window.NBDAuth.purgeAccountStorage(); }\n }\n localStorage.setItem('nbd_last_uid', user.uid);\n } catch (_) {}";
    const w = world({ auth: 'never' });
    await runner('', OLD, '')(w.win, w.ls)({ uid: 'B' });
    ok('with NBDAuth missing the old code left A\'s data AND recorded B (the leak)', w.ls.m.has('nbd_leads_cache') && w.ls.m.get('nbd_last_uid') === 'B');
  }

  console.log('\n2. NBDAuth present');
  {
    const w = world({});
    await FULL(w)({ uid: 'B' });
    ok('the purge ran once, A\'s data is gone and B is recorded', w.calls.purge === 1 && cleared(w) && w.ls.m.get('nbd_last_uid') === 'B');
    ok('an unrelated key is untouched', w.ls.m.get('plain-key') === 'keep');
  }

  console.log('\n3. NBDAuth assigned late');
  {
    const w = world({ auth: 'late' });
    const t0 = Date.now();
    await FULL(w)({ uid: 'B' });
    ok('the tick waited for it, purged once, then recorded B', w.calls.purge === 1 && cleared(w) && w.ls.m.get('nbd_last_uid') === 'B', 'purge=' + w.calls.purge + ' last=' + w.ls.m.get('nbd_last_uid'));
    ok('it did not wait the whole bound', Date.now() - t0 < 380);
    ok('no direct fallback clear was needed', w.idbDeleted.length === 0);
  }

  console.log('\n4. fail closed');
  for (const [label, opts] of [['NBDAuth never arrives', { auth: 'never' }], ['the purge throws', { purge: 'throw' }], ['the purge rejects', { purge: 'reject' }]]) {
    const w = world(opts);
    const t0 = Date.now();
    await FULL(w)({ uid: 'B' });
    ok(label + ': nbd_last_uid is still A (the next load retries)', w.ls.m.get('nbd_last_uid') === 'A', w.ls.m.get('nbd_last_uid'));
    ok(label + ': A\'s cached data was cleared directly', !w.ls.m.has('nbd_leads_cache') && !w.ls.m.has('nbd_ds_workouts') && !w.ls.m.has('nav-state'));
    ok(label + ': the photo, My Skin and SMS-outbox databases were deleted', ['nbd_ds_photos', 'nbd-myskin', 'nbd-sms-outbox-db'].every((n) => w.idbDeleted.includes(n)), w.idbDeleted.join());
    ok(label + ': unrelated keys survive, and the tick ended', w.ls.m.get('plain-key') === 'keep' && Date.now() - t0 < 3000);
  }
  {
    const w = world({ auth: 'never' });
    delete w.win.indexedDB;
    let threw = false;
    try { await FULL(w)({ uid: 'B' }); } catch (_) { threw = true; }
    ok('no indexedDB at all: still no throw', !threw);
    const w2 = world({ auth: 'never' });
    w2.win.indexedDB = { deleteDatabase() { throw new Error('x'); } };
    let threw2 = false;
    try { await FULL(w2)({ uid: 'B' }); } catch (_) { threw2 = true; }
    ok('deleteDatabase throwing: still no throw', !threw2);
  }

  console.log('\n5. no switch, nothing to do');
  {
    const same = world({});
    await FULL(same)({ uid: 'A' });
    ok('same account: no purge, no clearing, nothing wiped', same.calls.purge === 0 && same.ls.m.has('nbd_leads_cache') && same.idbDeleted.length === 0);
    const first = world({ storage: { nbd_last_uid: undefined } });
    first.ls.m.delete('nbd_last_uid');
    await FULL(first)({ uid: 'B' });
    ok('first sign-in on the phone: B is recorded, nothing is purged', first.calls.purge === 0 && first.ls.m.get('nbd_last_uid') === 'B' && first.ls.m.has('nbd_leads_cache'));
    const solo = world({ auth: 'never' });
    solo.ls.m.set('nbd_last_uid', 'B');
    await FULL(solo)({ uid: 'B' });
    ok('same account and NBDAuth missing: no wait, no clearing', solo.ls.m.has('nbd_leads_cache') && solo.idbDeleted.length === 0);
  }

  console.log('\n6. structure');
  {
    const cb = SRC.indexOf('onAuthStateChanged(auth, async user => {');
    const blockAt = SRC.indexOf(START, cb);
    const settleAt = SRC.indexOf('await _settleOwedPurge(user.uid, _pendingPurge);', cb);
    const subAt = SRC.indexOf('SUBSCRIPTION CHECK', cb);
    ok('the callback awaits the settle right after the block and before the subscription check', blockAt !== -1 && settleAt > blockAt && settleAt < subAt);
    ok('nbd_last_uid is written in exactly three places: the guarded block and the two after an awaited purge', (SRC.match(/setItem\('nbd_last_uid'/g) || []).length === 3 && /if \(!_purgeOwed\) localStorage\.setItem\('nbd_last_uid', user\.uid\)/.test(SRC));
    ok('the pending-purge variable is declared before the block, outside the lifted slice', SRC.lastIndexOf('let _pendingPurge = null;', s0) > cb && SRC.lastIndexOf('let _pendingPurge = null;', s0) < t0);
    ok('the settle helper is declared once', (SRC.match(/async function _settleOwedPurge/g) || []).length === 1);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})();
