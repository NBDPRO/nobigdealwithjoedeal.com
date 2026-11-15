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
 * The invoiced stamp is the SERVER's (functions/supplement-invoice.js, Joe
 * 2026-11-14): no client writes it, and no client creates an invoice that
 * carries supplements. Once stamped, nobody but the platform admin changes it
 * (the company_admin may clear one whose invoice is gone or void), and the
 * owner can no longer change status / supplementTotal / submission.
 *
 * Approval (Joe, 2026-11-14): only the owner side (company_admin of the
 * supplement's company, a solo owner, the platform admin) moves a supplement to
 * approved / partial or sets supplementTotal / submission.approvedAmount after
 * create, and only with an approval record: approvedBy == caller, approvedAt ==
 * server time, approvalEvidence { note 1..1000 and/or a path under
 * companies/{companyId}/supplement-evidence/ }.
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
    // Invoices the SERVER made (createSupplementInvoice), with the supplements it stamped.
    await setDoc(doc(db, 'supplements/sJ1'), sup({ version: 6, invoicedInvoiceId: 'invJ1', invoicedAt: 1 }));
    await setDoc(doc(db, 'supplements/sJ2'), sup({ version: 7, invoicedInvoiceId: 'invJ2', invoicedAt: 1 }));
    await setDoc(doc(db, 'invoices/invJ1'), inv('rep1', { supplementIds: ['sJ1'], total: 1, items: [], source: 'supplement_invoice' }));
    await setDoc(doc(db, 'invoices/invJ2'), inv('mike', { supplementIds: ['sJ2'], total: 1, items: [], source: 'supplement_invoice' }));
    await setDoc(doc(db, 'supplements/sJGone'), sup({ version: 8, invoicedInvoiceId: 'invNever', invoicedAt: 1 }));
    await setDoc(doc(db, 'supplements/sDel'), sup({ version: 9, deleted: true }));
    await setDoc(doc(db, 'supplements/sH'), draft({ version: 10 }));
    for (let i = 0; i < 10; i++) await setDoc(doc(db, 'supplements/sT' + i), sup({ version: 20 + i }));
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

  // ── the response flow (Joe, 2026-11-14): a rep records sent / denied; ONLY the owner side approves ──
  const EV = (by, f) => Object.assign({ approvedBy: by, approvedAt: serverTimestamp(), approvalEvidence: { note: 'Carrier letter 2026-11-10: adjuster approved the ice & water line.' } }, f || {});
  await check('owner records submitted (markSubmittedRemote)', 'allow', updateDoc(ref(rep, 'n1'), { status: 'submitted', 'submission.method': 'email' }));
  await check('owner records a denial on a submitted supplement', 'allow', updateDoc(ref(rep, 'n1'), { status: 'denied', 'submission.responseStatus': 'denied' }));
  await check('#3 FLIPPED: a rep cannot approve their own supplement', 'deny', updateDoc(ref(rep, 'sH'), Object.assign({ status: 'approved', 'submission.responseStatus': 'approved' }, EV('rep1'))));
  await check('#3 FLIPPED: …nor mark it partial with an amount', 'deny', updateDoc(ref(rep, 'sH'), Object.assign({ status: 'partial', 'submission.approvedAmount': 49999 }, EV('rep1'))));
  await check('a rep cannot change supplementTotal after create', 'deny', updateDoc(ref(rep, 'sH'), { supplementTotal: 50000 }));
  await check('a rep cannot set submission.approvedAmount', 'deny', updateDoc(ref(rep, 'sH'), { 'submission.approvedAmount': 10 }));
  await check('a rep cannot write the approval record', 'deny', updateDoc(ref(rep, 'sH'), EV('rep1')));
  await check('a manager cannot approve', 'deny', updateDoc(ref(mike, 'sH'), Object.assign({ status: 'approved' }, EV('mike'))));
  await check('company_admin cannot approve WITHOUT evidence', 'deny', updateDoc(ref(carol, 'sH'), { status: 'approved', approvedBy: 'carol', approvedAt: serverTimestamp() }));
  await check('company_admin cannot approve with a blank note', 'deny', updateDoc(ref(carol, 'sH'), Object.assign({ status: 'approved' }, EV('carol', { approvalEvidence: { note: '   ' } }))));
  await check('company_admin cannot approve with a note over 1000 characters', 'deny', updateDoc(ref(carol, 'sH'), Object.assign({ status: 'approved' }, EV('carol', { approvalEvidence: { note: 'x'.repeat(1001) } }))));
  await check('company_admin cannot approve in someone else\'s name', 'deny', updateDoc(ref(carol, 'sH'), Object.assign({ status: 'approved' }, EV('joe'))));
  await check('company_admin cannot back-date the approval (approvedAt must be the server time)', 'deny', updateDoc(ref(carol, 'sH'), Object.assign({ status: 'approved' }, EV('carol', { approvedAt: 12345 }))));
  await check('company_admin cannot point the evidence at another company\'s folder', 'deny', updateDoc(ref(carol, 'sH'), Object.assign({ status: 'approved' }, EV('carol', { approvalEvidence: { path: 'companies/co-b/supplement-evidence/x.pdf' } }))));
  await check('another company\'s admin cannot approve it', 'deny', updateDoc(doc(eve, 'supplements/sH'), Object.assign({ status: 'approved' }, EV('eve'))));
  await check('company_admin approves with the carrier evidence note', 'allow', updateDoc(ref(carol, 'sH'), Object.assign({ status: 'approved', 'submission.responseStatus': 'approved' }, EV('carol'))));
  await check('company_admin records a partial with an evidence document in the company\'s folder', 'allow', updateDoc(ref(carol, 'sH'), Object.assign({ status: 'partial', 'submission.approvedAmount': 1500 }, EV('carol', { approvalEvidence: { path: 'companies/co-a/supplement-evidence/letter.pdf' } }))));
  await check('once approved, the rep cannot change its status', 'deny', updateDoc(ref(rep, 'sH'), { status: 'denied' }));
  await check('once approved, the rep cannot change the carrier response', 'deny', updateDoc(ref(rep, 'sH'), { 'submission.responseNotes': 'x' }));
  await check('once approved, the rep cannot soft-delete it (that would stop it billing)', 'deny', updateDoc(ref(rep, 'sH'), { deleted: true }));
  await check('once approved, the rep may still edit the reason', 'allow', updateDoc(ref(rep, 'sH'), { reason: 'note' }));
  await check('a solo owner approves their own with evidence', 'allow', updateDoc(ref(solo, 'n5'), Object.assign({ status: 'approved' }, EV('solo1'))));
  await check('the platform admin approves with evidence', 'allow', updateDoc(ref(joe, 'sA2'), Object.assign({ status: 'approved' }, EV('joe'))));
  await check('a create cannot carry an approval record', 'deny', setDoc(ref(rep, 'n10'), draft(EV('rep1'))));
  await check('owner cannot re-tenant (companyId)', 'deny', updateDoc(ref(rep, 'sA'), { companyId: 'co-b' }));
  await check('owner cannot re-point the lead (leadId)', 'deny', updateDoc(ref(rep, 'sA'), { leadId: 'L2' }));

  // ── the invoiced stamp is the SERVER's (createSupplementInvoice); no client ever writes it ──
  await check('rep cannot stamp their own supplement', 'deny', updateDoc(ref(rep, 'sA'), { invoicedInvoiceId: 'x', invoicedAt: serverTimestamp() }));
  await check('staff cannot stamp a nonexistent invoice', 'deny', updateDoc(ref(carol, 'sA'), { invoicedInvoiceId: 'ghost', invoicedAt: serverTimestamp() }));
  await check('staff cannot point the stamp at an EXISTING invoice', 'deny', updateDoc(ref(carol, 'sFree'), { invoicedInvoiceId: 'invOld', invoicedAt: serverTimestamp() }));
  await check('staff cannot stamp even in a batch with a real same-job invoice that lists it', 'deny', billWith(carol, 'invOk', ['sA', 'sA2', 'sA3']));
  await check('the owner cannot stamp that way either', 'deny', billWith(rep, 'invRep', ['sA'], { createdBy: 'rep1' }));
  await check('a client cannot create an invoice that carries supplementIds', 'deny', setDoc(doc(carol, 'invoices/invS1'), inv('carol', { supplementIds: ['sA'], supplementTotal: 0 })));
  await check('a client cannot create an invoice with a supplementTotal', 'deny', setDoc(doc(carol, 'invoices/invS2'), inv('carol', { supplementIds: [], supplementTotal: 2000 })));
  await check('a client still creates an ordinary invoice (no supplements)', 'allow', setDoc(doc(carol, 'invoices/invPlain'), inv('carol', { supplementIds: [], supplementTotal: 0 })));
  await check('staff cannot CLEAR a stamp whose invoice is live', 'deny', updateDoc(ref(carol, 'sStamped'), { invoicedInvoiceId: deleteField() }));
  await check('the owner cannot clear the stamp', 'deny', updateDoc(ref(rep, 'sStamped'), { invoicedInvoiceId: null }));
  await check('the owner cannot change supplementTotal once stamped', 'deny', updateDoc(ref(rep, 'sStamped'), { supplementTotal: 99999 }));
  await check('the owner cannot change status once stamped', 'deny', updateDoc(ref(rep, 'sStamped'), { status: 'denied' }));
  await check('the owner cannot change the carrier response once stamped', 'deny', updateDoc(ref(rep, 'sStamped'), { 'submission.approvedAmount': 5 }));
  await check('the owner may still edit a note on a stamped supplement', 'allow', updateDoc(ref(rep, 'sStamped'), { reason: 'note' }));
  await check('company_admin cannot re-approve a stamped (billed) supplement', 'deny', updateDoc(ref(carol, 'sStamped'), Object.assign({ status: 'approved', supplementTotal: 5000 }, EV('carol'))));
  await check('staff cannot change the money without approving', 'deny', updateDoc(ref(mike, 'sFree'), { supplementTotal: 99999 }));
  await check('platform admin can still correct a stamp', 'allow', updateDoc(ref(joe, 'sStamped'), { invoicedInvoiceId: 'invFix' }));

  // ── H1 (security review 2026-11-15; Joe's call: total-only) ──
  // A rep or manager cannot change the TOTAL of a server-made supplement invoice; the owner side can.
  // The other money fields stay editable for now (the invoice update rule is at the 1000-expression
  // budget; a server-only money doc per invoice is the follow-up). These controls pin exactly that.
  await check('H1 a rep cannot change the total of the supplement invoice', 'deny', updateDoc(doc(rep, 'invoices/invJ1'), { total: 5000, balanceDue: 5000 }));
  await check('H1 a manager cannot change the total either', 'deny', updateDoc(doc(mike, 'invoices/invJ2'), { total: 50000, balanceDue: 50000 }));
  await check('H1 control (follow-up, not frozen yet): the rep can still edit its lines', 'allow', updateDoc(doc(rep, 'invoices/invJ1'), { items: [{ description: 'x', quantity: 1, unitPrice: 1, total: 1 }] }));
  await check('H1 control (follow-up): …its supplementTotal', 'allow', updateDoc(doc(rep, 'invoices/invJ1'), { supplementTotal: 99999 }));
  await check('H1 control (follow-up): …its subtotal, tax, deposit and credit fields', 'allow', updateDoc(doc(rep, 'invoices/invJ1'), { subtotal: 5, tax: 1, depositAmount: 0, creditTotal: 9, creditedInvoiceIds: ['z'] }));
  await check('H1 its supplementIds stay frozen', 'deny', updateDoc(doc(rep, 'invoices/invJ1'), { supplementIds: [] }));
  await check('H1 the rep can still edit the notes on it', 'allow', updateDoc(doc(rep, 'invoices/invJ1'), { notes: 'call first' }));
  await check('H1 the company_admin (owner side) may change its total', 'allow', updateDoc(doc(carol, 'invoices/invJ1'), { total: 2, balanceDue: 2 }));
  await check('H1 an ordinary invoice (no supplements) is still re-priced by its maker as before', 'allow', updateDoc(doc(carol, 'invoices/invPlain'), { total: 15000, balanceDue: 15000 }));

  // ── interim protections kept: a SERVER-made invoice that billed supplements (seeded) ──
  await check('#1 a rep cannot DELETE an invoice that billed supplements', 'deny', deleteDoc(doc(rep, 'invoices/invJ1')));
  await check('#2 a manager cannot VOID it (status void)', 'deny', updateDoc(doc(mike, 'invoices/invJ2'), { status: 'void' }));
  await check('#2 …nor void it by the deleted flag', 'deny', updateDoc(doc(mike, 'invoices/invJ2'), { deleted: true, voidNote: 'oops' }));
  await check('#2 …nor strip its supplementIds', 'deny', updateDoc(doc(mike, 'invoices/invJ2'), { supplementIds: [] }));
  await check('a manager cannot clear the stamp while its invoice is live', 'deny', updateDoc(ref(mike, 'sJ2'), { invoicedInvoiceId: deleteField(), invoicedAt: deleteField() }));
  await check('company_admin cannot clear a stamp whose invoice is still live', 'deny', updateDoc(ref(carol, 'sJ2'), { invoicedInvoiceId: deleteField(), invoicedAt: deleteField() }));
  await check('company_admin voids the mistaken invoice (owner side)', 'allow', updateDoc(doc(carol, 'invoices/invJ2'), { status: 'void' }));
  await check('a manager still cannot clear the stamp after the void', 'deny', updateDoc(ref(mike, 'sJ2'), { invoicedInvoiceId: deleteField(), invoicedAt: deleteField() }));
  await check('another tenant\'s admin cannot clear it', 'deny', updateDoc(doc(eve, 'supplements/sJ2'), { invoicedInvoiceId: deleteField(), invoicedAt: deleteField() }));
  await check('company_admin cannot clear the stamp AND change the money', 'deny', updateDoc(ref(carol, 'sJ2'), { invoicedInvoiceId: deleteField(), invoicedAt: deleteField(), supplementTotal: 1 }));
  await check('company_admin clears a stranded stamp (invoice void) so the supplement bills again', 'allow', updateDoc(ref(carol, 'sJ2'), { invoicedInvoiceId: deleteField(), invoicedAt: deleteField() }));
  await check('company_admin clears a stranded stamp whose invoice no longer exists', 'allow', updateDoc(ref(carol, 'sJGone'), { invoicedInvoiceId: deleteField(), invoicedAt: deleteField() }));
  await check('company_admin may delete an invoice that billed supplements (owner side)', 'allow', deleteDoc(doc(carol, 'invoices/invJ1')));
  // M-B: soft delete only; staff can tell "deleted" from "forbidden".
  await check('staff read of a supplement id that does not exist is allowed (exists() == false, not denied)', 'allow', getDoc(ref(carol, 'never-was')));
  await check('a rep read of a nonexistent id is allowed too', 'allow', getDoc(ref(rep, 'never-was')));
  await check('the owner cannot HARD-delete their supplement', 'deny', deleteDoc(ref(rep, 'n6b')));
  await check('the owner soft-deletes a draft (deleted: true)', 'allow', updateDoc(ref(rep, 'n6b'), { deleted: true }));
  await check('staff read the soft-deleted supplement (and so never bill it)', 'allow', getDoc(ref(carol, 'sDel')));
  await check('#4 a co-b company_admin cannot update a co-a supplement', 'deny', updateDoc(doc(eve, 'supplements/sFree'), { reason: 'x' }));

  // ── delete: platform admin only (soft delete for everyone else) ──
  await check('same-company admin cannot delete it', 'deny', deleteDoc(ref(carol, 'sFree')));
  await check('another tenant cannot delete co-b\'s doc from co-a', 'deny', deleteDoc(ref(carol, 'sB')));
  await check('platform admin can hard-delete', 'allow', deleteDoc(ref(joe, 'sFree')));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' - ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
