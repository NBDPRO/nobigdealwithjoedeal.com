/**
 * Firestore rules — the Apple Health weight Shortcut (2026-10-20).
 *
 *   health_shortcut_keys/{sha256 of key}   key hash -> uid        (admin SDK only)
 *   health_shortcut_state/{uid}            the one live hash, last reading, on/off (admin SDK only)
 *   system/healthShortcut                  the dark flag {enabled:true}  (admin SDK only; covered by system/{docId})
 *   functions/health-shortcut.js
 *
 * Why it matters: a client that could READ a key doc learns which hash maps to
 * which uid; one that could WRITE health_shortcut_state could mint itself a key
 * that skips the flag and the limits; one that could write system/healthShortcut
 * could switch the dark feature on for everyone. And the Shortcut writes the
 * user's own users/{uid}/ds_pages docs, so those must stay owner-only (a
 * stranger must not read or write them).
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-hshortcut-test \
 *     'node firestore-rules.health-shortcut.test.js'
 *
 * Every deny is paired with a positive control (the owner CAN still write her
 * own ds_pages) so a rule that denies everything cannot pass. RULES_PATH points
 * the suite at a mutated copy of firestore.rules (the mutation check).
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-hshortcut-test';
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
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const jo = ctx('jo-uid', {});
  const stranger = ctx('other-uid', {});
  const admin = ctx('plat', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, deleteDoc } = require('firebase/firestore');
  const HASH = 'a'.repeat(64);
  const FORGED = 'b'.repeat(64);

  await env.withSecurityRulesDisabled(async (c) => {
    const s = c.firestore();
    await setDoc(doc(s, 'health_shortcut_keys/' + HASH), { uid: 'jo-uid', hash: HASH, createdAt: 1 });
    await setDoc(doc(s, 'health_shortcut_state/jo-uid'), { keyHash: HASH, enabled: true });
    await setDoc(doc(s, 'system/healthShortcut'), { enabled: true });
    await setDoc(doc(s, 'users/jo-uid/ds_pages/p1'), { id: 1, dk: '2026-10-20', data: {} });
  });

  // positive controls: the harness is wired, and the client can still sync its own pages
  await check('control: Jo still writes her own ds_pages doc', 'allow', setDoc(doc(jo, 'users/jo-uid/ds_pages/p2'), { id: 2, dk: '2026-10-21', data: { 'bm-wt': '185.2' } }));
  await check('control: Jo still reads her own ds_pages doc', 'allow', getDoc(doc(jo, 'users/jo-uid/ds_pages/p1')));

  for (const [who, db] of [['the owner of the data', jo], ['another signed-in user', stranger], ['a platform admin', admin], ['an anonymous caller', anon]]) {
    await check(who + ' cannot read a key doc', 'deny', getDoc(doc(db, 'health_shortcut_keys/' + HASH)));
    await check(who + ' cannot write a key doc', 'deny', setDoc(doc(db, 'health_shortcut_keys/' + FORGED), { uid: 'jo-uid', hash: FORGED }));
    await check(who + ' cannot delete a key doc', 'deny', deleteDoc(doc(db, 'health_shortcut_keys/' + HASH)));
    await check(who + ' cannot read the state doc', 'deny', getDoc(doc(db, 'health_shortcut_state/jo-uid')));
    await check(who + ' cannot write the state doc', 'deny', setDoc(doc(db, 'health_shortcut_state/jo-uid'), { keyHash: FORGED, enabled: true }));
    await check(who + ' cannot read the dark flag', 'deny', getDoc(doc(db, 'system/healthShortcut')));
    await check(who + ' cannot switch the dark flag on', 'deny', setDoc(doc(db, 'system/healthShortcut'), { enabled: true }));
  }
  await check("another signed-in user cannot read Jo's day pages", 'deny', getDoc(doc(stranger, 'users/jo-uid/ds_pages/p1')));
  await check("another signed-in user cannot write Jo's day pages", 'deny', setDoc(doc(stranger, 'users/jo-uid/ds_pages/p1'), { data: { 'bm-wt': '1' } }, { merge: true }));

  await env.withSecurityRulesDisabled(async (c) => {
    const k = await getDoc(doc(c.firestore(), 'health_shortcut_keys/' + HASH));
    const f = await getDoc(doc(c.firestore(), 'system/healthShortcut'));
    results.push({ label: 'the stored key doc and flag are exactly what the admin SDK wrote (denied writes changed nothing)', ok: k.exists() && k.data().uid === 'jo-uid' && f.data().enabled === true, note: JSON.stringify(k.data()) });
    const k2 = await getDoc(doc(c.firestore(), 'health_shortcut_keys/' + FORGED));
    results.push({ label: 'no forged key doc was created', ok: !k2.exists(), note: 'forged doc exists' });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nhealth-shortcut rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
