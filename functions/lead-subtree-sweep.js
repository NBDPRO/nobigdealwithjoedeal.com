/**
 * functions/lead-subtree-sweep.js — delete a hard-deleted lead's whole
 * Firestore subtree, Storage objects first.
 *
 * WHY (2026-09-25)
 * ────────────────
 * Every rule under leads/{leadId}/... decides "owner" by reading the PARENT
 * lead doc, and the lead create rule only ties userId/companyId to the
 * caller; it cannot know the id was used before. onLeadDeleted swept only
 * `documents` (and, from PR #1771, `warrantyClaims`). Everything else a
 * hard-deleted lead had (notes, tasks, activity, drawings, saved homeowner
 * signatures, portal messages, ...) survived, and any signed-in user of ANY
 * tenant who created leads/{sameId} became its owner and could read, change
 * or delete all of it. Most ids are random auto-ids, but Cal.com leads are
 * `calcom__` + the numeric booking id, which is guessable. Reproduced on the
 * emulator against the real rules; see
 * documentation/audit/LEAD-SUBTREE-HIJACK-2026-09-25.md.
 *
 * WHAT
 * ────
 * sweepLeadSubtree() discovers every subcollection with listCollections()
 * (so a subcollection added next year is covered without touching this
 * file), recurses into nested subcollections (including ones under a row
 * that no longer exists), and for each row it may delete:
 *   1. deletes the Storage objects the row names (storageRefsIn +
 *      isReapableLeadArtifactPath, both in lead-artifact-paths.js), then
 *   2. deletes the row.
 * If an object delete FAILS, the row is kept: it is the only pointer to that
 * object, and a later sweep (scripts/audit-orphaned-lead-subtrees.js
 * --delete) can only retry what it can still find. A path the confinement
 * check refuses is not a failure; the row still goes.
 *
 * RACE SAFETY
 * ───────────
 * A lead can legitimately come back at the same id: the Cal.com webhook and
 * the public-lead bridge both use deterministic ids with create(), and both
 * are redelivered at least once. A re-created lead's NEW rows must survive.
 * So a row is deleted only if its createTime AND updateTime are at or before
 * `cutoffNs`, the delete event's time. updateTime too: a row written again
 * after the delete (a merge onto an old signatures/{role} doc, say) now
 * carries the new lead's data.
 *
 * Before each page the lead doc is read again. If it exists, it was re-created
 * after the delete, and rows at or after its createTime are also kept. That
 * is normally implied by the cutoff; it matters when the cutoff came from a
 * fallback (no usable event time) or the event time is later than the
 * re-create. Old rows are still swept after a re-create: they belong to the
 * deleted lead, and they are exactly what a stranger would be after.
 *
 * Each page's rows go in one batch with a lastUpdateTime precondition per
 * row, so a row changed between our read and our delete is not deleted. If
 * the batch fails, the page is retried row by row, so one changed row cannot
 * strand the rest.
 *
 * LIMITS
 * ──────
 * The trigger has retry:false and a 540 s cap. The sweep pages (PAGE rows at
 * a time), stops at `deadlineAt`, and reports `deadlineHit`; the caller logs
 * any partial sweep with logger.error. Rows created after the delete while
 * the lead stays absent (a late webhook appending activity) are reported as
 * `skippedNewer` and left for the audit script.
 *
 * `leads/{uid}/leads/...` is excluded. That is the retired per-user nested
 * schema; account erasure owns it (integrations/compliance.js), no client
 * rule reaches it, and anyone can create and delete a lead doc AT a uid, so
 * sweeping it here would let a stranger erase someone else's legacy data.
 *
 * No requires beyond the pure path helpers: the caller injects `db` and
 * `bucket`, so the rules suite and the backfill script run this exact code
 * with their own firebase-admin copy.
 */

'use strict';

const {
  isReapableLeadArtifactPath,
  storageRefsIn,
  timestampToNanos,
} = require('./lead-artifact-paths');

// Rows per query page, and so per delete batch (Firestore allows 500 writes).
const PAGE = 200;
// A lead's subtree is two levels today. The cap only stops a pathological
// tree from recursing forever.
const MAX_DEPTH = 6;
// listCollections() is one RPC per row; run a few at a time.
const LIST_CONCURRENCY = 8;
// Child collections of a lead doc that are not that lead's rows (see above).
const NOT_LEAD_SUBTREE = new Set(['leads']);

// gRPC codes: 5 NOT_FOUND, 9 FAILED_PRECONDITION. Either means the row
// changed or vanished after we read it, so leaving it is correct.
function isChangedUnderUs(e) {
  return !!e && (e.code === 9 || e.code === 5
    || /FAILED_PRECONDITION|NOT_FOUND/.test(String(e.message || '')));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * @param {object}   o
 * @param {object}   o.db          admin Firestore
 * @param {object}   o.bucket      admin Storage bucket (file(p).delete)
 * @param {string}   o.leadId
 * @param {bigint}   o.cutoffNs    rows newer than this (ns since epoch) are kept
 * @param {number}   [o.deadlineAt] Date.now() ms after which no new page starts
 * @param {Set<string>} [o.deletedPaths] shared with the caller's later steps
 * @returns {Promise<object>} counts + failures; never throws
 */
async function sweepLeadSubtree(o) {
  const { db, bucket, leadId } = o;
  const cutoffNs = o.cutoffNs;
  const deadlineAt = typeof o.deadlineAt === 'number' ? o.deadlineAt : Infinity;
  const deletedPaths = o.deletedPaths || new Set();

  const res = {
    rowsDeleted: 0,
    byCollection: {},
    objectsDeleted: 0,
    refusedRefs: 0,
    rowsKeptForStorage: 0,
    skippedNewer: 0,
    skippedChanged: 0,
    collectionsSeen: 0,
    excluded: [],
    recreated: false,
    recreatedAtNs: null, // BigInt; not for logs (JSON cannot hold it)
    deadlineHit: false,
    uidsSeen: new Set(),
    failures: [],
  };

  if (typeof cutoffNs !== 'bigint') {
    res.failures.push('no cutoff time — subtree NOT swept');
    return res;
  }
  if (!leadId || typeof leadId !== 'string' || leadId.includes('/')) {
    res.failures.push('bad leadId — subtree NOT swept');
    return res;
  }

  const leadRef = db.collection('leads').doc(leadId);
  let recreatedNs = null;

  async function recheckLead() {
    try {
      const s = await leadRef.get();
      if (s.exists) {
        const n = timestampToNanos(s.createTime);
        res.recreated = true;
        if (n != null && (recreatedNs == null || n < recreatedNs)) recreatedNs = n;
        res.recreatedAtNs = recreatedNs;
      }
    } catch (e) {
      // Keep going on the event cutoff alone; it is the primary guard.
      res.failures.push(`lead re-check: ${e.message}`);
    }
  }

  function eligible(snap) {
    const c = timestampToNanos(snap.createTime);
    const u = timestampToNanos(snap.updateTime);
    if (c == null || u == null) return false; // unknown age: keep it
    if (c > cutoffNs || u > cutoffNs) return false;
    if (recreatedNs != null && (c >= recreatedNs || u >= recreatedNs)) return false;
    return true;
  }

  function bump(label, n) {
    res.byCollection[label] = (res.byCollection[label] || 0) + n;
    res.rowsDeleted += n;
  }

  async function deleteRows(snaps, label) {
    if (!snaps.length) return;
    try {
      const batch = db.batch();
      for (const d of snaps) batch.delete(d.ref, { lastUpdateTime: d.updateTime });
      await batch.commit();
      bump(label, snaps.length);
      return;
    } catch (_) {
      // One changed row fails the whole batch. Retry one by one.
    }
    for (const d of snaps) {
      try {
        await d.ref.delete({ lastUpdateTime: d.updateTime });
        bump(label, 1);
      } catch (e) {
        if (isChangedUnderUs(e)) res.skippedChanged++;
        else res.failures.push(`${label} row: ${e.message}`);
      }
    }
  }

  async function sweepChildrenOf(refs, label, depth) {
    const lists = await mapLimit(refs, LIST_CONCURRENCY, async (ref) => {
      try { return await ref.listCollections(); }
      catch (e) { res.failures.push(`${label} listCollections: ${e.message}`); return []; }
    });
    for (const subs of lists) {
      for (const c of subs) await sweepCollection(c, `${label}/*/${c.id}`, depth + 1);
    }
  }

  async function sweepCollection(coll, label, depth) {
    if (depth > MAX_DEPTH) {
      res.failures.push(`${label}: depth cap ${MAX_DEPTH} — not swept`);
      return;
    }
    res.collectionsSeen++;
    const seen = new Set();
    let cursor = null;
    for (;;) {
      if (Date.now() > deadlineAt) { res.deadlineHit = true; return; }
      // Once per page, before anything on it is judged: has the lead come
      // back? One doc read per page of rows.
      await recheckLead();
      let snap;
      try {
        let q = coll.limit(PAGE);
        if (cursor) q = q.startAfter(cursor);
        snap = await q.get();
      } catch (e) {
        res.failures.push(`${label} read: ${e.message}`);
        return;
      }
      if (snap.empty) break;
      cursor = snap.docs[snap.docs.length - 1];

      // Children first, so a nested row is never stranded under a parent
      // row this page is about to delete.
      await sweepChildrenOf(snap.docs.map((d) => d.ref), label, depth);

      const ready = [];
      for (const d of snap.docs) {
        seen.add(d.id);
        if (!eligible(d)) { res.skippedNewer++; continue; }
        let storageOk = true;
        for (const p of storageRefsIn(d.data() || {})) {
          if (!isReapableLeadArtifactPath(p, leadId)) { res.refusedRefs++; continue; }
          if (deletedPaths.has(p)) continue;
          try {
            await bucket.file(p).delete({ ignoreNotFound: true });
            deletedPaths.add(p);
            res.objectsDeleted++;
            res.uidsSeen.add(p.split('/')[1]);
          } catch (e) {
            storageOk = false;
            res.failures.push(`${label} object: ${e.message}`);
          }
        }
        if (!storageOk) { res.rowsKeptForStorage++; continue; }
        ready.push(d);
      }
      await deleteRows(ready, label);

      if (snap.size < PAGE) break;
    }

    // A nested subcollection can hang off a row that does not exist (its
    // parent was deleted on its own, or never written). A query never
    // returns such a row; listDocuments() does.
    if (Date.now() > deadlineAt) { res.deadlineHit = true; return; }
    try {
      const refs = await coll.listDocuments();
      const missing = refs.filter((r) => !seen.has(r.id));
      if (missing.length) await sweepChildrenOf(missing, label, depth);
    } catch (e) {
      res.failures.push(`${label} listDocuments: ${e.message}`);
    }
  }

  let top;
  try {
    top = await leadRef.listCollections();
  } catch (e) {
    res.failures.push(`listCollections: ${e.message}`);
    return res;
  }
  for (const coll of top) {
    if (NOT_LEAD_SUBTREE.has(coll.id)) { res.excluded.push(coll.id); continue; }
    if (Date.now() > deadlineAt) { res.deadlineHit = true; break; }
    await sweepCollection(coll, coll.id, 0);
  }
  return res;
}

module.exports = { sweepLeadSubtree, NOT_LEAD_SUBTREE, PAGE };
