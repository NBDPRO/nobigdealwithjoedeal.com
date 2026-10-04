# Runbook — Restore Firestore from backup

**Severity:** P0 (you are here because data is lost or corrupted)
**Owner:** Jo Deal · **Last drilled:** _never against prod — emulator round-trip verified (Audit #4)_

> **UPDATE 2026-10-04: parts of this page are stale. The overview is now
> [BACKUP-RESTORE](BACKUP-RESTORE.md).** Read live with gcloud on 2026-10-04:
> - **§1:** the canonical bucket is `gs://nobigdeal-pro-firestore-backups`
>   (US multi-region). The second pipeline (`nightlyFirestoreBackup`) was
>   retired 2026-09-05.
> - **§0 RPO is no longer 24h.** PITR is on (7 days), and a daily native
>   Firestore backup schedule keeps 14 weeks (created 2026-10-04). Restore
>   either one into a NEW database: [BACKUP-RESTORE §3c](BACKUP-RESTORE.md).
> - **§6 is wrong now.** Storage HAS a backup: object versioning is on for
>   `nobigdeal-pro.firebasestorage.app`, and the separate project
>   `nobigdeal-backups` pulls daily copies of both the photo bucket and the
>   Firestore exports (since 2026-09-03).
> - **"Last drilled":** a real prod export was imported into the LOCAL
>   emulator on 2026-10-04 (67 collections, 32,705 root docs, 14 s). A
>   scratch-project import (§2) is still undrilled.
>
> ⚠️ A restore **overwrites/merges into the live database**. Read the whole
> page before running anything. When in doubt, restore into a **scratch
> project first**, eyeball it, then decide.

---

## 0. Targets (what "recovered" means)

| Metric | Target | Current reality |
|---|---|---|
| **RPO** (max data loss) | ≤ 24h | ≈ 24h — backups are once-daily exports. Anything written since the last 0?:00 export is **not** recoverable. |
| **RTO** (time to restore) | ≤ 2h | Unknown for prod. Emulator round-trip = ~15s on seed data; a real DB import scales with size (typically minutes–tens of minutes). |
| **Storage (photos/PDFs/recordings)** | — | **NOT BACKED UP.** See §6. Firestore restore does **not** bring binaries back. |

---

## 1. Find a good backup

Daily exports land in the backup bucket as date-stamped folders. (See the
backup-consolidation note in `documentation/projects/BIG_ROCKS.md` — there
were historically two buckets; confirm which is canonical before relying on it.)

```bash
PROJECT=nobigdeal-pro
BUCKET=nobigdeal-pro-firestore-backups      # confirm canonical bucket first
gcloud storage ls gs://$BUCKET/
# Pick the newest folder that has a metadata file (proves the export finished):
gcloud storage ls "gs://$BUCKET/2026-05-30/**overall_export_metadata"
```

A folder **without** an `*.overall_export_metadata` file is a failed/partial
export — do not restore from it. `./scripts/verify-backup.sh` enumerates the
last 7 days for you.

---

## 2. (Strongly recommended) restore into a SCRATCH project first

Never make a damaged-prod situation worse by importing untested data over it.

```bash
SCRATCH=nbd-restore-scratch                 # a disposable project you own
gcloud firestore databases create --location=us-central1 --project=$SCRATCH
# Grant the scratch project's import SA read on the prod backup bucket:
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member="serviceAccount:service-$(gcloud projects describe $SCRATCH --format='value(projectNumber)')@gcp-sa-firestore.iam.gserviceaccount.com" \
  --role=roles/storage.objectViewer
gcloud firestore import gs://$BUCKET/2026-05-30/ --project=$SCRATCH
```

Open the scratch project's Firestore console and confirm the data looks right
(spot-check `leads`, `companyProfile`, `subscriptions`).

---

## 3. Restore into production

> This **merges** documents by path: docs in the export overwrite live docs of
> the same path; live docs **not** in the export are **left untouched** (import
> is not a "wipe + replace"). If you need an exact point-in-time state, restore
> into a fresh database, not over a dirty one.

```bash
gcloud firestore import gs://$BUCKET/2026-05-30/ --project=$PROJECT
# Optional: restore only specific collections
gcloud firestore import gs://$BUCKET/2026-05-30/ \
  --collection-ids=leads,estimates --project=$PROJECT
```

Watch the long-running operation:

```bash
gcloud firestore operations list --project=$PROJECT
gcloud firestore operations describe <OP_NAME> --project=$PROJECT
```

---

## 4. Verify

- Console spot-check the collections that were lost.
- Re-run any app smoke test (`./scripts/verify-deploy.sh`).
- Confirm a recently-active tenant can log in and see their pipeline.

---

## 5. After action

- Note the actual RTO here and update §0.
- File what caused the loss; if it was a bad migration, add a guard.
- If a backup was missing/partial, that's a separate P0 — see the
  backup-cron-stale alert runbook.

---

## 6. Storage (binaries) — NOT covered by the above ⚠️

`gcloud firestore import` restores **documents only**. Photos, signed PDFs
(warranties/contracts/estimates), voice recordings and GDPR exports live in the
**Cloud Storage** default bucket, which currently has **no backup**. If those
are lost there is **no restore path** today.

Mitigation to stand up (tracked as a P0 in Audit #4):
- Enable **Object Versioning** on the Storage bucket, **and/or**
- a daily **Storage Transfer Service** job to a second bucket (ideally
  another region), with a lifecycle/retention policy.

Until that exists, this runbook cannot recover a lost photo or contract PDF.

---

## Drill it without touching prod

`./scripts/restore-drill.sh` proves the export→import **mechanic** in the
emulator (seeds, exports, wipes, re-imports, compares counts). It does **not**
exercise the managed-export / `gcloud firestore import` path — do that in a
scratch project (§2) at least once so this runbook has a real, measured RTO.
