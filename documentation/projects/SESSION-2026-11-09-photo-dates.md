# Install-complete date and photo EXIF dates (2026-11-09)

Built: step 3 of section 1 ("close the gaps") of the content, photos and credentials plan
(`CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09`, on the `plan-note` branch when this was written).
Branch `photo-dates`, unpushed. The plan's photo matcher (steps 1 and 2) reads both fields below.

## 1. installCompletedAt

Before: `installCompletedAt` was read by `functions/social-studio.js`, `agent-mcp-logic.js`,
`anniversary-touch.js` and `handlers/ai-texting.js`, but nothing wrote it. A normal move to
Install Done (`install_complete`) left only `stageStartedAt`, and the next stage move overwrites that.

Now the first move onto Install Done stamps `installCompletedAt` with server time, and a stored
date is never replaced:

- Client: `docs/pro/js/stage-write.js` `commitStageChange`, inside the transaction, reading the
  server copy of the lead.
- Server: `functions/job-spine-logic.js` `movePayload`, used by `job-spine.js` and `deal-prequal.js`.
- A job card moved on the kanban: `crm-pipeline.js` `_moveJobCard` writes the job doc, or the lead
  for its primary job, without going through `commitStageChange`. Like the `stageStartedAt` it
  writes, the stamp here uses the client clock, because the job cache keeps the patch.
- Bulk moves go through `moveCard`, which calls `commitStageChange`, so they are covered.
- The "already completed" backfill does not stamp it. That path writes the real day into
  `completedAt`, which every reader checks next, and a server-time stamp would win over that day.
- The fallback with no transaction does not stamp it either. Without reading the stored lead it
  cannot tell whether a date already exists, and never overwriting comes first.
- `firestore.rules` needs no change. `tests/firestore-rules.install-completed-at.test.js` (emulator)
  proves who can and cannot write the patch.
- "The install-complete stage role" is read as the `install_complete` stage key. No stage role
  means "install done": roles are new / active / job / won / lost.

## 2. Photo date and GPS on every upload path

Before: only the customer page read EXIF, and it stored the result under `exif` only. `capturedAt`
held the device clock at upload (PhotoEngine) or was missing (customer page, dashboard photo modal).
`geoLocation` came only from the camera session's GPS fix.

New: `docs/pro/js/photo-exif.js`, an ES module that each upload path loads with `import()` at upload
time. `photoExifFields(file, deviceMs)` returns:

- `capturedAt`: a number in epoch ms, as every reader already expects. It comes from EXIF
  `DateTimeOriginal`, else `CreateDate`, when the date is plausible (2005 or later, and no more than
  36 hours after the device clock). Otherwise it is the device clock.
- `capturedAtSource`: `'exif'` or `'device'`.
- `deviceCapturedAt`: the device clock, written only beside an EXIF date.
- `geoLocation`: written only when the file carries GPS, as `{lat, lng, accuracy: null, at, source: 'exif'}`.

exifr, vendored at 75 KB, loads only when a file has EXIF to read. A canvas JPEG from the in-app
camera is answered without it. Any failure, or a read that takes longer than 4 s, falls back to the
device clock.

Where it is wired:

- `photo-engine.js` `uploadPhotoToFirebase`: the device `capturedAt` pinned at capture stays the
  photo's identity and the fallback. EXIF GPS wins over a camera session fix, and `onSite` is
  measured from it to the lead.
- `customer-bootstrap.module.js` `uploadSinglePhoto`: the fields are merged into the photo doc.
- `dashboard-bootstrap.module.js` `_uploadPhoto`, a HELD file: two lines, around 4890 and 4893.
- `customer-photo-hub.js` `photoTime` reads `deviceCapturedAt` before `capturedAt`. A photo that was
  just uploaded, with `createdAt` not yet resolved, still sorts as just uploaded instead of under an
  older EXIF day.

The `/photos` create rule has no field allowlist. `tests/firestore-rules.photo-exif-fields.test.js`
(emulator) proves that the three real doc shapes still create.

Tests: `tests/install-completed-at-2026-11-09.test.js` and `tests/photo-exif-capture-2026-11-09.test.js`.
Both run the real functions in a vm, and the photo suite runs the real exifr over JPEGs built at runtime.

## Open items

- A lead created directly at a won stage (CSV import, payment backfill) is not a move onto
  Install Done, so it gets no `installCompletedAt`.
- The Stripe payoff advance goes to Final Payment and never enters Install Done, so it records
  no install date.
- Leads that reached Install Done before this change have no `installCompletedAt`. A backfill from
  `stageHistory` would be a separate dry-run script.
- `docs/pro/js/layouts/island-job.js` `photoMs` runs `Date.parse` on a numeric `capturedAt`, which
  returns NaN, so that layout already scores such photos 0. This was not changed.
- The customer page and the dashboard modal still write no `onSite` for EXIF GPS. Only PhotoEngine
  computes it.

## Review round (2026-11-09)

An independent review of this branch asked for changes. The branch is now rebased onto the
integration branch `claude/funny-hawking-t9zyzm`, so the plan is reachable from here:
[CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09](CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md).

- **Fixed, defect 1 (medium): the date was stored per lead, not per job.** `installCompletedAt` is
  now in all three pinned-equal `JOB_FIELDS` lists (`functions/jobs-logic.js`,
  `docs/pro/js/jobs-store.js`, `docs/pro/js/today-plan.js`). The effects:
  - Another job's card carries that job's own date.
  - Promotion nulls the old date, or carries the promoted job's date.
  - The jobs mirror copies the lead's stamp onto the active job.

  Before the fix, a second job read the first job's date, the review hand-off treated it as done, and
  its own first move onto Install Done was skipped. Test section 2c covers two jobs.
- **Fixed, defect 2: integration.** The rebase had conflicts in `dashboard.html`,
  `run-test-manifest.js` and `ci-manifest.json`, and I kept both sides' suites. Each cache key moved
  one past the base's value: script-loader 217, dashboard-bootstrap 45, customer-bootstrap 34. The
  floors were re-measured with `--check` and are now 1038/74/1179.
- **By design, defect 3: a drag back off Install Done keeps the stamp.** `completedAt` is cleared in
  that case; `installCompletedAt` is not. The rule was "recorded once, never overwritten". As a
  result, `isJobDone` (review hand-off) and `ai-texting` `isCustomer` still treat a lead dragged back
  to open work as done. The PR body should say so. This is pinned in the test as "a move back to open
  work does not clear it".
- **Fixed, defect 4: the photo CSV `uploadedAt` column.** The dashboard modal now stamps
  `uploadedAt` with server time, the same as the other two paths, so the column no longer falls back
  to the EXIF `capturedAt`. In the held file this added one token on line 4893.
- **Fixed, defect 5: a stalled module fetch.** The 4 s ceiling now covers the `import()` of
  `photo-exif.js` and the read together, on all three paths. In the held file this rewrote line 4890,
  the import line this branch added.
