/**
 * tests/ds-sync-pill-and-workout-isolation-2026-10-23.test.js
 *
 * Two audit findings in docs/pro/daily-success/ds-firebase-sync.js:
 *
 *   1. showBadge() started an independent 2400 ms hide timer per call and never cleared the previous one. "Saving..." (t=0) hid the
 *      pill ~0.1-0.4 s after "Sync failed" appeared (the push fires at the 2000 ms debounce), so a failed save flashed by unseen.
 *      Now: one timer handle, cleared on every call; error states stay up longer than success states.
 *   2. The load path ran `await pushToFirestore(...); await syncWorkouts();` in one try, so a throwing pages push skipped the workout
 *      sync for that load, and an unguarded localStorage.setItem(WKEY) (quota / private mode) aborted the remaining workout pushes.
 *      Now: each is isolated, and every failure still shows a failure badge.
 *
 * Runs the REAL ds-firebase-sync.js (imports stubbed, auth callback captured) with a virtual clock.
 *
 * Run: node tests/ds-sync-pill-and-workout-isolation-2026-10-23.test.js
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
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

function boot(o) {
  o = o || {};
  const store = new Map(Object.entries(o.storage || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const writes = [], reads = [], badges = [];
  let authCb = null, now = 0, nextId = 1;
  const timers = new Map();
  const fakeSetTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { at: now + (ms || 0), fn }); return id; };
  const fakeClearTimeout = (id) => { timers.delete(id); };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      let pick = null;
      for (const [id, t] of timers) if (t.at <= end && (!pick || t.at < pick.t.at)) pick = { id, t };
      if (!pick) break;
      timers.delete(pick.id); now = Math.max(now, pick.t.at); pick.t.fn(); await flush();
    }
    now = end; await flush();
  };
  const badge = { style: {}, _text: '', set textContent(v) { this._text = v; badges.push(v); }, get textContent() { return this._text; }, appendChild() {}, setAttribute() {} };
  const document = { getElementById: () => null, createElement: () => badge, body: { appendChild() {} } };
  const window = {
    NBDDsSync: L, loadPages() {}, dsRefreshView() {},
    savePages() {},
    NBDCoach: { mergeSessions: (a, b) => { const m = new Map(); for (const x of a.concat(b)) { const c = m.get(String(x.id)); if (!c || (x.mt || 0) > (c.mt || 0)) m.set(String(x.id), x); } return [...m.values()]; } },
  };
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if ((o.throwOnSetKeys || []).includes(k)) throw new Error('QuotaExceededError'); store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  const snap = (docs) => ({ forEach: (fn) => docs.forEach((d) => fn({ data: () => Object.assign({}, d) })), exists: () => false, data: () => ({}) });
  const stubs = {
    initializeApp: () => ({}), getApps: () => [], getAuth: () => ({}),
    onAuthStateChanged: (a, cb) => { authCb = cb; },
    getFirestore: () => ({}), doc: (...a) => ({ path: a.slice(1).join('/') }), collection: (...a) => ({ path: a.slice(1).join('/') }),
    getDoc: async (ref) => { reads.push(ref.path); return snap([]); },
    getDocs: async (ref) => { reads.push(ref.path); return snap(/ds_workouts/.test(ref.path) ? (o.cloudWorkouts || []) : []); },
    setDoc: async () => {},
    writeBatch: () => {
      const paths = [];
      return {
        set: (ref) => { paths.push(ref.path); },
        commit: async () => {
          if (o.failPagesCommit && paths.some((p) => /ds_pages|ds_meta/.test(p))) throw new Error('pages commit denied');
          paths.forEach((p) => writes.push(p));
        },
      };
    },
    serverTimestamp: () => 'ts', connectEmulatorsIfLocal: async () => {},
  };
  const body = SYNC_SRC.replace(/^import [\s\S]*?from '[^']+';\n/gm, '');
  const ctx = vm.createContext(Object.assign({ window, document, localStorage, console: { log() {}, warn() {}, error() {} }, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, JSON, Date, Math, Promise, Map, Set, Object, Array, String, Number, Error }, stubs));
  vm.runInContext('(async () => {\n' + body + '\n})();', ctx, { filename: 'ds-firebase-sync.js' });
  return {
    store, writes, reads, badges, badge, window, advance,
    signIn: async (uid) => { while (!authCb) await new Promise((r) => setImmediate(r)); await authCb({ uid }); await flush(); },
  };
}
const visible = (p) => p.badge.style.opacity === '1';

(async () => {
  console.log('\n1. the pill: a failed save stays on screen');
  {
    const p = boot({ failPagesCommit: true });
    await p.signIn('U1');
    await p.advance(10000); // let the sign-in badges expire
    ok('control: the pill is hidden once the sign-in messages expire', !visible(p), p.badge.style.opacity);
    p.window.savePages();
    ok('"Saving..." shows right after a save', p.badge.textContent === 'Saving...' && visible(p));
    await p.advance(2000); // the debounce fires; the push fails
    ok('"Sync failed" appears when the push fails', p.badge.textContent === 'Sync failed' && visible(p), p.badge.textContent);
    await p.advance(500); // t = 2500: past the old "Saving..." timer (2400)
    ok('...and is STILL visible after the stale Saving timer would have fired (the bug hid it here)', visible(p) && p.badge.textContent === 'Sync failed', p.badge.style.opacity);
    await p.advance(2500); // t = 5000
    ok('...and an error stays up several seconds (still visible 3 s after it appeared)', visible(p));
    await p.advance(8000);
    ok('...then hides', !visible(p));
  }
  {
    const p = boot();
    await p.signIn('U1');
    await p.advance(10000);
    p.window.savePages();
    await p.advance(2000);
    ok('success: "Synced" shows after a good push', p.badge.textContent === 'Synced' && visible(p), p.badge.textContent);
    await p.advance(2500);
    ok('...and a success pill still hides on the short timer', !visible(p));
  }

  console.log('\n2. a failing pages push does not skip the workout sync');
  {
    const cloudW = { id: 'w-cloud', date: '2026-10-01', mt: 500, exercises: [] };
    const p = boot({ failPagesCommit: true, cloudWorkouts: [cloudW] });
    await p.signIn('U1');
    ok('the pages push failed (control: it was attempted and rejected)', p.badges.includes('Sync error'), JSON.stringify(p.badges));
    ok('workouts were still pulled from the cloud', p.reads.some((r) => /ds_workouts/.test(r)), JSON.stringify(p.reads));
    ok('...and the cloud workout reached the phone', /w-cloud/.test(p.store.get('nbd_ds_workouts') || ''), String(p.store.get('nbd_ds_workouts')));
    ok('a failure is surfaced, not swallowed: the pill is not left on a success message', p.badge.textContent === 'Sync error', p.badge.textContent);
  }
  {
    const p = boot({ storage: { nbd_ds_workouts: [{ id: 'w-local', date: '2026-10-02', mt: 900, exercises: [] }] } });
    await p.signIn('U1');
    ok('control: with nothing failing, a local-only workout is pushed and the success pill shows', p.writes.some((w) => /ds_workouts\/w-local/.test(w)) && /days loaded/.test(p.badge.textContent), p.badge.textContent);
  }

  console.log('\n3. a localStorage write failure cannot abort the workout pushes');
  {
    const p = boot({
      throwOnSetKeys: ['nbd_ds_workouts'],
      storage: { nbd_ds_workouts: [{ id: 'w-local', date: '2026-10-02', mt: 900, exercises: [] }] },
      cloudWorkouts: [{ id: 'w-cloud', date: '2026-10-01', mt: 500, exercises: [] }],
    });
    await p.signIn('U1');
    ok('the local-only workout is still pushed to the cloud', p.writes.some((w) => /ds_workouts\/w-local/.test(w)), JSON.stringify(p.writes));
    ok('the failure is shown (not silent)', p.badge.textContent === 'Sync error' && p.badges.includes('Sync error'), JSON.stringify(p.badges));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
