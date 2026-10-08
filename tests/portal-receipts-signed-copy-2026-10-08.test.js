/**
 * tests/portal-receipts-signed-copy-2026-10-08.test.js
 *
 * The deferred half of #2309 (homeowner money audit 2026-10-07):
 *   M3b  The portal never showed a receipt. Each payment in the Payments card
 *        now has "Receipt": a printable receipt (date, amount, method,
 *        invoice, job, paid so far, total, balance) built by the CRM's own
 *        receipt renderer (docs/pro/js/payment-receipt.js, moved out of
 *        invoice-pipeline.js; functions/ carries a byte-identical copy).
 *   M4   A deal-room signer got no copy of what they signed. The portal now
 *        offers "Your signed agreement": a read-only copy built from the
 *        acceptance record (price signed, package, scope, signature, time,
 *        FTC statement, KY notices, the cancel packet dated the signing day).
 *
 * Behaviour over the real modules: getHomeownerPortalView and
 * getPortalDocumentHtml on a fake Firestore + Storage, payment-receipt.js,
 * portal-signed-agreement.js, invoice-pipeline.js (parity), and portal.js's
 * string builders lifted and run. Auth: another homeowner's token (same
 * company or not) reads neither receipts nor the agreement.
 *
 * Nothing is sent: no network (global fetch throws).
 * Harness (fake Firestore, stubs) copied from
 * tests/portal-after-signing-2026-10-07.test.js.
 *
 * Run: node tests/portal-receipts-signed-copy-2026-10-08.test.js
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

const PORTAL = require(fnPath('portal.js'));

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
  const realEnd = r.end.bind(r);
  r.end = (...a) => { try { realEnd(...a); } catch (_) { /* ended */ } return r; };
  return r;
}
function mkReq(o) {
  const h = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X)' };
  return Object.assign({ method: 'POST', body: {}, path: '/', headers: h, ip: '203.0.113.9', get: (k) => h[String(k).toLowerCase()] }, o || {});
}

// ════════════════════════════════════════════════════════════════════════
// Modules under test (real code)
// ════════════════════════════════════════════════════════════════════════
function req(rel) {
  try { return require(path.join(ROOT, rel)); } catch (e) { ok('loads ' + rel, false, e && e.message); return null; }
}
const PR = req('docs/pro/js/payment-receipt.js');
const PRF = req('functions/payment-receipt.js');
const PSA = req('functions/portal-signed-agreement.js');
const IP = req('docs/pro/js/invoice-pipeline.js');
const KyLaw = require(fnPath('ky-insurance-law.js'));
const DEALJS = fs.readFileSync(fnPath('deal-acceptance.js'), 'utf8');

// The page's pure string builders, lifted from docs/pro/js/portal.js and run.
const PJS = fs.readFileSync(path.join(ROOT, 'docs/pro/js/portal.js'), 'utf8').replace(/\r\n/g, '\n');
function lift(names) {
  const pick = (re) => { const m = re.exec(PJS); return m ? m[0] : ''; };
  const parts = [
    pick(/const esc = \(s\) => [\s\S]*?\);\n/),
    pick(/const safeUrl = \(u\) => \{[\s\S]*?\n  \};/),
  ];
  const missing = [];
  names.forEach((n) => {
    const src = pick(new RegExp('\\n  function ' + n + '\\([\\s\\S]*?\\n  \\}\\n'));
    if (!src) missing.push(n);
    parts.push(src);
  });
  if (missing.length) return { missing };
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(parts.join('\n') + '\nthis.fns = {' + names.map((n) => n + ':' + n).join(',') + '};', sb);
  return sb.fns;
}

const DAY = 86400000;
const OH = '1 Main St, Cincinnati, OH 45202';
const KY = '9 Elm St, Covington, KY 41011';
const SIG = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(40);
const XSS = '<img src=x onerror=alert(1)>"\'';
const T1 = 'PORTALTOKEN1234567890AB';   // Sam's portal (lead-1, tenant u1)
const T2 = 'OTHERHOMEOWNERTOKEN0000';   // Pat's portal (lead-2, same tenant)
const T3 = 'OTHERTENANTTOKEN0000000';   // another company's homeowner (lead-3)
const PAID1 = Date.parse('2026-10-01T15:00:00Z');
const PAID2 = Date.parse('2026-10-06T02:30:00Z'); // Oct 5, 10:30pm Eastern
const SIGNED = Date.parse('2026-10-02T18:05:00Z'); // Oct 2, 2:05pm Eastern

function world(extra) {
  resetWorld(Object.assign({
    'leads/lead-1': { userId: 'u1', companyId: 'u1', firstName: 'Sam', lastName: 'Smith', address: OH, stage: 'contract_signed' },
    'leads/lead-2': { userId: 'u1', companyId: 'u1', firstName: 'Pat', lastName: 'Jones', address: '2 Oak St, Cincinnati, OH 45202', stage: 'contract_signed' },
    'leads/lead-3': { userId: 'x9', companyId: 'x9', firstName: 'Kim', lastName: 'Lee', address: OH, stage: 'contract_signed' },
    ['portal_tokens/' + T1]: { leadId: 'lead-1', ownerUid: 'u1', companyId: 'u1', expiresAt: Timestamp.fromMillis(Date.now() + 30 * DAY), uses: 0, maxUses: 100 },
    ['portal_tokens/' + T2]: { leadId: 'lead-2', ownerUid: 'u1', companyId: 'u1', expiresAt: Timestamp.fromMillis(Date.now() + 30 * DAY), uses: 0, maxUses: 100 },
    ['portal_tokens/' + T3]: { leadId: 'lead-3', ownerUid: 'x9', companyId: 'x9', expiresAt: Timestamp.fromMillis(Date.now() + 30 * DAY), uses: 0, maxUses: 100 },
    'users/u1': { displayName: 'Joe Deal' },
    'companyProfile/u1': { brand: { legalName: 'Acme Roofing LLC', timeZone: 'America/New_York' } },
    'estimates/est-1': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', sharedWithHomeowner: true, grandTotal: 13675, createdAt: Timestamp.fromMillis(Date.now() - 9 * DAY) },
    // Sam's invoice: $13,675, deposit $6,850 online, then $6,825 by check.
    'invoices/inv-1': {
      leadId: 'lead-1', userId: 'u1', companyId: 'u1', createdBy: 'u1', total: 13675, depositAmount: 6850,
      amountPaid: 13675, balanceDue: 0, status: 'paid', invoiceNumber: 'NBD-2026-1007-0003',
      createdAt: Timestamp.fromMillis(Date.now() - 6 * DAY),
      paper: { receipt: { state: 'filed', pdfPath: 'money-paper/u1/secret-receipt.pdf', instanceId: 'NBD-510-0009' } },
      payments: [
        { amount: 6850, method: 'stripe', at: Timestamp.fromMillis(PAID1), paymentIntentId: 'pi_SECRET123', reference: 'pi_SECRET123', note: 'internal note' },
        { amount: 6825, method: 'check', at: Timestamp.fromMillis(PAID2), paymentId: 'pay_2', reference: '1042', proofPath: 'proof/u1/check.jpg' },
      ],
    },
  }, extra || {}));
}
async function post(handler, body) {
  const r = mkRes();
  await handler(mkReq({ body }), r);
  await flush();
  return r;
}
const openPortal = (tok) => post(PORTAL.getHomeownerPortalView, { token: tok || T1 });
const docHtml = (body) => post(PORTAL.getPortalDocumentHtml, body);

// A deal-room acceptance as submitDealAcceptance records it, and the page it stored.
function signedDeal(over) {
  return Object.assign({
    userId: 'u1', companyId: 'u1', leadId: 'lead-1', estimateId: 'est-1', customerName: 'Sam Smith', address: OH,
    status: 'accepted', acceptedTier: 'better', acceptedPrice: 13675, acceptedFinancing: -1,
    acceptedSignature: SIG, acceptedAt: Timestamp.fromMillis(SIGNED), acceptedVia: 'remote',
    acceptedEvidence: { at: SIGNED, consent: true, signatureSha256: 'abc' },
    scheduledInstallDate: '2026-10-20', cancelBy: '2026-10-06',
    scopeSummary: ['Tear off 1 layer', 'GAF Timberline HDZ shingles'],
    tiers: { better: { price: 13675, description: 'fallback description' }, best: { price: 16000 } },
  }, over || {});
}
function dealPage(opts) {
  const o = opts || {};
  const packet = KyLaw.cancelPacketHtml({
    transactionDate: new Date(Date.parse('2026-09-28T15:00:00Z')), timeZone: 'America/New_York',
    sellerName: 'Acme Roofing LLC', sellerAddress: 'PO Box 1, Cincinnati, OH 45201', email: 'office@acme.test',
    homeownerName: o.name || 'Sam Smith', propertyAddress: o.address || OH, state: o.ky ? 'KY' : 'OH',
    kyInsurance: !!o.ky, kyNoticesInDocument: !!o.ky,
  });
  return '<!DOCTYPE html><html><head><title>Deal</title></head><body>'
    + '<div class="tier recommended" id="tier-better" data-deal-tier="better"><div class="tier-name">★★ Preferred</div>'
    + '<div class="tier-price">$13,675.00</div><div class="tier-desc">' + (o.desc || 'Full replacement, upgraded underlayment') + '</div>'
    + '<div class="tier-warranty">🛡️ 10-year workmanship warranty</div></div>'
    + '<div class="tier" id="tier-best" data-deal-tier="best"><div class="tier-desc">Best desc</div><div class="tier-warranty">🛡️ 20-year</div></div>'
    + (o.ky ? '<div>' + KyLaw.kyNoticesHtml() + '</div>' : '')
    + '<canvas id="sigCanvas"></canvas><button class="sign-btn" id="submitBtn">✓ ACCEPT &amp; SCHEDULE</button>'
    + packet
    + '<script src="https://nobigdealwithjoedeal.com/pro/deal-room.js?v=5"></script></body></html>';
}
function storePage(dealId, html) { W.objects['deal_rooms/u1/' + dealId + '.html'] = { body: html, meta: {} }; }

(async () => {
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n1. One receipt renderer: the CRM\'s, shared with the portal and functions/');
  // ══════════════════════════════════════════════════════════════════════
  if (PR && PRF && PSA) {
    const a = fs.readFileSync(path.join(ROOT, 'docs/pro/js/payment-receipt.js'));
    const b = fs.readFileSync(fnPath('payment-receipt.js'));
    ok('functions/payment-receipt.js is a byte-identical copy of docs/pro/js/payment-receipt.js', a.equals(b));
    const html = fs.readFileSync(path.join(ROOT, 'docs/pro/portal.html'), 'utf8');
    const iR = html.indexOf('js/payment-receipt.js?v='); const iP = html.indexOf('js/portal.js?v=');
    ok('portal.html loads payment-receipt.js (defer) before portal.js', iR > 0 && iP > iR && /<script defer src="js\/payment-receipt\.js\?v=\d+"><\/script>/.test(html));

    world();
    const inv1 = W.docs['invoices/inv-1'];
    const d0 = PR.receiptDetailsOf(inv1, 'pi_SECRET123');
    const d1 = PR.receiptDetailsOf(inv1, 'pay_2');
    ok('deposit receipt: $6,850 paid, $6,850 so far, $6,825 left of $13,675', d0 && d0.amount === 6850 && d0.paidSoFar === 6850
      && d0.balanceRemaining === 6825 && d0.invoiceTotal === 13675 && d0.paidInFull === false, JSON.stringify(d0));
    ok('balance receipt: $6,825 paid, $13,675 so far, $0 left, paid in full', d1 && d1.amount === 6825 && d1.paidSoFar === 13675
      && d1.balanceRemaining === 0 && d1.paidInFull === true, JSON.stringify(d1));
    ok('a payment that reverted has no receipt', PR.receiptDetailsOf({ total: 100, payments: [{ amount: 100, reverted: true }] }, 'idx:0') === null);
    ok('the date is read in the zone it is given (10:30pm Eastern stays Oct 5)', PR.receiptDetailsOf(inv1, 'pay_2', { timeZone: 'America/New_York' }).dateText === 'October 5, 2026');
    ok('a bare calendar day is that day (no day-before shift)', PR.receiptDetailsOf({ total: 10, payments: [{ amount: 10, date: '2026-10-07' }] }, 'idx:0', { timeZone: 'America/Los_Angeles' }).dateText === 'October 7, 2026');

    if (IP && typeof IP.receiptDetailsOf === 'function') {
      // The CRM's receipt (invoice-pipeline.js) and this one agree, so the
      // homeowner's copy says what the CRM's "Send receipt" sends.
      const cases = [[inv1, 'pi_SECRET123'], [inv1, 'pay_2'], [{ total: 1000.1, payments: [{ amount: 400.05, method: 'zelle', at: new Date(PAID1) }, { amount: 600.05, method: 'cash', at: new Date(PAID2) }] }, 'idx:1']];
      let same = true; const diffs = [];
      cases.forEach(([inv, key]) => {
        const x = IP.receiptDetailsOf(inv, key); const y = PR.receiptDetailsOf(inv, key);
        ['key', 'index', 'amount', 'method', 'dateText', 'balanceRemaining', 'invoiceNumber', 'paidInFull', 'pdfPath', 'pdfName', 'reference'].forEach((k) => {
          if (x[k] !== y[k]) { same = false; diffs.push(k + ':' + x[k] + '≠' + y[k]); }
        });
        const ex = IP.buildReceiptEmail(x, 'Acme'); const ey = PR.buildReceiptEmail(y, 'Acme');
        if (ex.subject !== ey.subject || ex.html !== ey.html || ex.text !== ey.text) { same = false; diffs.push('email'); }
      });
      ok('the CRM\'s receipt (invoice-pipeline.js) and payment-receipt.js give the same receipt and email', same, diffs.join(', '));
    } else ok('invoice-pipeline.js exports receiptDetailsOf / buildReceiptEmail', false);

    const sheet = PR.buildReceiptSheetHtml(Object.assign({}, d1, { invoiceNumber: XSS, method: XSS, dateText: XSS }), XSS, { jobLabel: XSS });
    ok('receipt sheet: every value escaped (no live <img>, no raw quote)', !/<img/i.test(sheet) && sheet.indexOf('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;') !== -1, sheet.slice(0, 300));
    ok('receipt sheet: date, amount, method, invoice, job, paid so far, total, balance', ['Amount paid', 'Method', 'Date', 'Invoice', 'Job', 'Paid so far', 'Invoice total', 'Balance remaining'].every((k) => sheet.indexOf('>' + k + '<') !== -1)
      && sheet.indexOf('$13,675.00') !== -1 && sheet.indexOf('$6,825.00') !== -1);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n2. The portal: a receipt for every payment, from the same token');
  // ══════════════════════════════════════════════════════════════════════
  {
    world();
    const r = await openPortal();
    const pays = r.body && r.body.paid && r.body.paid.payments;
    ok('the portal view lists both payments', r.statusCode === 200 && Array.isArray(pays) && pays.length === 2, r.statusCode + ' ' + JSON.stringify(r.body && r.body.paid));
    const a = pays && pays[0] && pays[0].receipt; const b = pays && pays[1] && pays[1].receipt;
    ok('each payment carries its receipt', !!a && !!b);
    if (a && b) {
      ok('deposit receipt numbers match the payment: $6,850 · paid so far $6,850 · $6,825 left · total $13,675',
        a.amount === 6850 && a.amount * 100 === pays[0].amountCents && a.paidSoFar === 6850 && a.balanceRemaining === 6825 && a.invoiceTotal === 13675 && !a.paidInFull, JSON.stringify(a));
      ok('balance receipt: $6,825 · $13,675 so far · paid in full', b.amount === 6825 && b.paidSoFar === 13675 && b.balanceRemaining === 0 && b.paidInFull === true, JSON.stringify(b));
      ok('the receipt names the NBD invoice number and the homeowner\'s method words', a.invoiceNumber === 'NBD-2026-1007-0003' && a.method === 'Card (online)' && b.method === 'Check');
      ok('dated in the company\'s zone (10:30pm Eastern on Oct 5 → October 5, 2026)', b.dateText === 'October 5, 2026', b.dateText);
      const blob = JSON.stringify(pays);
      ok('nothing internal reaches the homeowner (no processor id, reference, Storage path, note, proof)',
        !/pi_SECRET|money-paper|secret-receipt|proof\/|internal note|"reference"|"key"|"index"|pdfPath/.test(blob), blob);
    }
    // Another homeowner's token sees only their own job's receipts.
    W.docs['invoices/inv-2'] = { leadId: 'lead-2', userId: 'u1', companyId: 'u1', total: 500, status: 'paid', invoiceNumber: 'NBD-PAT-1',
      payments: [{ amount: 500, method: 'cash', at: Timestamp.fromMillis(PAID1) }], createdAt: Timestamp.fromMillis(Date.now() - DAY) };
    const r2 = await openPortal(T2);
    const p2 = r2.body && r2.body.paid && r2.body.paid.payments;
    ok('Pat\'s token: Pat\'s one receipt only — never Sam\'s', Array.isArray(p2) && p2.length === 1 && p2[0].receipt.invoiceNumber === 'NBD-PAT-1'
      && JSON.stringify(r2.body).indexOf('NBD-2026-1007-0003') === -1, JSON.stringify(p2));
    // Another tenant's invoice written with Sam's lead id never becomes his receipt.
    W.docs['invoices/inv-x'] = { leadId: 'lead-1', userId: 'x9', companyId: 'x9', total: 999, status: 'paid', invoiceNumber: 'EVIL-1',
      payments: [{ amount: 999, method: 'cash', at: Timestamp.fromMillis(PAID1) }], createdAt: Timestamp.fromMillis(Date.now()) };
    const r3 = await openPortal();
    ok('another company\'s invoice on the same lead id is not a receipt here', JSON.stringify(r3.body.paid).indexOf('EVIL-1') === -1);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n3. The page: a Receipt button, and the receipt it opens');
  // ══════════════════════════════════════════════════════════════════════
  {
    const F = lift(['_milestoneDateLabel', 'paidSoFarCents', 'fmtCents', 'paymentsCardHtml', 'receiptSheetHtml', 'docViewButtonHtml']);
    if (F.missing) ok('portal.js has paymentsCardHtml / receiptSheetHtml / docViewButtonHtml', false, F.missing.join(', '));
    else {
      world();
      const r = await openPortal();
      const card = F.paymentsCardHtml(r.body.paid);
      ok('Payments card: a Receipt button per payment, keyed by its row', (card.match(/class="btn btn-ghost portal-receipt-btn" data-receipt-i="\d"/g) || []).length === 2
        && card.indexOf('data-receipt-i="0"') !== -1 && card.indexOf('data-receipt-i="1"') !== -1);
      ok('a payment without a receipt gets no button', F.paymentsCardHtml({ totalPaidCents: 100, payments: [{ amountCents: 100, method: 'Cash' }] }).indexOf('portal-receipt-btn') === -1);
      const evil = F.paymentsCardHtml({ totalPaidCents: 100, payments: [{ amountCents: 100, date: XSS, method: XSS, invoiceNumber: XSS, receipt: { amount: 1 } }] });
      ok('Payments card escapes method / invoice number / label', !/<img/i.test(evil) && evil.indexOf('&lt;img') !== -1);
      const sheet = F.receiptSheetHtml(PR, r.body.paid.payments[0].receipt, 'Acme Roofing LLC', OH);
      ok('the receipt it opens: $6,850 paid, $6,825 balance, the job address, the company', sheet.indexOf('$6,850.00') !== -1 && sheet.indexOf('$6,825.00') !== -1
        && sheet.indexOf('1 Main St, Cincinnati, OH 45202') !== -1 && sheet.indexOf('Acme Roofing LLC') !== -1);
      ok('…built by the CRM\'s renderer (payment-receipt.js), nothing else', sheet === PR.buildReceiptSheetHtml(r.body.paid.payments[0].receipt, 'Acme Roofing LLC', { jobLabel: OH }));
      ok('no renderer or no receipt → nothing opens', F.receiptSheetHtml(null, {}, 'x', 'y') === '' && F.receiptSheetHtml(PR, null, 'x', 'y') === '');
      ok('a signed agreement row carries its deal id (escaped); other rows their doc id',
        F.docViewButtonHtml({ kind: 'agreement', dealId: 'deal"1' }).indexOf('data-deal-id="deal&quot;1"') !== -1
        && F.docViewButtonHtml({ id: 'doc-9' }).indexOf('data-doc-id="doc-9"') !== -1);
      ok('the agreement opens read-only (no scripts, no forms)', /DOC_SANDBOX_READONLY = 'allow-popups allow-popups-to-escape-sandbox';/.test(PJS)
        && /setAttribute\('sandbox', dealId \? DOC_SANDBOX_READONLY : DOC_SANDBOX\)/.test(PJS));
      ok('the page adds no inline style for receipts', !/rcpt[^\n]*style=|portal-receipt-btn[^\n]*style=/.test(PJS));
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n4. "Your signed agreement" for a deal-room signer');
  // ══════════════════════════════════════════════════════════════════════
  if (PSA) {
    ok('the copy prints the same consent words the deal page records', DEALJS.indexOf("const DEAL_CONSENT_TEXT = '" + PSA.DEAL_CONSENT_TEXT + "';") !== -1);
    world({ 'deal_rooms/deal-1': signedDeal() });
    storePage('deal-1', dealPage());
    // The rep re-prices the estimate after the signature.
    W.docs['estimates/est-1'].grandTotal = 15999;
    const v = await openPortal();
    const docs = (v.body && v.body.documents) || [];
    ok('the portal lists "Your signed agreement" first on the shelf', docs[0] && docs[0].kind === 'agreement' && docs[0].dealId === 'deal-1'
      && docs[0].name === 'Your signed agreement' && docs[0].viaHtml === true && docs[0].url === null, JSON.stringify(docs[0]));

    const r = await docHtml({ token: T1, dealId: 'deal-1' });
    const h = (r.body && r.body.html) || '';
    ok('Sam\'s token opens it (200)', r.statusCode === 200 && h.indexOf('data-signed-agreement') !== -1, r.statusCode + ' ' + JSON.stringify(r.body).slice(0, 200));
    ok('the price is the one signed ($13,675.00) — not the re-priced estimate ($15,999)', h.indexOf('$13,675.00') !== -1 && h.indexOf('15,999') === -1);
    ok('package, its description and warranty as the page printed them', h.indexOf('>Preferred<') !== -1 && h.indexOf('Full replacement, upgraded underlayment') !== -1
      && h.indexOf('10-year workmanship warranty') !== -1 && h.indexOf('20-year') === -1);
    ok('scope, install date asked for', h.indexOf('<li>Tear off 1 layer</li>') !== -1 && h.indexOf('October 20, 2026') !== -1);
    ok('signature, name and time (company zone: Oct 2, 2:05 PM EDT)', h.indexOf('<img src="' + SIG + '"') !== -1 && h.indexOf('<strong>Sam Smith</strong>') !== -1
      && h.indexOf('October 2, 2026') !== -1 && /2:05\sPM EDT/.test(h));
    ok('the FTC 429.1(a) statement beside the signature, the consent they ticked', h.indexOf('data-nbd-statutory="ftc-429-1-a"') !== -1 && h.indexOf('You agreed: I agree to sign electronically') !== -1);
    ok('the Notice of Right to Cancel, dated the day they signed (not the day the page was made)', h.indexOf('data-nbd-cancel-packet="1"') !== -1
      && h.indexOf('Contract date: October 2, 2026') !== -1 && h.indexOf('September 28, 2026') === -1 && h.indexOf('data-nbd-cancel-by="2026-10-06"') !== -1);
    ok('an Ohio cash job carries no Kentucky notices', h.indexOf('ky-367-624-3') === -1);
    ok('nothing to run or submit: no script, no form, no canvas, no Accept button', !/<script|<form|<canvas|ACCEPT/i.test(h));
    ok('the company name heads it', h.indexOf('<div class="sa-co">Acme Roofing LLC</div>') !== -1);

    // ── Auth: the token proves which lead ──
    const pat = await docHtml({ token: T2, dealId: 'deal-1' });
    ok('another homeowner\'s token (Pat, same company) cannot read Sam\'s agreement (404)', pat.statusCode === 404 && !pat.body.html, pat.statusCode);
    const kim = await docHtml({ token: T3, dealId: 'deal-1' });
    ok('another company\'s homeowner cannot either (404)', kim.statusCode === 404 && !kim.body.html);
    const bad = await docHtml({ token: 'NOSUCHTOKEN00000000000', dealId: 'deal-1' });
    ok('an unknown token: 404', bad.statusCode === 404);
    W.docs['portal_tokens/' + T1].expiresAt = Timestamp.fromMillis(Date.now() - 1000);
    const exp = await docHtml({ token: T1, dealId: 'deal-1' });
    ok('an expired token: 410', exp.statusCode === 410);
    W.docs['portal_tokens/' + T1].expiresAt = Timestamp.fromMillis(Date.now() + 30 * DAY);
    ok('a malformed deal id: 400', (await docHtml({ token: T1, dealId: '../x' })).statusCode === 400);
    // A deal room another company wrote with Sam's lead id.
    W.docs['deal_rooms/deal-evil'] = signedDeal({ userId: 'x9', companyId: 'x9', customerName: 'Evil' });
    const ev = await docHtml({ token: T1, dealId: 'deal-evil' });
    ok('another company\'s deal room on the same lead id is refused (404) and never listed', ev.statusCode === 404
      && !JSON.stringify((await openPortal()).body.documents).includes('deal-evil'));
    // Not signed yet.
    W.docs['deal_rooms/deal-2'] = signedDeal({ status: 'viewed', acceptedTier: null, acceptedPrice: null, acceptedAt: null, acceptedEvidence: null });
    ok('a deal room not yet signed has no agreement (404, not listed)', (await docHtml({ token: T1, dealId: 'deal-2' })).statusCode === 404
      && !JSON.stringify((await openPortal()).body.documents).includes('deal-2'));
    // Same lead id but the lead was re-created by another tenant (tokenMatchesLead).
    W.docs['leads/lead-1'] = Object.assign({}, W.docs['leads/lead-1'], { userId: 'x9', companyId: 'x9' });
    ok('a lead re-created by another company: the old link reads nothing (404)', (await docHtml({ token: T1, dealId: 'deal-1' })).statusCode === 404);

    // ── Kentucky insurance deal ──
    world({ 'deal_rooms/deal-ky': signedDeal({ address: KY, insuranceClaim: true, insuranceCarrier: 'State Farm', claimNumber: 'C-1' }) });
    W.docs['leads/lead-1'].address = KY;
    storePage('deal-ky', dealPage({ ky: true, address: KY }));
    const ky = await docHtml({ token: T1, dealId: 'deal-ky' });
    const kh = (ky.body && ky.body.html) || '';
    ok('KY insurance: the two KRS 367.624(3) notices, and the KY cancel form', kh.indexOf('data-nbd-statutory="ky-367-624-3"') !== -1 && kh.indexOf('data-nbd-noc="ky"') !== -1);
    ok('KY wording: never "we handle / negotiate the claim"', !/handle (your|the) claim|negotiat/i.test(kh.replace(/<[^>]+>/g, ' ')));

    // ── No stored page: still a copy, KY decided from the deal (fail closed) ──
    delete W.objects['deal_rooms/u1/deal-ky.html'];
    const nk = await docHtml({ token: T1, dealId: 'deal-ky' });
    const nh = (nk.body && nk.body.html) || '';
    ok('stored page gone: price, signature and KY notices still there; asks for the notice copy', nk.statusCode === 200 && nh.indexOf('$13,675.00') !== -1
      && nh.indexOf('ky-367-624-3') !== -1 && nh.indexOf('Ask them for a copy') !== -1);

    // ── Escaping: rep- and homeowner-written values ──
    world({ 'deal_rooms/deal-x': signedDeal({ customerName: XSS, address: XSS, scopeSummary: [XSS], acceptedSignature: 'data:image/png;base64,AAA" onerror="alert(1)' }) });
    storePage('deal-x', dealPage({ desc: '<img src=x onerror=alert(2)>Nice &amp; tidy', name: XSS }));
    const xr = await docHtml({ token: T1, dealId: 'deal-x' });
    const xh = (xr.body && xr.body.html) || '';
    ok('every value escaped: name, address, scope, page text — no live <img onerror>', xr.statusCode === 200 && !/<img[^>]*onerror/i.test(xh)
      && xh.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1 && xh.indexOf('Nice &amp; tidy') !== -1, xh.slice(0, 400));
    ok('a signature that is not a clean PNG data URL is not printed', xh.indexOf('data:image/png;base64,AAA') === -1);
  }

  ok('no network was used (no email / SMS)', true);
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
