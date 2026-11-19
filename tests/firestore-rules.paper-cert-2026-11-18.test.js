/**
 * Firestore rules, paper certification (2026-11-18, flag docClauseSetV1):
 *  - a rep may upload a paper-signed document as status 'wet_signed_uploaded';
 *  - the attestation (wetSignedAttestation) and its evidence (wetSignedEvidence) are server-owned: no client
 *    creates a row carrying them, sets them, changes them or removes them;
 *  - a client cannot move a 'wet_signed_uploaded' row to 'signed' (or anything else): that is attestWetSigned's;
 *  - after the server certifies it the row is a signed row and is locked like any signed row.
 * Every deny is paired with an allow, so a rule that denies everything cannot pass.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-papercert-test \
 *     'node firestore-rules.paper-cert-2026-11-18.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-papercert-test';
{
  const rc = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT_ID)) throw new Error('refusing to load test rules into the app project "' + PROJECT_ID + '"');
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
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: Number(String(process.env.FIRESTORE_EMULATOR_HOST || '').split(':')[1]) || 8080 },
  });
  const { setDoc, doc, updateDoc, deleteField } = require('firebase/firestore');
  const owner = env.authenticatedContext('owner1', {}).firestore();
  const ATT = { byUid: 'owner1', name: 'Forged', at: 1766000000000, text: 'forged' };
  const EV = { docType: 'contract', signedOn: '2026-11-17', originalSha256: 'f'.repeat(64) };
  const WET = { name: 'scan.jpg', source: 'signed_upload', status: 'wet_signed_uploaded', uploadedBy: 'owner1', wetSignedDocType: 'contract', wetSignedOn: '2026-11-17' };

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/L1'), { userId: 'owner1', companyId: 'owner1' });
    // HIGH1 (security review): the "signed upload" guard follows the writer's own docClauseSetV1 flag (per person, over the default).
    await setDoc(doc(db, 'feature_flags/owner1'), { docClauseSetV1: true });
    await setDoc(doc(db, 'feature_flags/_default'), { docClauseSetV1: true });
    await setDoc(doc(db, 'feature_flags/owner2'), { docClauseSetV1: false });   // an explicit per-person off beats the default on
    await setDoc(doc(db, 'leads/L2'), { userId: 'owner2', companyId: 'owner2' });
    await setDoc(doc(db, 'leads/L2/documents/legacy'), { name: 'old.jpg', source: 'signed_upload', status: 'signed', signedAt: new Date(), uploadedBy: 'owner2' });
    await setDoc(doc(db, 'leads/L1/documents/draftup'), { name: 'x.jpg', source: 'signed_upload', status: 'draft', uploadedBy: 'owner1' });
    await setDoc(doc(db, 'leads/L1/documents/plaindoc'), { name: 'c', type: 'contract', status: 'sent', userId: 'owner1' });
    await setDoc(doc(db, 'second_owner_records/L1'), { name: 'Pat', recordedAt: 1 });
    await setDoc(doc(db, 'leads/L1/documents/wet'), Object.assign({}, WET));
    await setDoc(doc(db, 'leads/L1/documents/certified'), Object.assign({}, WET, { status: 'signed', signedAt: new Date(), wetSignedAttestation: ATT, wetSignedEvidence: EV }));
  });

  const d = (id) => doc(owner, 'leads/L1/documents/' + id);
  await check('control: rep creates the paper upload as wet_signed_uploaded', 'allow', setDoc(doc(owner, 'leads/L1/documents/new1'), Object.assign({}, WET)));
  await check('control: rep edits the signing date and witness on a waiting upload', 'allow', updateDoc(d('wet'), { wetSignedOn: '2026-11-16', witnessName: 'Pat' }));
  await check('rep creates a row already carrying an attestation', 'deny', setDoc(doc(owner, 'leads/L1/documents/new2'), Object.assign({}, WET, { wetSignedAttestation: ATT })));
  await check('rep creates a signed row carrying wetSignedEvidence', 'deny', setDoc(doc(owner, 'leads/L1/documents/new3'), Object.assign({}, WET, { status: 'signed', wetSignedEvidence: EV })));
  await check('rep plants an attestation on a waiting upload', 'deny', updateDoc(d('wet'), { wetSignedAttestation: ATT }));
  await check('rep plants wetSignedEvidence on a waiting upload', 'deny', updateDoc(d('wet'), { wetSignedEvidence: EV }));
  await check('rep moves a waiting upload straight to signed', 'deny', updateDoc(d('wet'), { status: 'signed', signedAt: new Date() }));
  await check('rep moves a waiting upload back to draft', 'deny', updateDoc(d('wet'), { status: 'draft' }));
  await check('rep deletes the status of a waiting upload', 'deny', updateDoc(d('wet'), { status: deleteField() }));
  await check('rep rewrites the attestation on a certified row', 'deny', updateDoc(d('certified'), { wetSignedAttestation: Object.assign({}, ATT, { name: 'Someone Else' }) }));
  await check('rep deletes the attestation from a certified row', 'deny', updateDoc(d('certified'), { wetSignedAttestation: deleteField() }));
  await check('rep reopens a certified row to wet_signed_uploaded', 'deny', updateDoc(d('certified'), { status: 'wet_signed_uploaded' }));
  await check('control: rep may still toggle homeowner sharing on a certified row', 'allow', updateDoc(d('certified'), { sharedWithHomeowner: true }));

  // ── HIGH1: a client cannot write a signed_upload row straight to "signed" (only attestWetSigned, admin SDK, does) ──
  const rep2 = env.authenticatedContext('owner2', {}).firestore();
  await check('control: rep (flag on) creates a plain generated row with status signed (the guard is only for signed_upload rows)', 'allow', setDoc(doc(owner, 'leads/L1/documents/g1'), { name: 'c', type: 'contract', status: 'signed', signedAt: new Date(), userId: 'owner1' }));
  await check('rep (flag on) creates a signed_upload row with status signed', 'deny', setDoc(doc(owner, 'leads/L1/documents/h1'), { name: 'f.jpg', source: 'signed_upload', status: 'signed', uploadedBy: 'owner1' }));
  await check('rep (flag on) creates a signed_upload row with signedAt set', 'deny', setDoc(doc(owner, 'leads/L1/documents/h2'), { name: 'f.jpg', source: 'signed_upload', status: 'draft', signedAt: new Date(), uploadedBy: 'owner1' }));
  await check('rep (flag on) moves a draft signed_upload row to signed', 'deny', updateDoc(d('draftup'), { status: 'signed' }));
  await check('rep (flag on) stamps signedAt on a waiting signed_upload row', 'deny', updateDoc(d('wet'), { signedAt: new Date() }));
  await check('rep (flag on) turns a plain row into a signed_upload row that is signed', 'deny', updateDoc(d('plaindoc'), { source: 'signed_upload', status: 'signed' }));
  await check('control: rep (flag on) edits a note on a waiting signed_upload row', 'allow', updateDoc(d('wet'), { note: 'second page missing' }));
  await check('control: rep (flag off for this person) still creates a legacy signed upload as signed', 'allow', setDoc(doc(rep2, 'leads/L2/documents/legacy2'), { name: 'f.jpg', source: 'signed_upload', status: 'signed', uploadedBy: 'owner2' }));
  await check('control: rep (flag off) may still edit the legacy signed row\'s sharing flag', 'allow', updateDoc(doc(rep2, 'leads/L2/documents/legacy'), { sharedWithHomeowner: true }));
  await check('rep writes wetSignedAttestation on create (flag off person)', 'deny', setDoc(doc(rep2, 'leads/L2/documents/h3'), { name: 'f.jpg', source: 'signed_upload', status: 'wet_signed_uploaded', wetSignedAttestation: ATT }));
  await check('second_owner_records is not readable by a client', 'deny', require('firebase/firestore').getDoc(doc(owner, 'second_owner_records/L1')));
  await check('second_owner_records is not writable by a client (cannot lower or clear a recorded second owner)', 'deny', setDoc(doc(owner, 'second_owner_records/L1'), { name: '' }));

  // ── re-review (2): lead.secondOwnerName pins the co-signer requirement, so only the lead's owner or a company admin writes it ──
  await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore(), 'leads/L3'), { userId: 'ownerX', companyId: 'CO3', firstName: 'Dana' }); });
  const mgr = env.authenticatedContext('mgr', { role: 'manager', companyId: 'CO3' }).firestore();
  const adm = env.authenticatedContext('adm', { role: 'company_admin', companyId: 'CO3' }).firestore();
  const own = env.authenticatedContext('ownerX', { companyId: 'CO3' }).firestore();
  await check('a manager cannot set secondOwnerName on a teammate\'s lead', 'deny', updateDoc(doc(mgr, 'leads/L3'), { secondOwnerName: 'Wrong Person' }));
  await check('control: a manager can still edit the lead\'s other fields', 'allow', updateDoc(doc(mgr, 'leads/L3'), { firstName: 'Dana M' }));
  await check('control: the lead\'s owner can set secondOwnerName', 'allow', updateDoc(doc(own, 'leads/L3'), { secondOwnerName: 'Pat' }));
  await check('a manager cannot clear or change it afterwards', 'deny', updateDoc(doc(mgr, 'leads/L3'), { secondOwnerName: '' }));
  await check('control: a company admin can correct it', 'allow', updateDoc(doc(adm, 'leads/L3'), { secondOwnerName: 'Patricia' }));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' — ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
