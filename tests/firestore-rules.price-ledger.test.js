/**
 * Firestore rules - the supplier price ledger under priceBook/{companyId}/…
 * (2026-11-17, flag supplierPricing; design section 2.4, the "slice 1" cases).
 *
 * Every write is a Cloud Function (admin SDK); a browser only reads. Offers and supplier
 * accounts: owner, company_admin, manager (a sales_rep was dropped 2026-11-18, Jo: reps never
 * read a supplier price; productLinks stay readable by a rep). Observations and meters: owner,
 * company_admin, manager. Audit: owner, company_admin. A viewer, the access-code role
 * `member`, a token with no role and another tenant read nothing.
 *
 * SYNTHETIC ids and numbers only (public repo): a fictional supplier, SKUs that start TEST-,
 * prices that are multiples of 1111. tests/price-fixture-privacy.test.js scans this file.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-priceledger-test \
 *     'node firestore-rules.price-ledger.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-priceledger-test';
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

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[0], port: Number(String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[1]) || 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const { setDoc, updateDoc, deleteDoc, doc, getDoc, getDocs, collectionGroup, query, where } = require('firebase/firestore');

  const WHO = {
    'solo owner (uid is the company)': ctx('co-a', {}),
    'company_admin': ctx('carol', { role: 'company_admin', companyId: 'co-a' }),
    'manager': ctx('mona', { role: 'manager', companyId: 'co-a' }),
    'sales_rep': ctx('rep1', { role: 'sales_rep', companyId: 'co-a' }),
    'viewer': ctx('vera', { role: 'viewer', companyId: 'co-a' }),
    'member (access code)': ctx('mem1', { role: 'member', companyId: 'co-a' }),
    'role-less token with the claim': ctx('norole', { companyId: 'co-a' }),
    'another company': ctx('eve', { role: 'company_admin', companyId: 'co-b' }),
    'platform admin': ctx('joe', { role: 'admin' }),
  };
  const anon = env.authenticatedContext('anon1', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  const signedOut = env.unauthenticatedContext().firestore();

  const BASE = 'priceBook/co-a/';
  const PATHS = {
    account: BASE + 'supplierAccounts/other_testco',
    offer: BASE + 'priceOffers/other_testco_TEST-0001',
    obs: BASE + 'priceObservations/o_1',
    meter: BASE + 'priceMeter/rows_2026-11-17',
    audit: BASE + 'priceAudit/a_1',
  };
  const DATA = {
    account: { supplierId: 'other_testco', label: 'Testco Supply', type: 'distributor', active: true },
    offer: { v: 1, supplierId: 'other_testco', sku: 'TEST-0001', title: 'Testco Example Shingle', productId: 'shingle_001', active: true },
    obs: { v: 1, offerId: 'other_testco_TEST-0001', kind: 'quote', priceMicros: 11110000, per: 1, statedUnit: 'BDL', voided: false },
    meter: { rows: 1 },
    audit: { v: 1, type: 'link', targetType: 'offer', targetId: 'other_testco_TEST-0001' },
  };
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'priceBook/co-a'), { items: {} });
    for (const k of Object.keys(PATHS)) await setDoc(doc(db, PATHS[k]), DATA[k]);
    // hand-off: co-h now belongs to someone else
    await setDoc(doc(db, 'companies/co-h'), { ownerId: 'newowner' });
    await setDoc(doc(db, 'priceBook/co-h/priceOffers/other_testco_TEST-0001'), DATA.offer);
    await setDoc(doc(db, 'priceBook/co-h/priceObservations/o_1'), DATA.obs);
    await setDoc(doc(db, 'priceBook/co-h/priceAudit/a_1'), DATA.audit);
    await setDoc(doc(db, 'priceBook/co-h/priceConfig/seen'), { marks: {} });
    await setDoc(doc(db, 'priceBook/co-h/productLinks/shingle_001'), { v: 1 });
    for (const p of ['priceAlerts/x', 'priceImports/x', 'priceConfig/main', 'priceConfig/seen', 'productLinks/shingle_001', 'priceNotices/x', 'priceRollups/2026-11', 'leadSkus/lead1']) await setDoc(doc(db, BASE + p), { v: 1 });
    await setDoc(doc(db, 'retail_shelf_cache/x'), { v: 1 });
    await setDoc(doc(db, 'price_check_global/day_2026-11-17'), { v: 1 });
    await setDoc(doc(db, 'integrations/pricing/companies/co-a'), { enabled: false });
  });

  // 1. offers and supplier accounts. A sales_rep reads neither (Jo, 2026-11-18: reps never read a supplier price)
  const members = ['solo owner (uid is the company)', 'company_admin', 'manager', 'sales_rep'];
  const outsiders = ['viewer', 'member (access code)', 'role-less token with the claim', 'another company'];
  for (const w of ['solo owner (uid is the company)', 'company_admin', 'manager']) {
    await check('1. ' + w + ' reads an offer', 'allow', getDoc(doc(WHO[w], PATHS.offer)));
    await check('1. ' + w + ' reads a supplier account', 'allow', getDoc(doc(WHO[w], PATHS.account)));
  }
  for (const w of ['sales_rep'].concat(outsiders)) {
    await check('1. ' + w + ' can not read an offer', 'deny', getDoc(doc(WHO[w], PATHS.offer)));
    await check('1. ' + w + ' can not read a supplier account', 'deny', getDoc(doc(WHO[w], PATHS.account)));
  }

  // 2. observations and meters
  for (const w of ['solo owner (uid is the company)', 'company_admin', 'manager']) {
    await check('2. ' + w + ' reads an observation', 'allow', getDoc(doc(WHO[w], PATHS.obs)));
    await check('2. ' + w + ' reads a meter doc', 'allow', getDoc(doc(WHO[w], PATHS.meter)));
    await check('2. ' + w + ' reading a meter doc that does not exist is not a permission error', 'allow', getDoc(doc(WHO[w], BASE + 'priceMeter/rows_2099-01-01')));
  }
  for (const w of ['sales_rep', 'viewer', 'member (access code)', 'role-less token with the claim', 'another company']) {
    await check('2. ' + w + ' can not read an observation', 'deny', getDoc(doc(WHO[w], PATHS.obs)));
    await check('2. ' + w + ' can not read a meter doc', 'deny', getDoc(doc(WHO[w], PATHS.meter)));
  }

  // 3. audit
  for (const w of ['solo owner (uid is the company)', 'company_admin']) await check('3. ' + w + ' reads audit', 'allow', getDoc(doc(WHO[w], PATHS.audit)));
  for (const w of ['manager', 'sales_rep', 'viewer', 'member (access code)', 'role-less token with the claim', 'another company']) await check('3. ' + w + ' can not read audit', 'deny', getDoc(doc(WHO[w], PATHS.audit)));

  // 4. nobody writes, the platform admin included
  for (const w of Object.keys(WHO)) {
    for (const k of Object.keys(PATHS)) {
      await check('4. ' + w + ' can not create ' + k, 'deny', setDoc(doc(WHO[w], PATHS[k] + '_new'), DATA[k]));
      await check('4. ' + w + ' can not update ' + k, 'deny', updateDoc(doc(WHO[w], PATHS[k]), { touched: true }));
      await check('4. ' + w + ' can not delete ' + k, 'deny', deleteDoc(doc(WHO[w], PATHS[k])));
    }
  }

  // 5. hand-off (companies/co-h names a new owner)
  const H = 'priceBook/co-h/';
  const removed = ctx('co-h', {});
  const demoted = ctx('co-h', { role: 'sales_rep', companyId: 'co-h' });
  const kept = ctx('co-h', { role: 'company_admin', companyId: 'co-h' });
  const newOwner = ctx('newowner', { role: 'company_admin', companyId: 'co-h' });
  await check('5. a removed former owner (no claims) can not read an offer', 'deny', getDoc(doc(removed, H + 'priceOffers/other_testco_TEST-0001')));
  await check('5. a removed former owner can not read an observation', 'deny', getDoc(doc(removed, H + 'priceObservations/o_1')));
  await check('5. a removed former owner can not read audit', 'deny', getDoc(doc(removed, H + 'priceAudit/a_1')));
  await check('5. a former owner demoted to sales_rep can not read offers', 'deny', getDoc(doc(demoted, H + 'priceOffers/other_testco_TEST-0001')));
  await check('5. a former owner demoted to sales_rep can not read an observation', 'deny', getDoc(doc(demoted, H + 'priceObservations/o_1')));
  await check('5. a former owner demoted to sales_rep can not read audit', 'deny', getDoc(doc(demoted, H + 'priceAudit/a_1')));
  await check('5. a former owner kept as company_admin reads an observation', 'allow', getDoc(doc(kept, H + 'priceObservations/o_1')));
  await check('5. a former owner kept as company_admin reads audit', 'allow', getDoc(doc(kept, H + 'priceAudit/a_1')));
  await check('5. the new owner reads an offer', 'allow', getDoc(doc(newOwner, H + 'priceOffers/other_testco_TEST-0001')));
  await check('5. the new owner reads an observation', 'allow', getDoc(doc(newOwner, H + 'priceObservations/o_1')));
  await check('5. the new owner reads audit', 'allow', getDoc(doc(newOwner, H + 'priceAudit/a_1')));

  // 6. anonymous provider, and signed out
  for (const k of Object.keys(PATHS)) {
    await check('6. an anonymous-provider token can not read ' + k, 'deny', getDoc(doc(anon, PATHS[k])));
    await check('6. a signed-out browser can not read ' + k, 'deny', getDoc(doc(signedOut, PATHS[k])));
  }

  // 7. server-only collections of later slices (default deny today)
  for (const p of ['retail_shelf_cache/x', 'price_check_global/day_2026-11-17', 'integrations/pricing/companies/co-a']) {
    for (const w of ['solo owner (uid is the company)', 'company_admin', 'platform admin']) {
      await check('7. ' + w + ' can not read ' + p, 'deny', getDoc(doc(WHO[w], p)));
      await check('7. ' + w + ' can not write ' + p, 'deny', setDoc(doc(WHO[w], p), { v: 2 }));
    }
  }

  // 8. the legacy priceBook/{companyId} doc behaves as before
  await check('8. a sales rep still reads the legacy price book doc', 'allow', getDoc(doc(WHO.sales_rep, 'priceBook/co-a')));
  await check('8. a viewer still reads the legacy price book doc', 'allow', getDoc(doc(WHO.viewer, 'priceBook/co-a')));
  await check('8. another company still can not read it', 'deny', getDoc(doc(WHO['another company'], 'priceBook/co-a')));
  await check('8. the owner still writes it', 'allow', setDoc(doc(WHO['solo owner (uid is the company)'], 'priceBook/co-a'), { items: {} }, { merge: true }));
  await check('8. a sales rep still can not write it', 'deny', setDoc(doc(WHO.sales_rep, 'priceBook/co-a'), { items: {} }, { merge: true }));

  // 9. no collection-group read
  for (const w of ['solo owner (uid is the company)', 'company_admin', 'platform admin']) {
    await check('9. ' + w + ' can not read priceObservations as a collection group', 'deny', getDocs(query(collectionGroup(WHO[w], 'priceObservations'), where('offerId', '==', 'other_testco_TEST-0001'))));
  }

  // 10. paths later slices add are denied to everyone today (each line goes when its slice lands)
  for (const p of ['priceAlerts/x', 'priceImports/x', 'priceNotices/x', 'priceRollups/2026-11', 'leadSkus/lead1']) {
    await check('10. the owner can not read ' + p + ' yet', 'deny', getDoc(doc(WHO['solo owner (uid is the company)'], BASE + p)));
    await check('10. a company_admin can not read ' + p + ' yet', 'deny', getDoc(doc(WHO.company_admin, BASE + p)));
  }

  // 11. priceConfig (slice 3): the shared "seen" marks. Owner and company_admin read; nobody writes
  for (const p of ['priceConfig/seen', 'priceConfig/main']) {
    for (const w of ['solo owner (uid is the company)', 'company_admin']) await check('11. ' + w + ' reads ' + p, 'allow', getDoc(doc(WHO[w], BASE + p)));
    for (const w of ['manager', 'sales_rep', 'viewer', 'member (access code)', 'role-less token with the claim', 'another company']) await check('11. ' + w + ' can not read ' + p, 'deny', getDoc(doc(WHO[w], BASE + p)));
    for (const w of Object.keys(WHO)) {
      await check('11. ' + w + ' can not write ' + p, 'deny', setDoc(doc(WHO[w], BASE + p), { marks: {} }));
      await check('11. ' + w + ' can not delete ' + p, 'deny', deleteDoc(doc(WHO[w], BASE + p)));
    }
    await check('11. a signed-out browser can not read ' + p, 'deny', getDoc(doc(signedOut, BASE + p)));
  }
  await check('11. a removed former owner can not read the seen marks', 'deny', getDoc(doc(removed, H + 'priceConfig/seen')));
  await check('11. a former owner kept as company_admin reads the seen marks', 'allow', getDoc(doc(kept, H + 'priceConfig/seen')));

  // 12. productLinks (slice 4): the last approved cost per tier. Read like offers; nobody writes
  {
    const p = BASE + 'productLinks/shingle_001';
    for (const w of members) await check('12. ' + w + ' reads a product link', 'allow', getDoc(doc(WHO[w], p)));
    for (const w of outsiders) await check('12. ' + w + ' can not read a product link', 'deny', getDoc(doc(WHO[w], p)));
    for (const w of Object.keys(WHO)) {
      await check('12. ' + w + ' can not write a product link', 'deny', setDoc(doc(WHO[w], p), { applied: {} }));
      await check('12. ' + w + ' can not create a product link', 'deny', setDoc(doc(WHO[w], p + '_new'), { applied: {} }));
      await check('12. ' + w + ' can not delete a product link', 'deny', deleteDoc(doc(WHO[w], p)));
    }
    await check('12. a signed-out browser can not read a product link', 'deny', getDoc(doc(signedOut, p)));
    await check('12. a removed former owner can not read a product link', 'deny', getDoc(doc(removed, H + 'productLinks/shingle_001')));
    await check('12. a former owner demoted to sales_rep reads a product link', 'allow', getDoc(doc(demoted, H + 'productLinks/shingle_001')));
  }

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' - ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
