/**
 * Storage rules: product-photos/{companyId}/{ownerId}/{file} (2026-11-18, supplier
 * price ledger, flag supplierPricing).
 *
 * A product or supplier-item picture, re-encoded and written by the server only
 * (priceLedgerSave savePhoto). This suite proves:
 *   - the company's owner, company_admin, manager and sales_rep read it (getBlob);
 *   - a viewer, an access-code member, another company, the platform admin and
 *     anonymous read nothing;
 *   - POSITIVE CONTROL: the same object is readable by the owner, so a rule that
 *     denies everything can not pass this file;
 *   - nobody writes or deletes, the owner and the platform admin included;
 *   - hand-off, as storage.rules documents it: a removed former owner whose claims
 *     were stripped still reads (claims only here; accepted in writing), a former
 *     owner demoted to viewer reads nothing.
 *
 * RUN:
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only storage --project nbd-prodphotos-test \
 *     'node storage-rules.product-photos.test.js'
 * RULES_PATH points the suite at a mutated copy of storage.rules (the mutation check).
 */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-prodphotos-test';
{
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT_ID)) {
    throw new Error('refusing to load test rules into the app project "' + PROJECT_ID + '"');
  }
}

const results = [];
async function check(label, expect, promise) {
  try {
    if (expect === 'deny') await assertFails(promise); else await assertSucceeds(promise);
    results.push({ label, ok: true });
  } catch (e) {
    results.push({ label, ok: false, note: expect === 'deny' ? 'WAS ALLOWED' : 'was denied: ' + String((e && e.message) || e).slice(0, 160) });
  }
}
const buf = (n) => Buffer.alloc(n, 1);

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../storage.rules'), 'utf8'), host: String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':')[0], port: Number(String(process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':')[1]) || 9199 },
  });
  const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');
  const P = (co) => 'product-photos/' + (co || 'co-a') + '/shingle_001/abc.webp';
  const WEBP = { contentType: 'image/webp' };
  await env.withSecurityRulesDisabled(async (c) => {
    await uploadBytes(ref(c.storage(), P()), buf(64), WEBP);
    await uploadBytes(ref(c.storage(), P('co-h')), buf(64), WEBP);
    await uploadBytes(ref(c.storage(), 'price-docs/co-a/d_1.pdf'), buf(64), { contentType: 'application/pdf' });
  });

  const st = (uid, claims) => env.authenticatedContext(uid, claims).storage();
  const owner = st('co-a', {});                                             // solo owner: uid == companyId
  const readers = {
    'a company_admin': st('carol', { role: 'company_admin', companyId: 'co-a' }),
    'a manager': st('mike', { role: 'manager', companyId: 'co-a' }),
    'a sales rep': st('alice', { role: 'sales_rep', companyId: 'co-a' }),
  };
  const outsiders = {
    'a viewer': st('vic', { role: 'viewer', companyId: 'co-a' }),
    'a viewer whose uid IS the company id': st('co-a', { role: 'viewer' }),
    'an access-code member': st('mem', { role: 'member', companyId: 'co-a' }),
    "another company's admin": st('bobca', { role: 'company_admin', companyId: 'co-b' }),
    "another company's solo owner": st('co-b', {}),
    'a platform admin': st('joe', { role: 'admin' }),
    'anonymous': env.unauthenticatedContext().storage(),
  };

  // -- reads: the positive control FIRST, then every other identity on the SAME object
  await check('POSITIVE CONTROL: the solo owner reads the photo', 'allow', getBytes(ref(owner, P())));
  for (const [label, s] of Object.entries(readers)) await check(label + ' of the company reads it', 'allow', getBytes(ref(s, P())));
  for (const [label, s] of Object.entries(outsiders)) await check(label + ' CANNOT read it', 'deny', getBytes(ref(s, P())));

  // -- nobody writes or deletes: the server writes with the admin SDK
  for (const [label, s] of Object.entries(Object.assign({ 'the solo owner': owner }, readers, outsiders))) {
    await check(label + ' CANNOT upload a photo', 'deny', uploadBytes(ref(s, 'product-photos/co-a/shingle_001/new.webp'), buf(10), WEBP));
    await check(label + ' CANNOT overwrite a photo', 'deny', uploadBytes(ref(s, P()), buf(10), WEBP));
    await check(label + ' CANNOT delete a photo', 'deny', deleteObject(ref(s, P())));
  }
  await check('control: the photo is still there after every denied write', 'allow', getBytes(ref(owner, P())));

  // -- hand-off (companies/co-h names a new owner; Storage rules read claims only)
  await check('a removed former owner (no claims) still reads, as storage.rules documents', 'allow', getBytes(ref(st('co-h', {}), P('co-h'))));
  await check('a former owner demoted to viewer reads nothing', 'deny', getBytes(ref(st('co-h', { role: 'viewer', companyId: 'co-h' }), P('co-h'))));
  await check('the new owner (company_admin claim) reads', 'allow', getBytes(ref(st('newowner', { role: 'company_admin', companyId: 'co-h' }), P('co-h'))));

  // -- supplier documents (slice 9, 2026-11-18): price-docs/{companyId}/{file}, owner and company_admin only
  const DOCP = 'price-docs/co-a/d_1.pdf';
  await check('POSITIVE CONTROL: the solo owner reads a supplier document', 'allow', getBytes(ref(owner, DOCP)));
  await check('a company_admin reads it', 'allow', getBytes(ref(readers['a company_admin'], DOCP)));
  for (const [label, s] of Object.entries({ 'a manager': readers['a manager'], 'a sales rep': readers['a sales rep'] }).concat(Object.entries(outsiders))) await check(label + ' CANNOT read a supplier document', 'deny', getBytes(ref(s, DOCP)));
  for (const [label, s] of Object.entries(Object.assign({ 'the solo owner': owner }, readers))) {
    await check(label + ' CANNOT upload a supplier document', 'deny', uploadBytes(ref(s, 'price-docs/co-a/new.pdf'), buf(10), { contentType: 'application/pdf' }));
    await check(label + ' CANNOT delete a supplier document', 'deny', deleteObject(ref(s, DOCP)));
  }

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nproduct-photos storage rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
