/**
 * tests/sweep-lows-server-2026-11-17.test.js — the 2026-11-17 sweep's server
 * lows, each driven through the REAL code (Module._load stubs or a vm), not
 * its source text:
 *
 *   #10 stripeWebhook and invoiceWebhook shared one stripe_events/{event.id}
 *       idempotency marker: the same evt_ id delivered to both endpoints ran
 *       only the first, and a failed invoiceWebhook deleted the other's
 *       marker. invoiceWebhook now keys its own marker.
 *   #11 Thursday's call extraction called Anthropic with no kill switch: it now
 *       honours feature_flags/global aiDisabled and thursdayExtractDisabled.
 *   #12 the measurement-ready task's dueDate was the server's (UTC) day: a
 *       result after 8 PM EDT / 7 PM EST was due tomorrow. Now the ET day.
 *   #13 getAdminAnalytics with a company_admin token and no companyId ran the
 *       GLOBAL (all-tenant) queries. It now fails closed.
 *   #18 the /inspect thank-you screen said the answers were on the request
 *       even when the CRM card never got them (crm:false). The server now
 *       logs + marks the public doc, and the page says so honestly.
 *
 * Run: node tests/sweep-lows-server-2026-11-17.test.js
 */
'use strict';
// Cloud Functions run in UTC; #12 only shows up there.
process.env.TZ = 'UTC';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const fnRequire = createRequire(path.join(FN, 'package.json'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

class HttpsError extends Error { constructor(code, message) { super(message || code); this.code = code; } }
const quietLogger = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

function loadWith(file, stubs) {
  const real = Module._load;
  const hook = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.apply(this, arguments);
  };
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN) && !k.includes('node_modules')) delete require.cache[k];
  }
  Module._load = hook;
  let mod;
  try { mod = require(path.join(FN, file)); } finally { Module._load = real; }
  return { mod, run: async (fn) => { Module._load = hook; try { return await fn(); } finally { Module._load = real; } } };
}

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, send(b) { this.body = b; return this; } };
}

(async () => {
  // ── #10 ───────────────────────────────────────────────────────────────────
  console.log('\n#10 stripeWebhook + invoiceWebhook on the same event id');
  {
    const docs = new Map();
    const log = [];
    const docRef = (p) => ({
      path: p,
      create: async (d) => { if (docs.has(p)) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; } docs.set(p, d); },
      delete: async () => { docs.delete(p); log.push('delete:' + p); },
      get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }),
      set: async (d) => { docs.set(p, d); },
      update: async () => {},
    });
    const query = (name) => {
      const q = {
        where: () => q, limit: () => q, orderBy: () => q,
        get: async () => (name === 'subscriptions'
          ? { empty: false, docs: [{ id: 'u1', data: () => ({}), ref: { update: async () => { log.push('usage-reset'); } } }] }
          : { empty: true, docs: [], forEach() {} }),
      };
      return q;
    };
    const db = {
      doc: docRef,
      collection: (name) => Object.assign(query(name), { doc: (id) => docRef(name + '/' + id) }),
      runTransaction: async (fn) => fn({ get: (r) => r.get(), update: () => {}, set: () => {} }),
    };
    let ledgerThrows = false;
    const stubs = {
      'firebase-functions/v2/https': { onRequest: (o, h) => ({ __handler: h }), onCall: (o, h) => ({ __handler: h }), HttpsError },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => (n === 'STRIPE_SECRET_KEY' ? 'sk_test_x' : /WEBHOOK_SECRET/.test(n) ? 'whsec_test' : '') }) },
      'firebase-functions/v2': { logger: quietLogger },
      'firebase-admin/firestore': {
        getFirestore: () => db,
        FieldValue: { serverTimestamp: () => '__ts__', increment: (n) => ({ __inc: n }), delete: () => '__del__', arrayUnion: (...a) => ({ __union: a }) },
        Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) },
      },
      'firebase-admin/auth': { getAuth: () => ({}) },
      stripe: function Stripe() { return { webhooks: { constructEvent: (raw) => JSON.parse(raw.toString('utf8')) } }; },
      './stripe-ledger': { onEvent: async () => { log.push('ledger'); if (ledgerThrows) throw new Error('ledger blip'); } },
      './ach-payments': { handleAchEvent: async () => ({}) },
      './integrations/upstash-ratelimit': { httpRateLimit: async () => true, enforceRateLimit: async () => ({ allowed: true }) },
    };
    const S = loadWith('stripe.js', stubs);
    const deliver = (fnName, event) => S.run(async () => {
      const res = fakeRes();
      await S.mod[fnName].__handler({ method: 'POST', headers: { 'stripe-signature': 't=1,v1=x' }, rawBody: Buffer.from(JSON.stringify(event)) }, res);
      return res;
    });
    const evt = (id) => ({ id, type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_1', billing_reason: 'subscription_cycle', metadata: {} } } });

    const a = await deliver('stripeWebhook', evt('evt_shared_1'));
    const b = await deliver('invoiceWebhook', evt('evt_shared_1'));
    ok('stripeWebhook ran (usage reset)', a.statusCode === 200 && log.includes('usage-reset'), { a: a.body, log });
    ok('invoiceWebhook ALSO ran on the same event id (ledger booked, not a duplicate)', b.statusCode === 200 && !(b.body && b.body.duplicate) && log.includes('ledger'), { b: b.body, log });
    ok('stripeWebhook keeps stripe_events/{event.id}', docs.has('stripe_events/evt_shared_1'));

    log.length = 0;
    const c = await deliver('invoiceWebhook', evt('evt_shared_1'));
    ok('control: a redelivery to invoiceWebhook is still a duplicate (no second ledger run)', c.body && c.body.duplicate === true && !log.includes('ledger'), { c: c.body, log });

    // A failed invoiceWebhook must release ITS marker only.
    log.length = 0;
    await deliver('stripeWebhook', evt('evt_shared_2'));
    ledgerThrows = true;
    const d = await deliver('invoiceWebhook', evt('evt_shared_2'));
    ledgerThrows = false;
    ok('a failing invoiceWebhook answers 500', d.statusCode === 500, d);
    ok('...and leaves stripeWebhook\'s marker alone', docs.has('stripe_events/evt_shared_2'), [...docs.keys()]);
    log.length = 0;
    const e = await deliver('invoiceWebhook', evt('evt_shared_2'));
    ok('...while its own marker was released, so Stripe\'s retry re-processes', e.statusCode === 200 && !(e.body && e.body.duplicate) && log.includes('ledger'), { e: e.body, log });
  }

  // ── #11 ───────────────────────────────────────────────────────────────────
  console.log('\n#11 Thursday extraction honours the AI kill switches');
  {
    process.env.ANTHROPIC_API_KEY = 'sk-' + 'ant-test-key';
    for (const k of Object.keys(require.cache)) {
      if (k.startsWith(FN) && !k.includes('node_modules')) delete require.cache[k];
    }
    const THU = require(path.join(FN, 'integrations', 'thursday.js'));
    const KS = require(path.join(FN, 'integrations', 'killswitch.js'));
    const extract = THU._test && THU._test.extract;
    ok('extract is reachable through the _test seam', typeof extract === 'function');
    const fetches = [];
    const realFetch = global.fetch;
    global.fetch = async (url) => { fetches.push(String(url)); return { ok: false, status: 500, json: async () => ({ error: { message: 'stubbed' } }) }; };
    const realGetFlags = KS.getFlags;
    const call = { callId: 'c1', transcript: 'the storm took shingles off the back of my roof '.repeat(10) };
    const tryExtract = async (flags) => {
      KS.getFlags = async () => flags;
      fetches.length = 0;
      try { await extract(call); return { err: null }; } catch (e) { return { err: e }; }
    };
    if (typeof extract === 'function') {
      let r = await tryExtract({ aiDisabled: true });
      ok('aiDisabled → no Anthropic call', fetches.length === 0, fetches);
      ok('...and the extraction fails (the call still reaches Jo through the failure path)', r.err && r.err.code === 'ai-disabled', r.err && r.err.code);
      r = await tryExtract({ thursdayExtractDisabled: true });
      ok('thursdayExtractDisabled → no Anthropic call', fetches.length === 0 && r.err && r.err.code === 'ai-disabled', { fetches, code: r.err && r.err.code });
      // 2026-11-25: extract also runs the one AI gate (functions/ai-gate.js), which
      // reads Firestore; for this control the gate says yes and a throwaway app
      // stands in for Firestore (nothing is read from it).
      const AG = require(path.join(FN, 'ai-gate.js'));
      const realGate = AG.aiGate;
      const FA = require(require.resolve('firebase-admin/app', { paths: [FN] }));
      const tmpApp = FA.getApps().length ? null : FA.initializeApp({ projectId: 'demo-sweep-lows' });
      AG.aiGate = async () => ({ ok: true });
      try { r = await tryExtract({}); } finally { AG.aiGate = realGate; if (tmpApp) await FA.deleteApp(tmpApp); }
      ok('control: no flag → Anthropic is called', fetches.length === 1 && /api\.anthropic\.com/.test(fetches[0]), fetches);
      KS.getFlags = async () => ({ aiDisabled: true });
      fetches.length = 0;
      const silent = await extract({ callId: 'c2', transcript: 'hello' });
      ok('control: a silent call is still logged without AI (no call, no error)', silent.meta && silent.meta.skipped === 'silent' && fetches.length === 0);
    }
    KS.getFlags = realGetFlags;
    global.fetch = realFetch;
  }

  // ── #12 ───────────────────────────────────────────────────────────────────
  console.log('\n#12 measurement-ready task is due on the Eastern-time day');
  {
    const M = require(path.join(FN, 'integrations', 'measurement.js'));
    const writes = {};
    const db = { doc: (p) => ({ set: async (d) => { writes[p] = d; }, update: async () => {}, get: async () => ({ exists: false, data: () => ({}) }) }) };
    const realNow = Date.now;
    Date.now = () => Date.UTC(2026, 10, 18, 4, 30); // 23:30 EST, Tue 2026-11-17
    try {
      await M.attachMeasurementToLead(db, { leadId: 'L1', ownerId: 'U1', address: '12 Elm St', provider: 'solar', reportType: 'ai', measurementJobId: 'mj1', measurements: { rawSqft: 2000 } });
    } finally { Date.now = realNow; }
    const task = Object.keys(writes).filter((k) => /^leads\/L1\/tasks\//.test(k)).map((k) => writes[k])[0] || {};
    ok('a result at 23:30 ET is due that ET day (2026-11-17), not the UTC tomorrow', task.dueDate === '2026-11-17', task.dueDate);
  }

  // ── #13 ───────────────────────────────────────────────────────────────────
  console.log('\n#13 getAdminAnalytics fails closed without a companyId');
  {
    const since = Date.now() - 86_400_000;
    const rows = {
      estimates: [{ userId: 'repA', createdAt: since }, { userId: 'repB', createdAt: since }],
      measurements: [{ ownerId: 'repA', status: 'ready' }, { ownerId: 'repB', status: 'ready' }],
      leads: [{ userId: 'repA' }, { userId: 'repB' }, { userId: 'repB' }],
      'companies/co-a/members': [{ uid: 'repA' }],
    };
    const snap = (arr) => ({ empty: !arr.length, size: arr.length, docs: arr.map((d, i) => ({ id: 'd' + i, data: () => d })), forEach(fn) { this.docs.forEach(fn); } });
    const query = (name) => { const q = { where: () => q, limit: () => q, orderBy: () => q, get: async () => snap(rows[name] || []) }; return q; };
    const db = {
      collection: (name) => Object.assign(query(name), { doc: () => ({ get: async () => ({ exists: false, data: () => ({}) }) }) }),
      doc: (p) => ({ get: async () => (p === 'companies/co-a' ? { exists: true, data: () => ({ ownerId: 'ownerA' }) } : { exists: false, data: () => ({}) }) }),
    };
    const stubs = {
      'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
      'firebase-functions/v2': { logger: quietLogger },
      'firebase-functions/v2/identity': { beforeUserCreated: (o, h) => ({ __handler: h }), beforeUserSignedIn: (o, h) => ({ __handler: h }) },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
      './heartbeat': { onSchedule: (op, h) => ({ __handler: h }) },
      'firebase-admin/firestore': {
        getFirestore: () => db,
        FieldValue: { serverTimestamp: () => '__ts__', increment: (n) => ({ __inc: n }), delete: () => '__del__' },
        Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) },
      },
      'firebase-admin/auth': { getAuth: () => ({}) },
      'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({}) }) },
      './upstash-ratelimit': { httpRateLimit: async () => true, enforceRateLimit: async () => ({}) },
      './integrations/upstash-ratelimit': { enforceRateLimit: async () => ({ allowed: true }), httpRateLimit: async () => true },
      '../shared': { callableRateLimit: async () => {} },
      '../rate-limit-policy': { guardCallable: (n, h) => h },
    };
    const A = loadWith('handlers/admin.js', stubs);
    const call = async (token, data) => {
      try { return { out: await A.run(() => A.mod.getAdminAnalytics.__handler({ auth: { uid: 'x', token }, data: data || {} })) }; }
      catch (e) { return { err: e }; }
    };
    let r = await call({ role: 'company_admin' });
    ok('company_admin with no companyId → failed-precondition, no global counts', r.err && r.err.code === 'failed-precondition', r.err ? r.err.code : r.out);
    r = await call({ role: 'company_admin', companyId: 'co-a' });
    ok('control: company_admin with a companyId sees only its own company', !r.err && r.out.companyId === 'co-a' && r.out.measurements.requested30d === 1, r.err ? r.err.message : r.out);
    r = await call({ role: 'admin' });
    ok('control: platform admin with no companyId still gets the global view', !r.err && r.out.companyId === 'all' && r.out.measurements.requested30d === 2, r.err ? r.err.message : r.out);
  }

  // ── #18 ───────────────────────────────────────────────────────────────────
  console.log('\n#18 /inspect thank-you: honest when the CRM card misses the answers');
  {
    const PLP = require(path.join(FN, 'public-lead-photos.js'))._internal;
    const B = require(path.join(FN, 'lead-bridge-logic.js'));
    const flog = fnRequire('firebase-functions/v2').logger;
    function fakeDb(seed) {
      const store = new Map(Object.entries(seed || {}));
      const apply = (prev, patch) => { const out = Object.assign({}, prev || {}); for (const [k, v] of Object.entries(patch)) { if (v && typeof v === 'object' && 'operand' in v) out[k] = (out[k] || 0) + v.operand; else out[k] = v; } return out; };
      const ref = (c, id) => { const key = c + '/' + id; return {
        get: async () => ({ exists: store.has(key), data: () => store.get(key) }),
        set: async (d, o) => { store.set(key, o && o.merge ? apply(store.get(key), d) : apply({}, d)); },
        update: async (d) => { if (!store.has(key)) throw new Error('NOT_FOUND'); store.set(key, apply(store.get(key), d)); },
      }; };
      return { store, collection: (c) => ({ doc: (id) => ref(c, id) }), runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, d) => r.update(d) }) };
    }
    const TOKEN = 'd'.repeat(48);
    const GKEY = PLP.GRANTS + '/' + PLP.hashToken(TOKEN);
    const grant = { collection: 'inspect_leads', publicId: 'pub-7', exp: Date.now() + 60_000, max: 10, used: 0 };
    const warns = [];
    const realWarn = flog.warn;
    flog.warn = (...a) => { warns.push(a); };
    let db, out;
    try {
      db = fakeDb({ [GKEY]: grant, 'inspect_leads/pub-7': { name: 'Pat' } });
      out = await PLP.saveIntakeUpdate(db, { token: TOKEN, story: 'Leak over the porch', referralCode: 'john-ab12' }, { wait: async () => {} });
    } finally { flog.warn = realWarn; }
    const pub = db.store.get('inspect_leads/pub-7');
    ok('bridge card missing → 200 with crm:false (answers kept on the public lead)', out.status === 200 && out.json.crm === false && pub.story === 'Leak over the porch', out);
    ok('...a warning is logged', warns.length >= 1, warns.length);
    ok('...and the public lead is stamped crmIntakePending', pub.crmIntakePending === true, pub);

    const crmKey = 'leads/' + B.bridgeDocId('inspect_leads', 'pub-7');
    db = fakeDb({ [GKEY]: grant, 'inspect_leads/pub-7': {}, [crmKey]: { notes: '' } });
    out = await PLP.saveIntakeUpdate(db, { token: TOKEN, story: 'Leak' }, { wait: async () => {} });
    ok('control: card present → crm:true and no pending marker', out.json.crm === true && !('crmIntakePending' in db.store.get('inspect_leads/pub-7')), out);

    // The page.
    const JS = fs.readFileSync(path.join(ROOT, 'docs', 'assets', 'js', 'inspect-form.js'), 'utf8');
    function runInspect(saveJson) {
      const els = {}; const handlers = {};
      const mk = (id, props) => {
        const el = Object.assign({ id, value: '', attrs: {}, textContent: '', disabled: false, hidden: false, style: {}, className: '', childElementCount: 0,
          classList: { add() {} }, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
          focus() {}, remove() {}, scrollIntoView() {}, addEventListener(t, fn) { handlers[id + ':' + t] = fn; }, appendChild() {}, querySelector: () => null }, props || {});
        els[id] = el; return el;
      };
      const form = mk('inspectForm', { fields: () => ({ name: 'Pat Example', address: '12 Elm St, Goshen OH', phone: '8595550100', nbd_hp: '' }) });
      mk('f-name', { value: 'Pat Example' }); mk('f-address', { value: '12 Elm St, Goshen OH' }); mk('f-phone', { value: '8595550100' });
      mk('ins-consent', { checked: true }); mk('inspectSubmit'); mk('inspectSuccess');
      mk('insThanksTitle'); mk('insThanksText'); mk('insPickTime', { hidden: true });
      mk('insDetails', { hidden: true }); mk('insDetailsSave'); mk('insDetailsStatus'); mk('insIntakeAfter');
      mk('f-story'); mk('f-email'); mk('f-referral');
      const box = mk('insXIntake');
      Object.defineProperty(box, 'innerHTML', { set(v) { this._html = v; this.childElementCount = 1; }, get() { return this._html; } });
      const NBDIntake = {
        read: (root, p) => (p === 'ins' ? { fields: { scheduling: 'contact_me' }, files: [] } : { fields: {}, files: [] }),
        html: () => 'block', calendarUrl: () => 'https://cal.com/x', afterSubmit: () => {},
      };
      function FormData(f) { this._f = f.fields(); }
      FormData.prototype.forEach = function (cb) { Object.keys(this._f).forEach((k) => cb(this._f[k], k)); };
      const window = {
        location: { search: '' }, NBDIntake, open() {},
        nbdPublicFunctionsBase: () => 'https://fn.test',
        submitPublicLead: () => Promise.resolve({ ok: true, photoToken: 'a'.repeat(48) }),
      };
      const fetch = async () => ({ ok: true, json: async () => saveJson });
      const document = { readyState: 'complete', getElementById: (id) => els[id] || null, createElement: () => mk('__n' + Object.keys(els).length), addEventListener() {} };
      form.addEventListener = (t, fn) => { handlers['form:' + t] = fn; };
      vm.runInNewContext(JS, { window, document, FormData, URLSearchParams, fetch, Promise, console: { error() {}, warn() {}, log() {} } });
      handlers['form:submit']({ preventDefault() {} });
      return { els, handlers };
    }
    const tick = () => new Promise((r) => setImmediate(r));
    const statusAfterSave = async (saveJson) => {
      const r = runInspect(saveJson);
      await tick(); await tick();
      r.els['f-story'].value = 'Shingles off after the storm';
      if (r.handlers['insDetailsSave:click']) await r.handlers['insDetailsSave:click']();
      await tick(); await tick();
      return r.els.insDetailsStatus.textContent;
    };
    const miss = await statusAfterSave({ success: true, crm: false });
    ok('crm:false → the page does NOT claim it is on the request', miss && !/on your request now/.test(miss), miss);
    // telify() moves the number itself into a tel: link child, so the text ends at "Joe at ".
    ok('...it says it saved and points to calling or texting Joe', /^Saved\./.test(miss) && /call or text Joe at/.test(miss), miss);
    const hit = await statusAfterSave({ success: true, crm: true });
    ok('control: crm:true keeps "Thanks, that’s on your request now."', /on your request now/.test(hit), hit);
  }

  // ── #18 review: the bridge carries answers that arrived before it ran ─────
  console.log('\n#18 review: a slow bridge still carries the thank-you answers onto the card');
  {
    const FVb = { serverTimestamp: () => 'ts', increment: (n) => ({ inc: n }), delete: () => 'del' };
    let minted = null;
    const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }) }) }) };
    const B = loadWith('lead-bridge.js', {
      'firebase-functions/v2/firestore': { onDocumentCreated: (op, h) => ({ __opts: op, __handler: h }) },
      'firebase-functions/v2': { logger: quietLogger },
      'firebase-admin/firestore': { getFirestore: () => db, FieldValue: FVb },
      './customer-id-mint': { createLeadWithCustomerId: async (dbArg, ref, doc) => { minted = doc || (ref && ref.doc) || null; return { customerId: 'NBD-0001' }; } },
    });
    // Created without answers; by the time the (retried) bridge runs, the
    // thank-you screen has merged a story and a referral code onto the doc.
    const created = { name: 'Pat', phone: '5135550100', address: '1 Vine St', source: 'inspect' };
    const now = Object.assign({}, created, { story: 'Shingles in the yard after Tuesday', referralCode: 'JANE-CD34', crmIntakePending: true });
    const evt = { data: { data: () => Object.assign({}, created), ref: { get: async () => ({ exists: true, data: () => Object.assign({}, now) }) } }, params: { leadId: 'src1' }, time: new Date().toISOString() };
    let threw = null;
    try { await B.run(() => B.mod.leadBridgeInspect.__handler(evt)); } catch (e) { threw = e; }
    const card = minted && (minted.data || minted);
    const flat = JSON.stringify(card || {});
    ok('the card carries the late referral code as redeemReferralCode (the $100 credit can fire)', !threw && /"redeemReferralCode":"JANE-CD34"/.test(flat), threw ? threw.message : flat.slice(0, 300));
    ok('…and the late story', /Shingles in the yard/.test(flat));
    const evtNoRef = { data: { data: () => Object.assign({}, created) }, params: { leadId: 'src2' }, time: new Date().toISOString() };
    minted = null; threw = null;
    try { await B.run(() => B.mod.leadBridgeInspect.__handler(evtNoRef)); } catch (e) { threw = e; }
    ok('control: with no ref to re-read, the create-time data bridges as before', !threw && !!minted, threw ? threw.message : 'no mint');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
