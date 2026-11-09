/**
 * Firestore rules — Call to Close P0 (2026-11-09): leads/{leadId}/call_briefs/{callId}.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.2.
 *
 * Read = exactly callCenterAction's audience, read off the CALL
 * (phone_calls/{callId} via get()): the call's owner, a platform admin, or a
 * same-company company_admin / manager. Never a viewer (briefs copy
 * transcript quotes), never a sales rep who does not own the call, never
 * another tenant. And only while the call is still filed on THIS lead (a
 * moved call's brief is deleted by the server; the rule refuses it anyway).
 * Write: never from a client (callBrief / callBriefDecide write it).
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-callbrief-test \
 *     'node firestore-rules.call-briefs.test.js'
 *
 * Every deny is paired with an allow (positive controls), so a rule that
 * denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-callbrief-test';
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

const CALL = 'cube_RULES00001';
const CALL_REP = 'cube_RULES00002';
const CALL_MOVED = 'cube_RULES00003';

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const owner = ctx('co-a', {});                                            // solo owner: uid == companyId, no role claim
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const eve = ctx('eve', { role: 'manager', companyId: 'co-a' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const vicOwner = ctx('vico', { role: 'viewer', companyId: 'co-a' });      // a viewer who owns a call
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });    // works the lead, does not own the call
  const aliceOwner = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' }); // other tenant, strongest role
  const bobSolo = ctx('co-b', {});
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, getDocs, collection, deleteDoc, updateDoc } = require('firebase/firestore');
  const brief = (db, lead, call) => doc(db, 'leads/' + (lead || 'L1') + '/call_briefs/' + (call || CALL));
  const BRIEF = { callId: CALL, leadId: 'L1', companyId: 'co-a', userId: 'co-a', v: 1, brief: { summary: { text: 'Hail leak.' } }, decisions: [] };

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'leads/L1'), { userId: 'alice', companyId: 'co-a', firstName: 'Pat' });
    await setDoc(doc(db, 'leads/L2'), { userId: 'co-a', companyId: 'co-a', firstName: 'Sam' });
    await setDoc(doc(db, 'phone_calls/' + CALL), { userId: 'co-a', companyId: 'co-a', leadId: 'L1', status: 'noted' });
    await setDoc(doc(db, 'phone_calls/' + CALL_REP), { userId: 'alice', companyId: 'co-a', leadId: 'L1', status: 'noted' });
    await setDoc(doc(db, 'phone_calls/' + CALL_MOVED), { userId: 'co-a', companyId: 'co-a', leadId: 'L2', status: 'noted' });
    await setDoc(brief(db), BRIEF);
    await setDoc(brief(db, 'L1', CALL_REP), Object.assign({}, BRIEF, { callId: CALL_REP, userId: 'alice' }));
    await setDoc(brief(db, 'L1', CALL_MOVED), Object.assign({}, BRIEF, { callId: CALL_MOVED }));
    await setDoc(doc(db, 'phone_calls/cube_VIEWEROWN1'), { userId: 'vico', companyId: 'co-a', leadId: 'L1', status: 'noted' });
    await setDoc(brief(db, 'L1', 'cube_VIEWEROWN1'), Object.assign({}, BRIEF, { callId: 'cube_VIEWEROWN1', userId: 'vico' }));
  });

  // -- reads: the callCenterAction set
  await check('the call\'s owner (solo, no role claim) reads the brief', 'allow', getDoc(brief(owner)));
  await check('a same-company company_admin reads', 'allow', getDoc(brief(carol)));
  await check('a same-company manager reads', 'allow', getDoc(brief(eve)));
  await check('a platform admin reads', 'allow', getDoc(brief(joe)));
  await check('a viewer does NOT read (briefs copy transcript quotes)', 'deny', getDoc(brief(vic)));
  await check('a viewer who owns the call does NOT read either', 'deny', getDoc(brief(vicOwner, 'L1', 'cube_VIEWEROWN1')));
  await check('a sales rep who owns the LEAD but not the call does NOT read', 'deny', getDoc(brief(alice)));
  await check('a sales rep who owns the CALL reads its brief (the callCenterAction owner branch)', 'allow', getDoc(brief(aliceOwner, 'L1', CALL_REP)));
  await check('another tenant\'s company_admin does NOT read', 'deny', getDoc(brief(bobCA)));
  await check('another tenant\'s solo owner does NOT read', 'deny', getDoc(brief(bobSolo)));
  await check('signed out does NOT read', 'deny', getDoc(brief(anon)));
  await check('a brief left on a lead the call is no longer filed on is NOT readable, even by the owner', 'deny', getDoc(brief(owner, 'L1', CALL_MOVED)));
  await check('a brief whose call does not exist is NOT readable', 'deny', getDoc(brief(owner, 'L1', 'cube_NOSUCHCALL')));
  await check('the owner reads it by its id path again (positive control next to the list deny)', 'allow', getDoc(brief(owner, 'L1', CALL)));
  await check('a viewer cannot list the collection', 'deny', getDocs(collection(vic, 'leads/L1/call_briefs')));

  // -- writes: never from a client
  await check('the owner cannot create a brief', 'deny', setDoc(brief(owner, 'L2', 'cube_NEWBRIEF01'), BRIEF));
  await check('the owner cannot edit a brief (e.g. forge a decision)', 'deny', updateDoc(brief(owner), { decisions: [{ item: 'field:claimNumber', decision: 'accept' }] }));
  await check('a company_admin cannot edit a brief', 'deny', updateDoc(brief(carol), { 'brief.summary.text': 'forged' }));
  await check('a platform admin cannot write from a client either', 'deny', setDoc(brief(joe), BRIEF));
  await check('the owner cannot delete a brief', 'deny', deleteDoc(brief(owner)));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
