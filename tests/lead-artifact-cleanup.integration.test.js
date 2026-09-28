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
 * 2026-09-25 (review of PR #1777): the review reproduced four more ways a
 * re-creator inherited the deleted lead, and each fix is pinned here:
 *   A. a top-level /notes doc naming the lead is swept (its read rule reads
 *      the lead the note names).
 *   R. leads named `_variants` / `d2d`, and a documents row naming another
 *      user's uid, never aim the trigger at someone else's objects or at
 *      leads/d2d/recordings; a legacy lead without userId trusts only
 *      same-tenant row uids.
 *   E. the module: same-tenant vs stranger re-create (E1, E3), a row changed
 *      between read and delete (E2), top-level docs under the same watch
 *      (E4), reserved ids (E5), the per-row deadline (E6), a row-named object
 *      judged by its own timeCreated (E7).
 *   P. functions/portal.js in-process: a re-creator's portal token shows
 *      none of the old tenant's estimate / invoice / signed PDF, and a
 *      planted estimate or invoice never reaches a live lead's homeowner.
 * These write photos/ and audio/ objects too, all text/html, so neither
 * Storage-triggered function acts on them.
 *
 * RUN (CI):
 *   npx firebase-tools emulators:exec --only functions,firestore,storage --project demo-nbd-pl \
 *     "node tests/lead-artifact-cleanup.integration.test.js"
 * RUN (a machine with a shared emulator already up; no emulator is started):
 *   see documentation/audit/LEAD-SUBTREE-HIJACK-2026-09-25.md, "How the
 *   tests were run": the real handler fires in-process from a --require
 *   preload, against a dedicated project id, with Storage in memory (since
 *   the review fixes: the shared Storage emulator, dedicated bucket).
 */
'use strict';

const path = require('path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { sweepLeadSubtree, sweepLeadKeyedDocs, makeLeadWatch } = require(path.join(__dirname, '..', 'functions', 'lead-subtree-sweep.js'));
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
  // Review of PR #1777: a TOP-LEVEL /notes doc naming the lead. Its read rule
  // reads the lead the note names, so a re-creator read these too.
  const topNote1 = `notes/${RUN}_tn1`;
  await db.doc(topNote1).set({ leadId, userId: OWNER, text: 'Stage moved to Inspected' });

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
  const topNote9 = `notes/${RUN}_tn9`;
  await db.doc(topNote9).set({ leadId: leadId2, userId: OWNER, text: 'keep me too' });

  // ── R) Reserved ids and row-supplied uids (review of PR #1777) ─────
  // A lead's id is the creator's choice. `_variants` made step 2 list a
  // victim's `photos/{uid}/_variants/` (every flat photo's variants), and
  // `d2d` their D2D memos, once a row (a documents row's userId is not
  // checked by its create rule) or a string in any row named the victim's
  // uid. `leads/d2d/recordings` also holds every user's D2D transcripts.
  const VICTIM = RUN + 'Victim';
  const varObjA = `photos/${VICTIM}/_variants/1790000000000_a_thumb.webp`;
  const varObjB = `photos/${VICTIM}/_variants/1790000000000_b_med.webp`;
  const memoObj = `audio/${VICTIM}/d2d/K1_1790000000000.webm`;
  const knockPhoto = `photos/${VICTIM}/d2d/K1/1790000000000_a.jpg`;
  // The lead owner's OWN shared folders: a reserved id must not reach them
  // either (a lead named `_variants` would list its creator's, or a
  // same-tenant teammate's, whole variants folder).
  const ownVariant = `photos/${STRANGER}/_variants/1790000000000_c_full.webp`;
  const ownMemo = `audio/${STRANGER}/d2d/K2_1790000000000.webm`;
  for (const p of [varObjA, varObjB, memoObj, knockPhoto, ownVariant, ownMemo]) await putObj(p);
  const tokVariants = `ZZQA${Date.now()}RV`;
  const tokD2d = `ZZQA${Date.now()}RD`;
  await db.doc('leads/_variants').set({ userId: STRANGER, companyId: STRANGER, stage: 'New', firstName: 'ZZ_QA' });
  await db.doc('leads/_variants/notes/n1').set({ text: varObjA });
  await db.doc('leads/_variants/documents/x').set({ status: 'draft', userId: VICTIM });
  await db.doc(`portal_tokens/${tokVariants}`).set({ leadId: '_variants', ownerUid: STRANGER });
  await db.doc('leads/d2d').set({ userId: STRANGER, companyId: STRANGER, stage: 'New', firstName: 'ZZ_QA' });
  await db.doc('leads/d2d/documents/x').set({ status: 'draft', userId: VICTIM });
  await db.doc(`leads/d2d/recordings/${RUN}_K1`).set({ userId: VICTIM, transcript: 'another user\'s D2D memo' });
  await db.doc(`portal_tokens/${tokD2d}`).set({ leadId: 'd2d', ownerUid: STRANGER });
  // An ordinary id, same trick through the /photos step: a documents row
  // naming the victim, and a /photos doc naming the victim's flat photo.
  const leadId6 = RUN + '_lead6';
  const victimFlat = `photos/${VICTIM}/1790000000000_kitchen.jpg`;
  const ownFlat = `photos/${STRANGER}/1790000000001_own.jpg`;
  await putObj(victimFlat);
  await putObj(ownFlat);
  await db.doc(`leads/${leadId6}`).set({ userId: STRANGER, companyId: STRANGER, stage: 'New', firstName: 'ZZ_QA Six' });
  await db.doc(`leads/${leadId6}/documents/x`).set({ status: 'draft', userId: VICTIM });
  await db.doc(`photos/${RUN}_p6victim`).set({ userId: STRANGER, companyId: STRANGER, leadId: leadId6, storagePath: victimFlat });
  await db.doc(`photos/${RUN}_p6own`).set({ userId: STRANGER, companyId: STRANGER, leadId: leadId6, storagePath: ownFlat });
  // A legacy lead WITHOUT a userId: the /photos step falls back to row uids,
  // and only a row uid in the lead's tenant may count. A teammate (server-only
  // users/{uid}.companyId = the lead's) does; the victim does not.
  const leadId7 = RUN + '_lead7';
  const MATE = RUN + 'Mate';
  const victimFlat7 = `photos/${VICTIM}/1790000000002_porch.jpg`;
  const mateFlat7 = `photos/${MATE}/1790000000003_ridge.jpg`;
  await putObj(victimFlat7);
  await putObj(mateFlat7);
  await db.doc(`users/${MATE}`).set({ displayName: 'ZZ_QA Mate', companyId: STRANGER });
  await db.doc(`leads/${leadId7}`).set({ companyId: STRANGER, stage: 'New', firstName: 'ZZ_QA Seven (legacy, no userId)' });
  await db.doc(`leads/${leadId7}/documents/v`).set({ status: 'draft', userId: VICTIM });
  await db.doc(`leads/${leadId7}/documents/m`).set({ status: 'draft', userId: MATE });
  await db.doc(`photos/${RUN}_p7victim`).set({ userId: MATE, companyId: STRANGER, leadId: leadId7, storagePath: victimFlat7 });
  await db.doc(`photos/${RUN}_p7mate`).set({ userId: MATE, companyId: STRANGER, leadId: leadId7, storagePath: mateFlat7 });

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
  // A legacy FLAT-shape object at the same id, written after the delete.
  // Step 2 deletes these by name; since the review of PR #1777 it checks
  // their timeCreated like everything else.
  const newFlat5 = `portals/${OWNER}/${leadId5}.html`;
  await putObj(newFlat5);
  // R: the reserved ids and lead6.
  await db.doc('leads/_variants').delete();
  await db.doc('leads/d2d').delete();
  await db.doc(`leads/${leadId6}`).delete();
  await db.doc(`leads/${leadId7}`).delete();

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
  ok('A: a top-level /notes doc naming the deleted lead is swept', await staysGone(db.doc(topNote1)));

  // lead3's delete has no appointment to wait on; give the trigger the same
  // settle window so any crash on the empty-query path would have surfaced.
  await sleep(4000);

  const stillThere2 = await db.doc(`appointments/${bookingId2}`).get();
  ok("an unrelated lead's appointment survives (confinement)", stillThere2.exists);
  ok("an unrelated lead's warrantyClaims row survives (confinement)",
    (await db.doc(`leads/${leadId2}/warrantyClaims/c9`).get()).exists);
  ok("an unrelated lead's notes row survives (confinement)",
    await exists(`leads/${leadId2}/notes/n9`));
  ok("an unrelated lead's top-level /notes doc survives (confinement)", await exists(topNote9));

  // R.
  console.log('\n  R. reserved ids and row-supplied uids never aim the trigger at someone else');
  // Tokens are the one thing a reserved id's delete still sweeps, so their
  // absence says the trigger has run.
  ok('R: the trigger ran for `_variants` and `d2d` (their tokens are revoked)',
    (await staysGone(db.doc(`portal_tokens/${tokVariants}`))) && (await staysGone(db.doc(`portal_tokens/${tokD2d}`))));
  ok('R: the victim\'s variant a `_variants` row named survives', await objExists(varObjA));
  ok('R: the rest of the victim\'s shared variants folder survives', await objExists(varObjB));
  ok('R: the victim\'s D2D memo survives a `d2d` lead\'s delete', await objExists(memoObj));
  ok('R: the victim\'s D2D knock photo survives too', await objExists(knockPhoto));
  ok('R: another user\'s leads/d2d/recordings row survives', await exists(`leads/d2d/recordings/${RUN}_K1`));
  ok('R: the creator of lead "_variants" keeps their own shared variants', await objExists(ownVariant));
  ok('R: the creator of lead "d2d" keeps their own D2D memos', await objExists(ownMemo));
  ok('R: lead6\'s own flat photo doc is swept (the trigger ran)', await staysGone(db.doc(`photos/${RUN}_p6own`)));
  ok('R: lead6\'s own flat photo object is deleted', !(await objExists(ownFlat)));
  ok('R: the victim\'s flat photo named through a documents row\'s uid survives', await objExists(victimFlat));
  ok('R: a legacy lead without userId still reaps its teammate\'s flat photo (same-tenant row uid)',
    (await staysGone(db.doc(`photos/${RUN}_p7mate`))) && !(await objExists(mateFlat7)));
  ok('R: ...but not the flat photo of a victim its documents row names', await objExists(victimFlat7));

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
  ok('C: a flat-shape object written at that id after the delete survives', await objExists(newFlat5));

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

  // E. Who may keep an old row (review of PR #1777), deterministic: every
  // cutoff is a real commit time. Two of these guards had no test at all
  // (removing either left the suite green); the other two are the fixes.
  console.log('\n  E. sweep module: same-tenant vs stranger re-create, change under the delete, reserved ids');
  const SAME = { userId: OWNER, companyId: OWNER };
  const noStorageE = { file: () => ({ delete: async () => {} }) };
  // A bucket whose delete of `obj` writes to `rowPath` first: a row changes
  // between the page read and the row delete, every time, on cue.
  const changingBucket = (obj, rowPath) => ({
    file: (p) => ({
      delete: async () => { if (p === obj) await db.doc(rowPath).set({ touched: Date.now() }, { merge: true }); },
    }),
  });
  {
    // E1. The updateTime half of the rule: the SAME tenant re-creates the
    // lead (a redelivered webhook) and merges onto an old row id.
    const E1 = RUN + '_e1';
    await db.doc(`leads/${E1}/signatures/Homeowner`).set({ png: 'data:image/png;base64,OLD' });
    const w = await db.doc(`leads/${E1}/notes/untouched`).set({ text: 'old' });
    await db.doc(`leads/${E1}`).set({ ...SAME, stage: 'New', firstName: 'ZZ_QA e1' });
    await db.doc(`leads/${E1}/signatures/Homeowner`).set({ signedAgain: true }, { merge: true });
    const r = await sweepLeadSubtree({ db, bucket: noStorageE, leadId: E1, cutoffNs: timestampToNanos(w.writeTime), deletedLead: SAME });
    ok('E1: an old row the same tenant\'s re-create wrote to survives (it is the new lead\'s now)',
      await exists(`leads/${E1}/signatures/Homeowner`));
    ok('E1: an old row nobody touched is swept', !(await exists(`leads/${E1}/notes/untouched`)));
    ok('E1: reported as a same-tenant re-create', r.recreated === true && r.recreatedByOtherTenant === false);
  }
  {
    // E2. The lastUpdateTime precondition: a row changes between the read
    // and the delete, and the change makes it the same-tenant re-create's.
    const E2 = RUN + '_e2';
    const obj = `documents/${OWNER}/${E2}/x.html`;
    const row = `leads/${E2}/documents/changing`;
    const w = await db.doc(row).set({ htmlPath: obj });
    await db.doc(`leads/${E2}`).set({ ...SAME, stage: 'New', firstName: 'ZZ_QA e2' });
    const r = await sweepLeadSubtree({ db, bucket: changingBucket(obj, row), leadId: E2, cutoffNs: timestampToNanos(w.writeTime), deletedLead: SAME });
    ok('E2: a row written between the read and the delete is not deleted blind', await exists(row));
    ok('E2: counted as changed, not as a failure', r.skippedChanged === 1 && r.failures.length === 0);
  }
  {
    // E3. A STRANGER re-creates the id and writes one field onto each old
    // row. Before the fix every one of them was kept, content and all.
    const E3 = RUN + '_e3';
    const obj = `documents/${OWNER}/${E3}/y.html`;
    const row = `leads/${E3}/documents/changing`;
    await db.doc(`leads/${E3}/signatures/Homeowner`).set({ png: 'data:image/png;base64,SIG', signerName: 'ZZ_QA Homeowner' });
    await db.doc(`leads/${E3}/notes/n1`).set({ text: 'claim #ZZ-77' });
    const w = await db.doc(row).set({ htmlPath: obj });
    await db.doc(`leads/${E3}`).set({ userId: STRANGER, companyId: STRANGER, stage: 'New', firstName: 'mine now' });
    await db.doc(`leads/${E3}/signatures/Homeowner`).set({ touchedBy: 'stranger' }, { merge: true });
    await db.doc(`leads/${E3}/notes/n1`).set({ touchedBy: 'stranger' }, { merge: true });
    await db.doc(`leads/${E3}/notes/mine`).set({ text: 'the stranger\'s own' });
    const r = await sweepLeadSubtree({ db, bucket: changingBucket(obj, row), leadId: E3, cutoffNs: timestampToNanos(w.writeTime), deletedLead: SAME });
    ok('E3: an old signature a stranger wrote to after re-creating the id is swept', !(await exists(`leads/${E3}/signatures/Homeowner`)));
    ok('E3: an old note a stranger wrote to is swept', !(await exists(`leads/${E3}/notes/n1`)));
    ok('E3: an old row changed mid-delete is still swept (judged again, deleted on retry)', !(await exists(row)));
    ok('E3: the stranger\'s own new row survives', await exists(`leads/${E3}/notes/mine`));
    ok('E3: reported as another tenant\'s re-create', r.recreatedByOtherTenant === true && r.failures.length === 0);
  }
  {
    // E4. Top-level docs keyed by leadId, through the same watch.
    const E4 = RUN + '_e4';
    await db.doc(`notes/${RUN}_e4old`).set({ leadId: E4, text: 'old' });
    await db.doc(`appointments/${RUN}_e4bk`).set({ leadId: E4, status: 'booked' });
    const tok = `ZZQA${Date.now()}E4`;
    await db.doc(`portal_tokens/${tok}`).set({ leadId: E4, ownerUid: OWNER, uses: 0 });
    const w = await db.doc(`appointments/${RUN}_e4old`).set({ leadId: E4, status: 'cancelled' });
    // The same tenant's redelivery re-creates the lead and rewrites its
    // booking; the old portal link is opened once more; a new note lands.
    await db.doc(`leads/${E4}`).set({ ...SAME, stage: 'New', firstName: 'ZZ_QA e4' });
    await db.doc(`appointments/${RUN}_e4bk`).set({ redelivered: true }, { merge: true });
    await db.doc(`portal_tokens/${tok}`).set({ uses: 1 }, { merge: true });
    await db.doc(`notes/${RUN}_e4new`).set({ leadId: E4, text: 'new' });
    const watch = makeLeadWatch({ db, leadId: E4, cutoffNs: timestampToNanos(w.writeTime), deletedLead: SAME });
    const rn = await sweepLeadKeyedDocs({ db, collection: 'notes', leadId: E4, watch });
    const ra = await sweepLeadKeyedDocs({ db, collection: 'appointments', leadId: E4, watch });
    const rt = await sweepLeadKeyedDocs({ db, collection: 'portal_tokens', leadId: E4, watch, alwaysStrict: true });
    ok('E4: the old top-level note is swept', !(await exists(`notes/${RUN}_e4old`)));
    ok('E4: a top-level note written after the re-create survives', await exists(`notes/${RUN}_e4new`));
    ok('E4: the booking the redelivery rewrote survives', await exists(`appointments/${RUN}_e4bk`));
    ok('E4: an old booking nobody touched is swept', !(await exists(`appointments/${RUN}_e4old`)));
    ok('E4: an old token is revoked even though it was opened after the delete (create time only)',
      !(await exists(`portal_tokens/${tok}`)));
    ok('E4: counts', rn.deleted === 1 && ra.deleted === 1 && rt.deleted === 1
      && rn.failures.length + ra.failures.length + rt.failures.length === 0);
  }
  {
    // E6. The budget is checked per row, not only per page: a page of rows
    // that each name a slow object must stop at the deadline, so the trigger
    // gets to log before the platform kills it.
    const E6 = RUN + '_e6';
    const b = db.batch();
    for (let i = 0; i < 6; i++) b.set(db.doc(`leads/${E6}/documents/d${i}`), { htmlPath: `documents/${OWNER}/${E6}/d${i}.html` });
    await b.commit();
    const slow = { file: () => ({ delete: () => new Promise((r) => setTimeout(r, 400)) }) };
    const t0 = Date.now();
    const r = await sweepLeadSubtree({ db, bucket: slow, leadId: E6, cutoffNs: (BigInt(Date.now()) + 5n) * 1000000n, deadlineAt: Date.now() + 1500 });
    const took = Date.now() - t0;
    ok('E6: a page stops at the deadline mid-page (' + r.rowsDeleted + ' of 6 rows)', r.deadlineHit === true && r.rowsDeleted >= 1 && r.rowsDeleted < 6);
    ok('E6: and returns promptly (' + took + ' ms)', took < 4000);
  }
  {
    // E7. An object a row names is judged by its own timeCreated: re-uploaded
    // to the same path after the re-create, it is the new lead's, while the
    // old row that named it still goes. Real Storage (the emulator).
    const E7 = RUN + '_e7';
    const obj = `documents/${OWNER}/${E7}/same.html`;
    const w = await db.doc(`leads/${E7}/documents/old`).set({ htmlPath: obj });
    await db.doc(`leads/${E7}`).set({ ...SAME, stage: 'New', firstName: 'ZZ_QA e7' });
    await sleep(20);
    await putObj(obj);
    const r = await sweepLeadSubtree({ db, bucket, leadId: E7, cutoffNs: timestampToNanos(w.writeTime), deletedLead: SAME });
    ok('E7: the old row is swept', !(await exists(`leads/${E7}/documents/old`)));
    ok('E7: the object re-uploaded at its path after the re-create survives', await objExists(obj));
    ok('E7: counted as newer, not deleted', r.objectsSkippedNewer === 1 && r.objectsDeleted === 0 && r.failures.length === 0);
  }
  {
    // E5. A reserved id is never swept, whatever the caller.
    const r = await sweepLeadSubtree({ db, bucket: noStorageE, leadId: '_variants', cutoffNs: BigInt(Date.now()) * 1000000n });
    ok('E5: the sweep refuses a reserved lead id outright',
      r.rowsDeleted === 0 && r.failures.some((f) => /reserved/.test(f)) && (await exists('leads/_variants/notes/n1')));
  }

  // P. The portal view, the real handler run in-process (review of PR
  // #1777). Estimates, invoices and e-sign envelopes are top-level, keyed by
  // leadId, and never swept (financial / executed-contract records). A
  // stranger who re-created the id minted a token and the view served the
  // old tenant's shared estimate, unpaid invoice + Stripe link, and a signed
  // URL to its completed e-sign PDF. And anyone could write an estimate or
  // invoice with a victim's LIVE lead id and have it shown to that
  // homeowner. Firestore only; the functions emulator is not needed.
  console.log('\n  P. homeowner portal: records scoped to the token\'s tenant');
  {
    const { createRequire } = require('module');
    const crypto = require('crypto');
    const { EventEmitter } = require('events');
    const { Timestamp } = require('firebase-admin/firestore');
    const fnReq = createRequire(path.join(__dirname, '..', 'functions', 'package.json'));
    const fnApp = fnReq('firebase-admin/app');
    if (!fnApp.getApps().length) {
      // A throwaway key, so getSignedUrl can sign locally. Never a real one.
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      fnApp.initializeApp({ projectId: PROJECT, storageBucket: BUCKET,
        credential: fnApp.cert({ projectId: PROJECT, clientEmail: `zzqa@${PROJECT}.iam.gserviceaccount.com`, privateKey }) });
    }
    if (!process.env.FIREBASE_CONFIG) process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, storageBucket: BUCKET });
    const portal = require(path.join(__dirname, '..', 'functions', 'portal.js'));
    let ipN = 0;
    const call = (handler, body) => new Promise((resolve, reject) => {
      const headers = {};
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200, headersSent: false,
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; }, getHeader(k) { return headers[String(k).toLowerCase()]; },
        set(k, v) { headers[String(k).toLowerCase()] = v; return res; }, status(c) { res.statusCode = c; return res; },
        json(b) { resolve({ status: res.statusCode, body: b }); }, send(b) { resolve({ status: res.statusCode, body: b }); },
        end() { resolve({ status: res.statusCode, body: null }); },
      });
      const ip = `10.77.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
      Promise.resolve(handler({ method: 'POST', headers: { 'x-forwarded-for': ip }, ip, body }, res)).catch(reject);
    });
    const view = (token) => call(portal.getHomeownerPortalView, { token });
    const later = () => Timestamp.fromMillis(Date.now() + 7 * 86400e3);

    const A = RUN + 'RepA', coA = RUN + 'CoA', B = RUN + 'RepB', coB = RUN + 'CoB';
    const PX = 'calcom__' + String(Date.now()).slice(-9);
    await db.doc(`users/${A}`).set({ displayName: 'ZZ_QA Rep A', companyId: coA });
    await db.doc(`users/${B}`).set({ displayName: 'ZZ_QA Rep B', companyId: coB });
    await db.doc(`leads/${PX}`).set({ userId: A, companyId: coA, stage: 'New', firstName: 'ZZ_QA', lastName: 'Homeowner' });
    await db.doc(`estimates/${RUN}_estA`).set({ leadId: PX, userId: A, companyId: coA, grandTotal: 18450,
      sharedWithHomeowner: true, createdAt: Timestamp.now() });
    await db.doc(`invoices/${RUN}_invA`).set({ leadId: PX, createdBy: A, companyId: coA, balanceDue: 9225,
      stripePaymentLink: 'https://buy.stripe.com/test_zzqa_A', createdAt: Timestamp.now() });
    await db.doc(`esign_envelopes/${RUN}_envA`).set({ leadId: PX, ownerUid: A, companyId: coA, status: 'completed',
      title: 'ZZ_QA change order (signed)', signedPath: `esign/${A}/${PX}/${RUN}_envA/signed.pdf` });
    const TA = `ZZQA${Date.now()}PA`;
    await db.doc(`portal_tokens/${TA}`).set({ leadId: PX, ownerUid: A, companyId: coA, expiresAt: later(), uses: 0, maxUses: 100 });

    const va = await view(TA);
    const vaDocs = ((va.body || {}).documents || []).map((d) => d.name);
    ok('P: control — the tenant\'s own token shows its estimate, balance and signed document',
      va.status === 200 && va.body.estimate && va.body.estimate.grandTotal === 18450
      && va.body.balance && va.body.balance.amountCents === 922500
      && vaDocs.includes('ZZ_QA change order (signed)'));

    // Hard delete; a stranger of another tenant re-creates the id and mints
    // a link for it (createPortalToken would allow it: canManageLead passes).
    await db.doc(`leads/${PX}`).delete();
    await db.doc(`leads/${PX}`).set({ userId: B, companyId: coB, stage: 'New', firstName: 'Attacker' });
    const TB = `ZZQA${Date.now()}PB`;
    await db.doc(`portal_tokens/${TB}`).set({ leadId: PX, ownerUid: B, companyId: coB, expiresAt: later(), uses: 0, maxUses: 100 });
    const vb = await view(TB);
    const vbDocs = ((vb.body || {}).documents || []).map((d) => d.name);
    ok('P: the re-creator\'s view opens (their own lead)', vb.status === 200);
    ok('P: ...with none of the old tenant\'s estimate', !(vb.body && vb.body.estimate));
    ok('P: ...none of its unpaid invoice or Stripe link', !(vb.body && vb.body.balance));
    ok('P: ...and none of its signed e-sign PDF', !vbDocs.includes('ZZ_QA change order (signed)'));
    const ea = await call(portal.getEstimateForView, { token: TB, estimateId: `${RUN}_estA` });
    ok('P: getEstimateForView refuses the old tenant\'s estimate by id', ea.status === 403);
    // The old tenant's link must not open the new tenant's lead (until the
    // trigger revokes it, it still exists).
    const vaAfter = await view(TA);
    ok('P: the old tenant\'s link does not open the re-created lead', vaAfter.status === 404);

    // Injection onto a LIVE lead: B writes records with A's lead id.
    const PY = RUN + '_live';
    await db.doc(`leads/${PY}`).set({ userId: A, companyId: coA, stage: 'New', firstName: 'ZZ_QA Live' });
    await db.doc(`estimates/${RUN}_estY`).set({ leadId: PY, userId: A, companyId: coA, grandTotal: 12000,
      sharedWithHomeowner: true, createdAt: Timestamp.fromMillis(Date.now() - 60000) });
    await db.doc(`estimates/${RUN}_estYfake`).set({ leadId: PY, userId: B, companyId: coB, grandTotal: 1,
      sharedWithHomeowner: true, createdAt: Timestamp.now() });
    await db.doc(`invoices/${RUN}_invYfake`).set({ leadId: PY, createdBy: B, companyId: coB, balanceDue: 1,
      stripePaymentLink: 'https://buy.stripe.com/test_zzqa_B', createdAt: Timestamp.now() });
    const TY = `ZZQA${Date.now()}PY`;
    await db.doc(`portal_tokens/${TY}`).set({ leadId: PY, ownerUid: A, companyId: coA, expiresAt: later(), uses: 0, maxUses: 100 });
    const vy = await view(TY);
    ok('P: a homeowner sees their rep\'s estimate, not a newer one another tenant planted',
      vy.status === 200 && vy.body.estimate && vy.body.estimate.grandTotal === 12000);
    ok('P: ...and no planted invoice or payment link', !(vy.body && vy.body.balance));
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
  console.log('✓ All lead-artifact-cleanup integration tests passed');
}

run().then(() => process.exit(0)).catch((e) => { console.error('integration test crashed:', e && (e.stack || e.message)); process.exit(1); });
