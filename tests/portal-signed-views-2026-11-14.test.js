/**
 * tests/portal-signed-views-2026-11-14.test.js
 *
 * The homeowner portal never shows a price or a "Signed" badge the homeowner
 * did not sign (money review 2026-11-14, findings 4 and 6). Behaviour over the
 * real getHomeownerPortalView / getEstimateForView handlers on a fake
 * Firestore.
 *
 *   4. The card showed the signed $14,500 but "See what's included"
 *      (getEstimateForView) showed the re-priced $16,200 and its new rows.
 *      Now the page reads the estimate through portalPriced, like the card.
 *   6. Roof signed at $14,500, a $2,300 gutter add-on shared later: the card
 *      picked the newest shared estimate and job-level signals labelled it
 *      "$2,300 Signed". Now the card prefers the estimate that carries the
 *      signature, and job-level signals only count for their own estimate.
 *
 * Nothing is sent: no network (global fetch throws).
 * Harness copied from tests/portal-after-signing-2026-10-07.test.js.
 *
 * Run: node tests/portal-signed-views-2026-11-14.test.js
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
// The accept path's job-spine hand-off (a no-op here: the stage move is
// tested elsewhere). Set before deal-acceptance.js destructures it.
spineStub.spineAfterDealAccept = async () => ({ moved: false });
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

// ════════════════════════════════════════════════════════════════════════
// Modules under test (real code)
// ════════════════════════════════════════════════════════════════════════
const PORTAL = require(fnPath('portal.js'));
const PAS = require(fnPath('portal-after-signing.js'));

const DAY = 86400000;
const TOKEN = 'PORTALTOKEN1234567890AB';
const OH = '1 Main St, Cincinnati, OH 45202';

// The roof as signed at $14,500, then re-priced to $16,200 by the rep.
const SIGNED_ROWS = [{ desc: 'Tear-off and replace', qty: '20 SQ', retailTotal: 14500 }];
const EDITED_ROWS = [{ desc: 'Tear-off and replace', qty: '20 SQ', retailTotal: 14500 }, { desc: 'Ridge vent upgrade', qty: '1', retailTotal: 1700 }];
function signedRoof(over) {
  const o = Object.assign({
    userId: 'u1', companyId: 'u1', leadId: 'lead-1', sharedWithHomeowner: true,
    grandTotal: 16200, total: 16200, rows: EDITED_ROWS, tier: 'better',
    signedPrice: { fields: { grandTotal: 14500, total: 14500, rows: SIGNED_ROWS, tier: 'better' }, fingerprint: 'p1-x', totalCents: 1450000, source: 'contract_signed', sourceId: 'c1', from: 'estimate', at: Date.now() - 4 * DAY },
    createdAt: Timestamp.fromMillis(Date.now() - 10 * DAY),
  }, over || {});
  Object.keys(o).forEach((k) => { if (o[k] === undefined) delete o[k]; });
  return o;
}
// The $2,300 gutter add-on, shared AFTER the roof was signed.
function gutters(over) {
  return Object.assign({
    userId: 'u1', companyId: 'u1', leadId: 'lead-1', sharedWithHomeowner: true,
    grandTotal: 2300, total: 2300, rows: [{ desc: 'Seamless gutters', qty: '120 LF', retailTotal: 2300 }],
    createdAt: Timestamp.fromMillis(Date.now() - 1 * DAY),
  }, over || {});
}
function world(docs, leadOver) {
  resetWorld(Object.assign({
    'leads/lead-1': Object.assign({ userId: 'u1', companyId: 'u1', firstName: 'Sam', lastName: 'Smith', address: OH, stage: 'contract_signed' }, leadOver || {}),
    ['portal_tokens/' + TOKEN]: { leadId: 'lead-1', ownerUid: 'u1', companyId: 'u1', expiresAt: Timestamp.fromMillis(Date.now() + 30 * DAY), uses: 0, maxUses: 100 },
    'users/u1': { displayName: 'Joe Deal' },
  }, docs || {}));
}
async function openPortal() {
  const r = mkRes();
  await PORTAL.getHomeownerPortalView(mkReq({ body: { token: TOKEN } }), r);
  await flush();
  return r;
}
async function openEstimate(estimateId) {
  const r = mkRes();
  await PORTAL.getEstimateForView(mkReq({ body: { token: TOKEN, estimateId } }), r);
  await flush();
  return r;
}
const sumLines = (lines) => Math.round((lines || []).reduce((s, l) => s + Number(l.lineTotal || 0), 0) * 100);

(async () => {
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n1. "See what\'s included" shows the SIGNED price, like the card (finding 4)');
  // ══════════════════════════════════════════════════════════════════════
  {
    world({ 'estimates/est-roof': signedRoof() });
    const card = await openPortal();
    const page = await openEstimate('est-roof');
    const e = page.body && page.body.estimate;
    ok('the card shows the signed $14,500 (unchanged behaviour)', card.body.estimate && card.body.estimate.grandTotal === 14500, JSON.stringify(card.body.estimate && card.body.estimate.grandTotal));
    ok('the detail page grandTotal is the signed $14,500, not the re-priced $16,200', page.statusCode === 200 && e && e.grandTotal === 14500, JSON.stringify(e && e.grandTotal));
    ok('the detail page total is the signed $14,500', e && e.total === 14500, JSON.stringify(e && e.total));
    ok('the line rows are the signed rows (no post-signing "Ridge vent upgrade")', e && Array.isArray(e.lines) && e.lines.length === 1 && !e.lines.some((l) => /Ridge vent/.test(l.name)), JSON.stringify(e && e.lines));
    ok('the line rows add up to the signed total in cents', e && sumLines(e.lines) === 1450000, String(e && sumLines(e.lines)));

    // Tier cards (per-SQ prices{}) follow the signed copy too.
    world({ 'estimates/est-sq': signedRoof({
      rows: undefined, priceMode: 'per-sq', grandTotal: 16200, total: 16200,
      prices: { good: 13000, better: 16200, best: 19000 },
      signedPrice: { fields: { grandTotal: 14500, total: 14500, priceMode: 'per-sq', prices: { good: 12000, better: 14500, best: 17000 }, tier: 'better' }, fingerprint: 'p1-y', totalCents: 1450000, source: 'contract_signed', sourceId: 'c2', from: 'estimate', at: Date.now() },
    }) });
    const sq = (await openEstimate('est-sq')).body.estimate;
    ok('per-SQ tier cards show the signed prices (better $14,500, not $16,200)', sq && sq.tiers && sq.tiers.better && sq.tiers.better.grandTotal === 14500 && sq.tiers.good.grandTotal === 12000, JSON.stringify(sq && sq.tiers));

    // A revision out for a NEW signature shows the revision (what they are
    // being asked to sign) — the same rule as the card (portalPriced).
    world({ 'estimates/est-roof': signedRoof({ signatureStatus: 'sent' }) });
    const rev = (await openEstimate('est-roof')).body.estimate;
    ok('a revision out for re-signature shows the revision ($16,200, both rows)', rev && rev.grandTotal === 16200 && rev.lines.length === 2, JSON.stringify(rev && { g: rev.grandTotal, n: rev.lines.length }));

    // Never signed: as saved.
    world({ 'estimates/est-g': gutters() });
    const g = (await openEstimate('est-g')).body.estimate;
    ok('an unsigned estimate is shown as saved', g && g.grandTotal === 2300 && g.lines.length === 1);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n2. "Signed" never sits on an unsigned estimate (finding 6)');
  // ══════════════════════════════════════════════════════════════════════
  {
    // Roof signed (stamped) at $14,500; a $2,300 gutter add-on shared later.
    world({ 'estimates/est-roof': signedRoof(), 'estimates/est-gut': gutters() });
    let r = await openPortal();
    let est = r.body.estimate;
    ok('the card is the signed roof, not the newer unsigned add-on', est && est.id === 'est-roof', JSON.stringify(est && est.id));
    ok('…at the signed $14,500 with "✓ Signed"', est && est.grandTotal === 14500 && est.jobStatus && est.jobStatus.key === 'signed', JSON.stringify(est && { g: est.grandTotal, js: est.jobStatus }));
    ok('no card ever reads "$2,300 Signed"', !(est && est.grandTotal === 2300 && est.jobStatus));

    // Same, signed through the deal room (accepted deal names the roof).
    world({
      'estimates/est-roof': signedRoof({ signedPrice: undefined, grandTotal: 14500, total: 14500, rows: SIGNED_ROWS }),
      'estimates/est-gut': gutters(),
      'deal_rooms/deal-1': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', estimateId: 'est-roof', status: 'accepted', acceptedTier: 'better', acceptedPrice: 14500 },
    }, { stage: 'estimate_sent_cash' });
    r = await openPortal();
    est = r.body.estimate;
    ok('deal-room signature on the roof (no stamp yet): the card is the roof, "✓ Signed"', est && est.id === 'est-roof' && est.jobStatus && est.jobStatus.key === 'signed' && est.signedVia === 'deal-room', JSON.stringify(est && { id: est.id, js: est.jobStatus, via: est.signedVia }));

    // Legacy: roof signed in person, no stamp and never shared; the job's
    // stage says signed and the lead's primary estimate is the roof. The
    // gutter card shows, and must not be labelled signed.
    world({
      'estimates/est-roof': signedRoof({ signedPrice: undefined, sharedWithHomeowner: false }),
      'estimates/est-gut': gutters(),
    }, { stage: 'contract_signed', primaryEstimateId: 'est-roof' });
    r = await openPortal();
    est = r.body.estimate;
    ok('the job is signed on another estimate → the $2,300 add-on card is not "Signed"', est && est.id === 'est-gut' && est.jobStatus === null && est.signedVia === null, JSON.stringify(est && { id: est.id, js: est.jobStatus, via: est.signedVia }));

    // An accepted deal for ANOTHER estimate never marks this one signed.
    world({
      'estimates/est-gut': gutters(),
      'deal_rooms/deal-1': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', estimateId: 'est-roof', status: 'accepted', acceptedTier: 'better', acceptedPrice: 14500 },
    }, { stage: 'estimate_sent_cash' });
    r = await openPortal();
    est = r.body.estimate;
    ok('a deal accepted for another estimate does not label the add-on "Signed"', est && est.id === 'est-gut' && est.jobStatus === null, JSON.stringify(est && { id: est.id, js: est.jobStatus, via: est.signedVia }));

    // The add-on OUT FOR SIGNATURE after the roof was signed: that is the
    // homeowner's current ask — the card shows it, awaiting signature.
    world({ 'estimates/est-roof': signedRoof(), 'estimates/est-gut': gutters({ signatureStatus: 'sent' }) });
    r = await openPortal();
    est = r.body.estimate;
    ok('an add-on out for signature (newer) is the card, awaiting signature, not "Signed"', est && est.id === 'est-gut' && est.jobStatus === null && est.signatureStatus === 'sent', JSON.stringify(est && { id: est.id, js: est.jobStatus }));

    // Unchanged: a single legacy estimate on a signed job still reads Signed.
    world({ 'estimates/est-1': gutters({ grandTotal: 12000, total: 12000 }) }, { stage: 'contract_signed' });
    r = await openPortal();
    ok('one estimate, job signed (no primary set) → still "✓ Signed" (M1 unchanged)', r.body.estimate && r.body.estimate.jobStatus && r.body.estimate.jobStatus.key === 'signed');

    // Pure: signedVia gates job-level signals to this estimate.
    ok('PAS.signedVia: a deal for another estimate does not count', PAS.signedVia({ estimate: { id: 'b' }, deals: [{ status: 'accepted', estimateId: 'a' }], progress: null }) === null);
    ok('PAS.signedVia: a deal with no estimateId (legacy) still counts', PAS.signedVia({ estimate: { id: 'b' }, deals: [{ status: 'accepted' }], progress: null }) === 'deal-room');
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n3. getEstimateForView serves only a shared estimate of this lead and tenant (review M2)');
  // ══════════════════════════════════════════════════════════════════════
  {
    // T3: an unshared draft on the right lead → 403, and nothing is stamped.
    world({ 'estimates/est-draft': gutters({ sharedWithHomeowner: false }) });
    let r = await openEstimate('est-draft');
    ok('T3 an unshared draft estimate → 403', r.statusCode === 403, r.statusCode + ' ' + JSON.stringify(r.body));
    const d = W.docs['estimates/est-draft'];
    ok('…and its viewCount / viewedAt are not bumped', !d.viewCount && !d.viewedAt, JSON.stringify({ c: d.viewCount, v: !!d.viewedAt }));
    ok('…and no "Homeowner viewed estimate" activity is logged', !Object.keys(W.docs).some((k) => k.startsWith('leads/lead-1/activity/')));
    // Each sharing signal still opens it.
    for (const [name, over] of [['sharedWithHomeowner', { sharedWithHomeowner: true }], ['sentAt', { sharedWithHomeowner: false, sentAt: Timestamp.fromMillis(Date.now()) }], ['signatureStatus sent', { sharedWithHomeowner: false, signatureStatus: 'sent' }]]) {
      world({ 'estimates/est-s': gutters(over) });
      r = await openEstimate('est-s');
      ok('a shared estimate (' + name + ') still opens → 200', r.statusCode === 200, String(r.statusCode));
    }
    // T5: another tenant's estimate on this lead id → 403.
    world({ 'estimates/est-x': gutters({ userId: 'intruder', companyId: 'intruder' }) });
    r = await openEstimate('est-x');
    ok('T5 another tenant\'s (shared) estimate on this lead → 403', r.statusCode === 403, String(r.statusCode));
    // T6: this tenant's shared estimate on ANOTHER lead → 403.
    world({ 'estimates/est-y': gutters({ leadId: 'lead-2' }) });
    r = await openEstimate('est-y');
    ok('T6 a shared estimate on another lead → 403', r.statusCode === 403, String(r.statusCode));
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n4. "✓ Signed" with no locked price shows no amount (review, portal-after-signing ~67/~78)');
  // ══════════════════════════════════════════════════════════════════════
  {
    // A legacy deal room (no estimateId) accepted; the estimate carries no
    // signedPrice, so its saved total may not be what was signed.
    world({
      'estimates/est-1': gutters({ grandTotal: 12000, total: 12000, depositPlan: { v: 1, summary: 'x', valueText: '$6,000.00' } }),
      'deal_rooms/deal-1': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', status: 'accepted', acceptedTier: 'better', acceptedPrice: 12000 },
    }, { stage: 'estimate_sent_cash' });
    let est = (await openPortal()).body.estimate;
    ok('signed (legacy deal room) but no signedPrice → "✓ Signed" with no amount, pricePending', est && est.jobStatus && est.jobStatus.key === 'signed'
      && est.grandTotal === null && est.pricePending === true && est.depositPlan === null, JSON.stringify(est && { g: est.grandTotal, p: est.pricePending, js: est.jobStatus }));
    // Signed by the stage alone, no stamp → same.
    world({ 'estimates/est-1': gutters({ grandTotal: 12000, total: 12000 }) }, { stage: 'contract_signed' });
    est = (await openPortal()).body.estimate;
    ok('signed by the job stage alone, no signedPrice → no amount, pricePending', est && est.grandTotal === null && est.pricePending === true, JSON.stringify(est && { g: est.grandTotal, p: est.pricePending }));
    // A stamped estimate keeps its signed amount.
    world({ 'estimates/est-roof': signedRoof() });
    est = (await openPortal()).body.estimate;
    ok('a stamped signed estimate keeps its signed $14,500 (not pending)', est && est.grandTotal === 14500 && !est.pricePending);
    // Not signed: the amount shows as before.
    world({ 'estimates/est-g': gutters() }, { stage: 'estimate_sent_cash' });
    est = (await openPortal()).body.estimate;
    ok('not signed → the amount shows as before', est && est.grandTotal === 2300 && !est.pricePending);
    // The page says so in words (docs/pro/js/portal.js).
    const PJS = fs.readFileSync(path.join(ROOT, 'docs/pro/js/portal.js'), 'utf8');
    ok('docs/pro/js/portal.js renders pricePending as "confirming the signed price"', /e\.pricePending/.test(PJS) && /confirming the signed price/.test(PJS));
    // $0 is a real total (?? not ||): an all-insurance $0 estimate is not "still putting the numbers together".
    world({ 'estimates/est-z': gutters({ grandTotal: 0, total: 0 }) }, { stage: 'estimate_sent_cash' });
    est = (await openPortal()).body.estimate;
    const ev = (await openEstimate('est-z')).body.estimate;
    ok('a $0 grandTotal reads as $0 on the card and the page (?? not ||)', est && est.grandTotal === 0 && ev && ev.grandTotal === 0, JSON.stringify({ card: est && est.grandTotal, page: ev && ev.grandTotal }));
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n5. Every estimate-view link marks the estimate shared first (M2 would 403 it otherwise)');
  // ══════════════════════════════════════════════════════════════════════
  {
    const JT = fs.readFileSync(path.join(ROOT, 'docs/pro/js/job-templates-ui.js'), 'utf8').replace(/\r\n/g, '\n');
    const at = JT.indexOf('async function sendToCustomer()');
    const body = at === -1 ? '' : JT.slice(at, JT.indexOf('\n  function duplicateTemplate', at));
    const stampAt = body.search(/sharedWithHomeowner:\s*true/);
    const linkAt = body.indexOf('navigator.share');
    ok('job-templates-ui sendToCustomer stamps sharedWithHomeowner before handing out the link', stampAt !== -1 && linkAt !== -1 && stampAt < linkAt);
    const CB = fs.readFileSync(path.join(ROOT, 'docs/pro/js/customer-bootstrap.module.js'), 'utf8').replace(/\r\n/g, '\n');
    const cStamp = CB.indexOf('sharedWithHomeowner: true');
    const cShare = CB.indexOf("title: 'Your estimate from '");
    ok('customer page: stamps sharedWithHomeowner before handing out the link', cStamp !== -1 && cShare !== -1 && cStamp < cShare);
    const cAt = CB.indexOf("console.warn('[estimate-share] could not stamp sharedWithHomeowner:'");
    const after = cAt === -1 ? '' : CB.slice(cAt, cAt + 400);
    ok('customer page: a failed share stamp stops with an error (the link would not open)', cAt !== -1 && /showToast\([^)]*error/.test(after) && /return;/.test(after), after.slice(0, 200));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
