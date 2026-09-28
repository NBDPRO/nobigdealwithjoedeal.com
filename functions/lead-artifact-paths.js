/**
 * functions/lead-artifact-paths.js — pure path logic for the lead-artifact reaper.
 *
 * WHY THIS IS ITS OWN MODULE
 * ──────────────────────────
 * functions/index.js mounts the reaper with `Object.assign(exports, mod)`, so
 * EVERY export of lead-artifact-cleanup.js becomes part of the deployed Cloud
 * Functions surface — and a smoke assertion (rightly) fails on any export not
 * documented in FUNCTIONS_INDEX.md. Exporting these two helpers from there
 * just to unit-test them would put test scaffolding into the deploy index.
 *
 * They also have no business needing firebase-admin: they are string
 * manipulation with a security rule attached. Keeping them here means the
 * confinement check — the security boundary of the whole trigger — is
 * testable in plain Node with zero mocking, which is the difference between a
 * boundary that is checked and one that is merely asserted in a comment.
 *
 * No imports on purpose. Anything that needs a bucket or a Firestore handle
 * belongs in lead-artifact-cleanup.js, not here.
 */

'use strict';

// Variant suffixes written by image-pipeline.js next to every source image, at
// `{sourceDir}/_variants/{base}_{name}.webp`. Deliberately duplicated rather
// than imported: requiring image-pipeline.js evaluates its onObjectFinalized
// registration at module scope, which throws without FIREBASE_CONFIG and would
// make this module untestable in plain Node. tests/lead-photo-reaping.test.js
// pins these names against that file's source so the copy cannot drift — if
// someone adds an 'xl' variant, that test goes red rather than the reaper
// silently leaving one orphan per photo behind forever.
const VARIANT_SUFFIXES = ['thumb', 'med', 'full'];

/**
 * The variant objects image-pipeline.js writes beside a source image.
 *
 * Variants land at `{sourceDir}/_variants/{base}_{name}.webp`. For the flat
 * photo shape that directory is `photos/{uid}/_variants/` — SHARED by every
 * one of that uid's flat photos across all leads — so it can never be
 * prefix-deleted and each name has to be derived. Returns [] for anything
 * without a directory or a base name rather than guessing at one.
 *
 * @param {string} objectPath
 * @returns {string[]}
 */
function variantPathsFor(objectPath) {
  if (typeof objectPath !== 'string') return [];
  const slash = objectPath.lastIndexOf('/');
  if (slash === -1) return [];
  const dir = objectPath.slice(0, slash);
  const base = objectPath.slice(slash + 1).replace(/\.[^.]+$/, '');
  if (!dir || !base) return [];
  return VARIANT_SUFFIXES.map((v) => `${dir}/_variants/${base}_${v}.webp`);
}

/**
 * May the reaper delete `p` on behalf of the deleted lead?
 *
 * THE ATTACK THIS REFUSES: photo paths come off /photos docs, and those are
 * CLIENT-WRITTEN. If we trusted a photo doc's own userId, anyone could write a
 * photos doc naming a victim's object, hard-delete their own lead, and have
 * the trigger delete someone else's file using admin credentials. So the uid
 * set passed in must be resolved from the LEAD, never from the photo doc.
 *
 * D2D knock objects are refused outright: they belong to the knock's
 * lifecycle, not the lead's, and a converted knock must survive its lead.
 *
 * Fails closed — an un-reaped orphan costs a sweep, a wrongly-reaped object
 * costs a customer their photos.
 *
 * @param {string} p object path taken from a /photos doc
 * @param {Set<string>|string[]} ownerUids uids resolved from the LEAD
 * @returns {boolean}
 */
function isReapablePhotoPath(p, ownerUids) {
  if (typeof p !== 'string' || !p) return false;
  if (p.includes('/d2d/')) return false;
  for (const uid of ownerUids) {
    if (!uid) continue;
    if (p.startsWith(`photos/${uid}/`)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// 2026-09-25 — helpers for the whole-subtree sweep (lead-subtree-sweep.js).
//
// onLeadDeleted used to sweep two named subcollections (documents,
// warrantyClaims). Every other row under a hard-deleted lead survived, and
// because each lead subcollection rule decides "owner" by reading the PARENT
// lead, whoever re-created that lead id owned the leftovers (see
// documentation/audit/LEAD-SUBTREE-HIJACK-2026-09-25.md). The sweep now walks
// the whole subtree, so it needs three things that have to be right in
// isolation: which object paths a row may make it delete, how to find those
// paths in a row it has never seen before, and exact time comparisons.
// ─────────────────────────────────────────────────────────────────────────

// Storage prefixes whose objects belong to a single lead. Mirrors
// LEAD_KEYED_PREFIXES in lead-artifact-cleanup.js (tests pin the two).
const LEAD_ARTIFACT_PREFIXES = ['documents', 'portals', 'galleries', 'audio', 'docs', 'photos'];

// Folder names that sit where a leadId sits ({prefix}/{uid}/{HERE}/...) but
// hold objects of MANY leads, or of none (2026-09-25, review of PR #1777):
//   photos/{uid}/_variants/     every flat photo's variants, across all leads
//   photos/{uid}/d2d/{knock}/   D2D knock photos
//   audio/{uid}/d2d/            D2D voice memos
//   thumbs                      a folder name the photo engine uses one level
//                               down; reserved so it never reads as a lead's
//   undefined / null            what a template literal writes for a missing id
// A lead's id is the creator's choice (the lead create rule does not constrain
// it), so a lead called `_variants` passed the segment-exact check below for
// `photos/{anyUid}/_variants/...`, and step 2's prefix listing of
// `photos/{uid}/_variants/` would have deleted every flat variant that uid has.
// No product path creates such an id: auto-ids are 20 alphanumerics, Cal.com
// ids are `calcom__<n>`, and client test leads start with `d-`.
const RESERVED_LEAD_ID_NAMES = ['d2d', 'thumbs', 'undefined', 'null'];

/**
 * Is `id` a name the reaper must never treat as one lead's folder?
 * Reserved: empty or non-string, anything starting with `_` or `.`, and the
 * names above in any case. onLeadDeleted sweeps nothing but tokens for such a
 * lead, and says so at error level.
 *
 * @param {string} id
 * @returns {boolean}
 */
function isReservedLeadId(id) {
  if (typeof id !== 'string' || !id) return true;
  if (id[0] === '_' || id[0] === '.') return true;
  return RESERVED_LEAD_ID_NAMES.includes(id.toLowerCase());
}

/**
 * May the sweep delete object `p` because a row under lead `leadId` names it?
 *
 * WHY SEGMENT-EXACT. Rows are CLIENT-written, so a row can name any path in
 * the bucket, and the trigger deletes with admin credentials. The documents
 * loop this replaces checked only `p.includes(leadId)`. A lead's id is the
 * caller's choice (the create rule does not constrain it), so a lead called
 * `html` would have authorised every `documents/.../*.html` object in the
 * bucket, every tenant's. Now the leadId has to BE a path segment:
 *
 *   {prefix}/{uid}/{leadId}/...            directory shape (every prefix)
 *   {prefix}/{uid}/{leadId}.html           legacy flat shape
 *   {prefix}/{uid}/{leadId}-photos.html    legacy flat shape
 *   docs/{uid}/{leadId}_{13-digit ms}_{name}   customer-page upload
 *
 * A live lead's id can never be re-created by someone else (the doc exists),
 * so an exact segment match cannot reach another lead's live objects. The
 * last shape needs the 13-digit timestamp straight after `{leadId}_`: without
 * it, a lead called `calcom` would match `calcom__123_...` (a Cal.com lead's
 * upload).
 *
 * Refused outright: flat `photos/{uid}/{file}` (a filename, not a leadId;
 * those are reaped through the /photos collection), anything under `d2d/`
 * (knock-owned), any empty, `.` or `..` segment, and every path at all when
 * the leadId is reserved (isReservedLeadId: `_variants`, `d2d`, ...), because
 * then the "lead folder" is a folder many leads share.
 *
 * The uid segment is NOT checked. A manager's upload to a teammate's lead
 * sits under the manager's uid, and the leadId segment is what scopes it.
 *
 * @param {string} p      object path taken from a row
 * @param {string} leadId the deleted lead's id
 * @returns {boolean}
 */
function isReapableLeadArtifactPath(p, leadId) {
  if (typeof p !== 'string' || !p || typeof leadId !== 'string' || !leadId) return false;
  if (isReservedLeadId(leadId)) return false;
  const parts = p.split('/');
  if (parts.length < 3) return false;
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return false;
  if (parts.includes('d2d')) return false;
  const prefix = parts[0];
  const third = parts[2];
  if (!LEAD_ARTIFACT_PREFIXES.includes(prefix)) return false;
  if (parts.length >= 4) return third === leadId;
  if (prefix === 'photos') return false;
  if (third === leadId + '.html' || third === leadId + '-photos.html') return true;
  if (prefix === 'docs' && third.startsWith(leadId + '_')) {
    return /^\d{13}_[^/]+$/.test(third.slice(leadId.length + 1));
  }
  return false;
}

/**
 * The object path inside a Firebase Storage URL, or null.
 *
 * Handles the two URL forms rows actually carry: the client SDK's
 * getDownloadURL() (`/v0/b/{bucket}/o/{encoded path}?alt=media&token=...`,
 * on firebasestorage.googleapis.com or the emulator) and a
 * storage.googleapis.com object URL. The bucket is ignored on purpose: the
 * caller confines the PATH, and a path confined to this lead is this lead's
 * object whichever bucket the row claimed.
 *
 * @param {string} u
 * @returns {string|null}
 */
function storagePathFromUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return null;
  let url;
  try { url = new URL(u); } catch (_) { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  let m = /^\/v0\/b\/[^/]+\/o\/([^/]+)$/.exec(url.pathname);
  if (!m && url.hostname === 'storage.googleapis.com') m = /^\/[^/]+\/(.+)$/.exec(url.pathname);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (_) { return null; }
}

/**
 * Every Storage object path a row refers to, found by shape, not field name.
 *
 * A fixed field list (htmlPath, archivePath) is how the documents loop missed
 * the `url`-only rows the customer-page upload writes, and a subtree sweep
 * meets rows it has never seen. So: walk the row (bounded depth and count),
 * keep strings that start with a lead-artifact prefix, and pull the path out
 * of Storage URLs. Nothing here decides whether a path may be deleted —
 * isReapableLeadArtifactPath() does that, so an over-eager match here costs a
 * refusal, not an object.
 *
 * Long strings are skipped before any parsing: a saved signature is a
 * `data:image/png;base64,...` string of tens of kilobytes.
 *
 * @param {object} data a row's data()
 * @returns {string[]}
 */
function storageRefsIn(data) {
  const out = new Set();
  const MAX_DEPTH = 4;
  const MAX_REFS = 50;
  (function walk(v, depth) {
    if (out.size >= MAX_REFS) return;
    if (typeof v === 'string') {
      if (v.length > 2048) return;
      if (/^[a-z]+:\/\//i.test(v)) {
        const p = storagePathFromUrl(v);
        if (p) out.add(p);
      } else if (LEAD_ARTIFACT_PREFIXES.includes(v.split('/')[0]) && v.includes('/')) {
        out.add(v);
      }
      return;
    }
    if (depth >= MAX_DEPTH || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 200)) walk(x, depth + 1);
      return;
    }
    // Plain maps only. A Timestamp, GeoPoint or DocumentReference is an
    // object too, and none of them holds a path worth deleting.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return;
    for (const k of Object.keys(v)) walk(v[k], depth + 1);
  })(data, 0);
  return [...out];
}

/**
 * RFC 3339 time -> BigInt nanoseconds since the epoch, or null.
 *
 * Exact on purpose. The race rule is "delete rows created AT OR BEFORE the
 * delete", and a CloudEvent `time` and a row's createTime both carry
 * sub-millisecond digits. Date.parse would round both to the millisecond, and
 * a row written in the same millisecond as the delete, after it, would be
 * swept.
 *
 * @param {string} iso e.g. 2026-09-25T22:07:31.123456789Z
 * @returns {bigint|null}
 */
function isoToNanos(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i.exec(iso.trim());
  if (!m) return null;
  const ms = Date.parse(m[1] + m[3].toUpperCase());
  if (!Number.isFinite(ms)) return null;
  return BigInt(ms) * 1000000n + BigInt((m[2] || '').padEnd(9, '0'));
}

/**
 * Firestore Timestamp ({seconds, nanoseconds}) -> BigInt nanoseconds, or null.
 * @param {{seconds:number, nanoseconds:number}} ts
 * @returns {bigint|null}
 */
function timestampToNanos(ts) {
  if (!ts || !Number.isInteger(ts.seconds) || !Number.isInteger(ts.nanoseconds)) return null;
  return BigInt(ts.seconds) * 1000000000n + BigInt(ts.nanoseconds);
}

/**
 * The race cutoff for one onLeadDeleted run: rows and objects NEWER than it
 * are left alone, because they may belong to a lead re-created at the id.
 *
 * Normally the delete event's `time`, which is the delete's commit time on
 * the same clock as every row's createTime. Three cases fall back to the
 * invocation's start (always after the delete, so every row of the deleted
 * lead is still at or before it; the sweep's per-page re-read of the lead
 * then guards a re-create):
 *
 *   - no usable time;
 *   - a time earlier than the lead's own last write, which a real delete
 *     cannot have;
 *   - a time on an exact second. The Firestore EMULATOR builds ce-time as
 *     the publish instant truncated to whole seconds (read from the emulator
 *     jar: FunctionsEmulatorEventPublisher.createHttpHeaders ->
 *     stripNanoSecond -> Instant.truncatedTo(SECONDS)), which can put it up
 *     to a second BEFORE the delete, and every row written in that second
 *     would look newer than the delete and survive. A real commit time lands
 *     on an exact second about once in a million deletes; the fallback costs
 *     that run a little precision, nothing else.
 *
 * @param {string} eventTime        the CloudEvent `time`
 * @param {bigint|null} leadUpdatedNs the deleted doc's last updateTime
 * @param {number} startedAtMs      Date.now() at invocation start
 * @returns {{cutoffNs: bigint, source: string}}
 */
function deleteCutoffNs(eventTime, leadUpdatedNs, startedAtMs) {
  const t = isoToNanos(eventTime);
  const fallback = BigInt(Math.floor(startedAtMs)) * 1000000n;
  if (t == null) return { cutoffNs: fallback, source: 'invocation-start (no event time)' };
  if (typeof leadUpdatedNs === 'bigint' && t < leadUpdatedNs) {
    return { cutoffNs: fallback, source: 'invocation-start (event time before the lead\'s last write)' };
  }
  if (t % 1000000000n === 0n) return { cutoffNs: fallback, source: 'invocation-start (whole-second event time)' };
  return { cutoffNs: t, source: 'event.time' };
}

/**
 * Was the lead re-created by the SAME tenant that owned the deleted one?
 *
 * WHY (2026-09-25, review of PR #1777). The sweep keeps a row that was
 * written after the delete, because a lead re-created at the same id by a
 * redelivered webhook may have merged onto an old row id. A stranger can use
 * that too: re-create the id, write one field onto each old row, and every
 * old row (a saved signature, a note) is "newer" and kept forever, content
 * and all. Reproduced on the emulator. So that allowance is only for the
 * deleted lead's own tenant; anyone else's re-create keeps nothing that
 * existed before it.
 *
 * companyId decides when both sides carry one (a teammate is the same
 * tenant); otherwise userId. Unknown on either side is NOT the same tenant.
 *
 * @param {object|null} deleted the deleted lead's data (the event's before-image)
 * @param {object|null} now     the re-created lead's data
 * @returns {boolean}
 */
function sameLeadTenant(deleted, now) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const d = deleted || {};
  const n = now || {};
  if (str(d.companyId) && str(n.companyId)) return d.companyId === n.companyId;
  if (str(d.userId) && str(n.userId)) return d.userId === n.userId;
  return false;
}

/**
 * Does a row or doc belong to the DELETED lead, so the sweep may delete it?
 *
 * Every time is BigInt nanoseconds (timestampToNanos). Kept, always:
 *   - unknown create or update time;
 *   - created after the cutoff (the delete), or at/after a re-create.
 * With `strict` false, also kept: written (updateTime) after the cutoff or
 * at/after a re-create — a re-created lead of the same tenant may have merged
 * onto an old row id, and that row is its data now.
 * With `strict` true, the update time is ignored: a row that existed before
 * the delete is the deleted lead's, whoever has written to it since. The
 * caller uses strict unless the lead was re-created by the same tenant
 * (sameLeadTenant), and always for tokens, whose update time moves on every
 * portal open.
 *
 * @param {{createNs: bigint|null, updateNs: bigint|null, cutoffNs: bigint,
 *          recreatedNs: bigint|null, strict: boolean}} o
 * @returns {boolean}
 */
function belongsToDeletedLead(o) {
  const { createNs, updateNs, cutoffNs, recreatedNs, strict } = o || {};
  if (typeof createNs !== 'bigint' || typeof updateNs !== 'bigint' || typeof cutoffNs !== 'bigint') return false;
  if (createNs > cutoffNs) return false;
  if (typeof recreatedNs === 'bigint' && createNs >= recreatedNs) return false;
  if (!strict) {
    if (updateNs > cutoffNs) return false;
    if (typeof recreatedNs === 'bigint' && updateNs >= recreatedNs) return false;
  }
  return true;
}

/**
 * May a uid that came off a ROW (not the lead) widen a Storage sweep?
 *
 * WHY (2026-09-25, review of PR #1777). Rows are client-written: a
 * `documents` row's userId (its create rule checks only `status`) or any
 * string in any row can name another tenant's uid. Step 2 of onLeadDeleted
 * lists `{prefix}/{uid}/{leadId}/` for every uid it holds, and the /photos
 * step confines deletes to `photos/{uid}/`, so an unchecked row uid let a
 * stranger aim the trigger's admin credentials at someone else's objects.
 * Reproduced on the emulator: a documents row naming the victim's uid plus a
 * /photos doc naming the victim's flat photo, on the attacker's own lead,
 * deleted the victim's photo.
 *
 * A row uid counts only when it is in the deleted lead's tenant: it IS the
 * lead's owner, or it is the lead's companyId (a solo tenant's companyId is
 * its uid), or the uid's own users/{uid} doc carries that companyId (a field
 * clients cannot write: firestore.rules freezes companyId on /users).
 *
 * @param {string} uid
 * @param {object} lead     the deleted lead's data
 * @param {object|null} userDoc users/{uid} data, or null when absent
 * @returns {boolean}
 */
function uidInLeadTenant(uid, lead, userDoc) {
  if (typeof uid !== 'string' || !uid || uid.includes('/')) return false;
  const l = lead || {};
  if (typeof l.userId === 'string' && l.userId && uid === l.userId) return true;
  const cid = typeof l.companyId === 'string' ? l.companyId : '';
  if (!cid) return false;
  if (uid === cid) return true;
  return !!userDoc && typeof userDoc.companyId === 'string' && userDoc.companyId === cid;
}

module.exports = {
  VARIANT_SUFFIXES,
  variantPathsFor,
  isReapablePhotoPath,
  LEAD_ARTIFACT_PREFIXES,
  RESERVED_LEAD_ID_NAMES,
  isReservedLeadId,
  isReapableLeadArtifactPath,
  storagePathFromUrl,
  storageRefsIn,
  isoToNanos,
  timestampToNanos,
  deleteCutoffNs,
  sameLeadTenant,
  belongsToDeletedLead,
  uidInLeadTenant,
};
