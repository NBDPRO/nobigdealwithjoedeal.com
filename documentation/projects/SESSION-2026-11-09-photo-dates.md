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
