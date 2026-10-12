/**
 * Firestore rules — per-number contact labels (2026-10-12).
 *
 *   companies/{companyId}/contact_labels/{digits10}
 *   documentation/projects/CONTACT-ROUTING-TREE-2026-10-12.md
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-labels-test \
 *     'node firestore-rules.contact-labels.test.js'
 *
 * Every deny that is about SHAPE is paired with an allow of the same doc
 * minus the one defect (a positive control), so a rule that denies
 * everything cannot pass. Numbers are 555 fixtures.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-labels-test';
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
function label(over, by) {
  return Object.assign({
    digits: D, kind: 'sub', policy: 'quiet', name: 'Test Sub', note: '', source: 'manual',
    companyId: 'co-a', updatedBy: by || 'carol', updatedAtMs: 1760000000000, createdAtMs: 1760000000000,
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
  const ref = (db, d) => doc(db, 'companies/co-a/contact_labels/' + (d || D));

  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), 'companies/co-a/contact_labels/' + D), label());
  });

  // ── reads ──────────────────────────────────────────────────
  await check('solo owner reads a label', 'allow', getDoc(ref(owner)));
  await check('company_admin reads', 'allow', getDoc(ref(carol)));
  await check('manager reads', 'allow', getDoc(ref(eve)));
  await check('viewer reads (read-only role)', 'allow', getDoc(ref(vic)));
  await check('platform admin reads', 'allow', getDoc(ref(joe)));
  await check('owner lists the collection', 'allow', getDocs(collection(owner, 'companies/co-a/contact_labels')));
  await check('sales_rep does NOT read (never sees teammates numbers)', 'deny', getDoc(ref(alice)));
  await check('sales_rep does NOT list', 'deny', getDocs(collection(alice, 'companies/co-a/contact_labels')));
  await check('other tenant company_admin does NOT read', 'deny', getDoc(ref(bobCA)));
  await check('other tenant solo owner does NOT read', 'deny', getDoc(ref(bobSolo)));
  await check('other tenant does NOT list', 'deny', getDocs(collection(bobCA, 'companies/co-a/contact_labels')));
  await check('anonymous does NOT read', 'deny', getDoc(ref(anon)));

  // ── writes: who ────────────────────────────────────────────
  await check('solo owner creates', 'allow', setDoc(ref(owner, D2), label({ digits: D2 }, 'co-a')));
  await check('company_admin creates', 'allow', setDoc(ref(carol, '5550142224'), label({ digits: '5550142224' }, 'carol')));
  await check('manager creates', 'allow', setDoc(ref(eve, '5550142225'), label({ digits: '5550142225' }, 'eve')));
  await check('manager updates (policy change)', 'allow', setDoc(ref(eve), label({ policy: 'hide', kind: 'spam', updatedBy: 'eve' })));
  await check('viewer CANNOT create', 'deny', setDoc(ref(vic, '5550142226'), label({ digits: '5550142226' }, 'vic')));
  await check('viewer CANNOT update', 'deny', setDoc(ref(vic), label({ policy: 'hide', updatedBy: 'vic' })));
  await check('viewer CANNOT delete', 'deny', deleteDoc(ref(vic)));
  await check('sales_rep CANNOT create', 'deny', setDoc(ref(alice, '5550142227'), label({ digits: '5550142227' }, 'alice')));
  await check('sales_rep CANNOT update', 'deny', setDoc(ref(alice), label({ policy: 'hide', updatedBy: 'alice' })));
  await check('other tenant company_admin CANNOT create in co-a', 'deny', setDoc(ref(bobCA, '5550142228'), label({ digits: '5550142228' }, 'bobca')));
  await check('other tenant company_admin CANNOT update co-a', 'deny', setDoc(ref(bobCA), label({ updatedBy: 'bobca' })));
  await check('other tenant company_admin CANNOT delete co-a', 'deny', deleteDoc(ref(bobCA)));
  await check('other tenant solo CANNOT write into co-a', 'deny', setDoc(ref(bobSolo, '5550142229'), label({ digits: '5550142229' }, 'co-b')));
  // notViewer() matters only where uid == companyId (isCompanyStaff already
  // excludes a viewer): a viewer-role token whose uid IS the tenant key.
  const vSelf = ctx('co-v', { role: 'viewer' });
  const vSelfOwner = ctx('co-v', {});
  const vRef = (db) => doc(db, 'companies/co-v/contact_labels/' + D);
  await check('control: that tenant key owner (no role claim) creates', 'allow', setDoc(vRef(vSelfOwner), label({ companyId: 'co-v' }, 'co-v')));
  await check('viewer role with uid == companyId CANNOT update', 'deny', setDoc(vRef(vSelf), label({ companyId: 'co-v', policy: 'hide' }, 'co-v')));
  await check('viewer role with uid == companyId CANNOT delete', 'deny', deleteDoc(vRef(vSelf)));
  await check('anonymous CANNOT write', 'deny', setDoc(ref(anon, '5550142230'), label({ digits: '5550142230' })));
  await check('writes into ANOTHER tenant path stay in that tenant (co-b solo owns co-b)', 'allow',
    setDoc(doc(bobSolo, 'companies/co-b/contact_labels/' + D), label({ companyId: 'co-b' }, 'co-b')));

  // ── writes: shape (each deny has an allow control) ─────────
  const N = '5550149000';
  const shaped = (over, d) => setDoc(ref(carol, d || N), label(Object.assign({ digits: d || N }, over)));
  await check('control: a valid doc is accepted', 'allow', shaped({}, '5550149001'));
  await check('unknown kind denied', 'deny', shaped({ kind: 'billionaire' }, '5550149002'));
  await check('unknown policy denied', 'deny', shaped({ policy: 'block' }, '5550149003'));
  await check('an extra key denied (no smuggled fields)', 'deny', shaped({ leadId: 'abc' }, '5550149004'));
  await check('digits field must equal the doc id', 'deny', setDoc(ref(carol, '5550149005'), label({ digits: '5550149006' })));
  await check('doc id must be 10 digits (9 denied)', 'deny', setDoc(ref(carol, '555014900'), label({ digits: '555014900' })));
  await check('doc id must be digits only', 'deny', setDoc(ref(carol, '555-014-9007'), label({ digits: '555-014-9007' })));
  await check('companyId must equal the path company', 'deny', shaped({ companyId: 'co-b' }, '5550149008'));
  await check('updatedBy must be the writer', 'deny', shaped({ updatedBy: 'someone-else' }, '5550149009'));
  await check('name over 80 chars denied', 'deny', shaped({ name: 'x'.repeat(81) }, '5550149010'));
  await check('name at 80 chars accepted (control)', 'allow', shaped({ name: 'x'.repeat(80) }, '5550149011'));
  await check('note over 200 chars denied', 'deny', shaped({ note: 'y'.repeat(201) }, '5550149012'));
  await check('ackAtMs (number) accepted — the "Keep hidden" stamp', 'allow', shaped({ ackAtMs: 1760000001000 }, '5550149015'));
  await check('ackAtMs must be a number', 'deny', shaped({ ackAtMs: 'yesterday' }, '5550149016'));
  await check('capture off on a PERSONAL label accepted (stop copying future calls)', 'allow', shaped({ kind: 'personal', policy: 'hide', capture: 'off' }, '5550149017'));
  await check('capture off on a non-personal kind denied', 'deny', shaped({ kind: 'spam', policy: 'hide', capture: 'off' }, '5550149018'));
  await check('capture value other than off denied', 'deny', shaped({ kind: 'personal', policy: 'hide', capture: 'on' }, '5550149019'));
  await check('source pattern accepted (a suggestion from repeated calls)', 'allow', shaped({ source: 'pattern' }, '5550149020'));
  await check('unknown source denied', 'deny', shaped({ source: 'bot' }, '5550149013'));
  await check('missing kind denied', 'deny', setDoc(ref(carol, '5550149014'), (() => { const l = label({ digits: '5550149014' }); delete l.kind; return l; })()));

  // ── contact_suggestions (remembered Not-this dismissals)
  const sref = (db, d, co) => doc(db, 'companies/' + (co || 'co-a') + '/contact_suggestions/' + (d || D));
  const sdoc = (over) => Object.assign({ digits: D, dismissed: [{ kind: 'sub', atMs: 1 }], companyId: 'co-a', updatedBy: 'carol', updatedAtMs: 1760000000000 }, over || {});
  await check('suggestions: company_admin writes a dismissal', 'allow', setDoc(sref(carol), sdoc()));
  await check('suggestions: solo owner writes', 'allow', setDoc(sref(owner), sdoc({ updatedBy: 'co-a' })));
  await check('suggestions: viewer reads', 'allow', getDoc(sref(vic)));
  await check('suggestions: viewer CANNOT write', 'deny', setDoc(sref(vic), sdoc({ updatedBy: 'vic' })));
  await check('suggestions: sales_rep CANNOT read', 'deny', getDoc(sref(alice)));
  await check('suggestions: sales_rep CANNOT write', 'deny', setDoc(sref(alice), sdoc({ updatedBy: 'alice' })));
  await check('suggestions: other tenant CANNOT read', 'deny', getDoc(sref(bobCA)));
  await check('suggestions: other tenant CANNOT write', 'deny', setDoc(sref(bobCA), sdoc({ updatedBy: 'bobca' })));
  await check('suggestions: more than 12 entries denied', 'deny', setDoc(sref(carol, '5550149030'), sdoc({ digits: '5550149030', dismissed: Array.from({ length: 13 }, (_, i) => ({ kind: 'sub', atMs: i })) })));
  await check('suggestions: exactly 12 accepted (control)', 'allow', setDoc(sref(carol, '5550149031'), sdoc({ digits: '5550149031', dismissed: Array.from({ length: 12 }, (_, i) => ({ kind: 'sub', atMs: i })) })));
  await check('suggestions: dismissed must be a list', 'deny', setDoc(sref(carol, '5550149032'), sdoc({ digits: '5550149032', dismissed: 'sub' })));
  await check('suggestions: an extra key denied', 'deny', setDoc(sref(carol, '5550149033'), sdoc({ digits: '5550149033', kind: 'sub' })));
  await check('suggestions: companyId must be the path company', 'deny', setDoc(sref(carol, '5550149034'), sdoc({ digits: '5550149034', companyId: 'co-b' })));
  await check('suggestions: updatedBy must be the writer', 'deny', setDoc(sref(carol, '5550149035'), sdoc({ digits: '5550149035', updatedBy: 'x' })));
  await check('suggestions: digits must match the doc id', 'deny', setDoc(sref(carol, '5550149036'), sdoc({ digits: '5550149037' })));

  // ── update invariants + delete ─────────────────────────────
  await check('createdAtMs frozen on update (changed = denied)', 'deny', setDoc(ref(carol), label({ createdAtMs: 1 })));
  await check('update keeping createdAtMs accepted (control)', 'allow', setDoc(ref(carol), label({ policy: 'surface', kind: 'customer' })));
  await check('company_admin deletes (undo of a first label)', 'allow', deleteDoc(ref(carol, '5550149001')));
  await check('solo owner deletes', 'allow', deleteDoc(ref(owner, D2)));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\ncontact_labels rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
