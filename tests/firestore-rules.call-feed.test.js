/**
 * Firestore rules — Call to Close P2 (2026-11-09): the multi-tenant call feed
 * config. Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md
 * §3.3, §9 P2, Q6.
 *
 * integrations/callCenter (NBD's feed) and integrations/callCenter_{companyId}
 * (another tenant's: owner uid, Drive folder id, enabled) are server-only.
 * Nobody signed in through a client reads or writes one: not the tenant's
 * own solo owner or company_admin, not another tenant, not a viewer, not the
 * platform admin's browser, not signed out. A client that could write
 * enabled: true would switch on call recording ingest for a company before
 * the lawyer review (Q6); one that could read it would learn a Drive folder id.
 *
 * Positive controls: the same people DO read their own company doc and the
 * call-brief settings doc in the same run, so a rules file that denies
 * everything cannot pass.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-callfeed-test \
 *     'node firestore-rules.call-feed.test.js'
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-callfeed-test';
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
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const owner = ctx('co-a', {});                                          // solo owner: uid == companyId
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, getDocs, deleteDoc, updateDoc, collection, query, where } = require('firebase/firestore');
  const F = (db, id) => doc(db, 'integrations/' + (id || 'callCenter_co-a'));
  const CFG = { kind: 'callCenterTenant', companyId: 'co-a', enabled: false, ownerUid: 'co-a', folderId: 'folderAAAA0001' };

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'companies/co-a'), { ownerId: 'co-a', name: 'A Roofing' });
    await setDoc(doc(db, 'companies/co-a/settings/callBrief'), { autoBrief: false });
    await setDoc(doc(db, 'integrations/callCenter_co-a'), CFG);
    await setDoc(doc(db, 'integrations/callCenter'), { folderId: 'nbdFolder00001', cursorYmd: '2026-11-08' });
  });

  // -- positive controls: these people can read their own company's docs
  await check('control: the owner reads their company doc', 'allow', getDoc(doc(owner, 'companies/co-a')));
  await check('control: a company_admin reads the call-brief settings', 'allow', getDoc(doc(carol, 'companies/co-a/settings/callBrief')));

  // -- reads of the tenant feed config
  for (const [who, db] of [['the solo owner', owner], ['a same-company company_admin', carol], ['a manager', eve], ['a viewer', vic], ['another tenant', bobCA], ['the platform admin (browser)', joe], ['signed out', anon]]) {
    await check(who + ' cannot read the tenant feed config', 'deny', getDoc(F(db)));
  }
  await check('the owner cannot read NBD\'s feed config', 'deny', getDoc(F(owner, 'callCenter')));
  await check('the platform admin cannot read NBD\'s feed config from a client', 'deny', getDoc(F(joe, 'callCenter')));
  await check('nobody lists the feed configs (collection query)', 'deny', getDocs(query(collection(joe, 'integrations'), where('kind', '==', 'callCenterTenant'))));

  // -- writes: nobody switches a tenant on from a client
  await check('the solo owner cannot switch their feed on', 'deny', updateDoc(F(owner), { enabled: true }));
  await check('a company_admin cannot switch it on', 'deny', setDoc(F(carol), Object.assign({}, CFG, { enabled: true })));
  await check('the platform admin cannot switch it on from a client', 'deny', updateDoc(F(joe), { enabled: true }));
  await check('another tenant cannot point co-a at their folder', 'deny', updateDoc(F(bobCA), { folderId: 'folderBBBB0002' }));
  await check('nobody creates a feed for a new company', 'deny', setDoc(F(owner, 'callCenter_co-new'), Object.assign({}, CFG, { companyId: 'co-new', enabled: true })));
  await check('nobody deletes a feed config', 'deny', deleteDoc(F(carol)));
  await check('signed out cannot write', 'deny', setDoc(F(anon), CFG));
  await check('the owner cannot move NBD\'s cursor', 'deny', updateDoc(F(owner, 'callCenter'), { cursorYmd: '2026-01-01' }));

  // The config is unchanged after every attempt.
  let still = null;
  await env.withSecurityRulesDisabled(async (c) => { still = (await getDoc(doc(c.firestore(), 'integrations/callCenter_co-a'))).data(); });
  results.push({ label: 'the tenant config is still switched off after every attempt', ok: !!still && still.enabled === false && still.folderId === 'folderAAAA0001', note: JSON.stringify(still) });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
