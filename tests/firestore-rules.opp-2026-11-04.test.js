/**
 * Firestore rules — Thumbtack Opportunities watcher (2026-11-04, flag thumbtackOpportunities, dark).
 *
 *   opp_seen/{companyId}_{oppId}   one record per Opportunity seen (PR 2)
 *   opp_rules/_default             the owner's rules override + kill switch (PR 2)
 *   opp_drafts/{companyId}_{oppId} the pending first-message draft, create-only (PR 3)
 *   documentation/projects/THUMBTACK-OPPORTUNITIES-2026-11-04.md
 *
 * ADMIN-SDK ONLY. The oppShortlistFile / oppDraftFile callables are the sole writers and the owner reads
 * through callables, so every client read AND write is denied, whoever the client is:
 * the owner, a platform admin, a company admin, another tenant, anonymous. The test proves
 * each path is denied for each of those, and (positive controls) that the harness really
 * does allow a read that the rules DO allow, so a "deny everything" harness cannot pass.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-opp-test \
 *     'node firestore-rules.opp-2026-11-04.test.js'
 * RULES_PATH points a break-test at a mutated copy of the rules.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-opp-test';
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
    results.push({ label, ok: false, note: expect === 'deny' ? 'WAS ALLOWED' : 'was denied: ' + String((e && e.message) || e).slice(0, 120) });
  }
}

async function run() {
  // emulators:exec exports FIRESTORE_EMULATOR_HOST (host:port); CI uses the default 8080.
  const [emuHost, emuPort] = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: emuHost, port: Number(emuPort) },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const owner = ctx('co-a', {});                                          // solo owner: uid == companyId
  const ownerAdmin = ctx('co-a', { owner: true, role: 'admin' });         // the owner's minted claims
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const bob = ctx('co-b', {});                                            // another tenant's owner
  const joe = ctx('joe', { role: 'admin' });                              // platform admin
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, getDocs, collection, deleteDoc, updateDoc, query, where } = require('firebase/firestore');

  const SEEN = 'opp_seen/co-a_ZZ_QA_1';
  const RULES_DOC = 'opp_rules/_default';
  const DRAFT = 'opp_drafts/co-a_ZZ_QA_1';
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), SEEN), { companyId: 'co-a', oppId: 'ZZ_QA_1', decision: 'SHOW', score: 80 });
    await setDoc(doc(c.firestore(), RULES_DOC), { killSwitch: false });
    await setDoc(doc(c.firestore(), DRAFT), { companyId: 'co-a', oppId: 'ZZ_QA_1', status: 'pending', draftText: 'ZZ_QA first draft' });
    await setDoc(doc(c.firestore(), 'feature_flags/_default'), { thumbtackOpportunities: false });
  });

  // -- positive control: the harness allows what the rules allow (so deny-everything cannot pass)
  await check('CONTROL: any signed-in user reads feature_flags/_default (an existing allow)', 'allow', getDoc(doc(owner, 'feature_flags/_default')));
  await check('CONTROL: the same read by anonymous is denied (the harness does tell users apart)', 'deny', getDoc(doc(anon, 'feature_flags/_default')));

  const who = [['solo owner', owner], ['owner with minted admin claims', ownerAdmin], ['company_admin', carol], ['manager', eve], ['sales_rep', alice], ['viewer', vic], ['other tenant owner', bob], ['platform admin', joe], ['anonymous', anon]];
  for (const [name, db] of who) {
    await check(name + ' CANNOT read an opp_seen doc', 'deny', getDoc(doc(db, SEEN)));
    await check(name + ' CANNOT list opp_seen', 'deny', getDocs(collection(db, 'opp_seen')));
    await check(name + ' CANNOT query opp_seen by companyId', 'deny', getDocs(query(collection(db, 'opp_seen'), where('companyId', '==', 'co-a'))));
    await check(name + ' CANNOT create an opp_seen doc', 'deny', setDoc(doc(db, 'opp_seen/co-a_ZZ_QA_2'), { companyId: 'co-a', oppId: 'ZZ_QA_2', decision: 'SHOW', score: 99 }));
    await check(name + ' CANNOT update an opp_seen doc', 'deny', updateDoc(doc(db, SEEN), { decision: 'SKIP' }));
    await check(name + ' CANNOT delete an opp_seen doc', 'deny', deleteDoc(doc(db, SEEN)));
    await check(name + ' CANNOT read opp_rules', 'deny', getDoc(doc(db, RULES_DOC)));
    await check(name + ' CANNOT write opp_rules (no client can lift the kill switch or raise a cap)', 'deny', setDoc(doc(db, RULES_DOC), { killSwitch: false, caps: { sendsPerDay: 99 } }));
    await check(name + ' CANNOT delete opp_rules', 'deny', deleteDoc(doc(db, RULES_DOC)));
    await check(name + ' CANNOT read an opp_drafts doc', 'deny', getDoc(doc(db, DRAFT)));
    await check(name + ' CANNOT list opp_drafts', 'deny', getDocs(collection(db, 'opp_drafts')));
    await check(name + ' CANNOT create an opp_drafts doc (the callable is the only writer)', 'deny', setDoc(doc(db, 'opp_drafts/co-a_ZZ_QA_2'), { companyId: 'co-a', oppId: 'ZZ_QA_2', status: 'pending', draftText: 'x' }));
    await check(name + ' CANNOT approve a draft (update status)', 'deny', updateDoc(doc(db, DRAFT), { status: 'approved' }));
    await check(name + ' CANNOT overwrite a draft (set over the existing doc)', 'deny', setDoc(doc(db, DRAFT), { companyId: 'co-a', oppId: 'ZZ_QA_1', status: 'sent', draftText: 'changed' }));
    await check(name + ' CANNOT delete a draft', 'deny', deleteDoc(doc(db, DRAFT)));
  }
  await check('another opp_rules doc id is denied too', 'deny', setDoc(doc(owner, 'opp_rules/co-a'), { killSwitch: false }));
  await check('a sub-path under opp_seen is denied (default deny)', 'deny', setDoc(doc(owner, 'opp_seen/co-a_ZZ_QA_1/notes/n1'), { x: 1 }));

  // the seeded docs are still exactly as seeded (nothing above slipped through)
  await env.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), SEEN));
    const r = await getDoc(doc(c.firestore(), RULES_DOC));
    results.push({ label: 'seeded opp_seen is untouched after all of the above', ok: s.exists() && s.data().decision === 'SHOW' && s.data().score === 80 });
    results.push({ label: 'seeded opp_rules is untouched after all of the above', ok: r.exists() && r.data().killSwitch === false && !r.data().caps });
    const n = await getDoc(doc(c.firestore(), 'opp_seen/co-a_ZZ_QA_2'));
    const dr = await getDoc(doc(c.firestore(), DRAFT));
    const dn = await getDoc(doc(c.firestore(), 'opp_drafts/co-a_ZZ_QA_2'));
    results.push({ label: 'seeded opp_drafts doc is untouched (still pending, text unchanged)', ok: dr.exists() && dr.data().status === 'pending' && dr.data().draftText === 'ZZ_QA first draft' });
    results.push({ label: 'no opp_drafts doc was created by a denied write', ok: !dn.exists() });
    results.push({ label: 'no doc was created by a denied write', ok: !n.exists() });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + (r.note || ''))));
  console.log('\nopp rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
