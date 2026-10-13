/**
 * Firestore rules - in-person visit recordings (2026-10-13).
 *
 *   users/{uid}/visit_captures/{visitId}
 *   documentation/projects/VISIT-RECORDER-PR1-2026-10-13.md
 *
 * RUN (proxy env scrubbed, throwaway emulator):
 *   cd tests
 *   env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
 *     npx firebase-tools emulators:exec --only firestore --project nbd-vcap-test \
 *     'node firestore-rules.visit-captures.test.js'
 *
 * Every deny that is about SHAPE is paired with an allow of the same doc minus
 * the one defect (a positive control), so a rule that denies everything cannot
 * pass. A parity check also fails if the client's field list
 * (visit-recorder-logic.js DOC_FIELDS) drifts from the rules' allowlist.
 */
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = process.env.RULES_TEST_PROJECT_ID || 'nbd-vcap-test';
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

const RULES_PATH = process.env.RULES_PATH || path.resolve(__dirname, '../firestore.rules');
const VID = 'vmgx7k2q4abc123d';

function visit(uid, over) {
  return Object.assign({
    startedAtMs: 1760000000000, status: 'stored', source: 'fab', consentMode: 'one_party',
    leadId: null, mime: 'audio/webm', sizeBytes: 123456, durationSec: 61, createdAtMs: 1760000000000,
  }, over || {});
}

async function run() {
  // ── parity: the client's field list == the rules allowlist ──────────────
  {
    const logic = require('../docs/pro/js/visit-recorder-logic.js');
    const src = fs.readFileSync(RULES_PATH, 'utf8');
    const m = /function vcKeys\(\) \{\s*return \[([\s\S]*?)\];/.exec(src);
    const inRules = m ? (m[1].match(/'([A-Za-z]+)'/g) || []).map((x) => x.slice(1, -1)).sort() : [];
    const inClient = logic.DOC_FIELDS.slice().sort();
    const same = inRules.length > 0 && JSON.stringify(inRules) === JSON.stringify(inClient);
    results.push({ label: 'parity: DOC_FIELDS equals the rules allowlist (' + inRules.length + ' vs ' + inClient.length + ')', ok: same,
      note: same ? '' : 'rules=' + inRules.join(',') + ' client=' + inClient.join(',') });
  }

  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: '127.0.0.1', port: 8080 },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const { setDoc, doc, getDoc, updateDoc, deleteDoc } = require('firebase/firestore');

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'leads/lead-a1'), { userId: 'alice', companyId: 'co-a', name: 'ZZ Alice Lead' });
    await setDoc(doc(db, 'leads/lead-a2'), { userId: 'rep2', companyId: 'co-a', name: 'ZZ Rep2 Lead' });
    await setDoc(doc(db, 'leads/lead-b1'), { userId: 'bob', companyId: 'co-b', name: 'ZZ Bob Lead' });
    await setDoc(doc(db, 'users/alice/visit_captures/' + VID), visit('alice', { leadId: null }));
    await setDoc(doc(db, 'users/alice/visit_captures/vseeded000000001'), visit('alice', { leadId: 'lead-a1' }));
    await setDoc(doc(db, 'users/alice/visit_captures/vseeded000000002'), visit('alice', { leadId: null }));
    await setDoc(doc(db, 'users/alice/visit_captures/vseeded000000003'), visit('alice', { leadId: null }));
    // a viewer's own doc (written before they were made a viewer): they may not change or delete it
    await setDoc(doc(db, 'users/vic/visit_captures/vvic000000000001'), visit('vic', { leadId: null }));
    await setDoc(doc(db, 'users/vic/visit_captures/vvic000000000002'), visit('vic', { leadId: null }));
  });

  const alice = ctx('alice', { role: 'sales_rep', companyId: 'co-a' });
  const carol = ctx('carol', { role: 'company_admin', companyId: 'co-a' });
  const bob = ctx('bob', { role: 'sales_rep', companyId: 'co-b' });
  const vic = ctx('vic', { role: 'viewer', companyId: 'co-a' });
  const admin = ctx('joe', { role: 'admin' });
  const solo = ctx('solo1', {});
  const anon = env.unauthenticatedContext().firestore();
  const ref = (db, uid, id) => doc(db, 'users/' + uid + '/visit_captures/' + (id || VID));

  // ── the happy path and its owner scoping ────────────────────────────────
  await check('control: owner creates a minimal visit doc', 'allow', setDoc(ref(alice, 'alice', 'vnew00000000001'), visit('alice')));
  await check('control: a solo operator (no claims) creates one under their own uid', 'allow', setDoc(ref(solo, 'solo1', 'vsolo0000000001'), visit('solo1')));
  await check('owner creates a full uploaded doc with its own _inbox audioPath', 'allow',
    setDoc(ref(alice, 'alice', 'vfull00000000001'), visit('alice', {
      status: 'uploaded', audioPath: 'audio/alice/_inbox/vfull00000000001.webm', uploadedAtMs: 1760000100000,
      lat: 39.103, lng: -84.512, accuracyM: 14, endedAtMs: 1760000061000, chunkCount: 31, backgroundSec: 0,
      appointmentId: 'appt1', disclosureAckedAtMs: 1760000000100, leadId: 'lead-a1', source: 'appointment',
    })));
  await check('lat/lng may be null (location refused)', 'allow', setDoc(ref(alice, 'alice', 'vnull00000000001'), visit('alice', { lat: null, lng: null, accuracyM: null })));
  await check('a different signed-in user cannot write under alice', 'deny', setDoc(ref(bob, 'alice', 'vevil00000000001'), visit('alice')));
  await check('a viewer cannot create one even under their own uid', 'deny', setDoc(ref(vic, 'vic', 'vview00000000001'), visit('vic')));
  await check('signed out cannot write', 'deny', setDoc(ref(anon, 'alice', 'vanon00000000001'), visit('alice')));
  // Note: read is ALSO granted by the users/{uid}/{subcol} wildcard (same rule), so the read
  // checks below pin the behaviour, not which match grants it. Writes have one grant only.
  await check('owner reads their doc', 'allow', getDoc(ref(alice, 'alice')));
  await check('another tenant cannot read it', 'deny', getDoc(ref(bob, 'alice')));
  await check('a same-company admin cannot read it either (owner-only)', 'deny', getDoc(ref(carol, 'alice')));
  await check('platform admin reads it', 'allow', getDoc(ref(admin, 'alice')));
  await check('signed out cannot read', 'deny', getDoc(ref(anon, 'alice')));

  // ── no client-set server fields ─────────────────────────────────────────
  for (const f of ['transcript', 'summary', 'analysisStatus', 'suggestions', 'serverStatus', 'linkedLeadId', 'transcribedAtMs', 'speakers']) {
    await check('server-owned field "' + f + '" is refused', 'deny', setDoc(ref(alice, 'alice', 'vsrv' + f.length + '0000000001'), Object.assign(visit('alice'), { [f]: 'x' })));
  }
  await check('control for the above: the same doc without it is accepted', 'allow', setDoc(ref(alice, 'alice', 'vsrvok0000000001'), visit('alice')));
  await check('an update that ADDS a server field is refused', 'deny', updateDoc(ref(alice, 'alice'), { transcript: 'hello' }));
  await check('control: an update that sets an allowed field is accepted', 'allow', updateDoc(ref(alice, 'alice'), { sizeBytes: 222222 }));

  // ── shape ───────────────────────────────────────────────────────────────
  await check('status outside the list', 'deny', setDoc(ref(alice, 'alice', 'vbad000000000001'), visit('alice', { status: 'transcribed' })));
  await check('source outside the list', 'deny', setDoc(ref(alice, 'alice', 'vbad000000000002'), visit('alice', { source: 'home' })));
  await check('consentMode outside the list', 'deny', setDoc(ref(alice, 'alice', 'vbad000000000003'), visit('alice', { consentMode: 'nobody' })));
  await check('lat out of range', 'deny', setDoc(ref(alice, 'alice', 'vbad000000000004'), visit('alice', { lat: 91 })));
  await check('size over the storage cap', 'deny', setDoc(ref(alice, 'alice', 'vbad000000000005'), visit('alice', { sizeBytes: 209715201 })));
  await check('a non-audio mime', 'deny', setDoc(ref(alice, 'alice', 'vbad000000000006'), visit('alice', { mime: 'text/html' })));
  await check('startedAtMs must be a number', 'deny', setDoc(ref(alice, 'alice', 'vbad000000000007'), visit('alice', { startedAtMs: 'now' })));
  await check('a too-short visit id', 'deny', setDoc(ref(alice, 'alice', 'v1'), visit('alice')));
  await check('missing status', 'deny', setDoc(ref(alice, 'alice', 'vbad000000000008'), (() => { const d = visit('alice'); delete d.status; return d; })()));
  await check('startedAtMs is write-once', 'deny', updateDoc(ref(alice, 'alice'), { startedAtMs: 1770000000000 }));
  await check('control: other fields still update', 'allow', updateDoc(ref(alice, 'alice'), { status: 'uploading' }));

  // ── audioPath cannot be aimed at someone else's object ──────────────────
  await check('audioPath at another user\'s inbox', 'deny', setDoc(ref(alice, 'alice', 'vpath00000000001'), visit('alice', { audioPath: 'audio/bob/_inbox/vpath00000000001.webm' })));
  await check('audioPath at a lead-bound recording', 'deny', setDoc(ref(alice, 'alice', 'vpath00000000002'), visit('alice', { audioPath: 'audio/alice/lead-a1/rec1.webm' })));
  await check('audioPath at another visit\'s file in own inbox', 'deny', setDoc(ref(alice, 'alice', 'vpath00000000003'), visit('alice', { audioPath: 'audio/alice/_inbox/vother0000000001.webm' })));
  await check('audioPath outside audio/', 'deny', setDoc(ref(alice, 'alice', 'vpath00000000004'), visit('alice', { audioPath: 'photos/alice/vpath00000000004.webm' })));
  await check('audioPath with a path escape', 'deny', setDoc(ref(alice, 'alice', 'vpath00000000005'), visit('alice', { audioPath: 'audio/alice/_inbox/vpath00000000005.webm/../../x' })));
  await check('control: the right own-inbox path', 'allow', setDoc(ref(alice, 'alice', 'vpath00000000006'), visit('alice', { audioPath: 'audio/alice/_inbox/vpath00000000006.m4a' })));

  // ── tenant isolation on leadId ──────────────────────────────────────────
  await check('leadId of another tenant\'s lead', 'deny', setDoc(ref(alice, 'alice', 'vlead00000000001'), visit('alice', { leadId: 'lead-b1' })));
  await check('leadId of a lead that does not exist', 'deny', setDoc(ref(alice, 'alice', 'vlead00000000002'), visit('alice', { leadId: 'no-such-lead' })));
  await check('a sales rep cannot file under a colleague\'s lead', 'deny', setDoc(ref(alice, 'alice', 'vlead00000000003'), visit('alice', { leadId: 'lead-a2' })));
  await check('control: own lead', 'allow', setDoc(ref(alice, 'alice', 'vlead00000000004'), visit('alice', { leadId: 'lead-a1' })));
  await check('control: company staff may file under a same-tenant lead', 'allow', setDoc(ref(carol, 'carol', 'vlead00000000005'), visit('carol', { leadId: 'lead-a2' })));
  await check('company staff cannot reach another tenant\'s lead', 'deny', setDoc(ref(carol, 'carol', 'vlead00000000006'), visit('carol', { leadId: 'lead-b1' })));
  await check('attach on an existing doc: merge of just leadId + attachedAtMs', 'allow',
    setDoc(ref(alice, 'alice', 'vseeded000000001'), { leadId: 'lead-a1', attachedAtMs: 1760000200000 }, { merge: true }));
  await check('detach: leadId back to null', 'allow', updateDoc(ref(alice, 'alice', 'vseeded000000001'), { leadId: null, attachedAtMs: null }));

  // the UPDATE path carries its own lead gate: an attach is an update, not a create
  await check('attach (merge update) to another tenant\'s lead is refused', 'deny',
    setDoc(ref(alice, 'alice', 'vseeded000000002'), { leadId: 'lead-b1', attachedAtMs: 1760000300000 }, { merge: true }));
  await check('attach (merge update) to a colleague\'s lead is refused for a sales rep', 'deny',
    setDoc(ref(alice, 'alice', 'vseeded000000002'), { leadId: 'lead-a2', attachedAtMs: 1760000300000 }, { merge: true }));
  await check('attach (merge update) to a lead that does not exist is refused', 'deny',
    setDoc(ref(alice, 'alice', 'vseeded000000002'), { leadId: 'no-such-lead', attachedAtMs: 1760000300000 }, { merge: true }));
  await check('updateDoc to another tenant\'s lead is refused', 'deny', updateDoc(ref(alice, 'alice', 'vseeded000000002'), { leadId: 'lead-b1' }));
  await check('control: the same merge update to their own lead is accepted', 'allow',
    setDoc(ref(alice, 'alice', 'vseeded000000002'), { leadId: 'lead-a1', attachedAtMs: 1760000300000 }, { merge: true }));

  // audioPath: extension allowlist and the exact folder, each with a deny for its own reason
  await check('audioPath with a non-audio extension in the right folder', 'deny', setDoc(ref(alice, 'alice', 'vpath00000000007'), visit('alice', { audioPath: 'audio/alice/_inbox/vpath00000000007.html' })));
  await check('audioPath with the right file name in a lead folder (folder is what is wrong)', 'deny', setDoc(ref(alice, 'alice', 'vpath00000000008'), visit('alice', { audioPath: 'audio/alice/lead-a1/vpath00000000008.webm' })));
  await check('audioPath with the right file name in a sibling folder that merely starts with _inbox', 'deny', setDoc(ref(alice, 'alice', 'vpath00000000009'), visit('alice', { audioPath: 'audio/alice/_inbox2/vpath00000000009.webm' })));
  await check('control: the right folder and name with each allowed extension', 'allow',
    Promise.all(['webm', 'm4a', 'ogg', 'mp3', 'wav'].map((e, i) => setDoc(ref(alice, 'alice', 'vext0000000000' + i + '0'), visit('alice', { audioPath: 'audio/alice/_inbox/vext0000000000' + i + '0.' + e })))));

  // a viewer is read-only here too
  await check('a viewer cannot update their own visit doc', 'deny', updateDoc(ref(vic, 'vic', 'vvic000000000001'), { status: 'uploaded' }));
  await check('a viewer cannot delete their own visit doc', 'deny', deleteDoc(ref(vic, 'vic', 'vvic000000000002')));
  await check('control: a sales rep CAN update their own (same shape of change)', 'allow', updateDoc(ref(alice, 'alice', 'vseeded000000003'), { status: 'uploaded' }));
  await check('platform admin can delete one (support)', 'allow', deleteDoc(ref(admin, 'alice', 'vseeded000000003')));

  // ── delete and the sibling-wildcard control ─────────────────────────────
  await check('owner deletes their doc', 'allow', deleteDoc(ref(alice, 'alice', 'vnew00000000001')));
  await check('another user cannot delete it', 'deny', deleteDoc(ref(bob, 'alice', 'vseeded000000001')));
  await check('the wildcard still refuses an unlisted sibling collection', 'deny', setDoc(doc(alice, 'users/alice/visit_captures_x/abc'), { a: 1 }));

  await env.cleanup();

  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ok   ' : '  FAIL ') + r.label + (r.ok ? '' : '  <- ' + r.note)));
  console.log('\nvisit_captures rules: ' + (results.length - bad.length) + '/' + results.length + ' checks went the right way');
  if (bad.length) { console.error('FAILED: ' + bad.length); process.exit(1); }
  console.log('PASS');
}

run().catch((e) => { console.error('visit_captures rules test crashed:', e); process.exit(1); });
