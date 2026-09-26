/**
 * tests/viewer-callables.test.js
 *
 * WHY THIS EXISTS (2026-09-25)
 * ────────────────────────────
 * Jo's decision B (2026-09-25, final): "The 'viewer' role is READ-ONLY
 * everywhere: a viewer can read what their company role allows but cannot
 * create, update or delete any tenant data — including rows under leads they
 * own." #1776 enforced it in firestore.rules / storage.rules and the client.
 * Cloud Functions write with the Admin SDK, which bypasses the rules, and most
 * callables checked ownership only — a viewer's browser could still write,
 * text a homeowner, mint a portal / share / sign link or order a paid
 * measurement through them. functions/shared.js now has ONE guard
 * (assertNotViewer for onCall, viewOnlyRefusal for onRequest) and every such
 * handler calls it first.
 *
 *   A. the helper — only a positive role === 'viewer' is refused; a solo
 *      operator (no role claim) and every other role pass; exact code + text.
 *   B. every refused handler, driven for real against stubbed firebase
 *      modules (the email-unsubscribe.test.js idiom): a viewer gets the
 *      view-only refusal with NO side effect recorded (no Firestore op, no
 *      per-uid limiter, no vendor call); a sales_rep and a solo operator with
 *      the SAME input get past the guard (not refused, and the handler body
 *      ran — at least one side effect recorded). Plus the two conditional
 *      guards' open branches (transcript-only voice memo, calendar revokeOnly).
 *      "Past the guard" is all section B proves for the other roles: most of
 *      those runs stop at a missing lead / envelope / secret right after it.
 *   B3. (2026-09-25, #1780 review) so the guard is shown not to cost anyone
 *      else a workflow: for the Firestore-only handlers, the caller's OWN
 *      lead / deal / report is seeded and a sales_rep and a solo operator run
 *      the handler to completion (its result returned, its terminal write
 *      recorded); a viewer who owns the very same data is still refused with
 *      zero side effects ("including rows under leads they own").
 *   C. the sweep is enforced: functions/index.js is loaded in a child process
 *      and EVERY exported callable / HTTP function must carry a verdict in
 *      VERDICTS below. A new function fails this suite until someone decides
 *      whether a viewer may call it. Every 'refused' verdict must have a
 *      section-B case, and every case a 'refused' verdict.
 *
 * Needs functions/node_modules (the unit-suite-manifest CI job installs it)
 * for section C and for the vendor-free modules the handlers load. Run:
 *   node tests/viewer-callables.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const fnPath = (rel) => path.join(FUNCTIONS, rel);
const VIEW_ONLY = 'Your role is view-only';

// ── The world every stub reads and records into ─────────────────────────
// Stubs are created ONCE and read `W` at call time, so a module that caches
// a stub at load (shared.js caches getAuth()) still sees the current caller.
let W = null;
function resetWorld(token) {
  W = { token: token || null, docs: {}, events: [], effects: [], seq: 0 };
}
function ev(tag) { if (W) W.events.push(tag); }
// A side effect: anything the guard must come BEFORE for a viewer.
function fx(tag) { if (W) { W.events.push(tag); W.effects.push(tag); } }

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// A recording stand-in for a vendor SDK (stripe, twilio, resend, …): every
// call is a side effect and rejects, so nothing ever reaches a network.
function vendor(name) {
  const fn = function () {};
  return new Proxy(fn, {
    get: (t, k) => (k === 'then' ? undefined : (k === Symbol.toPrimitive ? () => name : vendor(name + '.' + String(k)))),
    apply: () => { fx('vendor:' + name); return Object.assign(Promise.reject(new Error('stubbed vendor ' + name)), { catch: Promise.prototype.catch }); },
    construct: () => vendor(name),
  });
}

const Timestamp = {
  fromMillis: (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000) }),
  fromDate: (d) => Timestamp.fromMillis(d.getTime()),
  now: () => Timestamp.fromMillis(Date.now()),
};
const FieldValue = {
  serverTimestamp: () => ({ __fv: 'ts' }),
  increment: (n) => ({ __fv: 'inc', n }),
  arrayUnion: (...a) => ({ __fv: 'union', a }),
  arrayRemove: (...a) => ({ __fv: 'remove', a }),
  delete: () => ({ __fv: 'delete' }),
};

function makeDb() {
  function snap(p) {
    const d = W.docs[p];
    return { exists: d != null, id: p.split('/').pop(), ref: docRef(p), data: () => (d == null ? undefined : Object.assign({}, d)), get: (k) => (d ? d[k] : undefined) };
  }
  function docRef(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => { fx('read:' + p); return snap(p); },
      set: async (v, o) => { fx('write:' + p); W.docs[p] = (o && o.merge) ? Object.assign({}, W.docs[p] || {}, v) : v; },
      create: async (v) => { fx('write:' + p); W.docs[p] = v; },
      update: async (v) => {
        fx('update:' + p);
        if (W.docs[p] == null) { const e = new Error('NOT_FOUND: ' + p); e.code = 5; throw e; }
        W.docs[p] = Object.assign({}, W.docs[p], v);
      },
      delete: async () => { fx('delete:' + p); delete W.docs[p]; },
      collection: (n) => coll(p + '/' + n),
      listCollections: async () => { fx('list:' + p); return []; },
    };
  }
  function query(name) {
    const q = {
      where: () => q, orderBy: () => q, limit: () => q, limitToLast: () => q, startAfter: () => q, select: () => q, offset: () => q,
      get: async () => { fx('query:' + name); return { empty: true, size: 0, docs: [], forEach: () => {} }; },
      count: () => ({ get: async () => { fx('count:' + name); return { data: () => ({ count: 0 }) }; } }),
    };
    return q;
  }
  function coll(name) {
    return Object.assign(query(name), {
      id: name.split('/').pop(), path: name,
      doc: (id) => docRef(name + '/' + (id || ('auto' + (++W.seq)))),
      add: async (v) => { const id = 'auto' + (++W.seq); fx('add:' + name); W.docs[name + '/' + id] = v; return docRef(name + '/' + id); },
    });
  }
  return {
    doc: docRef,
    collection: coll,
    collectionGroup: (n) => query('group:' + n),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    batch: () => {
      const ops = [];
      const b = {
        set: (r, v, o) => { ops.push(() => r.set(v, o)); return b; },
        create: (r, v) => { ops.push(() => r.set(v)); return b; },
        update: (r, v) => { ops.push(() => r.update(v)); return b; },
        delete: (r) => { ops.push(() => r.delete()); return b; },
        commit: async () => { fx('batch'); for (const op of ops) await op(); },
      };
      return b;
    },
    runTransaction: async (fn) => {
      fx('tx');
      const tx = {
        get: (r) => r.get(),
        getAll: (...rs) => Promise.all(rs.map((r) => r.get())),
        set: (r, v, o) => { r.set(v, o); return tx; },
        create: (r, v) => { r.set(v); return tx; },
        update: (r, v) => { r.update(v); return tx; },
        delete: (r) => { r.delete(); return tx; },
      };
      return fn(tx);
    },
  };
}
const DB = makeDb();

const noopTrigger = () => ({ __trigger: true });
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, log: () => {}, write: () => {} };
const httpsStub = {
  onCall: (o, h) => ({ __opts: o, __handler: typeof o === 'function' ? o : h }),
  onRequest: (o, h) => ({ __opts: o, __handler: typeof o === 'function' ? o : h }),
  HttpsError,
};
const secret = (n) => ({ name: n, value: () => '' });
const bucket = {
  name: 'demo-bucket',
  file: (p) => ({
    name: p,
    save: async () => fx('storage:save:' + p),
    download: async () => { fx('storage:download:' + p); throw new Error('no object'); },
    getMetadata: async () => { fx('storage:meta:' + p); throw new Error('no object'); },
    exists: async () => { fx('storage:exists:' + p); return [false]; },
    delete: async () => fx('storage:delete:' + p),
    getSignedUrl: async () => { fx('storage:sign:' + p); return ['https://example.invalid/signed']; },
    setMetadata: async () => fx('storage:setmeta:' + p),
  }),
  getFiles: async () => { fx('storage:list'); return [[]]; },
  setCorsConfiguration: async () => fx('storage:cors'),
};

const PKG_STUBS = {
  'firebase-functions/v2/https': httpsStub,
  'firebase-functions/v2': { logger, https: httpsStub },
  'firebase-functions': { logger, https: httpsStub, config: () => ({}) },
  'firebase-functions/params': {
    defineSecret: secret, defineString: secret, defineInt: (n) => ({ name: n, value: () => 0 }),
    defineBoolean: (n) => ({ name: n, value: () => false }),
  },
  'firebase-functions/v2/firestore': {
    onDocumentCreated: noopTrigger, onDocumentWritten: noopTrigger, onDocumentUpdated: noopTrigger, onDocumentDeleted: noopTrigger,
  },
  'firebase-functions/v2/scheduler': { onSchedule: noopTrigger },
  'firebase-functions/v2/storage': { onObjectFinalized: noopTrigger },
  'firebase-functions/v2/identity': { beforeUserCreated: noopTrigger },
  'firebase-admin/firestore': { getFirestore: () => DB, FieldValue, Timestamp, FieldPath: { documentId: () => '__name__' } },
  'firebase-admin/auth': {
    getAuth: () => ({
      verifyIdToken: async () => { ev('auth'); if (!W.token) throw new Error('no token'); return Object.assign({}, W.token); },
      getUser: async (uid) => { fx('auth:getUser'); return { uid, email: 'u@example.com', emailVerified: true, customClaims: {} }; },
      getUserByEmail: async () => { fx('auth:getUserByEmail'); const e = new Error('nf'); e.code = 'auth/user-not-found'; throw e; },
      setCustomUserClaims: async () => fx('auth:setClaims'),
      createUser: async () => { fx('auth:createUser'); return { uid: 'new' }; },
      revokeRefreshTokens: async () => fx('auth:revoke'),
      createCustomToken: async () => { fx('auth:customToken'); return 'tok'; },
    }),
  },
  'firebase-admin/storage': { getStorage: () => ({ bucket: () => bucket }) },
  'firebase-admin/messaging': { getMessaging: () => vendor('messaging') },
  'firebase-admin/app': { initializeApp: () => ({}), getApps: () => [{}], getApp: () => ({}) },
  'firebase-admin': { initializeApp: () => ({}), apps: [{}], firestore: Object.assign(() => DB, { FieldValue, Timestamp }), auth: () => PKG_STUBS['firebase-admin/auth'].getAuth() },
  stripe: vendor('stripe'),
  twilio: vendor('twilio'),
  resend: { Resend: vendor('resend') },
  'puppeteer-core': vendor('puppeteer'),
  '@sparticuz/chromium': vendor('chromium'),
};

const limiter = {
  enforceRateLimit: async (ns) => { fx('limit:' + (typeof ns === 'string' ? ns : 'object')); return { count: 1 }; },
  httpRateLimit: async (req, res, ns) => { ev('iplimit:' + ns); return true; },
  clientIp: () => '203.0.113.9',
  hashKey: (k) => String(k),
  provider: 'firestore',
  _upstashConfigured: false,
};
const FILE_STUBS = {
  [fnPath('integrations/upstash-ratelimit.js')]: limiter,
  [fnPath('rate-limit.js')]: Object.assign({ rateLimitIpKey: (ip) => ip }, limiter),
  [fnPath('integrations/killswitch.js')]: {
    getFlags: async () => ({}), isAiDisabled: async () => false, isWebLeadMeasureDisabled: async () => false,
    isVoiceIntelDisabled: async () => false, isAiDraftDisabled: async () => false, _resetCache: () => {},
  },
  [fnPath('integrations/sentry.js')]: {
    withSentry: (n, fn) => fn, captureException: () => {}, ensureInit: () => {}, installRejectionHook: () => {},
  },
  [fnPath('integrations/heartbeat.js')]: { onSchedule: noopTrigger, withHeartbeat: (s, h) => h, pingHeartbeat: async () => {} },
};

// On for the whole run: several handlers require the limiter, firebase-admin
// and the HttpsError class LAZILY, inside the handler body, so a hook that was
// only on while a module loaded let those calls reach the real SDKs.
const hookOn = true;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (hookOn) {
    if (Object.prototype.hasOwnProperty.call(PKG_STUBS, request)) return PKG_STUBS[request];
    if (request.charAt(0) === '.') {
      let resolved = null;
      try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { /* let the real load report it */ }
      if (resolved && Object.prototype.hasOwnProperty.call(FILE_STUBS, resolved)) return FILE_STUBS[resolved];
    }
  }
  return realLoad.apply(this, arguments);
};

// Nothing in this suite may reach a network.
global.fetch = async (url) => { fx('fetch:' + String(url).slice(0, 60)); throw new Error('stubbed fetch'); };

const mods = {};
function load(rel) {
  if (!mods[rel]) mods[rel] = require(fnPath(rel));
  return mods[rel];
}

function mkRes() {
  const r = { statusCode: 200, body: undefined, headers: {}, ended: false };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.setHeader = r.set;
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  r.send = (b) => { r.body = b; r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((resolve) => { t = setTimeout(() => resolve({ timedOut: true }), ms); })])
    .finally(() => clearTimeout(t));
}

// ── Callers ─────────────────────────────────────────────────────────────
const CALLERS = {
  viewer:   { uid: 'u-viewer', token: { role: 'viewer', companyId: 'co-1', email: 'v@example.com', email_verified: true } },
  salesRep: { uid: 'u-rep', token: { role: 'sales_rep', companyId: 'co-1', email: 'r@example.com', email_verified: true } },
  // A solo operator carries NO role claim (and no team companyId).
  solo:     { uid: 'u-solo', token: { email: 's@example.com', email_verified: true } },
};

async function invoke(c, caller) {
  const who = CALLERS[caller];
  const handler = load(c.file)[c.fn].__handler;
  if (typeof handler !== 'function') return { kind: 'missing' };
  resetWorld(Object.assign({ uid: who.uid }, who.token));
  // B3: the caller's own docs (seeding is not a side effect — W.effects only
  // records what the handler does).
  if (typeof c.seed === 'function') Object.assign(W.docs, c.seed(who));
  if (c.kind === 'call') {
    const request = {
      auth: { uid: who.uid, token: Object.assign({ uid: who.uid }, who.token) },
      data: JSON.parse(JSON.stringify(c.data || {})),
      rawRequest: { headers: {}, ip: '203.0.113.9' },
    };
    const out = await withTimeout(Promise.resolve().then(() => handler(request)).then(
      (value) => ({ value }), (err) => ({ err })), 8000);
    return Object.assign(out, { effects: W.effects.slice() });
  }
  const res = mkRes();
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer t', origin: 'https://nobigdealwithjoedeal.com', 'content-type': 'application/json' },
    body: JSON.parse(JSON.stringify(c.body || {})),
    ip: '203.0.113.9', query: {}, get: () => '',
  };
  const out = await withTimeout(Promise.resolve().then(() => handler(req, res)).then(
    () => ({}), (err) => ({ err })), 8000);
  return Object.assign(out, { res, effects: W.effects.slice() });
}

function isViewOnly(c, r) {
  if (c.kind === 'call') {
    return !!(r.err && r.err.code === 'permission-denied' && r.err.message === VIEW_ONLY);
  }
  return !!(r.res && r.res.statusCode === 403 && r.res.body
    && r.res.body.error === VIEW_ONLY && r.res.body.code === 'view-only');
}
function describe(r) {
  if (r.kind === 'missing') return 'handler not found';
  if (r.timedOut) return 'timed out; effects=' + r.effects.length;
  if (r.err) return 'threw ' + (r.err.code || '') + ' ' + r.err.message + '; effects=' + r.effects.join(',');
  if (r.res) return 'HTTP ' + r.res.statusCode + ' ' + JSON.stringify(r.res.body) + '; effects=' + r.effects.join(',');
  return 'returned; effects=' + r.effects.join(',');
}

// ── Section B cases: one per refused handler ────────────────────────────
// `data`/`body` is the SAME for every caller, so a difference in outcome is
// the role and nothing else.
const LEAD = { leadId: 'lead-1' };
const CASES = [
  { fn: 'attachStormProof', file: 'handlers/storm-proof.js', kind: 'call', data: LEAD },
  { fn: 'requestMeasurement', file: 'integrations/measurement.js', kind: 'call', data: { address: '123 Main St, Cincinnati OH', leadId: 'lead-1' } },
  { fn: 'createPortalToken', file: 'portal.js', kind: 'call', data: LEAD },
  { fn: 'revokePortalToken', file: 'portal.js', kind: 'call', data: LEAD },
  { fn: 'replyToPortalMessage', file: 'portal.js', kind: 'call', data: { leadId: 'lead-1', text: 'On our way' } },
  { fn: 'createEsignEnvelope', file: 'esign-envelope.js', kind: 'call', data: { leadId: 'lead-1', envelopeId: 'env-123456', sourcePath: 'esign/u/lead-1/env-123456/source.pdf', title: 'Contract' } },
  { fn: 'saveEsignFields', file: 'esign-envelope.js', kind: 'call', data: { envelopeId: 'env-123456', fields: [] } },
  { fn: 'sendEsignEnvelope', file: 'esign-envelope.js', kind: 'call', data: { envelopeId: 'env-123456', signerName: 'Sam', signerEmail: 'sam@example.com' } },
  { fn: 'voidEsignEnvelope', file: 'esign-envelope.js', kind: 'call', data: { envelopeId: 'env-123456' } },
  { fn: 'createSignRequest', file: 'remote-signing.js', kind: 'call', data: { leadId: 'lead-1', docId: 'doc-1', signerEmail: 'sam@example.com', signerName: 'Sam' } },
  { fn: 'sendEstimateForSignature', file: 'integrations/esign.js', kind: 'call', data: { estimateId: 'est-1', signerName: 'Sam', signerEmail: 'sam@example.com', html: '<p>' + 'x'.repeat(200) + '</p>' } },
  { fn: 'createDealAcceptToken', file: 'deal-acceptance.js', kind: 'call', data: { dealId: 'deal-123456' } },
  { fn: 'createReportShareToken', file: 'report-sharing.js', kind: 'call', data: { reportId: 'report-123456' } },
  { fn: 'transcribeVoiceMemo', file: 'integrations/voice-memo.js', kind: 'call', data: { leadId: 'lead-1', audioBase64: 'A'.repeat(400), mimeType: 'audio/webm' } },
  { fn: 'analyzePhotoVision', file: 'photo-vision.js', kind: 'call', data: { photoId: 'photo-1' } },
  { fn: 'backfillAnalytics', file: 'handlers/migrations.js', kind: 'call', data: {} },
  { fn: 'trackUsage', file: 'billing.js', kind: 'call', data: { feature: 'leads' } },
  { fn: 'renderPdf', file: 'render-pdf.js', kind: 'call', data: { template: 'contract', payload: {}, filename: 'x.pdf' } },
  { fn: 'createCalendarFeedToken', file: 'calendar-feed.js', kind: 'call', data: {} },
  { fn: 'sendSMS', file: 'sms-functions.js', kind: 'http', body: { to: '+15135550100', body: 'Hi Sam', leadId: 'lead-1' } },
  { fn: 'sendQueuedSMS', file: 'sms-functions.js', kind: 'http', body: { to: '+15135550100', body: 'Hi Sam', leadId: 'lead-1', clientMsgId: 'm-1', createdAt: Date.now() } },
  { fn: 'sendD2DSMS', file: 'sms-functions.js', kind: 'http', body: { knockId: 'knock-1', templateKey: 'followUp' } },
  { fn: 'analyzeRoofPhoto', file: 'handlers/photo.js', kind: 'http', body: { photoId: 'photo-1' } },
  { fn: 'createCheckoutSession', file: 'stripe.js', kind: 'http', body: { plan: 'starter' } },
  { fn: 'createCustomerPortalSession', file: 'stripe.js', kind: 'http', body: {} },
  { fn: 'createStripePaymentLink', file: 'stripe.js', kind: 'http', body: { invoiceId: 'inv-1' } },
  // 2026-09-25 (#1780 review): paid vendor calls whose only client use is a
  // write flow a viewer cannot finish.
  { fn: 'previewAiPersona', file: 'handlers/ai-texting-preview.js', kind: 'call', data: { config: {}, sampleMessage: 'How much for a roof?' } },
  { fn: 'extractReceiptData', file: 'receipt-vision.js', kind: 'call', data: { storagePath: 'receipts/u-rep/r1.jpg' } },
  { fn: 'resolveAddress', file: 'handlers/geocode.js', kind: 'call', data: { mode: 'forward', address: '123 Main St, Cincinnati OH' } },
];

// ── Section B3: the whole workflow still runs for everyone but a viewer ──
// Firestore-only handlers, each with the caller's OWN doc seeded (the same
// seed for every caller, keyed by that caller's uid). `done` names the
// terminal write that proves the handler finished; `value` checks its result.
const ownLead = (who) => ({ 'leads/lead-1': { userId: who.uid, companyId: who.token.companyId || who.uid, name: 'Sam Homeowner' } });
const COMPLETE_CASES = [
  { fn: 'createPortalToken', file: 'portal.js', kind: 'call', data: LEAD, seed: ownLead,
    done: 'write:portal_tokens/', value: (v) => !!v && typeof v.token === 'string' && v.token.length > 10 },
  { fn: 'replyToPortalMessage', file: 'portal.js', kind: 'call', data: { leadId: 'lead-1', text: 'On our way' }, seed: ownLead,
    done: 'add:leads/lead-1/portal_messages', value: (v) => !!v && v.success === true && !!v.messageId },
  { fn: 'revokePortalToken', file: 'portal.js', kind: 'call', data: { leadId: 'lead-1', token: 'tokOwn0123456789' },
    seed: (who) => Object.assign(ownLead(who), { 'portal_tokens/tokOwn0123456789': { leadId: 'lead-1', ownerUid: who.uid } }),
    done: 'update:portal_tokens/tokOwn0123456789', value: (v) => !!v && v.success === true && v.revoked === 1 },
  { fn: 'createDealAcceptToken', file: 'deal-acceptance.js', kind: 'call', data: { dealId: 'deal-123456' },
    seed: (who) => ({ 'deal_rooms/deal-123456': { userId: who.uid, companyId: who.token.companyId || who.uid, tiers: { good: { price: 9000 } } } }),
    done: 'write:deal_accept_tokens/', value: (v) => !!v && typeof v.token === 'string' && /deal/.test(String(v.acceptUrl)) },
  { fn: 'createReportShareToken', file: 'report-sharing.js', kind: 'call', data: { reportId: 'report-123456' },
    seed: (who) => ({ 'reports/report-123456': { userId: who.uid, companyId: who.token.companyId || who.uid, html: '<p>Inspection</p>', type: 'inspection report' } }),
    done: 'write:report_share_tokens/', value: (v) => !!v && typeof v.token === 'string' && !!v.shareUrl },
  { fn: 'createCalendarFeedToken', file: 'calendar-feed.js', kind: 'call', data: {},
    done: 'write:calendar_feed_tokens/', value: (v) => !!v && typeof v.token === 'string' },
  { fn: 'trackUsage', file: 'billing.js', kind: 'call', data: { feature: 'leads' },
    done: 'write:subscriptions/', value: (v) => !!v && v.feature === 'leads' && v.usage === 1 },
];

// ── Section C: the sweep. Every exported callable / HTTP function ───────
// refused      — calls the shared guard first (section B proves each one)
// role-gated   — already refuses a viewer through a role allowlist
// already      — refused a viewer before this change, with its own message
// read / read-paid — returns data to the caller and writes nothing the caller
//                supplies (getConnectStatus refreshes the server-derived Stripe
//                mirror); read-paid ones bill a vendor per call (per-uid
//                rate-limited) and each has a read use a viewer is offered
// self         — the caller's own account: sign-in/boot, own tenant, GDPR
// public       — no signed-in caller: homeowner token, webhook, public site
const VERDICTS = {
  // callables
  activateInvitedRep: 'self', analyzePhotoVision: 'refused', assignSeats: 'role-gated',
  attachStormProof: 'refused', backfillAnalytics: 'refused', claimInvite: 'self',
  cleanupE2ETestData: 'role-gated', convertUnmatchedSms: 'role-gated',
  createCalendarFeedToken: 'refused', createCompany: 'self', createConnectAccount: 'role-gated',
  createConnectDashboardLink: 'role-gated', createConnectOnboardingLink: 'role-gated',
  createDealAcceptToken: 'refused', createEsignEnvelope: 'refused', createPortalToken: 'refused',
  createReportShareToken: 'refused', createSignRequest: 'refused', createTeamInvite: 'role-gated',
  createTeamMember: 'role-gated', deactivateUser: 'role-gated', dictate: 'read-paid',
  exportMyData: 'self', extractReceiptData: 'refused', getAdjusterTacticBoard: 'read',
  getAdminAnalytics: 'role-gated', getAiTextingStats: 'read', getAiUsageAnalytics: 'role-gated',
  getConnectStatus: 'read', getDocumentHtml: 'read', getEsignEnvelopeForOwner: 'read',
  getHailHistory: 'read-paid', getSwathReport: 'role-gated', getSwathUsage: 'role-gated',
  integrationAvailability: 'read', integrationStatus: 'role-gated', listTeamMembers: 'role-gated',
  lookupParcel: 'read-paid', markEmailUnsubscribed: 'already', mintOwnerClaims: 'role-gated',
  notifyNewLead: 'public', previewAiPersona: 'refused', provisionE2ETestUser: 'role-gated',
  registerDeviceFingerprint: 'self', removeMember: 'role-gated', renderPdf: 'refused',
  replyToPortalMessage: 'refused', requestAccountErasure: 'self', requestMeasurement: 'refused',
  reserveCompanyPrefix: 'self', resolveAddress: 'refused', reverifyCompanyKnocks: 'role-gated',
  revokeMySessions: 'self', revokePortalToken: 'refused', rotateAccessCodes: 'role-gated',
  runMigrations: 'role-gated', saveEsignFields: 'refused', sendEsignEnvelope: 'refused',
  sendEstimateForSignature: 'refused', sendVerificationCode: 'public', setCompanySeatCount: 'role-gated',
  setSiteSlug: 'role-gated', trackUsage: 'refused', transcribeVoiceMemo: 'refused',
  updateUserRole: 'role-gated', validateAccessCode: 'public', verifyCode: 'public',
  voidEsignEnvelope: 'refused',
  // HTTP functions
  adminAI: 'role-gated', analyzeRoofPhoto: 'refused', calcomWebhook: 'public', claudeProxy: 'read-paid',
  confirmAccountErasure: 'public', createCheckoutSession: 'refused', createCustomerPortalSession: 'refused',
  createStripePaymentLink: 'refused', cspReport: 'public', emailUnsubscribe: 'public', esignWebhook: 'public',
  getCalendarFeed: 'public', getDealRoom: 'public', getEsignEnvelope: 'public', getEstimateForView: 'public',
  getGoogleReviews: 'public', getHomeownerPortalView: 'public', getPortalDocumentHtml: 'public',
  getPortalMessages: 'public', getPublicSiteConfig: 'public', getSharedReport: 'public',
  getSignDocument: 'public', getSubscriptionStatus: 'read', imageProxy: 'public', incomingSMS: 'public',
  invoiceWebhook: 'public', measurementWebhook: 'public', publicFunnelAI: 'public',
  publicRoofMeasure: 'public', publicVisualizerAI: 'public', recordCustomerEvent: 'public',
  reportWarrantyClaim: 'public', requestCallback: 'public', resendWebhook: 'public',
  saveFunnelProgress: 'public', sendD2DSMS: 'refused', sendEmail: 'already', sendPortalMessage: 'public',
  sendQueuedSMS: 'refused', sendSMS: 'refused', setStorageCors: 'role-gated', shareSSR: 'public',
  signImageUrl: 'read', stormReport: 'public', stripeConnectWebhook: 'public', stripeWebhook: 'public',
  submitCustomerRating: 'public', submitDealAcceptance: 'public', submitEsignEnvelope: 'public',
  submitPublicLead: 'public', submitReferral: 'public', submitSignature: 'public', swathWebhook: 'public',
  thumbtackWebhook: 'public', uploadHomeownerPhoto: 'public', visualizerImageGen: 'public',
};
const VERDICT_KINDS = new Set(['refused', 'role-gated', 'already', 'read', 'read-paid', 'self', 'public']);

(async () => {
  // ═══ A. the helper ═════════════════════════════════════════════════════
  console.log('A. functions/shared.js — the one view-only guard');
  {
    const S = load('shared.js');
    ok('exports assertNotViewer / viewOnlyRefusal / isViewOnlyRole / VIEW_ONLY_MESSAGE',
      typeof S.assertNotViewer === 'function' && typeof S.viewOnlyRefusal === 'function'
      && typeof S.isViewOnlyRole === 'function' && S.VIEW_ONLY_MESSAGE === VIEW_ONLY);
    let err = null;
    try { S.assertNotViewer({ role: 'viewer', companyId: 'co-1' }); } catch (e) { err = e; }
    ok("assertNotViewer: role 'viewer' → HttpsError permission-denied 'Your role is view-only'",
      err instanceof HttpsError && err.code === 'permission-denied' && err.message === VIEW_ONLY);
    const passes = [{ role: 'sales_rep' }, { role: 'manager' }, { role: 'company_admin' }, { role: 'admin' },
      { role: 'member' }, {}, { companyId: 'u-solo' }, null, undefined];
    ok('assertNotViewer: every other role, a solo operator (no role claim) and no claims at all pass',
      passes.every((c) => { try { S.assertNotViewer(c); return true; } catch (_) { return false; } }));
    ok("only an exact 'viewer' is refused — the rules' notViewer() expression",
      S.isViewOnlyRole({ role: 'viewer' }) && !S.isViewOnlyRole({ role: 'Viewer' }) && !S.isViewOnlyRole({ role: 'viewer ' })
      && !S.isViewOnlyRole('viewer') && !S.isViewOnlyRole({ roles: ['viewer'] }));
    const r = S.viewOnlyRefusal({ uid: 'u', role: 'viewer' });
    ok('viewOnlyRefusal: viewer → { status: 403, body: { error, code: view-only } }; never throws',
      r && r.status === 403 && r.body.error === VIEW_ONLY && r.body.code === 'view-only');
    ok('viewOnlyRefusal: sales_rep / solo / missing token → null',
      S.viewOnlyRefusal({ role: 'sales_rep' }) === null && S.viewOnlyRefusal({ uid: 'u' }) === null && S.viewOnlyRefusal(null) === null);
  }

  // ═══ B. every refused handler ══════════════════════════════════════════
  console.log('\nB. refused handlers — viewer refused before any side effect; sales_rep and solo get past the guard');
  for (const c of CASES) {
    let rV, rR, rS;
    try {
      rV = await invoke(c, 'viewer');
      rR = await invoke(c, 'salesRep');
      rS = await invoke(c, 'solo');
    } catch (e) {
      ok(c.fn + ': loads and runs under the stubs', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
      continue;
    }
    if (process.env.VIEWER_CALLABLES_VERBOSE) {
      console.log('    viewer:   ' + describe(rV));
      console.log('    salesRep: ' + describe(rR));
      console.log('    solo:     ' + describe(rS));
    }
    ok(c.fn + ': viewer → view-only refusal, zero side effects',
      isViewOnly(c, rV) && rV.effects.length === 0, describe(rV));
    ok(c.fn + ': sales_rep → past the guard (not view-only; handler body ran)',
      !isViewOnly(c, rR) && rR.effects.length > 0, describe(rR));
    ok(c.fn + ': solo operator (no role claim) → past the guard',
      !isViewOnly(c, rS) && rS.effects.length > 0, describe(rS));
  }

  console.log('\nB2. the two conditional guards keep their read-shaped branch open');
  {
    // transcribeVoiceMemo WITHOUT a leadId only returns a transcript
    // (nbd-whisper.js "dictate everywhere") — a viewer gets past the guard.
    const voiceNoLead = { fn: 'transcribeVoiceMemo', file: 'integrations/voice-memo.js', kind: 'call', data: { audioBase64: 'A'.repeat(400), mimeType: 'audio/webm' } };
    const r1 = await invoke(voiceNoLead, 'viewer');
    ok('transcribeVoiceMemo with no leadId: a viewer is NOT refused (transcript only, nothing written)',
      !isViewOnly(voiceNoLead, r1) && r1.effects.length > 0, describe(r1));
    // createCalendarFeedToken revokeOnly turns off the caller's own links.
    const feedRevoke = { fn: 'createCalendarFeedToken', file: 'calendar-feed.js', kind: 'call', data: { revokeOnly: true } };
    const r2 = await invoke(feedRevoke, 'viewer');
    ok('createCalendarFeedToken revokeOnly: a viewer may still turn off their own feed links',
      !isViewOnly(feedRevoke, r2) && !r2.err && r2.value && r2.value.token === null, describe(r2));
  }

  // ═══ B3. the whole workflow, with the caller's own data ════════════════
  console.log('\nB3. with their own lead / deal / report seeded, sales_rep and solo finish the workflow; a viewer who owns it is still refused');
  for (const c of COMPLETE_CASES) {
    let rV, rR, rS;
    try {
      rV = await invoke(c, 'viewer');
      rR = await invoke(c, 'salesRep');
      rS = await invoke(c, 'solo');
    } catch (e) {
      ok(c.fn + ' (seeded): loads and runs under the stubs', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
      continue;
    }
    const finished = (r) => !r.err && !r.timedOut && c.value(r.value) && r.effects.some((e) => e.indexOf(c.done) === 0);
    ok(c.fn + ' (seeded): a viewer who owns it → view-only refusal, zero side effects',
      isViewOnly(c, rV) && rV.effects.length === 0, describe(rV));
    ok(c.fn + ' (seeded): sales_rep → completes (' + c.done + '…)', finished(rR), describe(rR));
    ok(c.fn + ' (seeded): solo operator → completes (' + c.done + '…)', finished(rS), describe(rS));
  }

  // ═══ C. the sweep ══════════════════════════════════════════════════════
  console.log('\nC. every exported callable / HTTP function carries a verdict');
  {
    let exported = null;
    let loadErr = '';
    try {
      const script = [
        "process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-viewer-callables';",
        "process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'demo-viewer-callables', storageBucket: 'demo-viewer-callables.appspot.com' });",
        'const idx = require(' + JSON.stringify(fnPath('index.js')) + ');',
        'const out = {};',
        'for (const [n, f] of Object.entries(idx)) {',
        '  const ep = f && f.__endpoint;',
        "  if (ep && ep.callableTrigger) out[n] = 'callable';",
        "  else if (ep && ep.httpsTrigger) out[n] = 'https';",
        '}',
        "process.stdout.write('\\n@@EXPORTS@@' + JSON.stringify(out) + '\\n');",
        'process.exit(0);',
      ].join('\n');
      const stdout = execFileSync(process.execPath, ['-e', script], {
        cwd: FUNCTIONS, encoding: 'utf8', timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const line = stdout.split('\n').find((l) => l.indexOf('@@EXPORTS@@') === 0);
      exported = line ? JSON.parse(line.slice('@@EXPORTS@@'.length)) : null;
    } catch (e) {
      loadErr = String((e && (e.stderr || e.message)) || e).split('\n').slice(0, 4).join(' | ');
    }
    ok('functions/index.js loads and lists its callable / HTTP exports', !!exported && Object.keys(exported).length > 100, loadErr);
    if (exported) {
      const names = Object.keys(exported).sort();
      const unclassified = names.filter((n) => !Object.prototype.hasOwnProperty.call(VERDICTS, n));
      ok('every exported callable / HTTP function has a verdict (' + names.length + ')',
        unclassified.length === 0, 'unclassified: ' + unclassified.join(', ') + ' — decide whether a viewer may call it');
      const stale = Object.keys(VERDICTS).filter((n) => !Object.prototype.hasOwnProperty.call(exported, n));
      ok('no verdict names a function that is no longer exported', stale.length === 0, 'stale: ' + stale.join(', '));
    }
    const badKind = Object.entries(VERDICTS).filter(([, v]) => !VERDICT_KINDS.has(v)).map(([n]) => n);
    ok('every verdict is one of the documented kinds', badKind.length === 0, badKind.join(', '));
    const refused = Object.keys(VERDICTS).filter((n) => VERDICTS[n] === 'refused').sort();
    const cased = CASES.map((c) => c.fn).sort();
    ok('every refused verdict has a section-B case, and every case is a refused verdict (' + refused.length + ')',
      JSON.stringify(refused) === JSON.stringify(cased),
      'refused-only: ' + refused.filter((n) => !cased.includes(n)).join(',') + ' / case-only: ' + cased.filter((n) => !refused.includes(n)).join(','));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) {
    console.log('FAILURES:\n  - ' + fails.join('\n  - '));
    process.exit(1);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
