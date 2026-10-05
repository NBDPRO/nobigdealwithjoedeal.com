/**
 * tests/tenant-site-publish-2026-10-04.test.js — a new tenant's public
 * microsite starts PRIVATE; only the owner's publishTenantSite call
 * (brand name + phone + service area filled) publishes it.
 *
 * THE DEFECT
 * createCompany wrote companies/{uid}.status:'active', and getPublicSiteConfig
 * served every status-active company at /sites/t/<id>. So anyone could sign
 * up free and immediately have a page on nobigdealwithjoedeal.com with any
 * name and phone they typed — a phishing page on Jo's domain. `status` also
 * means "working CRM tenant", so it can't double as the publish switch.
 *
 * THE FIX
 * A separate companies/{id}.sitePublished flag. createCompany (and
 * setSiteSlug's ensure-path) write false; publishTenantSite flips it after the
 * readiness check; tenants that predate the flag (field absent) keep the
 * status-only behaviour so no prod doc changes at cutover. The client can't
 * write it — that half is in tests/firestore-rules.test.js (23e-2).
 *
 * WHY THIS EXECUTES: the handlers are loaded with stubbed requires and RUN
 * against an in-memory Firestore, end to end: createCompany → the public
 * endpoint 404s → publish refuses until phone + service area exist → publish
 * → the endpoint serves 200. Pure Node, no emulator.
 * Run: node tests/tenant-site-publish-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROV_SRC = fs.readFileSync(path.join(ROOT, 'functions/handlers/provisioning.js'), 'utf8');
const SITE_SRC = fs.readFileSync(path.join(ROOT, 'functions/handlers/public-site.js'), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}

class HttpsError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}

// In-memory Firestore: flat path → data map; doc get/set(merge)/create,
// batch, and the one collection query the public resolver uses (siteSlug).
function makeDb(seed) {
  const docs = JSON.parse(JSON.stringify(seed || {}));
  const merge = (a, b) => {
    const out = Object.assign({}, a || {});
    for (const k of Object.keys(b)) {
      const v = b[k];
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object')
        ? merge(out[k], v) : v;
    }
    return out;
  };
  const snap = (p) => ({ exists: Object.prototype.hasOwnProperty.call(docs, p), id: p.split('/').pop(), data: () => docs[p] });
  const ref = (p) => ({
    path: p,
    get: async () => snap(p),
    set: async (data, o) => { docs[p] = (o && o.merge) ? merge(docs[p], data) : data; },
    create: async (data) => {
      if (Object.prototype.hasOwnProperty.call(docs, p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
      docs[p] = data;
    },
  });
  return {
    _docs: docs,
    doc: ref,
    collection: (c) => ({
      where: (field, _op, val) => ({
        limit: () => ({
          get: async () => {
            const hits = Object.keys(docs)
              .filter((p) => p.startsWith(c + '/') && p.split('/').length === 2 && (docs[p] || {})[field] === val)
              .map(snap);
            return { empty: hits.length === 0, docs: hits };
          },
        }),
      }),
    }),
    runTransaction: async (fn) => {
      const ops = [];
      const out = await fn({
        get: (r) => r.get(),
        set: (r, data, o) => ops.push(() => r.set(data, o)),
        delete: (r) => ops.push(async () => { delete docs[r.path]; }),
      });
      for (const op of ops) await op();
      return out;
    },
    batch: () => {
      const ops = [];
      return {
        set: (r, data, o) => ops.push({ r, data, o }),
        commit: async () => { for (const op of ops) await op.r.set(op.data, op.o); },
      };
    },
  };
}

const holder = { db: null };
const claimsStore = {};

// requireTeamAdmin stand-in with the real ownerOnly semantics
// (functions/handlers/_shared.js teamAdminDecision): owner or platform admin.
async function requireTeamAdmin(request, target, opts) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const claims = request.auth.token || {};
  const companyId = target || claims.companyId || uid;
  const snap = await holder.db.doc('companies/' + companyId).get();
  const ownerId = snap.exists ? snap.data().ownerId : null;
  const isAdmin = claims.role === 'admin';
  const isOwner = ownerId === uid || (!snap.exists && companyId === uid);
  const isCoAdmin = !(opts && opts.ownerOnly) && claims.role === 'company_admin' && claims.companyId === companyId;
  if (!(isAdmin || isOwner || isCoAdmin)) throw new HttpsError('permission-denied', 'Owner or admin access required');
  return { uid, companyId, isOwner, isGlobalAdmin: isAdmin };
}

function load(src) {
  const stubs = {
    'firebase-functions/v2/https': {
      onCall: (_o, h) => h,
      onRequest: (_o, h) => h,
      HttpsError,
    },
    'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
    'firebase-admin/firestore': {
      getFirestore: () => holder.db,
      FieldValue: { serverTimestamp: () => 'ts', delete: () => '__delete__' },
    },
    'firebase-admin/auth': {
      getAuth: () => ({
        getUser: async (uid) => ({ customClaims: Object.assign({}, claimsStore[uid] || {}) }),
        setCustomUserClaims: async (uid, c) => { claimsStore[uid] = Object.assign({}, c); },
      }),
    },
    './_shared': { CORS_ORIGINS: [], requireTeamAdmin },
    '../shared': { callableRateLimit: async () => {} },
    '../prefix-reservation': { validateSeal: () => ({}), decideReservation: () => ({}) },
    '../integrations/upstash-ratelimit': { httpRateLimit: async () => true },
  };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, (id) => {
    if (!Object.prototype.hasOwnProperty.call(stubs, id)) throw new Error('unstubbed require(' + id + ')');
    return stubs[id];
  });
  return mod.exports;
}

const prov = load(PROV_SRC);
const site = load(SITE_SRC);

async function fetchSite(key) {
  const res = { code: 0, body: null, headers: {} };
  const r = {
    set: (k, v) => { res.headers[k] = v; return r; },
    status: (c) => { res.code = c; return r; },
    json: (b) => { res.body = b; return r; },
  };
  await site.getPublicSiteConfig({ method: 'GET', query: { company: key } }, r);
  return res;
}
async function call(fn, request) {
  try { return { value: await fn(request), error: null }; }
  catch (e) { return { value: null, error: e }; }
}

(async function main() {
  const OWNER = 'newOwnerUid1';
  const ownerReq = (data) => ({ auth: { uid: OWNER, token: { email: 'new@x.test', companyId: OWNER, role: 'company_admin' } }, data });

  console.log('\n1. a brand-new self-serve tenant is NOT served');
  holder.db = makeDb({
    // NBD as prod has it (status absent — never published through /sites/t).
    'companies/nbdUid': { name: 'No Big Deal Home Solutions', ownerId: 'nbdUid', source: 'owner-guard-backfill' },
    'companyProfile/nbdUid': { brand: { legalName: 'No Big Deal Home Solutions', contact: { phone: '(859) 420-7382' } }, serviceArea: 'Cincinnati' },
    // A tenant released before the flag existed (status active, flag absent).
    'companies/legacyCo': { name: 'Legacy Roofing', ownerId: 'legacyOwner', status: 'active' },
    'companyProfile/legacyCo': { brand: { legalName: 'Legacy Roofing', contact: { phone: '5135550100' } } },
  });
  const created = await call(prov.createCompany, {
    auth: { uid: OWNER, token: { email: 'new@x.test' } },
    data: { name: 'Totally Real Bank', phone: '5135550199', serviceArea: '' },
  });
  ok('createCompany succeeds', !created.error && created.value && created.value.created === true);
  const co = holder.db._docs['companies/' + OWNER] || {};
  ok("company stays status:'active' for the CRM", co.status === 'active');
  ok('company is born sitePublished:false', co.sitePublished === false);
  const r1 = await fetchSite(OWNER);
  ok('BUG GUARD: /sites/t/<new tenant> → 404 (was 200 the moment signup finished)', r1.code === 404);
  ok("…with the same opaque reason as an unknown key", r1.body && r1.body.reason === 'not_found');

  console.log('\n2. publishing requires brand name + phone + service area');
  // createCompany seeds only the PRIVATE alertSms — not a public phone.
  let p = await call(site.publishTenantSite, ownerReq({}));
  ok('publish refused while phone + service area are missing', p.error && p.error.code === 'failed-precondition');
  ok('refusal names what is missing',
    p.error && /phone/.test(p.error.message) && /service area/.test(p.error.message));
  ok('still not served after the refused publish', (await fetchSite(OWNER)).code === 404);
  await holder.db.doc('companyProfile/' + OWNER).set({ brand: { contact: { phone: '(513) 555-0199' } } }, { merge: true });
  p = await call(site.publishTenantSite, ownerReq({}));
  ok('publish still refused with only the phone filled', p.error && p.error.code === 'failed-precondition' && /service area/.test(p.error.message) && !/phone/.test(p.error.message));
  await holder.db.doc('companyProfile/' + OWNER).set({ serviceArea: 'Cincinnati, OH' }, { merge: true });

  console.log('\n3. only the owner may publish');
  const rep = await call(site.publishTenantSite, { auth: { uid: 'someRep', token: { companyId: OWNER, role: 'sales_rep' } }, data: {} });
  ok('a rep of the company is refused', rep.error && rep.error.code === 'permission-denied');
  const coAdmin = await call(site.publishTenantSite, { auth: { uid: 'coAdmin2', token: { companyId: OWNER, role: 'company_admin' } }, data: {} });
  ok('a non-owner company_admin is refused (ownerOnly)', coAdmin.error && coAdmin.error.code === 'permission-denied');
  ok('neither refused call published anything', holder.db._docs['companies/' + OWNER].sitePublished === false);

  console.log('\n4. a published tenant IS served');
  p = await call(site.publishTenantSite, ownerReq({}));
  ok('owner publish succeeds once ready', !p.error && p.value && p.value.published === true);
  ok('sitePublished:true written server-side', holder.db._docs['companies/' + OWNER].sitePublished === true);
  const r2 = await fetchSite(OWNER);
  ok('/sites/t/<published tenant> → 200', r2.code === 200 && r2.body && r2.body.ok === true);
  ok('serves the tenant phone (not the private alert number)', r2.body && r2.body.contact.phone === '(513) 555-0199');

  console.log('\n5. unpublish takes it down again');
  p = await call(site.publishTenantSite, ownerReq({ publish: false }));
  ok('owner unpublish succeeds', !p.error && p.value && p.value.published === false);
  ok('/sites/t/<unpublished tenant> → 404', (await fetchSite(OWNER)).code === 404);

  console.log('\n6. NBD + legacy tenants unaffected (no prod data change)');
  ok('NBD (status absent) still 404 at /sites/t — unchanged', (await fetchSite('nbdUid')).code === 404);
  ok('legacy released tenant (flag absent) still served — unchanged', (await fetchSite('legacyCo')).code === 200);
  await holder.db.doc('companies/legacyCo').set({ sitePublished: false }, { merge: true });
  ok("…and Jo's unpublish (sitePublished:false) takes it down", (await fetchSite('legacyCo')).code === 404);

  console.log('\n7. setSiteSlug ensure-path also starts unpublished');
  holder.db = makeDb({});
  const SOLO = 'soloNoDoc';
  const ss = await call(site.setSiteSlug, { auth: { uid: SOLO, token: { name: 'Solo' } }, data: { slug: 'solo-roofing' } });
  ok('setSiteSlug creates the missing company doc', !ss.error && !!holder.db._docs['companies/' + SOLO]);
  ok('…born sitePublished:false', (holder.db._docs['companies/' + SOLO] || {}).sitePublished === false);
  ok('/sites/t/solo-roofing → 404 until published', (await fetchSite('solo-roofing')).code === 404);

  console.log('\n8. the gate, value by value');
  const g = site.isPublishedCompany;
  ok('active + true → published', g({ status: 'active', sitePublished: true }) === true);
  ok('active + false → NOT published', g({ status: 'active', sitePublished: false }) === false);
  ok("active + 'true' (string) → NOT published", g({ status: 'active', sitePublished: 'true' }) === false);
  ok('active + null → NOT published', g({ status: 'active', sitePublished: null }) === false);
  ok('active + absent (legacy) → published', g({ status: 'active' }) === true);
  ok('superseded + true → NOT published', g({ status: 'superseded-by-invite', sitePublished: true }) === false);
  ok('status absent + true → NOT published', g({ sitePublished: true }) === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
