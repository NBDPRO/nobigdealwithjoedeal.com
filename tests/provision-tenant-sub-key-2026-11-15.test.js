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
// Only the stubbed exit's own rejection is expected; anything else fails the file.
process.on('unhandledRejection', (e) => {
  if (e && e.message === '__exit__') return;
  origLog('UNEXPECTED rejection: ' + (e && (e.stack || e.message)));
  realExit(1);
});

function run(argv, world) {
  return new Promise((resolve) => {
    // A path that never calls process.exit would hang the run: fail it instead.
    const timer = setTimeout(() => { if (!current.done) { current.done = true; resolve({ code: 'TIMEOUT', out: current.out.join('\n') }); } }, 5000);
    current = { world, out: [], done: false, resolve: (r) => { clearTimeout(timer); resolve(r); } };
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
    // --apply: provisioning is a dry run without it since 2026-11-17 (rule f).
    const r = await run(['--company', 'oaks', '--owner-uid', OWNER, '--name', 'Oaks', '--plan', 'professional', '--apply'], w);
    ok('script exits 0', r.code === 0);
    ok('writes subscriptions/oaks', w.writes.includes('subscriptions/oaks'));
    ok('subscriptions/oaks is professional/active', !!w.store['subscriptions/oaks'] && w.store['subscriptions/oaks'].plan === 'professional' && w.store['subscriptions/oaks'].status === 'active');
    ok('never writes subscriptions/{ownerUid}', !w.writes.includes('subscriptions/' + OWNER));
    ok('the success line names subscriptions/oaks', r.out.includes("✅ subscriptions/oaks = {plan:'professional'"));
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

  console.log('--check: plans under BOTH keys is not flagged (the company doc wins)');
  {
    const w = fakeWorld({ 'companies/oaks': { ownerId: OWNER }, 'subscriptions/oaks': { plan: 'team', status: 'active' }, ['subscriptions/' + OWNER]: { plan: 'professional', status: 'active' } });
    const r = await run(['--company', 'oaks', '--owner-uid', OWNER, '--check'], w);
    ok('owner sub was probed (owner line printed)', r.out.includes('owner:') && r.out.includes(OWNER));
    ok('no MISPLACED flag when the company doc exists', !/MISPLACED/.test(r.out));
  }

  console.log('--check without an owner flag uses companies/{id}.ownerId');
  {
    const w = fakeWorld({ 'companies/oaks': { ownerId: OWNER }, ['subscriptions/' + OWNER]: { plan: 'professional', status: 'active' } });
    const r = await run(['--company', 'oaks', '--check'], w);
    ok('flags MISPLACED via the company owner', /MISPLACED/.test(r.out));
  }

  console.log('--check: an Auth error is not reported as "not found"');
  {
    const w = fakeWorld({ 'companies/oaks': { ownerId: OWNER } });
    w.auth.getUser = async () => { const e = new Error('credentials'); e.code = 'app/invalid-credential'; throw e; };
    const r = await run(['--company', 'oaks', '--owner-uid', OWNER, '--check'], w);
    ok('exits non-zero', r.code === 1);
    ok('does not print "not found"', !/not found/.test(r.out));
  }

  console.log('provision: a Stripe-managed plan is never overwritten');
  {
    const live = { plan: 'growth', status: 'past_due', stripeSubscriptionId: 'sub_x' };
    const w = fakeWorld({ 'companies/oaks': { ownerId: OWNER }, 'subscriptions/oaks': live });
    const r = await run(['--company', 'oaks', '--owner-uid', OWNER, '--name', 'Oaks', '--apply'], w);
    ok('exits 0', r.code === 0);
    ok('subscriptions/oaks not written', !w.writes.includes('subscriptions/oaks'));
    ok('plan unchanged', w.store['subscriptions/oaks'].plan === 'growth' && w.store['subscriptions/oaks'].status === 'past_due');
    ok('says it skipped', /Stripe-managed/.test(r.out));
    const w2 = fakeWorld({ 'companies/oaks': { ownerId: OWNER }, 'subscriptions/oaks': Object.assign({}, live) });
    await run(['--company', 'oaks', '--owner-uid', OWNER, '--name', 'Oaks', '--apply', '--force'], w2);
    ok('--force overwrites', w2.writes.includes('subscriptions/oaks') && w2.store['subscriptions/oaks'].plan === 'professional');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED: ' + fails.join('; ')); realExit(1); }
  realExit(0);
})();
