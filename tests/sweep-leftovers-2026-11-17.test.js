/**
 * tests/sweep-leftovers-2026-11-17.test.js
 *
 * Jo, 2026-11-17 (Q5): the public 'DEMO' access code stays live. It powers the
 * /pro login "Launch Demo Dashboard" button. scripts/seed-access-codes.js
 * stopped deactivating it (#3129), but the admin panel's "Rotate access codes"
 * button runs the rotateAccessCodes callable, whose LEGACY_ACCESS_CODES list
 * (functions/handlers/_shared.js) still held 'DEMO' and switched it off (found
 * by the sweep-leftovers review). This runs the real callable against a fake
 * Firestore: the legacy codes are rotated, DEMO is left active, and the
 * revokeGrants cascade never touches subscriptions minted from DEMO.
 *
 * Run: node tests/sweep-leftovers-2026-11-17.test.js
 */
'use strict';
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

class HttpsError extends Error { constructor(code, msg) { super(msg || code); this.code = code; } }
const quiet = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

function fakeDb(docs) {
  const store = JSON.parse(JSON.stringify(docs));
  const queries = [];
  const ref = (p) => ({
    path: p,
    get: async () => ({ exists: p in store, data: () => Object.assign({}, store[p]) }),
    update: async (d) => { store[p] = Object.assign({}, store[p], d); },
  });
  const coll = (name) => {
    const q = (ws) => ({
      where: (f, op, v) => q(ws.concat([[f, op, v]])),
      get: async () => {
        queries.push({ name, ws });
        const docs = Object.keys(store).filter((k) => k.startsWith(name + '/') && ws.every(([f, op, v]) => (op === 'in' ? v.includes(store[k][f]) : store[k][f] === v)))
          .map((k) => ({ id: k.split('/')[1], ref: ref(k), data: () => Object.assign({}, store[k]) }));
        return { docs, empty: !docs.length, size: docs.length };
      },
    });
    const base = q([]);
    base.doc = (id) => ref(name + '/' + id);
    return base;
  };
  return { store, queries, doc: ref, collection: coll, batch: () => ({ update: (r, d) => r.update(d), set() {}, commit: async () => {} }) };
}

(async () => {
  console.log('\nrotateAccessCodes leaves the public DEMO code alone');
  const S = require(path.join(FN, 'handlers', '_shared.js'));
  ok("LEGACY_ACCESS_CODES no longer lists 'DEMO'", Array.isArray(S.LEGACY_ACCESS_CODES) && !S.LEGACY_ACCESS_CODES.includes('DEMO'), S.LEGACY_ACCESS_CODES);

  const db = fakeDb({
    'access_codes/DEMO': { active: true },
    'access_codes/NBD-2026': { active: true },
    'subscriptions/demoUser': { source: 'access_code', accessCode: 'DEMO', plan: 'foundation', status: 'active' },
    'subscriptions/oldUser': { source: 'access_code', accessCode: 'NBD-2026', plan: 'growth', status: 'active' },
  });
  const realLoad = Module._load;
  const stubs = {
    'firebase-functions/v2/https': { onCall: (o, h) => ({ __handler: h }), onRequest: (o, h) => ({ __handler: h }), HttpsError },
    'firebase-functions/v2': { logger: quiet },
    'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => 'ts', delete: () => 'del', increment: (n) => ({ inc: n }) }, Timestamp: { now: () => ({ toMillis: () => 0 }), fromMillis: (m) => ({ toMillis: () => m }) } },
    'firebase-admin/auth': { getAuth: () => ({ revokeRefreshTokens: async () => {}, getUser: async () => ({ customClaims: {} }), setCustomUserClaims: async () => {} }) },
  };
  Module._load = function (req) { if (Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req]; return realLoad.apply(this, arguments); };
  let A = null, err = null;
  try {
    delete require.cache[path.join(FN, 'handlers', 'admin.js')];
    A = require(path.join(FN, 'handlers', 'admin.js'));
  } catch (e) { err = e.message; }
  ok('admin.js loads with the stubs', !!(A && A.rotateAccessCodes && A.rotateAccessCodes.__handler), err);
  if (A && A.rotateAccessCodes) {
    let res = null;
    try { res = await A.rotateAccessCodes.__handler({ auth: { uid: 'jo', token: { role: 'admin' } }, data: { revokeGrants: true } }); } catch (e) { err = e.message; }
    ok('a legacy code (NBD-2026) is still rotated off', db.store['access_codes/NBD-2026'].active === false, { res, err });
    ok('the public DEMO code stays active (the Try Demo button keeps working)', db.store['access_codes/DEMO'].active === true, db.store['access_codes/DEMO']);
    ok('the revokeGrants cascade leaves subscriptions minted from DEMO alone', db.store['subscriptions/demoUser'].status === 'active', db.store['subscriptions/demoUser']);
  }
  Module._load = realLoad;

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
