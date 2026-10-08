/**
 * Tenant ownership checks (2026-10-05, approved by Jo).
 *
 * A public link can write to — or email — only the record owner's own lead:
 *   A. createDealAcceptToken refuses a deal whose (client-written, rules-
 *      unbound) leadId is another tenant's lead; drops a lead that is gone.
 *   B. stampLeadCancelBy (deal accept / e-sign / remote sign) stamps only the
 *      owner's (or same company's) lead.
 *   C. spineAfterDealAccept passes ownerUid + companyId so the job-spine
 *      tenant check runs (it never did for deal accepts).
 *   D. createReportShareToken uses reports.leadId only when that lead is the
 *      report owner's / company's — never emails another company's homeowner.
 * The rules half (deal_rooms.leadId bound on CREATE + UPDATE) is §53 of
 * tests/firestore-rules.test.js.
 *
 * Harness copied from tests/estimate-send-track-2026-10-03.test.js (fake
 * Firestore + module stubs), with a Resend stub that records sends.
 *
 * Run: node tests/tenant-ownership-checks-2026-10-05.test.js
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
function resetWorld(docs) { W = { docs: Object.assign({}, docs || {}), objects: {}, pushes: [], spine: [], sent: [], seq: 0, now: Date.now() }; }
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
  stripe: vendorSpy('stripe'), twilio: vendorSpy('twilio'), resend: { Resend: function () { return { emails: { send: async (m) => { W.sent.push(m); return { data: { id: 'em1' }, error: null }; } } }; } },
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

const DEAL = require(fnPath('deal-acceptance.js'));
const SHARE = require(fnPath('report-sharing.js'));

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
const CW = require(fnPath('cancel-window.js'));
const SPINE_REAL = require(fnPath('job-spine.js'));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
function body(src, name) {
  const at = src.indexOf(name);
  return at < 0 ? '' : src.slice(at, at + 12000);
}

(async () => {
  // ══════════════════════════════════════════════════════════════════
  console.log('\nA. createDealAcceptToken — the deal\'s lead must be the deal owner\'s');
  // ══════════════════════════════════════════════════════════════════
  const DEAL_ID = 'deal-123456';
  const mkDeal = (extra) => Object.assign({ userId: 'u1', companyId: 'u1', tiers: { good: { price: 9000 } }, status: 'draft' }, extra);
  const tokens = () => Object.keys(W.docs).filter((k) => k.startsWith('deal_accept_tokens/')).map((k) => W.docs[k]);
  {
    resetWorld({
      ['deal_rooms/' + DEAL_ID]: mkDeal({ leadId: 'lead-victim' }),
      'leads/lead-victim': { userId: 'victim', companyId: 'co-victim', email: 'victim@example.com' },
    });
    const r = await call(DEAL.createDealAcceptToken, { dealId: DEAL_ID }, OWNER);
    ok('another tenant\'s lead → permission-denied', r.err && r.err.code === 'permission-denied', r.err ? r.err.code : 'minted');
    ok('…and no accept token is minted', tokens().length === 0);
  }
  {
    resetWorld({
      ['deal_rooms/' + DEAL_ID]: mkDeal({ companyId: 'co-victim', leadId: 'lead-victim' }),
      'leads/lead-victim': { userId: 'victim', companyId: 'co-victim' },
    });
    const r = await call(DEAL.createDealAcceptToken, { dealId: DEAL_ID }, { uid: 'u1', companyId: 'co-u1' });
    ok('a spoofed deal.companyId (client-written) does not pass the company check', r.err && r.err.code === 'permission-denied');
  }
  {
    resetWorld({
      ['deal_rooms/' + DEAL_ID]: mkDeal({ leadId: 'lead-legacy' }),
      'leads/lead-legacy': { userId: 'victim' },
    });
    const r = await call(DEAL.createDealAcceptToken, { dealId: DEAL_ID }, OWNER);
    ok('another owner\'s legacy lead (no companyId) → refused', r.err && r.err.code === 'permission-denied');
  }
  {
    resetWorld({
      ['deal_rooms/' + DEAL_ID]: mkDeal({ leadId: 'lead-1' }),
      'leads/lead-1': { userId: 'u1', companyId: 'u1' },
    });
    const r = await call(DEAL.createDealAcceptToken, { dealId: DEAL_ID }, OWNER);
    const t = tokens()[0] || {};
    ok('own lead → minted, token carries the lead', r.value && t.leadId === 'lead-1' && t.ownerUid === 'u1', r.err && r.err.message);
    ok('…token companyId = the owner\'s tenant (solo: uid)', t.companyId === 'u1');
  }
  {
    resetWorld({
      ['deal_rooms/' + DEAL_ID]: mkDeal({ companyId: undefined, leadId: 'lead-mate' }),
      'leads/lead-mate': { userId: 'mate', companyId: 'co-1' },
    });
    const r = await call(DEAL.createDealAcceptToken, { dealId: DEAL_ID }, { uid: 'u1', companyId: 'co-1' });
    const t = tokens()[0] || {};
    ok('a teammate\'s lead in the same company (claim) → minted', r.value && t.leadId === 'lead-mate' && t.companyId === 'co-1', r.err && r.err.message);
  }
  {
    resetWorld({ ['deal_rooms/' + DEAL_ID]: mkDeal({ leadId: 'lead-gone' }) });
    const r = await call(DEAL.createDealAcceptToken, { dealId: DEAL_ID }, OWNER);
    const t = tokens()[0] || {};
    ok('a lead that no longer exists → minted with leadId null (never carried)', r.value && t.leadId === null, r.err && r.err.message);
  }
  {
    resetWorld({ ['deal_rooms/' + DEAL_ID]: mkDeal({ leadId: 'a/b' }) });
    const r = await call(DEAL.createDealAcceptToken, { dealId: DEAL_ID }, OWNER);
    ok('a leadId with a slash → refused (doc-path injection)', r.err && r.err.code === 'failed-precondition' && tokens().length === 0);
  }
  {
    resetWorld({ ['deal_rooms/' + DEAL_ID]: mkDeal({}) });
    const r = await call(DEAL.createDealAcceptToken, { dealId: DEAL_ID }, OWNER);
    ok('a deal with no lead → minted as before', r.value && tokens()[0].leadId === null);
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nB. stampLeadCancelBy — only the signed record\'s owner\'s lead');
  // ══════════════════════════════════════════════════════════════════
  {
    resetWorld({ 'leads/L-v': { userId: 'victim', companyId: 'co-v' }, 'leads/L-own': { userId: 'u1', companyId: 'u1' }, 'leads/L-mate': { userId: 'mate', companyId: 'co-1' } });
    ok('another tenant\'s lead → not stamped', (await CW.stampLeadCancelBy(DB, 'L-v', '2026-10-09', logger, { ownerUid: 'u1', companyId: 'u1' })) === false && !W.docs['leads/L-v'].cancelBy);
    ok('no owner given → not stamped', (await CW.stampLeadCancelBy(DB, 'L-own', '2026-10-09', logger)) === false && !W.docs['leads/L-own'].cancelBy);
    ok('own lead → stamped', (await CW.stampLeadCancelBy(DB, 'L-own', '2026-10-09', logger, { ownerUid: 'u1' })) === true && W.docs['leads/L-own'].cancelBy === '2026-10-09');
    ok('teammate\'s lead, same company → stamped', (await CW.stampLeadCancelBy(DB, 'L-mate', '2026-10-09', logger, { ownerUid: 'u1', companyId: 'co-1' })) === true);
    ok('missing lead → false, never created', (await CW.stampLeadCancelBy(DB, 'L-none', '2026-10-09', logger, { ownerUid: 'u1' })) === false && !W.docs['leads/L-none']);
  }
  {
    const strip = (f) => stripComments(fs.readFileSync(fnPath(f), 'utf8'));
    ok('deal accept passes the owner to stampLeadCancelBy',
      /CW\.stampLeadCancelBy\(db, info\.leadId, cancelBy, logger, \{ ownerUid: info\.ownerUid, companyId: info\.companyId \}[,)]/.test(strip('deal-acceptance.js')));
    ok('e-sign envelope passes the owner',
      /CW\.stampLeadCancelBy\(db, env\.leadId, cancelBy, logger, \{ ownerUid: env\.ownerUid, companyId: env\.companyId \}[,)]/.test(strip('esign-envelope.js')));
    ok('remote signing passes the owner',
      /CW\.stampLeadCancelBy\(db, info\.leadId, cancelBy, logger, \{ ownerUid: info\.ownerUid \}[,)]/.test(strip('remote-signing.js')));
    const sub = body(strip('deal-acceptance.js'), 'exports.submitDealAcceptance');
    ok('submitDealAcceptance carries the token\'s companyId into info (spine + cancelBy)', /ownerUid: t\.ownerUid, companyId: t\.companyId \|\| null/.test(sub));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nC. spineAfterDealAccept — the tenant check runs');
  // ══════════════════════════════════════════════════════════════════
  {
    const deps = { FieldValue, logger, now: () => Date.parse('2026-10-05T15:00:00Z') };
    resetWorld({ 'leads/S-v': { userId: 'victim', companyId: 'co-v', stage: 'estimate_sent_cash', jobType: 'cash' } });
    const r = await SPINE_REAL.spineAfterDealAccept(DB, { dealId: 'd1', leadId: 'S-v', ownerUid: 'u1', companyId: 'u1' }, 'better', deps);
    ok('another tenant\'s lead → tenant_mismatch, stage untouched', r.reason === 'tenant_mismatch' && W.docs['leads/S-v'].stage === 'estimate_sent_cash', JSON.stringify(r));
    resetWorld({ 'leads/S-l': { userId: 'victim', stage: 'estimate_sent_cash', jobType: 'cash' } });
    const r2 = await SPINE_REAL.spineAfterDealAccept(DB, { dealId: 'd2', leadId: 'S-l', ownerUid: 'u1', companyId: 'u1' }, 'better', deps);
    ok('another owner\'s legacy lead (no companyId) → tenant_mismatch', r2.reason === 'tenant_mismatch' && W.docs['leads/S-l'].stage === 'estimate_sent_cash', JSON.stringify(r2));
    resetWorld({ 'leads/S-o': { userId: 'u1', companyId: 'u1', stage: 'estimate_sent_cash', jobType: 'cash' } });
    const r3 = await SPINE_REAL.spineAfterDealAccept(DB, { dealId: 'd3', leadId: 'S-o', ownerUid: 'u1', companyId: 'u1' }, 'better', deps);
    ok('own lead → Contract Signed', r3.moved === true && W.docs['leads/S-o'].stage === 'contract_signed', JSON.stringify(r3));
    resetWorld({ 'leads/S-m': { userId: 'mate', companyId: 'co-1', stage: 'estimate_sent_cash', jobType: 'cash' } });
    const r4 = await SPINE_REAL.spineAfterDealAccept(DB, { dealId: 'd4', leadId: 'S-m', ownerUid: 'u1', companyId: 'co-1' }, 'better', deps);
    ok('teammate\'s lead, same company → moves', r4.moved === true, JSON.stringify(r4));
  }

  // ══════════════════════════════════════════════════════════════════
  console.log('\nD. createReportShareToken — never emails another company\'s homeowner');
  // ══════════════════════════════════════════════════════════════════
  const shareTokens = () => Object.keys(W.docs).filter((k) => k.startsWith('report_share_tokens/')).map((k) => W.docs[k]);
  {
    resetWorld({
      'reports/report-': { userId: 'u1', companyId: 'u1', html: '<p>r</p>', leadId: 'lead-victim', type: 'Roof Inspection' },
      'leads/lead-victim': { userId: 'victim', companyId: 'co-victim', email: 'victim@example.com', firstName: 'Vic' },
    });
    const r = await call(SHARE.createReportShareToken, { reportId: 'report-' }, OWNER);
    ok('report naming another tenant\'s lead → link still minted', r.value && !!r.value.shareUrl, r.err && r.err.message);
    ok('…no email to that homeowner', W.sent.length === 0 && !(r.value && r.value.emailed), JSON.stringify(W.sent.map((m) => m.to)));
    ok('…and the token does not carry the foreign leadId', (shareTokens()[0] || {}).leadId === null);
  }
  {
    resetWorld({
      'reports/report-': { userId: 'u1', companyId: 'u1', html: '<p>r</p>', leadId: 'lead-1', type: 'Roof Inspection' },
      'leads/lead-1': { userId: 'u1', companyId: 'u1', email: 'pat@example.com', firstName: 'Pat' },
    });
    const r = await call(SHARE.createReportShareToken, { reportId: 'report-' }, OWNER);
    ok('own lead → emailed to that homeowner (unchanged)', W.sent.length === 1 && W.sent[0].to === 'pat@example.com' && r.value && r.value.emailed === true, r.err && r.err.message);
    ok('…token carries the lead', (shareTokens()[0] || {}).leadId === 'lead-1');
  }
  {
    resetWorld({
      'reports/report-': { userId: 'u1', companyId: 'co-1', html: '<p>r</p>', leadId: 'lead-mate' },
      'leads/lead-mate': { userId: 'mate', companyId: 'co-1', email: 'mate-home@example.com' },
    });
    await call(SHARE.createReportShareToken, { reportId: 'report-' }, { uid: 'u1', companyId: 'co-1' });
    ok('teammate\'s lead in the report\'s company → emailed', W.sent.length === 1 && W.sent[0].to === 'mate-home@example.com');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
