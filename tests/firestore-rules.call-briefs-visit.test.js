/**
 * Firestore rules — Call to Close P2 (2026-11-09), lane "walkthrough":
 * leads/{leadId}/call_briefs/visit_<visitId>, the Call Brief of an in-person
 * walkthrough (functions/call-brief.js with { visitId, visitUid }).
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.2, §6 #11.
 *
 * Read = the callable's audience, taken from the brief's own server-written
 * visitUid / companyId: the person who recorded the walkthrough, a platform
 * admin, or a company_admin / manager of the customer's company. Never a
 * viewer, never another rep, never another tenant. And only while the visit
 * (users/{visitUid}/visit_captures/{visitId}, read with get()) is still filed
 * on THIS lead (detach / move deletes the old brief; the rule refuses it anyway).
 * Write: never from a client. The phone-call branch is unchanged.
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-cbvisit-test \
 *     'node firestore-rules.call-briefs-visit.test.js'
 *
 * Every deny is paired with an allow (positive controls), so a rule that
 * denies everything cannot pass.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-cbvisit-test';
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

const V = 'vWalk0000001';        // recorded by the solo owner co-a, filed on L1
const V_REP = 'vRepWalk0001';    // recorded by alice (sales rep), filed on L1
const V_MOVED = 'vMoved000001';  // filed on L2 now; a stale brief left on L1
const V_VIEW = 'vViewOwn0001';   // recorded by a viewer
const CALL = 'cube_RULESV0001';

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
  const vicOwner = ctx('vico', { role: 'viewer', companyId: 'co-a' });
  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const rob = ctx('rob', { role: 'sales_rep', companyId: 'co-a' });         // another rep
  const bobCA = ctx('bobca', { role: 'company_admin', companyId: 'co-b' });
  const bobSolo = ctx('co-b', {});
  const joe = ctx('joe', { role: 'admin' });
  const anon = env.unauthenticatedContext().firestore();
  const { setDoc, doc, getDoc, getDocs, collection, deleteDoc, updateDoc } = require('firebase/firestore');
  const brief = (db, lead, id) => doc(db, 'leads/' + (lead || 'L1') + '/call_briefs/' + (id || 'visit_' + V));
  const B = (visitId, visitUid, over) => Object.assign({ callId: 'visit_' + visitId, leadId: 'L1', companyId: 'co-a', userId: visitUid, source: 'visit', visitId, visitUid, v: 1, brief: { summary: { text: 'Walked the roof.' } }, decisions: [] }, over || {});

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'leads/L1'), { userId: 'alice', companyId: 'co-a', firstName: 'Pat' });
    await setDoc(doc(db, 'leads/L2'), { userId: 'co-a', companyId: 'co-a', firstName: 'Sam' });
    const vc = (uid, id, lead) => setDoc(doc(db, 'users/' + uid + '/visit_captures/' + id), { startedAtMs: 1, status: 'uploaded', source: 'customer', consentMode: 'one_party', leadId: lead, attachedLeadId: lead, pipelineStatus: 'ready' });
    await vc('co-a', V, 'L1');
    await vc('alice', V_REP, 'L1');
    await vc('co-a', V_MOVED, 'L2');
    await vc('vico', V_VIEW, 'L1');
    await setDoc(brief(db), B(V, 'co-a'));
    await setDoc(brief(db, 'L1', 'visit_' + V_REP), B(V_REP, 'alice'));
    await setDoc(brief(db, 'L1', 'visit_' + V_MOVED), B(V_MOVED, 'co-a'));
    await setDoc(brief(db, 'L1', 'visit_' + V_VIEW), B(V_VIEW, 'vico'));
    // A brief whose stored visitId does not match its own doc id (a forged pointer).
    await setDoc(brief(db, 'L1', 'visit_vForged00001'), B(V, 'co-a', { callId: 'visit_vForged00001' }));
    // A brief whose visit doc does not exist.
    await setDoc(brief(db, 'L1', 'visit_vNoSuchVisit'), B('vNoSuchVisit', 'co-a'));
    // Another tenant's walkthrough brief on the same lead id space.
    await setDoc(brief(db, 'L1', 'visit_vOtherCo0001'), B('vOtherCo0001', 'co-b', { companyId: 'co-b' }));
    await setDoc(doc(db, 'users/co-b/visit_captures/vOtherCo0001'), { startedAtMs: 1, status: 'uploaded', source: 'customer', consentMode: 'one_party', leadId: 'L1', attachedLeadId: 'L1', pipelineStatus: 'ready' });
    // The phone branch, unchanged.
    await setDoc(doc(db, 'phone_calls/' + CALL), { userId: 'co-a', companyId: 'co-a', leadId: 'L1', status: 'noted' });
    await setDoc(brief(db, 'L1', CALL), { callId: CALL, leadId: 'L1', companyId: 'co-a', userId: 'co-a', v: 1, brief: {}, decisions: [] });
  });

  // -- reads
  await check('the walkthrough\'s recorder (solo owner, no role claim) reads its brief', 'allow', getDoc(brief(owner)));
  await check('a same-company company_admin reads', 'allow', getDoc(brief(carol)));
  await check('a same-company manager reads', 'allow', getDoc(brief(eve)));
  await check('a platform admin reads', 'allow', getDoc(brief(joe)));
  await check('a sales rep who recorded the walkthrough reads its brief', 'allow', getDoc(brief(alice, 'L1', 'visit_' + V_REP)));
  await check('a viewer does NOT read (briefs copy transcript quotes)', 'deny', getDoc(brief(vic)));
  await check('a viewer who recorded the walkthrough does NOT read either', 'deny', getDoc(brief(vicOwner, 'L1', 'visit_' + V_VIEW)));
  await check('a sales rep who owns the LEAD but did not record it does NOT read', 'deny', getDoc(brief(alice)));
  await check('another rep does NOT read a rep\'s walkthrough', 'deny', getDoc(brief(rob, 'L1', 'visit_' + V_REP)));
  await check('another tenant\'s company_admin does NOT read', 'deny', getDoc(brief(bobCA)));
  await check('another tenant\'s solo owner does NOT read', 'deny', getDoc(brief(bobSolo)));
  await check('another tenant\'s recorder reads their own brief (positive control for the deny above)', 'allow', getDoc(brief(bobSolo, 'L1', 'visit_vOtherCo0001')));
  await check('…but this company\'s company_admin does NOT read the other tenant\'s', 'deny', getDoc(brief(carol, 'L1', 'visit_vOtherCo0001')));
  await check('signed out does NOT read', 'deny', getDoc(brief(anon)));
  await check('a brief left on a lead the walkthrough is no longer filed on is NOT readable, even by its recorder', 'deny', getDoc(brief(owner, 'L1', 'visit_' + V_MOVED)));
  await check('a brief whose stored visitId is not its own id is NOT readable', 'deny', getDoc(brief(owner, 'L1', 'visit_vForged00001')));
  await check('a brief whose visit does not exist is NOT readable', 'deny', getDoc(brief(owner, 'L1', 'visit_vNoSuchVisit')));
  await check('a viewer cannot list the collection', 'deny', getDocs(collection(vic, 'leads/L1/call_briefs')));
  await check('the phone branch still reads (the call\'s owner)', 'allow', getDoc(brief(owner, 'L1', CALL)));
  await check('the phone branch still refuses a viewer', 'deny', getDoc(brief(vic, 'L1', CALL)));

  // -- writes: never from a client
  await check('the recorder cannot create a walkthrough brief', 'deny', setDoc(brief(owner, 'L2', 'visit_vNewBrief001'), B('vNewBrief001', 'co-a')));
  await check('the recorder cannot edit one (e.g. forge a decision)', 'deny', updateDoc(brief(owner), { decisions: [{ item: 'field:claimNumber', decision: 'accept' }] }));
  await check('a company_admin cannot edit one', 'deny', updateDoc(brief(carol), { 'brief.summary.text': 'forged' }));
  await check('a platform admin cannot write one from a client either', 'deny', setDoc(brief(joe), B(V, 'co-a')));
  await check('the recorder cannot delete one', 'deny', deleteDoc(brief(owner)));

  await env.cleanup();
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.label + (r.ok ? '' : ' — ' + r.note));
  console.log('\n' + (results.length - bad.length) + ' passed, ' + bad.length + ' failed');
  if (bad.length) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
