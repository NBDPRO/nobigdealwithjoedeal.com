/**
 * Firestore rules — the company's OWN expiring documents (2026-10-18).
 *
 *   companies/{companyId}/companyDocs/{docId}
 *   docs/pro/js/company-docs-ui.js; alert: functions/company-doc-expiry.js
 *
 * Role decisions: viewer read-only everywhere (2026-09-25); write = solo owner
 * or company_admin only. A sales_rep never reads. Another tenant reads/writes
 * nothing. A file reference may not be a link (no Storage ?token= URL).
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-cdocs-test \
 *     'node firestore-rules.company-docs.test.js'
 *
 * Every shape deny is paired with an allow of the same write minus the one
 * defect (a positive control), so a rule that denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-cdocs-test';
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
  const mike = ctx('mike', { role: 'manager', companyId: 'co-a' });
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const bobOwner = ctx('co-b', {});
  const viewerOwner = ctx('co-v', { role: 'viewer' });                       // uid == companyId but the role is viewer (decision B: read-only even on their own tenant)
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, deleteDoc, serverTimestamp } = require('firebase/firestore');
  const ref = (db, id, co) => doc(db, 'companies/' + (co || 'co-a') + '/companyDocs/' + (id || 'd1'));
  const good = (over) => Object.assign({ type: 'gl_coi', name: 'GL certificate', issuer: 'Sample Insurance Co', expiry: '2027-01-31', notes: 'renews each January', fileRef: 'Drive > Company > Insurance > COI.pdf', active: true }, over || {});

  // -- writes: who
  await check('the solo owner creates a document', 'allow', setDoc(ref(owner, 'o1'), good()));
  await check('a company_admin creates a document', 'allow', setDoc(ref(carol, 'c1'), good({ type: 'license', name: 'Trade license' })));
  await check('a company_admin updates one', 'allow', setDoc(ref(carol, 'c1'), good({ type: 'license', name: 'Trade license', expiry: '2028-01-31' })));
  await check('a manager CANNOT write', 'deny', setDoc(ref(mike, 'm1'), good()));
  await check('a sales rep CANNOT write', 'deny', setDoc(ref(alice, 'a1'), good()));
  await check('a viewer CANNOT write', 'deny', setDoc(ref(vic, 'v1'), good()));
  await check('a viewer CANNOT update an existing one', 'deny', setDoc(ref(vic, 'o1'), good({ expiry: '2030-01-01' })));
  await check('a viewer CANNOT delete', 'deny', deleteDoc(ref(vic, 'o1')));
  await check('a viewer whose uid IS the company id CANNOT write (the only case that isolates notViewer())', 'deny', setDoc(ref(viewerOwner, 'vo1', 'co-v'), good()));
  await check('control: the same company id as a normal owner CAN write', 'allow', setDoc(ref(ctx('co-v', {}), 'vo2', 'co-v'), good()));
  await check('another tenant company_admin CANNOT write into co-a', 'deny', setDoc(ref(bobCA, 'x1'), good()));
  await check('another tenant owner CANNOT write into co-a', 'deny', setDoc(ref(bobOwner, 'x2'), good()));
  await check('anonymous CANNOT write', 'deny', setDoc(ref(anon, 'x3'), good()));
  await check('a platform admin is not a writer here', 'deny', setDoc(ref(joe, 'x4'), good()));
  await check('another tenant writes its own collection (control)', 'allow', setDoc(ref(bobCA, 'b1', 'co-b'), good()));

  // -- reads: who
  await check('the solo owner reads', 'allow', getDoc(ref(owner, 'o1')));
  await check('a company_admin reads', 'allow', getDoc(ref(carol, 'o1')));
  await check('a manager reads', 'allow', getDoc(ref(mike, 'o1')));
  await check('a viewer reads (read-only)', 'allow', getDoc(ref(vic, 'o1')));
  await check('a platform admin reads', 'allow', getDoc(ref(joe, 'o1')));
  await check('a sales rep does NOT read', 'deny', getDoc(ref(alice, 'o1')));
  await check('another tenant company_admin does NOT read', 'deny', getDoc(ref(bobCA, 'o1')));
  await check('another tenant owner does NOT read', 'deny', getDoc(ref(bobOwner, 'o1')));
  await check('anonymous does NOT read', 'deny', getDoc(ref(anon, 'o1')));

  // -- shape (each deny has its allow control above or here)
  await check('control: a document with only the required fields', 'allow', setDoc(ref(owner, 's0'), { type: 'other', name: 'Misc' }));
  await check('an unknown type is denied', 'deny', setDoc(ref(owner, 's1'), good({ type: 'passport' })));
  await check('a missing name is denied', 'deny', setDoc(ref(owner, 's2'), { type: 'gl_coi', expiry: '2027-01-31' }));
  await check('an empty name is denied', 'deny', setDoc(ref(owner, 's3'), good({ name: '' })));
  await check('a name over 80 characters is denied', 'deny', setDoc(ref(owner, 's4'), good({ name: 'x'.repeat(81) })));
  await check('control: a name of exactly 80 characters', 'allow', setDoc(ref(owner, 's5'), good({ name: 'x'.repeat(80) })));
  await check('a malformed expiry is denied', 'deny', setDoc(ref(owner, 's6'), good({ expiry: '01/31/2027' })));
  await check('control: no expiry yet (empty string)', 'allow', setDoc(ref(owner, 's7'), good({ expiry: '' })));
  await check('notes over 1000 characters are denied', 'deny', setDoc(ref(owner, 's8'), good({ notes: 'n'.repeat(1001) })));
  await check('a smuggled field is denied', 'deny', setDoc(ref(owner, 's9'), good({ policyNumber: 'ABC123' })));
  await check('active must be a boolean', 'deny', setDoc(ref(owner, 's10'), good({ active: 'yes' })));
  await check('updatedBy must be the writer', 'deny', setDoc(ref(owner, 's11'), good({ updatedBy: 'someone-else' })));
  await check('control: updatedBy is the writer, with server timestamps', 'allow', setDoc(ref(owner, 's12'), good({ updatedBy: 'co-a', createdAt: serverTimestamp(), updatedAt: serverTimestamp() })));

  // -- the file reference is a pointer, never a link
  await check('a plain-text file reference is allowed', 'allow', setDoc(ref(owner, 'f0'), good({ fileRef: 'Binder, tab 3' })));
  await check('an https link is denied', 'deny', setDoc(ref(owner, 'f1'), good({ fileRef: 'https://example.com/coi.pdf' })));
  await check('a Storage token link is denied', 'deny', setDoc(ref(owner, 'f2'), good({ fileRef: 'photos/coi.pdf?alt=media&token=abc' })));
  await check('a firebasestorage host is denied (any case)', 'deny', setDoc(ref(owner, 'f3'), good({ fileRef: 'FirebaseStorage.googleapis.com/v0/b/x' })));
  await check('a file reference over 300 characters is denied', 'deny', setDoc(ref(owner, 'f4'), good({ fileRef: 'f'.repeat(301) })));

  // -- delete
  await check('a company_admin deletes', 'allow', deleteDoc(ref(carol, 'c1')));
  await check('a manager CANNOT delete', 'deny', deleteDoc(ref(mike, 'o1')));
  await check('another tenant CANNOT delete', 'deny', deleteDoc(ref(bobCA, 'o1')));
  await check('the solo owner deletes', 'allow', deleteDoc(ref(owner, 's0')));

  await env.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), 'companies/co-a/companyDocs/o1'));
    const d = s.data() || {};
    results.push({ label: 'the stored document is exactly what the owner wrote (a denied write changed nothing)', ok: d.expiry === '2027-01-31' && d.name === 'GL certificate', note: JSON.stringify(d) });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\ncompanyDocs rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
