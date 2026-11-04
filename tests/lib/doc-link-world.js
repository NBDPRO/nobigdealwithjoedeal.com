'use strict';
/**
 * tests/lib/doc-link-world.js — stubbed firebase world for the Secure Document
 * Link suites (the estimate-send-track idiom, extended with dotted-path
 * updates, increments, range where() and transactions). Nothing reaches a
 * network; every vendor and push is a spy. Requiring this installs the stubs.
 */
const path = require('path');
const Module = require('module');
const { Writable, PassThrough } = require('stream');

const ROOT = path.join(__dirname, '..', '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const fnPath = (rel) => path.join(FUNCTIONS, rel);

const W = { docs: {}, objects: {}, pushes: [], seq: 0, now: Date.now(), rl: null };
function resetWorld(docs) { W.docs = Object.assign({}, docs || {}); W.objects = {}; W.pushes = []; W.seq = 0; W.now = Date.now(); W.rl = null; }

class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const Timestamp = {
  fromMillis: (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000), _ts: true }),
  fromDate: (d) => Timestamp.fromMillis(d.getTime()),
  now: () => Timestamp.fromMillis(W.now),
};
const FieldValue = {
  serverTimestamp: () => Timestamp.fromMillis(W.now),
  increment: (n) => ({ __inc: n }),
  arrayUnion: (...a) => ({ __union: a }),
  delete: () => ({ __del: true }),
};
function setPath(obj, key, val) {
  const parts = key.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
    else o[parts[i]] = Object.assign({}, o[parts[i]]);
    o = o[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (val && typeof val === 'object' && '__inc' in val) o[last] = (Number(o[last]) || 0) + val.__inc;
  else if (val && typeof val === 'object' && val.__del) delete o[last];
  else o[last] = val;
}
function applyPatch(prev, v) {
  const out = Object.assign({}, prev || {});
  Object.keys(v).forEach((k) => setPath(out, k, v[k]));
  return out;
}
function makeDb() {
  function snap(p) {
    const d = W.docs[p];
    return { exists: d != null, id: p.split('/').pop(), ref: docRef(p), data: () => (d == null ? undefined : Object.assign({}, d)) };
  }
  function docRef(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => snap(p),
      set: async (v, o) => { W.docs[p] = (o && o.merge) ? applyPatch(W.docs[p], v) : applyPatch({}, v); },
      create: async (v) => { if (W.docs[p]) { const e = new Error('already exists'); e.code = 6; throw e; } W.docs[p] = applyPatch({}, v); },
      update: async (v) => {
        if (W.docs[p] == null) { const e = new Error('NOT_FOUND: ' + p); e.code = 5; throw e; }
        W.docs[p] = applyPatch(W.docs[p], v);
      },
      delete: async () => { delete W.docs[p]; },
      collection: (n) => coll(p + '/' + n),
    };
  }
  function query(name, filters) {
    const q = {
      where: (f, op, v) => query(name, filters.concat([[f, op, v]])),
      orderBy: () => q, limit: () => q, select: () => q,
      get: async () => {
        const docs = Object.keys(W.docs)
          .filter((k) => k.startsWith(name + '/') && k.slice(name.length + 1).indexOf('/') === -1)
          .filter((k) => filters.every(([f, op, v]) => {
            const x = (W.docs[k] || {})[f];
            if (op === '==') return x === v;
            if (op === '<=') return typeof x === 'number' && x <= v;
            return true;
          }))
          .map(snap);
        return { empty: !docs.length, size: docs.length, docs, forEach: (cb) => docs.forEach(cb) };
      },
    };
    return q;
  }
  function coll(name) {
    return Object.assign(query(name, []), {
      id: name.split('/').pop(), path: name,
      doc: (id) => docRef(name + '/' + (id || ('auto' + (++W.seq)))),
      add: async (v) => { const id = 'auto' + (++W.seq); W.docs[name + '/' + id] = applyPatch({}, v); return docRef(name + '/' + id); },
    });
  }
  return {
    doc: docRef, collection: coll,
    batch: () => {
      const ops = [];
      const b = {
        set: (r, v, o) => { ops.push(() => r.set(v, o)); return b; },
        update: (r, v) => { ops.push(() => r.update(v)); return b; },
        delete: (r) => { ops.push(() => r.delete()); return b; },
        commit: async () => { for (const op of ops) await op(); },
      };
      return b;
    },
    runTransaction: async (fn) => {
      const writes = [];
      const tx = {
        get: (r) => r.get(),
        set: (r, v, o) => { writes.push(() => r.set(v, o)); return tx; },
        create: (r, v) => { writes.push(() => r.create(v)); return tx; },
        update: (r, v) => { writes.push(() => r.update(v)); return tx; },
        delete: (r) => { writes.push(() => r.delete()); return tx; },
      };
      const out = await fn(tx);
      for (const w of writes) await w();
      return out;
    },
  };
}
const DB = makeDb();

const bucket = {
  name: 'demo-bucket',
  file: (p) => ({
    name: p,
    getMetadata: async () => { const o = W.objects[p]; if (!o) { const e = new Error('No such object'); e.code = 404; throw e; } return [Object.assign({ size: String(o.body.length) }, o.meta)]; },
    download: async () => { const o = W.objects[p]; if (!o) { const e = new Error('No such object'); e.code = 404; throw e; } return [Buffer.from(o.body)]; },
    createReadStream: () => { const s = new PassThrough(); const o = W.objects[p]; setImmediate(() => s.end(Buffer.from(o ? o.body : ''))); return s; },
  }),
};

const logger = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
const httpsStub = { onCall: (o, h) => (typeof o === 'function' ? o : h), onRequest: (o, h) => (typeof o === 'function' ? o : h), HttpsError };
const secret = (n) => ({ name: n, value: () => '' });
const vendorSpy = (name) => new Proxy(function () {}, {
  get: (t, k) => (k === 'then' ? undefined : vendorSpy(name + '.' + String(k))),
  apply: () => { throw new Error('vendor ' + name + ' must not be called'); },
  construct: () => vendorSpy(name),
});
const PKG_STUBS = {
  'firebase-functions/v2/https': httpsStub,
  'firebase-functions/v2': { logger, https: httpsStub },
  'firebase-functions': { logger, https: httpsStub, config: () => ({}) },
  'firebase-functions/params': { defineSecret: secret, defineString: secret, defineInt: (n) => ({ name: n, value: () => 0 }), defineBoolean: (n) => ({ name: n, value: () => false }) },
  'firebase-functions/v2/firestore': { onDocumentCreated: () => ({}), onDocumentWritten: () => ({}), onDocumentUpdated: () => ({}), onDocumentDeleted: () => ({}) },
  'firebase-functions/v2/scheduler': { onSchedule: (o, h) => h },
  './messaging-controls': require('./messaging-controls-stub'),
  'firebase-admin/firestore': { getFirestore: () => DB, FieldValue, Timestamp, FieldPath: { documentId: () => '__name__' } },
  'firebase-admin/storage': { getStorage: () => ({ bucket: () => bucket }) },
  'firebase-admin/auth': { getAuth: () => ({}) },
  'firebase-admin/messaging': { getMessaging: () => vendorSpy('messaging') },
  'firebase-admin/app': { initializeApp: () => ({}), getApps: () => [{}], getApp: () => ({}) },
  'firebase-admin': { initializeApp: () => ({}), apps: [{}], firestore: Object.assign(() => DB, { FieldValue, Timestamp }) },
  stripe: vendorSpy('stripe'), twilio: vendorSpy('twilio'), resend: { Resend: vendorSpy('resend') },
};
// Rate limiter: unlimited unless a test sets W.rl = (namespace, key, limit, windowMs) => bool(allowed).
const limiter = {
  enforceRateLimit: async (ns, key, limit, windowMs) => { if (W.rl && !W.rl(ns, key, limit, windowMs)) { const e = new Error('rate_limited'); e.rateLimited = true; throw e; } return { count: 1 }; },
  httpRateLimit: async () => true,
  clientIp: () => '203.0.113.9', hashKey: (k) => String(k), provider: 'firestore', _upstashConfigured: false,
};
const pushStub = { sendCustomNotification: async (uid, title, body, data) => { W.pushes.push({ uid, title, body, data }); return { sent: 1 }; } };
const FILE_STUBS = {
  [fnPath('integrations/upstash-ratelimit.js')]: limiter,
  [fnPath('rate-limit.js')]: Object.assign({ rateLimitIpKey: (ip) => ip }, limiter),
  [fnPath('push-functions.js')]: pushStub,
  [fnPath('integrations/sentry.js')]: { withSentry: (n, fn) => fn, captureException: () => {}, ensureInit: () => {}, installRejectionHook: () => {} },
  [fnPath('integrations/heartbeat.js')]: { onSchedule: (o, h) => h },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(PKG_STUBS, request)) return PKG_STUBS[request];
  if (request === './job-spine' && parent && parent.filename && parent.filename.startsWith(FUNCTIONS)) {
    const e = new Error("Cannot find module './job-spine'"); e.code = 'MODULE_NOT_FOUND'; throw e;
  }
  if (request.charAt(0) === '.') {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { /* real load reports it */ }
    if (resolved && Object.prototype.hasOwnProperty.call(FILE_STUBS, resolved)) return FILE_STUBS[resolved];
  }
  return realLoad.apply(this, arguments);
};
global.fetch = async () => { throw new Error('no network in this suite'); };

const tick = () => new Promise((r) => setImmediate(r));
async function flush(n) { for (let i = 0; i < (n || 20); i++) await tick(); }

async function call(handler, data, token) {
  try {
    const value = await handler({ auth: token ? { uid: token.uid, token } : null, data: data || {}, rawRequest: { ip: '203.0.113.9', headers: {} } });
    return { value };
  } catch (err) { return { err }; }
}
function mkRes() {
  const chunks = [];
  const r = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.statusCode = 200; r.headers = {}; r.body = undefined; r.redirectTo = null;
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.setHeader = r.set;
  r.status = (c) => { r.statusCode = c; return r; };
  r.redirect = (c, u) => { r.statusCode = c; r.redirectTo = u; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.destroy = () => r;
  r.bytes = () => Buffer.concat(chunks).toString('utf8');
  const realEnd = r.end.bind(r);
  r.end = (...a) => { try { realEnd(...a); } catch (_) { /* ended */ } return r; };
  return r;
}
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
function mkReq(o) {
  const h = Object.assign({ 'user-agent': IPHONE }, (o && o.headers) || {});
  return Object.assign({ method: 'GET', body: {}, path: '/', headers: h, ip: '203.0.113.9', get: (k) => h[String(k).toLowerCase()] }, o || {});
}

const UPLOAD_PATH = 'docs/u1/lead-1_1730000000000_Smith_Estimate.pdf';
const TOKEN_URL = 'https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/' + encodeURIComponent(UPLOAD_PATH) + '?alt=media&token=8f1c2d4e-0000-4000-8000-123456789abc';
function baseWorld(extra) {
  resetWorld(Object.assign({
    'leads/lead-1': { userId: 'u1', companyId: 'u1', firstName: 'Sam', lastName: 'Smith', phone: '5135550100', stage: 'estimate_sent_cash' },
    'leads/lead-1/documents/doc-1': { filename: 'Smith_Estimate.pdf', type: 'application/pdf', source: 'drive_import', url: TOKEN_URL, userId: 'u1', size: 2048 },
  }, extra || {}));
  W.objects[UPLOAD_PATH] = { meta: { contentType: 'application/pdf' }, body: '%PDF-1.7 estimate bytes' };
}

module.exports = {
  ROOT, FUNCTIONS, fnPath, W, DB, resetWorld, baseWorld, call, mkReq, mkRes, flush, tick, Timestamp, FieldValue, HttpsError,
  UPLOAD_PATH, TOKEN_URL, IPHONE, pushStub,
};
