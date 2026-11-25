/**
 * functions/backup-freshness.js — the alarm that would have caught it.
 *
 * WHAT HAPPENED (2026-09-03)
 * ──────────────────────────
 * Three Firestore backup functions — dailyFirestoreBackup (03:15),
 * nightlyFirestoreBackup (04:00) and firestoreBackupRetention (03:45) — were
 * deployed, ACTIVE and scheduled, and had failed EVERY NIGHT since the day
 * they shipped. Two independent causes: the destination bucket had never been
 * created (firestore-backup.js's own docstring says the operator must, and
 * nobody did), and the runtime service account holds roles/editor, which
 * deliberately excludes datastore.databases.export. Both are fixed.
 *
 * The database had never once been backed up, and nothing said so. Adding a
 * backup was not the fix — the backups already existed. The missing piece was
 * anything at all checking the OUTCOME.
 *
 * firestore-backup.js already named the artifact to check:
 *   "Success/failure of the export itself lands in the GCS bucket as
 *    `*.overall_export_metadata` files; operator checks there."
 * No operator ever did. This function is that operator.
 *
 * DESIGN NOTES, each one load-bearing
 * ───────────────────────────────────
 * 1. IT IS A SEPARATE FUNCTION, not a section of healthDigestCron. The digest
 *    is informational and, more importantly, is gated on
 *    HEALTH_DIGEST_ENABLED — an alarm that a config flag can silently switch
 *    off is the bug, not the fix.
 * 2. IT HAS NO ENABLE GATE, deliberately, unlike most crons here. There is no
 *    legitimate reason to run this system with its backup alarm turned off,
 *    and every *_ENABLED flag is one more way for this to go quiet again.
 * 3. IT CHECKS THE MARKER, NOT THE FUNCTION LOGS. A failing export writes
 *    nothing; a partial one leaves output-* files with no marker. Only
 *    `overall_export_metadata` means "an export finished". Checking the
 *    artifact rather than the process is what makes this independent of
 *    whatever broke.
 * 4. IT FAILS LOUD. No marker, an unreadable timestamp, or a future-dated one
 *    all raise the alarm. "Cannot tell" must never render as "fine" — see
 *    backup-freshness-logic.js.
 * 5. IT EMAILS. The old failures were visible in Cloud Logging the whole time
 *    and nobody was reading Cloud Logging. It queues to email_queue/, the same
 *    path healthDigestCron uses and emailQueueWorker drains — including
 *    status:'pending', without which the worker never claims the row (a
 *    silent-drop that health-digest.js documents in its own comment).
 */

'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const { assessBackupFreshness, isExportMarker } = require('./backup-freshness-logic');

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'nobigdeal-pro';
// Same derivation as firestore-backup.js's BUCKET, deliberately duplicated
// rather than imported: requiring that module would pull in its own schedule
// registrations, and a checker that cannot load without the thing it checks is
// not independent of it. tests/backup-freshness.test.js pins the two in step.
const BACKUP_BUCKET = `${PROJECT_ID}-firestore-backups`;

const RECIPIENT = 'jd@nobigdealwithjoedeal.com';

exports.backupFreshnessCron = onSchedule(
  {
    // 06:00 ET — after the 03:15 and 04:00 exports, with room for a slow one.
    schedule: '0 6 * * *',
    timeZone: 'America/New_York',
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: '256MiB',
    retry: false,
    // owner-notify.js may text the owner (roadmap step 13).
    secrets: require('./owner-notify').SMS_SECRETS,
  },
  async () => {
    const nowMs = Date.now();
    let newestMarkerMs = null;
    let markerName = null;
    let listFailed = null;

    try {
      const bucket = getStorage().bucket(BACKUP_BUCKET);
      const [files] = await bucket.getFiles();
      for (const f of files) {
        if (!isExportMarker(f.name)) continue;
        const md = f.metadata || {};
        const t = Date.parse(md.updated || md.timeCreated || '');
        if (!isFinite(t)) continue;
        if (newestMarkerMs === null || t > newestMarkerMs) {
          newestMarkerMs = t;
          markerName = f.name;
        }
      }
    } catch (e) {
      // A bucket that does not exist is EXACTLY the state this alarm was born
      // from, so a listing failure raises the alarm rather than skipping it.
      listFailed = e.message || String(e);
    }

    const verdict = listFailed
      ? {
        stale: true,
        ageHours: null,
        severity: 'critical',
        reason: 'Could not read the backup bucket gs://' + BACKUP_BUCKET
          + ' — ' + listFailed + '. A missing or unreadable backup bucket is '
          + 'the exact condition that hid this for the life of the project.',
      }
      : assessBackupFreshness({ newestMarkerMs, nowMs });

    if (!verdict.stale) {
      logger.info('backup_freshness.ok', {
        bucket: BACKUP_BUCKET,
        marker: markerName,
        ageHours: Number(verdict.ageHours.toFixed(2)),
      });
      return;
    }

    logger.error('backup_freshness.stale', {
      bucket: BACKUP_BUCKET,
      marker: markerName,
      severity: verdict.severity,
      reason: verdict.reason,
    });

    // Bell + push + one capped text (owner-notify.js, roadmap step 13): this
    // email rides the same email queue the health digest may be reporting as
    // broken. Never stops the email below.
    try {
      await require('./owner-notify').notifyOwner(getFirestore(), {
        title: 'Firestore backup has NOT run', body: verdict.reason, severity: 'alert',
        key: 'backup-freshness', type: 'backup_watch', clickUrl: '/pro/dashboard.html', idPrefix: 'backup-freshness-',
      });
    } catch (e) {
      logger.warn('backup_freshness.owner_notify_failed', { error: e && e.message });
    }

    const subject = 'NBD Pro — Firestore backup has NOT run';
    const lines = [
      verdict.reason,
      '',
      'Bucket:      gs://' + BACKUP_BUCKET,
      'Newest marker: ' + (markerName || 'none found'),
      'Checked at:  ' + new Date(nowMs).toISOString(),
      '',
      'What to check, in order:',
      '  1. Does the bucket exist?  gcloud storage ls gs://' + BACKUP_BUCKET,
      '  2. Can the runtime SA export? It needs roles/datastore.importExportAdmin —',
      '     roles/editor does NOT include datastore.databases.export.',
      '  3. Logs: gcloud logging read \'resource.labels.service_name="dailyfirestorebackup"\'',
      '',
      'This alarm exists because all three backup functions failed every night',
      'from the day they shipped until 2026-09-03 and nothing said so.',
    ];

    try {
      await getFirestore().collection('email_queue').add({
        to: RECIPIENT,
        subject,
        bodyHtml: '<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px">'
          + lines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;')
          + '</pre>',
        bodyPlain: lines.join('\n'),
        kind: 'backup_freshness_alert',
        // Without status:'pending' the worker never claims the row and the
        // alert silently never sends — health-digest.js documents this trap.
        status: 'pending',
        createdAt: FieldValue.serverTimestamp(),
      });
      logger.info('backup_freshness.alert_queued', { severity: verdict.severity });
    } catch (e) {
      // Nothing left to fall back to, so make it as loud as a log can be.
      logger.error('backup_freshness.alert_queue_failed', {
        error: e.message || String(e),
        reason: verdict.reason,
      });
      throw e;
    }
  }
);
