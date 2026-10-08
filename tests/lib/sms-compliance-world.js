/**
 * tests/lib/sms-compliance-world.js — a fake world for driving the REAL SMS
 * send / receive handlers (functions/sms-functions.js, storm-watch.js,
 * sms-dnc.js) with nothing reaching Twilio, Firestore or Anthropic.
 *
 * Stubs are installed at the module loader (the sms-send-optout-order.test.js
 * idiom) and read the CURRENT world at call time, so a fresh world per
 * scenario sees its own store. Every functions/*.js module is re-required per
 * load so module-level state (the cached Twilio SDK, a test's clock patch)
 * never leaks between scenarios.
 *
 * Fake Firestore: a flat Map of 'collection/doc[/sub/doc…]' → data, with
 * get / set(merge) / update / delete / create (ALREADY_EXISTS on a second
 * create), collection().add / where('==' | '>') / orderBy / limit, and a
 * runTransaction that applies writes as it goes. Server timestamps are the
 * world clock in ms (every reader in these modules accepts a number).
 */
'use strict';

const path = require('path');
const Module = require('module');

const FUNCTIONS = path.join(__dirname, '..', '..', 'functions');

let current = null;
const realLoad = Module._load;
let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  Module._load = function (request, parent, isMain) {
    if (current) {
      const stub = current.stubs[request];
      if (stub !== undefined) return stub;
    }
    return realLoad.apply(this, arguments);
  };
}

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function makeDb(w) {
  const store = w.store;
  const ts = () => w.clock.now;
  const parentOf = (p) => p.split('/').slice(0, -1).join('/');
  const idOf = (p) => p.split('/').pop();
  let seq = 0;

  function snap(p) {
    const has = store.has(p);
    return { exists: has, id: idOf(p), ref: docRef(p), data: () => (has ? JSON.parse(JSON.stringify(store.get(p))) : undefined) };
  }
  function docRef(p) {
    return {
      id: idOf(p),
      path: p,
      async get() {
        w.events.push('get:' + p);
        if (w.opts.readThrows && w.opts.readThrows(p)) throw new Error('simulated Firestore UNAVAILABLE on ' + p);
        return snap(p);
      },
      async set(data, o) {
        w.events.push('set:' + p);
        store.set(p, Object.assign({}, (o && o.merge && store.get(p)) || {}, data));
      },
      async update(data) {
        w.events.push('update:' + p);
        store.set(p, Object.assign({}, store.get(p) || {}, data));
      },
      async delete() { w.events.push('delete:' + p); store.delete(p); },
      async create(data) {
        if (store.has(p)) { const e = new Error('6 ALREADY_EXISTS: ' + p); e.code = 6; throw e; }
        w.events.push('create:' + p);
        store.set(p, Object.assign({}, data));
      },
      collection: (n) => collRef(p + '/' + n),
    };
  }
  function query(collPath, filters, lim) {
    return {
      where: (f, op, v) => query(collPath, filters.concat([[f, op, v]]), lim),
      orderBy: () => query(collPath, filters, lim),
      startAfter: () => query(collPath, filters, lim),
      limit: (n) => query(collPath, filters, n),
      async get() {
        w.events.push('query:' + collPath);
        const docs = [];
        for (const [p, d] of store) {
          if (parentOf(p) !== collPath) continue;
          const okAll = filters.every(([f, op, v]) => {
            const x = d[f];
            if (op === '==') return x === v || (x == null && v == null);
            if (op === '>') return x != null && Number(x) > Number(v instanceof Date ? v.getTime() : v);
            return true;
          });
          if (okAll) docs.push(snap(p));
        }
        const out = lim ? docs.slice(0, lim) : docs;
        return { empty: out.length === 0, size: out.length, docs: out };
      },
    };
  }
  function collRef(collPath) {
    return Object.assign(query(collPath, [], 0), {
      doc: (id) => docRef(collPath + '/' + (id || ('auto' + (++seq)))),
      async add(data) {
        const id = 'auto' + (++seq);
        w.events.push('add:' + collPath);
        store.set(collPath + '/' + id, Object.assign({}, data));
        return { id, path: collPath + '/' + id };
      },
    });
  }
  return {
    doc: docRef,
    collection: collRef,
    async runTransaction(fn) {
      const tx = {
        get: (ref) => ref.get(),
        create: (ref, d) => { if (store.has(ref.path)) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } store.set(ref.path, Object.assign({}, d)); },
        set: (ref, d, o) => { store.set(ref.path, Object.assign({}, (o && o.merge && store.get(ref.path)) || {}, d)); },
        update: (ref, d) => { store.set(ref.path, Object.assign({}, store.get(ref.path) || {}, d)); },
      };
      return fn(tx);
    },
    _ts: ts,
  };
}

/**
 * @param {object} opts
 *   docs: { path: data } seed
 *   token: decoded ID token for the caller (default rep-1 / co-1)
 *   clockMs: world clock (default 2026-10-05 12:00 America/New_York)
 *   twilioError: thrown by messages.create (read at call time: w.opts)
 *   twilioAccepted: with twilioError — Twilio took the message before the error
 *   twilioListError: thrown by messages.list
 *   readThrows(path) → true to make that doc read throw
 */
function makeWorld(opts) {
  opts = opts || {};
  const w = {
    opts,
    store: new Map(Object.entries(opts.docs || {})),
    events: [],
    twilioCalls: [],
    twilioAccepted: [],
    aiDrafts: [],
    logs: { error: [], warn: [], info: [] },
    clock: { now: opts.clockMs != null ? opts.clockMs : Date.parse('2026-10-05T16:00:00Z') },
  };
  const db = makeDb(w);
  w.db = db;
  const token = opts.token || { uid: 'rep-1', companyId: 'co-1', email_verified: true };
  w.stubs = {
    'firebase-functions/v2/https': {
      onRequest: (o, h) => ({ __opts: o, __handler: h }),
      onCall: (o, h) => ({ __opts: o, __handler: h }),
      HttpsError,
    },
    'firebase-functions/v2/firestore': {
      onDocumentUpdated: (o, h) => ({ __opts: o, __handler: h }),
      onDocumentCreated: (o, h) => ({ __opts: o, __handler: h }),
    },
    'firebase-functions/v2/scheduler': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'secret-' + n }) },
    'firebase-functions/v2': {
      logger: {
        error: (...a) => w.logs.error.push(a),
        warn: (...a) => w.logs.warn.push(a),
        info: (...a) => w.logs.info.push(a),
      },
    },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => w.clock.now, increment: (n) => n, arrayUnion: (...a) => a, delete: () => undefined },
      FieldPath: { documentId: () => '__name__' },
    },
    'firebase-admin/auth': {
      getAuth: () => ({
        verifyIdToken: async () => {
          w.events.push('auth');
          if (opts.unauthenticated) throw new Error('bad token');
          return token;
        },
      }),
    },
    'firebase-admin/messaging': { getMessaging: () => ({ send: async () => { w.events.push('push'); } }) },
    './integrations/upstash-ratelimit': {
      httpRateLimit: async () => true,
      enforceRateLimit: async (ns) => { w.events.push('limit:' + ns); return { count: 1 }; },
      clientIp: () => '203.0.113.9',
    },
    './shared': {
      requirePaidSubscription: async () => ({ ok: true, plan: 'growth' }),
      viewOnlyRefusal: (d) => (d && d.role === 'viewer'
        ? { status: 403, body: { error: 'Your role is view-only', code: 'view_only' } } : null),
    },
    './handlers/ai-texting': {
      generateAIDraft: async (args) => { w.aiDrafts.push(args); return { id: 'draft-1' }; },
      ANTHROPIC_API_KEY: { name: 'ANTHROPIC_API_KEY', value: () => '' },
    },
    './ai-draft-routing': { isPortalDraft: () => false, clampPortalText: (s) => s },
    './portal-reply-effects': { applyRepReplyEffects: async () => {} },
    './handlers/_shared': {
      requireTeamAdmin: async (request) => {
        const t = (request.auth && request.auth.token) || {};
        if (t.role === 'company_admin' || t.role === 'admin' || !t.role) return { companyId: t.companyId || request.auth.uid };
        throw new HttpsError('permission-denied', 'Owner or admin access required');
      },
    },
    twilio: Object.assign(() => ({
      messages: {
        create: async (msg) => {
          w.events.push('twilio-create');
          w.twilioCalls.push(msg);
          const sid = 'SM-test-' + w.twilioCalls.length;
          // twilioAccepted: Twilio took the message, THEN the error reached us
          // (a socket reset after the request) — it is on Twilio's list.
          if (!w.opts.twilioError || w.opts.twilioAccepted) {
            w.twilioAccepted.unshift(Object.assign({ sid, dateCreated: new Date(), status: 'queued' }, msg));
          }
          if (w.opts.twilioError) throw w.opts.twilioError;
          return { sid };
        },
        // Newest first, filtered like the API's To / From parameters.
        list: async (q) => {
          w.events.push('twilio-list');
          if (w.opts.twilioListError) throw w.opts.twilioListError;
          const f = q || {};
          return w.twilioAccepted.filter((m) => (!f.to || m.to === f.to) && (!f.from || m.from === f.from)).slice(0, f.limit || 50);
        },
      },
    }), { validateRequest: () => true }),
  };
  return w;
}

/** Load a functions/ module fresh inside world `w`. */
function load(w, rel) {
  hook();
  current = w;
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FUNCTIONS) && k.indexOf('node_modules') === -1) delete require.cache[k];
  }
  const mod = require(path.join(FUNCTIONS, rel));
  // The clock seam the send paths read (sms-outbox-guard.js nowMs) — this
  // world's copy of the module, re-required above.
  try {
    const Outbox = require(path.join(FUNCTIONS, 'sms-outbox-guard.js'));
    Outbox.nowMs = () => w.clock.now;
  } catch (_) { /* module absent on an old tree */ }
  return mod;
}

function mkRes() {
  const r = { statusCode: 200, body: undefined, headers: {} };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.type = (t) => { r.headers['Content-Type'] = t; return r; };
  return r;
}

/** Run an onRequest handler; an escaped throw becomes the framework's 500. */
async function invoke(handler, req) {
  const res = mkRes();
  const full = Object.assign({ method: 'POST', headers: { authorization: 'Bearer t' }, get: () => 'example.test', originalUrl: '/x' }, req);
  try { await handler(full, res); } catch (e) { res.statusCode = 500; res.body = 'Internal Server Error'; res.threw = e; }
  return res;
}

module.exports = { makeWorld, load, invoke, mkRes, HttpsError, FUNCTIONS };
