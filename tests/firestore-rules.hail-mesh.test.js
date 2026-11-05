/**
 * Firestore rules — MRMS MESH radar hail swaths (2026-11-04).
 *
 *   hail_mesh/{YYYY-MM-DD}   one doc per storm day, written by meshHailCron
 *                            (functions/integrations/mesh-hail.js, admin SDK)
 *
 * Public NOAA data cut to the service area, no tenant data, so any signed-in
 * non-anonymous user READS it for the storm maps. Nobody writes it from a
 * client: a rep who could write a day could paint a fake hail swath over a
 * neighbourhood, and that map is what the canvassing pitch is built on.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-hailmesh-test \
 *     'node firestore-rules.hail-mesh.test.js'
 *
 * Every deny is paired with a positive control (a signed-in rep CAN read a
 * day), so a rule that denies everything cannot pass. RULES_PATH points the
 * suite at a mutated copy of firestore.rules (the mutation check).
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-hailmesh-test';
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
  const hostPort = String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: hostPort[0], port: Number(hostPort[1]) || 8080 },
  });
  const rep = env.authenticatedContext('rep-uid', { companyId: 'c1', role: 'sales_rep' }).firestore();
  const otherTenant = env.authenticatedContext('other-uid', { companyId: 'c2' }).firestore();
  const admin = env.authenticatedContext('plat', { role: 'admin' }).firestore();
  const anonUser = env.authenticatedContext('anon-uid', { firebase: { sign_in_provider: 'anonymous' } }).firestore();
  const nobody = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, deleteDoc, updateDoc } = require('firebase/firestore');
  const DAY = 'hail_mesh/2026-06-26';
  const REAL = { ymd: '2026-06-26', maxIn: 1.2, polygonCount: 1, bandsJson: '[]' };

  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), DAY), REAL); });

  // positive controls: the storm maps can read a day
  await check('control: a signed-in rep reads a storm day', 'allow', getDoc(doc(rep, DAY)));
  await check('control: another tenant\'s user reads it too (public NOAA data)', 'allow', getDoc(doc(otherTenant, DAY)));

  await check('signed-out caller cannot read', 'deny', getDoc(doc(nobody, DAY)));
  await check('anonymous sign-in cannot read', 'deny', getDoc(doc(anonUser, DAY)));
  for (const [who, db] of [['a rep', rep], ['another tenant', otherTenant], ['a platform admin', admin], ['an anonymous caller', anonUser], ['a signed-out caller', nobody]]) {
    await check(who + ' cannot create a fake day', 'deny', setDoc(doc(db, 'hail_mesh/2026-06-27'), { ymd: '2026-06-27', maxIn: 3, bandsJson: '[]' }));
    await check(who + ' cannot overwrite a day', 'deny', setDoc(doc(db, DAY), { ymd: '2026-06-26', maxIn: 3, bandsJson: '[]' }));
    await check(who + ' cannot edit a day', 'deny', updateDoc(doc(db, DAY), { maxIn: 3 }));
    await check(who + ' cannot delete a day', 'deny', deleteDoc(doc(db, DAY)));
  }

  await env.withSecurityRulesDisabled(async (c) => {
    const d = await getDoc(doc(c.firestore(), DAY));
    results.push({ label: 'the stored day is exactly what the admin SDK wrote (denied writes changed nothing)', ok: d.exists() && d.data().maxIn === 1.2, note: JSON.stringify(d.data()) });
    const f = await getDoc(doc(c.firestore(), 'hail_mesh/2026-06-27'));
    results.push({ label: 'no fake day was created', ok: !f.exists(), note: 'fake doc exists' });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nhail-mesh rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
