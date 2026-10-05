/**
 * functions/vendor-config-export.js — weekly backup of vendor-held config.
 *
 * weeklyVendorConfigExport runs Sundays 04:30 America/New_York and writes the
 * Bland "Thursday" agent/pathway/persona/numbers, Cal.com event types (once a
 * CALCOM_API_KEY exists) and the
 * Stripe catalog config to the PRIVATE bucket
 *   gs://<project>-vendor-backups/vendor-config/YYYY-MM-DD/
 * Same logic as `node scripts/export-vendor-config.js` (both drive
 * vendor-config-export-core.js), so a manual run and the cron are identical.
 *
 * Why a scheduled function and not a GitHub Action: the repo is public and so
 * are its Action logs. This runs inside the project with Secret Manager
 * bindings and logs only paths, sizes and redaction counts.
 *
 * Bucket (created 2026-10-04, see documentation/runbooks/BACKUP-RESTORE.md):
 * US multi-region, uniform access, public access prevention ENFORCED, object
 * versioning on, noncurrent versions deleted after 365 days. The runtime SA
 * (compute default, roles/editor) can already write it. A daily Storage
 * Transfer job in the separate nobigdeal-backups project copies it off-project.
 *
 * A required item that fails makes the run throw AFTER uploading what did
 * succeed, so the heartbeat pings /fail and the partial backup is still kept.
 */
'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions');
const { defineSecret } = require('firebase-functions/params');
const { Storage } = require('@google-cloud/storage');
const { SECRETS, secretValue } = require('./integrations/_shared');
const core = require('./vendor-config-export-core');

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'nobigdeal-pro';
const BUCKET = PROJECT_ID + core.BUCKET_SUFFIX;

// Secret Manager names come from core.VENDOR_SECRETS / SCRUB_ONLY_SECRETS.
// CALCOM_API_KEY does not exist yet: the deploy's stub step creates it as
// `__unset__`, which secretValue() treats as "not configured" (Cal.com is then
// skipped and the manifest says so).
const PARAMS = {
  BLAND_API_KEY: SECRETS.BLAND_API_KEY,
  THURSDAY_LOOKUP_TOKEN: SECRETS.THURSDAY_LOOKUP_TOKEN,
  CALCOM_API_KEY: defineSecret('CALCOM_API_KEY'),
  STRIPE_SECRET_KEY: defineSecret('STRIPE_SECRET_KEY'),
};

exports.weeklyVendorConfigExport = onSchedule(
  {
    schedule: '30 4 * * 0',
    timeZone: 'America/New_York',
    maxInstances: 1,
    timeoutSeconds: 300,
    memory: '256MiB',
    secrets: Object.values(PARAMS),
  },
  async () => {
    const now = new Date();
    const { files, manifest } = await core.collectVendorConfig({
      getSecret: (name) => (PARAMS[name] ? secretValue(PARAMS[name]) : null),
      now,
    });
    const bucket = new Storage().bucket(BUCKET);
    const prefix = core.datePrefix(now);
    const save = (p, obj) => bucket.file(prefix + p).save(JSON.stringify(obj, null, 2) + '\n', {
      contentType: 'application/json',
      resumable: false,
    });
    for (const f of files) await save(f.path, f.data);
    await save('manifest.json', manifest);
    logger.info('weeklyVendorConfigExport.done', {
      bucket: BUCKET,
      prefix,
      vendors: manifest.vendors,
      summary: manifest.summary,
    });
    if (manifest.summary.failed > 0) {
      const failedPaths = manifest.items.filter((i) => !i.ok && !i.optional).map((i) => i.path + ' ' + i.status);
      throw new Error('weeklyVendorConfigExport: ' + manifest.summary.failed + ' required item(s) failed: ' + failedPaths.join(', '));
    }
  }
);
