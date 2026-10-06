/**
 * tests/member-offboarding-2026-10-06.test.js
 *
 * Review R3-1 (2026-10-06, fix approved by Jo): a removed team member kept
 * access to the company's customers three ways.
 *   (a) Rules authorize company records on isOwner(userId) with no tenant
 *       check, and removeMember reassigned nothing, so the ex-rep signed back
 *       in and kept reading/editing every lead they owned.
 *   (b) Their calendar feed token (never expires) kept serving the schedule.
 *   (c) A bot key they created kept reading the company's CRM, because
 *       crmMcp authenticate() never re-checked the creator.
 *
 * The fix (functions/member-offboarding.js):
 *   - removeMember reassigns the member's company records to the company
 *     owner BEFORE it strips their claims (rules then deny the ex-rep
 *     naturally, list queries included — see the module header for why the
 *     rules were not changed instead).
 *   - removal, deactivation, demotion to viewer, seat benching and the lapse
 *     cron revoke the member's agent_keys + calendar_feed_tokens.
 *   - crmMcp authenticate() and getCalendarFeed re-check the person behind the
 *     key / feed on every call (disabled, viewer, no longer in the company).
 *
 * Every check here was run against origin/main first and failed there.
 * The rules half (removed rep denied, owner allowed, solo owner unaffected)
 * lives in firestore-rules.cross-tenant.test.js section OFFBOARD.
 *
 * Pure Node: an in-memory Firestore fake and stubbed firebase-admin/auth.
 * Run: node tests/member-offboarding-2026-10-06.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ── in-memory Firestore (admin-SDK shaped) ────────────────────────────────
function fakeDb(seed, sharedLog) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, Object.assign({}, v)]));
  const log = sharedLog || [];
  function ref(p) {
    const parts = p.split('/');
    const r = {
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
    return r;
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
        for (const p of store.keys()) {
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
      q.doc = (id) => ref(c + '/' + id);
      q.add = async (d) => { const id = 'auto' + (store.size + 1); store.set(c + '/' + id, Object.assign({}, d)); return ref(c + '/' + id); };
      return q;
    },
    collectionGroup: (name) => query((p) => { const s = p.split('/'); return s.length % 2 === 0 && s[s.length - 2] === name; }),
    batch() {
      const ops = [];
      return {
        update(r, d) { ops.push(() => r.update(d)); return this; },
        set(r, d, o) { ops.push(() => r.set(d, o)); return this; },
        async commit() { for (const op of ops) await op(); },
      };
    },
  };
  return db;
}

// Fake Auth: users by uid → { uid, disabled, customClaims }.
function fakeAuth(users, events) {
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
    async setCustomUserClaims(uid, c) { events.push('claims:' + uid); users[uid].customClaims = c; },
    async revokeRefreshTokens(uid) { events.push('revokeRefresh:' + uid); },
    async updateUser(uid, u) { events.push('updateUser:' + uid + ':' + JSON.stringify(u)); Object.assign(users[uid], u); },
  };
}

class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

// Load a functions/ module with firebase deps stubbed.
function loadWith(file, stubs) {
  const real = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return real.apply(this, arguments);
  };
  const abs = path.join(FN, file);
  delete require.cache[abs];
  delete require.cache[path.join(FN, 'member-offboarding.js')];
  try { return require(abs); } finally { Module._load = real; }
}
function baseStubs(db, auth) {
  return {
    'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
    'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => '__ts__', increment: (n) => ({ __inc: n }) },
      Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) },
    },
    'firebase-admin/auth': { getAuth: () => auth },
    './integrations/upstash-ratelimit': { enforceRateLimit: async () => ({ allowed: true }), httpRateLimit: async () => true },
  };
}

let OFF = null;
try { OFF = require(path.join(FN, 'member-offboarding.js')); } catch (e) { OFF = null; }

(async () => {
  // ═════════════════════════════════════════════════════════════════════
  console.log('A. the module exists and exports the four pieces');
  ok('functions/member-offboarding.js loads', !!OFF);
  const has = (n) => !!OFF && typeof OFF[n] === 'function';
  ok('exports reassignMemberRecords, revokeMemberAccessTokens, keyCreatorAllowed, feedOwnerAllowed',
    has('reassignMemberRecords') && has('revokeMemberAccessTokens') && has('keyCreatorAllowed') && has('feedOwnerAllowed'));

  // ═════════════════════════════════════════════════════════════════════
  console.log('B. reassignMemberRecords — company records move to the owner, nothing else does');
  if (has('reassignMemberRecords')) {
    const db = fakeDb({
      'leads/L1':                 { userId: 'rep', companyId: 'co-a', name: 'Company customer' },
      'leads/L2':                 { userId: 'rep', companyId: 'rep', name: 'Solo-era customer (rep\'s own, before joining)' },
      'leads/L3':                 { userId: 'rep', companyId: 'co-z', name: 'Some other tenant' },
      'leads/L1/recordings/R1':   { userId: 'rep', companyId: 'co-a' },
      'leads/L1/storm_proofs/S1': { userId: 'rep', companyId: 'co-a' },
      'leads/L1/tasks/T1':        { userId: 'rep', companyId: 'co-a', type: 'event' },
      'leads/L1/jobs/J1':         { userId: 'rep', companyId: 'co-a' },
      'leads/L2/recordings/R2':   { userId: 'rep', companyId: 'rep' },
      'estimates/E1':             { userId: 'rep', companyId: 'co-a', leadId: 'L1' },
      'invoices/I1':              { createdBy: 'rep', companyId: 'co-a', leadId: 'L1' },
      'photos/P1':                { userId: 'rep', leadId: 'L1' },            // predates companyId stamping
      'photos/P2':                { userId: 'rep', leadId: 'L2' },            // solo-era lead → stays
      'photos/P3':                { userId: 'rep' },                          // no tenant evidence → stays
      'appointments/A1':          { userId: 'rep', companyId: 'co-a' },
      'tasks/TT1':                { userId: 'rep', companyId: 'co-a' },
      'email_log/M1':             { uid: 'rep', companyId: 'co-a', leadId: 'L1' },
      'esign_envelopes/V1':       { ownerUid: 'rep', companyId: 'co-a', leadId: 'L1' },
      'notifications/N1':         { userId: 'rep', companyId: 'co-a' },       // about the rep → stays
      'training_sessions/X1':     { userId: 'rep', companyId: 'co-a' },       // their own practice → stays
      'estimates/E9':             { userId: 'other', companyId: 'co-a' },     // a teammate's → untouched
    });
    const r = await OFF.reassignMemberRecords(db, { fromUid: 'rep', toUid: 'owner', companyId: 'co-a' });
    const g = (p) => db.store.get(p) || {};
    ok('company lead → owner', g('leads/L1').userId === 'owner');
    ok("the rep's solo-era lead stays theirs (companyId == their uid)", g('leads/L2').userId === 'rep');
    ok("another tenant's lead is never touched", g('leads/L3').userId === 'rep');
    ok('estimate → owner', g('estimates/E1').userId === 'owner');
    ok('invoice (owner field createdBy) → owner', g('invoices/I1').createdBy === 'owner');
    ok('photo without companyId follows its lead into the company → owner', g('photos/P1').userId === 'owner');
    ok('photo on the solo-era lead stays', g('photos/P2').userId === 'rep');
    ok('photo with no tenant evidence stays (never guess)', g('photos/P3').userId === 'rep');
    ok('appointment → owner', g('appointments/A1').userId === 'owner');
    ok('top-level task → owner', g('tasks/TT1').userId === 'owner');
    ok('sent-email log (owner field uid) → owner', g('email_log/M1').uid === 'owner');
    ok('e-sign envelope (owner field ownerUid) → owner', g('esign_envelopes/V1').ownerUid === 'owner');
    ok("recording under the moved lead → owner (rules key on the row's own userId)", g('leads/L1/recordings/R1').userId === 'owner');
    ok('storm proof under the moved lead → owner', g('leads/L1/storm_proofs/S1').userId === 'owner');
    ok('lead event task + job under the moved lead → owner (feeds/summaries key on userId)',
      g('leads/L1/tasks/T1').userId === 'owner' && g('leads/L1/jobs/J1').userId === 'owner');
    ok('recording under the solo-era lead stays', g('leads/L2/recordings/R2').userId === 'rep');
    ok('notifications + training_sessions (about the rep themselves) stay', g('notifications/N1').userId === 'rep' && g('training_sessions/X1').userId === 'rep');
    ok("a teammate's estimate is untouched", g('estimates/E9').userId === 'other');
    ok('only the owner field changes (companyId/name kept)', g('leads/L1').companyId === 'co-a' && g('leads/L1').name === 'Company customer');
    ok('returns per-collection counts', r && r.moved && r.moved.leads === 1 && r.moved.photos === 1 && r.moved.invoices === 1, JSON.stringify(r));
    const again = await OFF.reassignMemberRecords(db, { fromUid: 'rep', toUid: 'owner', companyId: 'co-a' });
    ok('idempotent: a retry moves nothing more', again && again.total === 0, JSON.stringify(again));
    let threw = false;
    try { await OFF.reassignMemberRecords(db, { fromUid: 'rep', toUid: 'rep', companyId: 'co-a' }); } catch (_) { threw = true; }
    ok('refuses fromUid === toUid / missing ids', threw);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('C. revokeMemberAccessTokens — the member\'s bot keys + calendar feeds');
  if (has('revokeMemberAccessTokens')) {
    const db = fakeDb({
      'agent_keys/k1': { createdBy: 'rep', companyId: 'co-a', botId: 'c_x', active: true },
      'agent_keys/k2': { createdBy: 'rep', ownerUid: 'rep', scope: 'personal', companyId: 'co-a', active: true },
      'agent_keys/k3': { createdBy: 'owner', companyId: 'co-a', active: true },
      'agent_keys/k4': { createdBy: 'rep', companyId: 'co-a', active: false },
      'calendar_feed_tokens/F1': { uid: 'rep', companyId: 'co-a', status: 'active' },
      'calendar_feed_tokens/F2': { uid: 'owner', companyId: 'co-a', status: 'active' },
    });
    const r = await OFF.revokeMemberAccessTokens(db, 'rep', 'member-removed');
    const g = (p) => db.store.get(p) || {};
    ok("the member's CRM key and personal key are revoked", g('agent_keys/k1').active === false && g('agent_keys/k2').active === false);
    ok('…stamped with the reason', g('agent_keys/k1').revokedReason === 'member-removed');
    ok("the owner's key keeps working", g('agent_keys/k3').active === true);
    ok("the member's calendar feed is revoked", g('calendar_feed_tokens/F1').status === 'revoked' && g('calendar_feed_tokens/F1').revokedReason === 'member-removed');
    ok("the owner's feed is untouched", g('calendar_feed_tokens/F2').status === 'active');
    ok('returns counts (2 keys, 1 feed; an already-off key is not re-counted)', r && r.agentKeys === 2 && r.calendarFeeds === 1, JSON.stringify(r));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('D. keyCreatorAllowed / feedOwnerAllowed — the per-call re-check');
  if (has('keyCreatorAllowed') && has('feedOwnerAllowed')) {
    const K = (o) => Object.assign({ createdBy: 'rep', companyId: 'co-a' }, o);
    const U = (o) => Object.assign({ uid: 'rep', disabled: false, customClaims: { companyId: 'co-a', role: 'company_admin' } }, o);
    ok('key: creator still company_admin in the company → allowed', OFF.keyCreatorAllowed(K(), U()) === true);
    ok('key: creator removed (claims stripped) → refused', OFF.keyCreatorAllowed(K(), U({ customClaims: {} })) === false);
    ok('key: creator deactivated (disabled) → refused', OFF.keyCreatorAllowed(K(), U({ disabled: true })) === false);
    ok('key: creator moved to another company → refused', OFF.keyCreatorAllowed(K(), U({ customClaims: { companyId: 'co-b', role: 'company_admin' } })) === false);
    ok('key: creator demoted to viewer → refused', OFF.keyCreatorAllowed(K(), U({ customClaims: { companyId: 'co-a', role: 'viewer' } })) === false);
    ok('key: creator account deleted → refused', OFF.keyCreatorAllowed(K(), null) === false);
    ok('key: solo owner (no claims yet, key.companyId == uid) → allowed',
      OFF.keyCreatorAllowed(K({ createdBy: 'solo', companyId: 'solo' }), { uid: 'solo', customClaims: {} }) === true);
    ok('key: house key made by the platform admin → allowed',
      OFF.keyCreatorAllowed(K({ createdBy: 'jo', companyId: 'nbd' }), { uid: 'jo', customClaims: { role: 'admin', owner: true } }) === true);
    ok('key: a disabled platform admin is still refused',
      OFF.keyCreatorAllowed(K({ createdBy: 'jo', companyId: 'nbd' }), { uid: 'jo', disabled: true, customClaims: { role: 'admin' } }) === false);
    ok('key: no createdBy (server-minted platform key) → allowed explicitly', OFF.keyCreatorAllowed({ companyId: 'co-a' }, null) === true);
    const T = (o) => Object.assign({ uid: 'rep', companyId: 'co-a', status: 'active' }, o);
    ok('feed: rep still in the company → allowed', OFF.feedOwnerAllowed(T(), U({ customClaims: { companyId: 'co-a', role: 'sales_rep' } })) === true);
    ok('feed: rep removed → refused', OFF.feedOwnerAllowed(T(), U({ customClaims: {} })) === false);
    ok('feed: rep deactivated → refused', OFF.feedOwnerAllowed(T(), U({ disabled: true })) === false);
    ok('feed: rep made a viewer → refused', OFF.feedOwnerAllowed(T(), U({ customClaims: { companyId: 'co-a', role: 'viewer' } })) === false);
    ok('feed: account gone → refused', OFF.feedOwnerAllowed(T(), null) === false);
    ok('feed: solo owner (token companyId == uid, no claims) → allowed',
      OFF.feedOwnerAllowed(T({ uid: 'solo', companyId: 'solo' }), { uid: 'solo', customClaims: {} }) === true);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('E. removeMember / deactivateUser / updateUserRole (handlers, stubbed Auth)');
  function adminRig() {
    const events = [];
    const db = fakeDb({
      'companies/co-a': { ownerId: 'owner' },
      'companies/co-a/members/rep@x.test': { uid: 'rep', email: 'rep@x.test', status: 'active', role: 'sales_rep' },
      'leads/L1': { userId: 'rep', companyId: 'co-a' },
      'estimates/E1': { userId: 'rep', companyId: 'co-a' },
      'agent_keys/k1': { createdBy: 'rep', companyId: 'co-a', active: true },
      'calendar_feed_tokens/F1': { uid: 'rep', companyId: 'co-a', status: 'active' },
    }, events);
    const users = {
      owner: { email: 'owner@x.test', customClaims: { companyId: 'co-a', role: 'company_admin' } },
      rep: { email: 'rep@x.test', customClaims: { companyId: 'co-a', role: 'sales_rep', plan: 'pro' } },
    };
    const auth = fakeAuth(users, events);
    const stubs = Object.assign(baseStubs(db, auth), {
      '../shared': { callableRateLimit: async () => {} },
      '../customer-id': { formatCustomerId: () => '', resolveCustMint: () => ({}) },
      './invites': { seatLimitForPlan: () => 10, isInviteExpired: () => false },
      './_shared': {
        CORS_ORIGINS: [], LEGACY_ACCESS_CODES: [],
        requireTeamAdmin: async () => ({ uid: 'owner', companyId: 'co-a', companyRef: db.doc('companies/co-a') }),
        callerMayManageTarget: (claims, cid, g) => g || (claims && claims.companyId === cid),
        normalizeRole: (r) => (['viewer', 'sales_rep', 'manager', 'company_admin'].includes(r) ? r : null),
        normalizeEmail: (e) => (typeof e === 'string' ? e.trim().toLowerCase() : ''),
        isOwnerCaller: () => true,
      },
    });
    const mod = loadWith('handlers/admin.js', stubs);
    const req = (data) => ({ auth: { uid: 'owner', token: { companyId: 'co-a', role: 'company_admin' } }, data });
    return { db, users, events, mod, req };
  }
  {
    const { db, users, events, mod, req } = adminRig();
    let res, err;
    try { res = await mod.removeMember.__handler(req({ email: 'rep@x.test' })); } catch (e) { err = e; }
    ok('removeMember succeeds', !err && res && res.removed === true, err && err.message);
    ok("removeMember: the rep's company lead + estimate now belong to the owner",
      db.store.get('leads/L1').userId === 'owner' && db.store.get('estimates/E1').userId === 'owner');
    ok("removeMember: the rep's bot key is revoked", db.store.get('agent_keys/k1').active === false);
    ok("removeMember: the rep's calendar feed is revoked", db.store.get('calendar_feed_tokens/F1').status === 'revoked');
    ok('removeMember still strips companyId/role and keeps billing claims',
      !('companyId' in users.rep.customClaims) && !('role' in users.rep.customClaims) && users.rep.customClaims.plan === 'pro');
    const reassignedAt = events.indexOf('update:leads/L1');
    const strippedAt = events.indexOf('claims:rep');
    ok('removeMember reassigns BEFORE stripping claims (a failed sweep stays retryable)',
      reassignedAt >= 0 && strippedAt > reassignedAt, db.log.join(' ') + ' | ' + events.join(' '));
    ok('removeMember timeout raised for the sweep (≥ 120s)', (mod.removeMember.__opts.timeoutSeconds || 0) >= 120);
    // 2026-10-06 file move: every moved doc is in the move's ledger, the move
    // is armed (phase collect), and the claim strip locks the Storage folder.
    const { keyOf } = require(path.join(__dirname, '..', 'functions', 'member-storage-move.js'));
    const led = (p) => db.store.get('member_offboarding/co-a__rep/ledger/' + keyOf(p));
    ok('removeMember: each moved doc is recorded in the file-move ledger',
      !!led('leads/L1') && led('leads/L1').docId === 'L1' && !!led('estimates/E1') && led('estimates/E1').scanned === false);
    ok('removeMember: the file move is armed after the reassignment (phase collect)',
      (db.store.get('member_offboarding/co-a__rep') || {}).phase === 'collect' && db.store.get('member_offboarding/co-a__rep').toUid === 'owner');
    ok('removeMember: the claim strip sets offboardLock (Storage folder locked)', users.rep.customClaims.offboardLock === true);
    ok('removeMember: a file-move slice that cannot run leaves the removal successful', res && res.filesMove === 'running', JSON.stringify(res));
  }
  {
    // Reassign must happen before the claim strip: make the sweep fail and
    // check the claims are still intact so a retry passes callerMayManageTarget.
    const { db, users, mod, req } = adminRig();
    const realUpdate = db.doc;
    db.doc = (p) => { const r = realUpdate(p); if (p === 'leads/L1') r.update = async () => { throw new Error('boom'); }; return r; };
    const realBatch = db.batch;
    db.batch = () => { const b = realBatch(); const u = b.update.bind(b); b.update = (r, d) => { if (r.path === 'leads/L1') throw new Error('boom'); return u(r, d); }; return b; };
    let err;
    try { await mod.removeMember.__handler(req({ email: 'rep@x.test' })); } catch (e) { err = e; }
    ok('removeMember: a failed reassign throws and leaves the rep\'s claims for a retry',
      !!err && users.rep.customClaims.companyId === 'co-a' && db.store.has('companies/co-a/members/rep@x.test'));
  }
  {
    const { db, mod, req } = adminRig();
    await mod.deactivateUser.__handler(req({ uid: 'rep' }));
    ok("deactivateUser: the rep's bot key is revoked", db.store.get('agent_keys/k1').active === false);
    ok("deactivateUser: the rep's calendar feed is revoked", db.store.get('calendar_feed_tokens/F1').status === 'revoked');
    ok('deactivateUser does NOT reassign (deactivation is reversible)', db.store.get('leads/L1').userId === 'rep');
  }
  {
    const { db, mod, req } = adminRig();
    await mod.updateUserRole.__handler(req({ uid: 'rep', role: 'viewer' }));
    ok('updateUserRole → viewer: bot key + calendar feed revoked',
      db.store.get('agent_keys/k1').active === false && db.store.get('calendar_feed_tokens/F1').status === 'revoked');
  }
  {
    const { db, mod, req } = adminRig();
    await mod.updateUserRole.__handler(req({ uid: 'rep', role: 'manager' }));
    ok('updateUserRole → manager: nothing revoked', db.store.get('agent_keys/k1').active === true && db.store.get('calendar_feed_tokens/F1').status === 'active');
  }
  // Follow-up (Jo 2026-10-06): any DOWNGRADE away from company_admin / manager
  // revokes too, not only a move to viewer.
  {
    const R = OFF && OFF.roleChangeRevokesAccess;
    ok('roleChangeRevokesAccess is exported', typeof R === 'function');
    if (typeof R === 'function') {
      ok('downgrades away from company_admin / manager revoke',
        R('company_admin', 'manager') && R('company_admin', 'sales_rep') && R('manager', 'sales_rep'));
      ok('any move to viewer revokes', R('sales_rep', 'viewer') && R('manager', 'viewer') && R(undefined, 'viewer'));
      ok('upgrades, no-ops and lower-role moves do not revoke',
        !R('sales_rep', 'manager') && !R('manager', 'company_admin') && !R('manager', 'manager')
        && !R('company_admin', 'company_admin') && !R(undefined, 'sales_rep') && !R('viewer', 'sales_rep'));
    }
  }
  for (const [from, to, revoked] of [['manager', 'sales_rep', true], ['company_admin', 'manager', true], ['company_admin', 'sales_rep', true], ['sales_rep', 'manager', false], ['manager', 'company_admin', false]]) {
    const { db, users, events, mod, req } = adminRig();
    users.rep.customClaims.role = from;
    await mod.updateUserRole.__handler(req({ uid: 'rep', role: to }));
    const off = db.store.get('agent_keys/k1').active === false && db.store.get('calendar_feed_tokens/F1').status === 'revoked';
    const on = db.store.get('agent_keys/k1').active === true && db.store.get('calendar_feed_tokens/F1').status === 'active';
    ok('updateUserRole ' + from + ' → ' + to + ': bot key + calendar feed ' + (revoked ? 'revoked' : 'kept'), revoked ? off : on);
    if (revoked) {
      const revokedAt = events.indexOf('update:agent_keys/k1');
      const claimsAt = events.indexOf('claims:rep');
      ok('updateUserRole ' + from + ' → ' + to + ': revokes BEFORE the claim change', revokedAt >= 0 && claimsAt > revokedAt, events.join(' '));
    }
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('F. lapse cron + seat benching revoke too');
  {
    const events = [];
    const db = fakeDb({
      'companies/co-a/members/rep@x.test': { uid: 'rep', status: 'active' },
      'agent_keys/k1': { createdBy: 'rep', companyId: 'co-a', active: true },
      'calendar_feed_tokens/F1': { uid: 'rep', companyId: 'co-a', status: 'active' },
      'subscriptions/co-a': { status: 'cancelled' },
    });
    const auth = fakeAuth({ rep: { customClaims: { companyId: 'co-a' } } }, events);
    const stubs = Object.assign(baseStubs(db, auth), {
      './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h }) },
      './billing': { _test: { PLAN_LIMITS: { free: { reps: 1 } } } },
    });
    const mod = loadWith('lapse-enforcement.js', stubs);
    const fn = mod.enforceLapseForCompany || (mod._test && mod._test.enforceLapseForCompany);
    if (typeof fn === 'function') await fn(db, { id: 'co-a', ref: db.doc('subscriptions/co-a') });
    ok('lapse pause revokes the paused rep\'s bot key + feed',
      db.store.get('agent_keys/k1').active === false && db.store.get('calendar_feed_tokens/F1').status === 'revoked');
  }
  {
    const fs = require('fs');
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
    const inv = strip(fs.readFileSync(path.join(FN, 'handlers', 'invites.js'), 'utf8'));
    ok('assignSeats benching revokes the benched rep\'s credentials',
      /deactivatedReason: 'seat-unassigned'[\s\S]{0,400}revokeMemberAccessTokens\(/.test(inv)
      || /revokeMemberAccessTokens\([^)]*'seat-unassigned'/.test(inv));
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('G. crmMcp authenticate() — a removed / deactivated creator\'s key stops working');
  async function mcpRig(userPatch) {
    const crypto = require('crypto');
    const raw = 'nbdk_' + 'A'.repeat(40);
    const id = crypto.createHash('sha256').update(raw).digest('hex');
    const db = fakeDb({
      ['agent_keys/' + id]: { botId: 'c_bot1', customBotId: 'bot1', companyId: 'co-a', createdBy: 'rep', active: true },
      'agent_bots/bot1': { companyId: 'co-a', active: true, name: 'Helper', tools: ['crm_summary'] },
      'subscriptions/co-a': { status: 'active', plan: 'growth' },
    });
    const users = { rep: { customClaims: { companyId: 'co-a', role: 'company_admin' } } };
    if (userPatch === 'removed') users.rep.customClaims = {};
    if (userPatch === 'disabled') users.rep.disabled = true;
    if (userPatch === 'deleted') delete users.rep;
    const mod = loadWith('agent-mcp.js', baseStubs(db, fakeAuth(users, [])));
    return mod._internal.authenticate(raw);
  }
  {
    const live = await mcpRig(null);
    ok('control: an active creator\'s key authenticates', !!(live && live.key), JSON.stringify(live && live.body));
    const removed = await mcpRig('removed');
    ok('key refused after the creator is removed (claims stripped)', removed && !removed.key && removed.status === 401, JSON.stringify(removed && removed.status));
    const disabled = await mcpRig('disabled');
    ok('key refused after the creator is deactivated', disabled && !disabled.key && disabled.status === 401);
    const deleted = await mcpRig('deleted');
    ok('key refused when the creator account no longer exists', deleted && !deleted.key && deleted.status === 401);
  }

  // ═════════════════════════════════════════════════════════════════════
  console.log('H. getCalendarFeed — a removed / deactivated / viewer rep\'s feed stops serving');
  async function feedRig(userPatch) {
    const db = fakeDb({
      'calendar_feed_tokens/TOKENABCDEFGHJKLMN': { uid: 'rep', companyId: 'co-a', status: 'active' },
      'leads/L1': { userId: 'rep', companyId: 'co-a', firstName: 'Pat', scheduledDate: new Date().toISOString().slice(0, 10) },
    });
    const users = { rep: { customClaims: { companyId: 'co-a', role: 'sales_rep' } } };
    if (userPatch === 'removed') users.rep.customClaims = {};
    if (userPatch === 'disabled') users.rep.disabled = true;
    if (userPatch === 'viewer') users.rep.customClaims.role = 'viewer';
    const stubs = Object.assign(baseStubs(db, fakeAuth(users, [])), {
      './shared': { callableRateLimit: async () => {}, assertNotViewer: () => {} },
    });
    const mod = loadWith('calendar-feed.js', stubs);
    const res = { code: 0, body: '', headers: {}, status(c) { this.code = c; return this; }, set(k, v) { this.headers[k] = v; return this; }, send(b) { this.body = b; return this; } };
    await mod.getCalendarFeed.__handler({ method: 'GET', path: '/calendar/TOKENABCDEFGHJKLMN.ics', headers: {}, get: () => '' }, res);
    return res;
  }
  {
    const live = await feedRig(null);
    ok('control: an active rep\'s feed serves 200 text/calendar', live.code === 200 && /BEGIN:VCALENDAR/.test(live.body), live.code + ' ' + String(live.body).slice(0, 80));
    const removed = await feedRig('removed');
    ok('feed refused after removal', removed.code === 410 && !/BEGIN:VCALENDAR/.test(removed.body), removed.code + ' ' + removed.body);
    const disabled = await feedRig('disabled');
    ok('feed refused after deactivation', disabled.code === 410 && !/BEGIN:VCALENDAR/.test(disabled.body), String(disabled.code));
    const viewer = await feedRig('viewer');
    ok('feed refused once the rep is a viewer', viewer.code === 410 && !/BEGIN:VCALENDAR/.test(viewer.body), String(viewer.code));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) console.log('FAILED:\n  - ' + fails.join('\n  - '));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
