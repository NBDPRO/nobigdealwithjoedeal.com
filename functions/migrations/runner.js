/**
 * functions/migrations/runner.js — versioned Firestore migration runner.
 *
 * Why this exists
 * ───────────────
 * Schema changes used to be ad-hoc one-shot scripts (e.g. PR #56's
 * companyId backfill on /leads). Each one re-derived "have I run
 * this yet?", "what if I run it twice?", "what if it fails halfway?"
 * from scratch. The next time the schema changes, you'd start from
 * zero again.
 *
 * This runner solves that once:
 *
 *   - Migrations live in functions/migrations/scripts/NNN-name.js,
 *     each exporting { version, name, up }.
 *   - The state doc /system/migrations tracks the highest applied
 *     version. The runner only executes scripts whose version > the
 *     stored value, in ascending order.
 *   - Each migration must be idempotent — running it twice on the
 *     same data must produce the same result. Helper utilities here
 *     enforce that for the common patterns.
 *   - Two entry points:
 *       - runMigrations    HTTPS callable, admin-only, manual trigger
 *       - migrationsTick   scheduled (daily), runs whatever's pending
 *     The schedule means "deploy a new migration script + redeploy
 *     functions" is the entire workflow — no manual Console step.
 *   - Each successful run appends to /system/migrations.history with
 *     timestamp + version + duration + docs touched, for audit.
 *
 * Failure mode
 * ────────────
 * If any migration throws, the runner stops, marks the partial run
 * in state.lastError, and does NOT advance the version. The next
 * tick (or manual call) retries from the same point. Migrations
 * MUST be written so that interrupted runs are resumable —
 * use the helpers in this module rather than rolling your own.
 *
 * @typedef {object} Migration
 * @property {number} version          Strictly ascending integer.
 * @property {string} name             Human-readable, in commit msg.
 * @property {(ctx: MigrationContext) => Promise<MigrationResult>} up
 *                                     Idempotent upgrade function.
 *
 * @typedef {object} MigrationContext
 * @property {FirebaseFirestore.Firestore} db
 * @property {(msg: string) => void}        log
 * @property {(coll: string, batchSize?: number) =>
 *           AsyncIterable<FirebaseFirestore.QuerySnapshot>}
 *           pages           Page-iterator over a collection.
 *
 * @typedef {object} MigrationResult
 * @property {number}  docsRead
 * @property {number}  docsWritten
 * @property {string=} note
 */

'use strict';

const admin = require('firebase-admin');
const { Timestamp, FieldPath, getFirestore } = require('firebase-admin/firestore');
const { getApps } = require('firebase-admin/app');
const { FieldValue } = require('firebase-admin/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('../integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler

if (!getApps().length) admin.initializeApp();

const STATE_DOC_PATH = 'system/migrations';
const HISTORY_COLLECTION = 'system/migrations/history';
const LOCK_DOC_PATH = 'system/migrations_lock';
const LEASE_MS = 15 * 60_000;  // >> a normal run; stale leases self-expire.

// 2.4: serialize the scheduled tick and the manual runMigrations callable
// so the same migration can't be run twice concurrently. Best-effort —
// a crashed holder's lease simply expires after LEASE_MS.
async function acquireMigrationLease(db) {
  const ref = db.doc(LOCK_DOC_PATH);
  const now = Date.now();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? snap.data() : null;
    if (d && d.expiresAt && d.expiresAt.toMillis() > now) return false;
    tx.set(ref, {
      lockedAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + LEASE_MS),
    });
    return true;
  });
}

async function releaseMigrationLease(db) {
  try {
    await db.doc(LOCK_DOC_PATH).set(
      { expiresAt: Timestamp.fromMillis(0) },
      { merge: true }
    );
  } catch (e) { /* lease will expire on its own */ }
}

// Resolve all migration scripts from the scripts/ subdirectory at
// require-time. Each script is a module exporting { version, name,
// up }. We sort by version ascending — runner depends on this order.
function loadMigrations() {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, 'scripts');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const mod = require(path.join(dir, f));
    if (typeof mod.version !== 'number' || !mod.name || typeof mod.up !== 'function') {
      throw new Error('Bad migration ' + f + ': must export { version: number, name: string, up: async fn }');
    }
    out.push(mod);
  }
  out.sort((a, b) => a.version - b.version);
  // Reject duplicates — strictly ascending integers.
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) {
      throw new Error('Duplicate migration version ' + out[i].version);
    }
  }
  return out;
}

/**
 * Iterate a collection in pages so we don't OOM on large sets.
 * Used by the helpers; migration scripts should reach for this
 * rather than `getAll()`.
 */
async function* paginate(db, collectionPath, batchSize = 200) {
  const coll = db.collection(collectionPath);
  let cursor = null;
  while (true) {
    let q = coll.orderBy(FieldPath.documentId()).limit(batchSize);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap;
    if (snap.size < batchSize) return;
    cursor = snap.docs[snap.docs.length - 1].id;
  }
}

/**
 * Helper for the 90% case: "for every doc in collection X, ensure
 * field F has a default value." The classic companyId-backfill
 * shape from PR #56. Idempotent — skips docs that already have the
 * field set.
 *
 * Returns { docsRead, docsWritten } for the migration result.
 */
async function backfillField(db, collectionPath, fieldName, computeValue, log) {
  let docsRead = 0;
  let docsWritten = 0;
  let batch = db.batch();
  let pending = 0;

  for await (const snap of paginate(db, collectionPath, 200)) {
    for (const doc of snap.docs) {
      docsRead++;
      const data = doc.data();
      if (data[fieldName] !== undefined && data[fieldName] !== null && data[fieldName] !== '') continue;
      const value = await computeValue(doc);
      if (value === undefined || value === null) continue;
      batch.update(doc.ref, { [fieldName]: value });
      pending++;
      docsWritten++;
      // 500 is the Firestore batch hard limit; commit at 250 so we
      // have headroom for retry-on-conflict logic without contention.
      if (pending >= 250) {
        await batch.commit();
        if (log) log('  committed ' + pending + ' updates (read so far: ' + docsRead + ')');
        batch = db.batch();
        pending = 0;
      }
    }
  }
  if (pending > 0) {
    await batch.commit();
    if (log) log('  committed final ' + pending + ' updates');
  }
  return { docsRead, docsWritten };
}

/**
 * Core runner. Reads /system/migrations to find the highest applied
 * version, runs all pending scripts in order, writes state + history
 * after each one.
 */
async function runPending() {
  const db = getFirestore();
  const migrations = loadMigrations();

  // 2.4: single-runner lease. The scheduled tick and the manual
  // runMigrations callable (or a scheduler double-fire) can otherwise run
  // concurrently — both read the same appliedVersion and run the same
  // migration twice. A 15-min lease serializes them; a stale lease from a
  // crashed run self-expires.
  const gotLease = await acquireMigrationLease(db);
  if (!gotLease) {
    console.log('[runPending] another runner holds the lease — skipping this run');
    return { ranCount: 0, appliedVersion: 0, results: [], skipped: 'locked' };
  }

  try {
  const stateRef = db.doc(STATE_DOC_PATH);
  const stateSnap = await stateRef.get();
  const state = stateSnap.exists ? stateSnap.data() : { appliedVersion: 0 };

  const pending = migrations.filter(m => m.version > (state.appliedVersion || 0));
  if (pending.length === 0) {
    return { ranCount: 0, appliedVersion: state.appliedVersion || 0, results: [] };
  }

  const results = [];
  let lastApplied = state.appliedVersion || 0;
  let lastError = null;

  for (const m of pending) {
    const start = Date.now();
    const ctx = {
      db,
      log: (msg) => console.log('[migration ' + m.version + '/' + m.name + '] ' + msg),
      pages: (coll, batchSize) => paginate(db, coll, batchSize),
      backfillField: (coll, field, fn) => backfillField(db, coll, field, fn, ctx.log),
    };

    try {
      ctx.log('starting');
      const result = await m.up(ctx);
      const duration = Date.now() - start;
      ctx.log('done in ' + duration + 'ms (read=' + result.docsRead + ', written=' + result.docsWritten + ')');

      // History first, then state — if the state write fails we'd
      // re-run the migration on the next tick, and we want the
      // history entry preserved either way.
      await db.collection(HISTORY_COLLECTION).add({
        version: m.version,
        name: m.name,
        startedAt: Timestamp.fromMillis(start),
        finishedAt: FieldValue.serverTimestamp(),
        durationMs: duration,
        docsRead: result.docsRead,
        docsWritten: result.docsWritten,
        note: result.note || '',
      });
      await stateRef.set({
        appliedVersion: m.version,
        lastRunAt: FieldValue.serverTimestamp(),
        lastError: null,
      }, { merge: true });

      lastApplied = m.version;
      results.push({ version: m.version, name: m.name, durationMs: duration, ...result });
    } catch (err) {
      lastError = String(err && err.stack || err);
      console.error('[migration ' + m.version + '/' + m.name + '] FAILED', err);
      await stateRef.set({
        appliedVersion: lastApplied,
        lastRunAt: FieldValue.serverTimestamp(),
        lastError: lastError,
        lastFailedVersion: m.version,
      }, { merge: true });
      // Stop the chain — manual intervention required to fix and
      // re-run. The next tick will retry from this same script.
      break;
    }
  }

  return {
    ranCount: results.length,
    appliedVersion: lastApplied,
    results,
    lastError,
  };
  } finally {
    await releaseMigrationLease(db);
  }
}

// HTTPS callable — manual trigger, admin-only. Use this when you
// want to run migrations immediately after deploy without waiting
// for the scheduled tick.
exports.runMigrations = onCall(
  { region: 'us-central1', enforceAppCheck: true },
  async (req) => {
    if (req.auth?.token?.role !== 'admin') {
      throw new HttpsError('permission-denied', 'admin role required');
    }
    return runPending();
  }
);

// Scheduled tick — runs daily; idempotent. Pending = 0 → no-op.
// A fixed time, not a 24-hour interval: an interval restarts at every
// deploy, and with daily deploys the tick last ran 2026-09-20 (audit
// 2026-10-03). 04:40 ET is clear of the morning jobs.
exports.migrationsTick = onSchedule(
  { schedule: 'every day 04:40', timeZone: 'America/New_York', region: 'us-central1' },
  async () => {
    const res = await runPending();
    // Always log a heartbeat (Audit #4 / 2.1) so a "no run in 26h" absence
    // alert can tell the difference between "nothing to do" and "the tick
    // silently stopped firing".
    console.log('[migrationsTick] heartbeat', JSON.stringify({
      ranCount: res.ranCount,
      appliedVersion: res.appliedVersion,
      skipped: res.skipped || null,
    }));
  }
);

// Surface the runner for tests + advanced ops paths.
exports._runPending = runPending;
exports._loadMigrations = loadMigrations;
exports._backfillField = backfillField;
