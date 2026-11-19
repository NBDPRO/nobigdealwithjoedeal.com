/**
 * Firestore rules — agreed sub pay per job (2026-11-19, flag subJobBoard).
 *
 *   companies/{companyId}/subJobs/{leadId}
 *     subId, basis (sq|job|hour|day), rateCents, qty, agreedCents (all cents),
 *     noSubNeeded, note, updatedAt, updatedBy. Doc id = the lead id.
 *
 * Decisions (Joe, 2026-11-19): this is COST DATA, so it sits in its own
 * collection and never on the customer-facing lead record. Read AND write: the
 * solo owner, the company's company_admin and manager. A sales_rep, a viewer
 * (including a viewer whose uid is the company id), another tenant and an
 * anonymous caller read and write nothing. No other key may ride along; a tax
 * ID typed into the note is refused.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-subjobs-test \
 *     'node firestore-rules.sub-jobs.test.js'
 *
 * Every deny is paired with an allow of the same write minus the one defect (a
 * positive control), so a rule that denies everything cannot pass. RULES_PATH
 * points the suite at a mutated copy of firestore.rules (the mutation check).
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-subjobs-test';
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
  const owner = ctx('co-a', {});                                            // solo owner: uid == companyId
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const mike = ctx('mike', { role: 'manager', companyId: 'co-a' });
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const viewerOwner = ctx('co-v', { role: 'viewer' });                       // uid == companyId but a viewer
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const bobOwner = ctx('co-b', {});
  const noRole = ctx('norole', { companyId: 'co-a' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, deleteDoc, serverTimestamp } = require('firebase/firestore');
  const sj = (db, id, co) => doc(db, 'companies/' + (co || 'co-a') + '/subJobs/' + (id || 'lead1'));
  const good = (uid, over) => Object.assign({
    subId: 'sub1', basis: 'sq', rateCents: 8500, qty: 32, agreedCents: 272000,
    noSubNeeded: false, note: 'Tear-off and install, agreed by text', updatedAt: serverTimestamp(), updatedBy: uid,
  }, over || {});

  // -- who writes (each deny has an allow of the same write by a permitted role)
  await check('the solo owner writes agreed pay', 'allow', setDoc(sj(owner), good('co-a')));
  await check('a company_admin writes agreed pay', 'allow', setDoc(sj(carol, 'l2'), good('carol')));
  await check('a manager writes agreed pay', 'allow', setDoc(sj(mike, 'l3'), good('mike')));
  await check('a sales rep CANNOT write agreed pay', 'deny', setDoc(sj(alice, 'l4'), good('alice')));
  await check('a viewer CANNOT write agreed pay', 'deny', setDoc(sj(vic, 'l5'), good('vic')));
  await check('a viewer whose uid IS the company id CANNOT write (isolates notViewer())', 'deny', setDoc(sj(viewerOwner, 'l6', 'co-v'), good('co-v')));
  await check('control: the same company id as a normal owner CAN', 'allow', setDoc(sj(ctx('co-v', {}), 'l7', 'co-v'), good('co-v')));
  await check('another tenant CANNOT write into co-a', 'deny', setDoc(sj(bobCA, 'l8'), good('bobca')));
  await check("another tenant's owner CANNOT write into co-a", 'deny', setDoc(sj(bobOwner, 'l9'), good('co-b')));
  await check('anonymous CANNOT write', 'deny', setDoc(sj(anon, 'l10'), good('anon')));
  await check('a token with a companyId but no role CANNOT write', 'deny', setDoc(sj(noRole, 'l11'), good('norole')));
  await check('control: a company_admin of co-b writes in co-b', 'allow', setDoc(sj(bobCA, 'l12', 'co-b'), good('bobca')));

  // -- who reads (cost data: staff only)
  await check('the solo owner reads agreed pay', 'allow', getDoc(sj(owner)));
  await check('a company_admin reads agreed pay', 'allow', getDoc(sj(carol)));
  await check('a manager reads agreed pay', 'allow', getDoc(sj(mike)));
  await check('a sales rep CANNOT read agreed pay', 'deny', getDoc(sj(alice)));
  await check('a viewer CANNOT read agreed pay', 'deny', getDoc(sj(vic)));
  await check('a viewer whose uid is the company id CANNOT read agreed pay', 'deny', getDoc(sj(viewerOwner, 'l7', 'co-v')));
  await check('another tenant CANNOT read agreed pay', 'deny', getDoc(sj(bobCA)));
  await check('anonymous CANNOT read agreed pay', 'deny', getDoc(sj(anon)));
  await check('a token with a companyId but no role CANNOT read agreed pay', 'deny', getDoc(sj(noRole)));

  // -- shape
  await check('an unknown key is denied (no cost / price / margin rides along)', 'deny', setDoc(sj(owner, 's1'), good('co-a', { margin: 12 })));
  await check('control: the same doc without the extra key', 'allow', setDoc(sj(owner, 's1'), good('co-a')));
  await check('an unknown pay basis is denied', 'deny', setDoc(sj(owner, 's2'), good('co-a', { basis: 'week' })));
  await check('control: each pay basis is allowed', 'allow', Promise.all(['sq', 'job', 'hour', 'day'].map((b, i) => setDoc(sj(owner, 's3' + i), good('co-a', { basis: b })))));
  await check('a fractional rateCents is denied (money is whole cents)', 'deny', setDoc(sj(owner, 's4'), good('co-a', { rateCents: 85.5 })));
  await check('a negative rateCents is denied', 'deny', setDoc(sj(owner, 's5'), good('co-a', { rateCents: -1 })));
  await check('a rateCents over the cap is denied', 'deny', setDoc(sj(owner, 's6'), good('co-a', { rateCents: 10000000 })));
  await check('control: rateCents at the cap', 'allow', setDoc(sj(owner, 's7'), good('co-a', { rateCents: 9999999 })));
  await check('an agreedCents over the cap is denied', 'deny', setDoc(sj(owner, 's8'), good('co-a', { agreedCents: 100000000 })));
  await check('control: agreedCents at the cap', 'allow', setDoc(sj(owner, 's9'), good('co-a', { agreedCents: 99999999 })));
  await check('a string agreedCents is denied', 'deny', setDoc(sj(owner, 's10'), good('co-a', { agreedCents: '2720' })));
  await check('a negative qty is denied', 'deny', setDoc(sj(owner, 's11'), good('co-a', { qty: -1 })));
  await check('control: a fractional qty (32.5 squares) is allowed', 'allow', setDoc(sj(owner, 's12'), good('co-a', { qty: 32.5 })));
  await check('noSubNeeded must be a boolean', 'deny', setDoc(sj(owner, 's13'), good('co-a', { noSubNeeded: 'yes' })));
  await check('control: noSubNeeded true with no sub or money is allowed', 'allow', setDoc(sj(owner, 's14'), { noSubNeeded: true, updatedAt: serverTimestamp(), updatedBy: 'co-a' }));
  await check('a note over 300 characters is denied', 'deny', setDoc(sj(owner, 's15'), good('co-a', { note: 'n'.repeat(301) })));
  await check('control: a note of exactly 300 characters', 'allow', setDoc(sj(owner, 's16'), good('co-a', { note: 'n'.repeat(300) })));
  await check('an SSN typed into the note is denied', 'deny', setDoc(sj(owner, 's17'), good('co-a', { note: 'ssn 123-45-6789' })));
  await check('control: a phone number in the note is fine', 'allow', setDoc(sj(owner, 's18'), good('co-a', { note: 'call 513-555-0100' })));
  await check('a null subId is allowed (job with no sub yet)', 'allow', setDoc(sj(owner, 's19'), good('co-a', { subId: null })));
  await check('an empty subId string is denied', 'deny', setDoc(sj(owner, 's20'), good('co-a', { subId: '' })));
  await check('updatedBy must be the writer', 'deny', setDoc(sj(carol, 's21'), good('someone-else')));
  await check('control: updatedBy is the writer', 'allow', setDoc(sj(carol, 's21'), good('carol')));
  await check('updatedAt is required', 'deny', setDoc(sj(owner, 's22'), { subId: 'sub1', updatedBy: 'co-a' }));
  await check('updatedAt must be a timestamp', 'deny', setDoc(sj(owner, 's23'), good('co-a', { updatedAt: 'today' })));
  await check('a lead id with a dot is denied', 'deny', setDoc(sj(owner, 'a.b'), good('co-a')));
  await check('a lead id of 129 characters is denied', 'deny', setDoc(sj(owner, 'x'.repeat(129)), good('co-a')));
  await check('control: a lead id of 128 characters', 'allow', setDoc(sj(owner, 'x'.repeat(128)), good('co-a')));

  // -- update and delete
  await check('a manager updates an existing agreed-pay doc', 'allow', setDoc(sj(mike, 'lead1'), good('mike', { agreedCents: 300000 })));
  await check('a viewer CANNOT update an existing doc', 'deny', setDoc(sj(vic, 'lead1'), good('vic', { agreedCents: 1 })));
  await check('a sales rep CANNOT delete', 'deny', deleteDoc(sj(alice, 'lead1')));
  await check('a viewer CANNOT delete', 'deny', deleteDoc(sj(vic, 'lead1')));
  await check('another tenant CANNOT delete', 'deny', deleteDoc(sj(bobCA, 'lead1')));
  await check('a manager deletes', 'allow', deleteDoc(sj(mike, 'lead1')));
  await check('a company_admin deletes', 'allow', deleteDoc(sj(carol, 'l2')));

  await env.cleanup();
  const failed = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ok   ' : '  FAIL ') + r.label + (r.ok ? '' : '  -> ' + r.note)));
  console.log('\n' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  if (failed.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
