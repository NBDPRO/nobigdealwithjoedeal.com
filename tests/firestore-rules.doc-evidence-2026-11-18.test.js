/**
 * Firestore rules, evidence and clause foundation (2026-11-18):
 *  - leads/{leadId}/documents.signatureEvidence is server-owned: no client creates
 *    a row with it, changes it or removes it, on a draft, a sent or a signed row;
 *  - deal_rooms.acceptedEvidence cannot be rewritten once the deal is closed, and (review
 *    2026-11-18) no client write, create or update, sets or changes any accepted* field on a
 *    deal that is not yet accepted: only the admin SDK (deal-acceptance.js) records an acceptance;
 *  - the legacy top-level /documents rows cannot carry signatureEvidence either.
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
    await setDoc(doc(db, 'leads/L1/documents/refused'), { name: 'c', status: 'signed', signedAt: new Date(), userId: 'owner1', evidenceRefused: { reasons: [{ code: 'price', message: 'The contract price is blank or $0.00.' }], at: 1766000000000 } });
    await setDoc(doc(db, 'leads/L1/documents/stampfail'), { name: 'c', status: 'sent', userId: 'owner1', signedStampFailed: true, signedStampFailedAt: new Date() });
    await setDoc(doc(db, 'deal_rooms/open'), { userId: 'owner1', status: 'sent' });
    await setDoc(doc(db, 'deal_rooms/closed'), { userId: 'owner1', status: 'accepted', acceptedTier: 'better', acceptedPrice: 100, acceptedEvidence: { ip: '1.1.1.1', clauseSetVersion: 'CS-REAL' } });
  });

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'documents/legacyA'), { userId: 'owner1', name: 'old', status: 'draft' });
    await setDoc(doc(db, 'documents/legacyB'), { userId: 'owner1', name: 'old', status: 'draft', signatureEvidence: { path: 'remote_link', ip: '1.1.1.1' } });
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
  // review 2 (2026-11-18), item 1: the stamp-failure warning is server-owned like signedSaveFailed.
  await check('owner deletes signedStampFailed from a non-signed row', 'deny', updateDoc(d('stampfail'), { signedStampFailed: deleteField() }));
  await check('owner sets signedStampFailed false on a non-signed row', 'deny', updateDoc(d('stampfail'), { signedStampFailed: false }));
  await check('owner deletes signedStampFailedAt from a non-signed row', 'deny', updateDoc(d('stampfail'), { signedStampFailedAt: deleteField() }));
  await check('owner plants signedStampFailed on a draft', 'deny', updateDoc(d('draft'), { signedStampFailed: true }));
  await check('owner creates a row carrying signedStampFailed', 'deny', setDoc(doc(owner, 'leads/L1/documents/new5'), { name: 'x', status: 'draft', userId: 'owner1', signedStampFailed: true }));
  await check('control: owner edits an ordinary field on a stamp-failed row', 'allow', updateDoc(d('stampfail'), { name: 'renamed' }));
  // review 2 (2026-11-18), item 4: evidenceRefused is server-owned too.
  await check('owner deletes evidenceRefused from a signed row', 'deny', updateDoc(d('refused'), { evidenceRefused: deleteField() }));
  await check('owner rewrites evidenceRefused on a signed row', 'deny', updateDoc(d('refused'), { 'evidenceRefused.at': 1 }));
  await check('owner plants evidenceRefused on a draft', 'deny', updateDoc(d('draft'), { evidenceRefused: { reasons: [], at: 1 } }));
  await check('owner creates a row carrying evidenceRefused', 'deny', setDoc(doc(owner, 'leads/L1/documents/new6'), { name: 'x', status: 'draft', userId: 'owner1', evidenceRefused: { reasons: [], at: 1 } }));
  await check('control: owner may still flip sharedWithHomeowner on a signed row', 'allow', updateDoc(d('signed'), { sharedWithHomeowner: true }));

  // security review 2026-11-18: linkSeq / linkMintedAt (the sign-link sequence number and mint stamp) are server-owned too: a client
  // that could reset linkSeq would keep an old sign link alive when it makes a new one.
  const mgr = env.authenticatedContext('mgr1', { role: 'manager', companyId: 'owner1' }).firestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'leads/L1/documents/seq'), { name: 'c', status: 'sent', userId: 'owner1', linkSeq: 5 });
    await setDoc(doc(ctx.firestore(), 'documents/legacySeq'), { userId: 'owner1', name: 'old', status: 'draft', linkSeq: 5 });
  });
  for (const [who, db] of [['owner', owner], ['manager', mgr]]) {
    const s = doc(db, 'leads/L1/documents/seq');
    await check('control: ' + who + ' edits an ordinary field on a row that carries linkSeq', 'allow', updateDoc(s, { name: 'r-' + who }));
    await check(who + ' sets linkSeq to 0', 'deny', updateDoc(s, { linkSeq: 0 }));
    await check(who + ' sets linkSeq to a string', 'deny', updateDoc(s, { linkSeq: 'x' }));
    await check(who + ' deletes linkSeq', 'deny', updateDoc(s, { linkSeq: deleteField() }));
    await check(who + ' sets linkMintedAt', 'deny', updateDoc(s, { linkMintedAt: new Date() }));
    await check(who + ' plants linkSeq on a draft', 'deny', updateDoc(doc(db, 'leads/L1/documents/draft'), { linkSeq: 0 }));
    await check(who + ' creates a row carrying linkSeq', 'deny', setDoc(doc(db, 'leads/L1/documents/seqnew-' + who), { name: 'x', status: 'draft', userId: 'owner1', linkSeq: 0 }));
    await check(who + ' creates a row carrying linkMintedAt', 'deny', setDoc(doc(db, 'leads/L1/documents/mintnew-' + who), { name: 'x', status: 'draft', userId: 'owner1', linkMintedAt: new Date() }));
  }
  await check('owner resets linkSeq on a legacy document', 'deny', updateDoc(doc(owner, 'documents/legacySeq'), { linkSeq: 0 }));
  await check('owner creates a legacy document carrying linkMintedAt', 'deny', setDoc(doc(owner, 'documents/legacySeq2'), { userId: 'owner1', name: 'x', status: 'draft', linkMintedAt: new Date() }));

  await check('control: owner edits notes on an open deal room', 'allow', updateDoc(doc(owner, 'deal_rooms/open'), { notes: 'n' }));
  await check('control: owner edits notes on a closed deal room', 'allow', updateDoc(doc(owner, 'deal_rooms/closed'), { notes: 'n' }));
  await check('owner rewrites acceptedEvidence on a closed deal room', 'deny', updateDoc(doc(owner, 'deal_rooms/closed'), { acceptedEvidence: { ip: '6.6.6.6', clauseSetVersion: 'CS-FORGED' } }));
  await check('owner changes one nested acceptedEvidence field on a closed deal room', 'deny', updateDoc(doc(owner, 'deal_rooms/closed'), { 'acceptedEvidence.ip': '6.6.6.6' }));
  await check('owner deletes acceptedEvidence from a closed deal room', 'deny', updateDoc(doc(owner, 'deal_rooms/closed'), { acceptedEvidence: deleteField() }));

  // review 2026-11-18, finding 1: an acceptance cannot be forged by the rep on a not-yet-accepted deal.
  const FORGED = { acceptedTier: 'better', acceptedPrice: 1, acceptedSignature: 'x', acceptedAt: new Date(), acceptedVia: 'remote', acceptedEvidence: { ip: '6.6.6.6', clauseSetVersion: 'CS-FORGED' } };
  await check('control: owner creates an ordinary open deal room', 'allow', setDoc(doc(owner, 'deal_rooms/new1'), { userId: 'owner1', status: 'draft' }));
  await check('owner creates a deal room already accepted, with forged evidence', 'deny', setDoc(doc(owner, 'deal_rooms/new2'), Object.assign({ userId: 'owner1', status: 'accepted' }, FORGED)));
  await check('owner creates an open deal room carrying acceptedEvidence', 'deny', setDoc(doc(owner, 'deal_rooms/new3'), { userId: 'owner1', status: 'draft', acceptedEvidence: FORGED.acceptedEvidence }));
  await check('owner creates an open deal room carrying acceptedSignature', 'deny', setDoc(doc(owner, 'deal_rooms/new4'), { userId: 'owner1', status: 'draft', acceptedSignature: 'x' }));
  await check('owner closes an open deal in one write with forged accepted* fields', 'deny', updateDoc(doc(owner, 'deal_rooms/open'), Object.assign({ status: 'accepted' }, FORGED)));
  await check('owner plants acceptedEvidence on an open deal', 'deny', updateDoc(doc(owner, 'deal_rooms/open'), { acceptedEvidence: FORGED.acceptedEvidence }));
  await check('owner plants acceptedSignature on an open deal', 'deny', updateDoc(doc(owner, 'deal_rooms/open'), { acceptedSignature: 'x' }));
  await check('control: owner still marks an open deal signed (no accepted* fields touched)', 'allow', updateDoc(doc(owner, 'deal_rooms/open'), { status: 'signed' }));

  // finding 9: the legacy top-level /documents collection.
  await check('control: owner creates an ordinary legacy document', 'allow', setDoc(doc(owner, 'documents/legacyNew'), { userId: 'owner1', name: 'x', status: 'draft' }));
  await check('owner creates a legacy document carrying signatureEvidence', 'deny', setDoc(doc(owner, 'documents/legacyNew2'), { userId: 'owner1', name: 'x', status: 'draft', signatureEvidence: EV }));
  await check('control: owner edits an ordinary field on a legacy document', 'allow', updateDoc(doc(owner, 'documents/legacyA'), { name: 'renamed' }));
  await check('owner plants signatureEvidence on a legacy document', 'deny', updateDoc(doc(owner, 'documents/legacyA'), { signatureEvidence: EV }));
  await check('owner rewrites signatureEvidence on a legacy document', 'deny', updateDoc(doc(owner, 'documents/legacyB'), { 'signatureEvidence.ip': '6.6.6.6' }));
  await check('owner deletes signatureEvidence from a legacy document', 'deny', updateDoc(doc(owner, 'documents/legacyB'), { signatureEvidence: deleteField() }));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' — ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
