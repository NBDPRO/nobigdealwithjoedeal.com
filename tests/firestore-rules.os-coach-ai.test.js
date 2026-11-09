/**
 * Firestore rules — NBD OS Coach AI focus line (2026-11-09, NBD OS P2;
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.2, functions/coach-line.js).
 *
 *   companyProfile/{companyId}.coachAiEnabled   the company's opt-in, a boolean or absent;
 *                                               written by the solo owner or company_admin only
 *   coach_lines/{uid}_{day}                     today's checked AI sentence: Admin SDK only
 *   coach_line_quota/{day}__u__{uid} / __c__{cid}  the daily caps: Admin SDK only
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-coachai-test \
 *     'node firestore-rules.os-coach-ai.test.js'
 *
 * Every deny is paired with an allow of the same write minus the one defect
 * (a positive control), so a rule that denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-coachai-test';
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
  const platform = ctx('pat', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, getDoc, deleteDoc, doc } = require('firebase/firestore');
  const cp = (db, co) => doc(db, 'companyProfile/' + (co || 'co-a'));

  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'companyProfile/co-a'), { companyName: 'Acme Roofing' });
    await setDoc(doc(f, 'companyProfile/co-b'), { companyName: 'Other Co' });
    await setDoc(doc(f, 'coach_lines/alice_2026-11-09'), { uid: 'alice', companyId: 'co-a', line: 'Call back first.' });
    await setDoc(doc(f, 'coach_line_quota/2026-11-09__u__alice'), { n: 3 });
    await setDoc(doc(f, 'coach_line_quota/2026-11-09__c__co-a'), { n: 60 });
  });

  // -- the opt-in: who may turn it on or off
  await check('the solo owner turns the Coach AI line on', 'allow', setDoc(cp(solo), { coachAiEnabled: true }, { merge: true }));
  await check('a company_admin turns it off', 'allow', setDoc(cp(admin), { coachAiEnabled: false }, { merge: true }));
  await check('a company_admin turns it on', 'allow', setDoc(cp(admin), { coachAiEnabled: true }, { merge: true }));
  await check('a rep cannot turn it on', 'deny', setDoc(cp(rep), { coachAiEnabled: true }, { merge: true }));
  await check('a manager cannot turn it on', 'deny', setDoc(cp(mgr), { coachAiEnabled: true }, { merge: true }));
  await check('a viewer cannot turn it on', 'deny', setDoc(cp(vic), { coachAiEnabled: true }, { merge: true }));
  await check('another tenant\'s admin cannot turn co-a\'s on', 'deny', setDoc(cp(otherAdmin), { coachAiEnabled: true }, { merge: true }));
  await check('positive control: that admin turns their own (co-b) on', 'allow', setDoc(cp(otherAdmin, 'co-b'), { coachAiEnabled: true }, { merge: true }));
  await check('signed out cannot turn it on', 'deny', setDoc(cp(anon), { coachAiEnabled: true }, { merge: true }));

  // -- the opt-in: its shape
  await check('a string "true" is not a boolean', 'deny', setDoc(cp(admin), { coachAiEnabled: 'true' }, { merge: true }));
  await check('1 is not a boolean', 'deny', setDoc(cp(admin), { coachAiEnabled: 1 }, { merge: true }));
  await check('null is not a boolean', 'deny', setDoc(cp(admin), { coachAiEnabled: null }, { merge: true }));
  await check('positive control: the same write as a boolean', 'allow', setDoc(cp(admin), { coachAiEnabled: true }, { merge: true }));
  await check('an unrelated profile save still works with the flag on the doc', 'allow', setDoc(cp(admin), { companyName: 'Acme Roofing LLC' }, { merge: true }));
  await check('a brand-new profile may carry it (create)', 'allow', setDoc(cp(platform, 'co-new'), { companyName: 'New', coachAiEnabled: false }));
  await check('…but not as a string (create)', 'deny', setDoc(cp(platform, 'co-new2'), { companyName: 'New', coachAiEnabled: 'yes' }));

  // -- the whole tenant still reads the profile (the browser shows the line only when it is on)
  await check('a rep reads the profile', 'allow', getDoc(cp(rep)));
  await check('a viewer reads the profile', 'allow', getDoc(cp(vic)));
  await check('another tenant\'s admin cannot read co-a', 'deny', getDoc(cp(otherAdmin)));

  // -- coach_lines and coach_line_quota: Admin SDK only, whoever the client is
  const line = (db) => doc(db, 'coach_lines/alice_2026-11-09');
  const uq = (db) => doc(db, 'coach_line_quota/2026-11-09__u__alice');
  const cq = (db) => doc(db, 'coach_line_quota/2026-11-09__c__co-a');
  for (const [who, db] of [['the rep herself', rep], ['the solo owner', solo], ['a company_admin', admin], ['a platform admin', platform], ['signed out', anon]]) {
    await check(who + ' cannot read a coach line', 'deny', getDoc(line(db)));
    await check(who + ' cannot write a coach line', 'deny', setDoc(line(db), { uid: 'alice', line: 'Anything at all.' }));
    await check(who + ' cannot read a quota', 'deny', getDoc(uq(db)));
    await check(who + ' cannot reset the user cap', 'deny', setDoc(uq(db), { n: 0 }));
    await check(who + ' cannot reset the company cap', 'deny', setDoc(cq(db), { n: 0 }));
  }
  await check('the rep cannot delete her coach line', 'deny', deleteDoc(line(rep)));
  await check('a company_admin cannot delete a quota', 'deny', deleteDoc(cq(admin)));
  await check('positive control: the rep can read something (her company profile)', 'allow', getDoc(cp(rep)));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note)));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
