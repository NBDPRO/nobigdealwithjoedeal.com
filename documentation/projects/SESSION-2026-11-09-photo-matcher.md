# Job photo matcher (2026-11-09)

Built: steps 1 and 2 of section 1 of the content, photos and credentials plan
([CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09](CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md)).
Branch `photo-matcher`, unpushed. Nothing was run against production.

`scripts/match-job-photos.js` runs on Jo's own computer, over his iCloud Photos or Google Photos
sync folder (or an export). Nothing reads iCloud or Google Photos directly.

## Step 1: the dry run (the default)

```
NBD_ACCESS_TOKEN=$(gcloud auth print-access-token) \
  node scripts/match-job-photos.js --photos "<photo folder>" --company <companyId> [--out <folder>]
node scripts/match-job-photos.js --photos "<photo folder>" --leads <leads export.json> --company <companyId>
```

- **Leads.** In token mode they are read through `scripts/_firestore-rest.js`, read only. The read is
  (since the review round) only the company's top-level `leads`: `companyId == company`, plus
  `userId == company` / `uid` for leads written before `companyId`, then `leadInCompany` from
  `functions/social-studio.js`. No other tenant's leads are read.
  Deleted leads are skipped, and so are leads with no date in `--year` (default 2026). `--leads` takes a
  local JSON export instead, for an offline run.
- **Photos.** Every `.jpg`, `.jpeg`, `.heic`, `.heif` and `.png` file under `--photos` is read. The walk is
  recursive and skips hidden entries. The EXIF date and GPS are read with the CRM's own
  `docs/pro/js/photo-exif.js` and the vendored exifr. Node loads both as ES modules, and HEIC works.
- **Scoring.** Each photo is scored against each lead:
  - street: the lead's `addrKey` (now exported from `scripts/audit-imported-docs-placement.js`, with
    that script's CLI unchanged) found in the photo's folder or file name. The house number must match,
    and so must the street word. A leading direction (N, North, SW...) is not the street word and must
    agree when both sides carry one, so "1004 N Elm" is not "1004 N Main" and "1004 North Main" is.
  - date: inside the install window (one day either side), or inside the wider job window (from 14 days
    before the lead was created to 30 days after its last stage move).
  - GPS: within 75 m (photo-engine.js's on-site radius) or 250 m. More than 1 km away disqualifies the
    lead.
  - **A match needs two different kinds of evidence.** A street key alone never files a photo, and
    neither does GPS alone. A tie between two leads is flagged `ambiguous`.
- **Phase.** Before the install day → Before. From the install day to the install-complete moment →
  During. After that → After.
  - Start: the first move onto an install-in-progress stage.
  - End: `installCompletedAt`, else the first move onto an after stage, else `completedAt`, else
    `stageStartedAt` or `updatedAt` when the lead stands on an after stage. (Corrected in the review
    round: this is not `functions/social-studio.js`'s order, which has no history step.)
  - A backfilled job (`completedBackfill`, or any `backfill: true` history event) prefers `completedAt`
    over the history: the backfill event and every later move are stamped at click time.
  - The stage lists are photo-engine.js's own, and a test pins them equal.
- **Output.** Two files go to `--out` (default `~/nbd-photo-match/<date>`), and the script refuses any
  folder inside the repository (not only `docs/`), so `git add -A` can never pick them up:
  - `photo-match-review.csv`, with `approve` blank on every row.
  - `contact-sheet.html`: thumbnails by `file://` path, grouped by lead, with no script and nothing
    loaded over the network.

  Both files name customers. stdout prints counts only, never a name, an address or a file name.

## Step 2: apply (writes production; Jo's OK for each run)

```
NBD_ACCESS_TOKEN=... node scripts/match-job-photos.js --apply <reviewed.csv> --company <id> --uid <uid>         # plan only
NBD_ACCESS_TOKEN=... node scripts/match-job-photos.js --apply <reviewed.csv> --company <id> --uid <uid> --yes   # writes
```

- Every apply run prints a loud warning banner. Without `--yes` it plans and writes nothing.
- Rows with `approve` = y, yes, x, 1 or true are filed. Jo may edit `phase` or `leadId` first.
- Before any row: `--uid` must belong to `--company` (`users/{uid}.companyId`, else
  `reps/{uid}.companyId`, else a solo owner with an existing user doc whose uid is the company id).
  Otherwise the run exits 2, plan included.
- Each approved row is checked again before anything is written:
  - the lead is live in `--company` (a local `--leads` file is refused for apply);
  - the file is unchanged since review (its sha256);
  - it is a JPEG or a PNG.
- Then the row is filed, create-only, **row first** (review round):
  - **Firestore:** `/photos/{photoId}` through `create()`, in the `photo-engine.js` row shape (leadId,
    userId, companyId, url, storagePath, thumbUrl, tags, phase, createdAt and uploadedAt as server time,
    reportSections, geoLocation, onSite). It also carries the photo-exif.js fields (`capturedAt` from
    EXIF, `capturedAtSource`, `deviceCapturedAt`), `source: 'photo-match'` and `phaseSource: 'photo-match'`.
    A file with no EXIF date gets `capturedAt: null`, `capturedAtSource: 'unknown'` (readers fall back
    to `createdAt`), never the apply day.
  - **Storage:** `photos/{uid}/{leadId}/{photoId}_original.jpg|png`, with `ifGenerationMatch=0` and the
    row's download token in the metadata. `functions/image-pipeline.js` runs once, when the object
    lands, and finds the row by `storagePath`; the row already exists, so `urls.{thumb,med,full}` get
    stamped.
- `photoId` comes from the company, the lead and the file hash, so a rerun finds its own rows and
  overwrites nothing. A row whose object exists is "already filed"; a row whose upload failed
  ("upload failed: rerun to finish") is finished by the next run with the row's own token. An object
  with no row is reported ("storage object exists without a row") and left alone: the pipeline already
  ran for it, so a row made now would never get thumbnails.
- Storage and Firestore are injected clients, which is how the test runs them without the network.

## Tests

`tests/match-job-photos-2026-11-09.test.js` (node bucket; floors 1045/74/1186). It was red before the
script existed (the "script exists" check failed), and the backfill case was red before its fix.
86 checks covered (122 after the review round, below):

- the audit-script export is unchanged;
- the phase windows and every fallback;
- the scoring, including the street-key-alone refusal and the GPS-alone refusal, with a mutation check
  (allowing one kind of evidence reddens three of them);
- the CSV round trip (quotes, commas, newlines, BOM, LF, the Excel formula guard);
- a real dry run over synthetic EXIF JPEGs, with counts-only stdout and a script-free sheet;
- `--out` under `docs/` refused;
- apply: plan only without `--yes`, approved rows only, create-only, each refusal, a rerun that writes
  nothing, the half-done-row recovery;
- the REST Storage client: `ifGenerationMatch=0`, 412 read as already-exists, and the token sent only
  in a header;
- stage-list parity with photo-engine.js.

## Assumptions (for the PR body)

- **HEIC is matched but not uploaded by apply.** Those rows are skipped with "heic: export as JPEG
  first", because most browsers cannot display HEIC. On a Mac, export those photos as JPEG ("Most
  Compatible"), run the dry run again and approve the new rows.
- **`thumbUrl` is the original's URL** until the image pipeline stamps `urls.thumb`. Node has no image
  library here, so the script writes no client-side thumbnail.
- **`--uid` is required for apply.** It sets the Storage owner segment and `userId`. The `companyId` on
  the row comes from the lead.
- **The token-mode lead read** is a filtered `collection('leads').where(field, '==', value)` query,
  added to `scripts/_firestore-rest.js` in the review round (equality filters on a top-level
  collection, automatic single-field indexes). The earlier every-tenant scan is gone.
- **"2026 leads"** means any lead with a date in 2026: created, a stage move, completed, or closed.

## Review round (2026-11-09)

Seven review findings, all fixed test-first (the new checks were red, 26 failing, before the fix;
the suite is now 122 checks):

1. A backfilled job's install window ended at a later after-stage click; it now prefers `completedAt`.
   The header's "social-studio.js order" claim was wrong and is corrected.
2. `--uid` is checked against `--company` before apply (plan included).
3. The `/photos` row is created before the upload, so the image pipeline finds it; an orphan object
   is reported instead of adopted; a failed upload is finished by a rerun.
4. No EXIF date writes `capturedAt: null` / `'unknown'`, not the apply day.
5. A direction prefix is no longer read as the street word.
6. `--out` is refused anywhere inside the repository.
7. Token mode reads only the company's leads (new filtered query in `_firestore-rest.js`, pinned by a
   request-shape test).
