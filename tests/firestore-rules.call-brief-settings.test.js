/**
 * Firestore rules — Call to Close P1 (2026-11-09): the auto-brief company flag,
 * companies/{companyId}/settings/callBrief = { autoBrief: bool, updatedAt?, updatedBy? }.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.1 (P1
 * auto-brief behind a company flag), §7 (kill switches), §9 P1.
 *
 * Read: the company's own members (and the platform admin): the Call Center
 * shows the switch's state. Write: the owner (solo owner keyed by uid) or a
 * company_admin of THAT company, or the platform admin; never a manager, a
 * sales rep, a viewer or another tenant. Only the doc id `callBrief`, only
 * the three keys, autoBrief a bool, updatedBy the writer. No client delete
 * except by the same writers (absent doc = off).
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-cbsettings-test \
 *     'node firestore-rules.call-brief-settings.test.js'
 *
 * Every deny is paired with an allow (positive controls), so a rule that
 * denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-cbsettings-test';
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
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const owner = ctx('co-a', {});                                             // solo owner: uid == companyId, no role claim
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const bobSolo = ctx('co-b', {});
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, deleteDoc, serverTimestamp } = require('firebase/firestore');
  const S = (db, cid, id) => doc(db, 'companies/' + (cid || 'co-a') + '/settings/' + (id || 'callBrief'));

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'companies/co-a'), { ownerId: 'co-a', name: 'A Roofing' });
    await setDoc(doc(db, 'companies/co-b'), { ownerId: 'co-b', name: 'B Roofing' });
    await setDoc(S(db, 'co-b'), { autoBrief: false });
  });

  // -- writes
  await check('the owner turns auto-brief on', 'allow', setDoc(S(owner), { autoBrief: true, updatedBy: 'co-a', updatedAt: serverTimestamp() }));
  await check('a same-company company_admin turns it off', 'allow', setDoc(S(carol), { autoBrief: false, updatedBy: 'carol', updatedAt: serverTimestamp() }));
  await check('the platform admin writes it', 'allow', setDoc(S(joe), { autoBrief: false, updatedBy: 'joe' }));
  await check('a manager cannot turn it on', 'deny', setDoc(S(eve), { autoBrief: true, updatedBy: 'eve' }));
  await check('a sales rep cannot turn it on', 'deny', setDoc(S(alice), { autoBrief: true, updatedBy: 'alice' }));
  await check('a viewer cannot turn it on', 'deny', setDoc(S(vic), { autoBrief: true, updatedBy: 'vic' }));
  await check('another tenant\'s company_admin cannot touch co-a', 'deny', setDoc(S(bobCA), { autoBrief: true, updatedBy: 'bobca' }));
  await check('another tenant\'s solo owner cannot touch co-a', 'deny', setDoc(S(bobSolo), { autoBrief: true, updatedBy: 'co-b' }));
  await check('…while writing their own company\'s doc (positive control)', 'allow', setDoc(S(bobSolo, 'co-b'), { autoBrief: true, updatedBy: 'co-b' }));
  await check('signed out cannot write', 'deny', setDoc(S(anon), { autoBrief: true }));
  await check('autoBrief must be a bool (not "yes")', 'deny', setDoc(S(owner), { autoBrief: 'yes', updatedBy: 'co-a' }));
  await check('no extra keys (e.g. a cap override)', 'deny', setDoc(S(owner), { autoBrief: true, updatedBy: 'co-a', dayCap: 999 }));
  await check('updatedBy must be the writer', 'deny', setDoc(S(carol), { autoBrief: true, updatedBy: 'co-a' }));
  await check('only the doc id callBrief (a lookalike id is refused)', 'deny', setDoc(S(owner, 'co-a', 'callBriefs'), { autoBrief: true, updatedBy: 'co-a' }));
  await check('the owner writes the real id again (positive control)', 'allow', setDoc(S(owner), { autoBrief: true, updatedBy: 'co-a' }));

  // -- reads
  await check('the owner reads it', 'allow', getDoc(S(owner)));
  await check('a same-company manager reads it', 'allow', getDoc(S(eve)));
  await check('a same-company sales rep reads it', 'allow', getDoc(S(alice)));
  await check('a same-company viewer reads it (a bool, no customer data)', 'allow', getDoc(S(vic)));
  await check('another tenant cannot read it', 'deny', getDoc(S(bobCA)));
  await check('signed out cannot read it', 'deny', getDoc(S(anon)));

  // -- delete (absent = off)
  await check('a manager cannot delete it', 'deny', deleteDoc(S(eve)));
  await check('a company_admin may delete it (absent = off)', 'allow', deleteDoc(S(carol)));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
