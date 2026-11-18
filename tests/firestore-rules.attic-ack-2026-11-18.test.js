/**
 * Firestore rules, attic acknowledgment (phase 3, 2026-11-18):
 *  - leads/{leadId}/documents.atticAckResult is server-owned (the gate and the warranty read it): no client creates a row
 *    with it, plants it, rewrites it or removes it;
 *  - attic_overrides is write:false for every client (the owner/admin "proceed anyway" event is written by recordAtticOverride
 *    only), readable by the company's own readers and the person who recorded it.
 * Every deny is paired with an allow, so a rule that denies everything cannot pass.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-atticack-test \
 *     'node firestore-rules.attic-ack-2026-11-18.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-atticack-test';
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
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: Number(String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':').pop()) },
  });
  const { setDoc, doc, updateDoc, getDoc, deleteField } = require('firebase/firestore');
  const owner = env.authenticatedContext('owner1', {}).firestore();
  const rep = env.authenticatedContext('rep1', { companyId: 'owner1', role: 'sales_rep' }).firestore();
  const admin = env.authenticatedContext('adm1', { companyId: 'owner1', role: 'company_admin' }).firestore();
  const stranger = env.authenticatedContext('x9', { companyId: 'other', role: 'company_admin' }).firestore();
  const RES = { version: 'ATTIC_ACK_V1', complete: true, declined: false, notInspected: false, acknowledgments: [] };

  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'leads/L1'), { userId: 'owner1', companyId: 'owner1' });
    await setDoc(doc(db, 'leads/L1/documents/draft'), { name: 'a', type: 'attic_acknowledgment', status: 'draft', userId: 'owner1' });
    await setDoc(doc(db, 'leads/L1/documents/signed'), { name: 'a', type: 'attic_acknowledgment', status: 'signed', signedAt: new Date(), userId: 'owner1', atticAckResult: RES });
    await setDoc(doc(db, 'attic_overrides/o1'), { leadId: 'L1', companyId: 'owner1', byUid: 'owner1', byName: 'Joe', reason: 'would not sign the page', at: 1 });
  });

  const d = (id) => doc(owner, 'leads/L1/documents/' + id);
  await check('control: owner creates an ordinary attic document row', 'allow', setDoc(doc(owner, 'leads/L1/documents/new1'), { name: 'x', type: 'attic_acknowledgment', status: 'draft', userId: 'owner1' }));
  await check('owner creates a row already carrying atticAckResult', 'deny', setDoc(doc(owner, 'leads/L1/documents/new2'), { name: 'x', type: 'attic_acknowledgment', status: 'signed', userId: 'owner1', atticAckResult: RES }));
  await check('control: owner edits an ordinary field on a draft', 'allow', updateDoc(d('draft'), { name: 'renamed' }));
  await check('owner plants atticAckResult on a draft', 'deny', updateDoc(d('draft'), { atticAckResult: RES }));
  await check('owner rewrites atticAckResult on a signed row', 'deny', updateDoc(d('signed'), { atticAckResult: Object.assign({}, RES, { declined: true }) }));
  await check('owner changes one nested atticAckResult field', 'deny', updateDoc(d('signed'), { 'atticAckResult.complete': false }));
  await check('owner removes atticAckResult from a signed row', 'deny', updateDoc(d('signed'), { atticAckResult: deleteField() }));

  const ov = (db, id) => doc(db, 'attic_overrides/' + id);
  await check('owner cannot create an override event (write:false)', 'deny', setDoc(ov(owner, 'forged'), { leadId: 'L1', companyId: 'owner1', byUid: 'owner1', reason: 'forged event', at: 2 }));
  await check('a rep cannot create an override event', 'deny', setDoc(ov(rep, 'forged2'), { leadId: 'L1', companyId: 'owner1', byUid: 'rep1', reason: 'forged event', at: 2 }));
  await check('nobody edits an override event', 'deny', updateDoc(ov(owner, 'o1'), { reason: 'rewritten reason here' }));
  await check('nobody deletes an override event', 'deny', require('firebase/firestore').deleteDoc(ov(owner, 'o1')));
  await check('control: the person who recorded it can read it', 'allow', getDoc(ov(owner, 'o1')));
  await check('control: the company_admin of the same company can read it', 'allow', getDoc(ov(admin, 'o1')));
  await check('a rep who did not record it cannot read it', 'deny', getDoc(ov(rep, 'o1')));
  await check('another company\'s admin cannot read it', 'deny', getDoc(ov(stranger, 'o1')));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.note ? ' — ' + r.note : '')));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
