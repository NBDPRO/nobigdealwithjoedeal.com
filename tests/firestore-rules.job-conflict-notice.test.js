/**
 * Firestore rules — the calendar hub's "Job overlaps a booking" bell row (2026-10-23).
 *
 *   notifications/job-conflict-<leadId>-<bookingId>-<jobStartMs>
 *   written by the Cloud Function (admin SDK, rules bypassed) with
 *   { userId: <Jo>, type: 'job_conflict', ... }; Jo reads and dismisses it.
 *
 * The function never goes through these rules, so what they must guarantee is
 * the CLIENT side: a client can only create a row for itself (no spoofing a
 * conflict alert into someone else's bell), can read/dismiss only its own,
 * cannot rewrite what the alert says, and cannot re-create the same id.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-jobconf-test \
 *     'node firestore-rules.job-conflict-notice.test.js'
 *
 * Every deny is paired with an allow of the same write minus the one defect
 * (a positive control), so a rule that denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-jobconf-test';
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
  const { setDoc, doc, getDoc, updateDoc, deleteDoc, serverTimestamp } = require('firebase/firestore');
  const jo = env.authenticatedContext('jo-owner', {}).firestore();
  const eve = env.authenticatedContext('eve', { role: 'sales_rep', companyId: 'jo-owner' }).firestore();
  const anon = env.unauthenticatedContext().firestore();
  const ID = (n) => 'notifications/job-conflict-LeadA-' + n + '-1791284400000';
  const body = (extra) => Object.assign({
    userId: 'jo-owner', type: 'job_conflict', title: 'Job overlaps a booking', message: 'Install now overlaps Pat\'s booking.',
    priority: 'high', clickUrl: '/pro/dashboard.html#/schedule', read: false, dismissed: false, createdAt: serverTimestamp(),
  }, extra || {});

  // The function writes with the admin SDK; seed the same shape with rules off.
  await env.withSecurityRulesDisabled(async (c) => {
    const { setDoc: s, doc: d } = require('firebase/firestore');
    await s(d(c.firestore(), ID('seeded')), { userId: 'jo-owner', type: 'job_conflict', title: 'Job overlaps a booking', message: 'seed', read: false, dismissed: false, createdAt: new Date() });
  });

  // -- create (client side)
  await check('control: Jo creates a row addressed to himself', 'allow', setDoc(doc(jo, ID('own')), body()));
  await check('a client cannot drop a conflict alert into someone else\'s bell', 'deny', setDoc(doc(eve, ID('spoof')), body({ userId: 'jo-owner' })));
  await check('control: the same rep may create a row addressed to herself', 'allow', setDoc(doc(eve, ID('eve')), body({ userId: 'eve' })));
  await check('anonymous cannot create', 'deny', setDoc(doc(anon, ID('anon')), body()));
  await check('a second create onto an existing id is refused (the function\'s create() is once-only on the client too)', 'deny', setDoc(doc(jo, ID('own')), body({ message: 'rewritten' })));

  // -- read / dismiss
  await check('Jo reads his row', 'allow', getDoc(doc(jo, ID('seeded'))));
  await check('another user cannot read it', 'deny', getDoc(doc(eve, ID('seeded'))));
  await check('anonymous cannot read it', 'deny', getDoc(doc(anon, ID('seeded'))));
  await check('Jo marks it read and dismisses it', 'allow', updateDoc(doc(jo, ID('seeded')), { read: true, dismissed: true }));
  await check('nobody can reassign it to another user', 'deny', updateDoc(doc(jo, ID('seeded')), { userId: 'eve' }));
  await check('nobody can change its type', 'deny', updateDoc(doc(jo, ID('seeded')), { type: 'follow_up' }));
  await check('another user cannot dismiss it', 'deny', updateDoc(doc(eve, ID('seeded')), { dismissed: true }));
  await check('another user cannot delete it', 'deny', deleteDoc(doc(eve, ID('seeded'))));
  await check('Jo can delete (dismiss for good) his own row', 'allow', deleteDoc(doc(jo, ID('seeded'))));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\njob-conflict notice rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
