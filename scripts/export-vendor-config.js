#!/usr/bin/env node
/**
 * scripts/export-vendor-config.js — back up the config that lives only at a
 * vendor (Bland "Thursday" agent/pathway/persona/numbers, Cal.com event types,
 * BoldSign templates, Stripe catalog) to the PRIVATE bucket
 *   gs://nobigdeal-pro-vendor-backups/vendor-config/YYYY-MM-DD/
 *
 * The same export runs weekly as the scheduled function
 * weeklyVendorConfigExport (functions/vendor-config-export.js); both use
 * functions/vendor-config-export-core.js.
 *
 * SECRETS: every API key is read at run time from Google Secret Manager
 * (`gcloud secrets versions access latest`) under your gcloud login, held in
 * memory, and never printed or written. Exported JSON is redacted (key names
 * like *token/secret/authorization*, value shapes like sk_live_/whsec_/Bearer,
 * ?token= URL params, and the literal value of every secret loaded) BEFORE
 * upload; a surviving literal aborts the run. Nothing is written to local disk:
 * objects stream to `gcloud storage cp -`.
 *
 * NEVER point --bucket at anything public, and never commit the output. The
 * repo is public.
 *
 * Usage:
 *   node scripts/export-vendor-config.js                 # export + upload
 *   node scripts/export-vendor-config.js --dry-run       # export + redact, print the file list, upload nothing
 *   node scripts/export-vendor-config.js --import-legacy=<dir>
 *        # redact and upload every *.json in <dir> to vendor-config/legacy/<name>
 *        # (one-off: Jo's old %TEMP%/thursday-bland-backups)
 *   --project=<id>  (default nobigdeal-pro)   --bucket=<name> (default <project>-vendor-backups)
 *
 * Restore: documentation/runbooks/BACKUP-RESTORE.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const core = require('../functions/vendor-config-export-core');

const args = process.argv.slice(2);
const flag = (n) => { const a = args.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : null; };
const DRY = args.includes('--dry-run');
const PROJECT = flag('project') || 'nobigdeal-pro';
const BUCKET = flag('bucket') || (PROJECT + core.BUCKET_SUFFIX);
const LEGACY = flag('import-legacy');
const WIN = process.platform === 'win32';

// gcloud is gcloud.cmd on Windows, so it needs a shell there. Every argument
// below is a constant or a sanitized object path — never user free text.
function gcloud(argv, input) {
  return execFileSync('gcloud', argv, {
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    shell: WIN,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function readSecret(name) {
  if (!/^[A-Z0-9_]+$/.test(name)) return null;
  try {
    return gcloud(['secrets', 'versions', 'access', 'latest', '--secret=' + name, '--project=' + PROJECT]).trim();
  } catch (e) {
    return null; // not created, or no access: the vendor is skipped
  }
}

function upload(objectPath, obj) {
  if (!/^[A-Za-z0-9._+\-/]+$/.test(objectPath)) throw new Error('unsafe object path ' + objectPath);
  gcloud(['storage', 'cp', '-', 'gs://' + BUCKET + '/' + objectPath, '--content-type=application/json', '--quiet'],
    JSON.stringify(obj, null, 2) + '\n');
}

async function main() {
  if (LEGACY) {
    const known = [];
    for (const n of Object.values(core.VENDOR_SECRETS).concat(core.SCRUB_ONLY_SECRETS)) {
      const v = readSecret(n);
      if (v && v !== '__unset__') known.push(v);
    }
    const names = fs.readdirSync(LEGACY).filter((f) => f.endsWith('.json')).sort();
    let n = 0;
    for (const f of names) {
      const raw = JSON.parse(fs.readFileSync(path.join(LEGACY, f), 'utf8'));
      const { data, count } = core.redactTokens(raw, known);
      if (core.containsKnownSecret(JSON.stringify(data), known)) throw new Error('secret survived redaction in ' + f);
      const dest = 'vendor-config/legacy/' + f.replace(/[^A-Za-z0-9._+-]/g, '_');
      if (!DRY) upload(dest, data);
      console.log((DRY ? '[dry] ' : '') + dest + '  (redactions: ' + count + ')');
      n++;
    }
    console.log(n + ' legacy file(s) ' + (DRY ? 'checked' : 'uploaded to gs://' + BUCKET + '/vendor-config/legacy/'));
    return;
  }

  const now = new Date();
  const { files, manifest } = await core.collectVendorConfig({ getSecret: readSecret, now });
  const prefix = core.datePrefix(now);
  for (const f of files) {
    if (!DRY) upload(prefix + f.path, f.data);
  }
  if (!DRY) upload(prefix + 'manifest.json', manifest);

  console.log((DRY ? '[dry run] would write ' : 'Wrote ') + (files.length + 1) + ' objects to gs://' + BUCKET + '/' + prefix);
  for (const [v, s] of Object.entries(manifest.vendors)) console.log('  ' + v + ': ' + s);
  for (const i of manifest.items) {
    console.log('  ' + (i.ok ? '✓' : (i.optional ? '·' : '✗')) + ' ' + i.path +
      (i.ok ? '  ' + i.bytes + ' B, redactions ' + i.redactions : '  HTTP ' + i.status));
  }
  if (manifest.summary.failed) {
    console.error(manifest.summary.failed + ' required item(s) failed — see manifest.json');
    process.exit(1);
  }
}

main().catch((e) => { console.error(e && e.message || e); process.exit(1); });
