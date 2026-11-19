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

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' — ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
