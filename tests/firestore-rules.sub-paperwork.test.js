/**
 * Firestore rules — the Sub paperwork tracker (2026-10-19, flag subPaperwork).
 *
 *   companies/{companyId}/subs/{subId}               new optional paperwork fields
 *   companies/{companyId}/subs/{subId}/papers/{id}   pointers to private W-9 / COI files
 *   docs/pro/js/sub-paperwork.js; files: storage.rules sub-papers/
 *
 * Decisions: write = the solo owner or company_admin only; a viewer is read-only
 * on the sub (statuses) and sees NO paper pointers; a sales_rep and a manager
 * never read the papers; another tenant reads and writes nothing; no tax ID is
 * ever stored (key names and free text both refused); a paper path is never a
 * link and must sit under this company's and this sub's own folder.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-subpaper-test \
 *     'node firestore-rules.sub-paperwork.test.js'
 *
 * Every deny is paired with an allow of the same write minus the one defect (a
 * positive control), so a rule that denies everything cannot pass. RULES_PATH
 * points the suite at a mutated copy of firestore.rules (the mutation check).
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-subpaper-test';
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
  const viewerOwner = ctx('co-v', { role: 'viewer' });                       // uid == companyId but viewer: read-only even on their own tenant
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const bobOwner = ctx('co-b', {});
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, getDocs, collection, deleteDoc, serverTimestamp, Timestamp } = require('firebase/firestore');
  const sub = (db, id, co) => doc(db, 'companies/' + (co || 'co-a') + '/subs/' + (id || 's1'));
  const paper = (db, id, co, sid) => doc(db, 'companies/' + (co || 'co-a') + '/subs/' + (sid || 's1') + '/papers/' + (id || 'p1'));
  const goodSub = (over) => Object.assign({
    name: 'CA Roofing', phone: '5135550100', trade: 'Roofing', active: true, aliases: ['CA Roofing (Alex)'],
    legalName: 'CA Roofing LLC', entityType: 'LLC', w9Status: 'on_file', w9ReceivedOn: '2026-10-19',
    glExpiry: '2027-03-01', wcExpiry: '2027-03-01', wcExempt: false, licenseRequired: false,
    paperworkNote: 'Alex has his own helpers; they are on his policy.', paperworkReviewedAt: '2026-10-19',
  }, over || {});
  const goodPaper = (over) => Object.assign({ kind: 'w9', storagePath: 'sub-papers/co-a/s1/1760000000_w9.pdf', fileName: 'w9.pdf', uploadedBy: 'co-a', uploadedAt: serverTimestamp() }, over || {});

  // -- the roster doc: who writes
  await check('the solo owner writes a sub with the paperwork fields', 'allow', setDoc(sub(owner), goodSub()));
  await check('a company_admin writes a sub with the paperwork fields', 'allow', setDoc(sub(carol, 's2'), goodSub({ name: 'Bravo Gutters' })));
  await check('a manager CANNOT create a sub that carries paperwork fields', 'deny', setDoc(sub(mike, 'm1'), goodSub()));
  await check('control: a manager still adds a plain roster sub (no paperwork fields)', 'allow', setDoc(sub(mike, 'm2'), { name: 'Plain Crew', trade: 'Roofing', active: true }));
  await check('a manager CANNOT change a paperwork field on an existing sub', 'deny', setDoc(sub(mike, 's1'), goodSub({ w9Status: 'none' })));
  await check('a manager CANNOT add a paperwork field to a plain sub', 'deny', setDoc(sub(mike, 'm2'), { name: 'Plain Crew', trade: 'Roofing', active: true, glExpiry: '2027-01-01' }, { merge: true }));
  await check('control: a manager edits the phone and leaves the paperwork fields alone', 'allow', setDoc(sub(mike, 's1'), goodSub({ phone: '5135550199' })));
  await check('a sales rep CANNOT write a sub', 'deny', setDoc(sub(alice, 'a1'), goodSub()));
  await check('a viewer CANNOT write a sub', 'deny', setDoc(sub(vic, 'v1'), goodSub()));
  await check('a viewer whose uid IS the company id CANNOT write a sub (isolates notViewer())', 'deny', setDoc(sub(viewerOwner, 'vo1', 'co-v'), goodSub()));
  await check('control: the same company id as a normal owner CAN', 'allow', setDoc(sub(ctx('co-v', {}), 'vo2', 'co-v'), goodSub()));
  await check('another tenant CANNOT write into co-a', 'deny', setDoc(sub(bobCA, 'x1'), goodSub()));
  await check('anonymous CANNOT write', 'deny', setDoc(sub(anon, 'x2'), goodSub()));
  await check('control: a sub with none of the new fields still saves (old writers)', 'allow', setDoc(sub(owner, 'old1'), { name: 'Old Crew', trade: 'Roofing', active: true, insuranceExpiry: '2027-01-01' }));

  // -- the roster doc: reads (unchanged by this feature, pinned so a change is seen)
  await check('a viewer reads the sub (statuses)', 'allow', getDoc(sub(vic)));
  await check('another tenant CANNOT read the sub', 'deny', getDoc(sub(bobCA)));

  // -- shape: each deny has the allow control above
  await check('an unknown W-9 status is denied', 'deny', setDoc(sub(owner, 'sh1'), goodSub({ w9Status: 'maybe' })));
  await check('control: each W-9 status is allowed', 'allow', Promise.all(['none', 'requested', 'on_file'].map((s, i) => setDoc(sub(owner, 'sh2' + i), goodSub({ w9Status: s })))));
  await check('a malformed liability end date is denied', 'deny', setDoc(sub(owner, 'sh3'), goodSub({ glExpiry: '03/01/2027' })));
  await check('a malformed workers comp end date is denied', 'deny', setDoc(sub(owner, 'sh4'), goodSub({ wcExpiry: 'next year' })));
  await check('a malformed W-9 received date is denied', 'deny', setDoc(sub(owner, 'sh5'), goodSub({ w9ReceivedOn: '2026-13-45x' })));
  await check('control: empty and null dates are allowed (not set yet)', 'allow', setDoc(sub(owner, 'sh6'), goodSub({ glExpiry: '', wcExpiry: null, licenseExpiry: '' })));
  await check('wcExempt must be a boolean', 'deny', setDoc(sub(owner, 'sh7'), goodSub({ wcExempt: 'yes' })));
  await check('licenseRequired must be a boolean', 'deny', setDoc(sub(owner, 'sh8'), goodSub({ licenseRequired: 1 })));
  await check('a legal name over 120 characters is denied', 'deny', setDoc(sub(owner, 'sh9'), goodSub({ legalName: 'x'.repeat(121) })));
  await check('control: a legal name of exactly 120 characters', 'allow', setDoc(sub(owner, 'sh10'), goodSub({ legalName: 'x'.repeat(120) })));
  await check('a paperwork note over 500 characters is denied', 'deny', setDoc(sub(owner, 'sh11'), goodSub({ paperworkNote: 'n'.repeat(501) })));
  await check('the legacy insuranceExpiry is still validated', 'deny', setDoc(sub(owner, 'sh12'), goodSub({ insuranceExpiry: 'soon' })));

  // -- no tax ID, ever
  await check('a key named ssn is denied', 'deny', setDoc(sub(owner, 't1'), goodSub({ ssn: '123456789' })));
  await check('a key named ein is denied', 'deny', setDoc(sub(owner, 't2'), goodSub({ ein: '12-3456789' })));
  await check('a key named taxId is denied', 'deny', setDoc(sub(owner, 't3'), goodSub({ taxId: 'x' })));
  await check('a key named w9Last4 is denied (no part of a tax ID is stored)', 'deny', setDoc(sub(owner, 't4'), goodSub({ w9Last4: '1234' })));
  await check('control: the same sub without a tax-ID key', 'allow', setDoc(sub(owner, 't5'), goodSub()));
  await check('an SSN typed into the note is denied', 'deny', setDoc(sub(owner, 't6'), goodSub({ paperworkNote: 'ssn 123-45-6789' })));
  await check('an EIN typed into the legal name is denied', 'deny', setDoc(sub(owner, 't7'), goodSub({ legalName: 'CA Roofing 12-3456789' })));
  await check('nine digits in a row in a note are denied', 'deny', setDoc(sub(owner, 't8'), goodSub({ licenseNote: 'tin: 123456789' })));
  await check('a tax ID after a newline is still denied', 'deny', setDoc(sub(owner, 't9'), goodSub({ paperworkNote: 'hello\n123456789' })));
  await check('control: a 10-digit phone number in a note is fine', 'allow', setDoc(sub(owner, 't10'), goodSub({ paperworkNote: 'call 5135550100 after 5' })));
  await check('a tax ID with spaces between the groups is denied', 'deny', setDoc(sub(owner, 't11'), goodSub({ paperworkNote: 'ssn 123 45 6789' })));
  await check('a tax ID with dots between the groups is denied', 'deny', setDoc(sub(owner, 't12'), goodSub({ paperworkNote: '123.45.6789' })));
  await check('an EIN with a space is denied', 'deny', setDoc(sub(owner, 't13'), goodSub({ licenseNote: '12 3456789' })));
  await check('control: a dashed phone number and a ZIP+4 are fine', 'allow', setDoc(sub(owner, 't14'), goodSub({ paperworkNote: 'call 513-555-0100, 45202-1234' })));
  await check('an SSN pasted into the OLD notes field is denied too', 'deny', setDoc(sub(owner, 't15'), goodSub({ notes: 'ssn 123-45-6789' })));
  await check('control: ordinary old notes still save', 'allow', setDoc(sub(owner, 't16'), goodSub({ notes: 'Does metal and shingle. Call after 5.' })));
  await check('upper-case SSN key is denied', 'deny', setDoc(sub(owner, 't17'), goodSub({ SSN: 'x' })));
  await check('taxIdNumber key is denied', 'deny', setDoc(sub(owner, 't18'), goodSub({ taxIdNumber: 'x' })));
  await check('ssn_last4 key is denied', 'deny', setDoc(sub(owner, 't19'), goodSub({ ssn_last4: '6789' })));

  // -- a planted id field (a client spreading doc data over the doc id could be pointed at another sub)
  await check('a sub doc with an id field is denied (create, even for the owner)', 'deny', setDoc(sub(owner, 'id1'), goodSub({ id: 's1' })));
  await check('a manager planting an id on their own sub is denied', 'deny', setDoc(sub(mike, 'id2'), { name: 'Plain Crew', active: true, id: 's1' }));
  await check('adding an id field to an existing sub is denied', 'deny', setDoc(sub(owner, 's1'), { id: 'other' }, { merge: true }));
  await check('control: a merge that touches only the phone', 'allow', setDoc(sub(owner, 's1'), { phone: '5135550123' }, { merge: true }));

  // -- who is staff (a role-less token with a companyId is nobody)
  await check('a token with a companyId but no role CANNOT write a sub', 'deny', setDoc(sub(ctx('norole', { companyId: 'co-a' }), 'nr1'), goodSub()));
  await check('a token with a companyId but no role does NOT read a paper', 'deny', getDoc(paper(ctx('norole', { companyId: 'co-a' }))));
  // -- pinned, on purpose: the older insuranceExpiry is a roster field the Production screen edits (a manager may)
  await check('PIN: a manager may still edit the older insuranceExpiry (Production roster)', 'allow', setDoc(sub(mike, 's1'), goodSub({ insuranceExpiry: '2027-03-01' })));

  // -- papers: who reads
  await check('the solo owner adds a paper', 'allow', setDoc(paper(owner), goodPaper()));
  await check('a company_admin adds a paper', 'allow', setDoc(paper(carol, 'p2'), goodPaper({ uploadedBy: 'carol', kind: 'gl_coi', storagePath: 'sub-papers/co-a/s1/2_gl.jpg' })));
  await check('the solo owner reads a paper', 'allow', getDoc(paper(owner)));
  await check('a company_admin reads a paper', 'allow', getDoc(paper(carol)));
  await check('a viewer does NOT read a paper', 'deny', getDoc(paper(vic)));
  await check('a viewer does NOT list papers', 'deny', getDocs(collection(vic, 'companies/co-a/subs/s1/papers')));
  await check('a manager does NOT read a paper', 'deny', getDoc(paper(mike)));
  await check('a sales rep does NOT read a paper', 'deny', getDoc(paper(alice)));
  await check('a platform admin does NOT read a paper', 'deny', getDoc(paper(joe)));
  await check('another tenant company_admin does NOT read a paper', 'deny', getDoc(paper(bobCA)));
  await check('another tenant owner does NOT read a paper', 'deny', getDoc(paper(bobOwner)));
  await check('anonymous does NOT read a paper', 'deny', getDoc(paper(anon)));
  await check('a viewer whose uid IS the company id does NOT read a paper', 'deny', getDoc(paper(viewerOwner, 'p1', 'co-v')));

  // -- papers: who writes
  await check('a viewer CANNOT add a paper', 'deny', setDoc(paper(vic, 'w1'), goodPaper({ uploadedBy: 'vic' })));
  await check('a manager CANNOT add a paper', 'deny', setDoc(paper(mike, 'w2'), goodPaper({ uploadedBy: 'mike' })));
  await check('a sales rep CANNOT add a paper', 'deny', setDoc(paper(alice, 'w3'), goodPaper({ uploadedBy: 'alice' })));
  await check('another tenant CANNOT add a paper into co-a', 'deny', setDoc(paper(bobCA, 'w4'), goodPaper({ uploadedBy: 'bobca' })));
  await check('a paper cannot be edited in place (immutable)', 'deny', setDoc(paper(owner), goodPaper({ kind: 'other' })));
  await check('a viewer CANNOT delete a paper', 'deny', deleteDoc(paper(vic)));
  await check('another tenant CANNOT delete a paper', 'deny', deleteDoc(paper(bobCA)));

  // -- papers: shape (pointer only)
  await check('control: a minimal paper (kind, path, uploader)', 'allow', setDoc(paper(owner, 'sp0'), { kind: 'license', storagePath: 'sub-papers/co-a/s1/lic.pdf', uploadedBy: 'co-a' }));
  await check('an https link is never a path', 'deny', setDoc(paper(owner, 'sp1'), goodPaper({ storagePath: 'https://firebasestorage.googleapis.com/v0/b/x/o/a.pdf?alt=media&token=abc' })));
  await check('a path with a token query is denied', 'deny', setDoc(paper(owner, 'sp2'), goodPaper({ storagePath: 'sub-papers/co-a/s1/a.pdf?token=abc' })));
  await check('a path in ANOTHER company folder is denied', 'deny', setDoc(paper(owner, 'sp3'), goodPaper({ storagePath: 'sub-papers/co-b/s1/a.pdf' })));
  await check('a path in ANOTHER sub folder is denied', 'deny', setDoc(paper(owner, 'sp4'), goodPaper({ storagePath: 'sub-papers/co-a/other/a.pdf' })));
  await check('a path outside sub-papers/ is denied', 'deny', setDoc(paper(owner, 'sp5'), goodPaper({ storagePath: 'receipts/co-a/a.pdf' })));
  await check('a path with .. is denied', 'deny', setDoc(paper(owner, 'sp6'), goodPaper({ storagePath: 'sub-papers/co-a/s1/..' })));
  await check('an unknown kind is denied', 'deny', setDoc(paper(owner, 'sp7'), goodPaper({ kind: 'passport' })));
  await check('a smuggled field (a tax id) is denied', 'deny', setDoc(paper(owner, 'sp8'), goodPaper({ ein: '12-3456789' })));
  await check('a smuggled download URL field is denied', 'deny', setDoc(paper(owner, 'sp9'), goodPaper({ downloadUrl: 'https://x/y?token=1' })));
  await check('uploadedBy must be the writer', 'deny', setDoc(paper(owner, 'sp10'), goodPaper({ uploadedBy: 'someone-else' })));
  await check('a missing path is denied', 'deny', setDoc(paper(owner, 'sp11'), { kind: 'w9', uploadedBy: 'co-a' }));
  await check('a file name over 120 characters is denied', 'deny', setDoc(paper(owner, 'sp12'), goodPaper({ fileName: 'f'.repeat(121) })));
  await check('uploadedAt must be a timestamp', 'deny', setDoc(paper(owner, 'sp13'), goodPaper({ uploadedAt: 'yesterday' })));
  await check('control: a real Timestamp for uploadedAt', 'allow', setDoc(paper(owner, 'sp14'), goodPaper({ uploadedAt: Timestamp.now() })));
  await check('a paper cannot be changed by a merge either', 'deny', setDoc(paper(owner, 'sp14'), { kind: 'other' }, { merge: true }));
  await check('the owner deletes a paper', 'allow', deleteDoc(paper(owner, 'sp0')));

  await env.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), 'companies/co-a/subs/s1'));
    const d = s.data() || {};
    results.push({ label: 'the stored sub is exactly what the owner wrote (denied writes changed nothing)', ok: d.glExpiry === '2027-03-01' && d.ssn === undefined && d.legalName === 'CA Roofing LLC', note: JSON.stringify(d) });
  });

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : '  >>> ' + r.note)));
  console.log('\nsub-paperwork rules: ' + (results.length - bad.length) + '/' + results.length + ' passed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
