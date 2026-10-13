# Visit recorder, PR 1: record first, save on the phone, upload later (2026-10-13)

Jo approved the in-person capture design ("go with your recommendations",
2026-10-13; the recon and design note is PR #2441, `projects/IN-PERSON-CAPTURE-RECON-AND-DESIGN-2026-10-13.md`
on `docs/voice-capture-design` until it merges). This is **PR 1 of 2: the
recorder.** No geocoding, no server transcription change, no new Cloud
Function.

Related: [PROMISE-CAPTURE-2026-10-12](PROMISE-CAPTURE-2026-10-12.md) (the
promise task shape PR 2 feeds), [../architecture/CALL-CENTER-2026-10-01.md](../architecture/CALL-CENTER-2026-10-01.md).

## What it is

One recorder, `NBDVisitRecorder`, that starts on a tap and never waits for the
network or for a customer, writes the audio to IndexedDB every 2 seconds,
uploads when it can, and only then lets the phone forget it.

| File | Job |
|---|---|
| `docs/pro/js/visit-recorder-logic.js` | pure decisions: mime, paths, backoff, chunk order, suggestions, consent, gates, the doc shape, badge words |
| `docs/pro/js/visit-recorder.js` | IndexedDB store, MediaRecorder session, wake lock, geolocation, upload drain, recovery |
| `docs/pro/js/visit-recorder-ui.js` | screens: start sheet, live panel, "Who was this?", search, Unfiled list, recovery prompt (all `textContent`, no `innerHTML`) |
| `docs/pro/js/visit-recorder-launcher.js` | the only boot-time file: entry points, Home bar, deep link, do-not-record toggle, Settings switch |
| `docs/pro/css/visit-recorder.css` | phone-first styles (44 px+ targets, high contrast) |

Boot cost: one deferred tag (17.9 KB, `localScripts` +1 / `localBytes` +18 KB,
deliberate raise in `tests/dashboard-boot-budget-2026-10-03.test.js`). The
recorder files (~52 KB) are fetched about 4 s after the page settles on
`requestIdleCallback`, **not at boot**, so a recording started with no signal
does not need the network to load its own code.

## Entry points

1. **Record a visit** bar on Home (dashboard `#view-home`, 56 px, above the
   bottom nav). Source `fab`.
2. **Record visit** on today's appointment rows. Pre-attaches the customer and
   the appointment id. The launcher adds the button to `.tp-row[data-tp-row^="appt:"]`
   rows itself (a debounced `MutationObserver`), so the Today files are untouched
   while the sibling Today PR is open. Source `appointment`.
3. **Record visit** on the customer page quick-actions (made a *primary* action
   in `customer-quick-actions.js` so it is not behind More on a phone).
   Pre-attached. Source `customer`.
4. **Deep link** `?capture=1[&lead=<id>]` on `/pro/dashboard.html`. Starts as
   soon as sign-in settles, then strips its own params so a reload cannot
   restart it. Source `deeplink`. Also an Android manifest shortcut.
5. **Unfiled visits** from the Home bar badge and from a button in Talk Tank.

## What is stored where

| Where | What | Who |
|---|---|---|
| IndexedDB `nbd-visit-recorder-db` / `visits` | one small row per visit (state, GPS, counters, retry schedule) | the phone |
| IndexedDB `nbd-visit-recorder-db` / `chunks` | the audio, 2 s ArrayBuffers keyed `{visitId}:{seq}` | the phone until the server confirmed both the object and the doc |
| Storage `audio/{uid}/_inbox/{visitId}.{webm\|m4a}` | the audio (base content type, no codecs param) | owner read/write (existing `storage.rules` `audio/{uid}/**`, unchanged) |
| Firestore `users/{uid}/visit_captures/{visitId}` | `startedAtMs, endedAtMs, durationSec, lat, lng, accuracyM, mime, sizeBytes, status, leadId, source, consentMode, appointmentId, audioPath, uploadedAtMs, chunkCount, backgroundSec, partOf, disclosureAckedAtMs, recoveredAtMs, attachedAtMs, discardedAtMs, createdAtMs` | owner only |
| `localStorage` `nbd_vr_cfg` / `nbd_vr_unfiled` / `nbd_vr_pending` | cached consent config; counters the Home badge and the boot check read without opening IndexedDB | the phone |
| `leads/{id}.doNotRecord` | per-customer flag | lead owner / company staff |
| `companies/{id}.visitRecordingReminder` | owner's optional reminder switch | company owner |

Status moves `recording -> stored -> uploading -> uploaded` (`failed`,
`discarded` off to the side). **PR 1 leaves every uploaded doc at `uploaded`.**
It is *not* made discoverable by the Voice Intel pipeline: the audio sits at an
`_inbox` path the trigger ignores, and the doc carries no field a server step
could mistake for work. PR 2 adds the trigger.

### Verified, not trusted: the `_inbox` claim

The recon note said the Voice Intel trigger ignores paths starting with `_`.
Checked in code, and pinned by a test that loads the real server module:

- `functions/integrations/voice-intelligence.js` `parseAudioPath` returns
  `null` when `isReservedLeadId(m[2])`; `functions/lead-artifact-paths.js`
  `isReservedLeadId` is true for any id starting with `_` or `.`.
  `_parseAudioPath('audio/u1/_inbox/v.webm') === null` (control: a lead-bound
  path parses).
- `storage.rules` `audio/{uid}/{allPaths=**}` already allows the owner to write
  any audio-typed object under 200 MB, so `_inbox` needed no rule change. The
  e2e uploaded to the Storage emulator under the real `storage.rules`.
- `functions/lead-artifact-cleanup.js`: a reserved lead id is never swept, so a
  deleted customer cannot reap an `_inbox` object either.

## Rules (`firestore.rules`, `tests/firestore-rules.visit-captures.test.js`)

`users/{uid}/visit_captures/{visitId}` has its own match (the
`users/{uid}/{subcol}` wildcard does not list it, so this is the only write
grant). Owner-only, non-viewer; `hasOnly` the allowlist above, so a client can
never set a server-owned field (transcript, summary, suggestions, analysis
status are all refused, each with a positive control); `leadId` null or a lead
the writer can reach (`leadReachable`: own lead, or company staff in the same
tenant); `audioPath` must be exactly `audio/{uid}/_inbox/{visitId}.{ext}` (the
PR 2 server reads it with admin credentials, so a client-chosen path would be
a read of any bucket object); `startedAtMs` write-once. A parity check fails if
the client's `DOC_FIELDS` and the rules allowlist drift.

The test runs in CI (`ci.yml` and the `firebase-deploy.yml` rules gate) and is
`wired-individually` in the manifest.

## Honest limits (also said in the UI)

- **A web app cannot record in the background or with the phone locked.** The
  live panel always says so. A Screen Wake Lock is requested (valid in the
  installed iOS app from 18.4); if it is lost or unsupported the panel says to
  keep the screen on. When the app returns from the background the elapsed gap
  is counted (`backgroundSec`) and named; chunks captured before it are kept.
- **Chunks are not independently playable.** Only the first carries the
  container header, so the upload is always the in-order concatenation. A hole
  (a lost chunk) is reported by `orderChunks`; the audio before it is intact.
- **Resumable upload is within a page's life.** `uploadBytesResumable` resumes
  across a flaky connection while the page lives. Across a reload the whole
  object is re-uploaded from the chunks still on the phone (same bytes, same
  path, idempotent).
- **iOS installed-PWA IndexedDB is not wiped after 7 days** (that cap is for
  Safari tabs) and the origin quota is large, but the recorder still asks for
  `navigator.storage.persist()` once and warns under 60 MB free.
- Location is requested lazily at the first start, with a plain reason on the
  recording screen the first time only, and never blocks recording. Coordinates
  are stored on the visit, not on the customer, and PR 1 does not use them to
  rank suggestions.

## Consent and do-not-record

- `recordingConsentMode` is read from `companies/{id}` by the launcher (cached).
  Unset means `one_party` for this feature (Ohio ORC 2933.52 and Kentucky
  KRS 526 are one-party): no disclosure at all by default.
- Owner-only switch in Settings > Company: "Remind me to tell them I am
  recording", off by default. It adds a one-line sheet before the first second.
- A company set to a two-party mode gets the line every time and a tap
  ("I told them - start recording"), stored as `disclosureAckedAtMs`.
- Per-customer **do not record**: toggle on the customer page (owner,
  company_admin, manager; the lead write rule still decides). Respected at
  start, at attach, and in the suggestions (a flagged customer is never
  offered). If a customer is not in memory yet (a deep link right after
  sign-in), the recorder asks the lead doc itself and, if flagged, stops and
  deletes the recording. **Found by the e2e**: the first version trusted
  `window._leads`, which is empty right after sign-in, and started recording a
  flagged customer from the deep link.
- Not legal advice. Counsel review of the policy remains open in the design note.

## Suggest and confirm

After Stop the "Who was this?" sheet shows 0-3 chips computed client-side from
(a) the customer the recording started from, (b) an appointment within +-60
minutes of when recording started, (c) the 3 most recently opened customers
(`nbd_recent_customers`). Each chip shows its evidence ("On your calendar at
6:54 PM, 15 min after you started."). Search customer reuses
`NbdGlobalSearch.searchLeads`. **Nothing is auto-filed**: the unit test asserts
`leadId === null` after stop even with matching chips available.

## Evidence (this PR)

| Check | Result |
|---|---|
| `node tests/visit-recorder-2026-10-13.test.js` (real modules in a vm sandbox with fake IndexedDB / MediaRecorder / geolocation / wake lock / clock / Firestore; a "kill" is a second sandbox sharing only IndexedDB + localStorage) | 126 passed |
| `tests/firestore-rules.visit-captures.test.js` | 52/52, each deny paired with an allow control |
| `tests/e2e/visit-recorder.spec.js` at 390 x 844, installed-app rules forced, real Chromium MediaRecorder with a fake mic, real Auth + Firestore + Storage emulators, real rules | 4 passed |
| boot-budget, inline-style ratchet, `check-js-syntax`, `check-site-integrity`, `apply-partials --check`, `check-inline-html-scripts`, `check-image-privacy`, marketing-polish, pwa-manifest | green |

The e2e's offline leg is `context.setOffline(true)`: start, stop, the "Saved on
phone - waiting for signal" badge, a chip with evidence, Save unattached, then
the signal returns and the visit uploads **without a tap**, the doc is
`uploaded` with `audioPath` under `_inbox`, the Storage object exists, the
local chunks are gone, and an attach-by-search writes `leadId`.

## What only a real iPhone can verify (Jo's pass)

1. `MediaRecorder` mime on iOS: the recorder asks for `audio/mp4`; confirm the
   file lands as `.m4a` and plays.
2. Wake lock in the **installed** app (iOS 18.4+): does the screen stay on for
   10 minutes without touching it? The panel text changes to a warning if it is
   released.
3. Background behaviour: record, switch to another app for 30 s, come back.
   Expected: "The app was in the background for 0:30 ..." and a silent stretch.
4. Geolocation prompt: appears once, at the first start, with the reason line;
   refusing it must not stop the recording.
5. Kill the app mid-recording (swipe it away), reopen: the "Recovered a
   recording from ..." prompt.
6. Airplane mode: record 2 minutes, stop, turn airplane mode off, wait. It
   should upload on its own.
7. The deep link from a Shortcut ("Open URL" to
   `https://nobigdealwithjoedeal.com/pro/dashboard.html?capture=1`): which app
   opens, and does a microphone prompt appear without a tap? Manifest
   shortcuts do not appear on iOS home-screen icons; this is not promised.
8. Add `?capture=1` through the login redirect: sign-in may drop query
   params; the deep link only works if the app is already signed in.

## For PR 2

- `onInboxAudioUploaded` (transcript first, analysis a separate retryable
  step, outage tolerant like PR #2437), writing next to the existing doc.
- Attach callable with tenancy check; promise tasks via `promise-logic`
  (`source: 'visit'`, both twins).
- Suggestions v2 with the call matcher; a Home "needs you" row for visits
  unattached after a day.
- The rules already reserve the doc shape; PR 2 adds server-only fields via the
  admin SDK, which the client allowlist already refuses to touch.
