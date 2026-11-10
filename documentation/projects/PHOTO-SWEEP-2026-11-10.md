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

## Blocked on Jo

- The real match needs lead coordinates and stage dates: a leads export (`--leads file.json`) or a
  read-only token (`NBD_ACCESS_TOKEN` plus `--company=<id>`). Until then `review.csv` and `review.html`
  cannot be built, and no job can be named ready for social posts or Google Business updates.
- Any upload (`--apply`) is built only after Jo reviews a dry run and approves that run in chat.
