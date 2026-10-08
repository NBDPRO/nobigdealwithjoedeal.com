/**
 * tests/offline-safety-2026-10-04.test.js — the installed iPhone app on a roof
 * with bad signal (behavioural: every module below is RUN, not grepped).
 *
 *   1. nbd-auth.js init: Firestore gets a PERSISTENT local cache (single-tab
 *      on iOS, multi-tab elsewhere, memory on the kill switch) and keeps
 *      long polling — so an offline edit survives iOS killing the app.
 *   2. nbd-auth.js boot read: a subscription "missing" answered from the
 *      on-phone cache is a network error, not "this account never paid".
 *   3. nbd-auth.js sign-out: the door-knock queue survives the nbd_ purge;
 *      the Firestore cache is cleared only when no edit is still queued.
 *   4. offline-sync-status.js: counts Firestore's queued batches from its
 *      IndexedDB mutation store (this user only), shows the badge, settle()
 *      returns 'queued' offline instead of hanging, and a "Saved" toast says
 *      "Saved on phone — will sync" while writes are pending.
 *   5. d2d-tracker-core: the knock queue flush sends only the signed-in
 *      rep's knocks; knock photos are resized, and held in the durable photo
 *      queue when offline / on failure, then attached to their knock.
 *
 * Run: node tests/offline-safety-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const AUTH_SRC = read('docs/pro/js/nbd-auth.js');
const SYNC_SRC = read('docs/pro/js/offline-sync-status.js');
const D2D_SRC = read('docs/pro/js/d2d-tracker-core-2026b.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
async function guard(fn) {
  try { await fn(); } catch (e) { failed++; fails.push('section threw: ' + e.message); console.log('  ✗ section threw: ' + e.message); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

function fakeLocalStorage(seed) {
  const m = new Map(Object.entries(seed || {}));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] || null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _m: m,
  };
}

// ── nbd-auth.js as a classic script: imports become injected mocks ──
function loadAuth(opts) {
  const o = opts || {};
  const calls = { initializeFirestore: [], terminate: 0, clear: 0, tabManagers: [] };
  let authCb = null;
  const sdk = {
    initializeApp: () => ({ name: '[DEFAULT]', options: { projectId: 'nobigdeal-pro' } }),
    getAuth: () => ({ currentUser: o.user || null }),
    onAuthStateChanged: (_a, cb) => { authCb = cb; },
    signOut: async () => {},
    getFirestore: () => ({ kind: 'existing' }),
    initializeFirestore: (_app, settings) => { calls.initializeFirestore.push(settings); return { kind: 'db', settings }; },
    doc: (_db, col, id) => ({ path: col + '/' + id }),
    getDoc: async (ref) => (o.getDoc ? o.getDoc(ref) : { exists: () => false, metadata: { fromCache: false } }),
    persistentLocalCache: (s) => ({ kind: 'persistent', tabManager: s && s.tabManager }),
    persistentSingleTabManager: (s) => { calls.tabManagers.push('single'); return { kind: 'single', s }; },
    persistentMultipleTabManager: () => { calls.tabManagers.push('multi'); return { kind: 'multi' }; },
    memoryLocalCache: () => ({ kind: 'memory' }),
    waitForPendingWrites: async () => {},
    terminate: async () => { calls.terminate++; },
    clearIndexedDbPersistence: async () => { calls.clear++; },
    initializeAppCheck: () => ({}), ReCaptchaEnterpriseProvider: function () {}, CustomProvider: function () {},
    connectEmulatorsIfLocal: () => Promise.resolve(), isLocalEmulatorEnv: () => false, emulatorAppCheckFakeToken: () => '',
  };
  let src = AUTH_SRC
    .replace(/^import \{([^}]*)\} from "[^"]+";$/gm, (_m, names) => 'const {' + names + '} = __sdk;')
    .replace(/^export const NBDAuth/m, 'const NBDAuth') + '\n;window.__NBDAuthForTest = NBDAuth;';
  const ls = fakeLocalStorage(o.localStorage);
  const win = {
    location: { search: o.search || '', replace: () => {}, href: '' },
    __NBD_APP_CHECK_KEY: '',
    __nbdLoadErrors: [],
    NBDOfflineSync: o.sync,
    NBDSmsOutbox: { purgeAll: async () => true },
  };
  win.window = win;
  const ctx = vm.createContext(Object.assign(win, {
    __sdk: sdk,
    navigator: { userAgent: o.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130', platform: o.platform || 'Win32', maxTouchPoints: o.touch || 0 },
    localStorage: ls,
    indexedDB: o.noIDB ? undefined : {},
    document: { createElement: () => ({}), head: { appendChild() {} }, documentElement: { style: {} }, addEventListener() {}, getElementById: () => null },
    console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, Promise, Date, Math, JSON, Object, Array, String, Number, Set, Map, Error, RegExp,
    sessionStorage: fakeLocalStorage(),
  }));
  vm.runInContext(src, ctx, { filename: 'nbd-auth.js' });
  return { NBDAuth: win.__NBDAuthForTest, calls, win, ls, fireAuth: (u) => authCb && authCb(u) };
}

// ── a fake IndexedDB holding Firestore's database ──
function fakeFirestoreIDB(dbs) {
  return {
    open(name) {
      const req = {};
      setTimeout(() => {
        const rows = dbs[name];
        if (!rows) {
          const tx = { abort() { req.__aborted = true; } };
          if (req.onupgradeneeded) req.onupgradeneeded({ target: { transaction: tx, result: {} } });
          if (req.__aborted) { if (req.onerror) req.onerror(); return; }
        }
        const db = {
          objectStoreNames: { contains: (s) => s === 'mutations' && !!rows },
          close() {},
          transaction() {
            const tx = {};
            tx.objectStore = () => ({
              openCursor() {
                const cur = {};
                let i = 0;
                const step = () => setTimeout(() => {
                  if (i < rows.length) {
                    const v = rows[i++];
                    cur.result = { value: v, continue: step };
                  } else { cur.result = null; setTimeout(() => tx.oncomplete && tx.oncomplete(), 0); }
                  cur.onsuccess && cur.onsuccess();
                }, 0);
                step();
                return cur;
              },
            });
            return tx;
          },
        };
        req.result = db;
        req.onsuccess && req.onsuccess();
      }, 0);
      return req;
    },
  };
}

function loadSync(o) {
  const opts = o || {};
  const toasts = [];
  const body = { children: [], appendChild(el) { this.children.push(el); } };
  const els = {};
  const document = {
    body,
    visibilityState: 'visible',
    addEventListener() {},
    getElementById: (id) => els[id] || null,
    createElement: () => {
      const el = { hidden: false, textContent: '', style: { _p: {}, setProperty(k, v) { this._p[k] = v; }, removeProperty(k) { delete this._p[k]; } }, classList: { _s: new Set(), toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } }, setAttribute() {} };
      Object.defineProperty(el, 'id', { set(v) { els[v] = el; this._id = v; }, get() { return this._id; } });
      return el;
    },
  };
  const nav = { onLine: opts.onLine !== false };
  const win = {
    _user: { uid: 'rep-a' },
    _firebaseApp: { options: { projectId: 'nobigdeal-pro' } },
    __NBD_FS_CACHE: opts.mode || 'single',
    NBDFirestoreSync: { waitForPendingWrites: opts.wait || (() => new Promise(() => {})), cacheMode: () => opts.mode || 'single' },
    indexedDB: fakeFirestoreIDB(opts.dbs || {}),
    showToast: (m, t) => toasts.push([m, t]),
    addEventListener() {},
  };
  win.window = win;
  const ctx = vm.createContext(Object.assign(win, { navigator: nav, document, console, setTimeout, clearTimeout, setInterval: () => 0, Promise, Math, String, Number, Object, Array }));
  vm.runInContext(SYNC_SRC, ctx, { filename: 'offline-sync-status.js' });
  return { S: win.NBDOfflineSync, win, nav, toasts, els };
}

(async () => {
  console.log('\n1. Firestore starts with a persistent on-phone cache');
  await guard(async () => {
    const iphone = loadAuth({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
    iphone.NBDAuth.init({ requiredPlan: 'free' });
    const s = iphone.calls.initializeFirestore[0] || {};
    ok('long polling kept (iOS transport fix)', s.experimentalForceLongPolling === true, JSON.stringify(s));
    ok('iPhone: persistentLocalCache with the SINGLE-tab manager', s.localCache && s.localCache.kind === 'persistent' && s.localCache.tabManager && s.localCache.tabManager.kind === 'single', JSON.stringify(s.localCache));
    ok('cache mode published for the sync badge', iphone.win.__NBD_FS_CACHE === 'single' && iphone.win.NBDFirestoreSync && typeof iphone.win.NBDFirestoreSync.waitForPendingWrites === 'function');
    const ipad = loadAuth({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', platform: 'MacIntel', touch: 5 });
    ipad.NBDAuth.init({ requiredPlan: 'free' });
    ok('iPadOS (reports as a Mac with touch) → single-tab too', (ipad.calls.initializeFirestore[0].localCache.tabManager || {}).kind === 'single');
    const desk = loadAuth({});
    desk.NBDAuth.init({ requiredPlan: 'free' });
    const d = desk.calls.initializeFirestore[0];
    ok('desktop: persistent cache with the MULTI-tab manager (dashboard + customer tabs)', d.localCache.kind === 'persistent' && d.localCache.tabManager.kind === 'multi' && d.experimentalForceLongPolling === true);
    const off = loadAuth({ search: '?nopersist=1' });
    off.NBDAuth.init({ requiredPlan: 'free' });
    ok('kill switch ?nopersist=1 → memory cache', off.calls.initializeFirestore[0].localCache.kind === 'memory' && off.win.__NBD_FS_CACHE === 'memory');
    const noidb = loadAuth({ noIDB: true });
    noidb.NBDAuth.init({ requiredPlan: 'free' });
    ok('no IndexedDB → memory cache (never a crash)', noidb.calls.initializeFirestore[0].localCache.kind === 'memory');
  });

  console.log('\n2. Boot reads: a cached "missing" is not "missing"');
  await guard(async () => {
    const a = loadAuth({
      getDoc: async (ref) => ref.path.startsWith('subscriptions/')
        ? { exists: () => false, data: () => ({}), metadata: { fromCache: true } }
        : { exists: () => true, data: () => ({ role: 'member' }), metadata: { fromCache: false } },
    });
    const p = a.NBDAuth.init({ requiredPlan: 'free', showUpgradeWall: false });
    a.fireAuth({ uid: 'u1', email: 'rep@x.test', getIdTokenResult: async () => ({ claims: {} }) });
    await p;
    ok('subscription "missing" from the on-phone cache → network_error, not "no subscription"',
      a.NBDAuth.subscription && a.NBDAuth.subscription.status === 'network_error', JSON.stringify(a.NBDAuth.subscription));
    const b = loadAuth({ getDoc: async () => ({ exists: () => false, data: () => ({}), metadata: { fromCache: false } }) });
    const pb = b.NBDAuth.init({ requiredPlan: 'free', showUpgradeWall: false });
    b.fireAuth({ uid: 'u1', email: 'rep@x.test', getIdTokenResult: async () => ({ claims: {} }) });
    await pb;
    ok('a SERVER "missing" is still read as no subscription', b.NBDAuth.subscription === null);
  });

  console.log('\n3. Sign-out: knock queue kept, Firestore cache cleared only when nothing is queued');
  await guard(async () => {
    const knock = JSON.stringify([{ action: 'submitKnock', data: { address: '1 Main' }, uid: 'rep-a' }]);
    const a = loadAuth({ localStorage: { nbd_d2d_sync_queue: knock, nbd_d2d_queue_last_known_size: '1', nbd_leads_cache: 'pii', 'nbd-theme': 'dark' } });
    await a.NBDAuth.purgeAccountStorage();
    ok('nbd_d2d_sync_queue survives the sign-out purge', a.ls.getItem('nbd_d2d_sync_queue') === knock);
    ok('…with its size counter (loss detector stays truthful)', a.ls.getItem('nbd_d2d_queue_last_known_size') === '1');
    ok('other nbd_ account data is still purged', a.ls.getItem('nbd_leads_cache') === null && a.ls.getItem('nbd-theme') === 'dark');

    const pend = loadAuth({ sync: { countPending: async () => 2 } });
    pend.NBDAuth.init({ requiredPlan: 'free' });
    ok('2 edits still queued → cache KEPT (they exist nowhere else)', (await pend.NBDAuth.clearFirestoreCache()) === 'kept-pending' && pend.calls.terminate === 0 && pend.calls.clear === 0);
    const unk = loadAuth({ sync: { countPending: async () => null } });
    unk.NBDAuth.init({ requiredPlan: 'free' });
    ok('unknown count → kept (never risk a queued edit)', (await unk.NBDAuth.clearFirestoreCache()) === 'kept-pending' && unk.calls.clear === 0);
    const none = loadAuth({ sync: { countPending: async () => 0 } });
    none.NBDAuth.init({ requiredPlan: 'free' });
    ok('nothing queued → terminate + clear the on-phone customer cache', (await none.NBDAuth.clearFirestoreCache()) === 'cleared' && none.calls.terminate === 1 && none.calls.clear === 1);
  });

  console.log('\n4. offline-sync-status: count, badge, settle, toast');
  await guard(async () => {
    const DB = 'firestore/[DEFAULT]/nobigdeal-pro/main';
    const q = loadSync({ dbs: { [DB]: [{ userId: 'rep-a', batchId: 1 }, { userId: 'rep-a', batchId: 2 }, { userId: 'rep-b', batchId: 3 }] } });
    ok('database name is the SDK\'s', q.S.dbName() === DB);
    ok('counts THIS user\'s queued batches from the mutation store', (await q.S.countPending()) === 2);
    ok('anyUser counts everyone\'s (sign-out check)', (await q.S.countPending({ anyUser: true })) === 3);
    await q.S.refresh();
    const badge = q.els.nbdSyncBadge;
    ok('badge shows "2 changes waiting to sync"', badge && !badge.hidden && /2 changes waiting to sync/.test(badge.textContent), badge && badge.textContent);
    ok('a plain "saved" toast says Saved on phone while writes wait', q.S.toastText('✓ Company info saved', 'success') === 'Saved on phone — will sync');
    ok('…but never rewrites an error, a warning or a not-saved message',
      q.S.toastText('Estimate not saved: x', 'error') === 'Estimate not saved: x'
      && q.S.toastText('Saved — but the link was cleared', 'warning') === 'Saved — but the link was cleared'
      && q.S.toastText("Couldn't place this address on the map — changes still saved", 'info') === "Couldn't place this address on the map — changes still saved");
    q.win._wrapped = null;
    q.S._wrapToast();
    q.win.showToast('Settings saved!', 'success');
    ok('window.showToast is wrapped: the shown text is the honest one', q.toasts.length === 1 && q.toasts[0][0] === 'Saved on phone — will sync', JSON.stringify(q.toasts));

    const none = loadSync({ dbs: { [DB]: [] } });
    await none.S.refresh();
    ok('nothing queued → no badge, toast unchanged', !none.els.nbdSyncBadge && none.S.toastText('Settings saved!', 'success') === 'Settings saved!');
    const fresh = loadSync({ dbs: {} });
    ok('no Firestore database yet → 0, and looking does not create one', (await fresh.S.countPending()) === 0);
    const mem = loadSync({ mode: 'memory', dbs: { [DB]: [{ userId: 'rep-a' }] } });
    ok('memory cache → unknown (null), not 0', (await mem.S.countPending()) === null);

    const offline = loadSync({ onLine: false, dbs: { [DB]: [] } });
    let resolveWrite;
    const write = new Promise((r) => { resolveWrite = r; });
    const t0 = Date.now();
    const st = await Promise.race([offline.S.settle(write), tick(1500).then(() => 'HUNG')]);
    ok('offline: settle() returns "queued" at once instead of hanging the Save', st === 'queued' && Date.now() - t0 < 500, st);
    ok('…and the badge appears straight away', offline.els.nbdSyncBadge && /waiting to sync · offline/.test(offline.els.nbdSyncBadge.textContent), offline.els.nbdSyncBadge && offline.els.nbdSyncBadge.textContent);
    ok('…and a following "saved" toast is honest', offline.S.toastText('Lead saved', 'success') === 'Saved on phone — will sync');
    resolveWrite();
    const online = loadSync({ dbs: { [DB]: [] } });
    ok('online: an acked write settles "synced"', (await online.S.settle(Promise.resolve())) === 'synced');
    let rejected = null;
    try { await online.S.settle(Promise.reject(Object.assign(new Error('nope'), { code: 'permission-denied' }))); } catch (e) { rejected = e; }
    ok('online: a refused write still rejects (save handler shows its error)', rejected && rejected.code === 'permission-denied');
  });

  console.log('\n5. Door knocks: owned queue, held photos');
  await guard(async () => {
    // Lift the real functions out of the D2D core IIFE and run them.
    const pick = (name) => {
      const re = new RegExp('\\n  (async )?function ' + name + '\\(');
      const m = re.exec(D2D_SRC);
      if (!m) throw new Error('missing ' + name);
      const start = m.index + 1;
      let i = D2D_SRC.indexOf('{', start), depth = 0;
      for (; i < D2D_SRC.length; i++) { const c = D2D_SRC[i]; if (c === '{') depth++; else if (c === '}') { depth--; if (!depth) break; } }
      return D2D_SRC.slice(start, i + 1);
    };
    const names = ['saveOfflineQueue', 'enqueueOffline', 'flushOfflineQueue', 'inferImageContentType', 'resizeKnockPhoto', '_knockPhotoStore', '_uploadKnockBlob', 'uploadPhotos', '_knockDocIdForTemp', 'flushKnockPhotoQueue', '_withTimeout'];
    const body = names.map(pick).join('\n') + '\nlet _knockPhotoDraining = false;\nconst D2D_QUEUE_MAX = 500, SYNC_QUEUE_KEY = "nbd_d2d_sync_queue", D2D_QUEUE_LAST_KNOWN_KEY = "nbd_d2d_queue_last_known_size", KNOCK_PHOTO_MAX_DIM = 1600, KNOCK_PHOTO_QUALITY = 0.82;';
    function d2d(opts) {
      const o = opts || {};
      const ls = fakeLocalStorage();
      const sent = [], updates = [], uploads = [], toasts = [], removed = [];
      const rows = (o.rows || []).slice();
      const store = {
        add: async (item) => { rows.push(Object.assign({ id: rows.length + 100 }, item)); return rows.length + 99; },
        all: async () => rows.slice(),
        available: async () => true,
        remove: async (id) => { removed.push(id); const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); return true; },
      };
      const state = { offlineQueue: (o.queue || []).slice(), isOnline: o.online !== false, knocks: o.knocks || [] };
      const win = {
        _user: { uid: o.uid || 'rep-a' },
        showToast: (m, t) => toasts.push([m, t]),
        NBDPhotoQueueStore: o.noStore ? undefined : store,
        uploadBytes: async (ref, blob, meta) => { if (o.uploadFails) throw new Error('network'); uploads.push({ path: ref.path, size: blob.size, type: meta && meta.contentType }); },
        updateDoc: async (ref, patch) => { updates.push({ ref, patch }); },
        doc: (_db, c, id) => ({ c, id }),
        arrayUnion: (v) => ({ union: v }),
        serverTimestamp: () => 'ts',
        query: (...a) => a, collection: () => 'knocks', where: (...a) => a, limit: (n) => n,
        getDocs: async () => (o.serverKnock ? { empty: false, docs: [{ id: o.serverKnock }] } : { empty: true, docs: [] }),
        _db: {}, _storage: {},
      };
      win.window = win;
      const ctx = vm.createContext(Object.assign(win, {
        state, localStorage: ls, console: { log() {}, warn() {}, error() {} }, navigator: { onLine: o.online !== false },
        setTimeout, clearTimeout, Promise, Date, Math, JSON, Object, Array, String, Number, Blob, URL,
        submitKnock: async (data) => { sent.push(data.address); return 'k1'; },
        updateKnock: async () => {}, deleteKnock: async () => {}, loadKnocks: async () => {},
        createImageBitmap: o.decodes === false ? undefined : async () => ({ width: 4032, height: 3024, close() {} }),
        Image: undefined,
        document: { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob(cb, type) { cb(new Blob([new Uint8Array(1200)], { type })); } }) },
      }));
      vm.runInContext(body.replace("await import('/assets/vendor/firebase/10.12.2/firebase-storage.js')", '({ ref: (_s, p) => ({ path: p }), getDownloadURL: async (r) => "https://x/" + r.path })'), ctx, { filename: 'd2d-core-lifted.js' });
      return { ctx, state, ls, sent, updates, uploads, toasts, rows, removed, win };
    }

    const mine = { action: 'submitKnock', data: { address: '1 Mine St' }, uid: 'rep-a' };
    const legacy = { action: 'submitKnock', data: { address: '2 Old St' } };
    const theirs = { action: 'submitKnock', data: { address: '3 Theirs St' }, uid: 'rep-b' };
    const k = d2d({ queue: [mine, legacy, theirs] });
    await vm.runInContext('flushOfflineQueue()', k.ctx);
    ok('flush sends the signed-in rep\'s knocks (and pre-ownership ones)', k.sent.join('|') === '1 Mine St|2 Old St', k.sent.join('|'));
    ok('…and leaves another rep\'s knock queued on the phone for them', k.state.offlineQueue.length === 1 && k.state.offlineQueue[0].uid === 'rep-b'
      && JSON.parse(k.ls.getItem('nbd_d2d_sync_queue')).length === 1);
    const e = d2d({});
    vm.runInContext("enqueueOffline('submitKnock', { address: '9 New Rd' })", e.ctx);
    ok('a knock queued offline records who knocked', e.state.offlineQueue[0].uid === 'rep-a');

    const file = new Blob([new Uint8Array(4 * 1024 * 1024)], { type: 'image/jpeg' });
    file.name = 'IMG_0001.JPG';
    const up = d2d({ online: true });
    const res = await vm.runInContext('uploadPhotos', up.ctx)([file], '1728050000000');
    ok('online: the RESIZED jpeg is uploaded, not the 4 MB original', up.uploads.length === 1 && up.uploads[0].size === 1200 && up.uploads[0].type === 'image/jpeg' && res.length === 1, JSON.stringify(up.uploads));
    ok('…under photos/{uid}/d2d/{knock id}/', /^photos\/rep-a\/d2d\/1728050000000\/.+\.jpg$/.test(up.uploads[0].path) && res.paths[0] === up.uploads[0].path);

    const offline = d2d({ online: false });
    const r2 = await vm.runInContext('uploadPhotos', offline.ctx)([file], '1728050000001');
    ok('offline: the photo is HELD in the durable photo queue, not dropped', offline.rows.length === 1 && offline.rows[0].kind === 'knock'
      && offline.rows[0].knockTempId === '1728050000001' && offline.rows[0].uid === 'rep-a' && offline.rows[0].blob.size === 1200 && r2.queued === 1 && r2.length === 0, JSON.stringify(offline.rows.map((r) => ({ kind: r.kind, t: r.knockTempId }))));
    ok('…and the rep is told it is on the phone', offline.toasts.some(([m]) => /saved on this phone/i.test(m)));
    const failing = d2d({ online: true, uploadFails: true });
    await vm.runInContext('uploadPhotos', failing.ctx)([file], '1728050000002');
    ok('a failed upload (timeout / dead signal) is held too', failing.rows.length === 1 && failing.rows[0].knockTempId === '1728050000002');

    const drain = d2d({ online: true, rows: [
      { id: 7, kind: 'knock', knockTempId: 'T1', uid: 'rep-a', blob: new Blob([new Uint8Array(900)], { type: 'image/jpeg' }), uploadId: 'p1.jpg' },
      { id: 8, kind: 'knock', knockTempId: 'T2', uid: 'rep-b', blob: new Blob([new Uint8Array(900)], { type: 'image/jpeg' }), uploadId: 'p2.jpg' },
      { id: 9, kind: 'lead', leadId: 'L1', uid: 'rep-a', blob: new Blob([new Uint8Array(900)]) },
    ], knocks: [{ id: 'knockDoc1', clientTempId: 'T1' }] });
    const n = await vm.runInContext('flushKnockPhotoQueue()', drain.ctx);
    ok('drain: my held knock photo is uploaded and attached to its knock', n === 1 && drain.updates.length === 1 && drain.updates[0].ref.id === 'knockDoc1'
      && drain.updates[0].patch.photoUrls.union === 'https://x/photos/rep-a/d2d/T1/p1.jpg' && drain.updates[0].patch.photoPaths.union === 'photos/rep-a/d2d/T1/p1.jpg', JSON.stringify(drain.updates));
    ok('…then removed from the queue; another rep\'s and customer photos untouched', drain.removed.join() === '7' && drain.rows.map((r) => r.id).join() === '8,9');
    const waiting = d2d({ online: true, rows: [{ id: 5, kind: 'knock', knockTempId: 'T9', uid: 'rep-a', blob: new Blob([new Uint8Array(9)]) }] });
    const n2 = await vm.runInContext('flushKnockPhotoQueue()', waiting.ctx);
    ok('a photo whose knock is not on the server yet stays queued', n2 === 0 && waiting.rows.length === 1 && waiting.uploads.length === 0);
    const viaQuery = d2d({ online: true, serverKnock: 'knockDoc2', rows: [{ id: 6, kind: 'knock', knockTempId: 'T6', uid: 'rep-a', blob: new Blob([new Uint8Array(9)]) }] });
    ok('a knock synced from the offline queue is found by its clientTempId', (await vm.runInContext('flushKnockPhotoQueue()', viaQuery.ctx)) === 1 && viaQuery.updates[0].ref.id === 'knockDoc2');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); console.log('\n' + passed + ' passed, ' + (failed + 1) + ' failed'); process.exit(1); });
