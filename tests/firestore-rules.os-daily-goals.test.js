/**
 * Firestore rules — NBD OS daily goals (2026-11-09, NBD OS P1 "Daily Success";
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.1).
 *
 *   companies/{companyId}/settings/goals
 *     { callsPerDay?, followUpsPerDay?, doorsPerDay?, updatedAt?, updatedBy? }
 *     each goal a whole number 0-500, or left out (no goal)
 *
 * Read by the whole tenant (the solo owner, any member whose companyId claim
 * is that company, platform admins). Written (create / update / delete) by the
 * solo owner (uid == companyId) or that company's company_admin. Not a
 * manager, rep or viewer, not another tenant, not anonymous.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-osgoals-test \
 *     'node firestore-rules.os-daily-goals.test.js'
 *
 * Every deny is paired with an allow of the same write minus the one defect
 * (a positive control), so a rule that denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-osgoals-test';
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
  const host = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080');
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: host.split(':')[0], port: Number(host.split(':')[1]) || 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const solo = ctx('co-a', {});                                             // solo owner: uid == companyId
  const admin = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const rep = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const mgr = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const otherAdmin = ctx('bob', { role: 'company_admin', companyId: 'co-b' });
  const otherRep = ctx('ray', { role: 'sales_rep', companyId: 'co-b' });
  const platform = ctx('pat', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, getDoc, deleteDoc, doc } = require('firebase/firestore');
  const ref = (db, co, id) => doc(db, 'companies/' + (co || 'co-a') + '/settings/' + (id || 'goals'));
  const G = (uid, extra) => Object.assign({ callsPerDay: 10, followUpsPerDay: 5, doorsPerDay: 40, updatedAt: '2026-11-09T12:00:00.000Z', updatedBy: uid }, extra || {});

  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'companies/co-a/settings/goals'), { callsPerDay: 8, doorsPerDay: 30 });
    await setDoc(doc(c.firestore(), 'companies/co-b/settings/goals'), { callsPerDay: 3 });
  });

  // -- who may read
  await check('a rep reads their own company\'s goals', 'allow', getDoc(ref(rep)));
  await check('a manager reads them', 'allow', getDoc(ref(mgr)));
  await check('a viewer reads them', 'allow', getDoc(ref(vic)));
  await check('the solo owner reads them', 'allow', getDoc(ref(solo)));
  await check('a company_admin reads them', 'allow', getDoc(ref(admin)));
  await check('a platform admin reads them', 'allow', getDoc(ref(platform)));
  await check('another tenant\'s rep cannot read co-a', 'deny', getDoc(ref(otherRep)));
  await check('positive control: that rep reads their own (co-b)', 'allow', getDoc(ref(otherRep, 'co-b')));
  await check('another tenant\'s admin cannot read co-a', 'deny', getDoc(ref(otherAdmin)));
  await check('signed out cannot read', 'deny', getDoc(ref(anon)));

  // -- who may write
  await check('the solo owner sets the goals', 'allow', setDoc(ref(solo), G('co-a')));
  await check('a company_admin sets the goals', 'allow', setDoc(ref(admin), G('carol')));
  await check('a company_admin updates one goal', 'allow', updateDoc(ref(admin), { doorsPerDay: 25, updatedBy: 'carol' }));
  await check('a rep cannot set goals', 'deny', setDoc(ref(rep), G('alice')));
  await check('a manager cannot set goals', 'deny', setDoc(ref(mgr), G('eve')));
  await check('a viewer cannot set goals', 'deny', setDoc(ref(vic), G('vic')));
  await check('another tenant\'s admin cannot set co-a goals', 'deny', setDoc(ref(otherAdmin), G('bob')));
  await check('positive control: that admin sets their own (co-b)', 'allow', setDoc(ref(otherAdmin, 'co-b'), G('bob')));
  await check('signed out cannot write', 'deny', setDoc(ref(anon), G('x')));

  // -- the shape
  await check('every goal left out (no goals) is a valid doc', 'allow', setDoc(ref(admin), { updatedBy: 'carol' }));
  await check('one goal only', 'allow', setDoc(ref(admin), { doorsPerDay: 0, updatedBy: 'carol' }));
  await check('500 is the most', 'allow', setDoc(ref(admin), G('carol', { callsPerDay: 500 })));
  await check('501 is too many', 'deny', setDoc(ref(admin), G('carol', { callsPerDay: 501 })));
  await check('a negative goal', 'deny', setDoc(ref(admin), G('carol', { followUpsPerDay: -1 })));
  await check('a fractional goal', 'deny', setDoc(ref(admin), G('carol', { doorsPerDay: 2.5 })));
  await check('a goal as a string', 'deny', setDoc(ref(admin), G('carol', { doorsPerDay: '40' })));
  await check('a goal as null', 'deny', setDoc(ref(admin), G('carol', { callsPerDay: null })));
  await check('an extra key', 'deny', setDoc(ref(admin), G('carol', { revenuePerDay: 100000 })));
  await check('updatedBy someone else', 'deny', setDoc(ref(admin), G('alice')));
  await check('positive control: the same doc with updatedBy = the writer', 'allow', setDoc(ref(admin), G('carol')));
  await check('update cannot add an extra key', 'deny', updateDoc(ref(admin), { byUid: { alice: 3 } }));

  // -- only the goals doc id is opened by this block
  await check('a rep cannot read a made-up settings doc', 'deny', getDoc(ref(rep, 'co-a', 'goals2')));
  await check('an admin cannot write a made-up settings doc', 'deny', setDoc(ref(admin, 'co-a', 'goals2'), G('carol')));

  // -- delete
  await check('a rep cannot delete the goals', 'deny', deleteDoc(ref(rep)));
  await check('a viewer cannot delete the goals', 'deny', deleteDoc(ref(vic)));
  await check('a company_admin deletes the goals', 'allow', deleteDoc(ref(admin)));
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'companies/co-a/settings/goals'), { callsPerDay: 8 }); });
  await check('the solo owner deletes the goals', 'allow', deleteDoc(ref(solo)));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note)));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
