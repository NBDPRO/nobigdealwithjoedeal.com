/**
 * tests/portal-after-signing-2026-10-07.test.js
 *
 * The homeowner portal after signing (homeowner money audit 2026-10-07,
 * "Portal after signing" batch) + review R6-2-6. Behaviour over the real
 * modules: functions/invoice-charge.js, functions/portal-after-signing.js,
 * the real getHomeownerPortalView / getDealRoom / submitDealAcceptance
 * handlers on a fake Firestore + Storage, and docs/pro/js/portal.js's string
 * builders lifted and run.
 *
 *   1. R6-2-6  After a $6,000 online deposit on a $12,000 job, "Balance Due
 *              $6,000 — Pay Now" opened the SPENT deposit link (the cents
 *              matched). Now: a link is offered only when its kind and cents
 *              are what is due now and no money landed since it was minted;
 *              otherwise "Your balance link is on its way". Kentucky hold first.
 *   2. M1      "Sent to you" after a deal-room signature, through paid in
 *              full. Now: Signed → Deposit paid → Build day set → In progress
 *              → Work complete → Paid in full, by any signing path.
 *   3. M2      "7 of 8 done" beside "See all 9 steps". Now one step list.
 *   4. M3      Nothing said what was paid. Now a Payments card (date, amount,
 *              method; cents; redacted) and "Paid so far" on the estimate card.
 *   5. M5      An e-signed, paid job's deal link still took a second
 *              signature. Now 410 + a link to the homeowner's portal; a
 *              re-priced revision (re-sign) stays open.
 *
 * Nothing is sent: no network (global fetch throws), push is a spy.
 * Harness (fake Firestore, stubs, mkReq/mkRes) copied from
 * tests/estimate-send-track-2026-10-03.test.js.
 *
 * Run: node tests/portal-after-signing-2026-10-07.test.js
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


// ════════════════════════════════════════════════════════════════════════
// Modules under test (real code)
// ════════════════════════════════════════════════════════════════════════
const IC = require(fnPath('invoice-charge.js'));
const DDL = require(fnPath('deposit-draft-logic.js'));
const KyLaw = require(fnPath('ky-insurance-law.js'));
const CER = require(fnPath('customer-estimate-rows.js'));
const HP = require(fnPath('homeowner-progress.js'));
let PAS = null;
try { PAS = require(fnPath('portal-after-signing.js')); } catch (e) { ok('loads functions/portal-after-signing.js', false, e && e.message); }

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

function portalWorld(extra, leadOver) {
  resetWorld(Object.assign({
    'leads/lead-1': Object.assign({ userId: 'u1', companyId: 'u1', firstName: 'Sam', lastName: 'Smith', address: OH, stage: 'contract_signed' }, leadOver || {}),
    'portal_tokens/PORTALTOKEN1234567890AB': { leadId: 'lead-1', ownerUid: 'u1', companyId: 'u1', expiresAt: Timestamp.fromMillis(Date.now() + 30 * DAY), uses: 0, maxUses: 100 },
    'users/u1': { displayName: 'Joe Deal' },
    'estimates/est-1': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', sharedWithHomeowner: true, grandTotal: 12000, createdAt: Timestamp.fromMillis(Date.now() - 5 * DAY) },
  }, extra || {}));
}
async function openPortal() {
  const r = mkRes();
  await PORTAL.getHomeownerPortalView(mkReq({ body: { token: 'PORTALTOKEN1234567890AB' } }), r);
  await flush();
  return r;
}
const acceptedDeal = { 'deal_rooms/deal-1': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', estimateId: 'est-1', status: 'accepted', acceptedTier: 'better', acceptedPrice: 12000 } };
const inv = (f) => Object.assign({ leadId: 'lead-1', userId: 'u1', companyId: 'u1', createdBy: 'u1', total: 12000, depositAmount: 6000, amountPaid: 0, balanceDue: 12000, status: 'sent', createdAt: Timestamp.fromMillis(Date.now() - 2 * DAY) }, f || {});

(async () => {
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n1. R6-2-6 — the balance Pay Now is never the spent deposit link');
  // ══════════════════════════════════════════════════════════════════════
  {
    const dd = DDL.decideDepositDraft({ leadId: 'L', event: 'contract_signed',
      lead: { userId: 'u', primaryEstimateId: 'E', address: OH, state: 'OH', activeJobId: 'J1' },
      est: { userId: 'u', leadId: 'L', grandTotal: 12000, subtotal: 12000, tax: 0, taxRate: 0, mode: 'cash', jobId: 'J1', addr: OH,
        rows: [{ desc: 'Roof', qty: '1', retailTotal: 12000, total: 12000 }] }, estimateId: 'E', existingInvoices: [] });
    const sent = Object.assign({}, dd.invoice, { status: 'sent' });
    const due0 = IC.chargeDueNow(sent);
    // What createStripePaymentLink stamps on a mint (functions/stripe.js _stampCharge).
    const depLink = Object.assign({}, sent, { stripePaymentLink: 'https://buy.stripe.test/deposit', stripeInvoiceId: 'plink_dep',
      stripeChargeCents: due0.chargeCents, stripeChargeKind: due0.kind, stripeChargePaidCents: 0 });
    // invoiceWebhook payment_intent.succeeded leaves the link fields in place.
    const afterDep = Object.assign({}, depLink, { status: 'partial', amountPaid: 6000, balanceDue: 6000, depositPaid: true });

    ok('context: the $12,000 cash job\'s deposit link charged the $6,000 deposit', due0.kind === 'deposit' && due0.chargeCents === 600000);
    const before = IC.portalBalanceCard(depLink, depLink.stripePaymentLink);
    ok('before the deposit: "Deposit Due $6,000" with the deposit link', before.kind === 'deposit' && before.amountCents === 600000
      && before.stripePaymentLink === 'https://buy.stripe.test/deposit' && before.linkPending === false, JSON.stringify(before));
    const card = IC.portalBalanceCard(afterDep, afterDep.stripePaymentLink);
    ok('after the $6,000 deposit is paid online, "Balance Due $6,000" offers NO Pay Now (was: the spent deposit link)',
      card.kind === 'balance' && card.amountCents === 600000 && card.totalOwedCents === 600000 && card.stripePaymentLink === null, JSON.stringify(card));
    ok('…and says a balance link is on its way (linkPending)', card.linkPending === true);
    const hosted = Object.assign({}, afterDep, { stripePaymentLink: null, stripeHostedUrl: 'https://invoice.stripe.test/i/dep', stripeInvoiceId: 'in_dep' });
    const hc = IC.portalBalanceCard(hosted, KyLaw.payUrlOf(hosted));
    ok('…the paid deposit Stripe INVOICE (hosted page) is not offered either', hc.stripePaymentLink === null && hc.linkPending === true, JSON.stringify(hc));
    const balLink = Object.assign({}, afterDep, { stripePaymentLink: 'https://buy.stripe.test/balance', stripeInvoiceId: 'plink_bal',
      stripeChargeCents: 600000, stripeChargeKind: 'balance', stripeChargePaidCents: 600000 });
    const bc = IC.portalBalanceCard(balLink, balLink.stripePaymentLink);
    ok('once the balance link is minted ($6,000, kind balance, $6,000 paid at the mint), Pay Now is that link',
      bc.stripePaymentLink === 'https://buy.stripe.test/balance' && bc.linkPending === false, JSON.stringify(bc));
    const supAfter = Object.assign({}, balLink, { total: 18000, amountPaid: 12000, balanceDue: 6000, status: 'partial' });
    const sc = IC.portalBalanceCard(supAfter, supAfter.stripePaymentLink);
    ok('a PAID balance link is not offered again when a later change leaves the same $6,000 owed (money landed since the mint)',
      sc.amountCents === 600000 && sc.stripePaymentLink === null && sc.linkPending === true, JSON.stringify(sc));
    const legacyStamp = Object.assign({}, balLink); delete legacyStamp.stripeChargePaidCents;
    ok('a link stamped before stripeChargePaidCents existed still works when kind + cents match',
      IC.portalBalanceCard(legacyStamp, legacyStamp.stripePaymentLink).stripePaymentLink === 'https://buy.stripe.test/balance');
    const legacyDep = Object.assign({}, afterDep); delete legacyDep.stripeChargePaidCents;
    ok('…and the spent deposit link with that older stamp is still refused (kind deposit ≠ balance)',
      IC.portalBalanceCard(legacyDep, legacyDep.stripePaymentLink).stripePaymentLink === null);
    const plain = { total: 1500, depositAmount: 0, amountPaid: 0, balanceDue: 1500, stripePaymentLink: 'https://buy.stripe.test/p' };
    ok('a plain unpaid invoice with a pre-stamp link keeps its Pay Now (unchanged)', IC.portalBalanceCard(plain, plain.stripePaymentLink).stripePaymentLink === 'https://buy.stripe.test/p');
    const noLink = IC.portalBalanceCard(Object.assign({}, afterDep, { stripePaymentLink: null, stripeChargeCents: null, stripeChargeKind: null }), '');
    ok('no link ever sent → no Pay Now and NOT "on its way" (the page says ask your rep)', noLink.stripePaymentLink === null && noLink.linkPending === false);

    // Kentucky insurance hold first.
    const kyLead = { address: KY, state: 'KY', insCarrier: 'State Farm', claimNumber: 'C-1' };
    const kyInv = Object.assign({}, afterDep, { kyInsuranceHold: true, stripeChargeKind: 'balance', stripeChargeCents: 600000, stripeChargePaidCents: 600000 });
    const kyUrl = KyLaw.payUrlUnlessHeld(kyLead, kyInv, Date.now(), KyLaw.DEFAULT_TIME_ZONE);
    const kyCard = IC.portalBalanceCard(kyInv, kyUrl);
    ok('Kentucky insurance job before the carrier decision + 5 business days: no link and no "on its way" promise',
      kyUrl === '' && kyCard.stripePaymentLink === null && kyCard.linkPending === false, JSON.stringify({ kyUrl, kyCard }));
    const released = Object.assign({}, kyLead, { carrierDecisionAt: Date.parse('2026-01-05T15:00:00Z') });
    const rUrl = KyLaw.payUrlUnlessHeld(released, kyInv, Date.now(), KyLaw.DEFAULT_TIME_ZONE);
    ok('…once released, a matching balance link is offered', IC.portalBalanceCard(kyInv, rUrl).stripePaymentLink === kyInv.stripePaymentLink, rUrl);

    // The real portal endpoint: the card AND the tracker's "Pay your invoice".
    portalWorld({ 'invoices/inv-1': afterDep && Object.assign(inv({ status: 'partial', amountPaid: 6000, balanceDue: 6000, depositPaid: true,
      payments: [{ amount: 6000, at: Timestamp.fromMillis(Date.now() - DAY), method: 'stripe', paymentIntentId: 'pi_secret_1' }] }),
      { stripePaymentLink: 'https://buy.stripe.test/deposit', stripeChargeCents: 600000, stripeChargeKind: 'deposit', stripeChargePaidCents: 0 }) },
      { stage: 'final_payment' });
    W.docs['leads/lead-1'].stage = 'collections';
    const r = await openPortal();
    const b = r.body && r.body.balance;
    ok('portal view: Balance Due $6,000 with no Pay Now and linkPending true', r.statusCode === 200 && b && b.kind === 'balance'
      && b.amountCents === 600000 && b.stripePaymentLink === null && b.linkPending === true, JSON.stringify(b));
    ok('…and the tracker carries no "Pay your invoice" link', r.body && r.body.progress && r.body.progress.payLink === null);

    const F = lift(['balancePayActionHtml']);
    ok('docs/pro/js/portal.js has balancePayActionHtml (lifted and run)', !F.missing, F.missing && F.missing.join(','));
    if (!F.missing) {
      const pending = F.balancePayActionHtml({ amountCents: 600000, kind: 'balance', stripePaymentLink: null, linkPending: true });
      ok('a pending balance link reads "Your balance link is on its way" — no button', /Your balance link is on its way/.test(pending) && !/<a /.test(pending), pending);
      const live = F.balancePayActionHtml({ stripePaymentLink: 'https://buy.stripe.test/balance', linkPending: false });
      ok('a real link is the Pay Now button', /<a class="btn[^"]*" href="https:\/\/buy\.stripe\.test\/balance"/.test(live) && /Pay Now/.test(live), live);
      ok('a javascript: link is never a button', !/<a /.test(F.balancePayActionHtml({ stripePaymentLink: 'javascript:alert(1)' })));
      ok('no link sent → "Ask your rep for a payment link" (unchanged)', /Ask your rep for a payment link/.test(F.balancePayActionHtml({ stripePaymentLink: null, linkPending: false })));
    }
    ok('renderView builds the pay line with balancePayActionHtml(view.balance)', /const payAction = balancePayActionHtml\(view\.balance\);/.test(PJS));
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n2. The portal status follows the job after signing (audit M1)');
  // ══════════════════════════════════════════════════════════════════════
  {
    const cases = [
      ['deal-room signed, nothing paid', { stage: 'contract_signed' }, {}, 'signed', '✓ Signed'],
      ['deposit paid', { stage: 'contract_signed' }, { 'invoices/inv-1': inv({ status: 'partial', amountPaid: 6000, balanceDue: 6000, depositPaid: true, payments: [{ amount: 6000, at: Timestamp.fromMillis(Date.now() - DAY), method: 'check' }] }) }, 'deposit_paid', '✓ Deposit paid'],
      ['build day set', { stage: 'crew_scheduled', scheduledDate: '2026-11-02' }, {}, 'scheduled', '✓ Build day set'],
      ['crew working', { stage: 'install_in_progress', scheduledDate: '2026-11-02' }, {}, 'in_progress', 'In progress'],
      ['work complete, final invoice out', { stage: 'final_payment' }, { 'invoices/inv-1': inv({ status: 'partial', amountPaid: 6000, balanceDue: 6000, depositPaid: true }) }, 'complete', '✓ Work complete'],
      ['paid in full', { stage: 'closed' }, { 'invoices/inv-1': inv({ status: 'paid', amountPaid: 12000, balanceDue: 0, depositPaid: true }) }, 'paid_in_full', '✓ Paid in full'],
    ];
    for (const [name, leadOver, extra, key, label] of cases) {
      portalWorld(Object.assign({}, acceptedDeal, extra), leadOver);
      const r = await openPortal();
      const js = r.body && r.body.estimate && r.body.estimate.jobStatus;
      ok('deal-room job, ' + name + ' → status "' + label + '" (never "Sent to you")',
        r.statusCode === 200 && js && js.key === key && js.label === label, JSON.stringify(js));
    }
    // Signed in the deal room, but the stage was never moved (spine skipped):
    // the accepted deal room alone is the signature.
    portalWorld(acceptedDeal, { stage: 'estimate_sent_cash' });
    let r = await openPortal();
    ok('an accepted deal room alone (stage not moved) still reads "✓ Signed", via deal-room',
      r.body.estimate && r.body.estimate.jobStatus && r.body.estimate.jobStatus.key === 'signed' && r.body.estimate.signedVia === 'deal-room',
      JSON.stringify(r.body.estimate));
    // Another tenant's accepted deal room on the same lead id does not count.
    portalWorld({ 'deal_rooms/deal-x': Object.assign({}, acceptedDeal['deal_rooms/deal-1'], { userId: 'intruder', companyId: 'intruder' }) }, { stage: 'estimate_sent_cash' });
    r = await openPortal();
    ok('another company\'s deal room on the lead does not mark it signed', r.body.estimate && r.body.estimate.jobStatus === null, JSON.stringify(r.body.estimate && r.body.estimate.jobStatus));
    // Not signed: the card keeps the old wording.
    portalWorld({}, { stage: 'estimate_sent_cash' });
    r = await openPortal();
    ok('not signed yet → jobStatus null (the card shows "Sent to you" as before)', r.body.estimate && r.body.estimate.jobStatus === null);
    // A re-priced revision out for a new signature keeps "Awaiting signature".
    portalWorld({ 'estimates/est-1': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', grandTotal: 13000, signatureStatus: 'sent', signatureProvider: 'nbd-esign', createdAt: Timestamp.fromMillis(Date.now() - DAY) } }, { stage: 'contract_signed' });
    r = await openPortal();
    ok('a revision out for a new signature → jobStatus null (the card keeps "✍ Awaiting signature")', r.body.estimate && r.body.estimate.jobStatus === null);
    // E-sign path.
    portalWorld({ 'estimates/est-1': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', grandTotal: 12000, signatureStatus: 'signed', createdAt: Timestamp.fromMillis(Date.now() - DAY) } }, { stage: 'contract_signed' });
    r = await openPortal();
    ok('e-signed → "✓ Signed", via esign', r.body.estimate.jobStatus && r.body.estimate.jobStatus.key === 'signed' && r.body.estimate.signedVia === 'esign');

    const F = lift(['jobStatusPill']);
    ok('docs/pro/js/portal.js has jobStatusPill (lifted and run)', !F.missing);
    if (!F.missing) {
      const h = F.jobStatusPill({ key: 'paid_in_full', label: '✓ Paid in full', tone: 'green' });
      ok('the pill renders the label, green', /class="pill pill-green"/.test(h) && />✓ Paid in full</.test(h), h);
      const x = F.jobStatusPill({ key: '"><img src=x onerror=alert(1)>', label: '<b>x</b>\'', tone: 'orange' });
      ok('label and key are escaped (no raw < > " \')', !/<img|<b>|"><|'/.test(x.replace(/class="[^"]*"|data-job-status="[^"]*"/g, '')) && /&lt;b&gt;/.test(x), x);
      ok('null → "" (the signature pill decides)', F.jobStatusPill(null) === '');
    }
    ok('the estimate card reads jobStatusPill(e.jobStatus) before the signature pill',
      /const sig = jobStatusPill\(e\.jobStatus\) \|\| signaturePill\(e\.signatureStatus \|\| 'none'\);/.test(PJS));
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n3. One step list for "N of M done" and "See all M steps" (audit M2)');
  // ══════════════════════════════════════════════════════════════════════
  {
    const hp = HP.resolveHomeownerProgress({ stage: 'closed' }, { invoices: [{ status: 'paid', total: 500, amountPaid: 500, balanceDue: 0 }] });
    ok('context: paid in full, no warranty paperwork → the server counts 8 steps (warranty skipped)', hp.paidInFull && hp.total === 8 && hp.steps.length === 9);
    const F = lift(['_progressSteps', '_visibleProgressSteps']);
    ok('docs/pro/js/portal.js has _visibleProgressSteps (lifted and run)', !F.missing, F.missing && F.missing.join(','));
    if (!F.missing) {
      const steps = F._visibleProgressSteps(F._progressSteps(hp.steps, hp.currentIndex));
      ok('the rendered list, the bar and "See all" use the same 8 steps the count does',
        steps.length === hp.total && !steps.some((s) => s.state === 'skipped'), steps.length + ' vs ' + hp.total);
      const withW = HP.resolveHomeownerProgress({ stage: 'closed', warranty: { tier: 'standard' } }, { invoices: [] });
      ok('with warranty paperwork on file all 9 show and count', F._visibleProgressSteps(F._progressSteps(withW.steps, withW.currentIndex)).length === 9 && withW.total === 9);
    }
    ok('renderView: total = the visible list\'s length, and "See all {total}" fills from it',
      /const steps = _visibleProgressSteps\(_progressSteps\(p\.milestones, idx\)\);\s*const total = steps\.length;/.test(PJS)
        && /_fillCopy\(copy\.showAll \|\| '', \{ total: total \}\)/.test(PJS) && !/\{ total: steps\.length \}/.test(PJS));
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n4. Payments: what was paid, when and how (audit M3)');
  // ══════════════════════════════════════════════════════════════════════
  {
    const invs = [
      inv({ invoiceNumber: 'NBD-1007', status: 'partial', amountPaid: 7350, balanceDue: 4650, payments: [
        { amount: 6850, at: Timestamp.fromMillis(Date.parse('2026-10-07T15:00:00Z')), method: 'stripe', paymentIntentId: 'pi_x', reference: 'secret-ref' },
        { amount: 500.5, at: '2026-10-09', method: 'zelle', note: 'internal note', proofStoragePath: 'proofs/u1/a.jpg' },
        { amount: 100, at: new Date('2026-10-10T12:00:00Z'), method: 'check', reverted: true },
        { amount: 0, method: 'cash' },
      ] }),
      inv({ status: 'draft', payments: [{ amount: 999, at: '2026-10-01', method: 'cash' }] }),
      inv({ status: 'void', payments: [{ amount: 999, at: '2026-10-01', method: 'cash' }] }),
    ];
    const pays = PAS ? PAS.paymentsFor(invs) : [];
    ok('two real payments listed (reverted, $0, draft and void invoices skipped)', pays.length === 2, JSON.stringify(pays));
    ok('amounts in cents: $6,850.00 and $500.50', pays[0] && pays[0].amountCents === 685000 && pays[1] && pays[1].amountCents === 50050);
    ok('methods in homeowner words: "Card (online)", "Zelle"', pays[0] && pays[0].method === 'Card (online)' && pays[1].method === 'Zelle');
    ok('dates: the Timestamp as ISO; a bare day pinned to noon (no timezone shift)', pays[0] && pays[0].date === '2026-10-07T15:00:00.000Z' && pays[1].date === '2026-10-09T12:00:00');
    ok('redacted: no processor ids, references, notes or proof paths reach the homeowner',
      !/pi_x|secret-ref|internal note|proofs\//.test(JSON.stringify(pays)));
    const sum = PAS && PAS.paidSummaryFor(invs);
    ok('total paid $7,350.50', sum && sum.totalPaidCents === 735050);
    ok('nothing paid → null (no card)', PAS && PAS.paidSummaryFor([inv()]) === null);

    portalWorld(Object.assign({ 'invoices/inv-1': invs[0] }, acceptedDeal), { stage: 'contract_signed' });
    const r = await openPortal();
    ok('portal view carries paid { payments, totalPaidCents }', r.body && r.body.paid && r.body.paid.totalPaidCents === 735050 && r.body.paid.payments.length === 2,
      JSON.stringify(r.body && r.body.paid));
    ok('…redacted in the view too', !/pi_x|secret-ref|internal note|proofs\//.test(JSON.stringify(r.body.paid)));

    const F = lift(['_milestoneDateLabel', 'paidSoFarCents', 'fmtCents', 'paymentsCardHtml']);
    ok('docs/pro/js/portal.js has paymentsCardHtml (lifted and run)', !F.missing, F.missing && F.missing.join(','));
    if (!F.missing) {
      const h = F.paymentsCardHtml(r.body.paid);
      ok('the Payments card lists each payment and the total ($7,350.50 paid)', /\$7,350\.50 paid/.test(h) && /\$6,850\.00/.test(h) && /\$500\.50/.test(h) && /Card \(online\)/.test(h) && /Zelle/.test(h), h);
      const x = F.paymentsCardHtml({ totalPaidCents: 100, payments: [{ amountCents: 100, method: '<img src=x onerror=a(1)>"\'', invoiceNumber: '"><script>' }] });
      ok('method and invoice number are escaped', !/<img|<script/.test(x) && x.includes('&lt;img src=x onerror=a(1)&gt;&quot;&#39;') && x.includes('Invoice &quot;&gt;&lt;script&gt;'), x);
      ok('nothing paid → no card', F.paymentsCardHtml(null) === '' && F.paymentsCardHtml({ payments: [] }) === '');
    }
    ok('the estimate card says "Paid so far" once money landed (not the stale "Due at signing")',
      /paidSoFarCents\(view\.paid\) > 0 \? 'Paid so far'/.test(PJS));
    ok('renderView adds the Payments card', /const paidHtml = paymentsCardHtml\(view\.paid\);/.test(PJS));
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n5. One signature per job: the deal link refuses once signed (audit M5)');
  // ══════════════════════════════════════════════════════════════════════
  {
    const dealWorld = (est, extra) => {
      resetWorld(Object.assign({
        'leads/lead-1': { userId: 'u1', companyId: 'u1', firstName: 'Sam', lastName: 'Smith', address: OH, stage: 'final_payment' },
        'estimates/est-1': Object.assign({ userId: 'u1', companyId: 'u1', leadId: 'lead-1', grandTotal: 13675, subtotal: 13675, tax: 0 }, est || {}),
        'deal_accept_tokens/DEALTOKEN1234567890ABCD': { dealId: 'deal-123456', leadId: 'lead-1', ownerUid: 'u1', companyId: 'u1', status: 'pending',
          htmlPath: 'deal_rooms/u1/deal-123456.html', estimateId: 'est-1', tierPrices: { economy: 0, good: 0, better: 13675, best: 0, beyond: 0 },
          expiresAt: Timestamp.fromMillis(Date.now() + DAY) },
        'deal_rooms/deal-123456': { userId: 'u1', companyId: 'u1', leadId: 'lead-1', estimateId: 'est-1', status: 'viewed', customerName: 'Sam Smith', viewCount: 1 },
        'portal_tokens/PORTALTOKEN1234567890AB': { leadId: 'lead-1', ownerUid: 'u1', companyId: 'u1', expiresAt: Timestamp.fromMillis(Date.now() + 30 * DAY), uses: 2, maxUses: 100 },
      }, extra || {}));
      W.objects['deal_rooms/u1/deal-123456.html'] = { meta: { contentType: 'text/html' }, body: '<html><head></head><body>deal</body></html>' };
    };
    const open = async () => { const res = mkRes(); await DEAL.getDealRoom(mkReq({ method: 'GET', path: '/deal/DEALTOKEN1234567890ABCD' }), res); await flush(); return res; };
    const accept = async () => { const res = mkRes(); await DEAL.submitDealAcceptance(mkReq({ body: { token: 'DEALTOKEN1234567890ABCD', tier: 'better', signature: SIG, consent: true } }), res); await flush(); return res; };

    dealWorld({ signatureStatus: 'signed', signatureProvider: 'nbd-esign' });
    let res = await open();
    ok('e-signed (and paid) job: the deal link answers 410, not the signable page', res.statusCode === 410, res.statusCode + ' ' + String(res.body).slice(0, 160));
    ok('…with a clear message', /already signed, so there is nothing more to sign here/.test(String(res.body)));
    ok('…and a button to the homeowner\'s existing portal link', /href="https:\/\/nobigdealwithjoedeal\.com\/pro\/portal\.html\?token=PORTALTOKEN1234567890AB"/.test(String(res.body)), String(res.body).slice(-400));
    ok('…and opening it did NOT regress the deal to "viewed"/count a view', W.docs['deal_rooms/deal-123456'].viewCount === 1);
    res = await accept();
    ok('submitting a signature anyway → 410 { code: already_signed }', res.statusCode === 410 && res.body && res.body.code === 'already_signed', JSON.stringify(res.body));
    ok('…the deal is not accepted and the token is not burned', W.docs['deal_rooms/deal-123456'].status === 'viewed' && !W.docs['deal_rooms/deal-123456'].acceptedSignature
      && W.docs['deal_accept_tokens/DEALTOKEN1234567890ABCD'].status === 'pending');

    // Signed in a sibling deal room: the spine stamped signedPrice.
    const fields = CER.signedPriceSnapshot(W.docs['estimates/est-1']);
    dealWorld({ signedPrice: { fields, fingerprint: CER.pricedFingerprint(fields), totalCents: 1367500, source: 'deal_accepted', sourceId: 'deal_other' } });
    delete W.docs['portal_tokens/PORTALTOKEN1234567890AB'];
    res = await open();
    ok('signed through another deal room (signedPrice stamped): refused too', res.statusCode === 410);
    ok('…no live portal link → "Your rep can send you a link", and no link at all', /Your rep can send you a link/.test(String(res.body)) && !/portal\.html\?token=/.test(String(res.body)));

    // Re-priced after signing: a new deal room to RE-sign stays open (R6-2-2).
    const oldFields = Object.assign({}, fields, { grandTotal: 12000, subtotal: 12000 });
    dealWorld({ signedPrice: { fields: oldFields, fingerprint: CER.pricedFingerprint(oldFields), totalCents: 1200000, source: 'deal_accepted', sourceId: 'deal_old' } });
    res = await open();
    ok('signed, then re-priced (a revision to re-sign): the deal page still loads (200)', res.statusCode === 200, res.statusCode + ' ' + String(res.body).slice(0, 120));

    dealWorld({});
    res = await open();
    ok('not signed: the deal page loads as before (200)', res.statusCode === 200);
    res = await accept();
    ok('…and accepts a signature (200)', res.statusCode === 200 && W.docs['deal_rooms/deal-123456'].status === 'accepted', JSON.stringify(res.body));

    dealWorld({ signatureStatus: 'signed', userId: 'someone-else', companyId: 'someone-else' });
    res = await open();
    ok('another company\'s estimate id on the token never refuses (tenant check)', res.statusCode === 200);

    // portalUrlFor: only a live token for THIS lead + owner.
    if (PAS) {
      const now = Date.now();
      const rows = [
        { id: 'EXPIREDTOKEN000000000AA', leadId: 'lead-1', ownerUid: 'u1', expiresAtMs: now - 1 },
        { id: 'OTHEROWNERTOKEN0000000A', leadId: 'lead-1', ownerUid: 'u2', expiresAtMs: now + DAY },
        { id: 'USEDUPTOKEN00000000000A', leadId: 'lead-1', ownerUid: 'u1', expiresAtMs: now + DAY, uses: 100, maxUses: 100 },
        { id: 'bad/token', leadId: 'lead-1', ownerUid: 'u1', expiresAtMs: now + DAY },
      ];
      ok('portalUrlFor: expired / other owner / used up / malformed tokens are never handed out', PAS.portalUrlFor(rows, 'lead-1', 'u1', now) === null);
      ok('…a live one is', PAS.portalUrlFor(rows.concat([{ id: 'LIVETOKEN0000000000000A', leadId: 'lead-1', ownerUid: 'u1', expiresAtMs: now + DAY, uses: 1, maxUses: 100 }]), 'lead-1', 'u1', now)
        === 'https://nobigdealwithjoedeal.com/pro/portal.html?token=LIVETOKEN0000000000000A');
    }
  }

  // Nothing leaves the building: global fetch throws (no email / SMS API),
  // and the only pushes are the rep's own in-app deal-view bells (a spy).
  ok('the only notifications were the rep\'s own in-app bells (no homeowner send)', W.pushes.every((x) => x.uid === 'u1'));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
