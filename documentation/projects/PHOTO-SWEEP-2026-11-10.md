# Job-photo sweep, Google Photos pass (2026-11-10)

Counts only. No customer names or addresses are in this note.

Plan: [CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09](CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md) section 1.
Tool: `scripts/match-job-photos.js` (dry run only; scoring in `scripts/lib/photo-match.js`).

## What was done

- Google Photos "roof <month> 2026" searches were downloaded by hand, one date group at a time,
  from November 2026 back to January 6, 2026 (the bottom of the January list). Each zip was
  extracted, EXIF-scanned, checked against the zip (file count and bytes), then the zip was deleted.
- Photos live outside the repo under `Documents\nbd-photo-review\photos\` (never committed).
- Nothing was uploaded, filed or written to the CRM. The matcher has no `--apply` in this build.

## Counts (EXIF cache, 2026 stills with a taken date)

- 5,808 dated stills, 3,833 with GPS.
- By month: Jan 82, Feb 201, Mar 269, Apr 506, May 741, Jun 653, Jul 454, Aug 1,333, Sep 863, Oct 604, Nov 102.
- Many June and July photos have no GPS; screenshots and non-GPS images are ignored by the matcher.

## Known gaps in the Google pass

- A few date groups in January and February (Jan 24-30 and the older January headers, Feb 27) and some
  side-by-side groups were not selected, mostly screenshots. April 18 was one screenshot, skipped on purpose.
- The iCloud pass has not started (needs Jo signed in to iCloud in Chrome).

## Dry-run match (leads from the CRM's own Export Leads CSV, 255 leads, 191 with coordinates)

- 971 photos matched: 842 high, 102 medium, 27 low; 141 flagged ambiguous (two leads tied).
- 41 of 255 leads got at least one photo; 214 got none (64 leads have no coordinates).
- Job window used is an approximation: lead Created date through the later of Updated and Current Stage Since,
  because the export has no per-stage history. Treat as candidates for Jo's review, not final.
- `review.csv` and `review.html` are in `Documents\nbd-photo-review` (outside the repo, they hold names). Nothing was uploaded.

## Filed to Drive (Jo's OK in chat, 2026-11-10)

- Scope Jo chose: clean matches only (high confidence, not ambiguous), jobs that already have a Drive customer folder.
- 644 photos across 25 jobs (about 1.8 GB) copied, never moved, into `COMPANIES/NBD/CUSTOMERS/<customer>/Photos/`,
  named `<date>_<phase>_<original name>`. All 644 verified by size. No existing file was overwritten.
- 4 matched jobs had no Drive customer folder and were skipped; Jo decides whether to create them.
## CRM upload (built, NOT run)

- `scripts/upload-job-photos.js` (pure core `scripts/lib/photo-upload.js`, pinned by
  `tests/upload-job-photos-2026-11-10.test.js`): full-size JPEG + thumbnail to Storage at
  `photos/{uid}/{leadId}/`, and a `/photos/{id}` doc in the `photo-engine.js` shape with `source: 'photo-match'`.
- Phase comes from the date window, so docs carry `phaseSource: 'stage'` and Photo Review asks the rep to confirm it.
- Safe by construction: dry run by default (local only, counts), `--apply` needs `--yes` and `--company=<id>`,
  stable doc ids so a rerun skips what exists and never overwrites rep edits, other-company or unknown leads are skipped.
- Staged inputs (outside the repo): `Documents\nbd-photo-review\upload-manifest.csv` and `upload-stage\`
  (569 HEIC converted to JPEG, thumbnails for all 644). Dry run: 644 photos, 25 jobs, 2.4 GB, nothing missing.
- Run (Jo, own terminal, after `gcloud auth application-default login`):
  `node scripts/upload-job-photos.js --manifest <upload-manifest.csv> --company=<id> --apply --yes`.
  Jo approves that specific run in chat first (CLAUDE.md rule f). Not run by any agent.

## Still open (updated 2026-11-14)

- Done since the first draft of this note: the match ran on the CRM's Export Leads CSV, and
  `review.csv`, `review.html` and `ready-jobs.html` exist in `Documents\nbd-photo-review`.
- CRM upload: built and dry-run only. Jo runs `--apply` himself after approving that specific run in chat.
- 4 matched jobs have no Drive customer folder (marked `NO FOLDER` in `drive-map.csv`); Jo decides whether to create them.
- 102 medium, 27 low and 141 ambiguous matches still need Jo's review in `review.html` before any filing.
- iCloud pass: not started; needs Jo signed in to iCloud in Chrome.
