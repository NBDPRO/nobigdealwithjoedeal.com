/**
 * Firestore rules - supplements/{id} company read (Finding 5, 2026-11-14).
 *
 * The office (company_admin / manager) invoices a job whose insurance
 * supplement a rep entered, so same-company STAFF read a supplement that
 * carries their companyId. Nobody else gains anything: another tenant, a
 * teammate sales rep and a viewer cannot read it; a legacy supplement with no
 * companyId stays owner-only. Create must stamp the caller's own tenant (a
 * forged companyId would put a supplement on a VICTIM tenant's invoice). Staff
 * may write only the invoiced stamp. SYNTHETIC ids and numbers only (public repo).
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-supco-test \
 *     'node firestore-rules.supplements-company.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-supco-test';
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
  const rep = ctx('rep1', { role: 'sales_rep', companyId: 'co-a' });     // entered the supplement
  const rep2 = ctx('rep2', { role: 'sales_rep', companyId: 'co-a' });    // a teammate rep
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const mike = ctx('mike', { role: 'manager', companyId: 'co-a' });
  const vera = ctx('vera', { role: 'viewer', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'company_admin', companyId: 'co-b' });   // another tenant's admin
  const solo = ctx('solo1', {});                                           // solo owner: no claims
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, deleteDoc, doc, getDoc, getDocs, collection, query, where } = require('firebase/firestore');
  const ref = (db, id) => doc(db, 'supplements/' + id);
  const sup = (f) => Object.assign({ userId: 'rep1', companyId: 'co-a', leadId: 'L1', parentEstimateId: 'estA', version: 1, status: 'approved', supplementTotal: 2000 }, f || {});

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'supplements/sA'), sup());
    await setDoc(doc(db, 'supplements/sB'), sup({ userId: 'eve', companyId: 'co-b' }));
    const legacy = sup(); delete legacy.companyId;
    await setDoc(doc(db, 'supplements/sOld'), legacy);
  });

  // ── read: company-stamped supplement ──
  await check('the rep who entered it reads it', 'allow', getDoc(ref(rep, 'sA')));
  await check('same-company company_admin reads it', 'allow', getDoc(ref(carol, 'sA')));
  await check('same-company manager reads it', 'allow', getDoc(ref(mike, 'sA')));
  await check('platform admin reads it', 'allow', getDoc(ref(joe, 'sA')));
  await check('a teammate sales rep cannot read it', 'deny', getDoc(ref(rep2, 'sA')));
  await check('a same-company viewer cannot read it', 'deny', getDoc(ref(vera, 'sA')));
  await check('another tenant\'s admin cannot read it', 'deny', getDoc(ref(eve, 'sA')));
  await check('a solo owner (no claims) cannot read it', 'deny', getDoc(ref(solo, 'sA')));
  await check('anonymous cannot read it', 'deny', getDoc(ref(anon, 'sA')));
  // ── read: the invoice query ──
  const teamQ = (db, cid) => getDocs(query(collection(db, 'supplements'), where('parentEstimateId', '==', 'estA'), where('companyId', '==', cid)));
  await check('company_admin\'s team query (parentEstimateId + own companyId) is allowed', 'allow', teamQ(carol, 'co-a'));
  await check('manager\'s team query is allowed', 'allow', teamQ(mike, 'co-a'));
  await check('company_admin cannot query ANOTHER company\'s supplements', 'deny', teamQ(carol, 'co-b'));
  await check('a sales rep cannot run the team query', 'deny', teamQ(rep2, 'co-a'));
  await check('a parentEstimateId-only query (no tenant filter) is denied to staff', 'deny',
    getDocs(query(collection(carol, 'supplements'), where('parentEstimateId', '==', 'estA'))));
  await check('the rep\'s own query (parentEstimateId + userId) still works', 'allow',
    getDocs(query(collection(rep, 'supplements'), where('parentEstimateId', '==', 'estA'), where('userId', '==', 'rep1'))));
  // ── read: legacy (no companyId) stays owner-only ──
  await check('legacy supplement: the owner reads it', 'allow', getDoc(ref(rep, 'sOld')));
  await check('legacy supplement: same-company admin still cannot read it', 'deny', getDoc(ref(carol, 'sOld')));

  // ── create ──
  await check('rep creates with their own companyId', 'allow', setDoc(ref(rep, 'n1'), sup()));
  await check('rep cannot create without companyId', 'deny', setDoc(ref(rep, 'n2'), (() => { const d = sup(); delete d.companyId; return d; })()));
  await check('rep cannot stamp ANOTHER tenant\'s companyId', 'deny', setDoc(ref(rep, 'n3'), sup({ companyId: 'co-b' })));
  await check('a member cannot stamp their own uid as companyId', 'deny', setDoc(ref(rep, 'n4'), sup({ companyId: 'rep1' })));
  await check('solo owner creates with companyId = their uid', 'allow', setDoc(ref(solo, 'n5'), sup({ userId: 'solo1', companyId: 'solo1' })));
  await check('solo owner cannot stamp someone else\'s companyId', 'deny', setDoc(ref(solo, 'n6'), sup({ userId: 'solo1', companyId: 'co-a' })));
  await check('viewer cannot create', 'deny', setDoc(ref(vera, 'n7'), sup({ userId: 'vera' })));
  await check('cannot create for another user', 'deny', setDoc(ref(rep, 'n8'), sup({ userId: 'rep2' })));

  // ── update ──
  await check('owner updates status', 'allow', updateDoc(ref(rep, 'sA'), { status: 'partial' }));
  await check('owner cannot re-tenant (companyId)', 'deny', updateDoc(ref(rep, 'sA'), { companyId: 'co-b' }));
  await check('same-company admin writes the invoiced stamp', 'allow', updateDoc(ref(carol, 'sA'), { invoicedInvoiceId: 'inv1', invoicedAt: 1 }));
  await check('same-company manager writes the invoiced stamp', 'allow', updateDoc(ref(mike, 'sA'), { invoicedInvoiceId: 'inv2' }));
  await check('same-company admin cannot change the money', 'deny', updateDoc(ref(carol, 'sA'), { supplementTotal: 99999 }));
  await check('same-company admin cannot change status alongside the stamp', 'deny', updateDoc(ref(carol, 'sA'), { invoicedInvoiceId: 'inv3', status: 'denied' }));
  await check('another tenant\'s admin cannot stamp it', 'deny', updateDoc(ref(eve, 'sA'), { invoicedInvoiceId: 'x' }));
  await check('a teammate rep cannot stamp it', 'deny', updateDoc(ref(rep2, 'sA'), { invoicedInvoiceId: 'x' }));
  await check('viewer cannot stamp it', 'deny', updateDoc(ref(vera, 'sA'), { invoicedInvoiceId: 'x' }));
  await check('same-company admin cannot stamp a LEGACY (no companyId) supplement', 'deny', updateDoc(ref(carol, 'sOld'), { invoicedInvoiceId: 'x' }));

  // ── delete stays owner / platform admin ──
  await check('same-company admin cannot delete it', 'deny', deleteDoc(ref(carol, 'sA')));
  await check('another tenant cannot delete co-b\'s doc from co-a', 'deny', deleteDoc(ref(carol, 'sB')));
  await check('owner deletes their own', 'allow', deleteDoc(ref(rep, 'n1')));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' - ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
