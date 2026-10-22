/**
 * tests/tracker-account-switch-2026-10-21.test.js
 *
 * Found by the security review of the offline-tracker proposal (F3): the tracker had no account-switch purge, so on a shared phone
 * user A's local pages / workouts could be merged into user B's cloud account when B signed in on the tracker. The dashboard already
 * purges on an account switch (nbd_last_uid); the tracker's sync now does the same BEFORE it reads or writes anything.
 *
 * This runs the REAL docs/pro/daily-success/ds-firebase-sync.js (imports stubbed, auth callback captured) against a fake phone.
 *
 * Run: node tests/tracker-account-switch-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SYNC_SRC = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'daily-success', 'ds-firebase-sync.js'), 'utf8').replace(/\r\n/g, '\n');
const L = require(path.join(ROOT, 'docs', 'pro', 'daily-success', 'js', 'ds-sync-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('\n1. accountSwitched (pure)');
{
  ok('two different real ids is a switch', L.accountSwitched('A', 'B') === true);
  ok('the same account is not', L.accountSwitched('A', 'A') === false);
  ok('no record (first sign-in on this phone) is not', L.accountSwitched(null, 'B') === false && L.accountSwitched('', 'B') === false && L.accountSwitched(undefined, 'B') === false);
  ok('no current uid is not', L.accountSwitched('A', '') === false && L.accountSwitched('A', null) === false && L.accountSwitched('A', undefined) === false);
  ok('non-strings never count (an object or number is not an account)', L.accountSwitched({}, 'B') === false && L.accountSwitched(5, 'B') === false && L.accountSwitched('A', {}) === false);
}

// ── a fake phone around the real module ─────────────────────────────────────
function boot(opts) {
  const o = opts || {};
  const store = new Map(Object.entries(o.storage || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const writes = [];          // every cloud write the module attempted
  const reads = [];           // every cloud read
  const purges = [];
  const events = [];          // purge + every cloud read/write, in order
  const badges = [];
  let authCb = null;
  const el = () => ({ style: {}, set textContent(v) { badges.push(v); }, get textContent() { return ''; }, appendChild() {}, setAttribute() {} });
  const window = {
    NBDDsSync: L,
    loadPages() { window._loaded = (window._loaded || 0) + 1; },
    dsRefreshView() {},
  };
  if (o.nbdAuth !== false) {
    window.NBDAuth = {
      purgeAccountStorage() {
        purges.push(1); events.push('purge');
        if (o.purgeThrows) throw new Error('purge failed');
        for (const k of [...store.keys()]) if (/^nbd_(dsp|ds_workouts|user_config|ds_coach|ds_food)/.test(k)) store.delete(k);
      },
    };
  }
  const document = { getElementById: () => null, createElement: () => el(), body: { appendChild() {} } };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (o.storageThrows) throw new Error('quota'); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const snap = (docs) => ({ forEach: (fn) => docs.forEach((d) => fn({ data: () => Object.assign({}, d) })), exists: () => false, data: () => ({}) });
  const stubs = {
    initializeApp: () => ({}), getApps: () => [], getAuth: () => ({}),
    onAuthStateChanged: (a, cb) => { authCb = cb; },
    getFirestore: () => ({}), doc: (...a) => ({ path: a.slice(1).join('/') }), collection: (...a) => ({ path: a.slice(1).join('/') }),
    getDoc: async (ref) => { events.push('read ' + ref.path); reads.push('getDoc ' + ref.path); return snap([]); },
    getDocs: async (ref) => { events.push('read ' + ref.path); reads.push('getDocs ' + ref.path); return snap(o.cloud || []); },
    setDoc: async (ref, data) => { events.push('write ' + ref.path); writes.push({ kind: 'setDoc', path: ref.path, data }); },
    writeBatch: () => ({ set: (ref, data) => { events.push('write ' + ref.path); writes.push({ kind: 'batch', path: ref.path, data }); }, delete: () => {}, commit: async () => {} }),
    serverTimestamp: () => 'ts', connectEmulatorsIfLocal: async () => {},
  };
  const body = SYNC_SRC.replace(/^import [\s\S]*?from '[^']+';\n/gm, '');
  const ctx = vm.createContext(Object.assign({ window, document, localStorage, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, JSON, Date, Math, Promise, Map, Set, Object, Array, String, Number, Error }, stubs));
  vm.runInContext('(async () => {\n' + body + '\n})();', ctx, { filename: 'ds-firebase-sync.js' });
  return { store, writes, reads, purges, events, badges, window, signIn: async (uid) => { while (!authCb) await new Promise((r) => setTimeout(r, 5)); await authCb({ uid }); } };
}
const pageA = { id: 'day-2026-10-01', dk: '2026-10-01', mt: 1700000000000, data: { note: 'A private day' } };
const pagesWritten = (p) => p.writes.filter((w) => /ds_pages/.test(w.path)).map((w) => w.data && w.data.id);

(async () => {
console.log('\n2. a different account signs in: the other account\'s local data is purged BEFORE any cloud read or write');
{
  const p = boot({ storage: { nbd_last_uid: 'A', nbd_dsp_v1: [pageA], nbd_ds_workouts: [{ id: 'w1', date: '2026-10-01', exercises: [] }], nbd_user_config: { marker: 'A-CONFIG' }, nbd_user_config_at: String(Date.now()) } });
  await p.signIn('B');
  ok('the purge ran exactly once', p.purges.length === 1);
  ok('A\'s pages are not in B\'s cloud (nothing written for them)', !pagesWritten(p).includes('day-2026-10-01'), JSON.stringify(pagesWritten(p)));
  ok('A\'s local pages, workouts and config are gone from the phone', !p.store.has('nbd_dsp_v1') || p.store.get('nbd_dsp_v1') === '[]');
  ok('the page list on screen was reloaded after the purge', p.window._loaded >= 1);
  ok('the phone now records B as the last account', p.store.get('nbd_last_uid') === 'B');
  ok('the purge is the FIRST thing that happens: before every cloud read and write (order)', p.events[0] === 'purge' && p.events.filter((e) => e === 'purge').length === 1 && p.events.length > 1, JSON.stringify(p.events));
  ok('control: some cloud reads did happen after it (the check is not satisfied by an empty log)', p.events.slice(1).some((e) => /^read /.test(e)));
  ok('A\'s settings never reach B\'s account either (userSettings, any write)', !JSON.stringify(p.writes).includes('A-CONFIG') && !p.writes.some((w) => /userSettings/.test(w.path) && JSON.stringify(w.data).includes('A-CONFIG')), JSON.stringify(p.writes).slice(0, 200));
}

console.log('\n3. the same account, or a first sign-in on this phone: nothing is wiped');
{
  const same = boot({ storage: { nbd_last_uid: 'A', nbd_dsp_v1: [pageA] } });
  await same.signIn('A');
  ok('same account: no purge, local pages kept and pushed', same.purges.length === 0 && same.store.has('nbd_dsp_v1') && pagesWritten(same).includes('day-2026-10-01'), JSON.stringify(pagesWritten(same)));
  const first = boot({ storage: { nbd_dsp_v1: [pageA] } });
  await first.signIn('A');
  ok('first sign-in on this phone (tracker-only user, no record): no purge, local pages kept and pushed', first.purges.length === 0 && pagesWritten(first).includes('day-2026-10-01'));
  ok('...and the account is recorded for next time', first.store.get('nbd_last_uid') === 'A');
}

console.log('\n4. failure modes never leak and never wedge');
{
  const noAuth = boot({ nbdAuth: false, storage: { nbd_last_uid: 'A', nbd_dsp_v1: [pageA] } });
  const t0 = Date.now();
  await noAuth.signIn('B');
  ok('no purge available (nbd-auth never loaded): the sync is paused - nothing read, nothing written, local copy untouched', noAuth.reads.length === 0 && noAuth.writes.length === 0 && noAuth.store.has('nbd_dsp_v1') && noAuth.badges.some((b) => /Sync paused/.test(String(b))), JSON.stringify({ r: noAuth.reads, w: noAuth.writes.length, b: noAuth.badges }));
  ok('...the last-account record is NOT overwritten (so the next load retries instead of masking the switch)', noAuth.store.get('nbd_last_uid') === 'A');
  ok('...and it waited a bounded time (about 3 s), not forever', Date.now() - t0 < 6000 && Date.now() - t0 >= 2500, String(Date.now() - t0));

  const late = boot({ nbdAuth: false, storage: { nbd_last_uid: 'A', nbd_dsp_v1: [pageA] } });
  const purges = late.purges;
  setTimeout(() => { late.window.NBDAuth = { purgeAccountStorage() { purges.push(1); late.store.delete('nbd_dsp_v1'); } }; }, 400);
  await late.signIn('B');
  ok('the module wins the race against nbd-auth.js: it waits for the purge to appear, then purges before syncing', purges.length === 1 && !pagesWritten(late).includes('day-2026-10-01'));

  const boom = boot({ purgeThrows: true, storage: { nbd_last_uid: 'A', nbd_dsp_v1: [pageA] } });
  await boom.signIn('B');
  ok('a purge that throws pauses the sync (A\'s data is not pushed into B\'s account)', boom.writes.length === 0 && boom.store.get('nbd_last_uid') === 'A');

  const stor = boot({ storageThrows: true, storage: { nbd_last_uid: 'A', nbd_dsp_v1: [pageA] } });
  let threw = null;
  try { await stor.signIn('B'); } catch (e) { threw = e; }
  ok('a storage write error does not throw out of the sign-in handler (and the sign-in still completed its cloud pass)', threw === null && stor.reads.length > 0, String(threw));
  const quick = boot({ storage: { nbd_last_uid: 'A', nbd_dsp_v1: [pageA] } });
  const q0 = Date.now();
  await quick.signIn('B');
  ok('when the purge is already there it runs at once (no fixed 3 s wait)', quick.purges.length === 1 && Date.now() - q0 < 1000, String(Date.now() - q0));
}

console.log('\n5. source shape (comment-stripped)');
{
  const src = SYNC_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
  const cb = src.slice(src.indexOf('onAuthStateChanged(auth, async user'));
  ok('the purge sits before the first cloud read in the auth callback', cb.indexOf('purgeAccountStorage()') > -1 && cb.indexOf('purgeAccountStorage()') < cb.indexOf('syncSettings()') && cb.indexOf('purgeAccountStorage()') < cb.indexOf('pullFromFirestore()'));
  ok('control: a commented-out purge would not satisfy that pin', !/purgeAccountStorage\(\)/.test('// window.NBDAuth.purgeAccountStorage();'.replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
