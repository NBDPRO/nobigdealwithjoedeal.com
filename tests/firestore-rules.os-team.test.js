/**
 * Firestore rules — NBD OS P2 "Team" (2026-11-09;
 * documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P2).
 *
 *   leaderboard/{uid}           the leaderboardAggregate rows: { companyId, uid, name, tz,
 *                               dayKey, weekKey, today, week, asOfMs }. Read by the member
 *                               and by anyone whose companyId claim is the row's companyId
 *                               (so a company query must filter on companyId); written by
 *                               NO client: only the Cloud Function (admin SDK).
 *   companyProfile/{cid}.timeZone  the company's IANA zone: a string of at most 64 chars,
 *                               written by the solo owner or a company_admin (the
 *                               existing companyProfile writers), never a rep.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-osteam-test \
 *     'node firestore-rules.os-team.test.js'
 *
 * Every deny is paired with an allow of the same request minus the one defect
 * (a positive control), so a rule that denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-osteam-test';
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
  const owner = ctx('co-a', { role: 'company_admin', companyId: 'co-a' });   // the company-keyed owner
  const solo = ctx('solo', {});                                               // a solo owner: no claims
  const admin = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const rep = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const mgr = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const otherAdmin = ctx('bob', { role: 'company_admin', companyId: 'co-b' });
  const otherRep = ctx('ray', { role: 'sales_rep', companyId: 'co-b' });
  const platform = ctx('pat', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, updateDoc, getDoc, getDocs, deleteDoc, doc, collection, query, where, limit } = require('firebase/firestore');
  const M = { doors: 3, appts: 1, estimates: 1, deals: 0 };
  const row = (uid, co) => ({ companyId: co, uid, name: uid, tz: 'America/New_York', tzSet: true, dayKey: '2026-11-09', weekKey: '2026-11-09', today: M, week: M, asOfMs: 1762700000000 });

  await env.withSecurityRulesDisabled(async (c) => {
    const d = c.firestore();
    await setDoc(doc(d, 'leaderboard/alice'), row('alice', 'co-a'));
    await setDoc(doc(d, 'leaderboard/co-a'), row('co-a', 'co-a'));
    await setDoc(doc(d, 'leaderboard/ray'), row('ray', 'co-b'));
    await setDoc(doc(d, 'leaderboard/solo'), row('solo', 'solo'));
    await setDoc(doc(d, 'companyProfile/co-a'), { businessName: 'A Roofing' });
    await setDoc(doc(d, 'companyProfile/solo'), { businessName: 'Solo Roofing' });
    await setDoc(doc(d, 'companies/co-a'), { ownerId: 'co-a' });
  });
  const lb = (db, id) => doc(db, 'leaderboard/' + id);
  const coQuery = (db, co) => getDocs(query(collection(db, 'leaderboard'), where('companyId', '==', co), limit(50)));

  // -- leaderboard reads
  await check('a rep queries their company\'s rows (companyId == claim)', 'allow', coQuery(rep, 'co-a'));
  await check('a manager queries them', 'allow', coQuery(mgr, 'co-a'));
  await check('a viewer queries them', 'allow', coQuery(vic, 'co-a'));
  await check('the owner queries them', 'allow', coQuery(owner, 'co-a'));
  await check('a company_admin reads one teammate row', 'allow', getDoc(lb(admin, 'alice')));
  await check('a rep reads their own row', 'allow', getDoc(lb(rep, 'alice')));
  await check('a solo owner (no claims) reads their own row', 'allow', getDoc(lb(solo, 'solo')));
  await check('a solo owner cannot read someone else\'s row', 'deny', getDoc(lb(solo, 'alice')));
  await check('another tenant\'s rep cannot query co-a', 'deny', coQuery(otherRep, 'co-a'));
  await check('positive control: that rep queries their own company (co-b)', 'allow', coQuery(otherRep, 'co-b'));
  await check('another tenant\'s admin cannot read a co-a row', 'deny', getDoc(lb(otherAdmin, 'alice')));
  await check('a rep cannot list every row (no companyId filter)', 'deny', getDocs(query(collection(rep, 'leaderboard'), limit(50))));
  await check('signed out cannot read a row', 'deny', getDoc(lb(anon, 'alice')));
  await check('a platform admin reads a row', 'allow', getDoc(lb(platform, 'alice')));

  // -- leaderboard writes: nobody from a client
  await check('a rep cannot write their own row', 'deny', setDoc(lb(rep, 'alice'), row('alice', 'co-a')));
  await check('a rep cannot inflate their own doors', 'deny', updateDoc(lb(rep, 'alice'), { 'today.doors': 999 }));
  await check('the owner cannot write a teammate\'s row', 'deny', setDoc(lb(owner, 'alice'), row('alice', 'co-a')));
  await check('a company_admin cannot create a row', 'deny', setDoc(lb(admin, 'carol'), row('carol', 'co-a')));
  await check('a solo owner cannot write their own row', 'deny', setDoc(lb(solo, 'solo'), row('solo', 'solo')));
  await check('a platform admin cannot write a row from a client either', 'deny', setDoc(lb(platform, 'alice'), row('alice', 'co-a')));
  await check('the owner cannot delete a row', 'deny', deleteDoc(lb(owner, 'alice')));
  await check('signed out cannot write a row', 'deny', setDoc(lb(anon, 'x'), row('x', 'co-a')));

  // -- companyProfile.timeZone
  const cp = (db, id) => doc(db, 'companyProfile/' + (id || 'co-a'));
  await check('a company_admin sets the time zone', 'allow', setDoc(cp(admin), { timeZone: 'America/Chicago' }, { merge: true }));
  await check('the owner updates it', 'allow', updateDoc(cp(owner), { timeZone: 'America/Denver' }));
  await check('a solo owner sets their own', 'allow', setDoc(cp(solo, 'solo'), { timeZone: 'America/Phoenix' }, { merge: true }));
  await check('64 chars is the most', 'allow', updateDoc(cp(admin), { timeZone: 'A'.repeat(64) }));
  await check('65 chars is too long', 'deny', updateDoc(cp(admin), { timeZone: 'A'.repeat(65) }));
  await check('a number is not a zone', 'deny', updateDoc(cp(admin), { timeZone: -5 }));
  await check('null is not a zone', 'deny', updateDoc(cp(admin), { timeZone: null }));
  await check('a map is not a zone', 'deny', updateDoc(cp(admin), { timeZone: { tz: 'America/Chicago' } }));
  await check('positive control: the same update with a string', 'allow', updateDoc(cp(admin), { timeZone: 'America/New_York' }));
  await check('the lowercase timezone (kept in step) is written alongside', 'allow', updateDoc(cp(admin), { timeZone: 'America/Chicago', timezone: 'America/Chicago' }));
  await check('a doc created with a time zone', 'allow', setDoc(cp(otherAdmin, 'co-b'), { businessName: 'B', timeZone: 'America/Chicago' }));
  await check('a doc created with a 65-char zone', 'deny', setDoc(cp(platform, 'co-c'), { timeZone: 'A'.repeat(65) }));
  await check('positive control: that create with a short zone', 'allow', setDoc(cp(platform, 'co-c'), { timeZone: 'UTC' }));
  await check('a rep cannot set the time zone', 'deny', updateDoc(cp(rep), { timeZone: 'America/Chicago' }));
  await check('a manager cannot set the time zone', 'deny', updateDoc(cp(mgr), { timeZone: 'America/Chicago' }));
  await check('a viewer cannot set the time zone', 'deny', updateDoc(cp(vic), { timeZone: 'America/Chicago' }));
  await check('another tenant\'s admin cannot set co-a\'s', 'deny', updateDoc(cp(otherAdmin), { timeZone: 'America/Chicago' }));
  await check('the whole company reads it (a rep)', 'allow', getDoc(cp(rep)));
  await check('an unrelated profile edit still saves with the zone on the doc', 'allow', updateDoc(cp(admin), { businessName: 'A Roofing LLC' }));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note)));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  process.exit(bad.length ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
