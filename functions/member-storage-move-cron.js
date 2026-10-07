/**
 * functions/member-storage-move-cron.js — finishes removed members' file
 * moves (member-storage-move.js) that removeMember's inline slice did not.
 *
 * Every 5 minutes: each member_offboarding/{id} still `running` gets one
 * bounded slice. The slice takes a lease first, so this never overlaps the
 * inline run or a slow previous tick. Nothing running = one empty query.
 */
'use strict';

const { onSchedule } = require('./integrations/heartbeat');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getAuth } = require('firebase-admin/auth');
const { STATE_COLLECTION, runMemberStorageMove } = require('./member-storage-move');

const TICK_BUDGET_MS = 240_000;

async function resumeAll({ db, bucket, auth, now = Date.now } = {}) {
  const started = now();
  const running = await db.collection(STATE_COLLECTION).where('status', '==', 'running').limit(20).get();
  const results = [];
  for (const d of running.docs) {
    const left = TICK_BUDGET_MS - (now() - started);
    if (left < 20_000) break;
    try {
      const r = await runMemberStorageMove(db, bucket, d.id, { auth, logger, deadlineMs: Math.min(left - 10_000, 120_000) });
      results.push({ id: d.id, status: r.status, phase: r.phase });
    } catch (e) {
      logger.error('resumeMemberStorageMoves.slice failed', { id: d.id, msg: e && e.message });
    }
  }
  if (results.length) logger.info('resumeMemberStorageMoves', { results });
  return results;
}

exports.resumeMemberStorageMoves = onSchedule(
  {
    region: 'us-central1',
    schedule: 'every 5 minutes',
    timeZone: 'America/New_York',
    timeoutSeconds: 300,
    memory: '512MiB',
    maxInstances: 1,
  },
  async () => {
    await resumeAll({ db: getFirestore(), bucket: getStorage().bucket(), auth: getAuth() });
  }
);

exports._test = { resumeAll };
