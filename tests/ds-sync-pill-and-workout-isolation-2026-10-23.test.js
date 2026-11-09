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
  const document = { getElementById: () => null, createElement: () => badge, body: { appendChild() {} }, activeElement: null };
  const chipEvents = [];
  let loads = 0, refreshes = 0;
  const window = {
    NBDDsSync: L, NBDSyncChip: require(path.join(ROOT, 'docs', 'pro', 'daily-success', 'js', 'sync-chip-logic.js')),
    dispatchEvent: (e) => { if (e.type === 'nbd-ds-sync') chipEvents.push(e.detail); return true; }, loadPages() { loads++; }, dsRefreshView() { refreshes++; },
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
    getDocs: async (ref) => { reads.push(ref.path); if (o.failWorkoutRead && /ds_workouts/.test(ref.path)) throw new Error('workouts read denied'); return snap(/ds_workouts/.test(ref.path) ? (o.cloudWorkouts || []) : (o.cloudPages || [])); },
    setDoc: async (ref) => { if (o.failSettings && /userSettings/.test(ref.path)) throw new Error('settings denied'); if (o.failWorkoutSet && /ds_workouts/.test(ref.path)) throw new Error('workout set denied'); },
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
  const ctx = vm.createContext(Object.assign({ window, document, localStorage, CustomEvent: class { constructor(n, i) { this.type = n; this.detail = i && i.detail; } }, console: { log() {}, warn() {}, error() {} }, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, JSON, Date, Math, Promise, Map, Set, Object, Array, String, Number, Error }, stubs));
  vm.runInContext('(async () => {\n' + body + '\n})();', ctx, { filename: 'ds-firebase-sync.js' });
  return {
    store, writes, reads, badges, badge, window, document, advance, opts: o, chipEvents, counts: () => ({ loads, refreshes }),
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

  console.log('\n4. the sync chip: a failure is retried with backoff, quietly, and a tap retries at once (audit M9)');
  {
    const p = boot({ failPagesCommit: true });
    await p.signIn('U1');
    const states = () => p.chipEvents.map((e) => e.cloud);
    const fails = () => states().filter((c) => c === 'failed').length;
    ok('a failed sync tells the chip: failed', states().slice(-1)[0] === 'failed', JSON.stringify(states()));
    const n0 = fails();
    await p.advance(1500);
    ok('...no retry before the first backoff step (2 s)', fails() === n0, JSON.stringify(states()));
    await p.advance(700);
    ok('...a retry after it, by itself', fails() === n0 + 1, JSON.stringify(states()));
    await p.advance(3000);
    ok('...the next step is longer (5 s), not another 2 s', fails() === n0 + 1, JSON.stringify(states()));
    await p.advance(3000);
    ok('...and it does come', fails() === n0 + 2, JSON.stringify(states()));
    ok('...without flashing the pill (the retry is the chip\'s business)', p.badge.style.opacity !== '1' || p.badge.textContent === 'Sync failed', p.badge.textContent);
    p.opts.failPagesCommit = false;
    await p.window.NBDDsCloud.retry();
    await p.advance(0);
    ok('a tap on the chip (NBDDsCloud.retry) pushes at once and the chip goes to synced with a time', states().slice(-1)[0] === 'synced' && p.chipEvents.slice(-1)[0].at > 0, JSON.stringify(states()));
    ok('...and the retries stop (nothing further fails or syncs once it is synced)', (await p.advance(400000), states().slice(-1)[0] === 'synced'), JSON.stringify(states().slice(-3)));
  }
  {
    const p = boot();
    await p.signIn('U1');
    ok('signing in tells the chip: syncing, then synced', p.chipEvents.some((e) => e.cloud === 'syncing' && e.signedIn === true) && p.chipEvents.slice(-1)[0].cloud === 'synced', JSON.stringify(p.chipEvents));
  }

  console.log('\n5. the chip never says SYNCED over a failed write, and a retry never races or eats typing (review fixes)');
  const last = (p) => p.chipEvents.slice(-1)[0].cloud;
  {
    const p = boot({ failSettings: true, storage: { nbd_ds_food: { favs: [] }, nbd_ds_food_at: '5' } });
    await p.signIn('U1');
    ok('a denied settings write on the first sync leaves the chip failed, not synced', last(p) === 'failed', JSON.stringify(p.chipEvents.map((e) => e.cloud)));
  }
  {
    const p = boot({ storage: { nbd_ds_food: { favs: [] }, nbd_ds_food_at: '5' } });
    await p.signIn('U1');
    p.opts.failSettings = true;
    const r = await p.window.NBDDsCloud.pushSettings();
    ok('pushSettings reports false when the write fails', r === false, String(r));
    ok('...and tells the chip: failed (a retry is scheduled)', last(p) === 'failed', JSON.stringify(p.chipEvents.map((e) => e.cloud)));
    await p.window.NBDDsCloud.retry();
    ok('a retry whose settings write still fails stays failed (the old code said synced here)', last(p) === 'failed', JSON.stringify(p.chipEvents.map((e) => e.cloud)));
    p.opts.failSettings = false;
    await p.window.NBDDsCloud.retry();
    ok('...and goes synced once the write goes through', last(p) === 'synced');
  }
  {
    const p = boot({ failWorkoutRead: true });
    await p.signIn('U1');
    ok('a workout read that fails on sign-in leaves the chip failed, not synced', last(p) === 'failed', JSON.stringify(p.chipEvents.map((e) => e.cloud)));
  }
  {
    const p = boot();
    await p.signIn('U1');
    p.opts.failWorkoutSet = true;
    const ok1 = await p.window.NBDDsCloud.pushWorkout({ id: 'w-new', mt: 5 });
    ok('a finished workout that fails to reach the cloud returns false and turns the chip failed', ok1 === false && last(p) === 'failed', last(p));
    p.opts.failWorkoutSet = false;
    p.store.set('nbd_ds_workouts', JSON.stringify([{ id: 'w-new', date: '2026-10-02', mt: 5, exercises: [] }]));
    await p.advance(2500);
    ok('...and the retry sends the workout (nothing waits for the next sign-in)', p.writes.some((w) => /ds_workouts\/w-new/.test(w)) && last(p) === 'synced', JSON.stringify(p.writes));
  }
  {
    const p = boot({ failPagesCommit: true });
    await p.signIn('U1');
    p.reads.length = 0;
    const a = p.window.NBDDsCloud.retry(), b = p.window.NBDDsCloud.retry(), c = p.window.NBDDsCloud.retry();
    await Promise.all([a, b, c]);
    ok('three overlapping retries run one merge (one pages read), not three', p.reads.filter((r) => /ds_pages/.test(r)).length === 1, JSON.stringify(p.reads));
  }
  {
    const cloudPage = { id: 7, dk: '2026-10-01', mt: 900, data: { x: 1 } };
    const p = boot({ cloudPages: [cloudPage], failWorkoutRead: true });
    p.document.activeElement = { tagName: 'INPUT' };
    await p.signIn('U1');
    ok('while an input has focus a merge does not overwrite the phone copy or redraw', p.counts().loads === 0 && p.counts().refreshes === 0 && !/"id":7/.test(p.store.get('nbd_dsp_v1') || ''), JSON.stringify(p.counts()));
    ok('...and the chip is not left claiming synced', last(p) !== 'synced', last(p));
    p.opts.failWorkoutRead = false;
    p.document.activeElement = null;
    await p.advance(5000);
    ok('once the field loses focus the next retry applies the cloud copy and redraws once', /"id":7/.test(p.store.get('nbd_dsp_v1') || '') && p.counts().refreshes === 1, JSON.stringify(p.counts()));
    ok('...and the chip reaches synced', last(p) === 'synced', last(p));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
