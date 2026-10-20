/**
 * tests/portal-rating-backfill-2026-10-19.test.js
 *
 * Behavioural: the REAL submitCustomerRating handler (functions/portal.js) over a small in-memory
 * Firestore. A customer whose only "payment" is a payment-backfill invoice (money recorded after
 * the fact) cannot rate (409 not-complete), so no review prompt is reachable; a customer with real,
 * fully paid money can, with or without an old backfilled check beside it. Synthetic data only.
 *
 * Run: node tests/portal-rating-backfill-2026-10-19.test.js
 */
'use strict';
const Module = require('module');
const path = require('path');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + JSON.stringify(detail).slice(0, 300) : '')); failed++; }
}
const ROOT = path.join(__dirname, '..');

let store = {};
let added = [];
const fakeDb = {
  doc: (p) => ({ path: p, collection: (c) => fakeDb.collection(p + '/' + c), get: async () => ({ exists: p in store, data: () => store[p] }), update: async (d) => { Object.assign(store[p] || (store[p] = {}), d); }, set: async (d) => { store[p] = d; } }),
  collection: (c) => {
    const q = { doc: (id) => fakeDb.doc(c + '/' + id), add: async (d) => { added.push({ c, d }); return { id: 'n' + added.length }; },
      get: async () => ({ docs: Object.keys(store).filter((k) => k.startsWith(c + '/') && k.split('/').length === 2).map((k) => ({ id: k.split('/')[1], data: () => store[k] })), empty: true, size: 0, forEach() {} }) };
    q.limit = () => q; q.where = () => q; q.orderBy = () => q;
    return q;
  },
  runTransaction: async (fn) => fn({ get: async (ref) => ({ exists: ref.path in store, data: () => store[ref.path] }), update: (ref, patch) => { Object.assign(store[ref.path], patch); } }),
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-functions/v2/https') return { onRequest: (opts, h) => (typeof opts === 'function' ? opts : h), onCall: (o, h) => (h || o), HttpsError: class extends Error {} };
  if (/upstash-ratelimit$/.test(request)) { const real = origLoad.apply(this, arguments); return Object.assign({}, real, { httpRateLimit: async () => true }); }
  if (request === 'firebase-admin/firestore') { const real = origLoad.apply(this, arguments); return Object.assign({}, real, { getFirestore: () => fakeDb }); }
  return origLoad.apply(this, arguments);
};
let portal;
try { portal = require(path.join(ROOT, 'functions/portal.js')); }
catch (e) { console.log('  ✗ portal.js did not load: ' + String(e.message).split('\n')[0]); process.exit(1); }
let nudge = null;
try { nudge = require(path.join(ROOT, 'functions/review-request-nudge.js')); } catch (e) { console.log('  (review-request-nudge not loadable here: ' + String(e.message).split('\n')[0] + ')'); }
Module._load = origLoad;

async function rate(invoices) {
  store = {
    'portal_tokens/TOKEN1234567': { leadId: 'L1', companyId: 'co', ownerUid: 'u1' },
    'leads/L1': { companyId: 'co', userId: 'u1', firstName: 'Sample', stage: 'closed', stageRole: 'won', stageHistory: [] },
  };
  invoices.forEach((inv, i) => { store['invoices/i' + i] = Object.assign({ leadId: 'L1', companyId: 'co', createdBy: 'u1' }, inv); });
  added = [];
  const out = { status: 200, body: null };
  const res = { status(s) { out.status = s; return res; }, json(b) { out.body = b; return res; }, end() { return res; }, set() { return res; }, setHeader() { return res; } };
  await portal.submitCustomerRating({ method: 'POST', body: { token: 'TOKEN1234567', stars: 5 }, headers: {}, ip: '127.0.0.1', get() { return ''; } }, res);
  return { out, rated: store['leads/L1'].customerRating };
}
async function view(invoices, tenant) {
  store = {
    'portal_tokens/TOKEN1234567': { leadId: 'L1', companyId: tenant, ownerUid: tenant },
    'leads/L1': { companyId: tenant, userId: tenant, firstName: 'Sample', stage: 'closed', stageRole: 'won', stageHistory: [] },
  };
  invoices.forEach((inv, i) => { store['invoices/i' + i] = Object.assign({ leadId: 'L1', companyId: tenant, createdBy: tenant }, inv); });
  const out = { status: 200, body: null };
  const res = { status(s) { out.status = s; return res; }, json(b) { out.body = b; return res; }, end() { return res; }, set() { return res; }, setHeader() { return res; }, send(b) { out.body = b; return res; } };
  await portal.getHomeownerPortalView({ method: 'POST', body: { token: 'TOKEN1234567' }, headers: {}, ip: '127.0.0.1', get() { return ''; } }, res);
  return out;
}
const at = new Date(Date.now() - 5 * 86400000);
const paid = (extra) => Object.assign({ status: 'paid', total: 500, amountPaid: 500, balanceDue: 0, paidAt: at, payments: [{ amount: 500, at, method: 'check' }] }, extra || {});

(async () => {
  console.log('\n— submitCustomerRating —');
  const control = await rate([paid()]);
  ok('control: a customer fully paid by a real invoice CAN rate', control.out.status === 200 && control.rated === 5, control);
  const only = await rate([paid({ source: 'backfill', backfilled: true })]);
  ok('a customer whose only payment is a backfill invoice gets 409 not-complete and nothing is stamped', only.out.status === 409 && only.rated === undefined, only);
  const mixed = await rate([paid({ source: 'backfill', backfilled: true }), paid()]);
  ok('real fully paid money + an old backfilled check: still allowed', mixed.out.status === 200 && mixed.rated === 5, mixed);
  const partial = await rate([paid({ source: 'backfill', backfilled: true }), { status: 'sent', total: 900, amountPaid: 0, balanceDue: 900, payments: [] }]);
  ok('a backfill payment beside a real invoice that is still owed: refused', partial.out.status === 409 && partial.rated === undefined, partial);
  const voided = await rate([paid({ source: 'backfill', backfilled: true, deleted: true }), paid()]);
  ok('a voided backfill invoice does not matter', voided.out.status === 200, voided);
  console.log('\n— the portal view (rating card and Google review link), NBD tenant —');
  const NBD = require(path.join(ROOT, 'functions/review-ask-auto-logic.js')).NBD_OWNER_UID;
  const v1 = await view([paid()], NBD);
  ok('control: a real paid job shows the rating card and the review link', v1.status === 200 && v1.body.rating.canRate === true && !!v1.body.rating.googleReviewUrl, v1.body && v1.body.rating);
  const v2 = await view([paid({ source: 'backfill', backfilled: true })], NBD);
  ok('a backfill-only customer: no rating card and NO Google review link', v2.status === 200 && v2.body.rating.canRate === false && v2.body.rating.googleReviewUrl === null, v2.body && v2.body.rating);
  const v3 = await view([paid({ source: 'backfill', backfilled: true }), paid()], NBD);
  ok('real paid money beside an old backfilled check: card and link stay', v3.body.rating.canRate === true && !!v3.body.rating.googleReviewUrl, v3.body && v3.body.rating);
  if (nudge && nudge._test) {
    console.log('\n— rep review nudge —');
    const anchor = async (invoices) => {
      store = { 'leads/L1': { companyId: 'co', userId: 'u1', stage: 'closed', stageRole: 'won', stageStartedAt: new Date(Date.now() - 6 * 86400000) } };
      invoices.forEach((inv, i) => { store['invoices/i' + i] = Object.assign({ leadId: 'L1', companyId: 'co', createdBy: 'u1' }, inv); });
      return nudge._test.paidAnchor(fakeDb, Object.assign({ id: 'L1' }, store['leads/L1']), 'L1', null, null);
    };
    const a1 = await anchor([paid()]);
    ok('control: a real paid job has a nudge anchor dated by its real payment', !!a1 && a1.receivedMs > 0, a1);
    const a2 = await anchor([paid({ source: 'backfill', backfilled: true })]);
    ok('a backfill-only customer has NO nudge anchor (no "ask for a review" to the rep)', a2 === null, a2);
    const old9 = new Date(Date.now() - 9 * 86400000);
    const a3 = await anchor([paid({ source: 'backfill', backfilled: true, paidAt: new Date() }), paid({ paidAt: old9, payments: [{ amount: 500, at: old9, method: 'check' }] })]);
    ok('beside a real payment, the backfill payment never dates the nudge', !!a3 && a3.ms <= Date.now() - 5 * 86400000 && a3.receivedMs <= Date.now() - 8 * 86400000, a3);
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ harness error: ' + (e && e.stack || e)); process.exit(1); });
