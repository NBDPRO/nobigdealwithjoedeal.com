/**
 * tests/portal-link-checks-2026-10-08.test.js
 *
 * Review R3 item 3 (open list 2026-10-08): six homeowner-portal endpoints
 * checked only that the link had not expired —
 *
 *   getPortalDocumentHtml   (portal document page)
 *   uploadHomeownerPhoto    (photo upload)
 *   requestCallback         (request a callback)
 *   reportWarrantyClaim     (warranty claim)
 *   submitCustomerRating    (rating)
 *   sendPortalMessage       (send message)
 *
 * — skipping the replay cap (uses >= maxUses) and the lead match
 * (tokenMatchesLead: an old tenant's link to a lead id another tenant has
 * since re-created). And getHomeownerPortalView skipped the cap whenever the
 * client said `poll: true`, so polling kept a used-up link alive and let any
 * caller read without spending a use.
 *
 * Fix: one check, functions/portal-authz.js portalTokenRefusal +
 * portalLinkRefusal, used by every portal endpoint; a poll is free only
 * within 12h of the last counted open (viewCountsAsOpen).
 *
 * This suite drives the REAL handlers on a fake Firestore + Storage. For each
 * of the six: a valid link works and writes (happy path), a used-up link and
 * a wrong-lead link are refused AND write nothing. Plus the view's poll rules.
 *
 * Nothing is sent: no network (global fetch throws), vendors throw, push is a
 * spy. Harness copied from tests/portal-after-signing-2026-10-07.test.js.
 * Needs functions/ deps (sharp, for the upload's re-encode).
 *
 * Run: node tests/portal-link-checks-2026-10-08.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');
const { Writable } = require('stream');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const fnPath = (rel) => path.join(FUNCTIONS, rel);
const fnRequire = createRequire(path.join(FUNCTIONS, 'package.json'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── World + fake Firestore (equality where() honoured) ───────────────────
let W = null;
function resetWorld(docs) { W = { docs: JSON.parse(JSON.stringify(docs || {}), reviveTs), objects: {}, saved: [], pushes: [], seq: 0, now: Date.now() }; }
function reviveTs(k, v) { return (v && typeof v === 'object' && v.__ms !== undefined) ? Timestamp.fromMillis(v.__ms) : v; }
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const Timestamp = {
  fromMillis: (ms) => ({ __ms: ms, toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000) }),
  fromDate: (d) => Timestamp.fromMillis(d.getTime()),
  now: () => Timestamp.fromMillis(Date.now()),
};
const FieldValue = {
  serverTimestamp: () => Timestamp.fromMillis(Date.now()),
  increment: (n) => ({ __inc: n }),
  arrayUnion: (...a) => ({ __union: a }),
  delete: () => ({ __del: true }),
};
function applyPatch(prev, v) {
  const out = Object.assign({}, prev || {});
  Object.keys(v).forEach((k) => {
    const x = v[k];
    // dotted keys (uploadsByDay.2026-10-08) — store flat; only counted here
    if (x && typeof x === 'object' && '__inc' in x) out[k] = (Number(out[k]) || 0) + x.__inc;
    else if (x && typeof x === 'object' && x.__del) delete out[k];
    else out[k] = x;
  });
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
          .filter((k) => filters.every(([f, op, v]) => op !== '==' || (W.docs[k] || {})[f] === v))
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
    save: async (buf) => { W.saved.push(p); W.objects[p] = { body: Buffer.from(buf).toString('utf8'), meta: {} }; },
    getMetadata: async () => { const o = W.objects[p]; if (!o) { const e = new Error('No such object'); e.code = 404; throw e; } return [Object.assign({ size: String(o.body.length) }, o.meta)]; },
    download: async () => { const o = W.objects[p]; if (!o) { const e = new Error('No such object'); e.code = 404; throw e; } return [Buffer.from(o.body)]; },
    getSignedUrl: async () => ['https://storage.example.invalid/signed'],
    delete: async () => {},
  }),
};

const logger = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
const httpsStub = {
  onCall: (o, h) => (typeof o === 'function' ? o : h),
  onRequest: (o, h) => (typeof o === 'function' ? o : h),
  HttpsError,
};
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
  'firebase-functions/v2/scheduler': { onSchedule: () => ({}) },
  'firebase-admin/firestore': { getFirestore: () => DB, FieldValue, Timestamp, FieldPath: { documentId: () => '__name__' } },
  'firebase-admin/storage': { getStorage: () => ({ bucket: () => bucket }) },
  'firebase-admin/auth': { getAuth: () => ({}) },
  'firebase-admin/messaging': { getMessaging: () => vendorSpy('messaging') },
  'firebase-admin/app': { initializeApp: () => ({}), getApps: () => [{}], getApp: () => ({}) },
  'firebase-admin': { initializeApp: () => ({}), apps: [{}], firestore: Object.assign(() => DB, { FieldValue, Timestamp }) },
  stripe: vendorSpy('stripe'), twilio: vendorSpy('twilio'), resend: { Resend: vendorSpy('resend') },
};
const limiter = {
  enforceRateLimit: async () => ({ count: 1 }),
  httpRateLimit: async () => true,
  clientIp: () => '203.0.113.9', hashKey: (k) => String(k), provider: 'firestore', _upstashConfigured: false,
};
const pushStub = { sendCustomNotification: async (uid, title, body, data) => { W.pushes.push({ uid, title, body, data }); return { sent: 1 }; } };
const FILE_STUBS = {
  [fnPath('integrations/upstash-ratelimit.js')]: limiter,
  [fnPath('rate-limit.js')]: Object.assign({ rateLimitIpKey: (ip) => ip }, limiter),
  [fnPath('push-functions.js')]: pushStub,
  [fnPath('integrations/sentry.js')]: { withSentry: (n, fn) => fn, captureException: () => {}, ensureInit: () => {}, installRejectionHook: () => {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(PKG_STUBS, request)) return PKG_STUBS[request];
  if (request.charAt(0) === '.') {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { /* real load reports it */ }
    if (resolved && Object.prototype.hasOwnProperty.call(FILE_STUBS, resolved)) return FILE_STUBS[resolved];
  }
  return realLoad.apply(this, arguments);
};
global.fetch = async () => { throw new Error('no network in this suite'); };

const PORTAL = require(fnPath('portal.js'));
const HP = require(fnPath('homeowner-progress.js'));

function mkRes() {
  const r = new Writable({ write(c, e, cb) { cb(); } });
  r.statusCode = 200; r.headers = {}; r.body = undefined;
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.setHeader = r.set;
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  const realEnd = r.end.bind(r);
  r.end = (...a) => { try { realEnd(...a); } catch (_) { /* ended */ } return r; };
  return r;
}
function mkReq(body) {
  const h = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)' };
  return { method: 'POST', body, path: '/', headers: h, ip: '203.0.113.9', get: (k) => h[String(k).toLowerCase()] };
}
async function post(handlerName, body) {
  const res = mkRes();
  await PORTAL[handlerName](mkReq(body), res);
  return res;
}

// ── Fixtures ─────────────────────────────────────────────────────────────
const DAY = 86_400_000;
const NOW = Date.now();
const LEAD = 'lead-1';
const T = {
  good:      'GOODTOKEN0000000000000AB',
  usedUp:    'USEDUPTOKEN000000000000A',
  wrongLead: 'WRONGLEADTOKEN0000000000',
  revoked:   'REVOKEDTOKEN000000000000',
};
const tok = (extra) => Object.assign({ leadId: LEAD, ownerUid: 'u1', companyId: 'coA', expiresAt: { __ms: NOW + 30 * DAY }, uses: 3, maxUses: 100 }, extra || {});
function baseWorld(extraDocs) {
  return Object.assign({
    [`leads/${LEAD}`]: { userId: 'u1', companyId: 'coA', firstName: 'Sam', lastName: 'Smith', stage: 'final_payment' },
    'users/u1': { displayName: 'Jo', companyName: 'No Big Deal Home Solutions' },
    [`portal_tokens/${T.good}`]: tok(),
    // Spent: uses has reached maxUses.
    [`portal_tokens/${T.usedUp}`]: tok({ uses: 100 }),
    // Minted by ANOTHER tenant for this lead id (the lead was hard-deleted and
    // re-created at the same id by coA): companyId does not match the lead's.
    [`portal_tokens/${T.wrongLead}`]: tok({ companyId: 'coB', ownerUid: 'uB' }),
    // revokedAt stamped (defence in depth: revoke also moves expiry back).
    [`portal_tokens/${T.revoked}`]: tok({ revokedAt: { __ms: NOW - 1000 } }),
    [`leads/${LEAD}/documents/doc-1`]: { name: 'Contract', generated: true, htmlPath: `documents/u1/${LEAD}/contract.html` },
  }, extraDocs || {});
}
const docsUnder = (prefix) => Object.keys(W.docs).filter((k) => k.startsWith(prefix));

let JPEG = null;

// Each endpoint: how to call it, and whether it took effect.
const ENDPOINTS = [
  {
    name: 'getPortalDocumentHtml (portal document page)',
    fn: 'getPortalDocumentHtml',
    body: (t) => ({ token: t, docId: 'doc-1' }),
    effect: (res) => !!(res.body && typeof res.body.html === 'string'),
  },
  {
    name: 'uploadHomeownerPhoto (photo upload)',
    fn: 'uploadHomeownerPhoto',
    body: (t) => ({ token: t, dataUrl: 'data:image/jpeg;base64,' + JPEG.toString('base64'), caption: 'hail on the ridge' }),
    effect: () => W.saved.length > 0 || docsUnder('photos/').length > 0,
  },
  {
    name: 'requestCallback (request a callback)',
    fn: 'requestCallback',
    body: (t) => ({ token: t, slot: 'anytime', note: 'after 5' }),
    effect: () => docsUnder(`leads/${LEAD}/tasks/`).length > 0,
  },
  {
    name: 'reportWarrantyClaim (warranty claim)',
    fn: 'reportWarrantyClaim',
    body: (t) => ({ token: t, issueDescription: 'Drip by the chimney' }),
    effect: () => docsUnder(`leads/${LEAD}/warrantyClaims/`).length > 0 || docsUnder(`leads/${LEAD}/tasks/`).length > 0,
  },
  {
    name: 'submitCustomerRating (rating)',
    fn: 'submitCustomerRating',
    body: (t) => ({ token: t, stars: 5, comment: 'Great crew' }),
    effect: () => typeof (W.docs[`leads/${LEAD}`] || {}).customerRating === 'number',
  },
  {
    name: 'sendPortalMessage (send message)',
    fn: 'sendPortalMessage',
    body: (t) => ({ token: t, text: 'Is Thursday still on?' }),
    effect: () => docsUnder(`leads/${LEAD}/portal_messages/`).length > 0,
  },
];

(async () => {
  const sharp = fnRequire('sharp');
  JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 90, b: 60 } } }).jpeg().toBuffer();

  console.log('\n0. Fixture controls');
  ok('the lead fixture counts as paid in full (so the rating happy path is reachable)',
    HP.paidInFullFor({ stage: 'final_payment' }, []) === true);

  for (const ep of ENDPOINTS) {
    console.log('\n' + ep.name);

    // Happy path FIRST: proves the endpoint really works with a valid link, so
    // the refusals below are refusals of the link and not a broken harness.
    resetWorld(baseWorld());
    W.objects[`documents/u1/${LEAD}/contract.html`] = { body: '<p>Contract</p>', meta: {} };
    const good = await post(ep.fn, ep.body(T.good));
    ok('a valid link works (200) and takes effect', good.statusCode === 200 && ep.effect(good),
      'status ' + good.statusCode + ' ' + JSON.stringify(good.body));

    for (const [label, t, status] of [
      ['a used-up link (uses >= maxUses)', T.usedUp, 429],
      ['a link minted for another tenant\'s lead (lead mismatch)', T.wrongLead, 404],
      ['a revoked link (revokedAt stamped)', T.revoked, 410],
    ]) {
      resetWorld(baseWorld());
      W.objects[`documents/u1/${LEAD}/contract.html`] = { body: '<p>Contract</p>', meta: {} };
      const before = JSON.stringify(W.docs[`portal_tokens/${t}`]);
      const r = await post(ep.fn, ep.body(t));
      ok(label + ' is refused (' + status + ')', r.statusCode === status, 'status ' + r.statusCode + ' ' + JSON.stringify(r.body));
      ok('…and takes no effect (nothing written, no quota slot spent)',
        !ep.effect(r) && JSON.stringify(W.docs[`portal_tokens/${t}`]) === before,
        'token now ' + JSON.stringify(W.docs[`portal_tokens/${t}`]));
    }
  }

  console.log('\ngetPortalMessages (strict read — gains the lead match)');
  {
    resetWorld(baseWorld({ [`leads/${LEAD}/portal_messages/m1`]: { leadId: LEAD, text: 'Hi', from: 'rep', createdAt: { __ms: NOW } } }));
    const g = await post('getPortalMessages', { token: T.good });
    ok('a valid link reads the thread', g.statusCode === 200, 'status ' + g.statusCode);
    const w = await post('getPortalMessages', { token: T.wrongLead });
    ok('a wrong-lead link is refused (404)', w.statusCode === 404, 'status ' + w.statusCode);
    const u = await post('getPortalMessages', { token: T.usedUp });
    ok('a used-up link is still refused (429)', u.statusCode === 429, 'status ' + u.statusCode);
  }

  console.log('\ngetHomeownerPortalView — opens and polls');
  {
    resetWorld(baseWorld());
    const open = await post('getHomeownerPortalView', { token: T.good });
    const t1 = W.docs[`portal_tokens/${T.good}`];
    ok('a genuine open works (200) and spends one use', open.statusCode === 200 && t1.uses === 4,
      'status ' + open.statusCode + ' uses ' + t1.uses + ' ' + JSON.stringify(open.body && open.body.error));
    ok('…and stamps lastOpenAt (starts the poll session)', !!(t1.lastOpenAt && t1.lastOpenAt.toMillis));

    const poll = await post('getHomeownerPortalView', { token: T.good, poll: true });
    ok('a poll inside the session works (200) and is free', poll.statusCode === 200 && W.docs[`portal_tokens/${T.good}`].uses === 4,
      'status ' + poll.statusCode + ' uses ' + W.docs[`portal_tokens/${T.good}`].uses);

    // A tab left open past the session window (or `poll: true` with no open).
    W.docs[`portal_tokens/${T.good}`].lastOpenAt = Timestamp.fromMillis(Date.now() - 13 * 3600e3);
    const stale = await post('getHomeownerPortalView', { token: T.good, poll: true });
    ok('a poll after the 12h session works but spends one use', stale.statusCode === 200 && W.docs[`portal_tokens/${T.good}`].uses === 5,
      'uses ' + W.docs[`portal_tokens/${T.good}`].uses);

    resetWorld(baseWorld());
    const bare = await post('getHomeownerPortalView', { token: T.good, poll: true });
    ok('`poll: true` with no counted open is not a free read — it spends a use', bare.statusCode === 200 && W.docs[`portal_tokens/${T.good}`].uses === 4,
      'uses ' + W.docs[`portal_tokens/${T.good}`].uses);

    resetWorld(baseWorld());
    W.docs[`portal_tokens/${T.usedUp}`].lastOpenAt = Timestamp.fromMillis(Date.now() - 60e3);
    const deadPoll = await post('getHomeownerPortalView', { token: T.usedUp, poll: true });
    ok('a poll on a used-up link is refused (429) — polling cannot keep it alive', deadPoll.statusCode === 429,
      'status ' + deadPoll.statusCode);
    const deadOpen = await post('getHomeownerPortalView', { token: T.usedUp });
    ok('an open on a used-up link is refused (429 too_many_opens)', deadOpen.statusCode === 429 && deadOpen.body.code === 'too_many_opens');
    const wl = await post('getHomeownerPortalView', { token: T.wrongLead, poll: true });
    ok('a wrong-lead link is refused on a poll too (404 project_missing)', wl.statusCode === 404 && wl.body.code === 'project_missing',
      'status ' + wl.statusCode);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
