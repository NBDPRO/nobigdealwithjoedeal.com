/**
 * Firestore rules, evidence and clause foundation (2026-11-18):
 *  - leads/{leadId}/documents.signatureEvidence is server-owned: no client creates
 *    a row with it, changes it or removes it, on a draft, a sent or a signed row;
 *  - deal_rooms.acceptedEvidence cannot be rewritten once the deal is closed.
 * Every deny is paired with an allow, so a rule that denies everything cannot pass.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-docevidence-test \
 *     'node firestore-rules.doc-evidence-2026-11-18.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-docevidence-test';
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
  const EV = { path: 'in_person', clauseSetVersion: 'CS-FORGED', ip: '6.6.6.6' };

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/L1'), { userId: 'owner1', companyId: 'owner1' });
    await setDoc(doc(db, 'leads/L1/documents/draft'), { name: 'c', status: 'draft', userId: 'owner1' });
    await setDoc(doc(db, 'leads/L1/documents/sent'), { name: 'c', status: 'sent', userId: 'owner1', signatureEvidence: { path: 'remote_link', ip: '1.1.1.1' } });
    await setDoc(doc(db, 'leads/L1/documents/signed'), { name: 'c', status: 'signed', signedAt: new Date(), userId: 'owner1', signatureEvidence: { path: 'in_person', ip: '1.1.1.1' } });
    await setDoc(doc(db, 'deal_rooms/open'), { userId: 'owner1', status: 'sent' });
    await setDoc(doc(db, 'deal_rooms/closed'), { userId: 'owner1', status: 'accepted', acceptedTier: 'better', acceptedPrice: 100, acceptedEvidence: { ip: '1.1.1.1', clauseSetVersion: 'CS-REAL' } });
  });

  const d = (id) => doc(owner, 'leads/L1/documents/' + id);
  await check('control: owner creates an ordinary document row', 'allow', setDoc(doc(owner, 'leads/L1/documents/new1'), { name: 'x', status: 'draft', userId: 'owner1' }));
  await check('owner creates a row carrying signatureEvidence', 'deny', setDoc(doc(owner, 'leads/L1/documents/new2'), { name: 'x', status: 'draft', userId: 'owner1', signatureEvidence: EV }));
  await check('control: owner edits an ordinary field on a draft', 'allow', updateDoc(d('draft'), { name: 'renamed' }));
  await check('owner plants signatureEvidence on a draft', 'deny', updateDoc(d('draft'), { signatureEvidence: EV }));
  await check('control: owner edits an ordinary field on a sent row that carries evidence', 'allow', updateDoc(d('sent'), { name: 'renamed' }));
  await check('owner overwrites signatureEvidence on a sent row', 'deny', updateDoc(d('sent'), { signatureEvidence: EV }));
  await check('owner changes one nested evidence field on a sent row', 'deny', updateDoc(d('sent'), { 'signatureEvidence.ip': '6.6.6.6' }));
  await check('owner deletes signatureEvidence from a sent row', 'deny', updateDoc(d('sent'), { signatureEvidence: deleteField() }));
  await check('owner overwrites signatureEvidence on a signed row', 'deny', updateDoc(d('signed'), { signatureEvidence: EV }));
  await check('owner deletes signatureEvidence from a signed row', 'deny', updateDoc(d('signed'), { signatureEvidence: deleteField() }));
  await check('control: owner may still flip sharedWithHomeowner on a signed row', 'allow', updateDoc(d('signed'), { sharedWithHomeowner: true }));

  await check('control: owner edits notes on an open deal room', 'allow', updateDoc(doc(owner, 'deal_rooms/open'), { notes: 'n' }));
  await check('control: owner edits notes on a closed deal room', 'allow', updateDoc(doc(owner, 'deal_rooms/closed'), { notes: 'n' }));
  await check('owner rewrites acceptedEvidence on a closed deal room', 'deny', updateDoc(doc(owner, 'deal_rooms/closed'), { acceptedEvidence: { ip: '6.6.6.6', clauseSetVersion: 'CS-FORGED' } }));
  await check('owner changes one nested acceptedEvidence field on a closed deal room', 'deny', updateDoc(doc(owner, 'deal_rooms/closed'), { 'acceptedEvidence.ip': '6.6.6.6' }));
  await check('owner deletes acceptedEvidence from a closed deal room', 'deny', updateDoc(doc(owner, 'deal_rooms/closed'), { acceptedEvidence: deleteField() }));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' — ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
