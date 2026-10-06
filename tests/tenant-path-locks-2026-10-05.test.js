/**
 * tests/tenant-path-locks-2026-10-05.test.js
 *
 * Server side of the 2026-10-05 security review "file / path locks" (fixes
 * approved by Jo). The flat collections /photos and /invoices name their lead
 * by a client-written leadId FIELD, and a photo's path is client-written too.
 * Before this:
 *
 *   A. the customer portal re-signed (7-day link) the `path` of ANY photo
 *      doc marked source:'homeowner' — a rep could plant one naming any
 *      object in the bucket and read it through their own portal;
 *   B. the invoice photo plate (money-paper.js plateFor) took any photo
 *      naming the lead and signed its path;
 *   C. a paid invoice from ANOTHER tenant naming a lead filed a "paid in full
 *      — not closed" task (and NBD-500/510 paper) onto that lead;
 *   D. another tenant's invoice naming a lead blocked that lead's deposit
 *      draft (deposit-draft-logic) and froze its accepted-tier deposit
 *      (deal-accepted-tier) as if the money were the customer's.
 *
 * Runs the shipped code (real modules, in-memory Firestore/bucket). Zero
 * network. Run: node tests/tenant-path-locks-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

// money-paper.js loads firebase modules at require time.
const FieldValue = { serverTimestamp: () => ({ __ts: true }) };
const stubs = {
  'firebase-functions/v2/firestore': { onDocumentWritten: (o, fn) => fn },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => null, FieldValue },
  'firebase-admin/storage': { getStorage: () => null },
};
const origLoad = Module._load;
Module._load = function (req) { if (stubs[req]) return stubs[req]; return origLoad.apply(this, arguments); };
const LAP = require(path.join(FN, 'lead-artifact-paths.js'));
const MP = require(path.join(FN, 'money-paper.js'));
const D = require(path.join(FN, 'deposit-draft-logic.js'));
const T = require(path.join(FN, 'deal-accepted-tier.js'));
const DR = require(path.join(FN, 'deposit-rule.js'));
Module._load = origLoad;

// ── tiny in-memory Firestore (money-paper shape) ──────────────────────────
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  const ref = (p) => ({
    id: p.split('/').pop(), path: p,
    async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))) }; },
    async set(d) { store.set(p, JSON.parse(JSON.stringify(d))); },
    async update(d) { store.set(p, Object.assign(store.get(p) || {}, d)); },
    collection: (c) => col(p + '/' + c),
  });
  const col = (c) => ({
    doc: (id) => ref(c + '/' + id),
    where: (field, op, val) => ({ limit: () => ({ async get() {
      const docs = [];
      for (const [k, v] of store) {
        if (k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1 && v[field] === val) docs.push({ id: k.split('/').pop(), data: () => JSON.parse(JSON.stringify(v)) });
      }
      return { docs };
    } }) }),
  });
  return { store, collection: col, doc: ref };
}
function makeBucket() {
  const signed = [];
  return { signed, file: (p) => ({ async getSignedUrl() { signed.push(p); return ['https://storage.example/' + p + '?sig=1']; } }) };
}

(async () => {
  // ════════════════════════════════════════════════════════════════════
  section('0. path helpers (functions/lead-artifact-paths.js)');
  // ════════════════════════════════════════════════════════════════════
  const H = LAP.isHomeownerUploadPathFor, O = LAP.isOwnerPhotoPath;
  ok('helpers exported', typeof H === 'function' && typeof O === 'function');
  if (typeof H === 'function' && typeof O === 'function') {
    ok('homeowner upload for this owner + lead → yes', H('homeowner-uploads/U1/L1/1700000000000.jpg', 'U1', 'L1'));
    ok('…another owner → no', !H('homeowner-uploads/U2/L1/1.jpg', 'U1', 'L1'));
    ok('…another lead → no', !H('homeowner-uploads/U1/L2/1.jpg', 'U1', 'L1'));
    ok('…another prefix (a contract, a photo) → no', !H('documents/U1/L1/d.html', 'U1', 'L1') && !H('photos/U1/L1/1.jpg', 'U1', 'L1'));
    ok('…traversal / nesting / backslash → no', !H('homeowner-uploads/U1/L1/../../x', 'U1', 'L1') && !H('homeowner-uploads/U1/L1/a/b.jpg', 'U1', 'L1') && !H('homeowner-uploads\\U1\\L1\\a.jpg', 'U1', 'L1'));
    ok('…missing owner / lead → no', !H('homeowner-uploads/U1/L1/1.jpg', undefined, 'L1') && !H('homeowner-uploads//L1/1.jpg', '', 'L1'));
    ok('owner photo prefix → yes (nested lead folders too)', O('photos/U1/L1/1_a.jpg', 'U1') && O('photos/U1/1_a.jpg', 'U1'));
    ok('…another uid / another prefix / traversal → no', !O('photos/U2/L1/1.jpg', 'U1') && !O('homeowner-uploads/U1/L1/1.jpg', 'U1') && !O('photos/U1/../U2/1.jpg', 'U1') && !O('photos/U1/', 'U1'));
  }

  // ════════════════════════════════════════════════════════════════════
  section('A. portal _refreshHomeownerPhotoUrls signs only the token\'s own homeowner-upload prefix');
  // ════════════════════════════════════════════════════════════════════
  {
    const SRC = fs.readFileSync(path.join(FN, 'portal.js'), 'utf8');
    const grab = (name) => {
      const at = SRC.indexOf('function ' + name + '(');
      if (at < 0) return null;
      const open = SRC.indexOf('{', at); let depth = 0;
      for (let i = open; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}' && --depth === 0) return SRC.slice(SRC.lastIndexOf('\n', at) + 1, i + 1); }
      return null;
    };
    const consts = (SRC.match(/^const HOMEOWNER_URL_(TTL|RENEW)_MS = [^\n]+$/gm) || []).join('\n');
    const signed = [];
    const sb = {
      console, isHomeownerUploadPathFor: LAP.isHomeownerUploadPathFor,
      logger: { warn() {} },
      getStorage: () => ({ bucket: () => ({ file: (p) => ({ async getSignedUrl() { signed.push(p); return ['https://signed/' + p]; } }) }) }),
    };
    vm.createContext(sb);
    vm.runInContext(consts + '\n' + grab('_homeownerUrlIsStale') + '\n' + grab('_refreshHomeownerPhotoUrls') + '\nthis.refresh = _refreshHomeownerPhotoUrls;', sb);
    const docOf = (id, p) => ({ id, data: () => p, ref: { update: async () => {} } });
    const tok = { ownerUid: 'U1', leadId: 'L1' };
    const docs = [
      docOf('good', { source: 'homeowner', path: 'homeowner-uploads/U1/L1/1.jpg', urlExpiresAt: 0 }),
      docOf('victim-contract', { source: 'homeowner', path: 'documents/VICTIM/LV/contract.html', urlExpiresAt: 0 }),
      docOf('victim-photo', { source: 'homeowner', path: 'photos/VICTIM/LV/1.jpg', urlExpiresAt: 0 }),
      docOf('other-lead', { source: 'homeowner', path: 'homeowner-uploads/U1/L-OTHER/1.jpg', urlExpiresAt: 0 }),
      docOf('other-owner', { source: 'homeowner', path: 'homeowner-uploads/VICTIM/L1/1.jpg', urlExpiresAt: 0 }),
    ];
    const fresh = await sb.refresh(docs, Date.now(), tok);
    ok('the real homeowner upload is still re-signed', fresh.has('good') && signed.indexOf('homeowner-uploads/U1/L1/1.jpg') !== -1, JSON.stringify(signed));
    ok('another tenant\'s contract named by a planted photo doc is NOT signed', !fresh.has('victim-contract') && signed.indexOf('documents/VICTIM/LV/contract.html') === -1);
    ok('another tenant\'s photo object is NOT signed', !fresh.has('victim-photo'));
    ok('another lead\'s / another owner\'s homeowner upload is NOT signed', !fresh.has('other-lead') && !fresh.has('other-owner'));
    ok('exactly one object was signed', signed.length === 1, JSON.stringify(signed));
    ok('getHomeownerPortalView passes the token in', /_refreshHomeownerPhotoUrls\(photoSnap\.docs, Date\.now\(\), tok\)/.test(SRC.replace(/\/\/[^\n]*/g, '')));
  }

  // ════════════════════════════════════════════════════════════════════
  section('B. invoice photo plate (money-paper.js plateFor)');
  // ════════════════════════════════════════════════════════════════════
  {
    const plateFor = MP._internal && MP._internal.plateFor;
    ok('plateFor is exposed for tests', typeof plateFor === 'function');
    if (typeof plateFor === 'function') {
      const LEAD = { userId: 'U1', companyId: 'C1', coverPhotoId: null };
      const t = (n) => ({ _seconds: n, toMillis: () => n });
      const photo = (o) => Object.assign({ leadId: 'L1', phase: 'After', userId: 'U1', companyId: 'C1' }, o);
      async function plate(photos, lead) {
        const seed = {}; photos.forEach((p, i) => { seed['photos/p' + i] = p; });
        const db = makeDb(seed); const bucket = makeBucket();
        const r = await plateFor(db, bucket, lead || LEAD, 'L1');
        return { r, signed: bucket.signed };
      }
      const a = await plate([photo({ storagePath: 'photos/U1/L1/after.jpg', createdAt: 5 })]);
      ok('the lead owner\'s own After photo → signed plate', a.r && a.signed[0] === 'photos/U1/L1/after.jpg', JSON.stringify(a));
      const b = await plate([photo({ userId: 'STRANGER', companyId: 'C-OTHER', storagePath: 'photos/U1/L1/after.jpg' })]);
      ok('a stranger\'s photo doc naming this lead is ignored', !b.r && b.signed.length === 0, JSON.stringify(b));
      const c = await plate([photo({ storagePath: 'documents/VICTIM/LV/contract.html' })]);
      ok('a tenant photo whose path is outside photos/{lead owner}/ is never signed', !c.r && c.signed.length === 0, JSON.stringify(c));
      const d = await plate([photo({ path: 'photos/VICTIM/LV/1.jpg' })]);
      ok('…another uid\'s photos/ prefix is never signed', !d.r && d.signed.length === 0, JSON.stringify(d));
      const e = await plate([photo({ userId: 'U2', storagePath: 'photos/U1/L1/team.jpg' })]);
      ok('a same-company teammate\'s photo (in the owner prefix) still plates', e.r && e.signed[0] === 'photos/U1/L1/team.jpg', JSON.stringify(e));
      void t;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  section('C. "paid in full — not closed" task skips another tenant\'s invoice');
  // ════════════════════════════════════════════════════════════════════
  {
    const flag = MP._internal.flagPaidNotClosed;
    const paidInv = (o) => Object.assign({ leadId: 'L1', status: 'paid', total: 500, balanceDue: 0, amountPaid: 500, payments: [{ method: 'zelle', amount: 500 }] }, o);
    const deps = (db) => ({ db, now: () => Date.parse('2026-10-05T15:00:00Z') });
    const seedLead = { 'leads/L1': { userId: 'U1', companyId: 'C1', stage: 'contract_signed', firstName: 'Pat' } };
    const db1 = makeDb(seedLead);
    const own = await flag(deps(db1), 'INV1', paidInv({ companyId: 'C1' }));
    ok('the lead\'s own tenant\'s paid invoice files the task', !!own && [...db1.store.keys()].some((k) => k.startsWith('leads/L1/tasks/')), String(own));
    const db2 = makeDb(seedLead);
    const xt = await flag(deps(db2), 'INV2', paidInv({ companyId: 'C-OTHER' }));
    ok('another tenant\'s paid invoice naming the lead files NOTHING', xt === null && ![...db2.store.keys()].some((k) => k.startsWith('leads/L1/tasks/')), String(xt));
    const db3 = makeDb(seedLead);
    const legacy = await flag(deps(db3), 'INV3', paidInv({}));
    ok('a legacy invoice with no companyId is still judged by its leadId (unchanged)', !!legacy, String(legacy));
  }

  // ════════════════════════════════════════════════════════════════════
  section('C2. money paper (NBD-500) is never filed onto another tenant\'s lead');
  // ════════════════════════════════════════════════════════════════════
  {
    const OWNER = MP._internal.OWNER;
    async function file(leadId, lead) {
      const db = makeDb({
        ['leads/' + leadId]: lead,
        'invoices/INVX': { leadId, companyId: OWNER, userId: OWNER, total: 250, amountPaid: 0, balanceDue: 250, status: 'sent', payments: [],
          stripeInvoiceId: 'in_1AbCdEf', stripeHostedUrl: 'https://invoice.stripe.com/i/acct_x/test_abc', lineItems: [{ description: 'x', qty: 1, rate: 250 }] },
      });
      db.runTransaction = async (fn) => fn({ get: (r) => r.get(), set: (r, d) => r.set(d), update: (r, p) => {
        const cur = db.store.get(r.path) || {};
        for (const [k, v] of Object.entries(p)) { const parts = k.split('.'); let o = cur; for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; } o[parts[parts.length - 1]] = v; }
        db.store.set(r.path, cur);
      } });
      const saved = [], rendered = [];
      const bucket = { file: (p) => ({ async save() { saved.push(p); }, async getSignedUrl() { return ['x']; } }) };
      const inv = (await db.collection('invoices').doc('INVX').get()).data();
      await MP._internal.handle('INVX', inv, { db, bucket, stripe: () => ({}), qr: async () => null,
        recordJobEvent: async () => null, writePaymentTimeline: async () => null,
        render: async (k) => { rendered.push(k); return Buffer.from('%PDF'); }, now: () => Date.parse('2026-10-05T15:00:00Z') }, null);
      return { rendered, saved, docs: [...db.store.keys()].filter((k) => k.startsWith('leads/' + leadId + '/documents/')) };
    }
    const own = await file('LN', { userId: OWNER, companyId: OWNER, firstName: 'Pat', address: '1 Test Ln' });
    ok('control: an NBD invoice on an NBD lead files its NBD-500', own.rendered.length === 1 && own.docs.length === 1, JSON.stringify(own));
    const xt = await file('LV', { userId: 'VICTIM', companyId: 'C-VICTIM', firstName: 'Vic', address: '1 Victim Rd' });
    ok('an NBD invoice naming another tenant\'s lead renders and files nothing there',
      xt.rendered.length === 0 && xt.saved.length === 0 && xt.docs.length === 0, JSON.stringify(xt));
  }

  // ════════════════════════════════════════════════════════════════════
  section('D1. deposit draft — another tenant\'s invoice does not block the draft');
  // ════════════════════════════════════════════════════════════════════
  {
    const lead = { userId: 'u1', companyId: 'u1', stage: 'estimate_sent_cash', firstName: 'Pat', lastName: 'Jones', email: 'pat@x.test', phone: '555', address: '123 Main St, Cincinnati, OH 45202' };
    const est = { leadId: 'L1', userId: 'u1', priceMode: 'per-sq', prices: { good: 12000, better: 15000, best: 18000 }, selectedTier: 'better', grandTotal: 15000, taxRate: 0, mode: 'cash' };
    const decide = (existingInvoices) => D.decideDepositDraft({ leadId: 'L1', event: 'contract_signed', sourceId: 'doc_d1', estimateId: 'E1', nowMs: Date.parse('2026-10-03T15:00:00Z'), lead, est, existingInvoices });
    ok('control: no invoices → draft', decide([]).action === 'create');
    ok('the tenant\'s own open invoice still blocks a second one', decide([{ id: 'i1', status: 'sent', total: 15000, companyId: 'u1' }]).reason === 'invoice_exists');
    ok('a legacy invoice (no companyId) still blocks, as before', decide([{ id: 'i1', status: 'sent', total: 15000 }]).reason === 'invoice_exists');
    const xt = decide([{ id: 'i9', status: 'sent', total: 1, companyId: 'C-OTHER' }]);
    ok('ANOTHER tenant\'s invoice naming this lead does not block the draft', xt.action === 'create', JSON.stringify(xt).slice(0, 160));
  }

  // ════════════════════════════════════════════════════════════════════
  section('D2. deal accepted tier — another tenant\'s "paid" invoice does not freeze the deposit');
  // ════════════════════════════════════════════════════════════════════
  {
    function fakeDb(docs) {
      const store = JSON.parse(JSON.stringify(docs));
      const snap = (p) => ({ exists: p in store, data: () => JSON.parse(JSON.stringify(store[p])) });
      const query = (q) => ({ docs: Object.keys(store).filter((p) => p.indexOf(q.name + '/') === 0 && store[p][q.field] === q.value)
        .map((p) => ({ id: p.slice(q.name.length + 1), data: () => JSON.parse(JSON.stringify(store[p])) })) });
      return {
        store,
        doc: (p) => ({ path: p }),
        collection: (name) => ({ where: (field, op, value) => ({ _q: { name, field, value } }) }),
        runTransaction: async (fn) => {
          const pending = [];
          const r = await fn({ get: async (ref) => (ref._q ? query(ref._q) : snap(ref.path)), update: (ref, data) => pending.push([ref.path, data]) });
          pending.forEach(([p, d]) => { store[p] = Object.assign({}, store[p], d); });
          return r;
        },
      };
    }
    const cashEst = () => ({ userId: 'u1', leadId: 'L1', grandTotal: 10000, subtotal: 9300, tax: 700, taxRate: 0.07527, deposit: 5000,
      depositPlan: DR.toStored(DR.compute({ total: 10000, mode: 'cash' })) });
    const run = async (extra) => {
      const db = fakeDb(Object.assign({ 'leads/L1': { userId: 'u1', companyId: 'u1', primaryEstimateId: 'E1' }, 'deal_rooms/D1': { estimateId: 'E1' }, 'estimates/E1': cashEst() }, extra));
      await T.applyAcceptedTier(db, { dealId: 'D1', leadId: 'L1', ownerUid: 'u1' }, 'best', 15000, { now: () => new Date('2026-10-03T16:00:00Z') });
      return db.store['estimates/E1'];
    };
    const own = await run({ 'invoices/I1': { leadId: 'L1', estimateId: 'E1', companyId: 'u1', status: 'partial', depositPaid: true, amountPaid: 5000 } });
    ok('control: the tenant\'s own paid deposit keeps the deposit', own.deposit === 5000 && own.acceptedTierDepositKept === true, JSON.stringify([own.deposit, own.acceptedTierDepositKept]));
    const xt = await run({ 'invoices/I9': { leadId: 'L1', estimateId: 'E1', companyId: 'C-OTHER', status: 'paid', amountPaid: 1 } });
    ok('ANOTHER tenant\'s paid invoice naming the lead does not freeze it ($7,500 at the new tier)', xt.deposit === 7500 && xt.acceptedTierDepositKept === false, JSON.stringify([xt.deposit, xt.acceptedTierDepositKept]));
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); for (const f of fails) console.log('  - ' + f); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
