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
  const BT = Date.now();                 // the Bin cases: now, in ms (the rules pin binnedAtMs to within a day of the server clock)
  const BIN30 = 30 * 86400000;
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
    // emulators:exec sets FIRESTORE_EMULATOR_HOST (127.0.0.1:8080 in CI); reading it lets a machine whose 8080 is taken use another port
    firestore: { rules: fs.readFileSync(RULES_PATH, 'utf8'), host: String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[0], port: Number(String(process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':')[1]) },
  });
  const ctx = (uid, claims) => env.authenticatedContext(uid, claims).firestore();
  const { setDoc, doc, getDoc, updateDoc, deleteDoc } = require('firebase/firestore');

  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore();
    await setDoc(doc(db, 'leads/lead-a1'), { userId: 'alice', companyId: 'co-a', name: 'ZZ Alice Lead' });
    await setDoc(doc(db, 'leads/lead-a2'), { userId: 'rep2', companyId: 'co-a', name: 'ZZ Rep2 Lead' });
    await setDoc(doc(db, 'leads/lead-b1'), { userId: 'bob', companyId: 'co-b', name: 'ZZ Bob Lead' });
    // The path-splice probe: an activity doc ALICE owns, named like another tenant's lead id.
    await setDoc(doc(db, 'leads/lead-a1/activity/lead-b1'), { userId: 'alice', companyId: 'co-b', type: 'note', source: 'rep' });
    await setDoc(doc(db, 'users/alice/visit_captures/' + VID), visit('alice', { leadId: null }));
    await setDoc(doc(db, 'users/alice/visit_captures/vseeded000000001'), visit('alice', { leadId: 'lead-a1' }));
    await setDoc(doc(db, 'users/alice/visit_captures/vseeded000000002'), visit('alice', { leadId: null }));
    await setDoc(doc(db, 'users/alice/visit_captures/vseeded000000003'), visit('alice', { leadId: null }));
    // a viewer's own doc (written before they were made a viewer): they may not change or delete it
    await setDoc(doc(db, 'users/vic/visit_captures/vvic000000000001'), visit('vic', { leadId: null }));
    await setDoc(doc(db, 'users/vic/visit_captures/vvic000000000002'), visit('vic', { leadId: null }));
    // PR 2: docs the SERVER pipeline has already written to (admin SDK). The phone keeps patching
    // its own upload state on these, so the update rule must accept that and still refuse every
    // change to a server-owned field.
    for (let i = 1; i <= 12; i++) {
      await setDoc(doc(db, 'users/alice/visit_captures/vsrvown0000000' + String(i).padStart(2, '0')), Object.assign(visit('alice', { status: 'uploaded', audioPath: 'audio/alice/_inbox/vsrvown0000000' + String(i).padStart(2, '0') + '.m4a', uploadedAtMs: 1760000100000 }), {
        pipelineStatus: 'ready', transcript: 'hello there', transcriptRaw: 'hello there', notes: { summary: 's', promises: [] },
        suggestions: [{ leadId: 'lead-a1', name: 'ZZ Alice Lead', evidence: 'x' }], audioLive: true, finalizedKey: null,
        attachedLeadId: null, pipelineNextAtMs: 0, rejectedLeadIds: [],
      }));
    }
    // Recordings Bin (2026-11-20): plain, already-binned, attached-then-binned, and a few more plain ones to write to
    for (let i = 1; i <= 8; i++) await setDoc(doc(db, 'users/alice/visit_captures/vbinseed0000000' + i), visit('alice', { status: 'uploaded', audioPath: 'audio/alice/_inbox/vbinseed0000000' + i + '.webm', uploadedAtMs: 1760000100000 }));
    await setDoc(doc(db, 'users/alice/visit_captures/vbinseed0000000b'), visit('alice', { status: 'uploaded', binnedAtMs: BT, hardDeleteAtMs: BT + BIN30, binnedFrom: 'unfiled', binnedLeadId: null }));
    await setDoc(doc(db, 'users/alice/visit_captures/vbinseed0000000c'), visit('alice', { status: 'uploaded', leadId: null, binnedAtMs: BT, hardDeleteAtMs: BT + BIN30, binnedFrom: 'attached', binnedLeadId: 'lead-a1' }));
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

  // ── PR 2: server-owned fields sit on the doc; the phone still patches its own ──
  const SV = (n) => 'vsrvown0000000' + String(n).padStart(2, '0');
  await check('PR2 control: the phone patches its upload state on a doc the server already wrote to', 'allow', updateDoc(ref(alice, 'alice', SV(1)), { status: 'uploaded', uploadedAtMs: 1760000200000 }));
  await check('PR2 control: attach (leadId + attachedAtMs) still works on such a doc', 'allow', setDoc(ref(alice, 'alice', SV(2)), { leadId: 'lead-a1', attachedAtMs: 1760000300000 }, { merge: true }));
  await check('PR2 control: a discard (status + leadId null) works on such a doc', 'allow', updateDoc(ref(alice, 'alice', SV(3)), { status: 'discarded', discardedAtMs: 1760000400000, leadId: null }));
  await check('PR2 control: a whole-doc merge that leaves every server field untouched is allowed', 'allow',
    setDoc(ref(alice, 'alice', SV(4)), { status: 'uploaded', durationSec: 62, pipelineStatus: 'ready', transcript: 'hello there' }, { merge: true }));
  const serverFields = [['pipelineStatus', 'queued'], ['transcript', 'forged words'], ['transcriptRaw', 'x'], ['notes', { summary: 'forged' }],
    ['suggestions', [{ leadId: 'lead-a1', name: 'x', evidence: 'y' }]], ['audioLive', false], ['finalizedKey', 'lead-a1:n'], ['attachedLeadId', 'lead-a1'],
    ['pipelineNextAtMs', 1], ['rejectedLeadIds', ['lead-a1']]];
  for (const [k, v] of serverFields) {
    await check('PR2: the phone cannot change server-owned "' + k + '"', 'deny', updateDoc(ref(alice, 'alice', SV(5)), { [k]: v }));
  }
  await check('PR2: nor smuggle one in beside a legitimate change', 'deny', updateDoc(ref(alice, 'alice', SV(5)), { status: 'uploaded', pipelineStatus: 'ready2' }));
  await check('PR2: nor delete one', 'deny', updateDoc(ref(alice, 'alice', SV(5)), { transcript: require('firebase/firestore').deleteField() }));
  await check('PR2: a bad allowlisted value is still refused on such a doc (status outside the list)', 'deny', updateDoc(ref(alice, 'alice', SV(6)), { status: 'transcribed' }));
  await check('PR2: a bad lead is still refused on such a doc (another tenant)', 'deny', setDoc(ref(alice, 'alice', SV(6)), { leadId: 'lead-b1', attachedAtMs: 1 }, { merge: true }));
  await check('PR2: startedAtMs is still write-once on such a doc', 'deny', updateDoc(ref(alice, 'alice', SV(6)), { startedAtMs: 1 }));
  await check('PR2: a viewer still cannot patch such a doc', 'deny', updateDoc(ref(vic, 'alice', SV(7)), { status: 'uploaded' }));
  await check('PR2: another tenant still cannot patch it', 'deny', updateDoc(ref(bob, 'alice', SV(7)), { status: 'uploaded' }));
  await check('PR2: the owner can still delete it (the server trigger then removes the audio)', 'allow', deleteDoc(ref(alice, 'alice', SV(8))));

  // ── review round: a leadId is an ID, never a path; consentMode is write-once ──
  await check('RR: leadId that is a path into an activity doc the writer owns (leads/lead-a1/activity/lead-b1) is refused', 'deny',
    setDoc(ref(alice, 'alice', 'vslash000000001'), visit('alice', { leadId: 'lead-a1/activity/lead-b1' })));
  await check('RR: ...on an update too (merge)', 'deny', setDoc(ref(alice, 'alice', SV(9)), { leadId: 'lead-a1/activity/lead-b1', attachedAtMs: 1 }, { merge: true }));
  await check('RR: leadId with a trailing path escape is refused', 'deny', setDoc(ref(alice, 'alice', 'vslash000000002'), visit('alice', { leadId: 'lead-a1/..' })));
  await check('RR: leadId that is not a string is refused', 'deny', setDoc(ref(alice, 'alice', 'vslash000000003'), visit('alice', { leadId: 12345 })));
  await check('RR control: the plain id of their own lead is accepted', 'allow', setDoc(ref(alice, 'alice', 'vslash000000004'), visit('alice', { leadId: 'lead-a1' })));
  await check('RR: consentMode cannot be lowered after the fact', 'deny', updateDoc(ref(alice, 'alice', SV(10)), { consentMode: 'two_party_verbal' }));
  await check('RR control: writing the SAME consentMode again (the phone mirrors its row) is accepted', 'allow', setDoc(ref(alice, 'alice', SV(10)), { consentMode: 'one_party', status: 'uploaded' }, { merge: true }));

  // ── Recordings Bin (2026-11-20): Bin, Keep, Restore; the deadline is pinned; Hold and the audit log are server-only ──
  const BIN = (over) => Object.assign({ binnedAtMs: BT, hardDeleteAtMs: BT + BIN30, binnedFrom: 'unfiled', binnedLeadId: null, leadId: null, keptAtMs: null }, over || {});
  const bref = (n) => ref(alice, 'alice', 'vbinseed0000000' + n);
  await check('Bin control: the phone bins a recording with the exact 30-day deadline', 'allow', updateDoc(bref(1), BIN()));
  await check('Bin: a deadline shorter than 30 days is refused (a short deadline would get the daily job to purge it early)', 'deny', updateDoc(bref(2), BIN({ hardDeleteAtMs: BT + 86400000 })));
  await check('Bin: a deadline in the past is refused', 'deny', updateDoc(bref(2), BIN({ hardDeleteAtMs: BT - 86400000 })));
  await check('Bin: a far-future deadline is refused (it would never expire)', 'deny', updateDoc(bref(2), BIN({ hardDeleteAtMs: BT + 365 * 86400000 })));
  await check('Bin: binnedAtMs ten days ago (with its matching deadline) is refused: it must be within a day of the server clock', 'deny', updateDoc(bref(2), BIN({ binnedAtMs: BT - 10 * 86400000, hardDeleteAtMs: BT - 10 * 86400000 + BIN30 })));
  await check('Bin: binnedAtMs a year ahead is refused', 'deny', updateDoc(bref(2), BIN({ binnedAtMs: BT + 365 * 86400000, hardDeleteAtMs: BT + 365 * 86400000 + BIN30 })));
  await check('Bin: binnedFrom must be unfiled or attached', 'deny', updateDoc(bref(2), BIN({ binnedFrom: 'lost' })));
  await check('Bin: binnedLeadId is capped at 128 characters', 'deny', updateDoc(bref(2), BIN({ binnedFrom: 'attached', binnedLeadId: 'x'.repeat(129) })));
  await check('Bin control: the same write with a normal binnedLeadId is accepted', 'allow', updateDoc(bref(2), BIN({ binnedFrom: 'attached', binnedLeadId: 'lead-a1' })));
  await check('Bin: another tenant cannot bin this recording', 'deny', updateDoc(ref(bob, 'alice', 'vbinseed00000004'), BIN()));
  await check('Bin: a viewer cannot', 'deny', updateDoc(ref(vic, 'alice', 'vbinseed00000004'), BIN()));
  await check('Bin: a same-company admin cannot write it either (admins go through the callable, never straight to the doc)', 'deny', updateDoc(ref(carol, 'alice', 'vbinseed00000004'), BIN()));
  await check('Keep control: the phone marks a recording Kept', 'allow', updateDoc(bref(4), { keptAtMs: BT }));
  await check('Keep: and un-keeps it', 'allow', updateDoc(bref(4), { keptAtMs: null }));
  await check('Keep: keptAtMs must be a number', 'deny', updateDoc(bref(4), { keptAtMs: 'yesterday' }));
  await check('Restore: clearing the Bin fields and putting the customer back is accepted (the customer is checked like any attach)', 'allow', updateDoc(bref('c'), { binnedAtMs: null, hardDeleteAtMs: null, binnedFrom: null, binnedLeadId: null, leadId: 'lead-a1' }));
  await check('Restore: but not onto another tenants customer', 'deny', updateDoc(bref('b'), { binnedAtMs: null, hardDeleteAtMs: null, binnedFrom: null, binnedLeadId: null, leadId: 'lead-b1' }));
  await check('Delete forever is the servers: the phone cannot write status discarded on a recording that is in the Bin', 'deny', updateDoc(bref(1), { status: 'discarded', discardedAtMs: BT }));
  await check('Delete forever control: the older Discard (status discarded) on a recording NOT in the Bin is unchanged, so the flag-off flow keeps working', 'allow', updateDoc(bref(5), { status: 'discarded', discardedAtMs: BT }));
  await check('Hold is server-owned: the phone cannot set legalHold', 'deny', updateDoc(bref(6), { legalHold: true }));
  await check('Hold is server-owned: nor holdBy, nor holdAtMs', 'deny', updateDoc(bref(6), { holdBy: 'alice', holdAtMs: BT }));
  await check('Hold is server-owned: nor a create that carries it', 'deny', setDoc(ref(alice, 'alice', 'vbinhold0000001'), visit('alice', { legalHold: false })));
  await check('Bin on create: a new doc may not carry a wrong deadline either', 'deny', setDoc(ref(alice, 'alice', 'vbinnew00000001'), visit('alice', BIN({ hardDeleteAtMs: BT + 1 }))));
  await check('Bin on create control: with the right deadline it is accepted', 'allow', setDoc(ref(alice, 'alice', 'vbinnew00000002'), visit('alice', BIN())));
  const audit = (db) => doc(db, 'companies/co-a/recording_audit/probe1');
  await check('the audit log is server-only: a company admin cannot read it from a client', 'deny', getDoc(audit(carol)));
  await check('...nor a platform admin', 'deny', getDoc(audit(admin)));
  await check('...nor write it (a company admin)', 'deny', setDoc(audit(carol), { action: 'hold', atMs: BT }));
  await check('...nor the owner of the recordings', 'deny', setDoc(audit(alice), { action: 'hold', atMs: BT }));

  await env.cleanup();

  const bad = results.filter((r) => !r.ok);
  results.forEach((r) => console.log((r.ok ? '  ok   ' : '  FAIL ') + r.label + (r.ok ? '' : '  <- ' + r.note)));
  console.log('\nvisit_captures rules: ' + (results.length - bad.length) + '/' + results.length + ' checks went the right way');
  if (bad.length) { console.error('FAILED: ' + bad.length); process.exit(1); }
  console.log('PASS');
}

run().catch((e) => { console.error('visit_captures rules test crashed:', e); process.exit(1); });
