# Runbook: backups and restores (all of them)

**Written:** 2026-10-04 · **Owner:** Jo Deal · **Last drilled:** 2026-10-04 (see §5)

This is the one page that says what is backed up, where, how often, and how
to get each piece back. The Firestore import steps in detail (scratch
project first, merge semantics) stay in
[RESTORE_FROM_BACKUP](RESTORE_FROM_BACKUP.md); this page links to it rather
than repeating it.

> **Never restore into production without a scratch-project or new-database
> check first.** Every restore path below has a "into a NEW place" form. Use it.
>
> **Never put backup data, prompts or tokens in this repo or under `docs/`.**
> The repo is public. Backups live only in the private buckets below.

Background: the vendor cost and lock-in audit,
`documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md` §4 and Lane B (PR #2157,
branch `docs/vendor-cost-map`, until it merges).

---

## 1. What is backed up

All read back with `gcloud` on 2026-10-04. Project `nobigdeal-pro` (from
`.firebaserc`) unless the row says `nobigdeal-backups`.

| What | Where | How often | Kept for | How it gets there |
|---|---|---|---|---|
| **Firestore, point-in-time** | inside the database (PITR) | continuous | 7 days (`versionRetentionPeriod: 604800s`) | built in. Delete protection is also on |
| **Firestore, native backups** | Firestore backups, location `nam5` | daily | **14 weeks** (`retention: 8467200s`) | backup schedule `d864b16b-4282-49e9-a430-25fe176117fc`, created 2026-10-04 |
| **Firestore, managed export** | `gs://nobigdeal-pro-firestore-backups/YYYY-MM-DD/` (US multi-region) | daily 03:15 ET | 30 days (`firestoreBackupRetention`, never below 7) | `dailyFirestoreBackup` (`functions/firestore-backup.js`); `backupFreshnessCron` emails if one is missing |
| **Firestore export, off-project copy** | `nobigdeal-backups`: `gs://nobigdeal-offsite-firestore` (US, versioned) | daily 00:00 UTC | forever (copy-only, no delete) | Storage Transfer job `nbd-firestore-offsite` |
| **Photos / PDFs / recordings (Storage)** | `gs://nobigdeal-pro.firebasestorage.app` | object versioning | until a noncurrent version is deleted | versioning on the live bucket |
| **Storage, off-project copy** | `nobigdeal-backups`: `gs://nobigdeal-offsite-photos` (US, versioned) | daily 00:00 UTC | forever (copy-only) | Storage Transfer job `nbd-photos-offsite` |
| **Vendor-held config** (Bland "Thursday", Stripe catalog; Cal.com once keyed) | `gs://nobigdeal-pro-vendor-backups/vendor-config/YYYY-MM-DD/` | weekly, Sun 04:30 ET (after the next functions deploy) + on demand | current forever; overwritten/old versions 365 days | `weeklyVendorConfigExport` / `node scripts/export-vendor-config.js` |
| **Vendor config, off-project copy** | `nobigdeal-backups`: `gs://nobigdeal-offsite-vendor-config` | daily | current forever; old versions 365 days | Storage Transfer job `nbd-vendor-config-offsite`, created 2026-10-04 |
| **Old Thursday backups** from `%TEMP%\thursday-bland-backups` | `gs://nobigdeal-pro-vendor-backups/vendor-config/legacy/` (7 files) | one-off, 2026-10-04 | as above | `--import-legacy` |

### The vendor-backups bucket (created 2026-10-04)

`gs://nobigdeal-pro-vendor-backups`: location US, uniform bucket-level
access, **public access prevention enforced**, object versioning on,
lifecycle rule deletes a noncurrent version 365 days after it is replaced,
7-day soft delete. The only extra grant is read for the
`nobigdeal-backups` Storage Transfer agent
(`project-760414839970@storage-transfer-service`: `legacyBucketReader` +
`objectViewer`), the same pair it holds on the Firestore export bucket.
Nothing in prod can write to the off-project buckets; the copies are
**pulled** by the backups project, so a compromised prod account cannot
delete them.

The off-project bucket `gs://nobigdeal-offsite-vendor-config` has the same
settings (US, uniform, enforced PAP, versioned, 365-day noncurrent rule).

Unauthenticated access, checked 2026-10-04: object GET **403**, listing
**401** (prod bucket); listing **401** (off-project bucket). Positive
control: the same object GET with a gcloud bearer token returns **200**, so
the 403 is the bucket refusing, not a wrong URL.

### What the vendor export contains

One run writes, under `vendor-config/YYYY-MM-DD/`:

- `bland/agents.json`, `bland/agents/<id>.json`, `.../versions.json`, and
  every **published** agent version (`versions/0.7.0.json` …). Bland's
  version endpoint rejects autosave drafts (semver null, HTTP 400), so
  drafts are listed in `versions.json` but not exported.
- `bland/pathways.json` + `bland/pathways/<id>.json` (pathway
  `771a3ea4…`, nodes and edges), `bland/inbound-numbers.json` +
  `bland/inbound/+15139405589.json` (first sentence, webhook, voice),
  `bland/personas.json`, `bland/tools.json`, `bland/knowledgebases.json`.
- `stripe/products.json`, `prices.json`, `webhook-endpoints.json`,
  `billing-portal-configurations.json`, `coupons.json`. Catalog and
  settings only. **Not** customers or invoices: Stripe is the system of
  record and `stripe-ledger.js` mirrors payments into Firestore, which is
  backed up above.
- `calcom/event-types.json`, `schedules.json`, `webhooks.json`: **skipped
  today**, because no `CALCOM_API_KEY` exists (only the webhook secret).
  See §6.
- `boldsign/templates.json`: skipped, because `BOLDSIGN_API_KEY` is the
  deploy's `__unset__` stub (BoldSign is dark).
- `manifest.json`: per-file status, byte size and redaction count, plus
  which vendors were skipped and why. It never holds a value.

**Redaction.** Before upload, every string is scrubbed: values under key
names like `*token*`, `*secret*`, `authorization`, `api_key`; value shapes
(`sk_live_…`, `whsec_…`, `Bearer …`, JWTs, `org_…`, `AIza…`, `?token=` URL
parameters); and the literal value of every key the run loaded plus
`THURSDAY_LOOKUP_TOKEN`. If a known literal survives anyway, the run
refuses to upload. On 2026-10-04 every file reported 0 redactions: the
Thursday init code reads its token from Bland's env, not a literal.

**Not covered (do these by hand):** Metricool post history (CSV export),
Grok Bot roles and prompts (copy into a private doc), GBP reviews (wait for
API access, case 8-9748000042165).

---

## 2. Run the vendor export by hand

From a checkout, logged in to gcloud as Jo:

```bash
node scripts/export-vendor-config.js --dry-run   # fetch + redact, print the list, upload nothing
node scripts/export-vendor-config.js             # upload to vendor-config/<today>/
gcloud storage ls -r gs://nobigdeal-pro-vendor-backups/vendor-config/$(date -u +%F)/
```

Keys come from Secret Manager at run time and are never printed or written.
Nothing touches local disk; objects stream to `gcloud storage cp -`. A
second run on the same day overwrites the files, and versioning keeps the
earlier copies.

Exit code 1 with `N required item(s) failed` means a vendor rejected a
call. Read the `✗` rows. Rows marked `·` are optional (tools,
knowledgebases) and do not fail the run.

---

## 3. Restore each piece

### 3a. Thursday (Bland agent, pathway, number)

1. Pick the date and download into a scratch folder **outside the repo**:
   `gcloud storage cp -r gs://nobigdeal-pro-vendor-backups/vendor-config/<date>/bland ./bland-restore`
2. **Agent prompt and settings:** the production version is
   `bland/agents/<id>.json` → `environments[].current_version_id`. Look up
   its semver in `versions.json`, then open `versions/<semver>.json`. Roll
   back with `node scripts/thursday-agent-lookup.js --rollback=<semver>`,
   which publishes and promotes a version Bland still holds. If the agent
   is gone, recreate it in the Bland dashboard and paste the snapshot.
3. **Pathway:** `pathways/<id>.json` holds `nodes`/`edges`. Re-POST it to
   `/v1/pathway/<id>` (or a new pathway) with Jo's key. Tools bind only
   through node `data.tools`.
4. **Number:** `inbound/+15139405589.json`. `scripts/thursday-bland-setup.js`
   sets `webhook` and `first_sentence`; set the other fields in the dashboard.
5. **Anything showing `[REDACTED]`** was a credential. Put the real value
   back from Secret Manager (for example `THURSDAY_LOOKUP_TOKEN`); never
   paste it into a file in the repo.

### 3b. Stripe catalog

Products and prices are in `stripe/*.json`. Recreate them in the dashboard
or with the API, then update the `STRIPE_PRICE_*` secrets to the new price
ids. Webhook endpoints: recreate them with the same `url` and
`enabled_events`. A recreated endpoint gets a **new** signing secret, so
set `STRIPE_WEBHOOK_SECRET` / `STRIPE_INVOICE_WEBHOOK_SECRET` /
`STRIPE_CONNECT_WEBHOOK_SECRET` to match.

### 3c. Firestore: pick the narrowest tool

| Situation | Use | Command (always into a NEW database or scratch project first) |
|---|---|---|
| Bad write in the last 7 days | PITR clone | `gcloud firestore databases clone --source-database=projects/nobigdeal-pro/databases/(default) --snapshot-time=<RFC3339, whole minute> --destination-database=restore-<yyyymmdd>` |
| Older than 7 days, up to 14 weeks | native backup | `gcloud firestore backups list --project=nobigdeal-pro`, then `gcloud firestore databases restore --source-backup=projects/nobigdeal-pro/locations/nam5/backups/<id> --destination-database=restore-<yyyymmdd> --project=nobigdeal-pro` |
| Up to 30 days, or one collection | managed export | [RESTORE_FROM_BACKUP](RESTORE_FROM_BACKUP.md) §1–3 (`gcloud firestore import … --collection-ids=…`) |
| Prod project lost or older than 30 days | off-project export copy | same import, from `gs://nobigdeal-offsite-firestore/<date>/`, into a scratch project |

A clone or restore makes a **second database** in the same project. Read
it in the console or with `--database=restore-…`, copy back only what you
need, then delete the restore database (it is billed like any database).
Native backups and PITR clones never overwrite `(default)` unless you name
it as the destination. Don't.

### 3d. Photos, PDFs, recordings

- One object deleted or overwritten: `gcloud storage ls -a gs://nobigdeal-pro.firebasestorage.app/<path>`
  lists versions. Copy the right generation back over it:
  `gcloud storage cp gs://…/<path>#<generation> gs://…/<path>`.
- Bucket or project gone: copy back from `gs://nobigdeal-offsite-photos/`.

---

## 4. Weekly automation

`weeklyVendorConfigExport` (`functions/vendor-config-export.js`), Sundays
04:30 America/New_York. It binds `BLAND_API_KEY`, `THURSDAY_LOOKUP_TOKEN`,
`BOLDSIGN_API_KEY`, `CALCOM_API_KEY` and `STRIPE_SECRET_KEY`. The deploy's
stub step creates `CALCOM_API_KEY` as `__unset__`, which counts as "not
set". It runs as the default compute SA, which already writes the bucket
through `roles/editor`. A failed required item makes the run throw after
saving what succeeded, so the Healthchecks slug `weekly-vendor-config-export`
pings `/fail` ([HEALTHCHECKS-SETUP](HEALTHCHECKS-SETUP.md)).

**Why not a GitHub Action:** the repo and its Action logs are public.

**It is not live until the PR merges and functions deploy.** Until then,
run §2 by hand.

---

## 5. Restore drill (do it quarterly)

**Vendor config, drilled 2026-10-04:** downloaded the whole
`vendor-config/` tree to a scratch folder outside the repo. All 36 files
parsed as JSON. The pathway file named "Thursday - NBD Reception Agent",
with 4 nodes, 2 edges and start node `__start`. Then the local copy was
deleted.

```bash
D=$(mktemp -d); gcloud storage cp -r gs://nobigdeal-pro-vendor-backups/vendor-config/<date> "$D"
node -e 'const fs=require("fs"),p=require("path");let n=0;(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);e.isDirectory()?w(f):(JSON.parse(fs.readFileSync(f,"utf8")),n++)}})(process.argv[1]);console.log(n+" files parse")' "$D"
rm -rf "$D"
```

**Firestore, drilled 2026-10-04 into the LOCAL EMULATOR only** (never
prod). The 2026-10-04 managed export (20.7 MB) was downloaded to a scratch
folder. Next to the date folder went a `firebase-export-metadata.json`:

```json
{"version":"13.0.0","firestore":{"version":"1.19.0","path":"2026-10-04","metadata_file":"2026-10-04/2026-10-04.overall_export_metadata"}}
```

Then:

```bash
env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy \
  npx firebase emulators:exec --only firestore --project nobigdeal-pro \
  --import <scratch-folder> "node <count-script>"
```

Result: the import ran without error and served **67 root collections and
32,705 root-level documents** (leads 277, companies 3, users 5, estimates
8, invoices 7). The whole run, boot to count, took 14 s. The local copy
(customer data) was deleted right after. Only Firestore was booted. **Never
add `functions` to `--only` with real data:** the functions emulator loads
real Twilio/Resend secrets and has texted Jo before.

Not yet drilled: a native-backup `databases restore` into a throwaway
database. It is billed while it exists, so do it once with Jo watching and
delete it after. A `gcloud firestore import` into a scratch project
([RESTORE_FROM_BACKUP](RESTORE_FROM_BACKUP.md) §2) is also undrilled.

---

## 6. Jo's to-do

1. **Cal.com API key:** Cal.com → Settings → Developer → API keys, then
   `firebase functions:secrets:set CALCOM_API_KEY --project nobigdeal-pro`.
   The next export picks it up. The Cal.com paths (`/v2/event-types`
   `cal-api-version: 2024-06-14`, `/v2/schedules`, `/v2/webhooks`) have
   **not run against a real key yet**. Check the first manifest after
   setting it.
2. **Healthchecks:** create the check `weekly-vendor-config-export`
   (weekly, 1-day grace) if you want an alert when the cron misses.
3. **By hand:** export Metricool history and copy the Grok Bot prompts into
   a private doc.
4. Nothing to click for an off-project copy: the separate project
   `nobigdeal-backups` already exists (billing on, same billing account),
   and all three copies run there.
