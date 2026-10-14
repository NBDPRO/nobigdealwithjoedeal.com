/**
 * tests/owner-handoff-2026-10-12.test.js
 *
 * Company OWNER HAND-OFF (Jo's ruling 2026-10-08): transferCompanyOwnership.
 * Real handlers (handlers/admin.js with the REAL requireTeamAdmin, the real
 * member-offboarding / storage-move modules); Firestore and Auth are in-memory
 * fakes. No network. The rules half lives in
 * tests/firestore-rules.cross-tenant.test.js (HANDOFF block) and
 * tests/storage-rules.test.js (owner hand-off block).
 *
 *   A. the callable's happy path and everything it must NOT touch (no Stripe
 *      or subscription write, audit row has ids only, claims merged).
 *   B. who may call it: not an admin, not a rep/manager/viewer, not a platform
 *      admin, not the platform company, not a suspended owner, not without
 *      the explicit confirm.
 *   C. who may receive it: an ACTIVE, ENABLED company_admin of the SAME
 *      company; every refusal is one generic message (no account oracle).
 *   D. concurrency / replay / spoofing: a race that moved ownerId aborts with
 *      no roster change; a replay is a no-op; a spoofed companyId is ignored.
 *   E. money: a connected payout account refuses the hand-off; nothing under
 *      subscriptions/ or connectAccounts/ is written.
 *   F. after the hand-off: the former owner (company_admin) is not the owner
 *      (ownerOnly callables refuse them); a claim-less former owner is not an
 *      admin and cannot re-provision the company; claimInvite sees them as a
 *      member, not a solo owner.
 *   G. removing a former owner turns their login off (the uid-key fallbacks
 *      would otherwise read an enabled claim-less account as the owner), moves
 *      their records to the new owner, and never does this for an ordinary rep.
 *   H. demoted former owner: pixel-draft and agent-mcp stop reading the uid key
 *      as "owner"; billingPortalRefusal stops the solo-owner branch.
 *
 * Run: node tests/owner-handoff-2026-10-12.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// ── in-memory Firestore (admin-SDK shaped, with buffered transactions) ────
function fakeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, Object.assign({}, v)]));
  const log = [];
  let autoId = 0;
  function ref(p) {
    const parts = p.split('/');
    return {
      path: p, id: parts[parts.length - 1],
      get parent() {
        const colPath = parts.slice(0, -1).join('/');
        return { id: parts[parts.length - 2], path: colPath, parent: parts.length > 2 ? ref(parts.slice(0, -2).join('/')) : null };
      },
      get: async () => snap(p),
      update: async (d) => { if (!store.has(p)) throw new Error('NOT_FOUND ' + p); log.push('update:' + p); store.set(p, Object.assign({}, store.get(p), d)); },
      set: async (d, o) => { log.push('set:' + p); store.set(p, Object.assign({}, (o && o.merge) ? store.get(p) : {}, d)); },
      delete: async () => { log.push('delete:' + p); store.delete(p); },
      collection: (c) => db.collection(p + '/' + c),
    };
  }
  function snap(p) {
    const has = store.has(p);
    return { id: p.split('/').pop(), ref: ref(p), exists: has, data: () => (has ? Object.assign({}, store.get(p)) : undefined) };
  }
  function query(match) {
    const filters = []; let lim = Infinity;
    const q = {
      where(f, op, v) { filters.push([f, op, v]); return q; },
      limit(n) { lim = n; return q; },
      async get() {
        const docs = [];
        for (const p of [...store.keys()].sort()) {
          if (!match(p)) continue;
          const d = store.get(p);
          const pass = filters.every(([f, op, v]) => {
            const x = d[f];
            if (op === '==') return x === v;
            if (op === '>=') return x >= v;
            if (op === '<=') return x <= v;
            throw new Error('fake: op ' + op);
          });
          if (pass) docs.push(snap(p));
          if (docs.length >= lim) break;
        }
        return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
      },
    };
    return q;
  }
  const db = {
    store, log,
    doc: (p) => ref(p),
    collection: (c) => {
      const depth = c.split('/').length;
      const q = query((p) => p.startsWith(c + '/') && p.split('/').length === depth + 1);
      q.doc = (id) => ref(c + '/' + (id || ('auto' + (++autoId))));
      q.add = async (d) => { const id = 'auto' + (++autoId); store.set(c + '/' + id, Object.assign({}, d)); log.push('add:' + c); return ref(c + '/' + id); };
      return q;
    },
    collectionGroup: (name) => query((p) => { const s = p.split('/'); return s.length % 2 === 0 && s[s.length - 2] === name; }),
    // Writes are buffered and applied only if the callback returns: a throw
    // leaves the store untouched, like a real aborted transaction.
    async runTransaction(fn) {
      const ops = [];
      const tx = {
        get: async (r) => r.get(),
        update(r, d) { ops.push(() => r.update(d)); return tx; },
        set(r, d, o) { ops.push(() => r.set(d, o)); return tx; },
        delete(r) { ops.push(() => r.delete()); return tx; },
      };
      const out = await fn(tx);
      for (const op of ops) await op();
      return out;
    },
    batch() {
      const ops = [];
      return {
        update(r, d) { ops.push(() => r.update(d)); return this; },
        set(r, d, o) { ops.push(() => r.set(d, o)); return this; },
        delete(r) { ops.push(() => r.delete()); return this; },
        async commit() { for (const op of ops) await op(); },
      };
    },
  };
  return db;
}

function fakeAuth(users, events, hooks) {
  return {
    async getUser(uid) {
      if (!users[uid]) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
      return Object.assign({ uid }, users[uid]);
    },
    async getUserByEmail(email) {
      const uid = Object.keys(users).find((u) => users[u].email === email);
      if (!uid) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
      return Object.assign({ uid }, users[uid]);
    },
    async setCustomUserClaims(uid, c) {
      events.push('claims:' + uid);
      users[uid].customClaims = c;
      if (hooks && hooks.onClaims) hooks.onClaims(uid, c);
    },
    async revokeRefreshTokens(uid) { events.push('revokeRefresh:' + uid); },
    async updateUser(uid, u) {
      if (hooks && hooks.updateUserFail && hooks.updateUserFail()) throw new Error('auth backend unavailable');
      events.push('updateUser:' + uid + ':' + JSON.stringify(u)); Object.assign(users[uid], u);
    },
  };
}

function baseStubs(db, auth) {
  return {
    'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
    'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
    'firebase-functions/v2/identity': { beforeUserCreated: (o, h) => ({ __handler: h }), beforeUserSignedIn: (o, h) => ({ __handler: h }) },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
    './heartbeat': { onSchedule: (op, h) => ({ __handler: h }) },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => '__ts__', increment: (n) => ({ __inc: n }), delete: () => '__del__' },
      Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) },
    },
    'firebase-admin/auth': { getAuth: () => auth },
    'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ deleteFiles: async () => {} }) }) },
    './upstash-ratelimit': { httpRateLimit: async () => true, enforceRateLimit: async () => ({}) },
    './integrations/upstash-ratelimit': { enforceRateLimit: async () => ({ allowed: true }), httpRateLimit: async () => true },
    '../shared': { callableRateLimit: async () => {} },
    '../rate-limit-policy': { guardCallable: (n, h) => h },
  };
}

function loadWith(file, stubs) {
  const real = Module._load;
  const hook = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.apply(this, arguments);
  };
  const abs = path.join(FN, file);
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(FN) && !k.includes('node_modules')) delete require.cache[k];
  }
  Module._load = hook;
  let mod;
  try { mod = require(abs); } finally { Module._load = real; }
  return {
    mod,
    run: async (fn) => { Module._load = hook; try { return await fn(); } finally { Module._load = real; } },
  };
}

// The company id IS the owner's uid (the legacy / self-serve convention):
// the dangerous shape, because the uid key keeps meaning "this company".
function seed(extra) {
  return Object.assign({
    'companies/ow1': { ownerId: 'ow1', name: 'Acme Roofing' },
    'subscriptions/ow1': { status: 'active', plan: 'team', stripeCustomerId: 'cus_X', stripeSubscriptionId: 'sub_X' },
    // The former owner's confirmed lead-alert address (2026-10-13): must not survive a hand-off.
    'alertRecipients/ow1': { confirmed: { k1: { email: 'former-inbox@x.test', requestedBy: 'ow1' } } },
    'companies/ow1/members/adm1@x.test': { uid: 'adm1', email: 'adm1@x.test', status: 'active', role: 'company_admin' },
    'companies/ow1/members/adm2@x.test': { uid: 'adm2', email: 'adm2@x.test', status: 'active', role: 'company_admin' },
    'companies/ow1/members/rep1@x.test': { uid: 'rep1', email: 'rep1@x.test', status: 'active', role: 'sales_rep' },
    'companies/ow1/members/off1@x.test': { uid: 'off1', email: 'off1@x.test', status: 'deactivated', role: 'company_admin' },
    'companies/ow1/members/inv1@x.test': { email: 'inv1@x.test', status: 'invited', role: 'company_admin' },
    'companies/co-b': { ownerId: 'ownB', name: 'Other Co' },
    'leads/L1': { userId: 'ow1', companyId: 'ow1', name: 'Customer One' },
    'leads/L2': { userId: 'rep1', companyId: 'ow1', name: 'Customer Two' },
  }, extra || {});
}
function users() {
  return {
    ow1: { email: 'ow1@x.test', customClaims: { companyId: 'ow1', role: 'company_admin', plan: 'team' } },
    adm1: { email: 'adm1@x.test', customClaims: { companyId: 'ow1', role: 'company_admin' } },
    adm2: { email: 'adm2@x.test', customClaims: { companyId: 'ow1', role: 'company_admin' } },
    rep1: { email: 'rep1@x.test', customClaims: { companyId: 'ow1', role: 'sales_rep' } },
    mgr1: { email: 'mgr1@x.test', customClaims: { companyId: 'ow1', role: 'manager' } },
    vw1: { email: 'vw1@x.test', customClaims: { companyId: 'ow1', role: 'viewer' } },
    off1: { email: 'off1@x.test', disabled: true, customClaims: { companyId: 'ow1', role: 'company_admin' } },
    ownB: { email: 'ob@x.test', customClaims: { companyId: 'co-b', role: 'company_admin' } },
    admB: { email: 'ab@x.test', customClaims: { companyId: 'co-b', role: 'company_admin' } },
    jo: { email: 'jo@x.test', customClaims: { role: 'admin', owner: true } },
  };
}

function rig(seedExtra, usersOverride, hooks) {
  const events = [];
  const db = fakeDb(seed(seedExtra));
  const us = Object.assign(users(), usersOverride || {});
  const auth = fakeAuth(us, events, hooks);
  const L = loadWith('handlers/admin.js', baseStubs(db, auth));
  const callerToken = (uid) => Object.assign({ email: us[uid] && us[uid].email }, (us[uid] && us[uid].customClaims) || {});
  async function call(name, uid, data, tokenOverride) {
    let out = null, err = null;
    try {
      out = await L.run(() => L.mod[name].__handler({ auth: { uid, token: tokenOverride || callerToken(uid) }, data }));
    } catch (e) { err = e; }
    return { out, err };
  }
  return { db, users: us, events, L, call, callerToken };
}
const snapshot = (db) => JSON.stringify([...db.store.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
const audits = (db) => [...db.store.entries()].filter(([k]) => /^audit_log\//.test(k)).map(([, v]) => v);
const REFUSAL = 'That person is not an active admin on your team. Make them an admin first.';

(async () => {
  // ═════════════════════════════════════════════════════════════════════
  console.log('A. happy path: owner hands the company to an active admin');
  {
    const R = rig();
    const { out, err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const s = R.db.store;
    ok('succeeds and names both uids', !err && out && out.success === true && out.ownerId === 'adm1' && out.previousOwnerId === 'ow1' && out.companyId === 'ow1', err && err.message);
    const co = s.get('companies/ow1');
    ok('companies/ow1.ownerId moved to the new owner; provenance stamped',
      co.ownerId === 'adm1' && co.previousOwnerId === 'ow1' && co.ownershipTransferredBy === 'ow1' && !!co.ownershipTransferredAt, JSON.stringify(co));
    ok('the company id did NOT change (no data, billing or Stripe key moved)', s.has('companies/ow1') && s.has('subscriptions/ow1') && !s.has('companies/adm1'));
    ok('the former owner\'s confirmed lead-alert address is dropped (the new owner re-confirms)', !s.has('alertRecipients/ow1'));
    ok('new owner holds no roster row (an owner is not a seat)', !s.has('companies/ow1/members/adm1@x.test'));
    const fr = s.get('companies/ow1/members/ow1@x.test');
    ok('former owner is on the roster as an active company_admin', !!fr && fr.uid === 'ow1' && fr.status === 'active' && fr.role === 'company_admin' && fr.activatedVia === 'owner-handoff', JSON.stringify(fr));
    ok('seat count unchanged: one row out, one row in',
      [...s.keys()].filter((k) => /^companies\/ow1\/members\//.test(k)).length === 5, [...s.keys()].filter((k) => /^companies\/ow1\/members\//.test(k)).join(','));
    ok('former owner claims merged: still companyId=ow1, role company_admin, plan claim kept',
      R.users.ow1.customClaims.companyId === 'ow1' && R.users.ow1.customClaims.role === 'company_admin' && R.users.ow1.customClaims.plan === 'team');
    ok('new owner claims explicit company_admin of ow1', R.users.adm1.customClaims.companyId === 'ow1' && R.users.adm1.customClaims.role === 'company_admin');
    ok("users/{uid} profiles agree for both", s.get('users/ow1').role === 'company_admin' && s.get('users/adm1').companyId === 'ow1');
    const a = audits(R.db);
    ok('exactly one audit row, ids only', a.length === 1 && a[0].type === 'company_ownership_transferred' && a[0].ids.from === 'ow1' && a[0].ids.to === 'adm1' && a[0].by === 'ow1', JSON.stringify(a));
    ok('...and the audit row carries no email / name', !/@x\.test|Acme|Customer/.test(JSON.stringify(a)));
    ok('no subscription, Stripe or connect doc was written', !R.db.log.some((e) => /subscriptions\/|connectAccounts\/|stripe/i.test(e)), R.db.log.join(' '));
    ok('company records are untouched (leads keep their authors)', s.get('leads/L1').userId === 'ow1' && s.get('leads/L2').userId === 'rep1');
    ok('callable shape: App Check enforced, CORS list, 60s', R.L.mod.transferCompanyOwnership.__opts.enforceAppCheck === true
      && Array.isArray(R.L.mod.transferCompanyOwnership.__opts.cors) && R.L.mod.transferCompanyOwnership.__opts.cors.length > 0);
  }
  // by uid as well as by email
  {
    const R = rig();
    const { out, err } = await R.call('transferCompanyOwnership', 'ow1', { uid: 'adm2', confirm: true });
    ok('works by target uid too', !err && out && out.ownerId === 'adm2' && R.db.store.get('companies/ow1').ownerId === 'adm2', err && err.message);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('B. who may call it');
  {
    const R = rig();
    const before = snapshot(R.db);
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test' });
    ok('no confirm: failed-precondition, nothing changed', !!err && err.code === 'failed-precondition' && snapshot(R.db) === before && !R.events.length, err && err.code);
    const r2 = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: 'yes' });
    ok('confirm must be the boolean true (a truthy string does not count)', !!r2.err && r2.err.code === 'failed-precondition' && snapshot(R.db) === before);
  }
  for (const [who, why] of [['adm2', 'another company_admin'], ['mgr1', 'a manager'], ['rep1', 'a sales_rep'], ['vw1', 'a viewer'], ['ownB', "another company's owner (spoofs data.companyId)"]]) {
    const R = rig();
    const before = snapshot(R.db);
    const { err } = await R.call('transferCompanyOwnership', who, { email: 'adm1@x.test', confirm: true, companyId: 'ow1' });
    ok(why + ' cannot hand the company off: ' + (err ? err.code : 'ALLOWED'),
      !!err && err.code === 'permission-denied' || (who === 'ownB' && !!err), err && (err.code + ' ' + err.message));
    ok('...' + why + ': nothing changed, no claim written', snapshot(R.db) === before && R.events.length === 0, R.events.join(','));
  }
  {
    // platform admin who happens to own a company (Jo): refused, and the
    // platform-admin claim is never rewritten
    const R = rig({ 'companies/jo': { ownerId: 'jo', name: 'NBD' }, 'companies/jo/members/adm1@x.test': { uid: 'adm1', status: 'active', role: 'company_admin' } },
      { jo: { email: 'jo@x.test', customClaims: { role: 'admin', owner: true, companyId: 'jo' } } });
    const { err } = await R.call('transferCompanyOwnership', 'jo', { email: 'adm1@x.test', confirm: true });
    ok('a platform admin / platform owner is refused', !!err && err.code === 'permission-denied' && R.users.jo.customClaims.role === 'admin' && R.db.store.get('companies/jo').ownerId === 'jo', err && err.code);
  }
  {
    // the platform company itself (NBD id), even for a non-admin caller
    const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
    const R = rig({ ['companies/' + NBD]: { ownerId: NBD, name: 'NBD' }, ['companies/' + NBD + '/members/adm1@x.test']: { uid: 'adm1', status: 'active', role: 'company_admin' } },
      { [NBD]: { email: 'nbd@x.test', customClaims: { companyId: NBD, role: 'company_admin' } }, adm1: { email: 'adm1@x.test', customClaims: { companyId: NBD, role: 'company_admin' } } });
    const { err } = await R.call('transferCompanyOwnership', NBD, { email: 'adm1@x.test', confirm: true });
    ok('the platform company cannot be handed off from the dashboard', !!err && err.code === 'permission-denied' && R.db.store.get('companies/' + NBD).ownerId === NBD, err && err.code);
  }
  {
    // owner's Auth account suspended: an unexpired token must not drive it
    const R = rig(null, { ow1: { email: 'ow1@x.test', disabled: true, customClaims: { companyId: 'ow1', role: 'company_admin' } } });
    const before = snapshot(R.db);
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    ok('a suspended owner cannot hand off (Auth is authoritative)', !!err && err.code === 'permission-denied' && snapshot(R.db) === before);
  }
  {
    const R = rig();
    let err = null;
    try { await R.L.run(() => R.L.mod.transferCompanyOwnership.__handler({ auth: null, data: { email: 'adm1@x.test', confirm: true } })); } catch (e) { err = e; }
    ok('unauthenticated is refused', !!err && err.code === 'unauthenticated');
  }
  {
    // a solo owner with no company doc: nobody to hand to
    const R = rig(null, { solo9: { email: 's9@x.test', customClaims: {} } });
    const { err } = await R.call('transferCompanyOwnership', 'solo9', { email: 'adm1@x.test', confirm: true });
    ok('a solo owner with no company doc is refused', !!err && /permission-denied|failed-precondition/.test(err.code), err && err.code);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('C. who may receive it (one generic refusal, no oracle)');
  const targets = [
    ['a sales_rep', { email: 'rep1@x.test' }],
    ['another company\'s admin', { email: 'ab@x.test' }],
    ['a disabled account', { email: 'off1@x.test' }],
    ['a pending invite with no account', { email: 'inv1@x.test' }],
    ['an unknown email', { email: 'nobody@x.test' }],
    ['an unknown uid', { uid: 'ghost-uid' }],
    ['a platform admin', { email: 'jo@x.test' }],
  ];
  const msgs = new Set();
  for (const [name, t] of targets) {
    const R = rig();
    const before = snapshot(R.db);
    const { err } = await R.call('transferCompanyOwnership', 'ow1', Object.assign({ confirm: true }, t));
    ok(name + ' is refused, nothing changed', !!err && err.code === 'failed-precondition' && snapshot(R.db) === before, err && (err.code + ' ' + err.message));
    if (err) msgs.add(err.message);
  }
  ok('every "not eligible" shape gets the SAME message', msgs.size === 1 && msgs.has(REFUSAL), [...msgs].join(' | '));
  {
    const R = rig();
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'ow1@x.test', confirm: true });
    ok('cannot hand the company to yourself', !!err && err.code === 'failed-precondition' && R.db.store.get('companies/ow1').ownerId === 'ow1');
  }
  {
    // roster row still says company_admin but the account's claims were
    // lowered (drift): the claims are what the rules and callables read
    const R = rig(null, { adm2: { email: 'adm2@x.test', customClaims: { companyId: 'ow1', role: 'sales_rep' } } });
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm2@x.test', confirm: true });
    ok('claims drift (row says admin, claims say rep): refused, ownerId unchanged',
      !!err && err.code === 'failed-precondition' && R.db.store.get('companies/ow1').ownerId === 'ow1', err && err.code);
  }
  {
    // claims say company_admin but the roster row was deactivated / re-roled
    // between the pre-checks and the transaction
    for (const [name, patch] of [['row deactivated', { status: 'deactivated' }], ['row demoted', { role: 'sales_rep' }], ['row uid mismatch', { uid: 'someone-else' }]]) {
      const R = rig({ 'companies/ow1/members/adm1@x.test': Object.assign({ uid: 'adm1', email: 'adm1@x.test', status: 'active', role: 'company_admin' }, patch) });
      const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
      ok('transaction re-checks the roster (' + name + '): refused, ownerId unchanged',
        !!err && err.code === 'failed-precondition' && R.db.store.get('companies/ow1').ownerId === 'ow1'
        && !R.db.store.has('companies/ow1/members/ow1@x.test'), err && err.code);
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('D. concurrency, replay, spoofing');
  {
    // ownerId moves between the pre-checks and the transaction (a second hand-off won)
    const R = rig(null, null, { onClaims: (uid) => { if (uid === 'ow1') R.db.store.set('companies/ow1', Object.assign({}, R.db.store.get('companies/ow1'), { ownerId: 'adm2' })); } });
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const s = R.db.store;
    ok('a race that moved ownerId aborts: no second owner, no roster change',
      !!err && err.code === 'aborted' && s.get('companies/ow1').ownerId === 'adm2' && s.has('companies/ow1/members/adm1@x.test')
      && !s.has('companies/ow1/members/ow1@x.test') && audits(R.db).length === 0, err && err.code);
  }
  {
    const R = rig();
    const first = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const after1 = snapshot(R.db);
    const claimsEvents = R.events.length;
    // the former owner's token still says company_admin of ow1
    const replay = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    ok('replay by the former owner is a no-op success', !first.err && !replay.err && replay.out.replayed === true && snapshot(R.db) === after1 && R.events.length === claimsEvents, replay.err && replay.err.message);
    const other = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm2@x.test', confirm: true });
    ok('...but the former owner cannot name a different new owner', !!other.err && other.err.code === 'permission-denied' && R.db.store.get('companies/ow1').ownerId === 'adm1');
    const back = await R.call('transferCompanyOwnership', 'adm2', { email: 'ow1@x.test', confirm: true });
    ok('another company_admin cannot hand it anywhere either', !!back.err && back.err.code === 'permission-denied');
    // the new owner CAN hand it on (and back)
    const onward = await R.call('transferCompanyOwnership', 'adm1', { email: 'ow1@x.test', confirm: true });
    ok('the new owner can hand it back to the former owner', !onward.err && R.db.store.get('companies/ow1').ownerId === 'ow1' && R.db.store.get('companies/ow1').previousOwnerId === 'adm1', onward.err && onward.err.message);
  }
  {
    // companyId in the payload is ignored: the tenant comes from the claims
    const R = rig();
    const { out } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true, companyId: 'co-b', ownerId: 'admB' });
    ok('spoofed companyId / ownerId in the payload are ignored', !!out && out.companyId === 'ow1' && R.db.store.get('companies/co-b').ownerId === 'ownB' && R.db.store.get('companies/ow1').ownerId === 'adm1');
  }
  {
    // a target in another company, addressed by uid
    const R = rig();
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { uid: 'admB', confirm: true });
    ok('another company\'s admin addressed by uid: refused', !!err && err.message === REFUSAL && R.db.store.get('companies/ow1').ownerId === 'ow1');
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('E. money does not move');
  {
    const R = rig({ 'connectAccounts/ow1': { accountId: 'acct_123', chargesEnabled: true } });
    const before = snapshot(R.db);
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    ok('a connected payout account refuses the hand-off, nothing changed',
      !!err && err.code === 'failed-precondition' && /payout/i.test(err.message) && snapshot(R.db) === before && R.events.length === 0, err && err.message);
    const R2 = rig({ 'connectAccounts/ow1': { status: 'failed' } });
    const ok2 = await R2.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    ok('(control) a connect doc with no account id does not block', !ok2.err && ok2.out.success === true, ok2.err && ok2.err.message);
  }
  {
    const src = require('fs').readFileSync(path.join(FN, 'handlers', 'admin.js'), 'utf8');
    const a = src.indexOf('exports.transferCompanyOwnership');
    const b = src.indexOf('async function beginMemberRemoval');
    const body = src.slice(a, b).replace(/\/\/[^\n]*/g, '');
    ok('the callable never touches Stripe or the subscription doc',
      !/getStripe|require\(['"]stripe|stripe\.(customers|subscriptions|accounts|paymentMethods)|subscriptions\//i.test(body));
    ok('the callable is rate limited', /callableRateLimit\(request, 'transferCompanyOwnership'/.test(body));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('F. after the hand-off');
  {
    const R = rig();
    await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const H = loadWith('handlers/_shared.js', baseStubs(R.db, fakeAuth(R.users, [])));
    const req = (uid, claims) => ({ auth: { uid, token: claims } });
    // owner-only callables (seat money, Connect, publish) go to the new owner only
    let e1 = null, r1 = null;
    try { r1 = await H.run(() => H.mod.requireTeamAdmin(req('adm1', { companyId: 'ow1', role: 'company_admin' }), null, { ownerOnly: true })); } catch (e) { e1 = e; }
    ok('new owner passes an ownerOnly gate as isOwner', !e1 && r1.isOwner === true, e1 && e1.message);
    let e2 = null;
    try { await H.run(() => H.mod.requireTeamAdmin(req('ow1', { companyId: 'ow1', role: 'company_admin' }), null, { ownerOnly: true })); } catch (e) { e2 = e; }
    ok('former owner (company_admin) is REFUSED at an ownerOnly gate', !!e2 && e2.code === 'permission-denied', e2 && e2.code);
    let r3 = null, e3 = null;
    try { r3 = await H.run(() => H.mod.requireTeamAdmin(req('ow1', { companyId: 'ow1', role: 'company_admin' }))); } catch (e) { e3 = e; }
    ok('...but still passes the ordinary company_admin gate, as a non-owner', !e3 && r3.isOwner === false, e3 && e3.message);
    // CLAIM-LESS former owner (claims stripped, account still enabled): the uid key
    let e4 = null;
    try { await H.run(() => H.mod.requireTeamAdmin(req('ow1', {}))); } catch (e) { e4 = e; }
    ok('a claim-less former owner is NOT an admin (uid == company id no longer means owner)', !!e4 && e4.code === 'permission-denied', e4 && e4.code);
    let e5 = null;
    try { await H.run(() => H.mod.requireTeamAdmin(req('ow1', { role: 'sales_rep' }))); } catch (e) { e5 = e; }
    ok('...nor with a lower role and no companyId claim', !!e5 && e5.code === 'permission-denied');
    // positive control: a solo owner whose company doc is missing is still the owner
    const R2 = rig({}, { solo2: { email: 's2@x.test', customClaims: {} } });
    const H2 = loadWith('handlers/_shared.js', baseStubs(R2.db, fakeAuth(R2.users, [])));
    let r6 = null, e6 = null;
    try { r6 = await H2.run(() => H2.mod.requireTeamAdmin({ auth: { uid: 'solo2', token: {} } })); } catch (e) { e6 = e; }
    ok('control: a solo owner with no company doc still passes as the owner', !e6 && r6.isOwner === true, e6 && e6.message);
  }
  {
    // createCompany cannot be used to take the company back
    const R = rig();
    await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const P = loadWith('handlers/provisioning.js', baseStubs(R.db, fakeAuth(R.users, [])));
    let err = null;
    try { await P.run(() => P.mod.createCompany.__handler({ auth: { uid: 'ow1', token: {} }, data: { name: 'Mine Now' } })); } catch (e) { err = e; }
    ok('createCompany by a claim-less former owner is a conflict, ownerId untouched',
      !!err && err.code === 'failed-precondition' && R.db.store.get('companies/ow1').ownerId === 'adm1', err && err.code);
  }
  {
    // claimInvite: a former owner is a member of their old company
    const R = rig();
    await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const I = loadWith('handlers/invites.js', baseStubs(R.db, fakeAuth(R.users, [])));
    let out = null, err = null;
    try {
      out = await I.run(() => I.mod.claimInvite.__handler({ auth: { uid: 'ow1', token: { email: 'ow1@x.test', companyId: 'ow1', role: 'company_admin' } }, data: { confirm: true } }));
    } catch (e) { err = e; }
    ok('claimInvite by the former owner (even confirm:true) answers already_member', !err && out && out.claimed === false && out.reason === 'already_member', err ? err.message : JSON.stringify(out));
    // control: a solo owner whose company doc names them still gets the preview path (not already_member)
    const I2 = loadWith('handlers/invites.js', baseStubs(R.db, fakeAuth(R.users, [])));
    let out2 = null;
    try {
      out2 = await I2.run(() => I2.mod.claimInvite.__handler({ auth: { uid: 'adm1', token: { email: 'adm1@x.test', companyId: 'ow1', role: 'company_admin' } }, data: {} }));
    } catch (e) { out2 = { err: e.message }; }
    ok('control: the NEW owner (claims point at ow1 != own uid) is also a member, not a free agent', out2 && out2.reason === 'already_member', JSON.stringify(out2));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('G. removing a former owner');
  {
    const R = rig();
    await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    R.events.length = 0;
    const { out, err } = await R.call('removeMember', 'adm1', { email: 'ow1@x.test' });
    const u = R.users.ow1;
    ok('new owner removes the former owner', !err && out && out.removed === true, err && err.message);
    ok('claims stripped (companyId/role gone), billing claims kept', !('companyId' in u.customClaims) && !('role' in u.customClaims) && u.customClaims.plan === 'team', JSON.stringify(u.customClaims));
    ok('login TURNED OFF: the account would otherwise read as the company owner by uid', u.disabled === true && out.signInDisabled === true, JSON.stringify(u));
    ok('refresh tokens revoked', R.events.includes('revokeRefresh:ow1'));
    ok("their records moved to the new owner (company data, not the person, stays)", R.db.store.get('leads/L1').userId === 'adm1', R.db.store.get('leads/L1').userId);
    ok("a teammate's records stay with the teammate", R.db.store.get('leads/L2').userId === 'rep1');
    ok('roster row gone', !R.db.store.has('companies/ow1/members/ow1@x.test'));
    ok('the company still belongs to the new owner', R.db.store.get('companies/ow1').ownerId === 'adm1');
  }
  {
    const R = rig();
    const { out, err } = await R.call('removeMember', 'ow1', { email: 'rep1@x.test' });
    ok('control: removing an ordinary rep does NOT disable their login', !err && out.removed === true && !R.users.rep1.disabled && out.signInDisabled === false, err && err.message);
  }
  {
    const R = rig();
    await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const a = await R.call('removeMember', 'ow1', { email: 'adm1@x.test' });
    ok('the former owner (now company_admin) cannot remove the new owner (no roster row: nothing to remove)',
      !a.err && a.out.removed === false && R.users.adm1.customClaims.companyId === 'ow1' && R.users.adm1.disabled !== true
      && R.db.store.get('companies/ow1').ownerId === 'adm1', a.err && a.err.message);
    const d = await R.call('deactivateUser', 'ow1', { email: 'adm1@x.test' });
    ok('...nor disable them', !!d.err && R.users.adm1.disabled !== true, d.err && d.err.message);
    const r = await R.call('updateUserRole', 'ow1', { email: 'adm1@x.test', role: 'viewer' });
    ok('...nor demote them', !!r.err && R.users.adm1.customClaims.role === 'company_admin', r.err && r.err.message);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('H. a demoted former owner keeps companyId == uid in claims');
  {
    const real = require(path.join(FN, 'pixel-draft.js'));
    const callerOf = real._internal.callerOf;
    const c = (uid, claims) => callerOf({ auth: { uid, token: claims } });
    ok('pixel-draft: solo owner (no role) is staff', c('ow1', { companyId: 'ow1' }).staff === true);
    ok('pixel-draft: former owner still company_admin is staff', c('ow1', { companyId: 'ow1', role: 'company_admin' }).staff === true);
    ok('pixel-draft: former owner demoted to sales_rep is NOT staff', c('ow1', { companyId: 'ow1', role: 'sales_rep' }).staff === false);
    ok('pixel-draft: an ordinary rep is not staff', c('rep1', { companyId: 'ow1', role: 'sales_rep' }).staff === false);
  }
  {
    const A = require(path.join(FN, 'agent-mcp.js'))._internal.callerOf;
    const c = (uid, claims) => A({ auth: { uid, token: claims } });
    ok('agent-mcp: solo owner (no role) administers bots', c('ow1', {}).isAdmin === true);
    ok('agent-mcp: former owner still company_admin administers bots', c('ow1', { companyId: 'ow1', role: 'company_admin' }).isAdmin === true);
    ok('agent-mcp: former owner demoted to manager does NOT administer bots', c('ow1', { companyId: 'ow1', role: 'manager' }).isAdmin === false);
    ok('agent-mcp: former owner demoted to sales_rep does NOT', c('ow1', { companyId: 'ow1', role: 'sales_rep' }).isAdmin === false);
    ok('agent-mcp: former owner demoted to viewer does NOT', c('ow1', { companyId: 'ow1', role: 'viewer' }).isAdmin === false);
  }
  {
    const { billingPortalRefusal } = require(path.join(FN, 'shared.js'));
    ok('billing portal: solo owner, no company doc: allowed', billingPortalRefusal({ uid: 'u1' }, null) === null);
    ok('billing portal: owner by ownerId: allowed', billingPortalRefusal({ uid: 'adm1', companyId: 'ow1', role: 'company_admin' }, 'adm1') === null);
    ok('billing portal: claim-less former owner (uid == companyId, ownerId is someone else): REFUSED',
      !!billingPortalRefusal({ uid: 'ow1' }, 'adm1') && billingPortalRefusal({ uid: 'ow1' }, 'adm1').status === 403);
    ok('billing portal: same with companyId claim == uid and no role: REFUSED', !!billingPortalRefusal({ uid: 'ow1', companyId: 'ow1' }, 'adm1'));
    ok('billing portal: former owner still company_admin: allowed (any company_admin may, existing decision)', billingPortalRefusal({ uid: 'ow1', companyId: 'ow1', role: 'company_admin' }, 'adm1') === null);
    ok('billing portal: demoted former owner: REFUSED', !!billingPortalRefusal({ uid: 'ow1', companyId: 'ow1', role: 'sales_rep' }, 'adm1'));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('I. review findings OPEN-1..8 (2026-10-12)');
  const TG = require(path.join(FN, 'tenant-guard.js'));
  {
    // OPEN-2: the guard itself
    const db = fakeDb(seed({ 'companies/ow1': { ownerId: 'adm1', previousOwnerId: 'ow1' }, 'companies/soloDoc': { ownerId: 'soloDoc' } }));
    TG._resetCache();
    ok('guard: claim-less token, company doc names someone else: GHOST', await TG.isGhost('ow1', {}, db) === true);
    TG._resetCache();
    ok('guard: with a companyId claim: not a ghost (a member)', await TG.isGhost('ow1', { companyId: 'ow1', role: 'company_admin' }, db) === false);
    TG._resetCache();
    ok('guard: solo owner with no company doc: not a ghost', await TG.isGhost('solo9', {}, db) === false);
    TG._resetCache();
    ok('guard: solo owner whose company doc names them: not a ghost', await TG.isGhost('soloDoc', {}, db) === false);
    TG._resetCache();
    ok('guard: a platform admin is never a ghost', await TG.isGhost('ow1', { role: 'admin' }, db) === false);
    TG._resetCache();
    let e = null;
    try { await TG.assertNotGhost({ auth: { uid: 'ow1', token: {} } }, db); } catch (x) { e = x; }
    ok('assertNotGhost refuses with permission-denied', !!e && e.code === 'permission-denied');
    const refusal = await TG.ghostRefusal({ uid: 'ow1' }, db);
    ok('ghostRefusal (onRequest shape) answers 403', !!refusal && refusal.status === 403);
    TG._resetCache();
    const throwing = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('boom'); } }) }) };
    ok('a Firestore read failure fails OPEN (a solo owner is not locked out by an outage)', await TG.isGhost('ow1', {}, throwing) === false);
    TG._resetCache();
  }
  {
    // wiring: the shared choke point and the callables named in the review
    const R = rig({ 'companies/ow1': { ownerId: 'adm1', previousOwnerId: 'ow1' } });
    TG._resetCache();
    const S = loadWith('shared.js', baseStubs(R.db, fakeAuth(R.users, [])));
    let e = null;
    try { await S.run(() => S.mod.callableRateLimit({ auth: { uid: 'ow1', token: {} } }, 'x', 5, 1000)); } catch (x) { e = x; }
    ok('callableRateLimit (the shared callable gate) refuses a ghost', !!e && e.code === 'permission-denied', e && e.code);
    TG._resetCache();
    let e2 = null;
    try { await S.run(() => S.mod.callableRateLimit({ auth: { uid: 'ow1', token: { companyId: 'ow1', role: 'company_admin' } } }, 'x', 5, 1000)); } catch (x) { e2 = x; }
    ok('...and passes the same account once it carries its claims (control)', !e2, e2 && e2.message);
    TG._resetCache();
    for (const [file, names] of [['agent-mcp.js', ['createAgentKey', 'listAgentKeys', 'revokeAgentKey', 'saveAgentBot']], ['pixel-draft.js', ['fileLeadTextDraft']], ['social-studio.js', ['socialEligibleJobs', 'socialDraftFromJob', 'socialApprovePost', 'socialPlanWeeks']]]) {
      const M = loadWith(file, baseStubs(R.db, fakeAuth(R.users, [])));
      for (const n of names) {
        TG._resetCache();
        let err = null;
        try { await M.run(() => M.mod[n].__handler({ auth: { uid: 'ow1', token: {} }, data: { leadId: 'L1', template: 'x', botId: 'dana', postId: 'p' } })); } catch (x) { err = x; }
        ok(file + ' ' + n + ': a claim-less former owner is refused', !!err && err.code === 'permission-denied' && /no longer belongs/.test(err.message), err ? err.code + ' ' + err.message : 'ran');
      }
    }
    TG._resetCache();
    const M2 = loadWith('lead-brief.js', baseStubs(R.db, fakeAuth(R.users, [])));
    let e3 = null;
    try { await M2.run(() => M2.mod.leadBrief.__handler({ auth: { uid: 'ow1', token: {} }, data: {} })); } catch (x) { e3 = x; }
    ok('lead-brief leadBrief: refused', !!e3 && e3.code === 'permission-denied', e3 && e3.code);
    TG._resetCache();
  }
  {
    // OPEN-1: social-studio treats company===uid as owner, never for a lower role
    const SS = require(path.join(FN, 'social-studio.js'))._test.requireSocialManager;
    const t = (claims) => { try { return SS({ auth: { uid: 'ow1', token: claims } }, (x) => x.role === 'admin'); } catch (x) { return x; } };
    ok('social: demoted former owner (sales_rep, companyId == uid) is refused', t({ companyId: 'ow1', role: 'sales_rep' }).code === 'permission-denied');
    ok('social: demoted to manager is refused', t({ companyId: 'ow1', role: 'manager' }).code === 'permission-denied');
    ok('social: former owner still company_admin is allowed', t({ companyId: 'ow1', role: 'company_admin' }).companyId === 'ow1');
    ok('social: a solo owner (no role) is allowed', t({}).companyId === 'ow1');
  }
  {
    // OPEN-3: disable BEFORE the claim strip; a retry finishes the job
    let failOnce = true;
    const R = rig(null, null, { updateUserFail: () => { if (failOnce) { failOnce = false; return true; } return false; } });
    await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const first = await R.call('removeMember', 'adm1', { email: 'ow1@x.test' });
    ok('disable fails: the removal errors and NOTHING was stripped (claims intact, login not half-removed)',
      !!first.err && R.users.ow1.customClaims.companyId === 'ow1' && R.users.ow1.disabled !== true && R.db.store.get('leads/L1').userId === 'ow1', first.err ? first.err.message : 'no error');
    const second = await R.call('removeMember', 'adm1', { email: 'ow1@x.test' });
    ok('the retry completes: disabled, claims stripped, records moved', !second.err && second.out.signInDisabled === true && R.users.ow1.disabled === true
      && !('companyId' in R.users.ow1.customClaims) && R.db.store.get('leads/L1').userId === 'adm1', second.err && second.err.message);
  }
  {
    // ...and a removal that already stripped the claims but never disabled (the old order)
    const R = rig();
    await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    R.users.ow1.customClaims = { plan: 'team' }; // stripped, still enabled
    const out = await R.call('removeMember', 'adm1', { email: 'ow1@x.test' });
    ok('a stripped-but-enabled former owner can still be removed (retry path): login turned off', !out.err && R.users.ow1.disabled === true, out.err && out.err.message);
    const rep = rig();
    const nobody = await rep.call('removeMember', 'ow1', { email: 'adm2@x.test' });
    ok('(control) an ordinary admin is removed without touching the login', !nobody.err && !rep.users.adm2.disabled && nobody.out.billingOnFormerOwner === false);
  }
  {
    // OPEN-8: removal says when billing is still the former owner's
    const R = rig();
    await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const out = await R.call('removeMember', 'adm1', { email: 'ow1@x.test' });
    ok('removing a former owner reports that the Stripe customer is still theirs', !out.err && out.out.billingOnFormerOwner === true, out.err && out.err.message);
  }
  {
    // OPEN-4: a removal racing the hand-off (row flipped + claims stripped between the read and the transaction)
    const R = rig(null, null, { onClaims: (uid) => {
      if (uid === 'ow1') {
        R.db.store.set('companies/ow1/members/adm1@x.test', Object.assign({}, R.db.store.get('companies/ow1/members/adm1@x.test'), { status: 'removing' }));
        R.users.adm1.customClaims = { plan: 'x' };
      }
    } });
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    ok('target being removed mid-flight: hand-off fails, ownerId unchanged', !!err && err.code === 'failed-precondition' && R.db.store.get('companies/ow1').ownerId === 'ow1', err && err.code);
    ok('...and the target claims are NOT restored from the stale read', !('companyId' in R.users.adm1.customClaims) && R.users.adm1.customClaims.plan === 'x', JSON.stringify(R.users.adm1.customClaims));
    // removeMember takes the roster row off active before it strips claims
    const R2 = rig();
    await R2.call('removeMember', 'ow1', { email: 'rep1@x.test' });
    const flip = R2.db.log.indexOf('set:companies/ow1/members/rep1@x.test');
    ok('removeMember wrote the roster row (status removing) before the delete', flip >= 0 && flip < R2.db.log.indexOf('delete:companies/ow1/members/rep1@x.test'), R2.db.log.join(' '));
  }
  {
    // OPEN-5: payout setup in flight (no accountId yet) blocks, before and during
    const R = rig({ 'connectAccounts/ow1': { status: 'creating', claimedAtMs: 1 } });
    const before = snapshot(R.db);
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    ok('connectAccounts status creating (no accountId): refused, nothing changed', !!err && err.code === 'failed-precondition' && snapshot(R.db) === before, err && err.message);
    const R2 = rig(null, null, { onClaims: (uid) => { if (uid === 'ow1') R2.db.store.set('connectAccounts/ow1', { status: 'creating', claimedAtMs: 1 }); } });
    const r2 = await R2.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    ok('a payout setup that starts after the pre-check is caught inside the transaction', !!r2.err && r2.err.code === 'failed-precondition' && R2.db.store.get('companies/ow1').ownerId === 'ow1', r2.err && r2.err.message);
  }
  {
    // OPEN-7: the former owner's bot keys and calendar links are switched off
    const R = rig({
      'agent_keys/kOwn': { createdBy: 'ow1', companyId: 'ow1', active: true },
      'agent_keys/kRep': { createdBy: 'rep1', companyId: 'ow1', active: true },
      'calendar_feed_tokens/fOwn': { uid: 'ow1', companyId: 'ow1', status: 'active' },
      'calendar_feed_tokens/fRep': { uid: 'rep1', companyId: 'ow1', status: 'active' },
    });
    const { err } = await R.call('transferCompanyOwnership', 'ow1', { email: 'adm1@x.test', confirm: true });
    const s = R.db.store;
    ok("the former owner's bot key and calendar feed are revoked", !err && s.get('agent_keys/kOwn').active === false && s.get('calendar_feed_tokens/fOwn').status === 'revoked', err && err.message);
    ok("a teammate's key and feed are untouched", s.get('agent_keys/kRep').active === true && s.get('calendar_feed_tokens/fRep').status === 'active');
  }

  // ── I. the Team tab client half (js/dashboard-team-owner.js, lazy) ──────
  // dashboard-team-tab.js is a render-blocking script held to a byte ceiling,
  // so the hand-off UI lives in a lazily loaded file. Real source of both,
  // minimal DOM stand-ins; the callables are recorded, never executed.
  {
    const fs = require('fs');
    const vm = require('vm');
    const TAB = fs.readFileSync(path.join(ROOT, 'docs/pro/js/dashboard-team-tab.js'), 'utf8');
    const OWN = fs.readFileSync(path.join(ROOT, 'docs/pro/js/dashboard-team-owner.js'), 'utf8');
    const attrOf = (tag, k) => { const m = new RegExp(k + '="([^"]*)"').exec(tag); return m ? m[1] : null; };
    function client(o) {
      const calls = { callable: [], confirms: [], toasts: [], loads: [], reloads: 0 };
      const parent = { appended: [], appendChild(b) { this.appended.push(b); b.parentNode = this; } };
      let btns = null, lastHtml = null;
      const list = {
        id: 'teamMembersList', _html: '',
        set innerHTML(v) { this._html = v; },
        get innerHTML() { return this._html; },
        addEventListener() {}, parentNode: null,
        querySelectorAll(sel) {
          if (lastHtml !== this._html) {
            lastHtml = this._html;
            btns = (this._html.match(/<button\b[^>]*>/g) || []).map((t) => ({
              attrs: { 'data-team-action': attrOf(t, 'data-team-action'), 'data-email': attrOf(t, 'data-email'), 'data-former-owner': attrOf(t, 'data-former-owner') },
              parentNode: parent,
              getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
              setAttribute(k, v) { this.attrs[k] = String(v); },
            }));
          }
          const want = /data-team-action="([^"]+)"/.exec(sel);
          return btns.concat(parent.appended).filter((b) => want && b.attrs['data-team-action'] === want[1]);
        },
      };
      const document = {
        readyState: 'complete',
        getElementById: (id) => (id === 'teamMembersList' ? list : null),
        addEventListener() {},
        createElement: () => ({ attrs: {}, className: '', textContent: '', parentNode: null,
          getAttribute(k) { return this.attrs[k] == null ? null : this.attrs[k]; },
          setAttribute(k, v) { this.attrs[k] = String(v); } }),
      };
      const win = {
        document, console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, Promise, Date,
        _user: { uid: o.uid, email: o.uid + '@x.test', getIdTokenResult: async () => ({ claims: { role: 'company_admin' } }) },
        _userClaims: o.claims || {},
        db: {}, collection: () => ({}), doc: (_d, c, id) => ({ c, id }),
        getDoc: async () => ({ exists: () => o.ownerId !== undefined, data: () => ({ ownerId: o.ownerId }) }),
        getDocs: async () => ({ empty: false, docs: o.roster.map((m) => ({ id: m.email, data: () => m })) }),
        _functions: {},
        _httpsCallable: (_f, name) => async (payload) => { calls.callable.push({ name, payload }); return { data: o.removeData || {} }; },
        nbdConfirm: async (m) => { calls.confirms.push(m); return o.confirm !== false; },
        showToast: (m, t) => calls.toasts.push({ m: String(m), t }),
      };
      win.window = win;
      if (!o.noLoader) {
        win.ScriptLoader = { load: async (src) => { calls.loads.push(src); vm.runInContext(OWN, ctx, { filename: 'dashboard-team-owner.js' }); } };
      }
      const ctx = vm.createContext(win);
      vm.runInContext(TAB, ctx, { filename: 'dashboard-team-tab.js' });
      return { win, calls, list, parent };
    }
    const roster = [
      { email: 'adm1@x.test', role: 'company_admin', status: 'active', uid: 'adm1' },
      { email: 'rep1@x.test', role: 'sales_rep', status: 'active', uid: 'rep1' },
      { email: 'pend@x.test', role: 'company_admin', status: 'invited' },
      { email: 'noUid@x.test', role: 'company_admin', status: 'active' },
      { email: 'benched@x.test', role: 'company_admin', status: 'deactivated', uid: 'adm9' },
      { email: 'former@x.test', role: 'company_admin', status: 'deactivated', uid: 'ow1' },
    ];
    const made = (c) => c.parent.appended.map((b) => b.attrs['data-email']);
    const flagged = (c) => c.list.querySelectorAll('button[data-team-action="remove"]').filter((b) => b.attrs['data-former-owner'] === '1').map((b) => b.attrs['data-email']);

    console.log('\nI. Team tab client half (lazy dashboard-team-owner.js)');
    {
      const c = client({ uid: 'ow1', ownerId: 'ow1', roster });
      await c.win.loadTeamMembers();
      ok('the hand-off code loads lazily through ScriptLoader (versioned src)', c.calls.loads.length === 1 && /^js\/dashboard-team-owner\.js\?v=\d+$/.test(c.calls.loads[0]), JSON.stringify(c.calls.loads));
      ok('the owner sees Make owner on an ACTIVE claimed company_admin only', JSON.stringify(made(c)) === '["adm1@x.test"]', JSON.stringify(made(c)));
      const mk = c.parent.appended[0];
      ok('the button rides the existing data-team-action delegate (no inline handler)',
        mk && mk.attrs['data-team-action'] === 'makeowner' && mk.className === 'team-makeowner-btn' && Object.keys(mk.attrs).every((k) => !/^on/i.test(k)));
      ok('the new file touches no innerHTML and no on* attribute', !/innerHTML/.test(OWN.replace(/\/\*[\s\S]*?\*\//g, '')) && !/setAttribute\('on/i.test(OWN));
    }
    {
      const c = client({ uid: 'adm1', claims: { companyId: 'ow1', role: 'company_admin' }, ownerId: 'ow1', roster });
      await c.win.loadTeamMembers();
      ok('an admin (not the owner) is offered no Make owner', made(c).length === 0, JSON.stringify(made(c)));
    }
    {
      const c = client({ uid: 'ow1', claims: { companyId: 'ow1', role: 'company_admin' }, ownerId: 'adm1', roster });
      await c.win.loadTeamMembers();
      ok('after the hand-off the FORMER owner (login == company id) is not shown the owner controls', made(c).length === 0, JSON.stringify(made(c)));
    }
    {
      const c = client({ uid: 'adm1', claims: { companyId: 'ow1', role: 'company_admin' }, ownerId: 'adm1', roster });
      await c.win.loadTeamMembers();
      ok('the NEW owner (uid != company id) is offered Make owner (hand it back) on the other admins', JSON.stringify(made(c)) === '["adm1@x.test"]', JSON.stringify(made(c)));
      ok("only the former owner's Remove is flagged data-former-owner", JSON.stringify(flagged(c)) === '["former@x.test"]', JSON.stringify(flagged(c)));
    }
    {
      const c = client({ uid: 'ow1', ownerId: 'ow1', roster });
      await c.win.loadTeamMembers();
      await c.win.handleTeamAction('makeowner', 'adm1@x.test', c.parent.appended[0]);
      const t = c.calls.callable.filter((x) => x.name === 'transferCompanyOwnership');
      ok('Make owner calls transferCompanyOwnership with the email and confirm:true, after the dialog',
        t.length === 1 && t[0].payload.email === 'adm1@x.test' && t[0].payload.confirm === true && c.calls.confirms.length === 1, JSON.stringify(c.calls.callable));
      ok('it calls nothing else (never deactivateUser / removeMember)', c.calls.callable.every((x) => x.name === 'transferCompanyOwnership'));
      ok('the dialog states the facts: billing stays, only they can hand it back', /Billing does not move/.test(c.calls.confirms[0]) && /only they can hand it back/.test(c.calls.confirms[0]));
      ok('success toast says they are the owner and the caller stays an admin', c.calls.toasts.some((x) => x.t === 'success' && /is now the owner/.test(x.m) && /admin/.test(x.m)));
      ok('the session pulls the demoted claims', c.win._userClaims.role === 'company_admin');
    }
    {
      const c = client({ uid: 'ow1', ownerId: 'ow1', roster, confirm: false });
      await c.win.loadTeamMembers();
      await c.win.handleTeamAction('makeowner', 'adm1@x.test', c.parent.appended[0]);
      ok('declining the dialog changes nothing', c.calls.callable.length === 0);
    }
    {
      const c = client({ uid: 'ow1', ownerId: 'ow1', roster, noLoader: true });
      await c.win.loadTeamMembers();
      await c.win.handleTeamAction('makeowner', 'adm1@x.test', null);
      ok('FAIL-CLOSED: if the lazy file is missing, makeowner does nothing (it never falls through to deactivateUser)', c.calls.callable.length === 0 && c.calls.confirms.length === 0);
    }
    {
      const c = client({ uid: 'adm1', claims: { companyId: 'ow1', role: 'company_admin' }, ownerId: 'adm1', roster, removeData: { billingOnFormerOwner: true } });
      await c.win.loadTeamMembers();
      const fb = c.list.querySelectorAll('button[data-team-action="remove"]').find((b) => b.attrs['data-email'] === 'former@x.test');
      await c.win.handleTeamAction('remove', 'former@x.test', fb);
      ok('removing the former owner asks with the login-off wording', /former owner/.test(c.calls.confirms[0]) && /turned off for good/.test(c.calls.confirms[0]), c.calls.confirms[0]);
      ok('the toast carries the billing-is-still-on-their-card note', c.calls.toasts.some((x) => /Billing is still on their card/.test(x.m)), JSON.stringify(c.calls.toasts));
      const ben = c.list.querySelectorAll('button[data-team-action="remove"]').find((b) => b.attrs['data-email'] === 'benched@x.test');
      await c.win.handleTeamAction('remove', 'benched@x.test', ben);
      ok('(control) an ordinary removed member gets the standard wording', !/former owner/.test(c.calls.confirms[1]) && /move to the company owner/.test(c.calls.confirms[1]), c.calls.confirms[1]);
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
