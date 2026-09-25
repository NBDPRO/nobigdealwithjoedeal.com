/**
 * functions/lead-artifact-cleanup.js — reap a deleted lead's Storage artifacts.
 *
 * THE BUG THIS CLOSES (found 2026-08-18)
 * ──────────────────────────────────────
 * Hard-deleting a lead (`window._permanentDeleteLead` →
 * `deleteDoc(doc(db,'leads',id))`) removes the Firestore doc and nothing else.
 * Firestore does not cascade to subcollections, and it has never touched
 * Storage. So every baked HTML artifact the lead accumulated survived:
 *
 *     portals/{uid}/{leadId}/v-<ts>.html      legacy customer portal
 *     portals/{uid}/{leadId}-photos.html      legacy photo portal
 *     documents/{uid}/{leadId}/d-*.html       generated + signed documents
 *     galleries/{uid}/{leadId}.html           retired share-gallery
 *     audio/{uid}/{leadId}/*                  call recordings
 *
 * Each was uploaded through the client SDK, which stamps a
 * `firebaseStorageDownloadTokens` value on the object. That token URL bypasses
 * Storage Security Rules, never expires, and has no revocation path — so the
 * artifact stayed fetchable by anyone holding the link *forever*, while the
 * only record that it existed (the lead doc) was gone. Deleting the lead
 * destroyed the pointer, not the data.
 *
 * A prod sweep found 10 such orphans across portals/, documents/ and
 * galleries/ belonging to two deleted leads. scripts/purge-legacy-storage-
 * portals.js could not see them: its discovery is lead-driven and it skips
 * `if (!leadSnap.exists)`, which is precisely the orphan case.
 *
 * WHAT THIS DOES
 * ──────────────
 * onDocumentDeleted('leads/{leadId}') → delete every leadId-keyed Storage
 * prefix for the owning uid, drop the orphaned `documents` subcollection (and
 * any Storage object its htmlPath points at, which covers older path shapes
 * the deterministic prefixes miss), and revoke the lead's outstanding portal /
 * doc-sign tokens.
 *
 * UPDATE 2026-09-03 — the photos carve-out above was wrong twice over.
 * ─────────────────────────────────────────────────────────────────
 * This docblock used to say photos were "NOT covered here, deliberately",
 * because `photos/{uid}/...` was flat per-uid and photo objects were
 * "reachable only through signImageUrl (15-min v4 signed URL, no permanent
 * token), so an orphan there is not publicly fetchable". Both halves are false:
 *
 *   1. NOT FLAT. The dominant modern shape IS leadId-keyed —
 *      `photos/{uid}/{leadId}/{ts}_{name}` (photo-engine.js, the dashboard
 *      quick-upload, photo-editor), with thumbs at
 *      `photos/{uid}/{leadId}/thumbs/` and variants at
 *      `photos/{uid}/{leadId}/_variants/`. All three reap by prefix. Only the
 *      legacy customer-page shape `photos/{uid}/{file}` is genuinely flat, and
 *      that one is reachable through the /photos collection's leadId field.
 *   2. NOT TOKEN-FREE. image-pipeline.js stamps a fresh
 *      `firebaseStorageDownloadTokens` on EVERY variant it writes (see its
 *      upload metadata). A permanent, unrevokable, rules-bypassing URL — the
 *      same leak class this trigger exists to close. A prod check found 446
 *      photos/ objects carrying one.
 *
 * So a hard-deleted lead left its entire photo set publicly fetchable forever.
 * Both shapes are now reaped below. `docs/` was also missing from the prefix
 * list while scripts/sweep-orphan-lead-artifacts.js already swept it — the
 * exact drift that script's comment warns about, in the opposite direction.
 *
 * UPDATE 2026-09-13 — linked Cal.com/appointments records were never reaped.
 * ───────────────────────────────────────────────────────────────────────
 * `appointments/{bookingId}` docs (functions/integrations/calcom.js) carry a
 * `leadId` field pointing at whichever CRM lead the booking is linked to —
 * either a pre-existing lead it matched, or the `calcom__<bookingId>` lead it
 * created for an unmatched booker. Hard-deleting that lead never touched
 * `appointments`: no client UI anywhere deletes an appointments/{id} doc
 * directly (the kanban Delete is a soft delete; the Trash drawer's Remove is
 * a bare `deleteDoc` on the lead), and Firestore does not cascade a delete
 * into a sibling top-level collection. The appointment survived forever with
 * a `leadId` pointing at nothing — same orphan class as the token
 * collections below, just undiscovered until now. Reaped in step 5.
 *
 * UPDATE 2026-09-25 — the warrantyClaims subcollection is reaped too (step 1b).
 * ─────────────────────────────────────────────────────────────────────
 * `documents` rows were swept here from the start, but the sibling
 * `leads/{id}/warrantyClaims` rows (warranty-claim.js, 2026-09-15) were not.
 * Until 2026-09-25 no client could delete either kind of row at all: their
 * `allow write` rules ran a shape validator that reads request.resource, and
 * that is null on a delete, so every client delete was denied. The rule now
 * lets the owner or same-company staff delete them while the parent lead
 * exists, because the check reads the lead.
 *
 * A row left under a hard-deleted lead is NOT sealed off by that, though.
 * Every lead subcollection rule decides "owner" by reading leads/{leadId}, and
 * the lead create rule only ties userId/companyId to the CALLER; it cannot
 * know the id was used before. A signed-in user who re-creates a deleted
 * lead's id therefore owns whatever rows are still under it, and can read,
 * change or delete them (found in review of PR #1771; reproduced on the
 * emulator against the rules before and after that PR). This sweep is what
 * closes that for documents and warrantyClaims, once it has run. The other
 * lead subcollections (tasks, notes, activity, drawings, signatures, ...) are
 * still not swept here and stay reachable that way. Follow-up: delete the
 * lead's whole subtree here, not two named subcollections. Account erasure
 * (integrations/compliance.js) recursiveDeletes every lead the user still has,
 * which covers all of them, but not a lead hard-deleted before.
 *
 * UPDATE 2026-09-25 (later) — the follow-up above is done: step 1 sweeps the
 * WHOLE subtree.
 * ─────────────────────────────────────────────────────────────────────
 * Step 1 is now lead-subtree-sweep.js: every subcollection, found with
 * listCollections() rather than named, nested ones included, each row's
 * Storage objects before the row. Steps 1 and 1b above (documents,
 * warrantyClaims) are folded into it. Two things changed on the way:
 *
 *   - The confinement for a row's Storage paths is segment-exact
 *     (isReapableLeadArtifactPath). It was `p.includes(leadId)`, and a
 *     lead's id is the creator's choice, so a lead named `html` authorised
 *     deleting any tenant's `documents/.../*.html`. Widening the old check to
 *     every subcollection would have widened that hole with it.
 *   - Race safety. A lead can come back at the same id (Cal.com and the
 *     public-lead bridge use deterministic ids with create(), and both are
 *     redelivered). Rows, and objects under the lead-keyed prefixes in step
 *     2, are deleted only if they are no newer than the delete event's time.
 *     Tokens, appointments and /photos (steps 3-5) are unchanged.
 * See documentation/audit/LEAD-SUBTREE-HIJACK-2026-09-25.md.
 *
 * NOT covered here, deliberately:
 *   - D2D knock photos (`photos/{uid}/d2d/{knockId}/...`). They belong to the
 *     knock, not the lead, and carry no /photos doc at all (image-pipeline.js
 *     routes them to the knock branch), so neither sweep below can reach them.
 *     A converted knock's lead deletion must not destroy the knock's record.
 *   - Soft delete (`deleted: true`) does NOT fire this. That is the trash bin;
 *     the lead is restorable and its artifacts must survive.
 *
 * Idempotent and best-effort throughout: a missing object, a missing
 * subcollection, or an unresolvable uid must never leave the function retrying
 * against data that is already gone.
 */

'use strict';

const { onDocumentDeleted } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

// Every Storage prefix whose path shape embeds the leadId. Kept in one place
// so a new leadId-keyed prefix is one line here rather than a fresh orphan
// class discovered years later. `flat` covers the pre-versioning shapes that
// wrote a single object at {prefix}/{uid}/{leadId}<suffix> instead of a
// directory — collectPaths() in scripts/purge-legacy-storage-portals.js
// documents where those came from.
const LEAD_KEYED_PREFIXES = [
  { prefix: 'documents', flat: [] },
  { prefix: 'portals', flat: ['.html', '-photos.html'] },
  { prefix: 'galleries', flat: ['.html', '-photos.html'] },
  { prefix: 'audio', flat: [] },
  // `docs/{uid}/{leadId}/{file}` — signed-doc uploads. Swept by
  // scripts/sweep-orphan-lead-artifacts.js since it was written, but never
  // reaped here, so every hard delete since has left a backlog for that
  // script. No `flat` entry: docs/ legitimately holds `{uid}/{file}` objects
  // whose filename must never be parsed as a leadId.
  { prefix: 'docs', flat: [] },
  // `photos/{uid}/{leadId}/...` — originals, plus `thumbs/` and `_variants/`
  // beneath the same leadId directory, so one prefix reaps all three. The flat
  // legacy shape `photos/{uid}/{file}` is not reachable this way and is handled
  // by the /photos collection sweep below.
  { prefix: 'photos', flat: [] },
];

// Pure path logic lives next door, deliberately. index.js mounts this module
// with Object.assign(exports, ...), so anything exported here joins the
// deployed Cloud Functions surface — these helpers would be test scaffolding
// in the deploy index. Keeping them in a firebase-free module also means the
// confinement check below is unit-tested for real, with no mocking:
// tests/lead-photo-reaping.test.js.
const {
  variantPathsFor, isReapablePhotoPath, isoToNanos, timestampToNanos, deleteCutoffNs,
} = require('./lead-artifact-paths');
// The whole-subtree sweep (2026-09-25). Also firebase-free: db and bucket are
// passed in, so the rules suite and scripts/audit-orphaned-lead-subtrees.js
// run this same code.
const { sweepLeadSubtree } = require('./lead-subtree-sweep');

// Step 1's share of the 540 s budget. What is left covers steps 2-5, which
// already fit in it before the subtree sweep existed (photos is the long one).
const SUBTREE_BUDGET_MS = 300 * 1000;

// Token collections that carry a leadId. A live token pointing at a deleted
// lead is the same leak class as an orphaned object: it grants a no-login
// stranger a page built from a customer record nobody can see anymore.
const LEAD_TOKEN_COLLECTIONS = ['portal_tokens', 'doc_sign_tokens'];

/**
 * Resolve the owning uid(s) for a deleted lead.
 *
 * Normally just `lead.userId`. But a lead doc that was written before the
 * ownership backfill — or corrupted — may lack it, and that is exactly the
 * lead whose artifacts nobody will ever look for again. Fall back to the uids
 * recorded on the documents subcollection, then to the uid embedded in any
 * htmlPath, so a missing userId degrades to a narrower sweep instead of none.
 *
 * @returns {Set<string>}
 */
function resolveOwnerUids(lead, docSnaps) {
  const uids = new Set();
  if (lead && typeof lead.userId === 'string' && lead.userId) uids.add(lead.userId);
  for (const d of docSnaps) {
    const m = d.data() || {};
    if (typeof m.userId === 'string' && m.userId) uids.add(m.userId);
    // documents/{uid}/{leadId}/{docId}.html — segment 1 is the owner.
    if (typeof m.htmlPath === 'string') {
      const parts = m.htmlPath.split('/');
      if (parts.length >= 3 && parts[1]) uids.add(parts[1]);
    }
  }
  return uids;
}

exports.onLeadDeleted = onDocumentDeleted(
  {
    document: 'leads/{leadId}',
    region: 'us-central1',
    // Prefix deletes fan out one HTTP call per object, sequentially. Photos
    // (2026-09-03) raised the ceiling by an order of magnitude: a 300-photo
    // reroof is ~1500 objects once thumbs and the three variants are counted,
    // and at a ~50 ms round trip that is ~75 s of deletes alone. 540 s is the
    // gen-2 event-function maximum and buys the headroom, because `retry` is
    // false — a timeout here is a permanent partial sweep, not a retry.
    timeoutSeconds: 540,
    memory: '256MiB',
    retry: false,
  },
  async (event) => {
    const leadId = event.params.leadId;
    // Client-side test leads are prefixed 'd-' and never hit Firestore, but a
    // guard here costs nothing and keeps the log clean.
    if (!leadId || leadId.startsWith('d-')) return;

    const lead = (event.data && typeof event.data.data === 'function')
      ? (event.data.data() || {})
      : {};

    const db = getFirestore();
    const bucket = getStorage().bucket();
    const startedAt = Date.now();

    let objectsDeleted = 0;
    let objectsSkippedNewer = 0;
    let tokensRevoked = 0;
    let photoDocsDeleted = 0;
    const failures = [];
    // Every object path already deleted, so the /photos sweep does not re-issue
    // a delete for something the prefix sweep just removed. Cheap insurance: a
    // 300-photo job is ~1200 objects and each redundant call is a round trip.
    const deletedPaths = new Set();

    // ── 0. The race cutoff (2026-09-25) ────────────────────────────
    // Anything under this lead id that is NEWER than the delete belongs to a
    // lead re-created at the same id (a redelivered Cal.com or public-lead
    // webhook) and must survive. event.time is the delete's commit time, on
    // the same clock as createTime/updateTime, parsed to the nanosecond.
    // deleteCutoffNs() falls back to this invocation's start when the time is
    // missing, impossible, or a whole second (the emulator truncates it; see
    // there). That is the wider choice, so the re-read of the lead doc (a
    // re-created lead's createTime) is what guards a re-create then.
    const leadUpdatedNs = event.data ? timestampToNanos(event.data.updateTime) : null;
    const { cutoffNs, source: cutoffSource } = deleteCutoffNs(event.time, leadUpdatedNs, startedAt);

    // ── 1. Owner uids, from the lead and its documents rows ─────────
    // Read BEFORE deleting anything: a documents row's userId/htmlPath is the
    // only record of an owner uid when the lead doc lacks userId, and step 2
    // scopes its prefix deletes by uid.
    let docSnaps = [];
    try {
      const snap = await db.collection(`leads/${leadId}/documents`).limit(500).get();
      docSnaps = snap.docs;
    } catch (e) {
      failures.push(`documents read: ${e.message}`);
    }

    const ownerUids = resolveOwnerUids(lead, docSnaps);
    if (!ownerUids.size) {
      // Nothing to scope a prefix delete to. Loud, because it means artifacts
      // may have survived and only the bucket-wide sweep script can find them.
      logger.error('[onLeadDeleted] no owner uid resolvable — Storage NOT swept', {
        leadId, documentsFound: docSnaps.length,
      });
    }

    // ── 1b. The lead's whole Firestore subtree (2026-09-25) ─────────
    // Replaces the two named sweeps that were here (documents, then
    // warrantyClaims). Every subcollection, nested ones included, each row's
    // Storage objects before the row, rows newer than the cutoff kept. See
    // lead-subtree-sweep.js for the design and the confinement change.
    const subtree = await sweepLeadSubtree({
      db, bucket, leadId, cutoffNs,
      deadlineAt: startedAt + SUBTREE_BUDGET_MS,
      deletedPaths,
    });
    objectsDeleted += subtree.objectsDeleted;
    for (const f of subtree.failures) failures.push(`subtree ${f}`);
    if (subtree.deadlineHit) failures.push(`subtree: stopped at the ${SUBTREE_BUDGET_MS / 1000}s budget`);
    if (subtree.rowsKeptForStorage) {
      failures.push(`subtree: ${subtree.rowsKeptForStorage} rows kept because their object delete failed`);
    }
    // A row newer than the delete while the lead is still absent is not a
    // re-created lead's data. It is an orphan that arrived late (a webhook
    // appending to a deleted lead), reachable the same way as the rest.
    if (subtree.skippedNewer && !subtree.recreated) {
      failures.push(`subtree: ${subtree.skippedNewer} rows newer than the delete left under an absent lead`);
    }

    // Uids named by this lead's own confined object paths join the prefix
    // sweep (a manager's upload to a teammate's lead sits under the manager's
    // uid). Safe to widen: every prefix delete below is scoped to
    // {prefix}/{uid}/{leadId}/. NOT passed to the /photos step, whose
    // flat-shape check trusts the uid alone.
    const prefixUids = new Set([...ownerUids, ...subtree.uidsSeen]);

    // Re-created since the delete? Then an object at or after the new lead's
    // createTime is the new lead's upload, whatever the cutoff says. One more
    // read of the lead; the subtree sweep's last look may be seconds old.
    let recreatedNs = subtree.recreatedAtNs;
    try {
      const now = await db.collection('leads').doc(leadId).get();
      const n = now.exists ? timestampToNanos(now.createTime) : null;
      if (n != null && (recreatedNs == null || n < recreatedNs)) recreatedNs = n;
    } catch (e) {
      failures.push(`lead re-check before prefixes: ${e.message}`);
    }

    // ── 2. Deterministic leadId-keyed Storage prefixes ─────────────
    for (const uid of prefixUids) {
      for (const { prefix, flat } of LEAD_KEYED_PREFIXES) {
        // Directory shape: {prefix}/{uid}/{leadId}/...
        // The trailing slash matters — without it, leadId 'abc' would also
        // match a sibling lead 'abcdef'.
        //
        // getFiles + per-object delete rather than bucket.deleteFiles(): the
        // latter resolves to `undefined` (Promise<void>), so destructuring a
        // count out of it throws — and the throw would land in the catch
        // below, silently reporting a failure while deleting nothing. Listing
        // first also gives an honest count and names each object in the log,
        // which is what makes a partial sweep visible.
        try {
          const [files] = await bucket.getFiles({ prefix: `${prefix}/${uid}/${leadId}/` });
          for (const f of files) {
            // Same race rule as the rows (2026-09-25): an object uploaded
            // after the delete belongs to a lead re-created at this id.
            // Missing metadata keeps the old behaviour (delete).
            const createdNs = isoToNanos(f.metadata && f.metadata.timeCreated);
            if (createdNs != null
                && (createdNs > cutoffNs || (recreatedNs != null && createdNs >= recreatedNs))) {
              objectsSkippedNewer++;
              continue;
            }
            try {
              await f.delete({ ignoreNotFound: true });
              deletedPaths.add(f.name);
              objectsDeleted++;
            } catch (e) {
              failures.push(`object ${f.name}: ${e.message}`);
            }
          }
        } catch (e) {
          failures.push(`prefix ${prefix}/${uid}/${leadId}/: ${e.message}`);
        }
        // Flat legacy shapes: {prefix}/{uid}/{leadId}.html etc.
        for (const suffix of flat) {
          const p = `${prefix}/${uid}/${leadId}${suffix}`;
          try {
            await bucket.file(p).delete({ ignoreNotFound: true });
            objectsDeleted++;
          } catch (e) {
            failures.push(`object ${p}: ${e.message}`);
          }
        }
      }
    }

    // ── 3. The /photos collection: flat-shape objects + orphaned docs ──
    // Two jobs the prefix sweep above cannot do:
    //
    //   a. The legacy customer-page shape `photos/{uid}/{file}` carries no
    //      leadId in its path. The only record tying it to this lead is the
    //      /photos doc, which is also the only thing that can find its
    //      `_variants/` siblings — those sit in the uid-wide
    //      `photos/{uid}/_variants/` directory SHARED with every other lead's
    //      flat photos, so it can never be prefix-deleted. They have to be
    //      named one by one, derived from the source filename.
    //   b. /photos is a TOP-LEVEL collection, not a subcollection of the lead,
    //      so Firestore cascades nothing. Without this, every hard delete
    //      leaves photo docs pointing at objects that are now gone — which is
    //      what makes a gallery render broken tiles for a customer who was
    //      never deleted, if the ids are ever reused.
    //
    // CONFINEMENT: paths are confined to `photos/{uid}/` for a uid resolved
    // from the LEAD (never from the photo doc). storagePath is client-written,
    // so trusting the doc's own userId would let anyone plant a photo doc
    // naming a victim's object, delete their own lead, and have this trigger
    // delete it for them with admin credentials. A lead with no resolvable uid
    // reaps no photos and says so, which is the safe direction to fail.
    const photoPathFields = ['storagePath', 'path', 'thumbStoragePath'];
    if (ownerUids.size) {
      let cursor = null;
      let scanned = 0;
      // A big reroof is a few hundred photos; 5000 is far past any real job and
      // exists only so a corrupt leadId cannot spin this trigger forever.
      const PHOTO_SCAN_CAP = 5000;
      let capped = false;

      while (scanned < PHOTO_SCAN_CAP) {
        let batch;
        try {
          let q = db.collection('photos').where('leadId', '==', leadId).limit(300);
          if (cursor) q = q.startAfter(cursor);
          batch = await q.get();
        } catch (e) {
          failures.push(`photos query: ${e.message}`);
          break;
        }
        if (batch.empty) break;
        cursor = batch.docs[batch.docs.length - 1];
        scanned += batch.docs.length;

        for (const photo of batch.docs) {
          const meta = photo.data() || {};
          const targets = [];
          for (const field of photoPathFields) {
            const p = meta[field];
            if (!p || typeof p !== 'string') continue;
            targets.push(p);
            targets.push(...variantPathsFor(p));
          }

          for (const p of targets) {
            if (deletedPaths.has(p)) continue;
            if (!isReapablePhotoPath(p, ownerUids)) {
              failures.push(`photo object ${p}: outside this lead's photos/{uid}/ — skipped`);
              continue;
            }
            try {
              await bucket.file(p).delete({ ignoreNotFound: true });
              deletedPaths.add(p);
              objectsDeleted++;
            } catch (e) {
              failures.push(`photo object ${p}: ${e.message}`);
            }
          }

          try {
            await photo.ref.delete();
            photoDocsDeleted++;
          } catch (e) {
            failures.push(`photo doc ${photo.id}: ${e.message}`);
          }
        }

        if (batch.docs.length < 300) break;
        if (scanned >= PHOTO_SCAN_CAP) capped = true;
      }

      if (capped) {
        // Silent truncation is how the original orphans hid. Say it loudly.
        logger.error('[onLeadDeleted] photo scan hit its cap — photos may remain', {
          leadId, scanned, cap: PHOTO_SCAN_CAP,
        });
        failures.push(`photos scan capped at ${PHOTO_SCAN_CAP}`);
      }
    } else {
      failures.push('photos: no owner uid resolvable — /photos NOT swept');
    }

    // ── 4. Outstanding tokens ──────────────────────────────────────
    for (const coll of LEAD_TOKEN_COLLECTIONS) {
      try {
        const snap = await db.collection(coll).where('leadId', '==', leadId).limit(200).get();
        for (const t of snap.docs) {
          await t.ref.delete();
          tokensRevoked++;
        }
      } catch (e) {
        failures.push(`${coll}: ${e.message}`);
      }
    }

    // ── 5. Linked Cal.com / appointments records ────────────────────
    // appointments/{bookingId}.leadId (functions/integrations/calcom.js)
    // points at whichever lead the booking is linked to — a pre-existing
    // match or the calcom__<bookingId> lead created for it. It is a
    // top-level collection Firestore never cascades into, and no client UI
    // deletes an appointments/{id} doc directly, so without this the doc
    // outlives the lead forever, `leadId` pointing at nothing. A lead is
    // rarely linked to more than a handful of bookings (one per reschedule
    // chain); 200 is far past any real case and exists only so a corrupt
    // leadId cannot spin this loop forever.
    let appointmentsDeleted = 0;
    try {
      const snap = await db.collection('appointments').where('leadId', '==', leadId).limit(200).get();
      for (const a of snap.docs) {
        try {
          await a.ref.delete();
          appointmentsDeleted++;
        } catch (e) {
          failures.push(`appointment ${a.id}: ${e.message}`);
        }
      }
    } catch (e) {
      failures.push(`appointments query: ${e.message}`);
    }

    const summary = {
      leadId,
      ownerUids: [...ownerUids],
      objectsDeleted,
      // docsDeleted/claimsDeleted keep their names so existing log queries
      // still read; they are now the subtree sweep's per-collection counts.
      docsDeleted: subtree.byCollection.documents || 0,
      claimsDeleted: subtree.byCollection.warrantyClaims || 0,
      photoDocsDeleted,
      tokensRevoked,
      appointmentsDeleted,
      // Subtree sweep (2026-09-25): counts only, collection names are code.
      subtreeRowsDeleted: subtree.rowsDeleted,
      subtreeByCollection: subtree.byCollection,
      subtreeCollectionsSeen: subtree.collectionsSeen,
      subtreeRefusedRefs: subtree.refusedRefs,
      subtreeSkippedNewer: subtree.skippedNewer,
      subtreeSkippedChanged: subtree.skippedChanged,
      subtreeExcluded: subtree.excluded,
      objectsSkippedNewer,
      recreatedDuringSweep: subtree.recreated || recreatedNs != null,
      cutoffSource,
      elapsedMs: Date.now() - startedAt,
      failures: failures.length,
    };
    if (failures.length) {
      // Best-effort by design, but a silent partial sweep is how the original
      // orphans went unnoticed for months — surface every failure.
      logger.error('[onLeadDeleted] partial sweep', { ...summary, detail: failures.slice(0, 20) });
    } else {
      logger.info('[onLeadDeleted] swept', summary);
    }
  }
);
