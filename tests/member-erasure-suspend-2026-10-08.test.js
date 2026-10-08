/**
 * tests/member-erasure-suspend-2026-10-08.test.js
 *
 * Review r3 item 1 (nbd-content/review-r3-r4-still-open-2026-10-08.md), Jo's
 * ruling 2026-10-08: "if it's a team member, save all their info, just remove
 * their own access or ability to reconnect or reactivate their account. Leave
 * it suspended but optional for owner or leader to turn back on."
 *
 * On origin/main confirmAccountErasure deleted every lead / estimate / invoice
 * carrying the erasing uid with no company check, so a rep who asked to be
 * erased wiped the company's customers.
 *
 *   A. a team member's erasure: nothing deleted, account SUSPENDED (Auth
 *      disabled, sessions revoked, keys + feeds revoked, roster deactivated
 *      'self-erasure', companyId claim kept), honest request + audit rows.
 *   B. an owner whose company still has members: refused, nothing deleted.
 *   C. a solo owner: erased as before, but docs of ANOTHER tenant that carry
 *      their uid are kept.
 *   D. requestAccountErasure: member email says "suspends"; owner-with-team
 *      refused up front.
 *   E. a scope lookup failure refuses with nothing changed.
 *   F. Re-enable (deactivateUser reactivate, REAL requireTeamAdmin): owner and
 *      company_admin may; sales_rep, manager, and another tenant's admin may not.
 *   G. self-serve activateInvitedRep cannot flip a suspended roster row back.
 *
 * Real handlers; Firestore / Auth / Storage are in-memory fakes. No network.
 * Run: node tests/member-erasure-suspend-2026-10-08.test.js
 */
'use strict';

const path = require('path');
const crypto = require('crypto');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// ── in-memory Firestore (admin-SDK shaped) ────────────────────────────────
function fakeDb(seed) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, Object.assign({}, v)]));
  const realGet = store.get.bind(store);
  store.g = (k) => realGet(k) || {};
  const log = [];
  function ref(p) {
    const parts = p.split('/');
    return {
      path: p, id: parts[parts.length - 1],
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
    const filters = []; let lim = Infinity; let after = null;
    const q = {
      where(f, op, v) { filters.push([f, op, v]); return q; },
      limit(n) { lim = n; return q; },
      startAfter(s) { after = s && s.ref ? s.ref.path : null; return q; },
      async get() {
        const docs = [];
        const keys = [...store.keys()].filter(match).sort();
        for (const p of keys) {
          if (after && p <= after) continue;
          const d = store.get(p);
          const pass = filters.every(([f, op, v]) => {
            if (op === '==') return d[f] === v;
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
      q.doc = (id) => ref(c + '/' + id);
      q.add = async (d) => { const id = 'auto' + (store.size + 1); store.set(c + '/' + id, Object.assign({}, d)); log.push('add:' + c); return ref(c + '/' + id); };
      return q;
    },
    collectionGroup: (name) => query((p) => { const s = p.split('/'); return s.length % 2 === 0 && s[s.length - 2] === name; }),
    recursiveDelete: async (r) => {
      log.push('recursiveDelete:' + r.path);
      for (const k of [...store.keys()]) if (k === r.path || k.startsWith(r.path + '/')) store.delete(k);
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

function fakeAuth(users, events, o) {
  return {
    async getUser(uid) {
      if (o && o.getUserThrows) throw new Error('auth backend unavailable');
      if (!users[uid]) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
      return Object.assign({ uid }, users[uid]);
    },
    async getUserByEmail(email) {
      const uid = Object.keys(users).find((u) => users[u].email === email);
      if (!uid) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; }
      return Object.assign({ uid }, users[uid]);
    },
    async setCustomUserClaims(uid, c) { events.push('claims:' + uid); users[uid].customClaims = c; },
    async revokeRefreshTokens(uid) { events.push('revokeRefresh:' + uid); },
    async updateUser(uid, u) { events.push('updateUser:' + uid + ':' + JSON.stringify(u)); Object.assign(users[uid], u); },
  };
}

function baseStubs(db, auth, storageEvents) {
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
    'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ deleteFiles: async (q) => { storageEvents.push(q.prefix); } }) }) },
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
    // handlers lazy-require stubs (./upstash-ratelimit), keep the hook on while they run
    run: async (fn) => { Module._load = hook; try { return await fn(); } finally { Module._load = real; } },
  };
}

const TOKEN = 'b'.repeat(64);
const HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');
const pending = () => ({ tokenHash: HASH, confirmed: false, expiresAt: { toMillis: () => Date.now() + 3600e3 } });
const mkRes = () => ({ code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, send(b) { this.body = b; return this; } });

// A company with an owner, a rep, and the rep's company records.
function teamSeed(extra) {
  return Object.assign({
    'companies/co-a': { ownerId: 'owner', name: 'Acme Roofing' },
    'subscriptions/co-a': { status: 'active', plan: 'enterprise' }, // uncapped seats for assignSeats
    'companies/co-a/members/rep@x.test': { uid: 'rep', email: 'rep@x.test', status: 'active', role: 'sales_rep' },
    'companies/co-a/members/admin2@x.test': { uid: 'admin2', email: 'admin2@x.test', status: 'active', role: 'company_admin' },
    'companies/co-b': { ownerId: 'ownerB', name: 'Other Co' },
    'leads/L1': { userId: 'rep', companyId: 'co-a', name: 'Customer One' },
    'leads/L1/tasks/t1': { text: 'call back' },
    'leads/L1/activity/a1': { userId: 'rep', note: 'knocked' },
    'estimates/E1': { userId: 'rep', companyId: 'co-a', leadId: 'L1' },
    'invoices/I1': { createdBy: 'rep', companyId: 'co-a', leadId: 'L1' },
    'photos/P1': { userId: 'rep', companyId: 'co-a', leadId: 'L1' },
    'dailyTracker/D1': { userId: 'rep' },
    'userSettings/rep': { theme: 'dark' },
    'users/rep': { email: 'rep@x.test', companyId: 'co-a', role: 'sales_rep' },
    'agent_keys/k1': { createdBy: 'rep', companyId: 'co-a', active: true },
    'calendar_feed_tokens/F1': { uid: 'rep', companyId: 'co-a', status: 'active' },
    'leads/OL1': { userId: 'owner', companyId: 'co-a', name: 'Owner Customer' },
  }, extra || {});
}
function teamUsers() {
  return {
    owner: { email: 'owner@x.test', customClaims: { companyId: 'co-a', role: 'company_admin' } },
    admin2: { email: 'admin2@x.test', customClaims: { companyId: 'co-a', role: 'company_admin' } },
    rep: { email: 'rep@x.test', customClaims: { companyId: 'co-a', role: 'sales_rep', plan: 'pro' } },
    mgr: { email: 'mgr@x.test', customClaims: { companyId: 'co-a', role: 'manager' } },
    ownerB: { email: 'ob@x.test', customClaims: { companyId: 'co-b', role: 'company_admin' } },
    adminB: { email: 'ab@x.test', customClaims: { companyId: 'co-b', role: 'company_admin' } },
  };
}

function complianceRig(seed, users, o) {
  const events = [];
  const storage = [];
  const db = fakeDb(seed);
  const auth = fakeAuth(users, events, o);
  const L = loadWith('integrations/compliance.js', baseStubs(db, auth, storage));
  async function post(uid) {
    const res = mkRes();
    await L.run(() => L.mod.confirmAccountErasure.__handler({ method: 'POST', body: { uid, token: TOKEN } }, res));
    return res;
  }
  async function request(uid) {
    let out = null, err = null;
    try { out = await L.run(() => L.mod.requestAccountErasure.__handler({ auth: { uid } })); } catch (e) { err = e; }
    return { out, err };
  }
  return { db, users, events, storage, post, request };
}
const audits = (db) => [...db.store.entries()].filter(([k]) => /^audit_log\//.test(k)).map(([, v]) => v);

(async () => {
  // ═════════════════════════════════════════════════════════════════════
  console.log('A. a team member erases their account: suspended, nothing deleted');
  {
    const R = complianceRig(teamSeed({ 'account_erasures/rep': pending() }), teamUsers());
    const res = await R.post('rep');
    const s = R.db.store;
    ok('answers 200 with suspended:true (not "deleted")', res.code === 200 && res.body && res.body.suspended === true, res.code + ' ' + JSON.stringify(res.body));
    ok('the company lead the rep entered is NOT deleted', s.has('leads/L1') && s.g('leads/L1').name === 'Customer One');
    ok('...nor its subcollections (tasks, activity)', s.has('leads/L1/tasks/t1') && s.has('leads/L1/activity/a1'));
    ok('...nor the estimate, invoice, photo', s.has('estimates/E1') && s.has('invoices/I1') && s.has('photos/P1'));
    ok('authorship kept: records still carry the rep as author', s.g('leads/L1').userId === 'rep' && s.g('invoices/I1').createdBy === 'rep');
    ok("the member's own info is saved too (tracker, settings, profile)", s.has('dailyTracker/D1') && s.has('userSettings/rep') && s.has('users/rep'));
    ok('no recursive delete and no Storage delete ran', !R.db.log.some((e) => /^recursiveDelete:|^delete:/.test(e)) && R.storage.length === 0, R.db.log.join(' ') + ' | ' + R.storage.join(','));
    ok('Auth account disabled', R.users.rep.disabled === true);
    ok('refresh tokens revoked', R.events.includes('revokeRefresh:rep'));
    ok('companyId claim KEPT (so the owner can re-enable)', R.users.rep.customClaims.companyId === 'co-a' && R.users.rep.customClaims.role === 'sales_rep');
    const m = s.g('companies/co-a/members/rep@x.test');
    ok("roster row deactivated, reason 'self-erasure' (not 'lapse': no re-checkout restores it)",
      m.status === 'deactivated' && m.active === false && m.deactivatedReason === 'self-erasure' && m.uid === 'rep', JSON.stringify(m));
    ok("the rep's bot key and calendar feed are revoked", s.g('agent_keys/k1').active === false && s.g('calendar_feed_tokens/F1').status === 'revoked');
    const reqDoc = s.g('account_erasures/rep');
    ok('request record says suspended, company data retained',
      reqDoc.confirmed === true && reqDoc.outcome === 'suspended' && /suspended, company data retained/.test(reqDoc.outcomeNote || '')
      && reqDoc.deleted === false && reqDoc.companyId === 'co-a', JSON.stringify(reqDoc));
    const a = audits(R.db);
    ok('audit row gdpr_erasure_member_suspended (and no gdpr_erasure_confirmed)',
      a.some((x) => x.type === 'gdpr_erasure_member_suspended' && x.ids && x.ids.companyId === 'co-a' && x.retained === 'all')
      && !a.some((x) => x.type === 'gdpr_erasure_confirmed'), JSON.stringify(a));
    const again = await R.post('rep');
    ok('the same link afterwards: 410 Already processed', again.code === 410);
  }
  {
    // A rep missing a roster row still lands in the team list as deactivated,
    // so the owner can see them and Re-enable.
    const seed = teamSeed({ 'account_erasures/rep': pending() });
    delete seed['companies/co-a/members/rep@x.test'];
    const R = complianceRig(seed, teamUsers());
    const res = await R.post('rep');
    const m = R.db.store.g('companies/co-a/members/rep@x.test');
    ok('no roster row: one is written, deactivated, with role + email', res.code === 200 && m && m.status === 'deactivated'
      && m.role === 'sales_rep' && m.email === 'rep@x.test', JSON.stringify(m));
  }
  {
    // A company_admin who is not the owner is a member too.
    const R = complianceRig(teamSeed({ 'account_erasures/admin2': pending(), 'leads/A2': { userId: 'admin2', companyId: 'co-a' } }), teamUsers());
    const res = await R.post('admin2');
    ok('a non-owner company_admin is suspended, their company lead kept', res.code === 200 && res.body.suspended === true
      && R.db.store.has('leads/A2') && R.users.admin2.disabled === true);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('B. an owner whose company still has members: refused');
  {
    const R = complianceRig(teamSeed({ 'account_erasures/owner': pending() }), teamUsers());
    const res = await R.post('owner');
    ok('409 owner_has_team', res.code === 409 && res.body && res.body.code === 'owner_has_team', res.code + ' ' + JSON.stringify(res.body));
    ok("...the owner's company lead is NOT deleted", R.db.store.has('leads/OL1'));
    ok('...nothing deleted at all, Auth untouched', !R.db.log.some((e) => /^recursiveDelete:|^delete:/.test(e)) && R.storage.length === 0 && !R.users.owner.disabled);
    ok('...the request stays unconfirmed', R.db.store.g('account_erasures/owner').confirmed === false);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('C. a solo owner: erased, but never another tenant\'s docs');
  {
    const seed = {
      'companies/solo1': { ownerId: 'solo1' },
      'account_erasures/solo1': pending(),
      'leads/S1': { userId: 'solo1', companyId: 'solo1' },
      'leads/S1/tasks/st': { text: 'x' },
      'estimates/S2': { userId: 'solo1' },
      // carries the uid, but lives in another company
      'leads/X1': { userId: 'solo1', companyId: 'co-b' },
      'leads/XL': { userId: 'bob', companyId: 'co-b' },
      'estimates/X2': { userId: 'solo1', leadId: 'XL' },
      'leads/XL/activity/xa': { userId: 'solo1' },
      'companies/co-b': { ownerId: 'ownerB' },
    };
    const users = { solo1: { email: 's@x.test', customClaims: { companyId: 'solo1', role: 'company_admin' } } };
    const R = complianceRig(seed, users);
    const res = await R.post('solo1');
    const s = R.db.store;
    ok('200 erased (not suspended)', res.code === 200 && res.body.success === true && !res.body.suspended, JSON.stringify(res.body));
    ok('own lead (+ subcollection) and own estimate deleted', !s.has('leads/S1') && !s.has('leads/S1/tasks/st') && !s.has('estimates/S2'));
    ok("another tenant's lead carrying the uid is KEPT", s.has('leads/X1'));
    ok("an estimate pointing at another tenant's lead is KEPT", s.has('estimates/X2'));
    ok("activity under another tenant's lead is KEPT", s.has('leads/XL/activity/xa'));
    ok('Auth disabled, Storage swept as before', users.solo1.disabled === true && R.storage.some((p) => p === 'photos/solo1/'));
    const reqDoc = s.g('account_erasures/solo1');
    ok('request + audit rows record the kept docs', reqDoc.outcome === 'erased' && reqDoc.keptOtherTenant && reqDoc.keptOtherTenant.leads === 1
      && reqDoc.keptOtherTenant.estimates === 1 && reqDoc.keptOtherTenant.activity === 1, JSON.stringify(reqDoc.keptOtherTenant));
  }
  {
    // Solo owner with no claims at all (pre-claims account) and no company doc.
    const R = complianceRig({ 'account_erasures/u9': pending(), 'leads/N1': { userId: 'u9' } }, { u9: { email: 'n@x.test' } });
    const res = await R.post('u9');
    ok('claimless solo account: erased normally', res.code === 200 && !R.db.store.has('leads/N1'));
  }
  {
    // A pending invite does not make an owner "with team".
    const R = complianceRig({
      'companies/solo2': { ownerId: 'solo2' },
      'companies/solo2/members/inv@x.test': { email: 'inv@x.test', status: 'invited' },
      'account_erasures/solo2': pending(), 'leads/Q1': { userId: 'solo2', companyId: 'solo2' },
    }, { solo2: { email: 'q@x.test', customClaims: { companyId: 'solo2' } } });
    const res = await R.post('solo2');
    ok('owner with only a pending invite: erased as solo', res.code === 200 && !R.db.store.has('leads/Q1'));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('D. requestAccountErasure');
  {
    const R = complianceRig(teamSeed(), teamUsers());
    const r = await R.request('rep');
    const q = [...R.db.store.entries()].find(([k]) => k.startsWith('email_queue/'));
    ok('member: success, mode member', !!r.out && r.out.success === true && r.out.mode === 'member', r.err && r.err.message);
    ok('...the email says the account is SUSPENDED and records stay', !!q && /SUSPENDS your account/.test(q[1].bodyPlain) && /stay with your company/.test(q[1].bodyPlain));
    ok('...the request doc records the mode', R.db.store.g('account_erasures/rep').mode === 'member');
  }
  {
    const R = complianceRig(teamSeed(), teamUsers());
    const r = await R.request('owner');
    ok('owner with team: refused failed-precondition, no token minted', !!r.err && r.err.code === 'failed-precondition' && !R.db.store.has('account_erasures/owner'));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('E. scope lookup failure refuses with nothing changed');
  {
    const R = complianceRig(teamSeed({ 'account_erasures/rep': pending() }), teamUsers(), { getUserThrows: true });
    const res = await R.post('rep');
    ok('503 scope_unavailable', res.code === 503 && res.body && res.body.code === 'scope_unavailable', res.code + ' ' + JSON.stringify(res.body));
    ok('...nothing deleted, account not disabled', R.db.store.has('leads/L1') && !R.db.log.some((e) => /^recursiveDelete:|^delete:/.test(e)) && !R.users.rep.disabled);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('F. Re-enable (deactivateUser reactivate): owner/admin only, same tenant');
  async function reenableAs(callerUid) {
    const R = complianceRig(teamSeed({ 'account_erasures/rep': pending() }), teamUsers());
    await R.post('rep');
    const events = [];
    const auth = fakeAuth(R.users, events);
    const A = loadWith('handlers/admin.js', baseStubs(R.db, auth, []));
    const claims = R.users[callerUid].customClaims;
    let out = null, err = null;
    try {
      out = await A.run(() => A.mod.deactivateUser.__handler({
        auth: { uid: callerUid, token: Object.assign({ email: R.users[callerUid].email }, claims) },
        data: { email: 'rep@x.test', reactivate: true },
      }));
    } catch (e) { err = e; }
    return { R, out, err };
  }
  {
    const { R, out, err } = await reenableAs('owner');
    const m = R.db.store.g('companies/co-a/members/rep@x.test');
    ok('owner re-enables the suspended rep', !err && out && out.disabled === false && R.users.rep.disabled === false, err && err.message);
    ok('...roster row active again, self-erasure reason cleared', m.status === 'active' && m.deactivatedReason === null);
    ok('...audited (member_reactivated, by owner)', audits(R.db).some((a) => a.type === 'member_reactivated' && a.by === 'owner' && a.ids.uid === 'rep'));
    ok('...and the records are all still there for them', R.db.store.has('leads/L1') && R.db.store.has('dailyTracker/D1'));
  }
  {
    const { R, out, err } = await reenableAs('admin2');
    ok('a company_admin of the same company can re-enable', !err && out && R.users.rep.disabled === false, err && err.message);
  }
  for (const who of ['mgr', 'ownerB', 'adminB']) {
    const { R, err } = await reenableAs(who);
    ok(who + ' cannot re-enable (permission-denied), rep stays suspended',
      !!err && err.code === 'permission-denied' && R.users.rep.disabled === true
      && R.db.store.g('companies/co-a/members/rep@x.test').status === 'deactivated', err ? err.code + ' ' + err.message : 'no error');
  }
  {
    // the suspended rep's own (still-unexpired) token cannot re-enable itself
    const R = complianceRig(teamSeed({ 'account_erasures/rep': pending() }), teamUsers());
    await R.post('rep');
    const A = loadWith('handlers/admin.js', baseStubs(R.db, fakeAuth(R.users, []), []));
    let err = null;
    try { await A.run(() => A.mod.deactivateUser.__handler({ auth: { uid: 'rep', token: { companyId: 'co-a', role: 'sales_rep' } }, data: { uid: 'rep', reactivate: true } })); } catch (e) { err = e; }
    ok('the suspended rep cannot re-enable themselves', !!err && err.code === 'permission-denied' && R.users.rep.disabled === true);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('G. self-serve activateInvitedRep cannot undo the suspension');
  {
    const R = complianceRig(teamSeed({ 'account_erasures/rep': pending() }), teamUsers());
    await R.post('rep');
    const A = loadWith('handlers/auth.js', baseStubs(R.db, fakeAuth(R.users, []), []));
    let out = null, err = null;
    try {
      out = await A.run(() => A.mod.activateInvitedRep.__handler({ auth: { uid: 'rep', token: { companyId: 'co-a', role: 'sales_rep', email: 'rep@x.test' } } }));
    } catch (e) { err = e; }
    const m = R.db.store.g('companies/co-a/members/rep@x.test');
    ok('activateInvitedRep refuses a deactivated roster row', !err && out && out.activated === false && m.status === 'deactivated', err ? err.message : JSON.stringify(out) + ' ' + m.status);
  }
  {
    // control: an invited rep still activates
    const db = fakeDb({ 'companies/co-a/members/new@x.test': { email: 'new@x.test', status: 'invited', role: 'sales_rep' } });
    const A = loadWith('handlers/auth.js', baseStubs(db, fakeAuth({}, []), []));
    const out = await A.run(() => A.mod.activateInvitedRep.__handler({ auth: { uid: 'n1', token: { companyId: 'co-a', role: 'sales_rep', email: 'new@x.test' } } }));
    ok('control: an invited rep still activates', out && out.activated === true && db.store.g('companies/co-a/members/new@x.test').status === 'active');
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('H. assignSeats: a suspended admin cannot re-enable themselves (#2318 review)');
  function invitesRig(R) {
    const stubs = Object.assign(baseStubs(R.db, fakeAuth(R.users, []), []), {
      'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __handler: h }) },
      resend: { Resend: function () { return {}; } },
    });
    return loadWith('handlers/invites.js', stubs);
  }
  async function assignAs(R, callerUid, emails) {
    const I = invitesRig(R);
    let out = null, err = null;
    try {
      out = await I.run(() => I.mod.assignSeats.__handler({
        auth: { uid: callerUid, token: Object.assign({ email: R.users[callerUid].email }, R.users[callerUid].customClaims) },
        data: { activeEmails: emails },
      }));
    } catch (e) { err = e; }
    return { out, err };
  }
  {
    const R = complianceRig(teamSeed({ 'account_erasures/admin2': pending() }), teamUsers());
    await R.post('admin2');
    const { err } = await assignAs(R, 'admin2', ['admin2@x.test', 'rep@x.test']);
    const m = R.db.store.g('companies/co-a/members/admin2@x.test');
    ok('suspended admin2 calling assignSeats with own email is refused', !!err && err.code === 'permission-denied', err ? err.code + ' ' + err.message : 'no error');
    ok("...still disabled, roster reason still 'self-erasure'", R.users.admin2.disabled === true && m.status === 'deactivated' && m.deactivatedReason === 'self-erasure', JSON.stringify(m));
  }
  {
    // Second lock: even an ENABLED admin cannot flip their own row (requireTeamAdmin passes here).
    const R = complianceRig(teamSeed({
      'companies/co-a/members/admin2@x.test': { uid: 'admin2', email: 'admin2@x.test', status: 'deactivated', role: 'company_admin', deactivatedReason: 'owner-removed' },
    }), teamUsers());
    const { err } = await assignAs(R, 'admin2', ['admin2@x.test']);
    const m = R.db.store.g('companies/co-a/members/admin2@x.test');
    ok("assignSeats never re-activates the caller's own row", !err && m.status === 'deactivated' && m.deactivatedReason === 'owner-removed', (err && err.message) + ' ' + JSON.stringify(m));
  }
  {
    const R = complianceRig(teamSeed({ 'account_erasures/admin2': pending() }), teamUsers());
    await R.post('admin2');
    const { err } = await assignAs(R, 'owner', ['admin2@x.test', 'rep@x.test']);
    const m = R.db.store.g('companies/co-a/members/admin2@x.test');
    ok('control: the OWNER can re-enable admin2 through assignSeats', !err && R.users.admin2.disabled === false && m.status === 'active', err && err.message);
  }
  {
    // requireTeamAdmin refuses any disabled caller, not only via assignSeats.
    const R = complianceRig(teamSeed({ 'account_erasures/admin2': pending() }), teamUsers());
    await R.post('admin2');
    const A = loadWith('handlers/admin.js', baseStubs(R.db, fakeAuth(R.users, []), []));
    let err = null;
    try { await A.run(() => A.mod.deactivateUser.__handler({ auth: { uid: 'admin2', token: { companyId: 'co-a', role: 'company_admin' } }, data: { uid: 'admin2', reactivate: true } })); } catch (e) { err = e; }
    ok('a suspended company_admin cannot call deactivateUser either (requireTeamAdmin checks Auth)', !!err && err.code === 'permission-denied' && /suspended/.test(err.message) && R.users.admin2.disabled === true, err && err.message);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('I. owner-with-team detection covers invited-with-uid rows and claim holders without a row');
  {
    const seed = {
      'companies/co-c': { ownerId: 'oc' }, 'account_erasures/oc': pending(), 'leads/C1': { userId: 'oc', companyId: 'co-c' },
      // createTeamMember stamps claims and leaves the row 'invited' with a uid
      'companies/co-c/members/m@x.test': { uid: 'mc', email: 'm@x.test', status: 'invited', role: 'sales_rep' },
    };
    const users = { oc: { email: 'oc@x.test', customClaims: { companyId: 'co-c', role: 'company_admin' } }, mc: { email: 'm@x.test', customClaims: { companyId: 'co-c', role: 'sales_rep' } } };
    const R = complianceRig(seed, users);
    const res = await R.post('oc');
    ok("an 'invited' roster row with a uid counts: 409, nothing deleted", res.code === 409 && res.body.code === 'owner_has_team' && R.db.store.has('leads/C1') && !users.oc.disabled, res.code + ' ' + JSON.stringify(res.body));
  }
  {
    const seed = {
      'companies/co-d': { ownerId: 'od' }, 'account_erasures/od': pending(), 'leads/D1': { userId: 'od', companyId: 'co-d' },
      'users/od': { companyId: 'co-d' }, 'users/md': { companyId: 'co-d' }, // a claim holder with no roster row
    };
    const users = { od: { email: 'od@x.test', customClaims: { companyId: 'co-d' } }, md: { email: 'md@x.test', customClaims: { companyId: 'co-d', role: 'sales_rep' } } };
    const R = complianceRig(seed, users);
    const res = await R.post('od');
    ok('a member holding the claim with no roster row counts: 409, nothing deleted', res.code === 409 && R.db.store.has('leads/D1') && !users.od.disabled, res.code + ' ' + JSON.stringify(res.body));
  }
  {
    // control: a REMOVED member keeps a stale profile companyId but no claim -> not a team
    const seed = {
      'companies/co-e': { ownerId: 'oe' }, 'account_erasures/oe': pending(), 'leads/E9': { userId: 'oe', companyId: 'co-e' },
      'users/gone': { companyId: 'co-e' },
    };
    const users = { oe: { email: 'oe@x.test', customClaims: { companyId: 'co-e' } }, gone: { email: 'g@x.test', customClaims: { plan: 'pro' } } };
    const R = complianceRig(seed, users);
    const res = await R.post('oe');
    ok('control: a removed member (stale profile, no claim) does not block a solo erasure', res.code === 200 && !R.db.store.has('leads/E9'), res.code + ' ' + JSON.stringify(res.body));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('J. every roster row of the member is deactivated (email key AND uid)');
  {
    const R = complianceRig(teamSeed({
      'account_erasures/rep': pending(),
      'companies/co-a/members/old-rep@x.test': { uid: 'rep', email: 'old-rep@x.test', status: 'active', role: 'sales_rep' },
    }), teamUsers());
    await R.post('rep');
    const a = R.db.store.g('companies/co-a/members/rep@x.test'), b = R.db.store.g('companies/co-a/members/old-rep@x.test');
    ok('a second row keyed by an older email (same uid) is deactivated too', a.status === 'deactivated' && b.status === 'deactivated' && b.deactivatedReason === 'self-erasure', JSON.stringify(b));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('K. a re-checkout (reactivateLapsedSeats) never restores a self-suspended member');
  {
    const R = complianceRig(teamSeed({ 'account_erasures/rep': pending() }), teamUsers());
    await R.post('rep');
    // the race: a lapse pause overwrote the reason after the suspension
    await R.db.doc('companies/co-a/members/rep@x.test').set({ deactivatedReason: 'lapse' }, { merge: true });
    await R.db.doc('companies/co-a/members/mgr@x.test').set({ uid: 'mgr', email: 'mgr@x.test', status: 'deactivated', deactivatedReason: 'lapse', role: 'manager' });
    R.users.mgr.disabled = true;
    const LE = loadWith('lapse-enforcement.js', Object.assign(baseStubs(R.db, fakeAuth(R.users, []), []), {
      './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
    }));
    await LE.run(() => LE.mod.reactivateLapsedSeats(R.db, 'co-a'));
    ok('the self-suspended rep stays suspended', R.users.rep.disabled === true && R.db.store.g('companies/co-a/members/rep@x.test').status === 'deactivated');
    ok('control: an ordinary lapse-paused member is restored', R.users.mgr.disabled === false && R.db.store.g('companies/co-a/members/mgr@x.test').status === 'active');
  }
  {
    // after the owner re-enables them, the erasure request is closed out
    const { R } = await reenableAs('owner');
    ok("owner Re-enable marks the erasure request 'reactivated' (a later lapse restore treats them normally)",
      R.db.store.g('account_erasures/rep').outcome === 'reactivated' && R.db.store.g('account_erasures/rep').reactivatedBy === 'owner');
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('L. Auth is disabled FIRST: a failed suspension fails closed');
  {
    const R = complianceRig(teamSeed({ 'account_erasures/rep': pending() }), teamUsers());
    const realCollection = R.db.collection;
    R.db.collection = (c) => { if (c === 'agent_keys') throw new Error('UNAVAILABLE (simulated)'); return realCollection(c); };
    const res = await R.post('rep');
    ok('500 suspend_failed, request left retryable', res.code === 500 && res.body.code === 'suspend_failed' && R.db.store.g('account_erasures/rep').confirmed === false, res.code + ' ' + JSON.stringify(res.body));
    ok('...but the account is already disabled and sessions revoked', R.users.rep.disabled === true && R.events.includes('revokeRefresh:rep'));
    ok('...and nothing was deleted', R.db.store.has('leads/L1'));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('M. dashboard warning before the request (dashboard-api.js _gdprRequestErasure)');
  {
    const vm = require('vm');
    const src = require('fs').readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'dashboard-api.js'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('window._gdprRequestErasure = async function');
    const end = src.indexOf('\n};', start);
    const block = start >= 0 && end > start ? src.slice(start, end + 3) : '';
    async function warningFor(claims) {
      let seen = null;
      const win = { _user: { uid: 'rep' }, _userClaims: claims, nbdConfirm: async (m) => { seen = m; return false; } };
      const ctx = vm.createContext({ window: win, showToast() {}, console });
      vm.runInContext(block, ctx);
      await win._gdprRequestErasure();
      return seen || '';
    }
    const member = await warningFor({ companyId: 'co-a', role: 'sales_rep' });
    const solo = await warningFor({ companyId: 'rep' });
    ok('a team member is told their access is SUSPENDED and company records stay', /SUSPENDED, not deleted/.test(member) && /stay with your company/.test(member) && !/PERMANENTLY DELETE/.test(member), member.slice(0, 120));
    ok('control: a solo owner still sees the permanent-delete warning', /PERMANENTLY DELETE/.test(solo));
  }

  console.log('');
  console.log(failed ? 'FAILED — ' + passed + ' passed, ' + failed + ' failed' : 'PASSED — ' + passed + ' assertions');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
