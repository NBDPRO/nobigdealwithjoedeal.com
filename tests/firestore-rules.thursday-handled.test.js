/**
 * Firestore rules — "let Thursday handle this number" (2026-10-12).
 *
 *   companies/{companyId}/thursday_handled/{digits10}
 *   documentation/projects/THURSDAY-LABEL-PLAYBOOKS-2026-10-12.md
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-thandled-test \
 *     'node firestore-rules.thursday-handled.test.js'
 *
 * Every deny that is about SHAPE is paired with an allow of the same doc
 * minus the one defect (a positive control), so a rule that denies
 * everything cannot pass. Numbers are 555 fixtures.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-thandled-test';
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

const D = '5550142222';
const D2 = '5550142223';
function setting(over, by) {
  return Object.assign({
    digits: D, companyId: 'co-a', updatedBy: by || 'carol', updatedAtMs: 1760000000000, createdAtMs: 1760000000000,
  }, over || {});
}

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    // RULES_PATH lets a break-test point at a mutated copy of the rules.
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const owner = ctx('co-a', {});                                          // solo owner: uid == companyId, no claims
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' }); // other tenant, strongest role
  const bobSolo = ctx('co-b', {});                                         // other tenant's solo owner
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, getDocs, collection, deleteDoc } = require('firebase/firestore');
  const ref = (db, d) => doc(db, 'companies/co-a/thursday_handled/' + (d || D));

  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'companies/co-a/thursday_handled/' + D), setting());
  });

  // -- reads
  await check('solo owner reads a setting', 'allow', getDoc(ref(owner)));
  await check('company_admin reads', 'allow', getDoc(ref(carol)));
  await check('manager reads', 'allow', getDoc(ref(eve)));
  await check('viewer reads (read-only role)', 'allow', getDoc(ref(vic)));
  await check('platform admin reads', 'allow', getDoc(ref(joe)));
  await check('owner lists the collection', 'allow', getDocs(collection(owner, 'companies/co-a/thursday_handled')));
  await check('sales_rep does NOT read (never sees teammates numbers)', 'deny', getDoc(ref(alice)));
  await check('sales_rep does NOT list', 'deny', getDocs(collection(alice, 'companies/co-a/thursday_handled')));
  await check('other tenant company_admin does NOT read', 'deny', getDoc(ref(bobCA)));
  await check('other tenant solo owner does NOT read', 'deny', getDoc(ref(bobSolo)));
  await check('other tenant does NOT list', 'deny', getDocs(collection(bobCA, 'companies/co-a/thursday_handled')));
  await check('anonymous does NOT read', 'deny', getDoc(ref(anon)));

  // -- writes: who
  await check('solo owner creates', 'allow', setDoc(ref(owner, D2), setting({ digits: D2 }, 'co-a')));
  await check('company_admin creates', 'allow', setDoc(ref(carol, '5550142224'), setting({ digits: '5550142224' }, 'carol')));
  await check('manager creates', 'allow', setDoc(ref(eve, '5550142225'), setting({ digits: '5550142225' }, 'eve')));
  await check('manager updates (note)', 'allow', setDoc(ref(eve), setting({ note: 'Aunt Pat', updatedBy: 'eve' })));
  await check('viewer CANNOT create', 'deny', setDoc(ref(vic, '5550142226'), setting({ digits: '5550142226' }, 'vic')));
  await check('viewer CANNOT update', 'deny', setDoc(ref(vic), setting({ note: 'x', updatedBy: 'vic' })));
  await check('viewer CANNOT delete (the reclaim is a writer action)', 'deny', deleteDoc(ref(vic)));
  await check('sales_rep CANNOT create', 'deny', setDoc(ref(alice, '5550142227'), setting({ digits: '5550142227' }, 'alice')));
  await check('sales_rep CANNOT update', 'deny', setDoc(ref(alice), setting({ updatedBy: 'alice' })));
  await check('sales_rep CANNOT delete', 'deny', deleteDoc(ref(alice)));
  await check('other tenant company_admin CANNOT create in co-a', 'deny', setDoc(ref(bobCA, '5550142228'), setting({ digits: '5550142228' }, 'bobca')));
  await check('other tenant company_admin CANNOT update co-a', 'deny', setDoc(ref(bobCA), setting({ updatedBy: 'bobca' })));
  await check('other tenant company_admin CANNOT delete co-a', 'deny', deleteDoc(ref(bobCA)));
  await check('other tenant solo CANNOT write into co-a', 'deny', setDoc(ref(bobSolo, '5550142229'), setting({ digits: '5550142229' }, 'co-b')));
  // notViewer() matters only where uid == companyId (isCompanyStaff already
  // excludes a viewer): a viewer-role token whose uid IS the tenant key.
  const vSelf = ctx('co-v', { role: 'viewer' });
  const vSelfOwner = ctx('co-v', {});
  const vRef = (db) => doc(db, 'companies/co-v/thursday_handled/' + D);
  await check('control: that tenant key owner (no role claim) creates', 'allow', setDoc(vRef(vSelfOwner), setting({ companyId: 'co-v' }, 'co-v')));
  await check('viewer role with uid == companyId CANNOT update', 'deny', setDoc(vRef(vSelf), setting({ companyId: 'co-v', note: 'x' }, 'co-v')));
  await check('viewer role with uid == companyId CANNOT delete', 'deny', deleteDoc(vRef(vSelf)));
  await check('anonymous CANNOT write', 'deny', setDoc(ref(anon, '5550142230'), setting({ digits: '5550142230' })));
  await check('writes into ANOTHER tenant path stay in that tenant (co-b solo owns co-b)', 'allow',
    setDoc(doc(bobSolo, 'companies/co-b/thursday_handled/' + D), setting({ companyId: 'co-b' }, 'co-b')));

  // -- writes: shape (each deny has an allow control)
  const N = '5550149000';
  const shaped = (over, d) => setDoc(ref(carol, d || N), setting(Object.assign({ digits: d || N }, over)));
  await check('control: a valid doc is accepted', 'allow', shaped({}, '5550149001'));
  await check('a mode / kind / policy key denied (existence IS the setting)', 'deny', shaped({ mode: 'blocked' }, '5550149002'));
  await check('an extra key denied (no smuggled fields)', 'deny', shaped({ leadId: 'abc' }, '5550149004'));
  await check('digits field must equal the doc id', 'deny', setDoc(ref(carol, '5550149005'), setting({ digits: '5550149006' })));
  await check('doc id must be 10 digits (9 denied)', 'deny', setDoc(ref(carol, '555014900'), setting({ digits: '555014900' })));
  await check('doc id must be digits only', 'deny', setDoc(ref(carol, '555-014-9007'), setting({ digits: '555-014-9007' })));
  await check('companyId must equal the path company', 'deny', shaped({ companyId: 'co-b' }, '5550149008'));
  await check('updatedBy must be the writer', 'deny', shaped({ updatedBy: 'someone-else' }, '5550149009'));
  await check('note over 200 chars denied', 'deny', shaped({ note: 'y'.repeat(201) }, '5550149012'));
  await check('note at 200 chars accepted (control)', 'allow', shaped({ note: 'y'.repeat(200) }, '5550149011'));
  await check('note must be a string', 'deny', shaped({ note: 12 }, '5550149013'));
  await check('missing createdAtMs denied', 'deny', setDoc(ref(carol, '5550149014'), (() => { const l = setting({ digits: '5550149014' }); delete l.createdAtMs; return l; })()));

  // -- update invariants + delete
  await check('createdAtMs frozen on update (changed = denied)', 'deny', setDoc(ref(carol), setting({ createdAtMs: 1 })));
  await check('update keeping createdAtMs accepted (control)', 'allow', setDoc(ref(carol), setting({ note: 'kept' })));
  await check('company_admin deletes (one-tap reclaim)', 'allow', deleteDoc(ref(carol, '5550149001')));
  await check('solo owner deletes', 'allow', deleteDoc(ref(owner, D2)));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  \u2713 ' : '  \u2717 ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nthursday_handled rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
