/**
 * Firestore rules - supplements/{id} (Finding 5, 2026-11-14 + its security review).
 *
 * The office (company_admin / manager) invoices a job whose insurance
 * supplement a rep entered, so same-company STAFF read a supplement that
 * carries their companyId. Nobody else gains anything: another tenant, a
 * teammate sales rep and a viewer cannot read it; a legacy supplement with no
 * companyId stays owner-only.
 *
 * Create (security review HIGH 2): the supplement must name a parent estimate
 * the caller may bill (their own, or, for staff, one in their company), carry
 * that estimate's companyId and leadId, and be born a 'draft' — so a rep cannot
 * add billable money to a teammate's job, and nobody creates one "approved".
 *
 * The invoiced stamp (security review HIGH 1) is write-once and only in the
 * same batch as a NEW invoice for the same job that lists the supplement; once
 * stamped, nobody but the platform admin changes it, and the owner can no
 * longer change status / supplementTotal / submission.
 *
 * SYNTHETIC ids and numbers only (public repo).
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
  const { setDoc, updateDoc, deleteDoc, doc, getDoc, getDocs, collection, query, where, writeBatch, serverTimestamp, deleteField } = require('firebase/firestore');
  const ref = (db, id) => doc(db, 'supplements/' + id);
  const sup = (f) => Object.assign({ userId: 'rep1', companyId: 'co-a', leadId: 'L1', parentEstimateId: 'estA', version: 1, status: 'approved', supplementTotal: 2000 }, f || {});
  const draft = (f) => sup(Object.assign({ status: 'draft', supplementTotal: 0 }, f || {}));
  // A new invoice as invoice-pipeline.js writes it (the fields the /invoices create rule reads).
  const inv = (by, f) => Object.assign({ createdBy: by, companyId: 'co-a', leadId: 'L1', estimateId: 'estA', status: 'draft', payments: [], amountPaid: 0,
    total: 16000, supplementIds: ['sA'] }, f || {});
  // Invoice + stamp in ONE batch (what createOrOpenJobInvoice now does).
  const billWith = (db, invId, supIds, invOver, stampOver) => {
    const b = writeBatch(db);
    b.set(doc(db, 'invoices/' + invId), inv(invOver && invOver.createdBy || 'carol', Object.assign({ supplementIds: supIds }, invOver || {})));
    for (const sid of supIds) b.update(ref(db, sid), Object.assign({ invoicedInvoiceId: invId, invoicedAt: serverTimestamp() }, stampOver || {}));
    return b.commit();
  };

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'leads/L1'), { userId: 'rep1', companyId: 'co-a', name: 'synthetic' });
    await setDoc(doc(db, 'leads/L2'), { userId: 'rep2', companyId: 'co-a', name: 'synthetic' });
    await setDoc(doc(db, 'leads/LB'), { userId: 'eve', companyId: 'co-b', name: 'synthetic' });
    await setDoc(doc(db, 'estimates/estA'), { userId: 'rep1', companyId: 'co-a', leadId: 'L1', grandTotal: 14000 });
    await setDoc(doc(db, 'estimates/estX'), { userId: 'rep2', companyId: 'co-a', leadId: 'L2', grandTotal: 9000 });  // a teammate's job
    await setDoc(doc(db, 'estimates/estB'), { userId: 'eve', companyId: 'co-b', leadId: 'LB', grandTotal: 5000 });   // another tenant's job
    await setDoc(doc(db, 'estimates/estS'), { userId: 'solo1', companyId: 'solo1', grandTotal: 3000 });               // a solo owner's, no lead
    await setDoc(doc(db, 'estimates/estL'), { userId: 'rep1', leadId: 'L1', grandTotal: 1000 });                       // legacy: no companyId
    await setDoc(doc(db, 'supplements/sA'), sup());
    await setDoc(doc(db, 'supplements/sA2'), sup({ version: 2 }));
    await setDoc(doc(db, 'supplements/sA3'), sup({ version: 3 }));
    await setDoc(doc(db, 'supplements/sB'), sup({ userId: 'eve', companyId: 'co-b', leadId: 'LB', parentEstimateId: 'estB' }));
    const legacy = sup(); delete legacy.companyId;
    await setDoc(doc(db, 'supplements/sOld'), legacy);
    await setDoc(doc(db, 'supplements/sStamped'), sup({ version: 4, invoicedInvoiceId: 'invOld', invoicedAt: 1 }));
    await setDoc(doc(db, 'supplements/sFree'), sup({ version: 5 }));
    await setDoc(doc(db, 'invoices/invOld'), inv('carol', { supplementIds: ['sStamped'] }));
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

  // ── create (HIGH 2) ──
  await check('rep creates a DRAFT on their own estimate', 'allow', setDoc(ref(rep, 'n1'), draft()));
  await check('rep cannot create one already APPROVED', 'deny', setDoc(ref(rep, 'n1b'), sup()));
  await check('rep cannot create one with a submitted / partial status either', 'deny', setDoc(ref(rep, 'n1c'), draft({ status: 'partial' })));
  await check('rep cannot create on a TEAMMATE\'s estimate', 'deny', setDoc(ref(rep, 'n1d'), draft({ parentEstimateId: 'estX', leadId: 'L2' })));
  await check('co-b cannot create on co-a\'s estimate (even claiming co-a)', 'deny', setDoc(doc(eve, 'supplements/n1e'), draft({ userId: 'eve', companyId: 'co-a' })));
  await check('co-b cannot create on co-a\'s estimate with its own companyId', 'deny', setDoc(doc(eve, 'supplements/n1f'), draft({ userId: 'eve', companyId: 'co-b' })));
  await check('company_admin creates a draft on a rep\'s estimate in their company', 'allow', setDoc(ref(carol, 'n1g'), draft({ userId: 'carol' })));
  await check('a supplement on a nonexistent estimate is denied', 'deny', setDoc(ref(rep, 'n1h'), draft({ parentEstimateId: 'nope' })));
  await check('leadId must be the estimate\'s lead', 'deny', setDoc(ref(rep, 'n1i'), draft({ leadId: 'L2' })));
  await check('rep cannot create without companyId', 'deny', setDoc(ref(rep, 'n2'), (() => { const d = draft(); delete d.companyId; return d; })()));
  await check('rep cannot stamp ANOTHER tenant\'s companyId', 'deny', setDoc(ref(rep, 'n3'), draft({ companyId: 'co-b' })));
  await check('a member cannot stamp their own uid as companyId', 'deny', setDoc(ref(rep, 'n4'), draft({ companyId: 'rep1' })));
  await check('solo owner creates a draft on their own estimate', 'allow', setDoc(ref(solo, 'n5'), draft({ userId: 'solo1', companyId: 'solo1', parentEstimateId: 'estS', leadId: null })));
  await check('solo owner cannot create on someone else\'s estimate', 'deny', setDoc(ref(solo, 'n6'), draft({ userId: 'solo1', companyId: 'solo1' })));
  await check('owner of a legacy (no companyId) estimate creates with their tenant', 'allow', setDoc(ref(rep, 'n6b'), draft({ parentEstimateId: 'estL' })));
  await check('viewer cannot create', 'deny', setDoc(ref(vera, 'n7'), draft({ userId: 'vera' })));
  await check('cannot create for another user', 'deny', setDoc(ref(rep, 'n8'), draft({ userId: 'rep2' })));
  await check('a create cannot arrive pre-stamped as invoiced', 'deny', setDoc(ref(rep, 'n9'), draft({ invoicedInvoiceId: 'invOld' })));

  // ── the approve flow still works on the owner's own (unstamped) supplement ──
  await check('owner records submitted (markSubmittedRemote)', 'allow', updateDoc(ref(rep, 'n1'), { status: 'submitted', 'submission.method': 'email' }));
  await check('owner records the carrier response (updateResponse)', 'allow', updateDoc(ref(rep, 'n1'), { status: 'approved', 'submission.responseStatus': 'approved', supplementTotal: 2000 }));
  await check('owner cannot re-tenant (companyId)', 'deny', updateDoc(ref(rep, 'sA'), { companyId: 'co-b' }));
  await check('owner cannot re-point the lead (leadId)', 'deny', updateDoc(ref(rep, 'sA'), { leadId: 'L2' }));

  // ── the invoiced stamp (HIGH 1) ──
  await check('rep cannot stamp their own supplement with no invoice', 'deny', updateDoc(ref(rep, 'sA'), { invoicedInvoiceId: 'x', invoicedAt: serverTimestamp() }));
  await check('staff cannot stamp a nonexistent invoice', 'deny', updateDoc(ref(carol, 'sA'), { invoicedInvoiceId: 'ghost', invoicedAt: serverTimestamp() }));
  await check('staff cannot point the stamp at an EXISTING older invoice', 'deny', updateDoc(ref(carol, 'sFree'), { invoicedInvoiceId: 'invOld', invoicedAt: serverTimestamp() }));
  await check('staff cannot stamp in a batch whose invoice is for ANOTHER estimate', 'deny', billWith(carol, 'invW1', ['sA'], { estimateId: 'estX', leadId: 'L2' }));
  await check('staff cannot stamp in a batch whose invoice does not list the supplement', 'deny', (() => {
    const b = writeBatch(carol);
    b.set(doc(carol, 'invoices/invW2'), inv('carol', { supplementIds: ['sA2'] }));
    b.update(ref(carol, 'sA'), { invoicedInvoiceId: 'invW2', invoicedAt: serverTimestamp() });
    return b.commit();
  })());
  await check('the stamp time must be the server time', 'deny', billWith(carol, 'invW3', ['sA'], null, { invoicedAt: 12345 }));
  await check('another tenant cannot stamp co-a\'s supplement with its own invoice', 'deny', billWith(eve, 'invW4', ['sA'], { createdBy: 'eve', companyId: 'co-b', leadId: 'LB' }));
  await check('a teammate rep cannot stamp it', 'deny', billWith(rep2, 'invW5', ['sA'], { createdBy: 'rep2', leadId: 'L1' }));
  await check('staff stamp three supplements in ONE batch with a real same-job invoice that lists them', 'allow', billWith(carol, 'invOk', ['sA', 'sA2', 'sA3']));
  await check('the owner bills their own supplement the same way', 'allow', billWith(rep, 'invRep', ['n1'], { createdBy: 'rep1', supplementIds: ['n1'] }));
  await check('staff cannot CLEAR a stamp', 'deny', updateDoc(ref(carol, 'sStamped'), { invoicedInvoiceId: deleteField() }));
  await check('staff cannot OVERWRITE a stamp, even with a new real invoice', 'deny', billWith(carol, 'invW6', ['sStamped']));
  await check('the owner cannot clear the stamp', 'deny', updateDoc(ref(rep, 'sStamped'), { invoicedInvoiceId: null }));
  await check('the owner cannot change supplementTotal once stamped', 'deny', updateDoc(ref(rep, 'sStamped'), { supplementTotal: 99999 }));
  await check('the owner cannot change status once stamped', 'deny', updateDoc(ref(rep, 'sStamped'), { status: 'denied' }));
  await check('the owner cannot change the carrier response once stamped', 'deny', updateDoc(ref(rep, 'sStamped'), { 'submission.approvedAmount': 5 }));
  await check('the owner may still edit a note on a stamped supplement', 'allow', updateDoc(ref(rep, 'sStamped'), { reason: 'note' }));
  await check('staff cannot change the money', 'deny', updateDoc(ref(carol, 'sFree'), { supplementTotal: 99999 }));
  await check('viewer cannot stamp', 'deny', billWith(vera, 'invW7', ['sFree'], { createdBy: 'vera' }));
  await check('same-company admin cannot stamp a LEGACY (no companyId) supplement', 'deny', billWith(carol, 'invW8', ['sOld'], { supplementIds: ['sOld'] }));
  await check('platform admin can still correct a stamp', 'allow', updateDoc(ref(joe, 'sStamped'), { invoicedInvoiceId: 'invFix' }));

  // ── delete stays owner / platform admin ──
  await check('same-company admin cannot delete it', 'deny', deleteDoc(ref(carol, 'sFree')));
  await check('another tenant cannot delete co-b\'s doc from co-a', 'deny', deleteDoc(ref(carol, 'sB')));
  await check('owner deletes their own', 'allow', deleteDoc(ref(rep, 'n6b')));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' - ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
