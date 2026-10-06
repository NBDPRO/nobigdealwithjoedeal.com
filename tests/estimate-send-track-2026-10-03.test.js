/**
 * tests/estimate-send-track-2026-10-03.test.js
 *
 * Send for review, the follow-up cadence, deal texts from Jo's phone, Fresh
 * link, and the ONE "they opened it" alert (2026-10-03).
 *
 * Context (read-only audit, 2026-10-03): Jo builds estimates OUTSIDE the CRM —
 * 77 estimate PDFs sit in leads/*\/documents (Drive import), carrying only a
 * Firebase download-token URL. No lead had lastSharedAt; 17 leads sat in
 * estimate stages for a median 46 days; Twilio is a trial with 0 texts
 * delivered while the Close Board stamped deals SENT.
 *
 * Everything here is EXECUTED — real handlers driven against stubbed firebase
 * modules and a fake Firestore (the viewer-callables.test.js idiom), real
 * client modules required or vm-loaded. Nothing reaches a network; no SMS or
 * email can be sent (every vendor + push is a spy).
 *
 *   A. Send for review mints the tracked /report/<token> link — never the
 *      row's Storage download-token URL — and stamps nothing yet; the serve
 *      side streams an attached estimate PDF pinned to the token's lead.
 *   B. recordEstimateShared stamps lastSharedAt / sharedDocId and fires the
 *      job spine's estimate_shared (spine stubbed; absent spine is a no-op).
 *   C. Cadence bucketing (estimate-followups.js) + copy with no claim wording.
 *   D. A2P flag routing: deal texts go through Jo's phone, SENT only when he
 *      shared, labelled "shared from your phone"; server reports the flag and
 *      the company link-days setting; phone-share.js outcomes.
 *   E. Fresh link revokes the old link(s) and mints a new one.
 *   F. One estimate_viewed alert per lead per 6h across portal, review link,
 *      deal room and remote signing — each path stamps lead.lastViewedAt.
 *
 * Run: node tests/estimate-send-track-2026-10-03.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const vm = require('vm');
const Module = require('module');
const { Writable, PassThrough } = require('stream');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const fnPath = (rel) => path.join(FUNCTIONS, rel);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const tick = () => new Promise((r) => setImmediate(r));
async function flush(n) { for (let i = 0; i < (n || 20); i++) await tick(); }

// ── World + fake Firestore (equality where() honoured) ───────────────────
let W = null;
function resetWorld(docs) { W = { docs: Object.assign({}, docs || {}), objects: {}, pushes: [], spine: [], seq: 0, now: Date.now() }; }
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const Timestamp = {
  fromMillis: (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms), seconds: Math.floor(ms / 1000), _ts: true }),
  fromDate: (d) => Timestamp.fromMillis(d.getTime()),
  now: () => Timestamp.fromMillis(Date.now()),
};
const FieldValue = {
  serverTimestamp: () => Timestamp.fromMillis(W.now),
  increment: (n) => ({ __inc: n }),
  arrayUnion: (...a) => ({ __union: a }),
  delete: () => ({ __del: true }),
};
function applyPatch(prev, v) {
  const out = Object.assign({}, prev || {});
  Object.keys(v).forEach((k) => {
    const x = v[k];
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
    getMetadata: async () => { const o = W.objects[p]; if (!o) { const e = new Error('No such object'); e.code = 404; throw e; } return [Object.assign({ size: String(o.body.length) }, o.meta)]; },
    download: async () => { const o = W.objects[p]; if (!o) { const e = new Error('No such object'); e.code = 404; throw e; } return [Buffer.from(o.body)]; },
    createReadStream: () => { const s = new PassThrough(); const o = W.objects[p]; setImmediate(() => s.end(Buffer.from(o ? o.body : ''))); return s; },
    getSignedUrl: async () => ['https://storage.example.invalid/signed'],
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
let SPINE_ON = true;
const spineStub = {
  recordJobEvent: async (db, args) => { W.spine.push(args); return { moved: true, from: 'inspected', to: 'estimate_sent_cash', markerId: 'm' }; },
};
const FILE_STUBS = {
  [fnPath('integrations/upstash-ratelimit.js')]: limiter,
  [fnPath('rate-limit.js')]: Object.assign({ rateLimitIpKey: (ip) => ip }, limiter),
  [fnPath('push-functions.js')]: pushStub,
  [fnPath('integrations/sentry.js')]: { withSentry: (n, fn) => fn, captureException: () => {}, ensureInit: () => {}, installRejectionHook: () => {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(PKG_STUBS, request)) return PKG_STUBS[request];
  if (request === './job-spine' && parent && parent.filename && parent.filename.startsWith(FUNCTIONS)) {
    if (SPINE_ON) return spineStub;
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

const ESL = require(fnPath('estimate-send-logic.js'));
const EVA = require(fnPath('estimate-view-alert.js'));
const SEND = require(fnPath('estimate-send.js'));
const DEAL = require(fnPath('deal-acceptance.js'));
const SIGN = require(fnPath('remote-signing.js'));
const SHARE = require(fnPath('report-sharing.js'));
const PORTAL = require(fnPath('portal.js'));
const EF = require(path.join(ROOT, 'docs/pro/js/estimate-followups.js'));
const PS = require(path.join(ROOT, 'docs/pro/js/phone-share.js'));

async function call(handler, data, token) {
  try {
    const value = await handler({ auth: token ? { uid: token.uid, token } : null, data: data || {}, rawRequest: { ip: '203.0.113.9', headers: {} } });
    return { value };
  } catch (err) { return { err }; }
}
function mkRes() {
  const chunks = [];
  const r = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.statusCode = 200; r.headers = {}; r.body = undefined;
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.setHeader = r.set;
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.destroy = () => r;
  r.bytes = () => Buffer.concat(chunks).toString('utf8');
  const realEnd = r.end.bind(r);
  r.end = (...a) => { try { realEnd(...a); } catch (_) { /* ended */ } return r; };
  return r;
}
function mkReq(o) {
  const h = Object.assign({ 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' }, (o && o.headers) || {});
  return Object.assign({ method: 'POST', body: {}, path: '/', headers: h, ip: '203.0.113.9', get: (k) => h[String(k).toLowerCase()] }, o || {});
}

const OWNER = { uid: 'u1' };
const UPLOAD_PATH = 'docs/u1/lead-1_1730000000000_Smith_Estimate.pdf';
const TOKEN_URL = 'https://firebasestorage.googleapis.com/v0/b/demo-bucket/o/' + encodeURIComponent(UPLOAD_PATH) + '?alt=media&token=8f1c2d4e-0000-4000-8000-123456789abc';
function baseWorld(extra) {
  resetWorld(Object.assign({
    'leads/lead-1': { userId: 'u1', companyId: 'u1', firstName: 'Sam', lastName: 'Smith', phone: '5135550100', stage: 'estimate_sent_cash', jobType: 'cash' },
    'leads/lead-1/documents/doc-1': { filename: 'Smith_Estimate.pdf', type: 'application/pdf', source: 'drive_import', url: TOKEN_URL, userId: 'u1', size: 2048 },
  }, extra || {}));
  W.objects[UPLOAD_PATH] = { meta: { contentType: 'application/pdf' }, body: '%PDF-1.7 estimate' };
}

(async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('A. Send for review — tracked link, never the Storage token URL');
  // ══════════════════════════════════════════════════════════════════
  {
    ok('the Drive-import download URL decodes to its object path',
      ESL.storagePathFromRow({ url: TOKEN_URL }) === UPLOAD_PATH);
    const L1 = { userId: 'u1' };
    ok('an upload under the owner + this lead is shareable', ESL.classifyLeadPdfPath(UPLOAD_PATH, 'lead-1', L1).ok);
    ok('another lead’s upload is refused', !ESL.classifyLeadPdfPath('docs/u1/lead-2_1_x.pdf', 'lead-1', L1).ok);
    ok('a lead id that merely PREFIXES another is refused', !ESL.classifyLeadPdfPath('docs/u1/lead-10_1_x.pdf', 'lead-1', L1).ok);
    ok('another owner’s prefix is refused', !ESL.classifyLeadPdfPath('docs/u2/lead-1_1_x.pdf', 'lead-1', L1).ok);
    ok('traversal is refused', !ESL.classifyLeadPdfPath('docs/u1/../u2/lead-1_x.pdf', 'lead-1', L1).ok);
    ok('a non-PDF is refused', ESL.classifyLeadPdfPath('docs/u1/lead-1_1_x.html', 'lead-1', L1).reason === 'not_pdf');
    ok('photos/ is never shareable', !ESL.classifyLeadPdfPath('photos/u1/lead-1/x.pdf', 'lead-1', L1).ok);
    ok('a filed PDF under documents/{uid}/{lead}/ is shareable', ESL.classifyLeadPdfPath('documents/u1/lead-1/NBD-500.pdf', 'lead-1', L1).ok);
  }
  {
    baseWorld();
    const r = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER);
    const v = r.value || {};
    ok('createEstimateReviewLink returns a /report/<token> link', /^https:\/\/nobigdealwithjoedeal\.com\/report\/[A-Z0-9]{24}$/.test(v.shareUrl || ''), r.err && r.err.message);
    ok('…and nothing in the response is a Storage URL or download token',
      !/firebasestorage|alt=media|token=|storage\.googleapis/.test(JSON.stringify(v)), JSON.stringify(v));
    const tok = W.docs['report_share_tokens/' + v.token] || {};
    ok('the token is the existing tracked document link (kind lead_document) for THIS file',
      tok.kind === 'lead_document' && tok.storagePath === UPLOAD_PATH && tok.leadId === 'lead-1' && tok.documentId === 'doc-1' && tok.status === 'active');
    ok('…and the token doc carries no download URL', !Object.values(tok).some((x) => typeof x === 'string' && /token=|firebasestorage/.test(x)));
    ok('minting stamps NOTHING on the lead (Jo may still cancel the share sheet)',
      !W.docs['leads/lead-1'].lastSharedAt && !W.docs['leads/lead-1'].sharedDocId);
    ok('a2pApproved is false by default (no integrations/sms doc)', v.a2pApproved === false);
    const again = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER);
    ok('a second tap reuses the same live link', again.value && again.value.token === v.token && again.value.reused === true);
  }
  {
    baseWorld({ 'leads/lead-1/documents/doc-2': { filename: 'x.pdf', type: 'application/pdf', url: TOKEN_URL.replace('lead-1_', 'lead-2_') } });
    const r = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-2' }, OWNER);
    ok('a row whose URL points at another lead’s file is refused', r.err && r.err.code === 'failed-precondition' && !Object.keys(W.docs).some((k) => k.startsWith('report_share_tokens/')));
  }
  {
    baseWorld();
    W.objects[UPLOAD_PATH].meta.contentType = 'text/html';
    const r = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER);
    ok('an object that is not application/pdf is refused (HTML never served from Storage)', r.err && r.err.code === 'failed-precondition');
  }
  {
    baseWorld();
    const r = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, { uid: 'u9', role: 'sales_rep', companyId: 'other' });
    ok('a rep from another tenant is refused', r.err && r.err.code === 'permission-denied');
    const rv = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, { uid: 'u1', role: 'viewer' });
    ok('a viewer is refused even on their own lead', rv.err && /view-only/i.test(rv.err.message));
  }
  {
    baseWorld({ 'integrations/sms': { a2pApproved: true } });
    const r = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER);
    ok('a2pApproved reflects integrations/sms when it is exactly true', r.value && r.value.a2pApproved === true);
  }
  {
    // Serve side: /report/<token> streams the attached estimate PDF.
    baseWorld();
    const minted = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER);
    const token = minted.value.token;
    const res = mkRes();
    await SHARE.getSharedReport(mkReq({ method: 'GET', path: '/report/' + token }), res);
    await flush();
    ok('getSharedReport streams the attached PDF (200, application/pdf)',
      res.statusCode === 200 && res.headers['Content-Type'] === 'application/pdf' && res.bytes().startsWith('%PDF'), res.statusCode + ' ' + res.body);
    ok('ESL.isServableLeadDocPath pins an upload to the TOKEN’s lead',
      ESL.isServableLeadDocPath(UPLOAD_PATH, 'lead-1') && !ESL.isServableLeadDocPath(UPLOAD_PATH, 'lead-2'));
    W.docs['report_share_tokens/' + token].leadId = 'lead-2';
    const res2 = mkRes();
    await SHARE.getSharedReport(mkReq({ method: 'GET', path: '/report/' + token }), res2);
    ok('…a token whose lead does not match the path gets a 404, not the file', res2.statusCode === 404);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nB. recordEstimateShared — lastSharedAt + the spine event');
  // ══════════════════════════════════════════════════════════════════
  {
    baseWorld();
    const minted = (await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER)).value;
    SPINE_ON = true;
    const r = await call(SEND.recordEstimateShared, { leadId: 'lead-1', documentId: 'doc-1', token: minted.token, via: 'phone_share' }, OWNER);
    const lead = W.docs['leads/lead-1'];
    ok('records the share', r.value && r.value.ok === true, r.err && r.err.message);
    ok('stamps lastSharedAt + lastSharedVia on the lead', lead.lastSharedAt && lead.lastSharedAt._ts && lead.lastSharedVia === 'phone_share');
    ok('stamps sharedDocId + the link it sent', lead.sharedDocId === 'doc-1' && lead.sharedLinkUrl === minted.shareUrl && lead.sharedDocName === 'Smith_Estimate.pdf');
    const ev = W.spine[0] || {};
    ok('fires the job spine’s estimate_shared for this lead', W.spine.length === 1 && ev.event === 'estimate_shared' && ev.leadId === 'lead-1' && ev.sourceId === 'review_' + minted.token);
    ok('…and reports the move', r.value && r.value.spine && r.value.spine.to === 'estimate_sent_cash');
  }
  {
    baseWorld();
    const minted = (await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER)).value;
    SPINE_ON = false;
    // The spine (PR #2123) may not be deployed: a missing module is a no-op.
    const r = await call(SEND.recordEstimateShared, { leadId: 'lead-1', documentId: 'doc-1', token: minted.token }, OWNER);
    ok('without the spine module the share still records (spine: null)', r.value && r.value.ok && r.value.spine === null && W.docs['leads/lead-1'].sharedDocId === 'doc-1', r.err && r.err.message);
    SPINE_ON = true;
  }
  {
    baseWorld({ 'report_share_tokens/ABCDEFGHJKLMNPQRSTUV2345': { leadId: 'lead-9', documentId: 'doc-1', status: 'active' } });
    const r = await call(SEND.recordEstimateShared, { leadId: 'lead-1', documentId: 'doc-1', token: 'ABCDEFGHJKLMNPQRSTUV2345' }, OWNER);
    ok('a token from another lead cannot be recorded as this lead’s share', r.err && r.err.code === 'failed-precondition' && !W.docs['leads/lead-1'].lastSharedAt && W.spine.length === 0);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nC. Cadence bucketing (estimate-followups.js)');
  // ══════════════════════════════════════════════════════════════════
  {
    const D = 86400000, H = 3600000;
    const NOW = Date.parse('2026-10-03T16:00:00Z');
    ok('bucketFor: <2 none, 2–4 d2, 5–9 d5, 10+ d10',
      EF.bucketFor(1) === null && EF.bucketFor(2) === 'd2' && EF.bucketFor(4) === 'd2' && EF.bucketFor(5) === 'd5' && EF.bucketFor(9) === 'd5' && EF.bucketFor(10) === 'd10' && EF.bucketFor(46) === 'd10');
    const lead = (id, o) => Object.assign({ id, firstName: 'Pat', lastName: id, phone: '5135550100', stage: 'estimate_sent_cash' }, o);
    const leads = [
      lead('one-day', { lastSharedAt: NOW - 1 * D }),
      lead('three-unopened', { lastSharedAt: NOW - 3 * D }),
      lead('three-opened', { lastSharedAt: NOW - 3 * D, lastViewedAt: NOW - 5 * H }),
      lead('six-unopened', { lastSharedAt: NOW - 6 * D }),
      lead('stage-only-46', { stage: 'estimate_submitted', stageStartedAt: NOW - 46 * D }),
      lead('stale-open', { lastSharedAt: NOW - 12 * D, lastPortalOpenAt: NOW - 20 * D }),
      lead('won', { stage: 'contract_signed', lastSharedAt: NOW - 6 * D }),
      lead('lost', { stage: 'lost', lastSharedAt: NOW - 6 * D }),
      lead('deleted', { deleted: true, lastSharedAt: NOW - 6 * D }),
      lead('snoozed', { lastSharedAt: NOW - 6 * D, snoozedUntil: NOW + D }),
      lead('future-followup', { lastSharedAt: NOW - 6 * D, followUp: '2026-10-09' }),
      lead('nudged-this-step', { lastSharedAt: NOW - 6 * D, lastEstimateNudgeAt: NOW - 1 * D }),
      lead('nudged-last-step', { lastSharedAt: NOW - 6 * D, lastEstimateNudgeAt: NOW - 3 * D }),
      lead('ten-nudged-8d', { lastSharedAt: NOW - 20 * D, lastEstimateNudgeAt: NOW - 8 * D }),
      lead('ten-nudged-2d', { lastSharedAt: NOW - 20 * D, lastEstimateNudgeAt: NOW - 2 * D }),
      lead('shared-not-moved', { stage: 'inspected', sharedDocId: 'd', lastSharedAt: NOW - 5 * D }),
    ];
    const res = EF.computeFollowups(leads, NOW, { from: 'Joe with No Big Deal' });
    const by = {}; res.rows.forEach((r) => { by[r.leadId] = r; });
    const ids = Object.keys(by).sort().join(',');
    ok('the right leads are due', ids === ['nudged-last-step', 'shared-not-moved', 'six-unopened', 'stage-only-46', 'stale-open', 'ten-nudged-8d', 'three-opened', 'three-unopened'].sort().join(','), ids);
    ok('under 2 days, won, lost, deleted, snoozed and a future follow-up date are not listed',
      !by['one-day'] && !by.won && !by.lost && !by.deleted && !by.snoozed && !by['future-followup']);
    ok('a nudge already sent at this step holds the lead until the next step', !by['nudged-this-step'] && !!by['nudged-last-step']);
    ok('10+ days comes back weekly', !!by['ten-nudged-8d'] && !by['ten-nudged-2d']);
    ok('buckets', by['three-unopened'].bucket === 'd2' && by['six-unopened'].bucket === 'd5' && by['stage-only-46'].bucket === 'd10' && by['stage-only-46'].daysOut === 46);
    ok('opened vs not opened; an open BEFORE the send does not count',
      by['three-opened'].opened && !by['three-unopened'].opened && !by['stale-open'].opened);
    ok('counts split opened / not opened per bucket',
      res.counts.d2.opened === 1 && res.counts.d2.notOpened === 1 && res.counts.d5.notOpened === 3 && res.counts.d10.notOpened === 3, JSON.stringify(res.counts));
    ok('"Opened Xh ago" on the row', by['three-opened'].openedLabel === 'Opened 5h ago' && by['three-unopened'].openedLabel === 'Not opened yet');
    ok('oldest bucket first, not-opened first inside it', res.rows[0].bucket === 'd10' && res.rows[res.rows.length - 1].bucket === 'd2' && res.rows[res.rows.length - 1].opened === true);
    ok('every row carries a pre-written follow-up naming the customer', res.rows.every((r) => /^Hi Pat, it’s Joe with No Big Deal\./.test(r.message)));
    const live = EF.computeFollowups([lead('x', { lastSharedAt: NOW - 3 * D, sharedLinkUrl: 'https://nobigdealwithjoedeal.com/report/ABC', sharedLinkExpiresAt: NOW + 20 * D })], NOW).rows[0];
    const dead = EF.computeFollowups([lead('x', { lastSharedAt: NOW - 3 * D, sharedLinkUrl: 'https://nobigdealwithjoedeal.com/report/ABC', sharedLinkExpiresAt: NOW - D })], NOW).rows[0];
    ok('a live link rides in the follow-up; an expired one is left out (Fresh link instead)',
      /report\/ABC/.test(live.message) && live.linkLive && !/report\/ABC/.test(dead.message) && !dead.linkLive);
    const all = ['d2', 'd5', 'd10'].flatMap((b) => [true, false].map((o) => EF.followupMessage({ firstName: 'Sam', from: 'Joe', url: 'https://x/report/T', bucket: b, opened: o })))
      .concat([EF.reviewMessage({ firstName: 'Sam', from: 'Joe', url: 'https://x/report/T' })]);
    ok('no message mentions a claim, insurance, an adjuster or negotiating', all.every((m) => !/claim|insur|adjuster|negotiat|deductible/i.test(m)), all.find((m) => /claim|insur|adjuster|negotiat|deductible/i.test(m)));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nD. A2P flag routing — the deal text goes from Jo’s phone');
  // ══════════════════════════════════════════════════════════════════
  {
    // phone-share.js outcomes
    const mk = (nav, confirmAns) => {
      const opened = [];
      // phoneTextAction stub: the server's 'ok to text?' answers yes (review R2-3-2;
      // the refusals are driven in tests/texting-r2-fixes-2026-10-06.test.js).
      const win = { navigator: nav, location: { assign: (h) => opened.push(h) }, nbdConfirm: async () => confirmAns,
        _functions: {}, _httpsCallable: () => async () => ({ data: { ok: true, to: '+15135550100' } }) };
      const sb = { window: win, module: { exports: {} }, console };
      vm.createContext(sb);
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/phone-share.js'), 'utf8').replace("typeof window !== 'undefined' ? window : null", 'window'), sb);
      return { api: sb.module.exports, opened };
    };
    const okShare = mk({ share: async () => {} });
    ok('share sheet resolved → shared via share', (await okShare.api.share({ text: 'Hi', url: 'https://x' })).shared === true);
    const abort = mk({ share: async () => { const e = new Error('x'); e.name = 'AbortError'; throw e; } });
    const ra = await abort.api.share({ text: 'Hi', phone: '5135550100', leadId: 'lead-1' });
    ok('share sheet cancelled → NOT shared, nothing opened', ra.shared === false && ra.cancelled && abort.opened.length === 0);
    const na = mk({ share: async () => { const e = new Error('x'); e.name = 'NotAllowedError'; throw e; } });
    ok('Safari refused (no user activation left) → needsTap, nothing opened', (await na.api.share({ text: 'Hi', phone: '5135550100', leadId: 'lead-1' })).needsTap === true && na.opened.length === 0);
    const smsNo = mk({}, false);
    const rn = await smsNo.api.share({ text: 'Hi', url: 'https://x/deal/T', phone: '(513) 555-0100', leadId: 'lead-1' });
    ok('no share sheet → Messages opens with the text written', smsNo.opened[0] === 'sms:5135550100?&body=' + encodeURIComponent('Hi\n\nhttps://x/deal/T'), smsNo.opened[0]);
    ok('…but it is NOT "shared" unless Jo says it went out', rn.shared === false);
    const smsYes = mk({}, true);
    ok('…and is shared (via sms) when he confirms', (await smsYes.api.share({ text: 'Hi', phone: '5135550100', leadId: 'lead-1' })).via === 'sms');
    ok('withLink puts the URL on its own line once', PS.withLink('Hi', 'https://u') === 'Hi\n\nhttps://u' && PS.withLink('Hi https://u', 'https://u') === 'Hi https://u');
  }
  {
    // Server: createDealAcceptToken reports the flag + uses the company link days.
    resetWorld({ 'deal_rooms/deal-123456': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', tiers: { good: { price: 9000 } }, status: 'draft' } });
    const r1 = await call(DEAL.createDealAcceptToken, { dealId: 'deal-123456' }, OWNER);
    ok('createDealAcceptToken: a2pApproved false by default, 14-day link', r1.value && r1.value.a2pApproved === false && r1.value.ttlDays === 14, r1.err && r1.err.message);
    W.docs['integrations/sms'] = { a2pApproved: true };
    W.docs['companyProfile/u1'] = { salesLinks: { dealLinkDays: 45 } };
    const r2 = await call(DEAL.createDealAcceptToken, { dealId: 'deal-123456' }, OWNER);
    const exp = W.docs['deal_accept_tokens/' + r2.value.token].expiresAt.toMillis();
    ok('…a2pApproved true from integrations/sms; link life from companyProfile.salesLinks.dealLinkDays',
      r2.value.a2pApproved === true && r2.value.ttlDays === 45 && Math.abs(exp - (Date.now() + 45 * 86400000)) < 60000);
    ok('dealLinkDays clamps 1..90 and defaults to 14',
      ESL.dealLinkDays({ salesLinks: { dealLinkDays: 500 } }) === 90 && ESL.dealLinkDays({ salesLinks: { dealLinkDays: 'x' } }) === 14 && ESL.dealLinkDays(null) === 14);
    ok('smsA2pApproved is strict', ESL.smsA2pApproved({ a2pApproved: true }) && !ESL.smsA2pApproved({ a2pApproved: 'true' }) && !ESL.smsA2pApproved(null));
  }
  {
    // Client: close-board.js vm-loaded whole; Text with A2P off / on.
    const CB_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/close-board.js'), 'utf8').replace(/\bimport\(/g, '__testImport(');
    async function board(a2p, shareResult) {
      const store = new Map();
      const els = {};
      const makeEl = () => ({ _html: '', get innerHTML() { return this._html; }, set innerHTML(v) { this._html = String(v); }, get textContent() { return this._html; }, set textContent(v) { this._html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }, style: {}, dataset: {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, classList: { add() {}, remove() {}, contains() { return false; } } });
      const smsCalls = [], shareCalls = [];
      const sb = {
        console: { log() {}, info() {}, warn() {}, error() {} }, JSON, Math, Date, Number, String, Array, Object, RegExp, Boolean, Error, Promise, Set, Map, isNaN, parseFloat, parseInt, encodeURIComponent, Intl,
        setTimeout: () => 0, clearTimeout: () => {},
        localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), key: () => null, get length() { return store.size; } },
        document: { getElementById: (id) => (els[id] = els[id] || makeEl()), createElement: makeEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {} },
        navigator: {},
        __testImport: async (spec) => {
          if (/firebase-firestore/.test(spec)) return { doc: () => ({}), setDoc: async () => {}, updateDoc: async () => {}, deleteDoc: async () => {}, collection: () => ({}), where: () => ({}), query: () => ({}), getDocs: async () => ({ empty: true, forEach() {}, docs: [] }) };
          throw new Error('unexpected import ' + spec);
        },
      };
      sb.window = sb; sb.addEventListener = () => {}; sb.showToast = () => {}; sb.open = () => null;
      sb._db = {}; sb._user = { uid: 'u1', email: 'jo@example.test', displayName: 'Joe Deal' }; sb._userClaims = { companyId: 'u1' };
      sb._functions = {};
      sb._httpsCallable = (fns, name) => async () => ({ data: { acceptUrl: 'https://nobigdealwithjoedeal.com/deal/TOKENTOKENTOKEN', a2pApproved: a2p } });
      sb.NBDComms = { sendSMS: async (o) => { smsCalls.push(o); return { success: true, mode: 'sent' }; } };
      sb.NBDPhoneShare = { share: async (o) => { shareCalls.push(o); return shareResult; } };
      vm.runInContext(CB_SRC, vm.createContext(sb), { filename: 'close-board.js' });
      const CB = sb.CloseBoard;
      CB.init();
      const d = CB.createFromEstimate ? null : null; // keep the public surface honest
      const deals = CB.getDeals();
      deals.length = 0;
      // Seed one draft deal through the public updateDeal path's storage.
      const seed = { id: 'dr_1', status: 'draft', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', customerName: 'Sam Smith', customerPhone: '5135550100', customerEmail: '', address: '1 Main St, Milford, OH 45150', leadId: 'lead-1', tiers: { good: { label: 'Good', price: 9000, lineItems: [], description: 'd' } }, selectedProducts: [], warranty: 'w', insuranceClaim: false, repName: 'Joe', repPhone: '', repEmail: '', notes: '', viewCount: 0, userId: 'u1' };
      store.set('nbd_deal_rooms:u1', JSON.stringify([seed]));
      CB.init();
      await CB.sendSMS('dr_1');
      await flush();
      const after = CB.getDeals().find((x) => x.id === 'dr_1') || {};
      CB.render();
      return { smsCalls, shareCalls, after, html: (els['view-closeboard'] || {}).innerHTML || '' };
    }
    const off = await board(false, { shared: false, via: null, cancelled: true });
    ok('A2P off: the server SMS path is never called', off.smsCalls.length === 0);
    ok('…the share sheet gets the deal link', off.shareCalls.length === 1 && /deal\/TOKENTOKENTOKEN/.test(off.shareCalls[0].text) && off.shareCalls[0].phone === '5135550100');
    ok('…cancelled → the deal is NOT marked sent', off.after.status === 'draft' && !off.after.sentAt, JSON.stringify({ s: off.after.status, at: off.after.sentAt }));
    const sent = await board(false, { shared: true, via: 'share' });
    ok('A2P off + Jo shared → sent, sentVia phone', sent.after.status === 'sent' && sent.after.sentVia === 'phone' && !!sent.after.sentAt && sent.smsCalls.length === 0);
    ok('…labelled "shared from your phone"', /shared from your phone/.test(sent.html) && !/via phone/.test(sent.html));
    const on = await board(true, { shared: true, via: 'share' });
    ok('A2P approved: the platform send is back (NBDComms.sendSMS), no share sheet', on.smsCalls.length === 1 && on.shareCalls.length === 0 && on.after.sentVia === 'sms');
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nE. Fresh link — new token, old one revoked');
  // ══════════════════════════════════════════════════════════════════
  {
    const future = Timestamp.fromMillis(Date.now() + 5 * 86400000);
    resetWorld({
      'leads/lead-1': { userId: 'u1', companyId: 'u1', firstName: 'Sam', stage: 'estimate_sent_cash' },
      'companyProfile/u1': { salesLinks: { dealLinkDays: 30 } },
      'deal_rooms/deal-123456': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', status: 'expired', tiers: { good: { price: 9000 }, best: { price: 15000 } }, customerName: 'Sam Smith', updatedAt: '2026-09-01T00:00:00Z' },
      'deal_rooms/deal-old999': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', status: 'accepted', updatedAt: '2026-09-20T00:00:00Z' },
      'deal_accept_tokens/OLDPENDINGA111111111111A': { dealId: 'deal-123456', status: 'pending', expiresAt: future },
      'deal_accept_tokens/OLDPENDINGB111111111111B': { dealId: 'deal-123456', status: 'pending', expiresAt: Timestamp.fromMillis(Date.now() - 86400000) },
      'deal_accept_tokens/ACCEPTEDC1111111111111C': { dealId: 'deal-123456', status: 'accepted', expiresAt: future },
    });
    const r = await call(SEND.freshEstimateLink, { leadId: 'lead-1' }, OWNER);
    const v = r.value || {};
    ok('freshEstimateLink re-mints the open deal’s accept link', v.kind === 'deal' && /\/deal\/[A-Z0-9]{24}$/.test(v.url || '') && v.dealId === 'deal-123456', r.err && r.err.message);
    const a = W.docs['deal_accept_tokens/OLDPENDINGA111111111111A'];
    ok('the old live link is revoked (expiry in the past + revokedAt/revokedBy)', a.expiresAt.toMillis() < Date.now() && a.revokedAt && a.revokedBy === 'u1');
    ok('an accepted token is left alone', !W.docs['deal_accept_tokens/ACCEPTEDC1111111111111C'].revokedAt);
    const tok = W.docs['deal_accept_tokens/' + v.url.split('/').pop()];
    ok('the new token is pending, for this deal, priced from the deal, and lives the company’s 30 days',
      tok && tok.status === 'pending' && tok.dealId === 'deal-123456' && tok.tierPrices.best === 15000 && Math.abs(tok.expiresAt.toMillis() - (Date.now() + 30 * 86400000)) < 60000);
    const room = W.docs['deal_rooms/deal-123456'];
    ok('the deal room is live again on the Close Board (new expiresAt, expired → sent)', room.status === 'sent' && Date.parse(room.expiresAt) > Date.now() + 29 * 86400000);
    // The old link now answers "expired".
    const res = mkRes();
    await DEAL.getDealRoom(mkReq({ method: 'GET', path: '/deal/OLDPENDINGA111111111111A' }), res);
    ok('opening the revoked link says it expired (410)', res.statusCode === 410 && /expired/i.test(String(res.body)));
  }
  {
    baseWorld();
    const minted = (await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER)).value;
    await call(SEND.recordEstimateShared, { leadId: 'lead-1', documentId: 'doc-1', token: minted.token }, OWNER);
    const r = await call(SEND.freshEstimateLink, { leadId: 'lead-1' }, OWNER);
    const v = r.value || {};
    ok('no deal room → the shared PDF’s review link is re-minted', v.kind === 'review' && v.token && v.token !== minted.token && v.documentId === 'doc-1', r.err && r.err.message);
    const old = W.docs['report_share_tokens/' + minted.token];
    ok('…the old review link is revoked (status revoked, expiry past)', old.status === 'revoked' && old.expiresAt.toMillis() < Date.now() && old.revokedBy === 'u1');
    ok('…the lead points at the new link', W.docs['leads/lead-1'].sharedLinkUrl === v.url);
    const res = mkRes();
    await SHARE.getSharedReport(mkReq({ method: 'GET', path: '/report/' + minted.token }), res);
    ok('…and the old link no longer serves the PDF (410)', res.statusCode === 410);
    resetWorld({ 'leads/lead-1': { userId: 'u1', companyId: 'u1' } });
    const none = await call(SEND.freshEstimateLink, { leadId: 'lead-1' }, OWNER);
    ok('nothing sent yet → a plain failed-precondition, no token minted', none.err && none.err.code === 'failed-precondition' && !Object.keys(W.docs).some((k) => /tokens\//.test(k)));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nF. One estimate_viewed alert per lead per 6h, from every open path');
  // ══════════════════════════════════════════════════════════════════
  {
    // The handlers read the real clock; drive it from the world so 6h can pass.
    const realNow = Date.now;
    Date.now = () => W.now;
    const notes = () => Object.keys(W.docs).filter((k) => k.startsWith('notifications/')).map((k) => W.docs[k]);
    resetWorld({
      'leads/lead-1': { userId: 'u1', companyId: 'u1', firstName: 'Sam', lastName: 'Smith', stage: 'estimate_sent_cash', lastSharedAt: Timestamp.fromMillis(Date.now() - 3 * 86400000), sharedDocId: 'doc-1' },
      'portal_tokens/PORTALTOKEN1234567890AB': { leadId: 'lead-1', ownerUid: 'u1', companyId: 'u1', expiresAt: Timestamp.fromMillis(Date.now() + 86400000), uses: 0, maxUses: 100 },
      'users/u1': { name: 'Joe' },
      'doc_sign_tokens/SIGNTOKEN1234567890ABCD': { leadId: 'lead-1', ownerUid: 'u1', docId: 'doc-9', status: 'pending', htmlPath: 'documents/u1/lead-1/c.html', docTypeName: 'Roofing Contract', signerName: 'Sam Smith', expiresAt: Timestamp.fromMillis(Date.now() + 86400000) },
      'deal_accept_tokens/DEALTOKEN1234567890ABCD': { dealId: 'deal-123456', leadId: 'lead-1', ownerUid: 'u1', status: 'pending', htmlPath: 'deal_rooms/u1/deal-123456.html', expiresAt: Timestamp.fromMillis(Date.now() + 86400000) },
      'deal_rooms/deal-123456': { userId: 'u1', leadId: 'lead-1', status: 'sent', customerName: 'Sam Smith', viewCount: 0 },
    });
    W.objects['documents/u1/lead-1/c.html'] = { meta: { contentType: 'text/html' }, body: '<p>contract</p>' };
    W.objects['deal_rooms/u1/deal-123456.html'] = { meta: { contentType: 'text/html' }, body: '<html><head></head><body>deal</body></html>' };

    // 1. Portal open
    const pr = mkRes();
    await PORTAL.getHomeownerPortalView(mkReq({ body: { token: 'PORTALTOKEN1234567890AB' } }), pr);
    await flush();
    ok('portal open answered 200', pr.statusCode === 200, pr.statusCode + ' ' + JSON.stringify(pr.body).slice(0, 120));
    let lead = W.docs['leads/lead-1'];
    ok('portal open stamps lead.lastViewedAt (via portal)', lead.lastViewedAt && lead.lastViewedVia === 'portal');
    ok('…and sends ONE estimate_viewed alert + push to Jo', notes().length === 1 && notes()[0].type === 'estimate_viewed' && notes()[0].userId === 'u1' && W.pushes.length === 1);

    // 2. Remote-signing open, minutes later
    W.now += 5 * 60000;
    const sr = mkRes();
    await SIGN.getSignDocument(mkReq({ body: { token: 'SIGNTOKEN1234567890ABCD' } }), sr);
    await flush();
    lead = W.docs['leads/lead-1'];
    ok('remote-signing open (was silent) stamps lastViewedAt (via remote_sign)', sr.statusCode === 200 && lead.lastViewedVia === 'remote_sign');
    ok('…but inside 6h it does NOT alert again', notes().length === 1 && W.pushes.length === 1);

    // 3. Deal room open
    W.now += 5 * 60000;
    const dr = mkRes();
    await DEAL.getDealRoom(mkReq({ method: 'GET', path: '/deal/DEALTOKEN1234567890ABCD' }), dr);
    await flush();
    lead = W.docs['leads/lead-1'];
    ok('deal-room open stamps lastViewedAt (via deal_room)', dr.statusCode === 200 && lead.lastViewedVia === 'deal_room');
    ok('…and does not double-alert inside 6h (the deal room no longer pushes on its own)', notes().length === 1 && W.pushes.length === 1, notes().length + ' notes, ' + W.pushes.length + ' pushes');

    // 4. A link preview of the review link is not an open.
    W.docs['report_share_tokens/REVIEWTOKEN1234567890AB'] = { kind: 'lead_document', leadId: 'lead-1', ownerUid: 'u1', status: 'active', storagePath: UPLOAD_PATH, filename: 'Smith_Estimate.pdf', expiresAt: Timestamp.fromMillis(Date.now() + 86400000) };
    W.objects[UPLOAD_PATH] = { meta: { contentType: 'application/pdf' }, body: '%PDF' };
    const before = lead.lastViewedAt.toMillis();
    W.now += 7 * 3600000; // past the 6h window
    await SHARE.getSharedReport(mkReq({ method: 'GET', path: '/report/REVIEWTOKEN1234567890AB', headers: { 'user-agent': 'facebookexternalhit/1.1 Facebot Twitterbot/1.0' } }), mkRes());
    await flush();
    ok('a link-preview bot fetching the review link stamps nothing and alerts no one',
      W.docs['leads/lead-1'].lastViewedAt.toMillis() === before && notes().length === 1);
    // 5. …the homeowner opening it 7h later alerts again.
    await SHARE.getSharedReport(mkReq({ method: 'GET', path: '/report/REVIEWTOKEN1234567890AB' }), mkRes());
    await flush();
    lead = W.docs['leads/lead-1'];
    ok('the homeowner opening the PDF 7h later stamps (via review_link) and alerts again', lead.lastViewedVia === 'review_link' && notes().length === 2 && W.pushes.length === 2);
    ok('…naming the estimate', notes().length > 1 && /Smith_Estimate\.pdf/.test(notes()[1].message));
    Date.now = realNow;
  }
  {
    // Pure throttle rule.
    const now = Date.parse('2026-10-03T20:00:00Z');
    ok('shouldAlert: first view yes, 1h later no, 6h later yes',
      EVA.shouldAlert({}, now) && !EVA.shouldAlert({ lastViewAlertAt: Timestamp.fromMillis(now - 3600e3) }, now) && EVA.shouldAlert({ lastViewAlertAt: Timestamp.fromMillis(now - 6 * 3600e3) }, now));
    resetWorld({ 'leads/lead-1': { userId: 'u1', firstName: 'Sam' } });
    const r = await EVA.recordEstimateView(DB, { leadId: 'lead-1', ownerUid: 'someone-else', source: 'portal' });
    ok('a token naming another owner neither stamps nor alerts', r.stamped === false && !W.docs['leads/lead-1'].lastViewedAt && W.pushes.length === 0);
    const r2 = await EVA.recordEstimateView(DB, { leadId: 'lead-1', ownerUid: 'u1', source: 'portal', alert: false });
    ok('a portal open with nothing sent stamps lastViewedAt but does not alert', r2.stamped && !r2.alerted && W.pushes.length === 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
