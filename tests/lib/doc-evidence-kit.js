/**
 * tests/lib/doc-evidence-kit.js — an in-memory Firestore + Storage and a loader
 * that runs the REAL signing handlers (esign-envelope.js, remote-signing.js,
 * deal-acceptance.js) under stubbed firebase modules. Used by
 * tests/clause-evidence-foundation-2026-11-18.test.js. Zero network.
 *
 * Same technique as tests/esign-gaps-2026-10-04.test.js and
 * tests/remote-sign-save-failure-2026-11-14.test.js (handlers loaded with
 * `new Function`, pure modules real, firebase stubbed).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FN = path.join(__dirname, '..', '..', 'functions');
module.paths.unshift(path.join(FN, 'node_modules'));

function isPlain(v) { return v && typeof v === 'object' && !Array.isArray(v) && !v.__fv && !Buffer.isBuffer(v) && typeof v.toMillis !== 'function'; }
function applyPatch(prev, patch, deep) {
  const next = Object.assign({}, prev || {});
  for (const [k, v] of Object.entries(patch)) {
    if (v && v.__fv === 'delete') { delete next[k]; continue; }
    if (v && v.__fv === 'arrayUnion') { next[k] = (Array.isArray(next[k]) ? next[k] : []).concat(v.items); continue; }
    if (v && v.__fv === 'serverTimestamp') { const now = Date.now(); next[k] = { __ts: true, toMillis: () => now }; continue; }
    if (deep && isPlain(v) && isPlain(next[k])) { next[k] = applyPatch(next[k], v, true); continue; }
    next[k] = v;
  }
  return next;
}

function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  let autoId = 0;
  const ref = (p) => ({
    id: p.split('/').pop(), path: p,
    get: async () => { const d = store.get(p); return { exists: d !== undefined, data: () => d, ref: ref(p), id: p.split('/').pop() }; },
    set: async (patch, opts) => { store.set(p, applyPatch((opts && opts.merge) ? store.get(p) : {}, patch, !!(opts && opts.merge))); },
    update: async (patch) => {
      if (!store.has(p)) throw new Error('NOT_FOUND ' + p);
      const flat = {}; const dotted = [];
      for (const [k, v] of Object.entries(patch)) (k.includes('.') ? dotted.push([k, v]) : (flat[k] = v));
      const next = applyPatch(store.get(p), flat, false);
      for (const [k, v] of dotted) {
        const parts = k.split('.'); let o = next;
        for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = Object.assign({}, o[parts[i]] || {}); o = o[parts[i]]; }
        o[parts[parts.length - 1]] = v;
      }
      store.set(p, next);
    },
  });
  const cmp = (o, a, b) => (o === '==' ? a === b : o === '<=' ? (a != null && a <= b) : o === '<' ? (a != null && a < b) : o === '>=' ? (a != null && a >= b) : false);
  const query = (coll, filters, lim) => ({
    where: (f, o, v) => query(coll, filters.concat([[f, o, v]]), lim),
    limit: (n) => query(coll, filters, n),
    get: async () => {
      const docs = [];
      for (const [p, d] of store) {
        if (!p.startsWith(coll + '/') || p.slice(coll.length + 1).includes('/')) continue;
        if (filters.every(([f, o, v]) => cmp(o, d && d[f], v))) docs.push({ id: p.split('/').pop(), ref: ref(p), data: () => store.get(p) });
      }
      const sl = lim ? docs.slice(0, lim) : docs;
      return { size: sl.length, docs: sl, empty: !sl.length, forEach: (fn) => sl.forEach(fn) };
    },
  });
  return {
    doc: ref,
    collection: (coll) => Object.assign(query(coll, []), {
      add: async (data) => { const id = 'auto' + (++autoId); store.set(coll + '/' + id, applyPatch({}, data)); return ref(coll + '/' + id); },
      doc: (id) => ref(coll + '/' + (id || ('auto' + (++autoId)))),
    }),
    batch: () => { const ops = []; return { update: (r, d) => ops.push(() => r.update(d)), set: (r, d, o) => ops.push(() => r.set(d, o)), commit: async () => { for (const op of ops) await op(); } }; },
    runTransaction: async (fn) => {
      const writes = [];
      const out = await fn({ get: (r) => r.get(), update: (r, d) => writes.push(() => r.update(d)), set: (r, d, o) => writes.push(() => r.set(d, o)) });
      for (const w of writes) await w();
      return out;
    },
    _store: store,
    _get: (p) => store.get(p),
    _all: (coll) => [...store.entries()].filter(([p]) => p.startsWith(coll + '/')).map(([p, d]) => Object.assign({ _id: p.split('/').pop() }, d)),
  };
}

function makeStorage(seedFiles) {
  const files = new Map(Object.entries(seedFiles || {}).map(([k, v]) => [k, Buffer.from(v)]));
  return {
    files,
    getStorage: () => ({ bucket: () => ({ file: (p) => ({
      save: async (buf) => { files.set(p, Buffer.from(buf)); },
      download: async () => { if (!files.has(p)) throw new Error('No such object: ' + p); return [Buffer.from(files.get(p))]; },
      getMetadata: async () => [{ size: files.has(p) ? files.get(p).length : 0 }],
      getSignedUrl: async () => ['https://storage.example/' + p],
    }) }) }),
  };
}

class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }

/**
 * Run functions/<rel> with `require` answered from `stubs` first, then by the
 * real module of that name in functions/ (the pure ones), else a loud error.
 * `real` lists the relative ids that may be loaded for real.
 */
function loadHandler(rel, db, storage, extraStubs, real) {
  const logs = [];
  const logger = { info() {}, warn: (m, d) => logs.push(['warn', m, d]), error: (m, d) => logs.push(['error', m, d]) };
  const stubs = Object.assign({
    crypto,
    'firebase-functions/v2/https': { onCall: (o, h) => h, onRequest: (o, h) => h, HttpsError },
    'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'stub' }) },
    'firebase-functions/v2': { logger },
    'firebase-admin/firestore': {
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => ({ __fv: 'serverTimestamp' }), arrayUnion: (...items) => ({ __fv: 'arrayUnion', items }), delete: () => ({ __fv: 'delete' }), increment: () => ({ __fv: 'inc' }) },
    },
    'firebase-admin/storage': { getStorage: storage.getStorage },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true, clientIp: (req) => (req && req.__ip) || '203.0.113.9' },
    './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
    './integrations/_shared': { secretOr: (_s, d) => d },
    './messaging-controls': require('./messaging-controls-stub'),
    './resend-guard': { resendRejected: () => false, resendErrorMessage: () => 'rejected' },
    './estimate-view-alert': { recordEstimateView: async () => {} },
    './job-spine': { spineAfterRemoteSign: async () => ({}), spineAfterDealAccept: async () => ({}), spineAfterEsign: async () => ({}) },
    './photo-reencode': { reencodePhoto: async (b) => b },
    resend: { Resend: class { constructor() { this.emails = { send: async () => ({ data: { id: 'm1' } }) }; } } },
  }, extraStubs || {});
  const realIds = real || [];
  const proc = { env: { FUNCTIONS_EMULATOR: 'true' } };
  const dir = path.join(FN, path.dirname(rel));
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    if (realIds.indexOf(id) !== -1) return require(id.charAt(0) === '.' ? path.join(dir, id) : id);
    throw new Error('unstubbed require(' + id + ')');
  };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'process', 'console', fs.readFileSync(path.join(FN, rel), 'utf8'))(
    mod, mod.exports, req, proc, { log() {}, warn() {}, error() {} });
  return { fns: mod.exports, logs, stubs };
}

function reqRes(body, o) {
  const opts = o || {};
  const res = { statusCode: 200, body: null, headers: {},
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; },
    set(k, v) { this.headers[k] = v; return this; }, send() { return this; }, end() { return this; } };
  const req = { method: 'POST', body, __ip: opts.ip || '203.0.113.9', ip: opts.ip || '203.0.113.9',
    get: (h) => (/user-agent/i.test(h) ? (opts.ua || 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)') : ''), path: '' };
  return { req, res };
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

module.exports = { FN, makeDb, makeStorage, HttpsError, loadHandler, reqRes, sha256 };
