// _store.js — the sample account's in-browser document store (Pro demo
// phase 2, wave 1, 2026-10-06).
//
// One shared instance behind every fake SDK module in this folder. The fake
// modules are reached through /pro/explore/demo-sw.js, which answers the CRM's
// `https://www.gstatic.com/firebasejs/<ver>/firebase-*.js` imports with
// `export * from "<origin>/pro/demo-sdk/firebase-*.js"`. Every version string
// therefore lands on ONE copy of this file, so Timestamp instanceof checks and
// the document map are shared by all of them.
//
// Nothing here talks to a server. The only fetch is the same-origin, static
// seed file (sample-company.json). Writes stay in memory and are mirrored to
// this browser's IndexedDB ("nbd-demo-account") so a reload keeps the
// prospect's changes; resetSampleAccount() wipes it back to the seed.
//
// Data is plain JSON-shaped objects plus Timestamp instances. data() always
// hands out a deep copy, so a page mutating what it read never edits the store.

const SEED_URL = '/pro/demo-sdk/sample-company.json';
const IDB_NAME = 'nbd-demo-account';
const IDB_STORE = 'kv';
const IDB_KEY = 'docs-v1';

export const DEMO_UID = 'demo-owner';

// ── Timestamp ────────────────────────────────────────────────────────────
export class Timestamp {
  constructor(seconds, nanoseconds) {
    this.seconds = Math.floor(Number(seconds) || 0);
    this.nanoseconds = Math.floor(Number(nanoseconds) || 0);
  }
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromDate(d) { return Timestamp.fromMillis(d instanceof Date ? d.getTime() : Number(d)); }
  static fromMillis(ms) {
    const n = Number(ms) || 0;
    const s = Math.floor(n / 1000);
    return new Timestamp(s, Math.round((n - s * 1000) * 1e6));
  }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  isEqual(o) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
  valueOf() { return String(this.toMillis()).padStart(16, '0'); }
  toJSON() { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; }
  toString() { return 'Timestamp(seconds=' + this.seconds + ', nanoseconds=' + this.nanoseconds + ')'; }
}

export class GeoPoint {
  constructor(latitude, longitude) { this.latitude = Number(latitude); this.longitude = Number(longitude); }
  isEqual(o) { return o instanceof GeoPoint && o.latitude === this.latitude && o.longitude === this.longitude; }
  toJSON() { return { latitude: this.latitude, longitude: this.longitude }; }
}

// FieldValue sentinels — resolved at write time.
export class FieldValue {
  constructor(kind, arg) { this._kind = kind; this._arg = arg; }
  isEqual(o) { return o instanceof FieldValue && o._kind === this._kind; }
}

// ── value helpers ────────────────────────────────────────────────────────
export function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
  if (v instanceof GeoPoint) return new GeoPoint(v.latitude, v.longitude);
  if (v instanceof Date) return Timestamp.fromDate(v);
  if (v instanceof FieldValue) return v;
  if (Array.isArray(v)) return v.map(clone);
  if (typeof v.toDate === 'function' && typeof v.seconds === 'number') return new Timestamp(v.seconds, v.nanoseconds || 0);
  const out = {};
  for (const k of Object.keys(v)) { if (v[k] !== undefined) out[k] = clone(v[k]); }
  return out;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    !(v instanceof Timestamp) && !(v instanceof GeoPoint) && !(v instanceof FieldValue);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (a instanceof Timestamp || b instanceof Timestamp) return a instanceof Timestamp && a.isEqual(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!deepEqual(a[k], b[k])) return false;
  return true;
}

// Firestore cross-type ordering: null < bool < number < timestamp < string < bytes < ref < geo < array < map
function typeRank(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (v instanceof Timestamp) return 3;
  if (typeof v === 'string') return 4;
  if (v instanceof GeoPoint) return 7;
  if (Array.isArray(v)) return 8;
  return 9;
}
export function compareValues(a, b) {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1 || ra === 2) return a === b ? 0 : (a < b ? -1 : 1);
  if (ra === 3) return a.toMillis() - b.toMillis() || a.nanoseconds - b.nanoseconds;
  if (ra === 4) return a === b ? 0 : (a < b ? -1 : 1);
  if (ra === 7) return (a.latitude - b.latitude) || (a.longitude - b.longitude);
  if (ra === 8) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compareValues(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : (JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
}

export function getField(data, fieldPath) {
  if (fieldPath === '__name__') return undefined;
  const parts = String(fieldPath).split('.');
  let cur = data;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setField(obj, fieldPath, value) {
  const parts = String(fieldPath).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deleteFieldAt(obj, fieldPath) {
  const parts = String(fieldPath).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) return;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
}

// Resolve sentinels against the previous value at that path.
function resolveSentinel(fv, prev) {
  switch (fv._kind) {
    case 'serverTimestamp': return Timestamp.now();
    case 'increment': return (typeof prev === 'number' ? prev : 0) + Number(fv._arg || 0);
    case 'arrayUnion': {
      const base = Array.isArray(prev) ? prev.slice() : [];
      for (const el of fv._arg) if (!base.some((x) => deepEqual(x, el))) base.push(clone(el));
      return base;
    }
    case 'arrayRemove': {
      const base = Array.isArray(prev) ? prev.slice() : [];
      return base.filter((x) => !fv._arg.some((el) => deepEqual(x, el)));
    }
    default: return undefined;
  }
}

// Apply `fields` (possibly nested, possibly with sentinels) onto `target`.
function applyNested(target, fields, prefix) {
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    const path = prefix ? prefix + '.' + k : k;
    if (v === undefined) continue;
    if (v instanceof FieldValue) {
      if (v._kind === 'delete') deleteFieldAt(target, path);
      else setField(target, path, resolveSentinel(v, getField(target, path)));
    } else if (isPlainObject(v) && !(typeof v.toDate === 'function')) {
      if (!isPlainObject(getField(target, path))) setField(target, path, {});
      applyNested(target, v, path);
    } else {
      setField(target, path, clone(v));
    }
  }
}

function materialize(fields) {
  const out = {};
  applyNested(out, fields, '');
  return out;
}

// ── the document map ─────────────────────────────────────────────────────
// path ("leads/abc" or "companies/x/members/y") -> data
const _docs = new Map();
const _listeners = new Set();
let _ready = null;
let _seedMeta = {};

export function seedMeta() { return _seedMeta; }

// Seed values may carry relative dates so the sample account always looks
// current: {"__ts": {"days": -3, "hour": 10}} -> Timestamp, {"__date": {"days": 2}}
// -> "YYYY-MM-DD", {"__ms": {"days": -1}} -> epoch millis, {"__iso": {...}} -> ISO.
function relDate(spec) {
  const d = new Date();
  d.setDate(d.getDate() + Number(spec.days || 0));
  d.setHours(spec.hour == null ? 10 : Number(spec.hour), spec.minute == null ? 0 : Number(spec.minute), 0, 0);
  return d;
}
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
export function reviveSeed(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(reviveSeed);
  if (v.__ts) return Timestamp.fromDate(relDate(v.__ts));
  if (v.__date) return ymd(relDate(v.__date));
  if (v.__ms) return relDate(v.__ms).getTime();
  if (v.__iso) return relDate(v.__iso).toISOString();
  // Wave 2: {"__media": "roof-front.svg"} -> this origin's /pro/demo-sdk/media/ URL
  // (the CRM renders photo URLs only when they are absolute).
  if (v.__media) return /^[\w-]+\.(svg|png|jpg|webp)$/.test(String(v.__media)) ? (typeof location !== 'undefined' ? location.origin : '') + '/pro/demo-sdk/media/' + v.__media : '';
  const out = {};
  for (const k of Object.keys(v)) out[k] = reviveSeed(v[k]);
  return out;
}

// IndexedDB mirror. Every failure is swallowed: private windows and blocked
// storage still get a working (memory-only) sample account.
function encode(v) {
  if (v instanceof Timestamp) return { __t: [v.seconds, v.nanoseconds] };
  if (v instanceof GeoPoint) return { __g: [v.latitude, v.longitude] };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = encode(v[k]); return o; }
  return v;
}
function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    if (Array.isArray(v.__t) && Object.keys(v).length === 1) return new Timestamp(v.__t[0], v.__t[1]);
    if (Array.isArray(v.__g) && Object.keys(v).length === 1) return new GeoPoint(v.__g[0], v.__g[1]);
    const o = {}; for (const k of Object.keys(v)) o[k] = decode(v[k]); return o;
  }
  return v;
}
function idbOpen() {
  return new Promise((resolve, reject) => {
    try {
      if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}
async function idbGet() {
  try {
    const db = await idbOpen();
    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const r = tx.objectStore(IDB_STORE).get(IDB_KEY);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch (_) { return null; }
}
async function idbPut(value) {
  try {
    const db = await idbOpen();
    await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      if (value === null) tx.objectStore(IDB_STORE).delete(IDB_KEY);
      else tx.objectStore(IDB_STORE).put(value, IDB_KEY);
      tx.oncomplete = resolve; tx.onerror = resolve; tx.onabort = resolve;
    });
  } catch (_) { /* memory-only */ }
}
let _persistTimer = null;
function schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const all = {};
    for (const [p, d] of _docs) all[p] = encode(d);
    idbPut({ seedVersion: _seedMeta.version || 0, savedAt: Date.now(), docs: all });
  }, 150);
}

async function loadSeed() {
  const res = await fetch(SEED_URL, { credentials: 'same-origin', cache: 'no-cache' });
  if (!res.ok) throw new Error('sample account seed missing (' + res.status + ')');
  return res.json();
}

// The real SDK answers over the network, so in the CRM every first result
// lands after the page's deferred scripts have run; some module code calls
// globals those scripts define (renderEstimatesList, …). Answering from memory
// before DOMContentLoaded would invent a race the live app never has, so the
// store opens only once the document has finished its deferred scripts.
function documentSettled() {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || document.readyState === 'complete') return resolve();
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    document.addEventListener('DOMContentLoaded', go, { once: true });
    window.addEventListener('load', go, { once: true });
  });
}

export function ready() {
  if (_ready) return _ready;
  _ready = (async () => {
    await documentSettled();
    let seed = null;
    try { seed = await loadSeed(); } catch (e) { console.error('[demo] seed load failed:', e); seed = { docs: {} }; }
    _seedMeta = { version: seed.version || 0, company: seed.company || {}, user: seed.user || {}, claims: seed.claims || {} };
    const saved = await idbGet();
    if (saved && saved.docs && saved.seedVersion === _seedMeta.version) {
      for (const p of Object.keys(saved.docs)) _docs.set(p, decode(saved.docs[p]));
    } else {
      for (const p of Object.keys(seed.docs || {})) _docs.set(p, clone(reviveSeed(seed.docs[p])));
    }
  })();
  return _ready;
}

export async function resetSampleAccount() {
  await idbPut(null);
  _docs.clear();
  _ready = null;
  await ready();
  notifyAll();
}

// ── raw store API used by firebase-firestore.js ──────────────────────────
export function rawGet(path) { const d = _docs.get(path); return d === undefined ? undefined : d; }
export function rawSet(path, fields, opts) {
  const prev = _docs.get(path);
  let next;
  if (opts && (opts.merge || opts.mergeFields) && prev) {
    next = clone(prev);
    if (opts.mergeFields) {
      const picked = {};
      for (const f of opts.mergeFields) { const v = getField(fields, f); if (v !== undefined) setField(picked, f, v); }
      applyNested(next, picked, '');
    } else {
      applyNested(next, fields, '');
    }
  } else {
    next = materialize(fields);
  }
  _docs.set(path, next);
  changed();
}
export function rawUpdate(path, fields) {
  const prev = _docs.get(path);
  if (prev === undefined) {
    const err = new Error('No document to update: ' + path);
    err.code = 'not-found';
    throw err;
  }
  const next = clone(prev);
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if (v === undefined) continue;
    if (v instanceof FieldValue) {
      if (v._kind === 'delete') deleteFieldAt(next, k);
      else setField(next, k, resolveSentinel(v, getField(next, k)));
    } else {
      setField(next, k, clone(v)); // dotted keys replace that leaf; a map value replaces the map
    }
  }
  _docs.set(path, next);
  changed();
}
export function rawDelete(path) {
  if (_docs.delete(path)) changed();
}
// Direct children of a collection path.
export function rawList(collPath) {
  const depth = collPath.split('/').length + 1;
  const out = [];
  for (const [p, d] of _docs) {
    if (p.startsWith(collPath + '/') && p.split('/').length === depth) out.push([p, d]);
  }
  return out;
}
export function rawListGroup(collId) {
  const out = [];
  for (const [p, d] of _docs) {
    const parts = p.split('/');
    if (parts.length % 2 === 0 && parts[parts.length - 2] === collId) out.push([p, d]);
  }
  return out;
}

// ── change notification ──────────────────────────────────────────────────
let _notifyQueued = false;
function changed() {
  schedulePersist();
  if (_notifyQueued) return;
  _notifyQueued = true;
  Promise.resolve().then(() => { _notifyQueued = false; notifyAll(); });
}
function notifyAll() {
  for (const l of Array.from(_listeners)) {
    try { l.run(); } catch (e) { console.error('[demo] listener failed:', e); }
  }
}
export function addListener(l) { _listeners.add(l); return () => _listeners.delete(l); }

// Auto ids look like Firestore's (20 chars, base62).
const AUTO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function autoId() {
  let s = '';
  const buf = new Uint8Array(20);
  try { crypto.getRandomValues(buf); } catch (_) { for (let i = 0; i < 20; i++) buf[i] = Math.floor(Math.random() * 256); }
  for (let i = 0; i < 20; i++) s += AUTO[buf[i] % 62];
  return s;
}

// Honest "this would happen in your real account" notice, shown by the
// demo shell (docs/pro/js/demo-mode.js listens for this event).
export function demoNotice(message, detail) {
  try {
    window.dispatchEvent(new CustomEvent('nbd-demo:notice', { detail: Object.assign({ message: String(message || '') }, detail || {}) }));
  } catch (_) { /* no window (tests) */ }
}
