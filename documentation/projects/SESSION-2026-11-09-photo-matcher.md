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

- **Leads.** In token mode they are read through `scripts/_firestore-rest.js`, read only. The read is a
  collection-group page over `leads` (the one query shape the adapter supports), kept to top-level
  `leads/{id}` and filtered in memory to `--company` (`leadInCompany` from `functions/social-studio.js`).
  Deleted leads are skipped, and so are leads with no date in `--year` (default 2026). `--leads` takes a
  local JSON export instead, for an offline run.
- **Photos.** Every `.jpg`, `.jpeg`, `.heic`, `.heif` and `.png` file under `--photos` is read. The walk is
  recursive and skips hidden entries. The EXIF date and GPS are read with the CRM's own
  `docs/pro/js/photo-exif.js` and the vendored exifr. Node loads both as ES modules, and HEIC works.
- **Scoring.** Each photo is scored against each lead:
  - street: the lead's `addrKey` (now exported from `scripts/audit-imported-docs-placement.js`, with
    that script's CLI unchanged) found in the photo's folder or file name. The house number must match,
    and so must the first street word.
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
    `stageStartedAt` or `updatedAt` when the lead stands on an after stage. This is the order
    `functions/social-studio.js` uses.
  - A quiet "already completed" backfill event is skipped, because its timestamp is the click time and
    its real day is in `completedAt`. This was found and fixed in this session, test first.
  - The stage lists are photo-engine.js's own, and a test pins them equal.
- **Output.** Two files go to `--out` (default `~/nbd-photo-match/<date>`), and the script refuses any
  folder under `docs/`:
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
- Each approved row is checked again before anything is written:
  - the lead is live in `--company` (a local `--leads` file is refused for apply);
  - the file is unchanged since review (its sha256);
  - it is a JPEG or a PNG.
- Then the row is filed, create-only:
  - **Storage:** `photos/{uid}/{leadId}/{photoId}_original.jpg|png`, with `ifGenerationMatch=0` and a
    download token in the metadata. `functions/image-pipeline.js` makes the variants, as for any upload.
  - **Firestore:** `/photos/{photoId}` through `create()`, in the `photo-engine.js` row shape (leadId,
    userId, companyId, url, storagePath, thumbUrl, tags, phase, createdAt and uploadedAt as server time,
    reportSections, geoLocation, onSite). It also carries the photo-exif.js fields (`capturedAt` from
    EXIF, `capturedAtSource`, `deviceCapturedAt`), `source: 'photo-match'` and `phaseSource: 'photo-match'`.
- `photoId` comes from the company, the lead and the file hash, so a rerun finds its own rows
  ("already filed") and overwrites nothing. If a run stopped after the upload but before the row, the
  next run reuses the uploaded object and its token.
- Storage and Firestore are injected clients, which is how the test runs them without the network.

## Tests

`tests/match-job-photos-2026-11-09.test.js` (node bucket; floors 1045/74/1186). It was red before the
script existed (the "script exists" check failed), and the backfill case was red before its fix.
86 checks cover:

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
- **The token-mode lead read** pages every top-level lead and filters to the company in memory. Only
  counts are printed. Adding a filtered query to the shared adapter was left out, to keep the change small.
- **"2026 leads"** means any lead with a date in 2026: created, a stage move, completed, or closed.
