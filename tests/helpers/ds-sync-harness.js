/**
 * tests/helpers/ds-sync-harness.js — runs the REAL Daily Success cloud sync
 * (docs/pro/daily-success/ds-firebase-sync.js) in a vm with its Firebase
 * imports stubbed by an in-memory "cloud", a virtual clock, and an offline
 * switch that behaves like the vendored Firestore 10.12.2 measured in a real
 * browser on 2026-11-14 (audit #4 repro):
 *   - offline getDocs(query)        → resolves an EMPTY snapshot, metadata.fromCache = true
 *   - offline getDocsFromServer / getDocFromServer → rejects { code: 'unavailable' }
 *   - offline writes (batch.commit / setDoc) are QUEUED and land when back online
 * Not a test itself (no .test.js suffix).
 *
 *   const h = boot({ storage: { nbd_dsp_v1: [...] }, cloud: { 'users/U1/ds_pages/1': {...} }, offline: true });
 *   await h.signIn('U1'); h.goOnline(); await h.advance(5000);
 *   h.cloud (Map path → doc), h.queued, h.chipEvents, h.badges, h.store
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const DS = path.join(ROOT, 'docs', 'pro', 'daily-success');

function boot(opts) {
  const o = opts || {};
  const SRC = fs.readFileSync(path.join(DS, 'ds-firebase-sync.js'), 'utf8').replace(/\r\n/g, '\n');
  const L = require(path.join(DS, 'js', 'ds-sync-logic.js'));
  const store = new Map(Object.entries(o.storage || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  const cloud = new Map(Object.entries(o.cloud || {}).map(([k, v]) => [k, Object.assign({}, v)]));
  const badges = [], chipEvents = [], queued = [];
  let offline = !!o.offline;
  let authCb = null, now = o.now || 1763100000000, nextId = 1;
  const timers = new Map();
  const listeners = {};
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
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
  const FakeDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  const badge = { style: {}, _text: '', set textContent(v) { this._text = v; badges.push(v); }, get textContent() { return this._text; } };
  const document = Object.assign({ getElementById: () => null, createElement: () => badge, body: { appendChild() {} }, activeElement: null, visibilityState: 'visible',
    addEventListener(t, fn) { (listeners['d:' + t] = listeners['d:' + t] || []).push(fn); } }, o.document || {});
  let loads = 0, refreshes = 0;
  const window = Object.assign({
    NBDDsSync: L, NBDSyncChip: require(path.join(DS, 'js', 'sync-chip-logic.js')),
    dispatchEvent: (e) => { if (e.type === 'nbd-ds-sync') chipEvents.push(e.detail); return true; },
    addEventListener: (t, fn) => { (listeners['w:' + t] = listeners['w:' + t] || []).push(fn); },
    loadPages() { loads++; }, dsRefreshView() { refreshes++; },
    savePages() { return true; },
    NBDCoach: { mergeSessions: (a, b) => { const m = new Map(); for (const x of a.concat(b)) { const c = m.get(String(x.id)); if (!c || (x.mt || 0) > (c.mt || 0)) m.set(String(x.id), x); } return [...m.values()]; } },
  }, o.window || {});
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    key: (i) => [...store.keys()][i] || null,
    get length() { return store.size; },
  };
  const navigator = { get onLine() { return !offline; } };
  const unavailable = () => { const e = new Error('Failed to get document from server'); e.code = 'unavailable'; return e; };
  const docsUnder = (p) => [...cloud.entries()].filter(([k]) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')).map(([, v]) => v);
  const qsnap = (docs, fromCache) => ({ size: docs.length, metadata: { fromCache: !!fromCache }, forEach: (fn) => docs.forEach((d) => fn({ data: () => JSON.parse(JSON.stringify(d)) })) });
  const dsnap = (d, fromCache) => ({ metadata: { fromCache: !!fromCache }, exists: () => !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) });
  const apply = (p, data, merge) => { const clean = JSON.parse(JSON.stringify(data)); cloud.set(p, merge ? Object.assign({}, cloud.get(p) || {}, clean) : clean); };
  // offline writes queue (the SDK's pending writes) and land when the network returns
  const write = (p, data, merge) => new Promise((resolve) => {
    if (!offline) { apply(p, data, merge); resolve(); return; }
    queued.push({ p, data: JSON.parse(JSON.stringify(data)), merge, resolve });
  });
  const stubs = {
    initializeApp: () => ({}), getApps: () => [], getAuth: () => ({}),
    onAuthStateChanged: (a, cb) => { authCb = cb; },
    getFirestore: () => ({}), doc: (...a) => ({ path: a.slice(1).join('/') }), collection: (...a) => ({ path: a.slice(1).join('/') }),
    // offline getDoc of a document not in the (memory) cache rejects; a cached one would come back stale (fromCache)
    getDoc: async (ref) => { if (offline) { if (o.cachedDocs && o.cachedDocs[ref.path]) return dsnap(o.cachedDocs[ref.path], true); throw unavailable(); } return dsnap(cloud.get(ref.path), false); },
    getDocFromServer: async (ref) => { if (o.holdReads) await o.holdReads; if (offline) throw unavailable(); if (o.failReads && o.failReads.test(ref.path)) { const e = new Error('read failed'); e.code = 'internal'; throw e; } return dsnap(cloud.get(ref.path), false); },
    getDocs: async (ref) => (offline ? qsnap([], true) : qsnap(docsUnder(ref.path), false)),
    getDocsFromServer: async (ref) => { if (o.holdReads) await o.holdReads; if (offline) throw unavailable(); return qsnap(docsUnder(ref.path), false); },
    setDoc: (ref, data, opt) => write(ref.path, data, !!(opt && opt.merge)),
    writeBatch: () => { const ops = []; return { set: (ref, data, opt) => { ops.push([ref.path, data, !!(opt && opt.merge)]); }, commit: () => Promise.all(ops.map(([p, d, m]) => write(p, d, m))) }; },
    serverTimestamp: () => 'ts', connectEmulatorsIfLocal: async () => {},
  };
  const body = SRC.replace(/^import [\s\S]*?from '[^']+';\n/gm, '');
  const ctx = vm.createContext(Object.assign({ window, document, localStorage, navigator, CustomEvent: class { constructor(n, i) { this.type = n; this.detail = i && i.detail; } }, console: { log() {}, warn() {}, error() {} }, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, JSON, Date: FakeDate, Math, Promise, Map, Set, Object, Array, String, Number, Error }, stubs));
  vm.runInContext('(async () => {\n' + body + '\n})();', ctx, { filename: 'ds-firebase-sync.js' });
  const fire = async (key, ev) => { (listeners[key] || []).forEach((fn) => fn(ev || {})); await flush(); };
  return {
    store, cloud, queued, badges, chipEvents, window, document, advance, flush, counts: () => ({ loads, refreshes }),
    read: (k) => { const v = store.get(k); return v == null ? null : JSON.parse(v); },
    now: () => now, setNow: (t) => { now = t; },
    signIn: async (uid) => { while (!authCb) await new Promise((r) => setImmediate(r)); // not awaited: offline, onAuth waits on queued writes exactly as the real SDK does
      const run = authCb(uid ? { uid } : null); if (run && run.catch) run.catch(() => {}); await flush(); },
    goOffline: () => { offline = true; },
    goOnline: async () => { offline = false; const q = queued.splice(0); q.forEach((w) => { apply(w.p, w.data, w.merge); w.resolve(); }); await flush(); await fire('w:online'); },
    fireWindow: (t, ev) => fire('w:' + t, ev),
    fireDocument: (t, ev) => fire('d:' + t, ev),
  };
}

module.exports = { boot };
