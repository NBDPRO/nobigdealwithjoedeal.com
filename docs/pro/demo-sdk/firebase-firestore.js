// Fake firebase-firestore.js for the browser-only sample account (Pro demo
// phase 2, wave 1). Same export names the CRM imports from
// /assets/vendor/firebase/10.12.2/firebase-firestore.js, backed by
// the in-memory store in _store.js. No network, ever.
//
// tests/pro-demo-sdk-2026-10-06.test.js compares this module's exports with
// every name the CRM imports from the real SDK, so a newly used SDK function
// fails CI instead of silently being undefined here.
import {
  Timestamp, GeoPoint, FieldValue, clone, compareValues, getField, ready,
  rawGet, rawSet, rawUpdate, rawDelete, rawList, rawListGroup, addListener, autoId
} from './_store.js';

export { Timestamp, GeoPoint, FieldValue };

const DB = { type: 'firestore', app: null, __nbdDemo: true, toJSON() { return { demo: true }; } };

function err(code, message) { const e = new Error(message); e.code = code; e.name = 'FirebaseError'; return e; }

// ── instances ────────────────────────────────────────────────────────────
export function getFirestore(app) { if (app) DB.app = app; return DB; }
export function initializeFirestore(app) { if (app) DB.app = app; return DB; }
export function connectFirestoreEmulator() {}
export function persistentLocalCache(s) { return { kind: 'persistent', settings: s || {} }; }
export function persistentSingleTabManager(s) { return { kind: 'single', settings: s || {} }; }
export function persistentMultipleTabManager(s) { return { kind: 'multi', settings: s || {} }; }
export function memoryLocalCache(s) { return { kind: 'memory', settings: s || {} }; }
export function memoryEagerGarbageCollector() { return {}; }
export function memoryLruGarbageCollector() { return {}; }
export async function enableNetwork() {}
export async function disableNetwork() {}
export async function waitForPendingWrites() { await ready(); }
export async function terminate() {}
export async function clearIndexedDbPersistence() {}
export async function enableIndexedDbPersistence() {}
export async function enableMultiTabIndexedDbPersistence() {}
export function setLogLevel() {}
export function onSnapshotsInSync(_db, cb) { setTimeout(() => { try { (typeof cb === 'function' ? cb : cb.next)(); } catch (_) {} }, 0); return () => {}; }
export async function loadBundle() { return {}; }
export async function namedQuery() { return null; }

// ── references ───────────────────────────────────────────────────────────
function normSegments(parts) {
  const out = [];
  for (const p of parts) {
    if (p === undefined || p === null) throw err('invalid-argument', 'Path segment is ' + p);
    for (const s of String(p).split('/')) if (s) out.push(s);
  }
  return out;
}

export class Query {
  constructor(path, constraints, group) {
    this.type = 'query';
    this.firestore = DB;
    this._path = path;              // collection path, or collection id for a group
    this._group = !!group;
    this._c = constraints || [];
    this.converter = null;
  }
  withConverter(c) { const q = new Query(this._path, this._c, this._group); q.converter = c; return q; }
}

export class CollectionReference extends Query {
  constructor(path) {
    super(path, [], false);
    this.type = 'collection';
    this.path = path;
    const parts = path.split('/');
    this.id = parts[parts.length - 1];
    this.parent = parts.length > 1 ? new DocumentReference(parts.slice(0, -1).join('/')) : null;
  }
  withConverter(c) { const r = new CollectionReference(this.path); r.converter = c; return r; }
}

export class DocumentReference {
  constructor(path) {
    this.type = 'document';
    this.firestore = DB;
    this.path = path;
    const parts = path.split('/');
    this.id = parts[parts.length - 1];
    this.converter = null;
  }
  get parent() { return new CollectionReference(this.path.split('/').slice(0, -1).join('/')); }
  withConverter(c) { const r = new DocumentReference(this.path); r.converter = c; return r; }
  isEqual(o) { return o instanceof DocumentReference && o.path === this.path; }
  toJSON() { return { path: this.path }; }
}

function basePath(ref) {
  if (!ref || ref === DB || ref.type === 'firestore') return '';
  if (ref instanceof DocumentReference) return ref.path;
  if (ref instanceof CollectionReference) return ref.path;
  throw err('invalid-argument', 'Expected a Firestore instance or reference');
}

export function collection(parent, ...segments) {
  const parts = normSegments([basePath(parent), ...segments].filter((s) => s !== ''));
  if (parts.length % 2 !== 1) throw err('invalid-argument', 'Invalid collection reference: ' + parts.join('/'));
  return new CollectionReference(parts.join('/'));
}

export function collectionGroup(_db, collectionId) { return new Query(String(collectionId), [], true); }

export function doc(parent, ...segments) {
  const base = basePath(parent);
  if (parent instanceof CollectionReference && segments.length === 0) return new DocumentReference(base + '/' + autoId());
  const parts = normSegments([base, ...segments].filter((s) => s !== ''));
  if (parts.length % 2 !== 0) throw err('invalid-argument', 'Invalid document reference: ' + parts.join('/'));
  return new DocumentReference(parts.join('/'));
}

export function refEqual(a, b) { return !!a && !!b && a.path === b.path && a.type === b.type; }
export function queryEqual(a, b) { return JSON.stringify(a && a._c) === JSON.stringify(b && b._c) && a._path === b._path; }

const DOC_ID = '__name__';
export class FieldPath {
  constructor(...names) { this._s = names.join('.'); }
  isEqual(o) { return o instanceof FieldPath && o._s === this._s; }
}
export function documentId() { const f = new FieldPath(DOC_ID); f._s = DOC_ID; return f; }
function fieldStr(f) { return f instanceof FieldPath ? f._s : String(f); }

// ── constraints ──────────────────────────────────────────────────────────
export function where(field, op, value) { return { kind: 'where', field: fieldStr(field), op, value }; }
export function orderBy(field, dir) { return { kind: 'orderBy', field: fieldStr(field), dir: dir === 'desc' ? 'desc' : 'asc' }; }
export function limit(n) { return { kind: 'limit', n: Number(n) }; }
export function limitToLast(n) { return { kind: 'limitToLast', n: Number(n) }; }
export function startAfter(...v) { return { kind: 'cursor', at: 'startAfter', v }; }
export function startAt(...v) { return { kind: 'cursor', at: 'startAt', v }; }
export function endBefore(...v) { return { kind: 'cursor', at: 'endBefore', v }; }
export function endAt(...v) { return { kind: 'cursor', at: 'endAt', v }; }
export function and(...filters) { return { kind: 'and', filters }; }
export function or(...filters) { return { kind: 'or', filters }; }

export function query(base, ...constraints) {
  const flat = [];
  for (const c of constraints) if (c) flat.push(c);
  const q = new Query(base._path, (base._c || []).concat(flat), base._group);
  q.converter = base.converter || null;
  return q;
}

// ── sentinels ────────────────────────────────────────────────────────────
export function serverTimestamp() { return new FieldValue('serverTimestamp'); }
export function increment(n) { return new FieldValue('increment', n); }
export function arrayUnion(...els) { return new FieldValue('arrayUnion', els); }
export function arrayRemove(...els) { return new FieldValue('arrayRemove', els); }
export function deleteField() { return new FieldValue('delete'); }

export class Bytes {
  constructor(u8) { this._u8 = u8 || new Uint8Array(); }
  static fromUint8Array(u8) { return new Bytes(u8); }
  static fromBase64String(s) { return new Bytes(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); }
  toUint8Array() { return this._u8; }
  toBase64() { return btoa(String.fromCharCode.apply(null, Array.from(this._u8))); }
}

// ── snapshots ────────────────────────────────────────────────────────────
const META = Object.freeze({ fromCache: false, hasPendingWrites: false, isEqual() { return true; } });

export class DocumentSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this._d = data;
    this.metadata = META;
  }
  exists() { return this._d !== undefined; }
  data() {
    if (this._d === undefined) return undefined;
    const plain = clone(this._d);
    if (this.ref.converter && typeof this.ref.converter.fromFirestore === 'function') {
      return this.ref.converter.fromFirestore(new DocumentSnapshot(new DocumentReference(this.ref.path), this._d), {});
    }
    return plain;
  }
  get(field) { return this._d === undefined ? undefined : clone(getField(this._d, fieldStr(field))); }
}
export class QueryDocumentSnapshot extends DocumentSnapshot {}

export class QuerySnapshot {
  constructor(q, docs, changes) {
    this.query = q;
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
    this.metadata = META;
    this._changes = changes || docs.map((d, i) => ({ type: 'added', doc: d, oldIndex: -1, newIndex: i }));
  }
  forEach(cb, thisArg) { this.docs.forEach((d) => cb.call(thisArg, d)); }
  docChanges() { return this._changes; }
}

// ── query evaluation ─────────────────────────────────────────────────────
function valueFor(path, data, field) {
  if (field === DOC_ID) return path;
  return getField(data, field);
}
function cmpForWhere(v, value, field) {
  // documentId() filters may compare a full path or a bare id
  if (field === DOC_ID && typeof value === 'string' && !value.includes('/')) return compareValues(v.split('/').pop(), value);
  if (value instanceof DocumentReference) value = value.path;
  return compareValues(v, value);
}
function matches(path, data, c) {
  if (c.kind === 'and') return c.filters.every((f) => matches(path, data, f));
  if (c.kind === 'or') return c.filters.some((f) => matches(path, data, f));
  if (c.kind !== 'where') return true;
  const v = valueFor(path, data, c.field);
  const val = c.value;
  switch (c.op) {
    case '==': return v !== undefined && cmpForWhere(v, val, c.field) === 0 && typeRankEq(v, val, c.field);
    case '!=': return v !== undefined && v !== null && !(cmpForWhere(v, val, c.field) === 0 && typeRankEq(v, val, c.field));
    case '<': return v !== undefined && sameKind(v, val, c.field) && cmpForWhere(v, val, c.field) < 0;
    case '<=': return v !== undefined && sameKind(v, val, c.field) && cmpForWhere(v, val, c.field) <= 0;
    case '>': return v !== undefined && sameKind(v, val, c.field) && cmpForWhere(v, val, c.field) > 0;
    case '>=': return v !== undefined && sameKind(v, val, c.field) && cmpForWhere(v, val, c.field) >= 0;
    case 'array-contains': return Array.isArray(v) && v.some((x) => compareValues(x, val) === 0);
    case 'array-contains-any': return Array.isArray(v) && Array.isArray(val) && v.some((x) => val.some((y) => compareValues(x, y) === 0));
    case 'in': return v !== undefined && Array.isArray(val) && val.some((y) => cmpForWhere(v, y, c.field) === 0);
    case 'not-in': return v !== undefined && v !== null && Array.isArray(val) && !val.some((y) => cmpForWhere(v, y, c.field) === 0);
    default: throw err('invalid-argument', 'Unsupported where operator: ' + c.op);
  }
}
function kind(v) {
  if (v === null || v === undefined) return 'null';
  if (v instanceof Timestamp) return 'ts';
  if (v instanceof DocumentReference) return 'string';
  return Array.isArray(v) ? 'array' : typeof v;
}
function sameKind(a, b, field) { return field === DOC_ID || kind(a) === kind(b); }
function typeRankEq(a, b, field) { return field === DOC_ID || kind(a) === kind(b); }

function runQuery(q) {
  const rows = q._group ? rawListGroup(q._path) : rawList(q._path);
  let list = rows.filter(([p, d]) => q._c.every((c) => matches(p, d, c)));
  const orders = q._c.filter((c) => c.kind === 'orderBy');
  // orderBy also filters out documents missing the field (Firestore semantics)
  for (const o of orders) if (o.field !== DOC_ID) list = list.filter(([, d]) => getField(d, o.field) !== undefined);
  const sortKeys = orders.length ? orders.slice() : [];
  if (!sortKeys.some((o) => o.field === DOC_ID)) sortKeys.push({ field: DOC_ID, dir: sortKeys.length ? sortKeys[sortKeys.length - 1].dir : 'asc' });
  list.sort((a, b) => {
    for (const o of sortKeys) {
      const c = compareValues(valueFor(a[0], a[1], o.field), valueFor(b[0], b[1], o.field));
      if (c) return o.dir === 'desc' ? -c : c;
    }
    return 0;
  });
  for (const cur of q._c.filter((c) => c.kind === 'cursor')) {
    const keyOf = (row) => {
      if (cur.v.length === 1 && cur.v[0] instanceof DocumentSnapshot) {
        const s = cur.v[0];
        const target = rawGet(s.ref.path) || s._d || {};
        return sortKeys.map((o) => valueFor(s.ref.path, target, o.field));
      }
      return cur.v;
    };
    const k = keyOf();
    const cmpRow = (row) => {
      for (let i = 0; i < k.length && i < sortKeys.length; i++) {
        let c = compareValues(valueFor(row[0], row[1], sortKeys[i].field), k[i]);
        if (sortKeys[i].dir === 'desc') c = -c;
        if (c) return c;
      }
      return 0;
    };
    if (cur.at === 'startAfter') list = list.filter((r) => cmpRow(r) > 0);
    else if (cur.at === 'startAt') list = list.filter((r) => cmpRow(r) >= 0);
    else if (cur.at === 'endBefore') list = list.filter((r) => cmpRow(r) < 0);
    else if (cur.at === 'endAt') list = list.filter((r) => cmpRow(r) <= 0);
  }
  const lim = q._c.filter((c) => c.kind === 'limit').pop();
  const limLast = q._c.filter((c) => c.kind === 'limitToLast').pop();
  if (lim) list = list.slice(0, lim.n);
  if (limLast) list = list.slice(Math.max(0, list.length - limLast.n));
  return list.map(([p, d]) => {
    const ref = new DocumentReference(p);
    ref.converter = q.converter || null;
    return new QueryDocumentSnapshot(ref, d);
  });
}

// ── reads ────────────────────────────────────────────────────────────────
export async function getDoc(ref) {
  await ready();
  if (!(ref instanceof DocumentReference)) throw err('invalid-argument', 'getDoc expects a DocumentReference');
  return new DocumentSnapshot(ref, rawGet(ref.path));
}
export const getDocFromServer = getDoc;
export const getDocFromCache = getDoc;

export async function getDocs(q) {
  await ready();
  return new QuerySnapshot(q, runQuery(q));
}
export const getDocsFromServer = getDocs;
export const getDocsFromCache = getDocs;

export function count() { return { kind: 'count' }; }
export function sum(field) { return { kind: 'sum', field: fieldStr(field) }; }
export function average(field) { return { kind: 'avg', field: fieldStr(field) }; }
export async function getCountFromServer(q) {
  await ready();
  const n = runQuery(q).length;
  return { data: () => ({ count: n }) };
}
export async function getAggregateFromServer(q, spec) {
  await ready();
  const docs = runQuery(q);
  const out = {};
  for (const k of Object.keys(spec || {})) {
    const a = spec[k];
    if (a.kind === 'count') out[k] = docs.length;
    else {
      const nums = docs.map((d) => Number(getField(d._d, a.field))).filter((n) => Number.isFinite(n));
      const total = nums.reduce((s, n) => s + n, 0);
      out[k] = a.kind === 'sum' ? total : (nums.length ? total / nums.length : null);
    }
  }
  return { data: () => out };
}

// ── writes ───────────────────────────────────────────────────────────────
function toFields(ref, data, opts) {
  if (ref.converter && typeof ref.converter.toFirestore === 'function') return ref.converter.toFirestore(data, opts);
  return data;
}
function assertData(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw err('invalid-argument', 'Document data must be an object');
}
export async function setDoc(ref, data, opts) {
  await ready();
  assertData(data);
  rawSet(ref.path, toFields(ref, data, opts), opts);
}
export async function addDoc(collRef, data) {
  await ready();
  assertData(data);
  const ref = doc(collRef);
  ref.converter = collRef.converter || null;
  rawSet(ref.path, toFields(ref, data));
  return ref;
}
function updateArgs(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object') return args[0];
  const out = {};
  for (let i = 0; i + 1 < args.length; i += 2) out[fieldStr(args[i])] = args[i + 1];
  return out;
}
export async function updateDoc(ref, ...args) {
  await ready();
  rawUpdate(ref.path, updateArgs(args));
}
export async function deleteDoc(ref) {
  await ready();
  rawDelete(ref.path);
}

export function writeBatch() {
  const ops = [];
  let done = false;
  const b = {
    set(ref, data, opts) { ops.push(() => rawSet(ref.path, toFields(ref, data, opts), opts)); return b; },
    update(ref, ...args) { const f = updateArgs(args); ops.push(() => rawUpdate(ref.path, f)); return b; },
    delete(ref) { ops.push(() => rawDelete(ref.path)); return b; },
    async commit() {
      if (done) throw err('failed-precondition', 'A write batch can only be committed once');
      done = true;
      await ready();
      // all-or-nothing: validate updates first
      for (const op of ops) op();
    }
  };
  return b;
}

export async function runTransaction(_db, fn) {
  await ready();
  const writes = [];
  const tx = {
    async get(ref) { return new DocumentSnapshot(ref, rawGet(ref.path)); },
    set(ref, data, opts) { writes.push(() => rawSet(ref.path, toFields(ref, data, opts), opts)); return tx; },
    update(ref, ...args) { const f = updateArgs(args); writes.push(() => rawUpdate(ref.path, f)); return tx; },
    delete(ref) { writes.push(() => rawDelete(ref.path)); return tx; }
  };
  const result = await fn(tx);
  for (const w of writes) w();
  return result;
}

// ── listeners ────────────────────────────────────────────────────────────
export function onSnapshot(target, ...rest) {
  let i = 0;
  if (rest[0] && typeof rest[0] === 'object' && typeof rest[0].next !== 'function' &&
      (('includeMetadataChanges' in rest[0]) || ('source' in rest[0]))) i = 1;
  let next = rest[i], error = rest[i + 1];
  if (next && typeof next === 'object') { error = next.error; next = next.next; }
  let alive = true;
  let last = null;     // doc: serialized; query: Map id -> serialized
  let lastOrder = [];
  const isDoc = target instanceof DocumentReference;
  const run = () => {
    if (!alive) return;
    try {
      if (isDoc) {
        const d = rawGet(target.path);
        const sig = d === undefined ? '∅' : JSON.stringify(d);
        if (sig === last) return;
        last = sig;
        next && next(new DocumentSnapshot(target, d));
      } else {
        const docs = runQuery(target);
        const now = new Map(docs.map((d) => [d.ref.path, JSON.stringify(d._d)]));
        const order = docs.map((d) => d.ref.path);
        if (last && now.size === last.size && order.join('|') === lastOrder.join('|') &&
            order.every((p) => last.get(p) === now.get(p))) return;
        const changes = [];
        if (!last) {
          docs.forEach((d, n) => changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: n }));
        } else {
          for (const [p] of last) {
            if (!now.has(p)) {
              changes.push({ type: 'removed', doc: new QueryDocumentSnapshot(new DocumentReference(p), JSON.parse(last.get(p))), oldIndex: lastOrder.indexOf(p), newIndex: -1 });
            }
          }
          docs.forEach((d, n) => {
            const p = d.ref.path;
            if (!last.has(p)) changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: n });
            else if (last.get(p) !== now.get(p) || lastOrder.indexOf(p) !== n) changes.push({ type: 'modified', doc: d, oldIndex: lastOrder.indexOf(p), newIndex: n });
          });
        }
        last = now;
        lastOrder = order;
        next && next(new QuerySnapshot(target, docs, changes));
      }
    } catch (e) {
      if (typeof error === 'function') error(e); else console.error('[demo] onSnapshot:', e);
    }
  };
  const off = addListener({ run });
  ready().then(() => setTimeout(run, 0));
  return () => { alive = false; off(); };
}

// What the demo shell and tests can reach without importing the SDK.
export const __nbdDemo = true;
