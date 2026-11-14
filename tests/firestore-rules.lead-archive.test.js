/**
 * Firestore rules — archiving a lead (2026-11-14).
 *
 * Jo: managers no longer delete leads (firestore-rules.lead-soft-delete.test.js),
 * so they ARCHIVE instead. leads/{id}.archived (bool) + archivedAt + archivedBy:
 *
 *   - writable by the lead's owner (not a viewer), or a manager / company_admin
 *     of the lead's company (the leads update rule's existing writers), never a
 *     viewer and never another tenant;
 *   - archiveWriteOk() checks the shape whenever any of the three change:
 *     archived is a bool; archiving stamps archivedBy == the caller and
 *     archivedAt == request.time; un-archiving clears both to null.
 *
 * Before this, nothing in the rules named `archived`: any writer could set any
 * value, with no screen to see it and no way back (2026-11-14 review).
 *
 * RUN (throwaway emulator):
 *   cd tests
 *   firebase emulators:exec --only firestore --project nbd-leadarch-test \
 *     'node firestore-rules.lead-archive.test.js'
 * RULES_PATH=<file> points it at another rules file.
 *
 * Every deny is paired with an allow of the same request by an allowed writer,
 * or of the same writer with the defect removed (a positive control).
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-leadarch-test';
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
  const coAdmin = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const mgr = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const rep = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const rep2 = ctx('rick', { role: 'sales_rep', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const solo = ctx('solo', {});
  const otherAdmin = ctx('bob', { role: 'company_admin', companyId: 'co-b' });
  const otherMgr = ctx('mo', { role: 'manager', companyId: 'co-b' });
  const { setDoc, updateDoc, doc, serverTimestamp } = require('firebase/firestore');

  const lead = (userId, companyId, extra) => Object.assign({ userId, companyId, firstName: 'Pat', lastName: 'Home', stage: 'new' }, extra || {});
  const archivedBy = (uid) => ({ archived: true, archivedAt: new Date('2026-11-01'), archivedBy: uid });
  const ids = {
    a1: lead('alice', 'co-a'), a2: lead('alice', 'co-a'), a3: lead('alice', 'co-a'), a4: lead('alice', 'co-a'),
    a5: lead('alice', 'co-a'), a6: lead('alice', 'co-a'), a7: lead('alice', 'co-a'), a8: lead('alice', 'co-a'),
    vicLead: lead('vic', 'co-a'),
    soloLead: lead('solo', 'solo'),
    bLead: lead('ray', 'co-b'),
    arch1: lead('alice', 'co-a', archivedBy('eve')), arch2: lead('alice', 'co-a', archivedBy('eve')),
    arch3: lead('alice', 'co-a', archivedBy('eve')), arch4: lead('alice', 'co-a', archivedBy('eve')),
    arch5: lead('alice', 'co-a', archivedBy('eve')), archV: lead('vic', 'co-a', archivedBy('vic')),
    archB: lead('ray', 'co-b', archivedBy('mo')),
  };
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    for (const [id, data] of Object.entries(ids)) await setDoc(doc(d, 'leads/' + id), data);
  });
  const L = (db, id) => doc(db, 'leads/' + id);
  const arch = (uid) => ({ archived: true, archivedAt: serverTimestamp(), archivedBy: uid });
  const unarch = () => ({ archived: false, archivedAt: null, archivedBy: null });

  // -- who may archive
  await check('a manager archives a teammate\'s lead', 'allow', updateDoc(L(mgr, 'a1'), arch('eve')));
  await check('a company_admin archives a tenant lead', 'allow', updateDoc(L(coAdmin, 'a2'), arch('carol')));
  await check('the lead\'s own rep archives it', 'allow', updateDoc(L(rep, 'a3'), arch('alice')));
  await check('a solo owner archives their own lead', 'allow', updateDoc(L(solo, 'soloLead'), arch('solo')));
  await check('another rep cannot archive alice\'s lead', 'deny', updateDoc(L(rep2, 'a4'), arch('rick')));
  await check('a viewer cannot archive, even their own lead', 'deny', updateDoc(L(vic, 'vicLead'), arch('vic')));
  await check('another tenant\'s manager cannot archive a co-a lead', 'deny', updateDoc(L(otherMgr, 'a4'), arch('mo')));
  await check('another tenant\'s company_admin cannot archive a co-a lead', 'deny', updateDoc(L(otherAdmin, 'a4'), arch('bob')));
  await check('a co-a manager cannot archive a co-b lead', 'deny', updateDoc(L(mgr, 'bLead'), arch('eve')));
  await check('positive control: co-b\'s manager archives a co-b lead', 'allow', updateDoc(L(otherMgr, 'bLead'), arch('mo')));

  // -- the shape when archiving
  await check('archivedBy must be the caller', 'deny', updateDoc(L(mgr, 'a5'), { archived: true, archivedAt: serverTimestamp(), archivedBy: 'alice' }));
  await check('archivedAt must be request.time (no backdating)', 'deny', updateDoc(L(mgr, 'a5'), { archived: true, archivedAt: new Date('2026-01-01'), archivedBy: 'eve' }));
  await check('archiving needs archivedAt', 'deny', updateDoc(L(mgr, 'a5'), { archived: true, archivedBy: 'eve' }));
  await check('archiving needs archivedBy', 'deny', updateDoc(L(mgr, 'a5'), { archived: true, archivedAt: serverTimestamp() }));
  await check('archived must be a bool (\'yes\')', 'deny', updateDoc(L(mgr, 'a5'), { archived: 'yes', archivedAt: serverTimestamp(), archivedBy: 'eve' }));
  await check('archived must be a bool (1)', 'deny', updateDoc(L(mgr, 'a5'), { archived: 1, archivedAt: serverTimestamp(), archivedBy: 'eve' }));
  await check('archivedBy alone (no archived flag) is refused', 'deny', updateDoc(L(mgr, 'a6'), { archivedBy: 'eve' }));
  await check('archivedAt alone is refused', 'deny', updateDoc(L(mgr, 'a6'), { archivedAt: serverTimestamp() }));
  await check('positive control: the same manager archives it properly', 'allow', updateDoc(L(mgr, 'a5'), arch('eve')));

  // -- un-archive
  await check('a manager un-archives a teammate\'s lead', 'allow', updateDoc(L(mgr, 'arch1'), unarch()));
  await check('the lead\'s own rep un-archives it', 'allow', updateDoc(L(rep, 'arch2'), unarch()));
  await check('a company_admin un-archives it', 'allow', updateDoc(L(coAdmin, 'arch3'), unarch()));
  await check('un-archiving must clear archivedBy', 'deny', updateDoc(L(mgr, 'arch4'), { archived: false, archivedAt: null }));
  await check('un-archiving must clear archivedAt', 'deny', updateDoc(L(mgr, 'arch4'), { archived: false, archivedBy: null }));
  await check('un-archiving cannot leave a forged archivedBy', 'deny', updateDoc(L(mgr, 'arch4'), { archived: false, archivedAt: null, archivedBy: 'alice' }));
  await check('positive control: the full un-archive on that lead', 'allow', updateDoc(L(mgr, 'arch4'), unarch()));
  await check('a viewer cannot un-archive, even their own lead', 'deny', updateDoc(L(vic, 'archV'), unarch()));
  await check('another rep cannot un-archive alice\'s lead', 'deny', updateDoc(L(rep2, 'arch5'), unarch()));
  await check('a co-a manager cannot un-archive a co-b lead', 'deny', updateDoc(L(mgr, 'archB'), unarch()));

  // -- re-archiving and ordinary edits
  await check('a manager re-archives (stamping themselves) an archived lead', 'allow', updateDoc(L(mgr, 'arch5'), arch('eve')));
  await check('an ordinary edit of an archived lead (flags untouched) is allowed', 'allow', updateDoc(L(rep, 'arch2'), { notes: 'still archived? no, restored above' }));
  await check('an ordinary edit with the same archived:false is allowed', 'allow', updateDoc(L(mgr, 'arch1'), { notes: 'x', archived: false }));
  await check('a manager can no longer delete, but archiving is not deleting: deleted stays put', 'deny', updateDoc(L(mgr, 'a7'), Object.assign(arch('eve'), { deleted: true })));
  await check('positive control: that archive without the delete', 'allow', updateDoc(L(mgr, 'a7'), arch('eve')));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note)));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
