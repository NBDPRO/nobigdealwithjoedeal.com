/**
 * tests/provision-tenant-sub-key-2026-11-15.test.js
 *
 * Every plan reader on the platform keys the plan on subscriptions/{companyId}
 * (dashboard nbd-auth, billing-gate, claudeProxy, adminAI, trackUsage, Stripe
 * checkout/portal, the lead-cap rule). scripts/provision-tenant.js seeded a
 * SLUG tenant's plan under subscriptions/{ownerUid} instead, so a tenant it
 * provisioned read as free everywhere (upgrade wall, AI refused).
 *
 * Drives the REAL script against a stubbed firebase-admin (module loader), so
 * no credentials and no network:
 *   - provisioning writes subscriptions/{companyId}, never subscriptions/{ownerUid};
 *   - --check reports subscriptions/{companyId} and flags a plan that sits
 *     under the owner uid instead.
 *
 * Run: node tests/provision-tenant-sub-key-2026-11-15.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const SCRIPT = path.join(__dirname, '..', 'scripts', 'provision-tenant.js');
const OWNER = 'ownerUidAAAAAAAAAAAAAAAAAAAA';

function fakeWorld(docs) {
  const store = Object.assign({}, docs);
  const writes = [];
  const db = {
    collection: (c) => ({
      doc: (id) => ({
        get: async () => ({ exists: (c + '/' + id) in store, data: () => store[c + '/' + id] }),
        set: async (v) => { writes.push(c + '/' + id); store[c + '/' + id] = Object.assign({}, store[c + '/' + id], v); },
      }),
    }),
    terminate: async () => {},
  };
  const user = { uid: OWNER, email: 'zz-qa-owner@example.test', customClaims: { companyId: 'oaks', role: 'company_admin' } };
  const auth = {
    getUser: async (u) => { if (u === OWNER) return user; throw new Error('not found'); },
    getUserByEmail: async () => user,
    setCustomUserClaims: async () => {},
    revokeRefreshTokens: async () => {},
  };
  return { db, auth, writes, store };
}

// One set of stubs for the whole file, routed to the run in progress. The
// script's own `main().catch(... process.exit(1))` fires after the stubbed
// exit throws; a finished run ignores it, so one run can't leak into the next.
let current = null;
const origLoad = Module._load;
const origLog = console.log;
Module._load = function (req) {
  const w = current && current.world;
  if (w && req === 'firebase-admin') return { initializeApp: () => {} };
  if (w && req === 'firebase-admin/app') return { getApps: () => [1] };
  if (w && req === 'firebase-admin/firestore') return { getFirestore: () => w.db, FieldValue: { serverTimestamp: () => 'TS' } };
  if (w && req === 'firebase-admin/auth') return { getAuth: () => w.auth };
  return origLoad.apply(this, arguments);
};
const realExit = process.exit;
process.exit = (code) => {
  if (current && !current.done) { current.done = true; current.resolve({ code, out: current.out.join('\n') }); }
  throw new Error('__exit__');
};
process.on('unhandledRejection', () => {});

function run(argv, world) {
  return new Promise((resolve) => {
    current = { world, out: [], done: false, resolve };
    const run_ = current;
    console.log = (...a) => { if (!run_.done) run_.out.push(a.join(' ')); };
    console.error = console.log;
    process.argv = ['node', SCRIPT].concat(argv);
    delete require.cache[require.resolve(SCRIPT)];
    try { require(SCRIPT); } catch (e) {
      if (e.message !== '__exit__' && !run_.done) { run_.done = true; resolve({ code: 99, out: run_.out.concat('THREW ' + e.message).join('\n') }); }
    }
  }).then((r) => {
    console.log = origLog;
    // The script's catch logs the stubbed exit after the run is over: drop that line only.
    console.error = (...a) => { if (!a.join(' ').includes('__exit__')) origLog(...a); };
    return r;
  });
}

(async () => {
  console.log('provision: the slug tenant plan lands on subscriptions/{companyId}');
  {
    const w = fakeWorld({});
    const r = await run(['--company', 'oaks', '--owner-uid', OWNER, '--name', 'Oaks', '--plan', 'professional'], w);
    ok('script exits 0', r.code === 0);
    ok('writes subscriptions/oaks', w.writes.includes('subscriptions/oaks'));
    ok('subscriptions/oaks is professional/active', !!w.store['subscriptions/oaks'] && w.store['subscriptions/oaks'].plan === 'professional' && w.store['subscriptions/oaks'].status === 'active');
    ok('never writes subscriptions/{ownerUid}', !w.writes.includes('subscriptions/' + OWNER));
    ok('reports the company-keyed doc', r.out.includes('subscriptions/oaks'));
  }

  console.log('--check: a plan stranded under the owner uid is flagged');
  {
    const w = fakeWorld({ 'companies/oaks': { ownerId: OWNER }, ['subscriptions/' + OWNER]: { plan: 'professional', status: 'active' } });
    const r = await run(['--company', 'oaks', '--owner-uid', OWNER, '--check'], w);
    ok('check exits 0', r.code === 0);
    ok('check writes nothing', w.writes.length === 0);
    ok('reports subscriptions/oaks as ABSENT', /subscriptions\/oaks:\s+ABSENT/.test(r.out));
    ok('flags the plan under the owner uid', /MISPLACED/.test(r.out));
  }

  console.log('--check: a correctly keyed tenant is not flagged');
  {
    const w = fakeWorld({ 'companies/oaks': { ownerId: OWNER }, 'subscriptions/oaks': { plan: 'professional', status: 'active' } });
    const r = await run(['--company', 'oaks', '--owner-uid', OWNER, '--check'], w);
    ok('reports the company plan', /subscriptions\/oaks:\s+\{"plan":"professional","status":"active"\}/.test(r.out));
    ok('no MISPLACED flag', !/MISPLACED/.test(r.out));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED: ' + fails.join('; ')); realExit(1); }
  realExit(0);
})();
