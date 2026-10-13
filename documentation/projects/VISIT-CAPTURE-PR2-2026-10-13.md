# Visit capture, PR 2: the server pipeline, ranked suggestions, attach (2026-10-13)

Jo approved the in-person capture design ("go with your recommendations",
2026-10-13). PR 1 ([VISIT-RECORDER-PR1-2026-10-13](VISIT-RECORDER-PR1-2026-10-13.md))
records on the phone and uploads to `audio/{uid}/_inbox/`. **This is PR 2 of 2:
what the server does with it.** No geocoding (a backfill is Phase 2 of the
design note, `IN-PERSON-CAPTURE-RECON-AND-DESIGN-2026-10-13.md`, PR #2441).

Related: [PROMISE-CAPTURE-2026-10-12](PROMISE-CAPTURE-2026-10-12.md) (the task
shape this feeds), [../architecture/CALL-CENTER-2026-10-01.md](../architecture/CALL-CENTER-2026-10-01.md)
(the matcher and the outage rule this reuses),
[../audit/LEAD-TASK-SHAPE-2026-09-26.md](../audit/LEAD-TASK-SHAPE-2026-09-26.md).

## The states

The client's `status` stays the upload lifecycle (`stored -> uploading ->
uploaded`). The server keeps its own machine in **`pipelineStatus`**, so a stale
write from the phone can never knock the pipeline backwards (the design note
sketched "status: transcribed"; one field written by two parties is the PR 1
race again, so there are two fields).

| `pipelineStatus` | Meaning | Next |
|---|---|---|
| (absent) / `queued` | uploaded, untouched | process |
| `waiting_object` | the client says uploaded but the Storage object is not there (or Storage could not be asked) | retried every 10 min; after 24 h `failed: object_missing`. **No vendor call is ever made on a missing object** |
| `transcribe_pending` | Groq credit / key / 429 / 5xx, or the company's daily audio budget, or the AI kill switch | retried by the sweep; **no strike**, audio kept |
| `consent_pending` | `two_party_verbal`: the consent check hit an outage | fails CLOSED: no notes, no suggestions, no attach until it passes |
| `transcribed` | transcript saved on the doc (this is written BEFORE the Claude call) | notes |
| `notes_pending` | Anthropic outage (credit is exhausted in prod today): "Transcript saved, notes pending" | retried by the sweep (1 h for credit/key, 10 min for 429, 5 min for 5xx); re-runs **only** the notes |
| `notes_failed` | three notes failures that were the recording's own | transcript kept; the person can "Retry notes" |
| `ready` | notes + suggestions written | file it if a customer is chosen |
| `failed` | `bad_audio_path`, `object_missing`, `audio_empty`, `too_large` (> Groq's 25 MB), `too_long` (> 62 min), `no_speech`, `transcribe_failed` (3 strikes) | audio kept; reason in `pipelineNote` |
| `skipped` | `do_not_record`, `do_not_record_match`, `personal` | **audio deleted, transcript and notes wiped** |
| `quarantined_consent` | a two-party company with no disclosure tap, or no verbal yes in the opening | audio deleted, transcript wiped |
| `discarded` | the phone discarded it | audio deleted, anything filed on a customer retracted |

Only the states a retry can move are in `RETRY_STATES`; everything else is
terminal and `nextStep` returns `none`, so the trigger's own writes re-fire it
into a no-op (checked: no hot loop on an internal error, a failed audio delete,
a backoff, or a settled doc).

## What runs

| Function | Kind | Why it exists |
|---|---|---|
| `onVisitCaptureWrite` | Firestore trigger, `users/{uid}/visit_captures/{visitId}` | The doc is the only place that knows the audio is *ours* and *finished*. A Storage trigger (`onAudioUploaded`) cannot see the doc, and the doc is written after the object, so it would race the client. It also deletes the audio when a doc is deleted. |
| `visitCaptureSweep` | schedule, every 30 min, heartbeat slug `calls-texts-ingest` | An outage leaves docs that nothing re-triggers. The sweep retries them, and picks up a doc uploaded in the last 48 h whose trigger never ran. |
| `attachVisitCapture` | callable | attach / detach / "not these" / retry notes / a ten-minute audio link |
| retention phase | a third phase inside the existing `recordingRetentionCron` | no new function: it calls `visit-capture.retentionSweep` |

No existing scheduled/trigger function fits the first two: the call-center
transcriber is single-owner (a hard-coded owner uid) and is being rewritten in
PR #2437; a Storage trigger cannot hold the doc's state. All three are mapped in
`functions/function-map.json` and `FUNCTIONS_INDEX.md`; the viewer-callables
sweep classifies `attachVisitCapture` as `role-gated`.

Files: `functions/visit-capture-logic.js` (pure), `functions/visit-capture.js`
(I/O), `docs/pro/js/visit-unfiled-today.js` (the Today row).

## The pipeline, in order

1. **Verify.** `audioPath` must be exactly `audio/{uid}/_inbox/{visitId}.{ext}`
   (a forged path naming another user's object is never read; tested). Then
   `file.exists()` and size. The client's `status: 'uploaded'` is a claim.
2. **Gates before any spend:** AI kill switch (`aiDisabled` + `voiceIntelDisabled`),
   the lead's `doNotRecord`, the consent mode (`two_party_attested` without
   `disclosureAckedAtMs` is quarantined; `two_party_verbal` runs the existing
   opening-window check), the company's daily audio budget (`checkBudget`).
3. **Transcribe** with Groq. New: a vocabulary `prompt` (the pre-attached
   customer, today's appointment customers, the 25 most recently touched
   customers, their streets and towns, then GAF / TAMKO / IKO / Owens Corning /
   CertainTeed / Timberline HDZ / roofing terms), capped at 560 characters so it
   stays inside Whisper's ~224 tokens. `transcribeGroqBuffer` gained an optional
   `prompt`; every existing caller's request is unchanged.
4. **Correct** with a short whole-word list (`gaff` -> GAF, `tam co` -> TAMKO,
   `certain teed`, `timber line`, `A C V`...) and a one-edit fix of a
   *capitalised* word to a surname/street word of a customer this tenant has
   (`Smyth` -> `Smith`; `mother` is never touched). **The raw transcript is
   kept beside the corrected one**, and the corrections are listed.
5. **Save the transcript first** (`pipelineStatus: transcribed`), then usage.
6. **Suggestions** from the transcript alone, so an AI outage still has chips.
7. **Notes** (Claude Haiku 4.5): summary, promises with who and a stated date,
   follow-ups, measurements/scope facts *as said*, insurance details, speaker
   roles (best effort), and caller name/street/town. `personal` deletes
   everything. The caller facts re-rank the suggestions.
8. **File** when the *client* pre-attached the capture (started from a
   customer page or appointment). This is the only automatic attach.

### Outage handling

`classifyProviderError` (credit 400/402, auth 401/403 / not configured, 429,
5xx/529) is the same rule as PR #2437's call-line classifier and reads the same
strings; if `call-center-logic.js` exports one (after #2437 merges) this file
uses it and the test asserts parity. A provider outage never increments a
strike (`transcribeStrikes`, `notesStrikes`), never sets `failed`, keeps the
transcript, and sets `pipelineNextAtMs`. Own-fault failures strike three times
then stop, with the transcript kept.

## Suggestions (no auto-attach)

`rankSuggestions` returns up to three chips, each with an evidence string.
`autoAttach` is `false` in the return value and nothing reads it as true.

| Signal | Score | Rule |
|---|---|---|
| appointment | 90 (70 if more than one customer that hour) + up to 4 for closeness | within +-60 min of when recording **started** (the phone's own window); a cancelled appointment is ignored; an appointment pinned by the client's `appointmentId` is 95 |
| said | 85 (95 if it disagrees with the calendar) | the **call matcher unchanged**: `suggestLeadForCall` (full name said, numbered street said) then `suggestByFacts` (name + street, name + town, house number + street; a conflict rules a lead out). **Two customers matching is a refusal: no chip.** |
| GPS | 70 | exactly **one** customer that has coordinates inside max(40 m, 2 x accuracy), capped at 200 m; a fix worse than 150 m is not used. The evidence says only customers with a map pin were checked (127 of 262 addressed leads have one; this can never mean "nobody else is here") |
| recency | tie-break only | touched in the last 14 days; never creates a chip |

A do-not-record customer is never offered. If the unique match *is* a
do-not-record customer, the capture is purged instead (`do_not_record_match`).

The phone merges the server's chips (first, with evidence) with its own
(`mergeChips`), minus customers the person said "Not these" to. "Not these"
goes through the callable so the server remembers `rejectedLeadIds`.

## What attaching files

One idempotent set, all keyed by the visit id (`doFinalize`):

| Where | What |
|---|---|
| `leads/{id}/activity/visit-{visitId}` | the timeline row: summary, what you said you would do, what they said they would do, **"Said (not measured)"** facts, insurance (as said). Rendered by `call-timeline.js` (`fromVisit`). **No URL**: it carries `audioVisitId`; the phone asks the callable for a ten-minute signed link |
| `leads/{id}/tasks/visit-{visitId}-p{n}` | a **`kind:'promise'`** task per promise, `source:'visit'`, `promiseKind` guessed (estimate / order / permit / text / callback; what *they* promised is `waiting` on the customer / adjuster / supplier), `dueDate` = the stated date when it is today or later and under 120 days, else tomorrow, with `dueStated:false` |
| `leads/{id}/tasks/visit-{visitId}-f{n}` | follow-ups, the lead-task shape (`text`+`title`, `done:false`, `dueDate`, `dueInferred`) |

`source: 'visit'` is added to `SOURCES` in **both** twins
(`functions/promise-logic.js`, `docs/pro/js/promise-logic.js`; the byte-identical
test still passes). The server channel reads one collection-group query on
`tasks.userId`, keeps `kind === 'promise'`, and needs `promiseKind` to be a
known kind: a visit promise is visible to it (tested with the same predicate,
and with the real `promise-channel.js` when #2444 is on the base).

Tasks are created only when absent: a task Jo ticked or edited is never
re-opened by a retry. Changing the customer retracts what was filed on the old
one (the row, and tasks that are still open); ticked ones stay. A discard on
the phone retracts the same way.

## The callable: `attachVisitCapture`

`{ visitId, action: attach | detach | notThese | retryNotes | audioUrl, leadId }`

- uid comes from the token, never the client: a person acts on their **own**
  captures (another user gets `not-found`).
- roles: no role (solo owner), `owner`, `company_admin`, `manager`, `admin`.
  Viewer / anonymous / sales rep refused. App Check enforced.
- the lead must exist, not be deleted, and be reachable
  (`uploaderMayRecordOn`: your own, or your company's); a do-not-record
  customer is `failed-precondition`.
- idempotent: attaching the same customer again returns `already: true` and
  writes nothing under the lead.
- `audioUrl`: a v4 signed URL valid ten minutes, never stored; refused once
  the audio is deleted. No download tokens anywhere.

## Today: the "N unfiled visits" row

`docs/pro/js/visit-unfiled-today.js`, a **new** file that touches no Today
code: it listens for the `nbd:today-rendered` event `today-home.js` already
dispatches and inserts one `.tp-sec` after the header. It is loaded lazily by
the launcher right after the recorder (no new boot tag, no change to
`dashboard.html`), so it only appears once the recorder has booted (about 4 s
after the page settles).

Visits unattached and older than 24 h, **counted once** (a capped recording
and its part 2 are one visit; discarded / skipped / still recording are not
counted). Buttons: **Attach** (the Unfiled visits sheet), **Keep** (hidden
until tomorrow, or sooner if more pile up), **Discard** (arm, then all of them;
a visit another device uploaded is discarded on the server doc).

Not done on purpose: the row does not add to the headline count of
`today-home.js` ("N things need you"): that would be an edit in the Today
files the sibling PRs (`feat/today-row-and-handled-flow`,
`feat/today-boot-phone-undo`) are changing. One-line follow-up once they land.

## Settings, retention

- Owner-only number in Settings > Company: **Keep the raw audio N days**
  (7 to 3650, default 90). It writes `companies/{id}.recordingRetentionDays`,
  the **same field the existing recordings cron already reads**; the cron now
  has a third phase that deletes `audio/{uid}/_inbox/*` (attached or not,
  because attach never moves the object). The transcript and notes stay.
- The per-customer do-not-record toggle and the reminder switch are PR 1's.
- Skipped / quarantined / discarded audio whose delete failed is retried by the
  nightly phase as soon as the doc is 7 days old (it is overdue regardless of
  the company's 90 days).

## Rules and indexes

- `firestore.rules`: PR 1's update rule compared `hasOnly(allowlist)` on the
  **whole** merged doc, so the first server field on a doc would have made
  every later phone write (discard, upload confirm, attach) fail. The update
  rule now checks what **changed** (`diff().affectedKeys().hasOnly(vcKeys())`)
  and still validates every allowlisted field on the whole doc. Create is
  unchanged. 22 new checks (server fields may sit on the doc; the phone cannot
  set, change, delete or smuggle one; bad values / other tenant / viewer still
  refused).
- `firestore.indexes.json` (the emulator never enforces indexes): composite
  COLLECTION_GROUP `visit_captures` (`status`, `uploadedAtMs`) for the
  lost-trigger query; composite (`audioLive`, `uploadedAtMs`) for retention;
  single-field COLLECTION_GROUP override on `pipelineStatus` for the retry `in`
  query. The appointments query is the one the phone already runs (indexes
  exist). Leads are read by `userId ==` and `companyId ==` (single field).

## Evidence

| Check | Result |
|---|---|
| `node tests/visit-capture-pipeline-2026-10-13.test.js` (real modules, in-memory Firestore that honours where / orderBy / startAfter, fake Storage, stubbed Groq / Claude) | 129 passed |
| `node tests/visit-recorder-2026-10-13.test.js` (PR 1 suite + 35 for the callable path, pipeline words, merged chips, the Today row in a fake DOM) | 222 passed |
| `tests/firestore-rules.visit-captures.test.js` (Firestore emulator) | 87/87 |
| function-map `--check`, check-js-syntax, site-integrity, apply-partials, sitemap, inline scripts, image privacy | clean |

Scenarios the pipeline test pins: outage -> transcript saved, no strike, notes
later (and only the notes run, and the backoff is respected); Groq outage;
three own-fault failures -> `notes_failed` -> manual retry; missing object ->
not processed (+ 24 h -> failed; Storage down is "not yet"); forged
`audioPath` never read; do-not-record (pre-attached and named) -> audio
deleted; personal; two-party no-ack / no verbal yes / consent outage fails
closed; kill switch; budget; ambiguous name -> no suggestion, no attach; two
concurrent invocations -> one Groq call; a pre-attached capture files itself
and the channel read sees the promise; ticked tasks survive a re-file; change
customer retracts; discard retracts; the callable's tenant / role / DNR /
idempotency; retention per company; the sweep.

## Cost of one 30-minute memo

Groq whisper-large-v3-turbo $0.04 per audio hour = **$0.02**. Claude Haiku 4.5
($1 / $5 per million tokens): about 6.5k tokens of transcript + 0.6k prompt in,
0.7k out = **$0.011**. Suggestions, corrections and filing are free.
**About 3 cents a memo**; a 60-minute memo (the cap) about 6 cents. Ten
30-minute visits a day is about 30 cents. The kill switch and the company
budget bound it.

## Honest limits

- The client's suggestions need the phone online once (they read the doc). A
  visit attached offline is carried by the local write and filed by the
  trigger when the pipeline gets there.
- GPS only helps for the customers that have a pin. The geocode backfill is
  still Phase 2.
- Whisper does not diarize: `speakers` is the model's guess from content.
- The vocabulary prompt and the corrections have not been measured on real
  memos yet; the design note's accuracy test (three real memos with and
  without the prompt) is still the way to know.
- `personal` is judged by the model and deletes the audio, the same trade the
  call line makes. A misjudged visit is lost; the transcript was never kept.
- A lead's `doNotRecord` is enforced by this pipeline and the callable, not by
  Firestore rules (PR 1's residue: other open PRs edit that region).
- The pipeline does not alert Jo on an outage (the call line already tells
  him about Anthropic credit once a day, and the memo's own sheet says "notes
  pending"). A visit-specific alert is easy to add if he wants it.

## What only a real device or Jo can verify

1. A real 30-minute memo from the installed iPhone: the `.m4a` lands, Groq
   accepts the file, the transcript quality with the vocabulary prompt.
2. After Anthropic is topped up: a memo that was `notes_pending` gets its
   notes by itself within an hour, and "Retry notes" works from the sheet.
3. The Today row after 24 h of an unfiled visit, and Keep / Discard on the
   phone (fake-DOM tested, not on a device).
4. `Play audio` plays on iOS (the signed URL needs
   `roles/iam.serviceAccountTokenCreator`, granted 2026-09-03).
5. The retention number saves from Settings (owner) and the 05:00 cron logs
   `visitAudio: { deleted: ... }`.
6. Deploy: three new functions (`onVisitCaptureWrite`, `visitCaptureSweep`,
   `attachVisitCapture`) and the new indexes; the first deploy builds the
   indexes before the sweep's queries work (until then the sweep logs
   `visit_capture_sweep_*_query_failed` and the trigger still does the work).
