# Daily Success: body measurements and progress photos (2026-10-22)

Roadmap Horizon 2 item 4 ([DAILY-SUCCESS-ROADMAP-2026-10-21](DAILY-SUCCESS-ROADMAP-2026-10-21.md)).

## What shipped
- **Measurements card** (waist, chest, hips, neck, arm, thigh, calf): log today's number, see the latest, change vs about
  four weeks back, and a small trend line. Unit toggle in / cm. Stored as whole millimetres, so flipping the unit never
  drifts a number. One value per site per day; re-logging replaces. `js/measurements-logic.js` + `js/measurements-ui.js`.
- **Progress photos** (front / side / back): add from camera or library, "then and now" compare (oldest vs newest of the
  pose), per-photo delete (second tap, no `confirm()`). Newest 60 kept. `js/photos-logic.js` + the same UI file.
- Both cards sit under the Progress card on the dashboard and on a day page's Fitness section.

## Where the data lives (and does not)
- Measurements: `localStorage` key `nbd_ds_measurements`; unit in `nbd_ds_meas_unit`. **Not** part of the cloud-synced
  pages, so they are per device. No sync was added because it would touch `userSettings`/rules (needs a security review).
- Photos: IndexedDB `nbd_ds_photos`. Re-encoded through a canvas (long edge 1280, JPEG) which drops EXIF/GPS, then the
  stored bytes also pass `stripJpegMetadata` (removes APP1-APP15 and COM); a failed strip refuses the photo. Never
  uploaded: no Storage path, no download URL, no `?token=`. The test scans the feature for any network/Firebase call.
- Clearing site data or switching phones loses them. A future export (zip of photos + CSV) would be the backup path.
- The old per-day "Weekly Body Metrics" boxes on day pages (chest/waist/arms/legs text) are untouched and not merged in.

## Verification
- `tests/tracker-measurements-photos-2026-10-22.test.js` (55 checks, in ci-manifest): units, validation with controls,
  trend, a synthetic JPEG with GPS/XMP/comment segments that must come out clean and byte-identical to the clean fixture.
- Mutation run: seven mutants (EXIF range narrowed, COM kept, min size 0, wrong inch factor, strip-failure fallback,
  a `fetch` added, duplicate-row push) each turned the test red; all restored.
- Browser pane: logged 34.5 in, flipped to 87.6 cm, added a 1600x1200 photo (stored 1280x960 JPEG, blob URL shown);
  360 and 412 px: no horizontal overflow, every button/label 44px+.
- `tests/smoke.test.js` in this worktree: 8 failures from missing `functions/` deps (`firebase-functions`) and GBP/photo-
  vision modules, none in files this change touches.

## Not done / needs Jo
- Real-iPhone pass: camera capture, HEIC from the library (canvas decode via `createImageBitmap`), IndexedDB quota.
- Themes use `--ac`, `--rule`, `--ac-text` tokens only; the save/add buttons use white text on `--ac` like `.rv-start`.

## Update 2026-10-23: photos survived sign-out (fixed)
The overnight audit found that `purgeAccountStorage()` (`docs/pro/js/nbd-auth.js`) swept `nbd_` localStorage and the My Skin
database but never the photos database, so on a shared phone account B saw account A's progress photos. It now also
deletes IndexedDB `nbd_ds_photos` (best-effort: no `indexedDB`, a throw or a blocked delete never stops sign-out; a blocked
delete finishes when the other tab lets go). The "this note's" line above ("Where the data lives") was incomplete on this.
Storage audit: `nbd_ds_measurements` and `nbd_ds_meas_unit` are swept by the existing `nbd_` prefix purge; the accent key
`nbd_ds_accent` is a device preference owned by the accent picker and was left alone.
The strip guard now asserts on the bytes stored in IndexedDB from a GPS-EXIF JPEG fixture (the old check only matched source
text). Test: `tests/tracker-photos-account-purge-2026-10-23.test.js`; mutations (purge target renamed, throw in onblocked,
unstripped blob stored, strip range narrowed) each went red. Removing the `if (!stripped) throw` line is an equivalent mutant:
`stripped.out` on null throws anyway.
