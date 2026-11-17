/**
 * tests/price-ledger-server-2026-11.test.js
 *
 * functions/price-ledger.js (priceLedgerSave, priceLedgerRecord) and
 * functions/price-ledger-store.js driven for real against stubbed firebase modules
 * (the receipt-inbox-server idiom): an in-memory Firestore, a fake Auth and a fake
 * rate limiter. shared.js, handlers/_shared.js and tenant-guard.js are the real files.
 * Nothing reaches a network.
 *
 * Every price is synthetic (a multiple of 1111), the supplier is fictional and every
 * SKU starts TEST-. tests/price-fixture-privacy.test.js scans this file.
 *
 * Guards:
 *   - the gates run before any write, on both callables: signed in, ghost, viewer,
 *     rate limit, role, flag
 *   - who may do what: a manager records but never saves; a rep, a member and a
 *     viewer do neither; nobody can name another company
 *   - provenance is the server's: a manager's typed price is a note, and a caller
 *     can not create an API or shelf row or set compare / attested / latest
 *   - limits: 500 rows a call, 5000 a company a day
 *   - the write path is idempotent: duplicates, a retry, two appends at once, a void
 *     and a re-record
 *   - the save operations write named fields, never `latest`, and audit what they should
 *
 * Needs functions/node_modules. Run: node tests/price-ledger-server-2026-11.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const FUNCTIONS = path.join(__dirname, '..', 'functions');
const fnPath = (rel) => path.join(FUNCTIONS, rel);
const FX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'pricing', 'ledger-basic.json'), 'utf8'));

// ── the world ────────────────────────────────────────────────────────
let W;
const LOGS = [];
function reset() {
  W = { docs: {}, effects: [], seq: 0, clock: 1000, limited: false, failReads: null, disabled: {} };
  W.docs['companies/co-a'] = { ownerId: 'u_boss' };
  W.docs['companies/ghost1'] = { ownerId: 'u_newowner' };
  W.docs['feature_flags/_default'] = { supplierPricing: false };
  ['u_owner', 'u_boss', 'u_ca', 'u_mgr', 'u_rep', 'u_member', 'u_viewer', 'u_plat', 'ghost1', 'u_norole', 'u_submgr'].forEach((u) => { W.docs['feature_flags/' + u] = { supplierPricing: true }; });
  LOGS.length = 0;
  require(fnPath('tenant-guard.js'))._resetCache();
}
const fx = (t) => { W.effects.push(t); };
const writes = () => W.effects.filter((e) => /^(create|update|set|delete):/.test(e));
const writesUnder = (prefix) => writes().filter((e) => e.split(':')[1].indexOf(prefix) === 0);

class HttpsError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details; } }
const FieldValue = { serverTimestamp: () => ({ __fv: 'ts' }), increment: (n) => ({ __fv: 'inc', n }), delete: () => ({ __fv: 'delete' }) };
const Timestamp = { fromMillis: (ms) => ({ toMillis: () => ms }), now: () => ({ toMillis: () => Date.now() }) };
const applyVals = (prev, v) => {
  const out = Object.assign({}, prev || {});
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (x && x.__fv === 'ts') { const at = ++W.clock; out[k] = { toMillis: () => at }; }
    else if (x && x.__fv === 'inc') out[k] = (Number(out[k]) || 0) + x.n;
    else out[k] = x;
  }
  return out;
};
function snapOf(p) { const d = W.docs[p]; return { exists: d != null, id: p.split('/').pop(), ref: docRef(p), data: () => (d == null ? undefined : Object.assign({}, d)) }; }
function docRef(p) {
  return {
    id: p.split('/').pop(), path: p,
    get: async () => { if (W.failReads && p.indexOf(W.failReads) === 0) throw new Error('read failed'); return snapOf(p); },
    create: async (v) => {
      if (W.docs[p] != null) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; }
      fx('create:' + p); W.docs[p] = applyVals({}, v);
    },
    set: async (v, o) => { fx('set:' + p); W.docs[p] = (o && o.merge) ? applyVals(W.docs[p], v) : applyVals({}, v); },
    update: async (v) => { if (W.docs[p] == null) throw new Error('5 NOT_FOUND'); fx('update:' + p); W.updates = (W.updates || []).concat([{ path: p, keys: Object.keys(v) }]); W.docs[p] = applyVals(W.docs[p], v); },
    delete: async () => { fx('delete:' + p); delete W.docs[p]; },
  };
}
const msOf = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis() : v;
function query(colPath, filters, order, lim) {
  return {
    where: (f, op, v) => query(colPath, filters.concat([[f, op, v]]), order, lim),
    orderBy: (f, dir) => query(colPath, filters, [f, dir || 'asc'], lim),
    limit: (n) => query(colPath, filters, order, n),
    get: async () => {
      let paths = Object.keys(W.docs).filter((p) => p.indexOf(colPath + '/') === 0 && p.slice(colPath.length + 1).indexOf('/') === -1);
      paths = paths.filter((p) => filters.every(([f, , v]) => W.docs[p][f] === v));
      if (order) paths.sort((a, b) => { const x = msOf(W.docs[a][order[0]]), y = msOf(W.docs[b][order[0]]); return order[1] === 'desc' ? y - x : x - y; });
      if (lim) paths = paths.slice(0, lim);
      const docs = paths.map(snapOf);
      return { docs, size: docs.length, empty: docs.length === 0 };
    },
  };
}
let TX_CHAIN = Promise.resolve();
const DB = {
  doc: docRef,
  collection: (n) => Object.assign(query(n, [], null, 0), { doc: (id) => docRef(n + '/' + (id || 'auto' + (++W.seq))) }),
  getAll: (...refs) => Promise.all(refs.map((r) => r.get())),
  // Serialized, like Firestore's retry of contended transactions: two never interleave.
  runTransaction: (fn) => {
    const run = TX_CHAIN.then(() => {
      const tx = { get: (r) => r.get(), set: (r, v, o) => { r.set(v, o); return tx; }, update: (r, v) => { r.update(v); return tx; } };
      return fn(tx);
    });
    TX_CHAIN = run.catch(() => {});
    return run;
  },
};
const logger = { info: (...a) => LOGS.push(JSON.stringify(a)), warn: (...a) => LOGS.push(JSON.stringify(a)), error: (...a) => LOGS.push(JSON.stringify(a)), debug: () => {}, log: () => {} };
const httpsStub = { onCall: (o, h) => ({ __opts: o, __handler: typeof o === 'function' ? o : h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError };
const PKG_STUBS = {
  'firebase-functions/v2/https': httpsStub,
  'firebase-functions/v2': { logger, https: httpsStub },
  'firebase-functions': { logger, https: httpsStub, config: () => ({}) },
  'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'sk-test-' + 'not-real' }), defineString: (n) => ({ name: n, value: () => '' }) },
  'firebase-admin/firestore': { getFirestore: () => DB, FieldValue, Timestamp },
  'firebase-admin/auth': { getAuth: () => ({ getUser: async (uid) => ({ uid, disabled: W.disabled[uid] === true, customClaims: {} }) }) },
  'firebase-admin/app': { initializeApp: () => ({}), getApps: () => [{}], getApp: () => ({}) },
  'firebase-admin': { initializeApp: () => ({}), apps: [{}], firestore: Object.assign(() => DB, { FieldValue }) },
};
const limiter = {
  enforceRateLimit: async () => { if (W.limited) { const e = new Error('rate limited'); e.rateLimited = true; throw e; } return { count: 1 }; },
  httpRateLimit: async () => true, clientIp: () => '203.0.113.9', hashKey: (k) => String(k), provider: 'firestore', _upstashConfigured: false,
};
const FILE_STUBS = {
  [fnPath('integrations/upstash-ratelimit.js')]: limiter,
  [fnPath('rate-limit.js')]: Object.assign({ rateLimitIpKey: (ip) => ip }, limiter),
  [fnPath('integrations/sentry.js')]: { withSentry: (n, fn) => fn, captureException: () => {}, ensureInit: () => {}, installRejectionHook: () => {} },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(PKG_STUBS, request)) return PKG_STUBS[request];
  if (request.charAt(0) === '.') {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_) { /* let the real load report it */ }
    if (resolved && Object.prototype.hasOwnProperty.call(FILE_STUBS, resolved)) return FILE_STUBS[resolved];
  }
  return realLoad.apply(this, arguments);
};

const mod = require(fnPath('price-ledger.js'));
const Store = require(fnPath('price-ledger-store.js'));
const L = require(fnPath('price-logic.js'));
const SAVE = mod.priceLedgerSave.__handler, RECORD = mod.priceLedgerRecord.__handler;

const USERS = {
  owner: { uid: 'u_owner', token: {} },                                           // solo owner: the company is the uid
  ca: { uid: 'u_ca', token: { companyId: 'co-a', role: 'company_admin' } },
  mgr: { uid: 'u_mgr', token: { companyId: 'co-a', role: 'manager' } },
  rep: { uid: 'u_rep', token: { companyId: 'co-a', role: 'sales_rep' } },
  member: { uid: 'u_member', token: { role: 'member' } },
  viewer: { uid: 'u_viewer', token: { companyId: 'co-a', role: 'viewer' } },
  plat: { uid: 'u_plat', token: { role: 'admin' } },
  ghost: { uid: 'ghost1', token: {} },
  norole: { uid: 'u_norole', token: { companyId: 'co-a' } },
  submgr: { uid: 'u_submgr', token: { role: 'manager' } },                        // a manager role with no company claim
};
async function call(handler, who, data) {
  const u = who ? USERS[who] : null;
  const req = { auth: u ? { uid: u.uid, token: Object.assign({ uid: u.uid }, u.token) } : null, data, rawRequest: { headers: {}, ip: '203.0.113.9' } };
  try { return { value: await handler(req) }; } catch (e) { return { code: e.code || 'threw', message: e.message, details: e.details }; }
}
const save = (who, op, data) => call(SAVE, who, { op, data });
const record = (who, rows, extra) => call(RECORD, who, Object.assign({ rows }, extra || {}));
const OFFER = 'other_testco_TEST-0001';
const CO_A = 'priceBook/co-a/';
async function seed(who) {
  const a = await save(who || 'ca', 'upsertSupplierAccount', FX.account);
  const o = await save(who || 'ca', 'upsertOffer', FX.offers[0]);
  return { a, o };
}
const obsDocs = (prefix) => Object.keys(W.docs).filter((p) => p.indexOf((prefix || CO_A) + 'priceObservations/') === 0);
const TODAY = new Date().toISOString().slice(0, 10);
const typed = (patch) => Object.assign({ offerId: OFFER, kind: 'paid', priceMicros: 11110000, per: 1, statedUnit: 'BDL', uomRaw: 'BD', priceType: 'account', taxIncluded: false, observedOn: TODAY }, patch || {});

(async () => {
  console.log('\nGates, on both callables');
  {
    const cases = [
      ['unauthenticated', null, 'unauthenticated'],
      ['a ghost (no claims; the company doc names someone else)', 'ghost', 'permission-denied'],
      ['a viewer', 'viewer', 'permission-denied'],
      ['a sales rep', 'rep', 'permission-denied'],
      ['an access-code member', 'member', 'permission-denied'],
      ['a manager role with no company claim', 'submgr', 'permission-denied'],
      ['a token with the company claim and no role', 'norole', 'permission-denied'],
    ];
    for (const [label, who, code] of cases) {
      reset();
      const s = await save(who, 'upsertSupplierAccount', FX.account);
      const r = await record(who, [typed()]);
      ok(label + ': refused on both with zero writes', s.code === code && r.code === code && writes().length === 0, [s.code, r.code, writes()]);
    }
    reset(); W.limited = true;
    const s1 = await save('ca', 'upsertSupplierAccount', FX.account), r1 = await record('ca', [typed()]);
    ok('the rate limit refuses both with zero writes', s1.code === 'resource-exhausted' && r1.code === 'resource-exhausted' && writes().length === 0, [s1.code, r1.code]);
    reset(); W.docs['feature_flags/u_ca'] = { supplierPricing: false };
    const s2 = await save('ca', 'upsertSupplierAccount', FX.account), r2 = await record('ca', [typed()]);
    ok('flag off: failed-precondition on both with zero writes', s2.code === 'failed-precondition' && r2.code === 'failed-precondition' && writes().length === 0, [s2.code, r2.code]);
    reset(); W.docs['feature_flags/u_ca'] = { supplierPricing: 'true' };
    ok('a string "true" does not switch it on', (await save('ca', 'upsertSupplierAccount', FX.account)).code === 'failed-precondition');
    reset(); W.failReads = 'feature_flags/';
    const s3 = await save('ca', 'upsertSupplierAccount', FX.account), r3 = await record('ca', [typed()]);
    ok('a flag read error: unavailable on both with zero writes', s3.code === 'unavailable' && r3.code === 'unavailable' && writes().length === 0, [s3.code, r3.code]);
    reset(); W.disabled.u_mgr = true; W.disabled.u_ca = true;
    await seed('owner');
    const before = writes().length;
    ok('a disabled account is refused', (await record('mgr', [typed()])).code === 'permission-denied' && (await save('ca', 'upsertSupplierAccount', FX.account)).code === 'permission-denied' && writes().length === before);
  }

  console.log('\nRoles');
  {
    reset();
    const { a, o } = await seed('ca');
    ok('a company_admin saves an account and an offer', a.value && a.value.ok && o.value && o.value.id === OFFER, [a, o]);
    const before = writes().length;
    const m = await save('mgr', 'upsertOffer', FX.offers[0]);
    ok('a manager is refused on priceLedgerSave with zero writes', m.code === 'permission-denied' && writes().length === before, m);
    const mr = await record('mgr', [typed()]);
    ok('a manager is allowed on priceLedgerRecord', mr.value && mr.value.written === 1, mr);
    const cr = await record('ca', [typed({ priceMicros: 22220000 })]);
    ok('a company_admin records', cr.value && cr.value.written === 1, cr);

    reset();
    const so = await seed('owner');
    const sr = await record('owner', [typed()]);
    ok('a solo owner saves and records, under their own uid', so.o.value && sr.value && sr.value.written === 1 && writes().every((e) => e.split(':')[1].indexOf('priceBook/u_owner/') === 0), writes());

    reset();
    const pa = await seed('plat');
    const pr = await record('plat', [typed()], { companyId: 'co-a' });
    ok('the platform admin acts on their own tenant only', pa.o.value && pr.value && pr.value.written === 1 && writes().every((e) => e.split(':')[1].indexOf('priceBook/u_plat/') === 0), writes());

    reset();
    await call(SAVE, 'ca', { op: 'upsertSupplierAccount', companyId: 'co-b', data: Object.assign({ companyId: 'co-b' }, FX.account) });
    await call(SAVE, 'ca', { op: 'upsertOffer', companyId: 'co-b', data: Object.assign({ companyId: 'co-b' }, FX.offers[0]) });
    await record('ca', [typed({ companyId: 'co-b' })], { companyId: 'co-b' });
    ok('a companyId in the request data is ignored: every write is under the caller\'s company', writes().length > 0 && writes().every((e) => e.split(':')[1].indexOf(CO_A) === 0), writes());
    ok('an unknown operation is refused', (await save('ca', 'dropEverything', {})).code === 'invalid-argument');
  }

  console.log('\nProvenance');
  {
    reset(); await seed('ca');
    const m = await record('mgr', [typed({ kind: 'paid' })]);
    const md = W.docs[CO_A + 'priceObservations/' + m.value.results[0].obsId];
    ok('a manager\'s typed paid row is stored as manual, claimedKind paid, unattested', md.kind === 'manual' && md.claimedKind === 'paid' && md.attested === false && md.source.actor.role === 'manager', md);
    const o = await record('ca', [typed({ kind: 'paid', priceMicros: 22220000 })]);
    const od = W.docs[CO_A + 'priceObservations/' + o.value.results[0].obsId];
    ok('a company_admin\'s typed paid row is stored as paid, attested', od.kind === 'paid' && od.claimedKind === null && od.attested === true && od.compare === true, od);
    ok('the server stamps the offer\'s supplier, product, pack and the per-square price', od.supplierId === 'other_testco' && od.productId === 'shingle_001' && od.pack.den === 3 && od.catalogMicros === 22220000 * 3 && od.source.channel === 'manual', od);
    const before = writes().length;
    const bad = await record('ca', [typed({ kind: 'live_shelf' }), typed({ kind: 'api_account' })]);
    ok('live_shelf and api_account from a caller are refused (bad_kind), nothing written', bad.value.rejected === 2 && bad.value.results.every((r) => r.reason === 'bad_kind') && obsDocs().length === 2 && writesUnder(CO_A + 'priceObservations/').length === 2, [bad.value, before]);
    const sent = await record('ca', [typed({ priceMicros: 33330000, compare: false, attested: false, source: { channel: 'abc_api' }, latest: { best: null }, levelAtWrite: 5, catalogMicros: 1111, productId: 'evil', supplierId: 'abc', match: 'comparable', pack: { num: 9, den: 1 } })]);
    const sd = W.docs[CO_A + 'priceObservations/' + sent.value.results[0].obsId];
    ok('caller-sent compare, attested, source, levelAtWrite, catalogMicros, productId, supplierId, match and pack are ignored',
      sd.compare === true && sd.attested === true && sd.source.channel === 'manual' && sd.levelAtWrite === 1 && sd.catalogMicros === 33330000 * 3
      && sd.productId === 'shingle_001' && sd.supplierId === 'other_testco' && sd.match === 'exact' && sd.pack.num === 1 && !('latest' in sd), sd);
    ok('a branch the supplier account does not have is refused', (await record('ca', [typed({ locationId: 'nowhere' })])).value.results[0].reason === 'unknown_location');
    ok('a branch the account has is accepted', (await record('ca', [typed({ locationId: 'main', priceMicros: 44440000 })])).value.written === 1);
    ok('no log line carries a price, a SKU or the supplier name', LOGS.length > 0 && LOGS.every((l) => !/1111|2222|3333|4444|TEST-|Testco/.test(l)), LOGS);
  }

  console.log('\nLimits');
  {
    reset(); await seed('ca');
    const before = writes().length;
    const rows = []; for (let i = 0; i < 501; i++) rows.push(typed());
    ok('501 rows are refused with zero writes', (await record('ca', rows)).code === 'invalid-argument' && (await record('ca', [])).code === 'invalid-argument' && writes().length === before);
    const day = new Date().toISOString().slice(0, 10);
    W.docs[CO_A + 'priceMeter/rows_' + day] = { rows: Store.DAILY_ROW_CAP - 1 };
    const over = await record('ca', [typed(), typed({ priceMicros: 22220000 })]);
    ok('the daily counter refuses the call that would pass it', over.code === 'resource-exhausted' && obsDocs().length === 0, over);
    const fits = await record('ca', [typed()]);
    ok('a call that exactly reaches the cap is written, and the counter moves', fits.value && fits.value.written === 1 && W.docs[CO_A + 'priceMeter/rows_' + day].rows === Store.DAILY_ROW_CAP, [fits, W.docs[CO_A + 'priceMeter/rows_' + day]]);
    ok('the next row that day is refused', (await record('ca', [typed({ priceMicros: 33330000 })])).code === 'resource-exhausted');
  }

  console.log('\nWrite path');
  {
    reset(); await seed('ca');
    const mixed = await record('ca', [typed({ offerId: 'other_testco_TEST-9999' }), typed(), typed({ statedUnit: 'zorkmid', uomRaw: '' })]);
    ok('an unknown offer is rejected, the other rows are written, results stay in order',
      mixed.value.results[0].reason === 'unknown_offer' && mixed.value.results[1].status === 'written' && mixed.value.results[2].reason === 'needs_unit'
      && mixed.value.written === 1 && mixed.value.rejected === 2 && mixed.value.needsUnit === 1 && mixed.value.alertsOpened === 0, mixed.value);

    reset(); await seed('ca');
    const A = typed({ doc: { type: 'invoice', ref: 'TEST-INV-0001' } });
    const B = typed({ priceMicros: 22220000, doc: { type: 'invoice', ref: 'TEST-INV-0002' } });
    const first = await record('ca', [A]);
    const again = await record('ca', [A, B, A]);
    ok('a duplicate row does not fail its neighbours', again.value.results[0].status === 'duplicate' && again.value.results[1].status === 'written' && again.value.results[2].status === 'duplicate'
      && again.value.results[0].obsId === first.value.results[0].obsId && again.value.duplicates === 2 && again.value.written === 1, again.value);
    const createsBefore = W.effects.filter((e) => e.indexOf('create:' + CO_A + 'priceObservations/') === 0).length;
    const retry = await record('ca', [A, B]);
    ok('a retry of the same rows writes nothing', retry.value.written === 0 && retry.value.duplicates === 2 && W.effects.filter((e) => e.indexOf('create:' + CO_A + 'priceObservations/') === 0).length === createsBefore, retry.value);
    ok('a row that names its document gets the document id; the summary counts both', /^[0-9a-f]{28}$/.test(first.value.results[0].obsId) && W.docs[CO_A + 'priceOffers/' + OFFER].latest.count === 2, W.docs[CO_A + 'priceOffers/' + OFFER].latest);

    reset(); await seed('ca');
    await record('ca', [A]);
    W.docs[CO_A + 'priceOffers/' + OFFER].latest = null;                          // a crash between the write and the summary
    const half = await record('ca', [A, B]);
    ok('a retry of a half-written call writes only the missing row and repairs the summary', half.value.written === 1 && half.value.duplicates === 1 && obsDocs().length === 2 && W.docs[CO_A + 'priceOffers/' + OFFER].latest.count === 2, half.value);

    reset(); await seed('ca');
    const [p, q] = await Promise.all([record('ca', [typed({ observedOn: '2026-10-01' })]), record('mgr', [typed({ priceMicros: 22220000, observedOn: '2026-10-02' })])]);
    const latest = W.docs[CO_A + 'priceOffers/' + OFFER].latest;
    ok('two interleaved appends on one offer leave latest built from both rows', p.value.written === 1 && q.value.written === 1 && latest.count === 2 && latest.recent.length === 2, latest);
    ok('the admin\'s paid row is best; the manager\'s note is in the history only', latest.best.kind === 'paid' && latest.best.catalogMicros === 11110000 * 3 && latest.recent.some((r) => r.k === 'manual'), latest);

    reset(); await seed('ca');
    const w1 = await record('ca', [A]);
    const id = w1.value.results[0].obsId;
    const v = await save('ca', 'voidObservation', { obsId: id, reason: 'wrong unit' });
    const w2 = await record('ca', [A]);
    const rdoc = W.docs[CO_A + 'priceObservations/' + id + '-r1'];
    ok('void then re-record gives -r1 with supersedes', v.value && v.value.ok && w2.value.results[0].status === 'written' && w2.value.results[0].obsId === id + '-r1' && rdoc && rdoc.supersedes === id, [w2.value, rdoc && rdoc.supersedes]);
    ok('a plain re-import after that is a duplicate again', (await record('ca', [A])).value.results[0].status === 'duplicate');
  }

  console.log('\nSave operations');
  {
    reset(); await seed('ca');
    await record('ca', [typed()]);
    W.updates = [];
    const up = await save('ca', 'upsertOffer', Object.assign({}, FX.offers[0], { title: 'Testco Example Architectural Shingle, Slate (renamed)', latest: { best: { catalogMicros: 1111 } }, nextCheckMs: 5 }));
    const offerUpdates = W.updates.filter((u) => u.path === CO_A + 'priceOffers/' + OFFER);
    ok('upsertOffer on an existing offer sends named fields and never latest, nextCheckMs, createdAt or createdBy',
      up.value && up.value.ok && offerUpdates.length === 1 && ['latest', 'nextCheckMs', 'createdAt', 'createdBy', 'supplierId', 'sku'].every((k) => offerUpdates[0].keys.indexOf(k) === -1) && offerUpdates[0].keys.indexOf('title') !== -1, offerUpdates);
    ok('the stored summary survives an edit', W.docs[CO_A + 'priceOffers/' + OFFER].latest.count === 1 && W.docs[CO_A + 'priceOffers/' + OFFER].title.indexOf('renamed') !== -1);
    ok('an offer for a supplier with no account is refused', (await save('ca', 'upsertOffer', Object.assign({}, FX.offers[0], { supplierId: 'other_nobody' }))).details.reason === 'unknown_supplier_account');
    ok('a bad pack is refused with a plain reason', (await save('ca', 'upsertOffer', Object.assign({}, FX.offers[0], { pack: Object.assign({}, FX.offers[0].pack, { den: 0 }) }))).details.reason === 'bad_pack');

    const audits = () => Object.keys(W.docs).filter((p) => p.indexOf(CO_A + 'priceAudit/') === 0);
    const a0 = audits().length;
    const link = await save('ca', 'linkOffer', { offerId: OFFER, productId: 'shingle_002', match: 'equivalent' });
    ok('linkOffer writes one audit row and the link', link.value && audits().length === a0 + 1 && W.docs[CO_A + 'priceOffers/' + OFFER].productId === 'shingle_002' && W.docs[CO_A + 'priceOffers/' + OFFER].match === 'equivalent');
    const vp = await save('ca', 'verifyPack', { offerId: OFFER });
    const pack = W.docs[CO_A + 'priceOffers/' + OFFER].pack;
    ok('verifyPack writes one audit row and marks the pack verified by the caller', vp.value && audits().length === a0 + 2 && pack.verified === true && pack.verifiedBy === 'u_ca' && typeof pack.verifiedAtMs === 'number', pack);
    const edited = await save('ca', 'upsertOffer', Object.assign({}, FX.offers[0], { pack: Object.assign({}, FX.offers[0].pack, { den: 5 }) }));
    const after = W.docs[CO_A + 'priceOffers/' + OFFER];
    ok('changing the pack clears verified and re-derives the summary from the new ratio', edited.value && after.pack.verified === false && after.pack.den === 5 && after.latest.best.catalogMicros === 11110000 * 5, [after.pack, after.latest.best]);
    await save('ca', 'upsertOffer', FX.offers[1]);
    ok('verifyPack on an unknown pack is refused', (await save('ca', 'verifyPack', { offerId: 'other_testco_TEST-0002' })).details.reason === 'needs_unit');
    const un = await record('ca', [typed({ offerId: 'other_testco_TEST-0002', priceMicros: 44440000 })]);
    ok('a price on an offer with no pack is stored with no per-unit price and counted as needs a unit', un.value.written === 1 && un.value.needsUnit === 1 && W.docs[CO_A + 'priceObservations/' + un.value.results[0].obsId].catalogMicros === null
      && W.docs[CO_A + 'priceOffers/other_testco_TEST-0002'].latest.unitState === 'needs_unit' && W.docs[CO_A + 'priceOffers/other_testco_TEST-0002'].latest.best === null);

    const obsId = obsDocs().filter((p) => W.docs[p].offerId === OFFER)[0].split('/').pop();
    const a1 = audits().length;
    const vo = await save('ca', 'voidObservation', { obsId, reason: 'typo' });
    const od = W.docs[CO_A + 'priceObservations/' + obsId];
    ok('voidObservation writes one audit row, marks the row and rebuilds latest', vo.value && audits().length === a1 + 1 && od.voided === true && od.voidedBy === 'u_ca' && od.voidReason === 'typo'
      && W.docs[CO_A + 'priceOffers/' + OFFER].latest.count === 0 && W.docs[CO_A + 'priceOffers/' + OFFER].latest.best === null, W.docs[CO_A + 'priceOffers/' + OFFER].latest);
    ok('voiding it again changes and audits nothing', (await save('ca', 'voidObservation', { obsId })).value.ok === true && audits().length === a1 + 1);
    ok('a missing observation or offer is not-found', (await save('ca', 'voidObservation', { obsId: 'nope' })).code === 'not-found' && (await save('ca', 'linkOffer', { offerId: 'nope' })).code === 'not-found');
    const ar = await save('ca', 'archiveOffer', { offerId: OFFER });
    ok('archiveOffer turns the offer off without an audit row', ar.value && W.docs[CO_A + 'priceOffers/' + OFFER].active === false && audits().length === a1 + 1);
    ok('every audit row names the actor and carries no price', audits().every((p) => W.docs[p].actor.uid === 'u_ca' && !/Micros|price/i.test(JSON.stringify(W.docs[p].detail))));
  }

  console.log('\nThe store builds every path itself');
  {
    reset(); await seed('ca');
    const src = fs.readFileSync(fnPath('price-ledger-store.js'), 'utf8');
    ok('no exported store function takes a path argument', !/async (?:function )?\w+\(db, (?:path|ref|docPath|collectionPath)\b/.test(src) && !/\(db, companyId, (?:path|ref)\b/.test(src));
    ok('a company id that is not an id is refused before any read or write', await Store.appendObservations(DB, 'co-a/../co-b', [typed()], { origin: 'callable', channel: 'manual', actor: { uid: 'u', role: 'owner' }, nowMs: Date.now() }).then(() => false, (e) => e.code === 'permission-denied'));
    ok('the logic file and the store agree on the caps', Store.MAX_ROWS_PER_CALL === 500 && Store.DAILY_ROW_CAP === 5000 && L.FLAG_NAME === 'supplierPricing');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
