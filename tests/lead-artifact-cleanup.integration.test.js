/**
 * tests/lead-artifact-cleanup.integration.test.js — appointments sweep on
 * lead hard-delete (functions/lead-artifact-cleanup.js, added 2026-09-13).
 *
 * THE BUG THIS CLOSES
 * ────────────────────
 * Hard-deleting a lead (the Trash drawer's Remove → window._permanentDelete
 * Lead → a bare `deleteDoc(doc(db,'leads',id))`) never touched a Cal.com
 * booking linked to it. appointments/{bookingId}.leadId
 * (functions/integrations/calcom.js) points at whichever CRM lead the
 * booking is linked to — a pre-existing match, or the calcom__<bookingId>
 * lead created for an unmatched booker. onLeadDeleted swept Storage
 * artifacts and token collections but never queried `appointments` at all
 * (grepped — zero references). No client UI anywhere deletes an
 * appointments/{id} doc directly, and Firestore does not cascade a delete
 * into a sibling top-level collection, so once a Cal.com-linked lead was
 * hard-deleted its appointment became a permanent orphan — leadId pointing
 * at nothing, with no path in the product to ever remove it.
 *
 * Drives the REAL onLeadDeleted trigger (functions + firestore emulator):
 * seeds a lead + linked appointments/{id} docs via the admin SDK, hard-
 * deletes the lead, and asserts they're gone. Also pins CONFINEMENT
 * (another lead's appointment must survive) and that a lead with no linked
 * appointment still deletes cleanly.
 *
 * 2026-09-25: also asserts the lead's documents + warrantyClaims subcollection
 * rows are swept (and another lead's claim row is not). After a hard delete
 * the client rules can no longer reach those rows, so the trigger is the only
 * cleanup path for them.
 *
 * 2026-09-25 (later): the WHOLE subtree. Any row left under a hard-deleted
 * lead belongs to whoever re-creates that lead id (every subcollection rule
 * reads the parent lead to decide "owner"). onLeadDeleted now sweeps every
 * subcollection it can find, so this suite asserts, through the real trigger:
 *   A. every subcollection goes: notes, tasks, activity, drawings, saved
 *      signatures, portal messages, a name no code knows, a nested row, and a
 *      nested row under a row that never existed. Storage objects named by a
 *      row go too, including one only a row's download URL points at. An
 *      object of a lead whose id merely STARTS with this one survives (the
 *      old `includes(leadId)` confinement would have deleted it), and so do
 *      another lead's rows.
 *   B. a row written AFTER the delete, to a lead that stays gone (a late
 *      webhook), survives: rows newer than the cutoff are never swept. It is
 *      written once the trigger has provably started (its first page is
 *      gone), because under the emulator the cutoff is the invocation start:
 *      the emulator's event time is truncated to the second (see
 *      deleteCutoffNs in functions/lead-artifact-paths.js). 450 old rows
 *      make three pages, so the late row, last by id, is normally read after
 *      it exists. Same for an object uploaded under the lead's prefix then.
 *      The exact-cutoff rule is pinned deterministically in D.
 *   C. a stranger who re-creates the id right after the delete keeps their
 *      own new row and finds nothing of the old lead's.
 *   D. the sweep module directly (lead-subtree-sweep.js). With the cutoff set
 *      to one row's exact commit time, that row goes (at or before) and a row
 *      committed next survives. With a cutoff far in the future, as if the
 *      event time were unusable, rows written after a re-create still survive
 *      (the per-page lead re-read), and a row whose Storage delete FAILS is
 *      kept, because it is the only pointer left.
 * Storage runs as the storage emulator here (CI adds it to --only).
 *
 * RUN (CI):
 *   npx firebase-tools emulators:exec --only functions,firestore,storage --project demo-nbd-pl \
 *     "node tests/lead-artifact-cleanup.integration.test.js"
 * RUN (a machine with a shared emulator already up; no emulator is started):
 *   see documentation/audit/LEAD-SUBTREE-HIJACK-2026-09-25.md, "How the
 *   tests were run": the real handler fires in-process from a --require
 *   preload, against a dedicated project id, with Storage in memory.
 */
'use strict';

const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { sweepLeadSubtree } = require(path.join(__dirname, '..', 'functions', 'lead-subtree-sweep.js'));
const { timestampToNanos } = require(path.join(__dirname, '..', 'functions', 'lead-artifact-paths.js'));

const PROJECT = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'demo-nbd-pl';
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('✗ emulator env not set — run via emulators:exec --only functions,firestore,storage');
  process.exit(1);
}
// Storage is part of what is under test (a row's objects go before the row).
// No silent skip: without it the Storage assertions would pass on nothing.
if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST && !global.__nbdFakeStorage) {
  console.error('✗ storage emulator not set — run via emulators:exec --only functions,firestore,storage');
  process.exit(1);
}
const BUCKET = (() => {
  try { return JSON.parse(process.env.FIREBASE_CONFIG || '{}').storageBucket || null; } catch (_) { return null; }
})() || `${PROJECT}.appspot.com`;
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket(BUCKET);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function staysGone(ref, ms = 25000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await ref.get()).exists) return true;
    await sleep(300);
  }
  return !(await ref.get()).exists;
}
async function waitFor(fn, ms = 40000, every = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(every);
  }
  return !!(await fn());
}
const exists = async (p) => (await db.doc(p).get()).exists;
const objExists = async (p) => (await bucket.file(p).exists())[0];
const putObj = (p) => bucket.file(p).save(Buffer.from('<html>zz-qa</html>'), { contentType: 'text/html' });
// What getDownloadURL() hands the client. Only the path inside is used.
const downloadUrl = (p) => `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(p)}?alt=media&token=zz-qa`;
// Every row still under leads/{id}, at any depth (counts, for "nothing left").
async function rowsUnder(docRef) {
  let n = 0;
  for (const c of await docRef.listCollections()) {
    for (const r of await c.listDocuments()) {
      const s = await r.get();
      if (s.exists) n++;
      n += await rowsUnder(r);
    }
  }
  return n;
}

async function run() {
  console.log('LEAD-ARTIFACT-CLEANUP INTEGRATION — appointments + the whole lead subtree swept on hard delete');
  const RUN = 'ZZ_QA_' + Date.now();
  const OWNER = RUN + 'Owner';
  const STRANGER = RUN + 'Stranger';

  // ── 1) A Cal.com-linked lead + its appointment(s) are both swept ────
  const leadId = RUN + '_lead1';
  const bookingId = RUN + '_booking1';
  const bookingId1b = RUN + '_booking1b'; // reschedule chain: same leadId, different doc
  await db.doc(`leads/${leadId}`).set({
    userId: OWNER, companyId: OWNER, stage: 'New',
    firstName: 'ZZ_QA', source: 'Website — Cal.com booking',
  });
  await db.doc(`appointments/${bookingId}`).set({
    bookingId, leadId, userId: OWNER, repUid: OWNER, status: 'booked', source: 'calcom',
  });
  await db.doc(`appointments/${bookingId1b}`).set({
    bookingId: bookingId1b, leadId, userId: OWNER, repUid: OWNER,
    status: 'cancelled', cancelledReason: 'rescheduled', supersededBy: bookingId, source: 'calcom',
  });
  // 2026-09-25: lead subcollection rows the trigger must sweep. Once the lead
  // is gone no client can delete them (the rules check reads the parent
  // lead), so onLeadDeleted is their only path out. documents was already
  // swept (step 1) but never asserted; warrantyClaims is new (step 1b).
  await db.doc(`leads/${leadId}/documents/d1`).set({ name: 'contract.html', status: 'signed', userId: OWNER });
  await db.doc(`leads/${leadId}/warrantyClaims/c1`).set({ status: 'resolved', reason: 'workmanship' });
  await db.doc(`leads/${leadId}/warrantyClaims/c2`).set({ status: 'open', reason: 'material' });

  // A. The rest of the subtree (2026-09-25, later).
  const A = `leads/${leadId}`;
  const aRows = {
    'a note': `${A}/notes/n1`,
    'a task': `${A}/tasks/t1`,
    'a nested row (tasks/t1/checklist/c1)': `${A}/tasks/t1/checklist/c1`,
    'a nested row under a row that never existed (drawings/ghost/versions/v1)': `${A}/drawings/ghost/versions/v1`,
    'an activity row': `${A}/activity/a1`,
    'a drawing': `${A}/drawings/d1`,
    'the saved homeowner signature': `${A}/signatures/Homeowner`,
    'a portal message': `${A}/portal_messages/m1`,
    'a row in a subcollection no code names (zz_future_sub)': `${A}/zz_future_sub/f1`,
    'the documents row pointing at an HTML object': `${A}/documents/d2`,
    'the documents row whose only pointer is a download URL': `${A}/documents/d3`,
    'the documents row naming a sibling lead\'s object': `${A}/documents/d4`,
  };
  await db.doc(aRows['a note']).set({ text: 'gate code 4411', userId: OWNER });
  await db.doc(aRows['a task']).set({ title: 'call back', userId: OWNER });
  await db.doc(aRows['a nested row (tasks/t1/checklist/c1)']).set({ item: 'bring ladder' });
  await db.doc(aRows['a nested row under a row that never existed (drawings/ghost/versions/v1)']).set({ sq: 12 });
  await db.doc(aRows['an activity row']).set({ type: 'note', source: 'rep', userId: OWNER });
  await db.doc(aRows['a drawing']).set({ sq: 31 });
  await db.doc(aRows['the saved homeowner signature']).set({ role: 'Homeowner', png: 'data:image/png;base64,iVBORw0KGgo=', userId: OWNER });
  await db.doc(aRows['a portal message']).set({ body: 'is Tuesday ok?', from: 'homeowner' });
  await db.doc(aRows['a row in a subcollection no code names (zz_future_sub)']).set({ any: 'thing' });

  const htmlObj = `documents/${OWNER}/${leadId}/d2.html`;
  // The customer-page upload's shape: flat, `{leadId}_{ms}_{name}`, and the
  // row keeps only the download URL. No leadId directory, so the prefix sweep
  // (step 2) cannot see it; only the row does.
  const urlOnlyObj = `docs/${OWNER}/${leadId}_1790000000000_signed.pdf`;
  // A live lead whose id STARTS with lead1's. `includes(leadId)` said yes.
  const sibLead = leadId + 'sib';
  const sibObj = `documents/${OWNER}/${sibLead}/d.html`;
  await db.doc(`leads/${sibLead}`).set({ userId: OWNER, companyId: OWNER, stage: 'New', firstName: 'ZZ_QA Sib' });
  await putObj(htmlObj);
  await putObj(urlOnlyObj);
  await putObj(sibObj);
  await db.doc(aRows['the documents row pointing at an HTML object']).set({ name: 'contract', htmlPath: htmlObj, userId: OWNER });
  await db.doc(aRows['the documents row whose only pointer is a download URL']).set({ filename: 'signed.pdf', url: downloadUrl(urlOnlyObj), userId: OWNER, source: 'overview_upload' });
  await db.doc(aRows['the documents row naming a sibling lead\'s object']).set({ name: 'planted', htmlPath: sibObj, userId: OWNER });

  // ── 2) An unrelated lead + appointment — CONFINEMENT control ────────
  const leadId2 = RUN + '_lead2';
  const bookingId2 = RUN + '_booking2';
  await db.doc(`leads/${leadId2}`).set({
    userId: OWNER, companyId: OWNER, stage: 'New',
    firstName: 'ZZ_QA Two', source: 'Website — Cal.com booking',
  });
  await db.doc(`appointments/${bookingId2}`).set({
    bookingId: bookingId2, leadId: leadId2, userId: OWNER, repUid: OWNER,
    status: 'booked', source: 'calcom',
  });
  await db.doc(`leads/${leadId2}/warrantyClaims/c9`).set({ status: 'open', reason: 'workmanship' });
  await db.doc(`leads/${leadId2}/notes/n9`).set({ text: 'keep me' });

  // ── 3) A lead with no linked appointment at all ─────────────────────
  const leadId3 = RUN + '_lead3';
  await db.doc(`leads/${leadId3}`).set({
    userId: OWNER, companyId: OWNER, stage: 'New', firstName: 'ZZ_QA Three',
  });

  // ── B) A late write to a lead that stays gone ──────────────────────
  const leadId4 = RUN + '_lead4';
  await db.doc(`leads/${leadId4}`).set({ userId: OWNER, companyId: OWNER, stage: 'New', firstName: 'ZZ_QA Four' });
  {
    const b = db.batch();
    for (let i = 0; i < 450; i++) {
      b.set(db.doc(`leads/${leadId4}/activity/old${String(i).padStart(3, '0')}`), { type: 'note', source: 'rep', i });
    }
    await b.commit();
  }
  const oldObj4 = `documents/${OWNER}/${leadId4}/old.html`;
  const lateObj4 = `documents/${OWNER}/${leadId4}/late.html`;
  await putObj(oldObj4);

  // ── C) A stranger re-creates a guessable id right after the delete ──
  const leadId5 = 'calcom__' + String(Date.now()).slice(-9);
  await db.doc(`leads/${leadId5}`).set({ userId: OWNER, companyId: OWNER, stage: 'New', firstName: 'ZZ_QA Five' });
  await db.doc(`leads/${leadId5}/notes/n1`).set({ text: 'owner-only note' });
  await db.doc(`leads/${leadId5}/signatures/Homeowner`).set({ role: 'Homeowner', png: 'data:image/png;base64,iVBORw0KGgo=' });
  await db.doc(`leads/${leadId5}/tasks/t1`).set({ title: 'owner-only task' });
  const oldObj5 = `documents/${OWNER}/${leadId5}/old.html`;
  const newObj5 = `documents/${OWNER}/${leadId5}/new.html`;
  await putObj(oldObj5);

  // Hard-delete lead1 and lead3; leave lead2 (and its appointment) alone.
  await db.doc(`leads/${leadId}`).delete();
  await db.doc(`leads/${leadId3}`).delete();
  // B: delete, and once the trigger is under way, append the way a late
  // webhook would (admin SDK).
  await db.doc(`leads/${leadId4}`).delete();
  const lateWritten = (async () => {
    await waitFor(async () => !(await exists(`leads/${leadId4}/activity/old000`)), 40000, 25);
    await db.doc(`leads/${leadId4}/activity/zzzz_late`).set({ type: 'measurement_ready', source: 'webhook' });
    await putObj(lateObj4);
  })();
  // C: delete, then at once re-create the id as someone else, with a row.
  await db.doc(`leads/${leadId5}`).delete();
  await db.doc(`leads/${leadId5}`).set({ userId: STRANGER, companyId: STRANGER, stage: 'New', firstName: 'mine now' });
  await db.doc(`leads/${leadId5}/notes/mine`).set({ text: 'the new lead\'s own note' });
  // An upload under the same {uid}/{leadId}/ prefix after the delete. Step 2
  // lists that prefix; the object is newer than the delete, so it stays.
  await putObj(newObj5);

  const gone1 = await staysGone(db.doc(`appointments/${bookingId}`));
  ok('appointment linked to a hard-deleted lead is deleted', gone1);

  const gone1b = await staysGone(db.doc(`appointments/${bookingId1b}`));
  ok('a second appointment sharing the same leadId (reschedule chain) is also swept', gone1b);

  ok("the hard-deleted lead's documents row is swept",
    await staysGone(db.doc(`leads/${leadId}/documents/d1`)));
  ok("the hard-deleted lead's warrantyClaims rows are swept",
    (await staysGone(db.doc(`leads/${leadId}/warrantyClaims/c1`)))
    && (await staysGone(db.doc(`leads/${leadId}/warrantyClaims/c2`))));

  // A.
  console.log('\n  A. the whole subtree of a hard-deleted lead');
  await waitFor(async () => {
    for (const p of Object.values(aRows)) if (await exists(p)) return false;
    return true;
  });
  for (const [label, p] of Object.entries(aRows)) ok(`A: ${label} is swept`, !(await exists(p)));
  ok('A: nothing at all is left under the deleted lead id', (await rowsUnder(db.doc(A))) === 0);
  ok('A: the HTML object a documents row named is deleted', !(await objExists(htmlObj)));
  ok('A: the object only a row\'s download URL named is deleted', !(await objExists(urlOnlyObj)));
  ok('A: a sibling lead\'s object (id starts with the deleted one) survives', await objExists(sibObj));

  // lead3's delete has no appointment to wait on; give the trigger the same
  // settle window so any crash on the empty-query path would have surfaced.
  await sleep(4000);

  const stillThere2 = await db.doc(`appointments/${bookingId2}`).get();
  ok("an unrelated lead's appointment survives (confinement)", stillThere2.exists);
  ok("an unrelated lead's warrantyClaims row survives (confinement)",
    (await db.doc(`leads/${leadId2}/warrantyClaims/c9`).get()).exists);
  ok("an unrelated lead's notes row survives (confinement)",
    await exists(`leads/${leadId2}/notes/n9`));

  const lead3Gone = await staysGone(db.doc(`leads/${leadId3}`), 5000);
  ok('a lead with no linked appointment still deletes cleanly (no crash on empty sweep)', lead3Gone);

  // B.
  console.log('\n  B. a row written after the delete, lead still gone');
  await lateWritten;
  const oldGone = await waitFor(async () => !(await exists(`leads/${leadId4}/activity/old449`))
    && !(await exists(`leads/${leadId4}/activity/old000`)));
  ok('B: the 450 old activity rows are swept (three pages)', oldGone
    && (await db.collection(`leads/${leadId4}/activity`).where('source', '==', 'rep').limit(1).get()).empty);
  await sleep(2000);
  ok('B: the row written after the delete survives (never newer than the delete)',
    await exists(`leads/${leadId4}/activity/zzzz_late`));
  ok('B: the old object under the lead prefix is deleted', !(await objExists(oldObj4)));
  ok('B: an object uploaded there after the trigger started survives', await objExists(lateObj4));

  // C.
  console.log('\n  C. a stranger re-creates the id right after the delete');
  await waitFor(async () => !(await exists(`leads/${leadId5}/notes/n1`))
    && !(await exists(`leads/${leadId5}/signatures/Homeowner`))
    && !(await exists(`leads/${leadId5}/tasks/t1`)));
  await sleep(2000);
  ok('C: the old lead\'s note, saved signature and task are gone',
    !(await exists(`leads/${leadId5}/notes/n1`))
    && !(await exists(`leads/${leadId5}/signatures/Homeowner`))
    && !(await exists(`leads/${leadId5}/tasks/t1`)));
  ok('C: the re-created lead\'s own new note survives', await exists(`leads/${leadId5}/notes/mine`));
  ok('C: the only row under the re-created id is its own', (await rowsUnder(db.doc(`leads/${leadId5}`))) === 1);
  ok('C: the re-created lead doc itself is untouched', (await db.doc(`leads/${leadId5}`).get()).get('userId') === STRANGER);
  ok('C: the old lead\'s object under the lead prefix is deleted', !(await objExists(oldObj5)));
  ok('C: an object uploaded under that prefix after the delete survives', await objExists(newObj5));

  // D. The module on its own, with a fake bucket so a Storage failure can be
  // injected and the Storage-before-row order observed.
  console.log('\n  D. sweep module: exact cutoff, re-create guard, Storage-before-row');
  {
    // The cutoff rule itself, with no timing in it: the cutoff is one row's
    // own commit time, and the next row is committed after it.
    const X = RUN + '_cut';
    const w1 = await db.doc(`leads/${X}/notes/atCutoff`).set({ text: 'committed at the cutoff' });
    await db.doc(`leads/${X}/notes/afterCutoff`).set({ text: 'committed after it' });
    const noStorage = { file: () => ({ delete: async () => {} }) };
    const r0 = await sweepLeadSubtree({ db, bucket: noStorage, leadId: X, cutoffNs: timestampToNanos(w1.writeTime) });
    ok('D: a row committed exactly at the cutoff is swept (at or before)', !(await exists(`leads/${X}/notes/atCutoff`)));
    ok('D: a row committed after the cutoff survives', await exists(`leads/${X}/notes/afterCutoff`));
    ok('D: it is counted as newer, not as a failure', r0.skippedNewer === 1 && r0.failures.length === 0);
  }
  {
    const ghost = RUN + '_ghost';
    const G = `leads/${ghost}`;
    const okObj = `documents/${OWNER}/${ghost}/ok.html`;
    const badObj = `documents/${OWNER}/${ghost}/bad.html`;
    await db.doc(`${G}/notes/old1`).set({ text: 'before the re-create' });
    await db.doc(`${G}/documents/okRow`).set({ htmlPath: okObj });
    await db.doc(`${G}/documents/badRow`).set({ htmlPath: badObj });
    await sleep(50);
    await db.doc(G).set({ userId: STRANGER, companyId: STRANGER, stage: 'New', firstName: 'ZZ_QA ghost' });
    await sleep(50);
    await db.doc(`${G}/notes/new1`).set({ text: 'after the re-create' });

    let okRowExistedAtObjectDelete = null;
    const fakeBucket = {
      file: (p) => ({
        delete: async () => {
          if (p === badObj) throw new Error('injected Storage failure');
          if (p === okObj) okRowExistedAtObjectDelete = await exists(`${G}/documents/okRow`);
        },
      }),
    };
    // An hour ahead: as if the event time were unusable and the fallback
    // (invocation start) were much later than the re-create.
    const r = await sweepLeadSubtree({
      db, bucket: fakeBucket, leadId: ghost,
      cutoffNs: BigInt(Date.now() + 3600 * 1000) * 1000000n,
    });
    ok('D: a row from before the re-create is swept', !(await exists(`${G}/notes/old1`)));
    ok('D: a row from after the re-create survives (per-page lead re-read)', await exists(`${G}/notes/new1`));
    ok('D: the sweep reports it saw the re-created lead', r.recreated === true);
    ok('D: a row\'s object is deleted while the row still exists (Storage first)', okRowExistedAtObjectDelete === true);
    ok('D: that row is then deleted', !(await exists(`${G}/documents/okRow`)));
    ok('D: a row whose object delete FAILED is kept (it is the only pointer)', await exists(`${G}/documents/badRow`));
    ok('D: the kept row is counted and the failure reported',
      r.rowsKeptForStorage === 1 && r.failures.some((f) => /injected Storage failure/.test(f)));
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  console.log('✓ All lead-artifact-cleanup integration tests passed');
}

run().then(() => process.exit(0)).catch((e) => { console.error('integration test crashed:', e && (e.stack || e.message)); process.exit(1); });
