/**
 * tests/operator-scripts-dry-run-2026-11-17.test.js
 *
 * Repo sweep 2026-11-17 (M6, L14, L15, L16) and Jo's answers the same day:
 *   Q3  every prod-writing operator script is a DRY RUN unless given --apply
 *       (CLAUDE.md rule f): provision-tenant.js, seed-access-codes.js,
 *       seed-demo-access.js, grant-admin-claim.js
 *   Q4  provision-tenant.js refuses, unless --force, to move an account that
 *       already belongs to another company, to demote a platform admin, or to
 *       reassign a company that already has a different owner
 *   Q5  seed-access-codes.js no longer deactivates the public 'DEMO' code
 *   Q6  grant-admin-claim.js merges role:'admin' into the existing claims and
 *       checks companyId survived
 *   L16 upload-job-photos.js --apply finds legacy leads with no companyId,
 *       skips soft-deleted ones, never overwrites a Storage object, and exits
 *       non-zero when an upload fails
 *   L15 the photo sweep's token mode reads only this company's top-level
 *       leads (legacy userId leads included, soft-deleted ones dropped)
 *
 * Runs each real script against a fake Firestore / Auth / Storage.
 * Run: node tests/operator-scripts-dry-run-2026-11-17.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const S = (f) => path.join(ROOT, 'scripts', f);
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : '')); }
}

// ── a fake prod ──────────────────────────────────────────────────────────
function fakeWorld(docs, users) {
  const store = JSON.parse(JSON.stringify(docs || {}));
  const writes = [];
  const authWrites = [];
  const u = JSON.parse(JSON.stringify(users || {}));
  const ref = (p) => ({
    path: p, id: p.split('/').pop(),
    get: async () => ({ exists: p in store, id: p.split('/').pop(), data: () => (p in store ? Object.assign({}, store[p]) : undefined) }),
    set: async (v, o) => { writes.push(p); store[p] = (o && o.merge) ? Object.assign({}, store[p], v) : Object.assign({}, v); },
    update: async (v) => { writes.push(p); store[p] = Object.assign({}, store[p], v); },
    create: async (v) => { if (p in store) throw new Error('ALREADY_EXISTS'); writes.push(p); store[p] = Object.assign({}, v); },
  });
  const db = {
    collection: (c) => ({ doc: (id) => ref(c + '/' + id) }),
    doc: (p) => ref(p),
    terminate: async () => {},
  };
  const notFound = () => { const e = new Error('no user'); e.code = 'auth/user-not-found'; return e; };
  const auth = {
    getUser: async (uid) => { if (u[uid]) return JSON.parse(JSON.stringify(u[uid])); throw notFound(); },
    getUserByEmail: async (email) => { const x = Object.values(u).find((v) => v.email === email); if (x) return JSON.parse(JSON.stringify(x)); throw notFound(); },
    setCustomUserClaims: async (uid, claims) => { authWrites.push(['claims', uid]); u[uid].customClaims = Object.assign({}, claims); },
    revokeRefreshTokens: async (uid) => { authWrites.push(['revoke', uid]); },
    createUser: async (o) => { authWrites.push(['create', o.email]); const uid = 'newUid' + Object.keys(u).length; u[uid] = { uid, email: o.email, customClaims: {} }; return u[uid]; },
    updateUser: async (uid) => { authWrites.push(['update', uid]); },
  };
  return { db, auth, store, writes, authWrites, users: u };
}

// One set of module stubs, routed to the run in progress (same harness as
// tests/provision-tenant-sub-key-2026-11-15.test.js).
let current = null;
const origLoad = Module._load;
const origLog = console.log;
const origErr = console.error;
Module._load = function (req) {
  const w = current && current.world;
  if (w) {
    const FV = { serverTimestamp: () => 'TS', delete: () => 'DEL' };
    const TSc = { now: () => 'NOW', fromMillis: (ms) => ({ ms }) };
    if (req === 'firebase-admin') return { initializeApp: () => {} };
    if (req === 'firebase-admin/app') return { getApps: () => [1], getApp: () => ({ options: { projectId: 'fake' } }) };
    if (req === 'firebase-admin/firestore') return { getFirestore: () => w.db, FieldValue: FV, Timestamp: TSc };
    if (req === 'firebase-admin/auth') return { getAuth: () => w.auth };
    if (req === './_admin') return { initAdmin: () => {}, getFirestore: () => w.db, getAuth: () => w.auth, getStorage: () => w.storage, FieldValue: FV, Timestamp: TSc };
  }
  return origLoad.apply(this, arguments);
};
const realExit = process.exit;
process.exit = (code) => {
  if (current && !current.done) { current.done = true; current.resolve({ code: code == null ? 0 : code, out: current.out.join('\n') }); }
  throw new Error('__exit__');
};
process.on('unhandledRejection', (e) => {
  if (e && e.message === '__exit__') return;
  origLog('UNEXPECTED rejection: ' + (e && (e.stack || e.message)));
  realExit(1);
});
function run(script, argv, world, env) {
  const saveEnv = {};
  Object.keys(env || {}).forEach((k) => { saveEnv[k] = process.env[k]; process.env[k] = env[k]; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (!current.done) { current.done = true; resolve({ code: 'TIMEOUT', out: current.out.join('\n') }); } }, 5000);
    current = { world, out: [], done: false, resolve: (r) => { clearTimeout(timer); resolve(r); } };
    const run_ = current;
    console.log = (...a) => { if (!run_.done) run_.out.push(a.join(' ')); };
    console.error = console.log;
    process.argv = ['node', S(script)].concat(argv);
    delete require.cache[require.resolve(S(script))];
    try { require(S(script)); } catch (e) {
      if (e.message !== '__exit__' && !run_.done) { run_.done = true; resolve({ code: 99, out: run_.out.concat('THREW ' + e.message).join('\n') }); }
    }
  }).then((r) => {
    console.log = origLog;
    console.error = (...a) => { if (!a.join(' ').includes('__exit__')) origErr(...a); };
    Object.keys(saveEnv).forEach((k) => { if (saveEnv[k] === undefined) delete process.env[k]; else process.env[k] = saveEnv[k]; });
    return r;
  });
}

const OWNER = 'ownerUidAAAAAAAAAAAAAAAAAAAA';
const owner = (claims) => ({ [OWNER]: { uid: OWNER, email: 'zz-qa-owner@example.test', customClaims: claims || {} } });
const prov = (extra) => ['--company', 'oaks', '--owner-uid', OWNER, '--name', 'Oaks'].concat(extra || []);

(async () => {
  // ════════════════════════════════════════════════════════════════════
  console.log('\nprovision-tenant.js');
  {
    const w = fakeWorld({}, owner({}));
    const r = await run('provision-tenant.js', prov(), w);
    ok('no --apply → a dry run: exits 0, writes no Firestore doc and no Auth change', r.code === 0 && w.writes.length === 0 && w.authWrites.length === 0, { code: r.code, writes: w.writes, auth: w.authWrites, out: r.out });
    ok('…and prints the claims, company and subscription it WOULD write', /DRY RUN/.test(r.out) && /"companyId":"oaks"/.test(r.out) && /companies\/oaks/.test(r.out) && /subscriptions\/oaks/.test(r.out), r.out);
  }
  {
    const w = fakeWorld({}, owner({}));
    const r = await run('provision-tenant.js', prov(['--apply']), w);
    ok('--apply on a clean owner provisions: claims, company, subscription', r.code === 0 && w.users[OWNER].customClaims.companyId === 'oaks' && w.writes.includes('companies/oaks') && w.writes.includes('subscriptions/oaks'), { code: r.code, out: r.out });
  }
  {
    const w = fakeWorld({}, owner({ companyId: 'acme', role: 'company_admin' }));
    const r = await run('provision-tenant.js', prov(['--apply']), w);
    ok('--apply refuses to move an account that belongs to another company (exit non-zero, nothing written)', r.code !== 0 && w.writes.length === 0 && w.authWrites.length === 0 && /acme/.test(r.out), { code: r.code, writes: w.writes, out: r.out });
    const w2 = fakeWorld({}, owner({ companyId: 'acme', role: 'company_admin' }));
    const r2 = await run('provision-tenant.js', prov(['--apply', '--force']), w2);
    ok('…--force lets it through', r2.code === 0 && w2.users[OWNER].customClaims.companyId === 'oaks', { code: r2.code, out: r2.out });
  }
  {
    const w = fakeWorld({}, owner({ role: 'admin' }));
    const r = await run('provision-tenant.js', prov(['--apply']), w);
    ok('--apply refuses to demote a platform admin', r.code !== 0 && w.authWrites.length === 0 && /admin/.test(r.out), { code: r.code, out: r.out });
  }
  {
    const w = fakeWorld({ 'companies/oaks': { ownerId: 'someoneElseBBBBBBBBBBBBBBBBB' } }, owner({}));
    const r = await run('provision-tenant.js', prov(['--apply']), w);
    ok('--apply refuses to reassign a company that already has a different owner', r.code !== 0 && w.writes.length === 0 && w.authWrites.length === 0, { code: r.code, out: r.out });
    const w2 = fakeWorld({ 'companies/oaks': { ownerId: OWNER } }, owner({ companyId: 'oaks', role: 'company_admin' }));
    const r2 = await run('provision-tenant.js', prov(['--apply']), w2);
    ok('…the same owner re-running is fine (idempotent)', r2.code === 0, { code: r2.code, out: r2.out });
  }
  {
    // A stale --owner-uid plus the email of an EXISTING admin account: it must be
    // checked as that account, not planned as "create" and written unchecked.
    const jo = { joUid: { uid: 'joUid', email: 'jd@example.test', customClaims: { companyId: 'joUid', role: 'admin' } } };
    const w = fakeWorld({}, jo);
    const args = ['--company', 'newco', '--owner-uid', 'staleUidCCCCCCCCCCCCCCCCCCCCC', '--owner-email', 'jd@example.test', '--name', 'X'];
    const dry = await run('provision-tenant.js', args, w);
    ok('stale --owner-uid + an existing --owner-email: the dry run names the existing account and the refusal', /joUid/.test(dry.out) && /REFUSE/.test(dry.out) && !/CREATE/.test(dry.out), dry.out);
    const r = await run('provision-tenant.js', args.concat(['--apply']), w);
    ok('…and --apply refuses: the admin account is not demoted or moved', r.code !== 0 && w.authWrites.length === 0 && w.users.joUid.customClaims.role === 'admin', { code: r.code, auth: w.authWrites, out: r.out });
  }
  {
    const r = await run('provision-tenant.js', ['--company', 'abcdefghijklmnopqrstuvwxyz'], fakeWorld({}, {}));
    ok('the uid-looking-company refusal no longer points at the deleted set-jd-claims.js', r.code !== 0 && !/set-jd-claims/.test(r.out), r.out);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nseed-access-codes.js');
  {
    const docs = { 'access_codes/DEMO': { active: true }, 'access_codes/NBD-2026': { active: true } };
    const w = fakeWorld(docs, {});
    const r = await run('seed-access-codes.js', [], w, { BETA_COUNT: '2', DEMO_COUNT: '0' });
    ok('no --apply → a dry run: nothing written, no codes minted or printed', r.code === 0 && w.writes.length === 0 && !/NEW ACCESS CODES/.test(r.out), { code: r.code, writes: w.writes, out: r.out });
    ok('…it says what it WOULD do', /DRY RUN/.test(r.out) && /NBD-2026/.test(r.out) && /2 beta/.test(r.out), r.out);
    const w2 = fakeWorld(docs, {});
    const r2 = await run('seed-access-codes.js', ['--apply'], w2, { BETA_COUNT: '2', DEMO_COUNT: '0' });
    ok('--apply deactivates the legacy NBD-2026 code and mints the codes', r2.code === 0 && w2.store['access_codes/NBD-2026'].active === false && w2.writes.filter((p) => /^access_codes\/NBD-[A-Z0-9]{10}$/.test(p)).length === 2, { code: r2.code, writes: w2.writes });
    ok('…and leaves the public DEMO code active (the Try Demo button keeps working)', w2.store['access_codes/DEMO'].active === true && !w2.writes.includes('access_codes/DEMO'), w2.store['access_codes/DEMO']);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nseed-demo-access.js');
  {
    const w = fakeWorld({ 'access_codes/DEMO': { active: false } }, {});
    const r = await run('seed-demo-access.js', [], w);
    ok('no --apply → a dry run: DEMO is not written', r.code === 0 && w.writes.length === 0 && /DRY RUN/.test(r.out), { code: r.code, writes: w.writes, out: r.out });
    const w2 = fakeWorld({ 'access_codes/DEMO': { active: false } }, {});
    const r2 = await run('seed-demo-access.js', ['--apply'], w2);
    ok('--apply activates access_codes/DEMO', r2.code === 0 && w2.store['access_codes/DEMO'].active === true, { code: r2.code, out: r2.out });
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\ngrant-admin-claim.js');
  const JO = { joUid: { uid: 'joUid', email: 'jd@nobigdealwithjoedeal.com', customClaims: { companyId: 'joUid', role: 'company_admin', owner: true, plan: 'professional' } } };
  {
    const w = fakeWorld({}, JO);
    const r = await run('grant-admin-claim.js', [], w);
    ok('no --apply → a dry run: no claims written, no sessions revoked', r.code === 0 && w.authWrites.length === 0 && /DRY RUN/.test(r.out), { code: r.code, auth: w.authWrites, out: r.out });
    const w2 = fakeWorld({}, JO);
    const r2 = await run('grant-admin-claim.js', ['--apply'], w2);
    const c = w2.users.joUid.customClaims;
    ok('--apply sets role admin', r2.code === 0 && c.role === 'admin', { code: r2.code, c, out: r2.out });
    ok('…and KEEPS companyId, owner and plan (merge, not replace)', c.companyId === 'joUid' && c.owner === true && c.plan === 'professional', c);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nupload-job-photos.js --apply');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-upl-'));
    const f = (n) => { const p = path.join(tmp, n); fs.writeFileSync(p, 'x'); return p.split(path.sep).join('/'); };
    const rows = [
      ['NBD-0001', 'a.heic', f('a.jpg'), f('a_t.jpg'), 'after', '2026-06-01T12:00:00Z', '', '', '10'],
      ['NBD-0002', 'b.heic', f('b.jpg'), f('b_t.jpg'), 'after', '2026-06-01T12:00:00Z', '', '', '10'],
      ['NBD-0003', 'c.heic', f('c.jpg'), f('c_t.jpg'), 'after', '2026-06-01T12:00:00Z', '', '', '10'],
    ];
    const manifest = path.join(tmp, 'm.csv');
    fs.writeFileSync(manifest, 'lead_id,source,jpeg,thumb,phase,taken_at,lat,lng,bytes\n' + rows.map((r) => r.join(',')).join('\n') + '\n');
    const C = 'coNBD';
    const leadsStore = {
      L1: { customerId: 'NBD-0001', companyId: C, userId: C },
      L2: { customerId: 'NBD-0002', userId: C },                   // legacy: no companyId
      L3: { customerId: 'NBD-0003', companyId: C, userId: C, isDeleted: true },
      X9: { customerId: 'NBD-0002', companyId: 'other', userId: 'other' }, // another tenant's NBD-0002
    };
    function uploadWorld(opt) {
      const w = fakeWorld({}, {});
      const uploads = [];
      w.db.collection = (c) => {
        if (c !== 'leads') return { doc: (id) => w.db.doc(c + '/' + id) };
        const q = (filters) => ({
          where: (fld, op, v) => q(filters.concat([[fld, v]])),
          get: async () => {
            const docs = Object.keys(leadsStore).filter((id) => filters.every(([fld, v]) => leadsStore[id][fld] === v))
              .map((id) => ({ id, data: () => Object.assign({}, leadsStore[id]) }));
            return { size: docs.length, docs };
          },
        });
        return q([]);
      };
      // objects: dest → { gen, nbdPhotoId } (what is already in Storage)
      const objects = Object.assign({}, (opt && opt.objects) || {});
      w.storage = { bucket: () => ({
        upload: async (src, o) => {
          uploads.push(o);
          if (opt && opt.failOn && o.destination.includes(opt.failOn)) throw new Error('boom');
          const cur = objects[o.destination];
          const want = o.preconditionOpts && o.preconditionOpts.ifGenerationMatch;
          if (want === 0 && cur) { const e = new Error('precondition'); e.code = 412; throw e; }
          if (want && (!cur || cur.gen !== want)) { const e = new Error('precondition'); e.code = 412; throw e; }
          objects[o.destination] = { gen: (cur ? cur.gen : 0) + 1, nbdPhotoId: o.metadata && o.metadata.metadata && o.metadata.metadata.nbdPhotoId, replaced: !!cur };
        },
        file: (dest) => ({ getMetadata: async () => [objects[dest] ? { generation: String(objects[dest].gen), metadata: { nbdPhotoId: objects[dest].nbdPhotoId } } : {}] }),
      }) };
      w.uploads = uploads;
      w.objects = objects;
      return w;
    }
    let U = null;
    try { U = require(S('upload-job-photos.js')); } catch (e) { /* red below */ }
    ok('upload-job-photos.js exports main for a stubbed run', !!U && typeof U.main === 'function');
    if (U && U.main) {
      const go = async (w) => {
        current = { world: w, out: [], done: true };
        const out = [];
        console.log = (...a) => out.push(a.join(' ')); console.error = console.log;
        let code;
        try { code = await U.main(['--manifest', manifest, '--company=' + C, '--apply', '--yes']); } catch (e) { code = 'THREW ' + e.message; }
        console.log = origLog; console.error = origErr;
        current = null;
        return { code, out: out.join('\n') };
      };
      const w = uploadWorld();
      const r = await go(w);
      const photoLeads = Object.keys(w.store).filter((p) => p.startsWith('photos/')).map((p) => w.store[p].leadId).sort();
      ok('a legacy lead with no companyId (userId == company) is found and filed', photoLeads.includes('L2'), { photoLeads, out: r.out });
      ok('…another tenant\'s lead with the same display id is not used', !photoLeads.includes('X9'));
      ok('a soft-deleted lead (isDeleted) is skipped', !photoLeads.includes('L3'), photoLeads);
      ok('every Storage upload refuses to overwrite (ifGenerationMatch: 0)', w.uploads.length > 0 && w.uploads.every((o) => o.preconditionOpts && o.preconditionOpts.ifGenerationMatch === 0), w.uploads.map((o) => o.preconditionOpts));
      ok('all good → exit code 0', r.code === 0, r);
      const wf = uploadWorld({ failOn: 'L1' });
      const rf = await go(wf);
      ok('an upload failure → a non-zero exit code (never "done" when a photo failed)', rf.code !== 0 && rf.code != null, rf);

      const PU = require(S('lib/photo-upload.js'));
      const id1 = PU.photoIdFor('L1', 'a.heic');
      const p1 = PU.buildPaths(C, 'L1', id1).photoPath;
      const wr = uploadWorld({ objects: { [p1]: { gen: 7, nbdPhotoId: id1 } } });
      const rr = await go(wr);
      ok('a re-run finishes a photo whose earlier upload died before filing (same nbdPhotoId → replaced)',
        rr.code === 0 && !!wr.store['photos/' + id1] && wr.objects[p1].replaced === true, { code: rr.code, out: rr.out });
      const wo = uploadWorld({ objects: { [p1]: { gen: 3, nbdPhotoId: 'someone-else' } } });
      const ro = await go(wo);
      ok('a DIFFERENT file already at the path is left alone, that photo fails, exit non-zero',
        ro.code !== 0 && !wo.store['photos/' + id1] && wo.objects[p1].gen === 3, { code: ro.code, obj: wo.objects[p1] });
    }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nmatch-job-photos-sweep-2026-11-10.js token mode');
  {
    let SW = null;
    try { SW = require(S('match-job-photos-sweep-2026-11-10.js')); } catch (e) { /* red below */ }
    ok('the sweep exports loadLeads', !!SW && typeof SW.loadLeads === 'function');
    if (SW && SW.loadLeads) {
      const C = 'coNBD';
      const leads = {
        A: { companyId: C, userId: C, firstName: 'A' },
        B: { userId: C, firstName: 'B' },                       // legacy
        D: { companyId: C, userId: C, deleted: true },
        E: { companyId: C, userId: C, deletedAt: '2026-01-01' },
        O: { companyId: 'other', userId: 'other' },
      };
      const reads = [];
      const db = {
        collection: (c) => {
          const q = (filters) => ({
            where: (f, op, v) => q(filters.concat([[f, v]])),
            orderBy: () => q(filters), limit: () => q(filters), startAfter: () => q(filters),
            get: async () => {
              reads.push(c + ':' + filters.map((x) => x.join('=')).join('&'));
              const docs = Object.keys(leads).filter((id) => filters.every(([f, v]) => leads[id][f] === v)).map((id) => ({ id, data: () => Object.assign({}, leads[id]) }));
              return { size: docs.length, docs };
            },
          });
          return q([]);
        },
        collectionGroup: () => { reads.push('collectionGroup'); throw new Error('collectionGroup must not be used'); },
      };
      let got = null, err = null;
      try { got = await SW.loadLeads({ company: C, project: 'p' }, { db }); } catch (e) { err = e.message; }
      const ids = (got || []).map((l) => l.id).sort();
      ok('reads only this company\'s top-level leads (no collection-group scan of every tenant)', !reads.includes('collectionGroup') && reads.every((r) => r.startsWith('leads:')), { reads, err });
      ok('keeps the legacy lead with no companyId', ids.includes('B'), ids);
      ok('drops soft-deleted leads (deleted / deletedAt) and other tenants', ids.join() === 'A,B', ids);
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  realExit(failed ? 1 : 0);
})().catch((e) => { origLog(e && e.stack || e); realExit(1); });
