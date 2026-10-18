/**
 * Firestore rules — morningBriefState/{companyId} (2026-10-18).
 *
 * The ids-only snapshot of what the previous 06:45 brief listed (delta mode,
 * functions/morning-brief-delta.js). Admin SDK only: NO client may read or
 * write it, whoever they are, including the owner whose uid is the doc id and a
 * platform admin. A client write could hide items from the owner's brief.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-mbstate-test \
 *     'node firestore-rules.morning-brief-state.test.js'
 *
 * Positive control: the same actors CAN write a sibling client-writable path
 * (users/{uid}) so a rules file that denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-mbstate-test';
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
  const owner = ctx('co-a', {});                                            // solo owner: uid == companyId
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const bob = ctx('co-b', {});
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, deleteDoc } = require('firebase/firestore');
  const ref = (db, id) => doc(db, 'morningBriefState/' + (id || 'co-a'));
  const snap = { companyId: 'co-a', updatedAtMs: 1, snapshot: { v: 1, atMs: 1, lists: { needsWeek: { atMs: 1, ids: ['L1/-'] } } } };

  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'morningBriefState/co-a'), snap); });

  for (const [who, db] of [['the solo owner (uid == doc id)', owner], ['a company_admin of that company', carol], ['another tenant', bob], ['a platform admin', joe], ['anonymous', anon]]) {
    await check(who + ' CANNOT read it', 'deny', getDoc(ref(db)));
    await check(who + ' CANNOT write it', 'deny', setDoc(ref(db), snap));
    await check(who + ' CANNOT delete it', 'deny', deleteDoc(ref(db)));
  }
  await check('control: the owner CAN write a client-writable sibling (users/{uid})', 'allow', setDoc(doc(owner, 'users/co-a'), { displayName: 'Jo' }));

  await env.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), 'morningBriefState/co-a'));
    results.push({ label: 'the stored snapshot is untouched by every denied write', ok: s.exists() && JSON.stringify(s.data()) === JSON.stringify(snap), note: JSON.stringify(s.data()) });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nmorningBriefState rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
