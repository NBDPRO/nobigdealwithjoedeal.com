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
 * UPDATE 2026-09-25 (review of PR #1777) — order, perimeter, who owns what.
 * ─────────────────────────────────────────────────────────────────────
 * A security review of the whole-subtree change reproduced four more ways
 * in. Each is fixed here or next door:
 *
 *   - TOP-LEVEL /notes. Its read rule reads the lead named by the note's
 *     leadId, so whoever re-created the id read every stage-change note of
 *     the old lead, subtree or not. Swept now (the /notes step).
 *   - Uids off ROWS. Owner uids used to include every `documents` row's
 *     userId/htmlPath uid (that row's create rule checks only `status`), and
 *     the Storage-prefix step also took the uid of any object a row named. A
 *     row naming a victim's uid aimed the prefix listing, and the /photos
 *     confinement, at that victim. Now the /photos step trusts the LEAD's
 *     userId only (row uids are a fallback for a lead without one, and only
 *     same-tenant ones), and a row uid reaches the prefix step only if it is
 *     in the lead's tenant (uidInLeadTenant).
 *   - RESERVED ids. A lead called `_variants` or `d2d` made the prefix step
 *     list `photos/{uid}/_variants/` (every flat photo's variants) or
 *     `audio/{uid}/d2d/` (D2D memos). Such a lead now revokes tokens and
 *     nothing else (isReservedLeadId), at error level.
 *   - RACES. /photos, tokens and appointments were deleted by leadId with no
 *     time check, so a redelivered Cal.com booking that re-created the lead
 *     lost its own appointment. Every step now goes through one watch
 *     (makeLeadWatch in lead-subtree-sweep.js): nothing newer than the
 *     delete, and only a same-tenant re-create may keep old docs it wrote
 *     to. Tokens are judged by create time alone.
 *
 * And the order changed: tokens, /photos, /notes and appointments run BEFORE
 * the subtree walk, which may take minutes. Those are the steps that close a
 * live link or a readable doc, so a re-creator's window is the seconds they
 * take, not the subtree's 300 s budget. Every loop checks the handler budget
 * per row, so the summary line is logged before the 540 s kill, and a start
 * line is logged first so even a killed run shows. The steps below are
 * named, not numbered; the step numbers in the notes above are the old order.
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
  isReservedLeadId, uidInLeadTenant,
} = require('./lead-artifact-paths');
// The whole-subtree sweep and the top-level lead-keyed sweep (2026-09-25).
// Also firebase-free: db and bucket are passed in, so the rules suite and
// scripts/audit-orphaned-lead-subtrees.js run this same code.
const { sweepLeadSubtree, sweepLeadKeyedDocs, makeLeadWatch } = require('./lead-subtree-sweep');

// The whole run's budget: the platform kills the function at 540 s
// (retry:false), and the summary must be logged before that. 60 s of margin.
const HANDLER_BUDGET_MS = 480 * 1000;
// The subtree walk's share, counted from the invocation start. What is left
// covers the Storage-prefix step, which fit in it before the walk existed.
const SUBTREE_BUDGET_MS = 300 * 1000;
// Row-derived uids checked against the lead's tenant, at most. Each costs a
// users/{uid} read, and rows are client-written.
const ROW_UID_CHECK_CAP = 25;

// Token collections that carry a leadId. A live token pointing at a deleted
// lead is the same leak class as an orphaned object: it grants a no-login
// stranger a page built from a customer record nobody can see anymore.
const LEAD_TOKEN_COLLECTIONS = ['portal_tokens', 'doc_sign_tokens'];

/**
 * Uids a deleted lead's `documents` rows name (their userId, and segment 1
 * of an htmlPath). CLIENT-WRITTEN, so a candidate list only: see
 * tenantUids() and the 2026-09-25 review note at the top.
 *
 * @returns {Set<string>}
 */
function rowOwnerUids(docSnaps) {
  const uids = new Set();
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

/**
 * The candidates that are in the deleted lead's tenant (uidInLeadTenant):
 * the lead's owner, its companyId (a solo tenant), or a user whose
 * server-only users/{uid}.companyId is the lead's. At most ROW_UID_CHECK_CAP
 * are looked at.
 *
 * @returns {Promise<Set<string>>}
 */
async function tenantUids(db, candidates, lead, failures) {
  const out = new Set();
  let checked = 0;
  for (const uid of candidates) {
    if (uidInLeadTenant(uid, lead, null)) { out.add(uid); continue; }
    if (typeof uid !== 'string' || !uid || uid.includes('/')) continue;
    if (typeof lead.companyId !== 'string' || !lead.companyId) continue;
    if (++checked > ROW_UID_CHECK_CAP) {
      failures.push(`row uids: more than ${ROW_UID_CHECK_CAP} to check — the rest ignored`);
      break;
    }
    try {
      const s = await db.collection('users').doc(uid).get();
      if (uidInLeadTenant(uid, lead, s.exists ? s.data() : null)) out.add(uid);
    } catch (e) {
      failures.push(`row uid check: ${e.message}`);
    }
  }
  return out;
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
    const deadlineAt = startedAt + HANDLER_BUDGET_MS;
    const late = () => Date.now() > deadlineAt;

    let objectsDeleted = 0;
    let objectsSkippedNewer = 0;
    const failures = [];
    // Every object path already handled, so no step re-issues a delete for
    // something an earlier step removed (or kept as a re-created lead's).
    // Cheap insurance: a 300-photo job is ~1200 objects, one round trip each.
    const deletedPaths = new Set();

    // ── The race cutoff (2026-09-25) ────────────────────────────────
    // Anything under this lead id that is NEWER than the delete belongs to a
    // lead re-created at the same id (a redelivered Cal.com or public-lead
    // webhook) and must survive. event.time is the delete's commit time, on
    // the same clock as createTime/updateTime, parsed to the nanosecond.
    // deleteCutoffNs() falls back to this invocation's start when the time is
    // missing, impossible, or a whole second (the emulator truncates it; see
    // there). That is the wider choice, so the watch's re-reads of the lead
    // doc (a re-created lead's createTime) are what guard a re-create then.
    const leadUpdatedNs = event.data ? timestampToNanos(event.data.updateTime) : null;
    const { cutoffNs, source: cutoffSource } = deleteCutoffNs(event.time, leadUpdatedNs, startedAt);
    // First line of every run, so a run the platform kills still shows up.
    logger.info('[onLeadDeleted] start', { leadId, cutoffSource });

    // One view of "has the lead come back, and whose is it?" for every step.
    const watch = makeLeadWatch({ db, leadId, cutoffNs, deletedLead: lead });

    // A reserved id (`d2d`, `_variants`, ...) names a folder many leads
    // share, and `leads/d2d/recordings` holds every tenant's D2D memo
    // transcripts. No product path creates one; whoever did gets their
    // tokens revoked and nothing else touched.
    const reserved = isReservedLeadId(leadId);
    if (reserved) failures.push('reserved lead id — tokens revoked, nothing else swept');

    // ── Owner uids ─────────────────────────────────────────────────
    // The lead's userId is trustworthy (the create rule pins it to the
    // creator; server writers set it). Row uids are not; see tenantUids().
    // Read BEFORE the subtree sweep deletes the documents rows.
    let docSnaps = [];
    if (!reserved) {
      try {
        const snap = await db.collection(`leads/${leadId}/documents`).limit(500).get();
        docSnaps = snap.docs;
      } catch (e) {
        failures.push(`documents read: ${e.message}`);
      }
    }
    const leadOwner = typeof lead.userId === 'string' && lead.userId ? lead.userId : null;
    const rowUids = reserved ? new Set() : await tenantUids(db, rowOwnerUids(docSnaps), lead, failures);
    // /photos confinement: the lead's owner. Only a lead WITHOUT one falls
    // back to same-tenant row uids, so it degrades to a narrower sweep.
    const ownerUids = new Set(leadOwner ? [leadOwner] : [...rowUids]);
    if (!ownerUids.size && !reserved) {
      // Nothing to scope a prefix delete to. Loud, because it means artifacts
      // may have survived and only the bucket-wide sweep script can find them.
      logger.error('[onLeadDeleted] no owner uid resolvable — Storage NOT swept', {
        leadId, documentsFound: docSnaps.length,
      });
    }

    const counts = {};
    let skippedNewerAbsent = 0; // docs newer than the delete, lead still gone
    function takeKeyed(name, r) {
      counts[name] = r.deleted;
      for (const f of r.failures) failures.push(f);
      if (r.deadlineHit) failures.push(`${name}: stopped at the ${HANDLER_BUDGET_MS / 1000}s budget`);
      if (r.capped) failures.push(`${name}: scan capped — docs may remain`);
      if (r.kept) failures.push(`${name}: ${r.kept} docs kept because an object delete failed`);
      if (!watch.recreated) skippedNewerAbsent += r.skippedNewer;
    }

    // ── Tokens ─────────────────────────────────────────────────────
    // First: a live portal or doc-sign link is the most direct leak. By
    // create time only (alwaysStrict), because every portal open bumps a
    // token's update time; a token minted after a re-create is the new
    // lead's and survives.
    let tokensRevoked = 0;
    for (const coll of LEAD_TOKEN_COLLECTIONS) {
      const r = await sweepLeadKeyedDocs({
        db, collection: coll, leadId, watch, deadlineAt, alwaysStrict: true, cap: 1000,
      });
      takeKeyed(coll, r);
      tokensRevoked += r.deleted;
    }

    // ── /photos: flat-shape objects + orphaned docs ────────────────
    // Two jobs the prefix step cannot do:
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
    //      leaves photo docs pointing at objects that are now gone. Its read
    //      rule also admits a company reader of the lead the doc names, so
    //      a re-creator can list them until this step runs: it runs early.
    //
    // CONFINEMENT: paths are confined to `photos/{uid}/` for a uid resolved
    // from the LEAD (never from the photo doc, and since 2026-09-25 never
    // from a documents row either, unless the lead has no owner and the row
    // uid is in its tenant). storagePath is client-written, so trusting the
    // doc's own userId would let anyone plant a photo doc naming a victim's
    // object, delete their own lead, and have this trigger delete it for them
    // with admin credentials. A lead with no resolvable uid reaps no photos
    // and says so, which is the safe direction to fail. A doc whose object
    // delete fails is kept (2026-09-25): it is the only pointer to the object.
    let photoDocsDeleted = 0;
    const photoPathFields = ['storagePath', 'path', 'thumbStoragePath'];
    if (reserved) {
      // nothing
    } else if (ownerUids.size) {
      const r = await sweepLeadKeyedDocs({
        db, collection: 'photos', leadId, watch, deadlineAt,
        // A big reroof is a few hundred photos; 5000 is far past any real job
        // and exists only so a corrupt leadId cannot spin this forever.
        cap: 5000,
        beforeDelete: async (photo) => {
          const meta = photo.data() || {};
          const targets = [];
          for (const field of photoPathFields) {
            const p = meta[field];
            if (!p || typeof p !== 'string') continue;
            targets.push(p);
            targets.push(...variantPathsFor(p));
          }
          let ok = true;
          for (const p of targets) {
            if (late()) return false; // keep the doc; the budget is spent
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
              ok = false;
              failures.push(`photo object ${p}: ${e.message}`);
            }
          }
          return ok;
        },
      });
      takeKeyed('photos', r);
      photoDocsDeleted = r.deleted;
      if (r.capped) {
        // Silent truncation is how the original orphans hid. Say it loudly.
        logger.error('[onLeadDeleted] photo scan hit its cap — photos may remain', {
          leadId, scanned: r.scanned,
        });
      }
    } else {
      failures.push('photos: no owner uid resolvable — /photos NOT swept');
    }

    // ── Top-level /notes (2026-09-25, review of PR #1777) ───────────
    // Activity-log notes ({leadId, userId, text}; stage-write.js,
    // crm-pipeline.js, dashboard-actions.js, ...). The /notes read rule
    // admits the owner, or a company reader, of the lead the note NAMES, so
    // they were readable by whoever re-created this id. No Storage.
    let topNotesDeleted = 0;
    if (!reserved) {
      const r = await sweepLeadKeyedDocs({ db, collection: 'notes', leadId, watch, deadlineAt });
      takeKeyed('notes', r);
      topNotesDeleted = r.deleted;
    }

    // ── Linked Cal.com / appointments records ──────────────────────
    // appointments/{bookingId}.leadId (functions/integrations/calcom.js)
    // points at whichever lead the booking is linked to — a pre-existing
    // match or the calcom__<bookingId> lead created for it. It is a
    // top-level collection Firestore never cascades into, and no client UI
    // deletes an appointments/{id} doc directly, so without this the doc
    // outlives the lead forever, `leadId` pointing at nothing. A redelivered
    // booking that re-creates the lead merges onto the same appointments doc;
    // the watch keeps it then (same tenant, written after the delete).
    let appointmentsDeleted = 0;
    if (!reserved) {
      const r = await sweepLeadKeyedDocs({ db, collection: 'appointments', leadId, watch, deadlineAt, cap: 1000 });
      takeKeyed('appointments', r);
      appointmentsDeleted = r.deleted;
    }

    // ── The lead's whole Firestore subtree (2026-09-25) ─────────────
    // Every subcollection, nested ones included, each row's Storage objects
    // before the row, rows newer than the cutoff kept. See
    // lead-subtree-sweep.js for the design and the confinement change.
    let subtree = null;
    if (!reserved) {
      subtree = await sweepLeadSubtree({
        db, bucket, leadId, cutoffNs, watch,
        deadlineAt: Math.min(startedAt + SUBTREE_BUDGET_MS, deadlineAt),
        deletedPaths,
      });
      objectsDeleted += subtree.objectsDeleted;
      objectsSkippedNewer += subtree.objectsSkippedNewer;
      for (const f of subtree.failures) failures.push(`subtree ${f}`);
      if (subtree.deadlineHit) failures.push(`subtree: stopped at the ${SUBTREE_BUDGET_MS / 1000}s budget`);
      if (subtree.rowsKeptForStorage) {
        failures.push(`subtree: ${subtree.rowsKeptForStorage} rows kept because their object delete failed`);
      }
      if (!watch.recreated) skippedNewerAbsent += subtree.skippedNewer;
    }
    // A doc newer than the delete while the lead is still absent is not a
    // re-created lead's data. It is an orphan that arrived late (a webhook
    // appending to a deleted lead), reachable the same way as the rest.
    if (skippedNewerAbsent) {
      failures.push(`${skippedNewerAbsent} docs newer than the delete left under an absent lead`);
    }

    // ── Deterministic leadId-keyed Storage prefixes ────────────────
    // Uids: the lead's owner, plus row uids (documents rows, and objects rows
    // named) that are in the lead's tenant — a manager's upload to a
    // teammate's lead sits under the manager's uid. A row uid outside the
    // tenant never gets here: it would aim this listing at a stranger.
    const prefixUids = new Set([...ownerUids, ...rowUids]);
    if (subtree && subtree.uidsSeen.size) {
      for (const u of await tenantUids(db, subtree.uidsSeen, lead, failures)) prefixUids.add(u);
    }
    // The subtree's last look at the lead may be minutes old.
    if (!reserved) await watch.refresh();
    let prefixStopped = false;
    for (const uid of (reserved ? [] : prefixUids)) {
      for (const { prefix, flat } of LEAD_KEYED_PREFIXES) {
        if (late()) { prefixStopped = true; break; }
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
            if (late()) { prefixStopped = true; break; }
            if (deletedPaths.has(f.name)) continue;
            // Same race rule as the rows: an object uploaded after the delete
            // belongs to a lead re-created at this id. Missing metadata keeps
            // the old behaviour (delete).
            if (!watch.ownsObject(isoToNanos(f.metadata && f.metadata.timeCreated))) {
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
        // Flat legacy shapes: {prefix}/{uid}/{leadId}.html etc. Judged by the
        // object's own timeCreated too (2026-09-25), and counted only when
        // there was an object to delete.
        for (const suffix of flat) {
          if (late()) { prefixStopped = true; break; }
          const p = `${prefix}/${uid}/${leadId}${suffix}`;
          if (deletedPaths.has(p)) continue;
          try {
            const [md] = await bucket.file(p).getMetadata();
            if (!watch.ownsObject(isoToNanos(md && md.timeCreated))) { objectsSkippedNewer++; continue; }
            await bucket.file(p).delete({ ignoreNotFound: true });
            deletedPaths.add(p);
            objectsDeleted++;
          } catch (e) {
            if (e && (e.code === 404 || /No such object|Not Found/i.test(String(e.message || '')))) continue;
            failures.push(`object ${p}: ${e.message}`);
          }
        }
        if (prefixStopped) break;
      }
      if (prefixStopped) break;
    }
    if (prefixStopped) failures.push(`storage prefixes: stopped at the ${HANDLER_BUDGET_MS / 1000}s budget`);
    for (const f of watch.failures) failures.push(f);

    const recreatedByOtherTenant = watch.recreated && watch.otherTenant;
    const summary = {
      leadId,
      reserved,
      ownerUids: [...ownerUids],
      objectsDeleted,
      // docsDeleted/claimsDeleted keep their names so existing log queries
      // still read; they are now the subtree sweep's per-collection counts.
      docsDeleted: subtree ? (subtree.byCollection.documents || 0) : 0,
      claimsDeleted: subtree ? (subtree.byCollection.warrantyClaims || 0) : 0,
      photoDocsDeleted,
      tokensRevoked,
      appointmentsDeleted,
      topNotesDeleted,
      // Subtree sweep (2026-09-25): counts only, collection names are code.
      subtreeRowsDeleted: subtree ? subtree.rowsDeleted : 0,
      subtreeByCollection: subtree ? subtree.byCollection : {},
      subtreeCollectionsSeen: subtree ? subtree.collectionsSeen : 0,
      subtreeRefusedRefs: subtree ? subtree.refusedRefs : 0,
      subtreeSkippedNewer: subtree ? subtree.skippedNewer : 0,
      subtreeSkippedChanged: subtree ? subtree.skippedChanged : 0,
      subtreeExcluded: subtree ? subtree.excluded : [],
      keyedDocsDeleted: counts,
      objectsSkippedNewer,
      recreatedDuringSweep: watch.recreated,
      recreatedByOtherTenant,
      cutoffSource,
      elapsedMs: Date.now() - startedAt,
      failures: failures.length,
    };
    if (recreatedByOtherTenant) {
      // Someone outside the deleted lead's tenant created a lead at this id
      // while the sweep ran. Everything that existed before it was swept
      // (strict mode), but this is what an attempt to inherit a deleted
      // customer's records looks like, so it is never an info line.
      logger.error('[onLeadDeleted] lead id re-created by another tenant during the sweep', {
        leadId, cutoffSource,
      });
    }
    if (failures.length) {
      // Best-effort by design, but a silent partial sweep is how the original
      // orphans went unnoticed for months — surface every failure.
      logger.error('[onLeadDeleted] partial sweep', { ...summary, detail: failures.slice(0, 20) });
    } else {
      logger.info('[onLeadDeleted] swept', summary);
    }
  }
);
