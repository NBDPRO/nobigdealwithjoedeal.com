/**
 * Firestore rules — who may soft-delete (and restore) a lead (2026-11-14).
 *
 * "Delete lead" in the CRM is a SOFT delete: an update that sets
 * { deleted: true, deletedAt } (dashboard-bootstrap.module.js _deleteLead,
 * crm-portal-bridge.js bulkDelete); the Deleted bin's Restore clears them
 * (_restoreLead). Before this change the update rule's staff branch let a
 * manager write those fields on any lead in the tenant, so a manager could bin
 * a teammate's lead although the hard-delete rule says only the lead's owner or
 * the tenant owner destroys data. Jo's decision: managers do not delete leads.
 *
 *   softDeleteWriteOk() — setting or clearing deleted / deletedAt / isDeleted /
 *   e2eTestData is limited to the hard-delete rule's writers: the lead's own
 *   non-viewer owner, a company_admin of the lead's tenant, a platform admin;
 *   and `deleted` stays a bool.
 *   _test (the rules-probe flag, which the dashboard loader drops with no way
 *   back) is frozen on update for every role (2026-11-14 security review).
 *
 * RUN (throwaway emulator):
 *   cd tests
 *   firebase emulators:exec --only firestore --project nbd-leaddel-test \
 *     'node firestore-rules.lead-soft-delete.test.js'
 * RULES_PATH=<file> points it at another rules file (used to show it fails on
 * the rules before this change).
 *
 * Every deny is paired with an allow of the same request by an allowed writer,
 * or of the same writer minus the marker (a positive control), so a rule that
 * denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-leaddel-test';
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
  const platform = ctx('pat', { role: 'admin' });
  const otherAdmin = ctx('bob', { role: 'company_admin', companyId: 'co-b' });
  const otherMgr = ctx('mo', { role: 'manager', companyId: 'co-b' });
  const { setDoc, updateDoc, doc, serverTimestamp, deleteField } = require('firebase/firestore');

  const lead = (userId, companyId, extra) => Object.assign({ userId, companyId, firstName: 'Pat', lastName: 'Home', stage: 'new' }, extra || {});
  const ids = {
    repLead: lead('alice', 'co-a'),          // a rep's lead
    repLead2: lead('alice', 'co-a'),
    repLead3: lead('alice', 'co-a'),
    mgrOwn: lead('eve', 'co-a'),             // the manager's own lead
    binned: lead('alice', 'co-a', { deleted: true, deletedAt: new Date('2026-11-01') }),
    binned2: lead('alice', 'co-a', { deleted: true, deletedAt: new Date('2026-11-01') }),
    binned3: lead('alice', 'co-a', { deleted: true, deletedAt: new Date('2026-11-01') }),
    vicLead: lead('vic', 'co-a'),
    soloLead: lead('solo', 'solo'),
    bLead: lead('ray', 'co-b'),
    plain: lead('alice', 'co-a'),            // no deleted field at all
    live: lead('alice', 'co-a', { deleted: false }),
    hide: lead('alice', 'co-a'),
    probe: lead('alice', 'co-a', { _test: true }),
    e2e: lead('alice', 'co-a', { e2eTestData: true }),
  };
  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    for (const [id, data] of Object.entries(ids)) await setDoc(doc(d, 'leads/' + id), data);
  });
  const L = (db, id) => doc(db, 'leads/' + id);
  const binIt = () => ({ deleted: true, deletedAt: serverTimestamp() });
  const restore = () => ({ deleted: false, deletedAt: null });

  // -- the gap: a manager binning a teammate's lead
  await check('a manager cannot soft-delete a teammate\'s lead (deleted + deletedAt)', 'deny', updateDoc(L(mgr, 'repLead'), binIt()));
  await check('a manager cannot set deleted alone', 'deny', updateDoc(L(mgr, 'repLead'), { deleted: true }));
  await check('a manager cannot set deletedAt alone', 'deny', updateDoc(L(mgr, 'repLead'), { deletedAt: serverTimestamp() }));
  await check('a manager cannot set isDeleted (readers honour it)', 'deny', updateDoc(L(mgr, 'repLead'), { isDeleted: true }));
  await check('a manager cannot hide a soft delete inside an ordinary edit', 'deny', updateDoc(L(mgr, 'repLead'), Object.assign({ notes: 'dupe' }, binIt())));
  await check('positive control: the manager still edits that lead', 'allow', updateDoc(L(mgr, 'repLead'), { notes: 'called, no answer', stage: 'contacted' }));
  await check('positive control: a company_admin soft-deletes the same lead', 'allow', updateDoc(L(coAdmin, 'repLead'), binIt()));

  // -- restore is held to the same writers
  await check('a manager cannot restore a teammate\'s lead from the bin', 'deny', updateDoc(L(mgr, 'binned'), restore()));
  await check('a manager cannot clear deletedAt on a binned lead', 'deny', updateDoc(L(mgr, 'binned'), { deletedAt: deleteField() }));
  await check('positive control: the company_admin restores it', 'allow', updateDoc(L(coAdmin, 'binned'), restore()));
  await check('positive control: the lead\'s own rep restores theirs', 'allow', updateDoc(L(rep, 'binned2'), restore()));
  await check('positive control: a platform admin restores one', 'allow', updateDoc(L(platform, 'binned3'), restore()));

  // -- what owners keep (unchanged from before)
  await check('a rep still soft-deletes their own lead', 'allow', updateDoc(L(rep, 'repLead2'), binIt()));
  await check('another rep cannot soft-delete it (not theirs, not staff)', 'deny', updateDoc(L(rep2, 'repLead3'), binIt()));
  await check('a manager still soft-deletes a lead they own', 'allow', updateDoc(L(mgr, 'mgrOwn'), binIt()));
  await check('a solo owner (no claims) soft-deletes their own lead', 'allow', updateDoc(L(solo, 'soloLead'), binIt()));
  await check('a solo owner restores it', 'allow', updateDoc(L(solo, 'soloLead'), restore()));
  await check('a platform admin soft-deletes a tenant lead', 'allow', updateDoc(L(platform, 'repLead3'), binIt()));
  await check('a viewer cannot soft-delete even their own lead', 'deny', updateDoc(L(vic, 'vicLead'), binIt()));

  // -- markers left unchanged never trigger the check (managers' ordinary saves)
  await check('a manager re-sending the SAME deleted value (false) with an edit is allowed', 'allow', updateDoc(L(mgr, 'live'), { notes: 'same', deleted: false }));
  await check('a manager adding deleted:false to a lead that has no deleted field is refused', 'deny', updateDoc(L(mgr, 'plain'), { notes: 'x', deleted: false }));
  await check('positive control: the same edit without deleted is allowed', 'allow', updateDoc(L(mgr, 'plain'), { notes: 'x' }));

  // -- deleted must stay a bool (a string hides the lead from the board and never shows in the bin)
  await check('an owner cannot write deleted: \'yes\'', 'deny', updateDoc(L(rep, 'hide'), { deleted: 'yes' }));
  await check('a company_admin cannot write deleted: 1', 'deny', updateDoc(L(coAdmin, 'hide'), { deleted: 1, deletedAt: serverTimestamp() }));
  await check('positive control: the owner writes deleted: true', 'allow', updateDoc(L(rep, 'hide'), binIt()));

  // -- the hidden-lead flags. _test (the loader drops it, nothing un-hides it):
  //    frozen on update for every role; only a create may carry it.
  //    e2eTestData (agent tools, Home, storm, mission/coach, closes-this-week skip
  //    it): the owner side's, like the soft-delete markers (E2E tags its own leads).
  await check('a manager cannot set _test on a teammate\'s lead', 'deny', updateDoc(L(mgr, 'plain'), { _test: true }));
  await check('positive control: the same manager edit without _test', 'allow', updateDoc(L(mgr, 'plain'), { notes: 'probe-free' }));
  await check('the lead\'s own rep cannot set _test', 'deny', updateDoc(L(rep, 'plain'), { _test: true }));
  await check('a company_admin cannot set _test', 'deny', updateDoc(L(coAdmin, 'plain'), { _test: true }));
  await check('a platform admin cannot set _test from a client', 'deny', updateDoc(L(platform, 'plain'), { _test: true }));
  await check('a manager cannot clear _test on a probe lead', 'deny', updateDoc(L(mgr, 'probe'), { _test: false }));
  await check('a manager cannot set e2eTestData on a teammate\'s lead', 'deny', updateDoc(L(mgr, 'plain'), { e2eTestData: true }));
  await check('a manager cannot clear e2eTestData on a teammate\'s lead', 'deny', updateDoc(L(mgr, 'e2e'), { e2eTestData: false }));
  await check('another rep cannot set e2eTestData on alice\'s lead', 'deny', updateDoc(L(rep2, 'plain'), { e2eTestData: true }));
  await check('positive control: a manager sets it on a lead they own', 'allow', updateDoc(L(mgr, 'mgrOwn'), { e2eTestData: true }));
  await check('positive control: the lead\'s own rep tags it (the E2E post-hoc tag)', 'allow', updateDoc(L(rep, 'plain'), { e2eTestData: true }));
  await check('positive control: a company_admin clears it', 'allow', updateDoc(L(coAdmin, 'plain'), { e2eTestData: false }));
  await check('positive control: an ordinary edit of an e2e lead (flag untouched) is allowed', 'allow', updateDoc(L(rep, 'e2e'), { notes: 'still a test lead' }));
  await check('positive control: a create may still carry _test (the rules probe)', 'allow',
    setDoc(doc(rep, 'leads/newprobe'), { userId: 'alice', companyId: 'co-a', firstName: 'Test', stage: 'New', meter: 'sample', _test: true }));

  // -- tenant isolation (unchanged)
  await check('another tenant\'s company_admin cannot restore (clear the markers on) a co-a lead', 'deny', updateDoc(L(otherAdmin, 'repLead2'), restore()));
  await check('another tenant\'s manager cannot restore (clear the markers on) a co-a lead', 'deny', updateDoc(L(otherMgr, 'mgrOwn'), restore()));
  await check('another tenant\'s company_admin cannot soft-delete a co-a lead', 'deny', updateDoc(L(otherAdmin, 'plain'), binIt()));
  await check('positive control: co-b\'s company_admin soft-deletes a co-b lead', 'allow', updateDoc(L(otherAdmin, 'bLead'), binIt()));
  await check('a manager cannot restore a co-b lead', 'deny', updateDoc(L(mgr, 'bLead'), restore()));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note)));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
