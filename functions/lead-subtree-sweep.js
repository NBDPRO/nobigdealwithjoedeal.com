/**
 * functions/lead-subtree-sweep.js — delete a hard-deleted lead's whole
 * Firestore subtree, Storage objects first; and the lead-keyed top-level docs
 * the same way.
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
 * sweepLeadKeyedDocs() (review of PR #1777, 2026-09-25) does the same for a
 * TOP-LEVEL collection whose docs carry `leadId`: /notes (its read rule
 * reads the lead named by the note's leadId, so a re-creator read them),
 * /photos, the token collections and /appointments.
 *
 * RACE SAFETY
 * ───────────
 * A lead can legitimately come back at the same id: the Cal.com webhook and
 * the public-lead bridge both use deterministic ids with create(), and both
 * are redelivered at least once. A re-created lead's NEW rows must survive.
 * makeLeadWatch() holds that rule for every step:
 *   - never a row CREATED after `cutoffNs` (the delete event's time) or at
 *     or after the re-created lead's createTime;
 *   - if the lead was re-created by the SAME tenant (sameLeadTenant), also
 *     never a row WRITTEN after either: a redelivery may have merged onto an
 *     old row id (a signatures/{role} doc, an appointments/{bookingId} doc),
 *     and that row is the new lead's data now;
 *   - otherwise (the lead is still gone, or someone else re-created it) the
 *     write time does not count. Before this, a stranger who re-created the
 *     id and wrote one field onto each old row kept every one of them,
 *     content and all, and the run logged success. Reproduced on the
 *     emulator (review of PR #1777).
 *
 * The lead doc is read again before every page. Each page's rows go in one
 * batch with a lastUpdateTime precondition per row, so a row changed between
 * our read and our delete is not deleted blind. If the batch fails, the page
 * is retried row by row: re-read the lead and the row, judge again, and try
 * again with the row's new update time (three tries, then a loud failure).
 * So a changed row is kept only if it now belongs to a same-tenant re-create.
 *
 * Storage objects a row names are judged the same way, by their own
 * timeCreated: an object re-uploaded to the same path after the delete is the
 * new lead's.
 *
 * LIMITS
 * ──────
 * The trigger has retry:false and a 540 s cap. Both sweeps take `deadlineAt`
 * and check it before every page AND every row, so the caller always gets to
 * log what it did; they report `deadlineHit` and the caller logs a partial
 * sweep with logger.error. Rows created after the delete while the lead stays
 * absent (a late webhook appending activity) are reported as `skippedNewer`
 * and left for the audit script.
 *
 * `leads/{uid}/leads/...` is excluded. That is the retired per-user nested
 * schema; account erasure owns it (integrations/compliance.js), no client
 * rule reaches it, and anyone can create and delete a lead doc AT a uid, so
 * sweeping it here would let a stranger erase someone else's legacy data.
 *
 * A reserved lead id (isReservedLeadId: `d2d`, `_variants`, ...) is never
 * swept. `leads/d2d/recordings/*` holds every tenant's D2D memo transcripts
 * (voice-intelligence reads `audio/{uid}/d2d/...` as lead `d2d`), and anyone
 * can create and delete `leads/d2d`.
 *
 * No requires beyond the pure path helpers: the caller injects `db` and
 * `bucket`, so the rules suite and the backfill script run this exact code
 * with their own firebase-admin copy.
 */

'use strict';

const {
  isReapableLeadArtifactPath,
  isReservedLeadId,
  storageRefsIn,
  timestampToNanos,
  isoToNanos,
  sameLeadTenant,
  belongsToDeletedLead,
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
// A row that keeps changing under the delete is retried this many times.
const DELETE_ATTEMPTS = 3;

// gRPC codes: 5 NOT_FOUND, 9 FAILED_PRECONDITION. Either means the row
// changed or vanished after we read it.
function isChangedUnderUs(e) {
  return !!e && (e.code === 9 || e.code === 5
    || /FAILED_PRECONDITION|NOT_FOUND/.test(String(e.message || '')));
}

function isObjectMissing(e) {
  return !!e && (e.code === 404 || /No such object|Not Found/i.test(String(e.message || '')));
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
 * The re-create state of leads/{leadId}, shared by every step of one run.
 *
 * @param {object} o
 * @param {object} o.db
 * @param {string} o.leadId
 * @param {bigint} o.cutoffNs
 * @param {object|null} [o.deletedLead] the deleted lead's data (before-image);
 *        unknown means any re-create is treated as another tenant's
 */
function makeLeadWatch(o) {
  const { db, leadId, cutoffNs } = o;
  const deletedLead = o.deletedLead || null;
  const ref = db.collection('leads').doc(leadId);
  const w = {
    cutoffNs,
    recreated: false,
    recreatedNs: null, // BigInt, earliest re-create seen; not for logs
    otherTenant: false, // sticky: once seen, strict for the rest of the run
    failures: [],
    async refresh() {
      try {
        const s = await ref.get();
        if (!s.exists) return;
        w.recreated = true;
        const n = timestampToNanos(s.createTime);
        if (n != null && (w.recreatedNs == null || n < w.recreatedNs)) w.recreatedNs = n;
        if (!sameLeadTenant(deletedLead, s.data() || {})) w.otherTenant = true;
      } catch (e) {
        // Keep going on the event cutoff alone; it is the primary guard.
        w.failures.push(`lead re-check: ${e.message}`);
      }
    },
    // Only a same-tenant re-create may keep old rows it has written to.
    strict() {
      return !(w.recreated && !w.otherTenant);
    },
    owns(snap, alwaysStrict) {
      return belongsToDeletedLead({
        createNs: timestampToNanos(snap.createTime),
        updateNs: timestampToNanos(snap.updateTime),
        cutoffNs,
        recreatedNs: w.recreatedNs,
        strict: !!alwaysStrict || w.strict(),
      });
    },
    // A Storage object, by its timeCreated. Unknown: delete (the old
    // behaviour; every object this is asked about was named by an old row or
    // listed under the deleted lead's own folder).
    ownsObject(createdNs) {
      if (typeof createdNs !== 'bigint') return true;
      if (createdNs > cutoffNs) return false;
      if (w.recreatedNs != null && createdNs >= w.recreatedNs) return false;
      return true;
    },
  };
  return w;
}

/**
 * Delete `snaps` if they still belong to the deleted lead. Counts into `res`
 * (deleted, skippedChanged, failures) and calls onDeleted(n) for each commit.
 */
async function deleteOwned(snaps, { db, watch, label, res, alwaysStrict, onDeleted }) {
  if (!snaps.length) return;
  try {
    const batch = db.batch();
    for (const d of snaps) batch.delete(d.ref, { lastUpdateTime: d.updateTime });
    await batch.commit();
    onDeleted(snaps.length);
    return;
  } catch (_) {
    // One changed row fails the whole batch. Retry one by one.
  }
  for (const d of snaps) {
    let cur = d;
    for (let attempt = 1; ; attempt++) {
      try {
        await cur.ref.delete({ lastUpdateTime: cur.updateTime });
        onDeleted(1);
        break;
      } catch (e) {
        if (!isChangedUnderUs(e)) { res.failures.push(`${label} row: ${e.message}`); break; }
      }
      // Changed or gone since we read it. Judge it again as it is now.
      await watch.refresh();
      let fresh;
      try { fresh = await cur.ref.get(); } catch (e) { res.failures.push(`${label} re-read: ${e.message}`); break; }
      if (!fresh.exists) break; // someone else deleted it; nothing left to do
      if (!watch.owns(fresh, alwaysStrict)) { res.skippedChanged++; break; } // the re-created lead's now
      if (attempt >= DELETE_ATTEMPTS) {
        res.failures.push(`${label} row: still the deleted lead's but changed ${DELETE_ATTEMPTS} times under the delete — kept`);
        break;
      }
      cur = fresh;
    }
  }
}

/**
 * @param {object}   o
 * @param {object}   o.db          admin Firestore
 * @param {object}   o.bucket      admin Storage bucket (file(p).delete, .getMetadata)
 * @param {string}   o.leadId
 * @param {bigint}   o.cutoffNs    rows newer than this (ns since epoch) are kept
 * @param {object}   [o.watch]     makeLeadWatch() shared with the caller's other steps
 * @param {object}   [o.deletedLead] the deleted lead's data, when no watch is passed
 * @param {number}   [o.deadlineAt] Date.now() ms after which no new page or row starts
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
    objectsSkippedNewer: 0,
    refusedRefs: 0,
    rowsKeptForStorage: 0,
    skippedNewer: 0,
    skippedChanged: 0,
    collectionsSeen: 0,
    excluded: [],
    recreated: false,
    recreatedByOtherTenant: false,
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
  if (isReservedLeadId(leadId)) {
    res.failures.push('reserved lead id — subtree NOT swept');
    return res;
  }

  const watch = o.watch || makeLeadWatch({ db, leadId, cutoffNs, deletedLead: o.deletedLead });
  const leadRef = db.collection('leads').doc(leadId);
  const late = () => Date.now() > deadlineAt;

  function bump(label, n) {
    res.byCollection[label] = (res.byCollection[label] || 0) + n;
    res.rowsDeleted += n;
  }

  // One object a row names: 'deleted' | 'newer' | 'failed'.
  async function deleteNamedObject(p, label) {
    const f = bucket.file(p);
    if (typeof f.getMetadata === 'function') {
      try {
        const [md] = await f.getMetadata();
        if (!watch.ownsObject(isoToNanos(md && md.timeCreated))) return 'newer';
      } catch (e) {
        if (isObjectMissing(e)) return 'deleted'; // already gone
        res.failures.push(`${label} object: ${e.message}`);
        return 'failed';
      }
    }
    try {
      await f.delete({ ignoreNotFound: true });
      return 'deleted';
    } catch (e) {
      res.failures.push(`${label} object: ${e.message}`);
      return 'failed';
    }
  }

  async function sweepChildrenOf(refs, label, depth) {
    const lists = await mapLimit(refs, LIST_CONCURRENCY, async (ref) => {
      if (late()) return [];
      try { return await ref.listCollections(); }
      catch (e) { res.failures.push(`${label} listCollections: ${e.message}`); return []; }
    });
    for (const subs of lists) {
      for (const c of subs) {
        if (late()) { res.deadlineHit = true; return; }
        await sweepCollection(c, `${label}/*/${c.id}`, depth + 1);
      }
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
      if (late()) { res.deadlineHit = true; return; }
      // Once per page, before anything on it is judged: has the lead come
      // back, and whose is it? One doc read per page of rows.
      await watch.refresh();
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
        // Per row, not only per page: a page of rows naming many objects can
        // outrun the budget, and the caller must get to log before the hard
        // timeout kills the process.
        if (late()) { res.deadlineHit = true; break; }
        if (!watch.owns(d)) { res.skippedNewer++; continue; }
        let storageOk = true;
        for (const p of storageRefsIn(d.data() || {})) {
          if (!isReapableLeadArtifactPath(p, leadId)) { res.refusedRefs++; continue; }
          if (deletedPaths.has(p)) continue;
          const r = await deleteNamedObject(p, label);
          if (r === 'failed') { storageOk = false; continue; }
          deletedPaths.add(p);
          if (r === 'newer') { res.objectsSkippedNewer++; continue; }
          res.objectsDeleted++;
          res.uidsSeen.add(p.split('/')[1]);
        }
        if (!storageOk) { res.rowsKeptForStorage++; continue; }
        ready.push(d);
      }
      await deleteOwned(ready, { db, watch, label, res, onDeleted: (n) => bump(label, n) });

      if (res.deadlineHit) return;
      if (snap.size < PAGE) break;
    }

    // A nested subcollection can hang off a row that does not exist (its
    // parent was deleted on its own, or never written). A query never
    // returns such a row; listDocuments() does.
    if (late()) { res.deadlineHit = true; return; }
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
    if (late()) { res.deadlineHit = true; break; }
    await sweepCollection(coll, coll.id, 0);
  }
  res.recreated = watch.recreated;
  res.recreatedByOtherTenant = watch.recreated && watch.otherTenant;
  res.recreatedAtNs = watch.recreatedNs;
  if (!o.watch) for (const f of watch.failures) res.failures.push(f);
  return res;
}

/**
 * Delete the docs of a TOP-LEVEL collection that point at the deleted lead
 * through their `leadId` field, under the same race rule as the subtree.
 *
 * @param {object}   o
 * @param {object}   o.db
 * @param {string}   o.collection  e.g. 'notes'
 * @param {string}   o.leadId
 * @param {object}   o.watch       makeLeadWatch()
 * @param {number}   [o.deadlineAt]
 * @param {boolean}  [o.alwaysStrict] judge by create time only (tokens: every
 *                   portal open bumps their update time)
 * @param {function} [o.beforeDelete] async (snap) => boolean; false keeps the doc
 *                   (the /photos step deletes the doc's objects here first)
 * @param {number}   [o.cap]       stop after this many docs scanned
 * @returns {Promise<object>} counts + failures; never throws
 */
async function sweepLeadKeyedDocs(o) {
  const { db, collection, leadId, watch, alwaysStrict, beforeDelete } = o;
  const deadlineAt = typeof o.deadlineAt === 'number' ? o.deadlineAt : Infinity;
  const cap = typeof o.cap === 'number' ? o.cap : 5000;
  const res = {
    deleted: 0, scanned: 0, skippedNewer: 0, skippedChanged: 0, kept: 0,
    capped: false, deadlineHit: false, failures: [],
  };
  if (!leadId || typeof leadId !== 'string' || !watch) {
    res.failures.push(`${collection}: bad call — NOT swept`);
    return res;
  }
  let cursor = null;
  for (;;) {
    if (Date.now() > deadlineAt) { res.deadlineHit = true; break; }
    if (res.scanned >= cap) { res.capped = true; break; }
    await watch.refresh();
    let snap;
    try {
      let q = db.collection(collection).where('leadId', '==', leadId).limit(PAGE);
      if (cursor) q = q.startAfter(cursor);
      snap = await q.get();
    } catch (e) {
      res.failures.push(`${collection} query: ${e.message}`);
      break;
    }
    if (snap.empty) break;
    cursor = snap.docs[snap.docs.length - 1];
    res.scanned += snap.size;

    const ready = [];
    for (const d of snap.docs) {
      if (Date.now() > deadlineAt) { res.deadlineHit = true; break; }
      if (!watch.owns(d, alwaysStrict)) { res.skippedNewer++; continue; }
      if (beforeDelete) {
        let ok = false;
        try { ok = await beforeDelete(d); } catch (e) { res.failures.push(`${collection} ${d.id}: ${e.message}`); }
        if (!ok) { res.kept++; continue; }
      }
      ready.push(d);
    }
    await deleteOwned(ready, {
      db, watch, label: collection, res, alwaysStrict,
      onDeleted: (n) => { res.deleted += n; },
    });
    if (res.deadlineHit) break;
    if (snap.size < PAGE) break;
  }
  return res;
}

module.exports = {
  sweepLeadSubtree,
  sweepLeadKeyedDocs,
  makeLeadWatch,
  NOT_LEAD_SUBTREE,
  PAGE,
};
