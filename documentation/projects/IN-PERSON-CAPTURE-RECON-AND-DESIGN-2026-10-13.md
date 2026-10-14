# In-person conversation capture: recon and design (2026-10-13)

Jo's ask, in short: the call memos and Thursday spoiled him; he wants the same
for every in-person conversation, with the memo **attached to the right
customer** (by location, or picked before starting), and he wants linking,
ease of use, reliability, accuracy and speed-to-start all streamlined.

**Status:** recon + design only. No code changed. Prod was read once, counts
only (section 1.9). Not legal advice (section 7).

Related notes: [PROMISE-CAPTURE-2026-10-12](PROMISE-CAPTURE-2026-10-12.md)
(the promise task shape this design feeds),
[CALL-CENTER-2026-10-01](../architecture/CALL-CENTER-2026-10-01.md) (the call
pipeline whose matcher we reuse),
[THURSDAY-BLAND-2026-09-26](../architecture/THURSDAY-BLAND-2026-09-26.md),
[NEXT_SESSION-2026-10-13-part2](NEXT_SESSION-2026-10-13-part2.md) (current
handoff).

## 0. The short version

1. **Jo is right that a lot exists. Almost none of it is used.** There are
   five separate in-person recording code paths. A read-only prod count found
   **0 docs in `users/*/captures`** (Quick Capture / Talk Tank) and **0 docs
   in any `leads/*/recordings`** (Voice Intel). The call pipeline, by
   contrast, is live. The in-person path is built; it is not a habit and it
   is not dependable.
2. **The strongest piece is already built and idle:** Voice Intel
   (record on a customer page, resumable upload to Storage, server
   transcription, speaker roles, commitments, `voiceConsumer` turns them into
   tasks). It only works when you start from a customer's page, and it has no
   local buffer.
3. **The piece Jo thinks of as "the talk tank" (Quick Capture) is the weakest:**
   audio is never kept, the recording lives only in memory, the whole result
   is lost if the Claude step fails (and Anthropic credit is exhausted today),
   and customers are attached by a manual picker after the fact.
4. **Geotag is feasible but half the data is missing:** only **127 of 262**
   live leads with an address (48%) have lat/lng, and only 84 of the 218 leads
   created in the last 90 days. Proximity matching needs a geocode backfill
   first, and the lead-save path does not guarantee coordinates.
5. **Recommended shape:** one new "visit memo" front door that records first,
   keeps audio on the phone until it is safely uploaded, and attaches by a
   ranked suggestion (today's appointment, then nearest, then spoken name)
   with a one-tap confirm chip, feeding the **existing** Voice Intel analysis
   and the **existing** promise-task shape. Phase 1 is two PRs and needs no
   geocoding.

## 1. Recon: what exists, exactly

### 1.1 Surface map

| Surface | Files | Starts how | Audio kept? | Transcribed | Attach to customer |
|---|---|---|---|---|---|
| **Quick Capture** ("Talk it out") | `docs/pro/js/quick-capture.js` | FAB `#nbd-qc-fab` (🎙, bottom-right, behind the ⋯ speed dial on phones), command palette, mobile "+" menu row "Voice Note" | **No.** Blob lives in a JS variable (`_chunks`), 5 min cap (`MAX_RECORD_MS`, line 44) | After stop, `dictate` callable, `mode: 'summarize'` (line 376-387) | Manual, after the summary renders. On a customer page, one tap "Save to <name>" (PR #2405). Elsewhere a picker over `window._leads` (line 503) |
| **Talk Tank view** | `docs/pro/js/talk-tank.js` (route `#/talk-tank`) | Nav item, "Record" button calls `NBDQuickCapture.open()` (line 165) | n/a (reads `users/{uid}/captures`) | n/a | List only. Linked / "Joe note" filter, open customer, archive. **No link or re-link action here** |
| **Capture inbox** | `docs/pro/js/quick-capture-inbox.js` (FAB `#nbd-qci-fab`) | 📋 FAB | n/a | n/a | Has a **Re-link** button (line 262) and re-commit tasks |
| **Dictate everywhere** | `docs/pro/js/nbd-whisper.js` (mic FAB `#nbd-whisper-fab`) | Mic FAB, 60 s cap | No | `dictate` mode `clean` | None. Text goes into a focused input only |
| **Voice Intel (record a call/visit on a customer)** | `docs/pro/js/voice-intelligence.js`, mount `customer-voice-intelligence.module.js` at `#voiceIntelRoot` (customer.html:2543); server `functions/integrations/voice-intelligence.js`, `functions/voice-consumer*.js` | "Record call" button on the customer page, then a consent modal | **Yes**, `audio/{uid}/{leadId}/{recId}.{ext}`, up to 200 MB | Server: Storage trigger `onAudioUploaded` -> Groq whisper-large-v3-turbo -> Claude Haiku analysis | **Implicit**, the lead whose page you are on |
| **Voice memo (card detail)** | `docs/pro/js/voice-memo.js` -> `transcribeVoiceMemo` (`functions/integrations/voice-memo.js`) | Lead card button, 60 s | **Never** ("audio is NEVER written to Storage") | Groq, returns text, files a `voice_memo` activity | The lead it was started on |
| **D2D knock voice note** | `docs/pro/js/d2d-tracker-ui-2026b.js:70-110`, upload at `d2d-tracker-core-2026b.js:4970` | Mic button in the knock sheet, 30 s | Yes, `audio/{uid}/d2d/{knockId}_{ts}.webm` | **Never** (Voice Intel deliberately ignores `d2d`) | The knock |
| **Command bar mic** | `docs/pro/js/ui.js:256-360` | Command bar mic | No | `dictate` | None |
| **Voicemail** | `docs/pro/js/voicemail.js` | Record button -> `dictate` summarize | No | `dictate` | The lead it is on |
| **Phone calls** | `functions/call-center*.js`, `call-center-logic.js`, Cube ACR on Jo's phone -> Drive | Automatic (every 30 min) | Yes, `calls/{owner}/cube-acr/...` private | `callCenterTranscribe` (Groq), notes by Claude | By phone number, then spoken facts (below) |
| **Thursday** | `functions/integrations/thursday.js` | Bland webhook | Yes, copied to Storage | Bland + Claude | Phone, creates or attaches lead |
| **Field App capture** | `docs/pro/js/layouts/field.js` | Capture tab | n/a | n/a | **Photos only.** No voice. Has the arrival stamp with GPS (below) |

Honest count: **five** MediaRecorder implementations for in-person audio
(`quick-capture.js`, `nbd-whisper.js`, `voice-memo.js`, `voicemail.js`,
`voice-intelligence.js`) plus D2D's and the command bar's. They differ in caps
(30 s, 60 s, 5 min, 200 MB), MIME choice and error handling.

### 1.2 Speed to start (taps from cold)

- **Installed iPhone app, from the home screen:** open app (lands on
  `/pro/dashboard.html`), wait for boot, open the ⋯ field-tools dial
  (`fab-speed-dial.js`), tap the 🎙 capture FAB, tap the big mic. **About 4
  taps plus a boot**, then the mic permission prompt the first time.
- **From a customer page:** the Voice Intel "Record call" button is one tap
  plus the consent modal (checkbox) = 2-3 taps, and the customer is
  pre-attached.
- **Quick Capture on a customer page** is 2 taps to record, then "Save to
  <name>" after stop.
- **No one-tap launch anywhere.** There is **no deep link** that opens the
  recorder (`?capture=` was searched for and does not exist; the only
  deep-link params found are `?open=promises&item=` for Call Center,
  `call-center-view.js:982`). `docs/pro/manifest.json` has four shortcuts (CRM,
  D2D, Map, New Estimate), none for capture, and shortcuts are an Android
  feature (section 3.1).
- The mobile "+" menu row says "Voice Note: Talk it out - save to Talk Tank
  or a lead" (`dashboard.html:6326`), which routes to the same Quick Capture.

### 1.3 Storage, transcription, extraction

- **Quick Capture / dictate (`functions/dictate.js`):** audio goes as
  **base64 inside the callable payload**, hard cap 1.5 MB
  (`MAX_AUDIO_BYTES`, line 63) and a 60 s function timeout. Transcription is
  Groq `whisper-large-v3-turbo` (via `transcribeGroqBuffer`), language forced
  to `en`, **no vocabulary prompt is sent**. Then one Claude Haiku 4.5 call.
  Per-uid rate limit 30/hour. Audio is discarded. The `summarize` schema is
  overview, actionItems, people, addresses, amounts, dates, category.
  **There are no promises, no who-said-it, no insurance fields.**
- **Failure behavior (important):** `dictate` refuses up front with
  "AI processing not configured" if the Anthropic key is missing (line 255),
  and throws `AI processing failed` if Claude errors (line 182). In both cases
  **the Groq transcript that was already paid for is dropped**, and so is the
  audio. With Anthropic credit exhausted today, Quick Capture cannot produce
  anything. (This is probably why `captures` is empty. That is an inference,
  not proven.)
- **Likely size trap, unverified on a device:** the 5-minute Quick Capture cap
  versus the 1.5 MB dictate cap. Opus/webm at default bitrate fits roughly
  5 min; iPhone Safari records `audio/mp4` (AAC), which is larger per minute,
  so a long iPhone memo can exceed 1.5 MB and be rejected after the rep has
  finished talking. Needs a real-phone test before relying on it.
- **Voice Intel (`voice-intelligence.js`):** transcript is **persisted before
  analysis** (`status: 'analyzing'`, line ~660), so an analysis failure leaves
  a transcript on the doc with `status: 'failed'`; re-analysis is possible
  (`forceReanalyze`, admin callable). Analysis output (`summary`): overview,
  damageNoted, objections, **commitments {who, what, when}**, nextActions,
  insuranceDetails (carrier, claim number, adjuster, deductible), redFlags;
  plus `speakers[{label, role, confidence}]` where role is
  rep/homeowner/adjuster/spouse/other, **inferred by the LLM from the text**,
  not acoustic diarization. `voiceConsumer` then writes tasks
  (`source: 'call'`, nextActions + commitments), backfills insurance fields
  only where empty, and denormalizes red flags. Budget gate per company per
  day; kill switch `voiceIntelDisabled`.
- **Call center:** `sanitizeNotes` extracts `promises[{who: jo|them, text, due}]`,
  `followUpDate`, `urgent`, `callerFacts{name, street, town, service}`.
  Promise tasks (`kind: 'promise'`, `promiseKind`, `source`) are what Today,
  Waiting and the server promise channel read (`functions/promise-logic.js`,
  `SOURCES = ['call','text','today','customer']`). **Voice Intel commitments
  and Quick Capture action items do not carry `kind: 'promise'`**, so an
  in-person promise is a plain task, not something the never-forget ladder
  re-tells.

### 1.4 How attachment works today (and what is reusable)

- **Quick Capture:** manual picker. `pickerLeads()` (line 493) puts the current
  customer first, then the first 30 matches of `window._leads` in array order.
  No proximity, no appointment, no recency ranking. The spoken-name resolver
  does not exist for this path (`entity-resolver.js` is only a search-or-create
  picker used by Job Templates; its own header lists quick-capture's picker as
  a "bespoke duplicate").
- **Call center matcher is the gem:** `suggestLeadForCall` /
  `suggestByContactOrSaid` / `suggestByFacts` in
  `functions/call-center-logic.js` (lines 603-738) already do "who did they
  say they were": name said in the transcript, address said, name + street,
  name + town, conflicts rule a lead out, Thumbtack masked-number special
  cases, **never auto-picks when ambiguous**. It is pure and server-side. It
  can be run against an in-person transcript unchanged (minus the phone-number
  tier).
- **Voice Intel:** attach is the page you are on; tenancy is checked
  server-side (`uploaderMayRecordOn`).

### 1.5 Where results appear

- Quick Capture: `users/{uid}/captures/{id}` (private to the user), and when
  linked a `leads/{id}/activity` note "Voice capture" and optional
  `leads/{id}/tasks` (`source: 'voice-capture'`). Visible on the customer
  timeline only after linking. **Not** on Today, not in Call Center, no
  promises.
- Voice Intel: `leads/{id}/recordings/{rec}` (list on the customer page),
  tasks from `voiceConsumer`.
- Voice memo: `leads/{id}/activity` type `voice_memo`
  (rendered via `call-timeline.js`).
- Calls: Call Center, Today "needs you", promises deck.

### 1.6 Offline, backgrounding, reliability

- **Local buffering of audio: none.** `quick-capture.js`, `voice-memo.js`,
  `nbd-whisper.js`, `voice-intelligence.js` all hold chunks in memory.
  `rec.start(1000)` emits a chunk each second, but the chunks are never
  persisted anywhere (the `voice-intelligence.js` comment "so no data lost on crash" is
  only true while the page lives).
- **Upload retry:** `uploadAudioBlob` uses `uploadBytesResumable`, so a flaky
  connection resumes within the page's life. If the upload ultimately fails
  the rep gets a toast and the **blob is gone**. Quick Capture has no retry
  at all: one `dictate` call, failure = "Capture failed: try again" (the audio
  is already discarded after `_onStop`).
- **Durable-queue precedent exists:** `photo-queue-store.js` (IndexedDB queue
  for photo uploads that survives the iOS bfcache reload) is the pattern to
  copy. `offline-manager.js` has an IndexedDB write queue but its own header
  (in `photo-queue-store.js`) documents it as the wrong shape for large blobs
  and as having zero callers.
- **Backgrounding / lock:** no `wakeLock`, no `visibilitychange` handling
  anywhere in docs/pro (grep). Quick Capture closes on `pagehide`
  (line 111). On iOS, a standalone web app that is backgrounded or locked
  loses microphone capture, and `dashboard-sw-bootstrap.js` reloads on bfcache
  resume (per the photo-queue note), which destroys an in-memory recording.
  Treat any recording longer than "stay in the app with the screen on" as at
  risk until proven otherwise on Jo's phone.
- **Max length:** Quick Capture 5 min, dictate 60 s, D2D 30 s, Voice Intel
  200 MB. A real kitchen-table conversation is 10-45 minutes; only Voice Intel
  can take that.
- **No chunking** to the server for transcription; Groq's file limit is far
  above any realistic memo, but the dictate path's 1.5 MB is the binding
  limit.

### 1.7 Accuracy

- Model: Groq `whisper-large-v3-turbo`, `language: 'en'`, `response_format:
  verbose_json` with segment timestamps. **No `prompt` field is sent**, so
  there is no vocabulary biasing for street names, customer names, "TAMKO",
  "GAF", "Timberline HDZ", "ridge vent", "drip edge", "ACV/RCV".
- **Speaker separation:** none at the audio level. Whisper does not diarize.
  The analysis prompt asks the LLM to infer speaker roles from content, which
  is reasonable for a two-person visit and unreliable when the rep and
  homeowner both say "I'll send that".
- **Post-edit UI:** none for transcript or names. Quick Capture shows the
  transcript in a `<details>` read-only block. `quick-capture-inbox.js` can
  re-link but not edit text.
- Confidence: dictate returns a `confidence` value, no UI uses it.

### 1.8 Consent, privacy, retention

- **Voice Intel** has a consent model: `companies/{id}.recordingConsentMode`
  one of `one_party`, `two_party_attested` (checkbox), `two_party_verbal`
  (server checks the first ~25 s of transcript for a non-rep affirmative and
  **quarantines** the recording if absent; fails closed). Default when unset
  is `two_party_attested`. **All 3 company docs in prod have the field
  unset**, so every Voice Intel recording today shows the attest checkbox
  even though Ohio and Kentucky are one-party states. There is no Settings UI
  for the field (grep found it only in the two voice-intelligence files).
- **Quick Capture / voice memo / dictate / D2D:** **no disclosure prompt, no
  consent record.**
- **Per-customer do-not-record:** none. Contact labels (`contact-labels.js`,
  `capture: 'off'`) exist for **phone numbers** and stop copying/transcribing
  calls; they have no meaning for an in-person visit.
- **Storage rules:** `audio/{uid}/**` read = owner or admin only, write =
  owner, < 200 MB, audio MIME allowlist (`storage.rules` ~277). A leading
  `_` lead-id segment is "reserved" and ignored by the Voice Intel trigger
  (`isReservedLeadId`), which matters for the inbox design.
- **Retention:** `recordingRetentionCron` (daily 05:00), default
  `RETENTION_DEFAULT_DAYS = 90` (voice-intelligence.js:881), per-company
  override 7-3650 days; soft-deletes then removes audio. Quick Capture
  `captures` docs have no retention (and no audio).
- **Who can read:** `users/{uid}/captures` owner/admin only (firestore.rules
  ~1717), so a crew member or an office assistant cannot see Jo's captures
  even when linked to a shared lead.

### 1.9 Location and geocoding that already exists

- **Foreground GPS reads** (`navigator.geolocation.getCurrentPosition`) exist
  in: Field App "I'm on site" (`layouts/field.js:394`, stamps lat, lng,
  accuracy on `leads/{id}/activity`), D2D (`watchPosition`, battery-guarded
  on tab hide), photo EXIF fallback (`photo-engine.js:1072`), maps, storm
  center, auto-theme (sunrise). **Nothing uses location to find a customer.**
- **Haversine / distance code exists** in `layouts/mission-logic.js`,
  `d2d-tracker-core-2026b.js`, `yard-signs-logic.js`, `photo-engine.js`,
  `functions/agent-mcp-logic.js` (`storm_near_customers`),
  `functions/storm-tag-logic.js`. The drone-EXIF GPS-to-lead match from the
  photo work is the same idea.
- **Geocoding:** `geocode()` in `dashboard-api.js:322` (Nominatim, client side,
  single result). Lead modal resets pending pin coordinates in
  `crm-leads.js:196`. There is no server-side geocode on lead create and no
  coverage guarantee.
- **Prod coverage, read-only, counts only** (one Admin SDK read of `leads`,
  fields `lat/lng/address/deleted/createdAt` only, nothing printed but
  integers): 294 lead docs, 267 not deleted, 262 with an address,
  **127 with numeric lat/lng (48% of addressable leads)**; 135 have an
  address but no coordinates. Of 218 leads created in the last 90 days,
  **84 have coordinates (39%)**. So proximity suggestion would be blind for
  roughly half of the customers Jo is actually standing at.
- Also from the same read: 0 `captures` docs, 0 `recordings` docs, 3 company
  docs, none with a consent mode set.
- `window._leads` on the dashboard is the in-memory source for any client-side
  nearest-lead ranking; it carries `lat`/`lng` where present
  (`dashboard-actions.js:957`, `2658`).

### 1.10 Cost and limits

- Groq free tier per the dictate header (verified 2026-09-02): 20 req/min,
  2,000 req/day, 8 h audio/day. Paid Whisper turbo is on the order of
  $0.04 per audio hour (the code's own cost model uses $0.000011/s). 10
  visits x 20 min = 3.3 h/day = about 13 cents/day at the paid rate.
- Claude Haiku 4.5 analysis ~2k in / ~600 out tokens per memo, fractions of a
  cent. Cost is not the constraint; **availability is**: `dictate` and Voice
  Intel both need the Anthropic key to produce a result, and the credit is
  exhausted in prod today. PR #2437 (open) makes the **call** pipeline treat a
  provider outage as "retry later, keep the transcript, no strike". **No
  equivalent exists for dictate or Quick Capture**, and this design must
  degrade the same way (section 6).
- Voice Intel per-company daily audio cap by plan
  (`VOICE_COMPANY_BUDGET_SEC`, `lite` 3,600 s/day; `starter` 72,000 s/day).
  Confirm which tier Jo's company is on before promising "all-day capture".

## 2. Gaps, ranked by what hurts Jo

1. **Nothing is durable.** A dropped signal, an iOS suspend, or a Claude
   outage loses the conversation. This is the opposite of the product
   promise ("so I don't forget anything").
2. **The in-person path is unused** (0 captures, 0 recordings) and the best
   path (Voice Intel) is hidden behind a customer page and a consent
   checkbox every time.
3. **No record-first.** To use Voice Intel he must already know and open the
   customer; to use Quick Capture he gets no audio and a manual picker after.
4. **Attach is manual and unranked.** The call matcher already solves
   "which customer" and is not used for visits.
5. **Promises do not enter the never-forget system** from a visit.
6. **No fast launch** (no deep link, no Action Button / Siri path, no
   appointment-card "Record this visit").
7. **Half the leads lack coordinates**, so geotag alone cannot be the primary
   signal yet.
8. **Consent defaults are wrong for Ohio/Kentucky** (an attestation checkbox
   on every recording) and absent on the paths he would actually use.
9. **Accuracy knobs untouched:** no vocabulary prompt, no name edit, no
   speaker labels beyond LLM guesses.

## 3. Design

### 3.1 Speed to start (and what iOS PWAs cannot do)

Honest platform limits (iPhone, installed web app):

- **Manifest `shortcuts` do not appear** on an iOS home-screen icon (long
  press). They work on Android Chrome. Keep adding one for Android; do not
  count on it for Jo.
- **No lock-screen or background recording.** A web app cannot start the
  microphone from the lock screen or while another app is frontmost, and iOS
  stops web audio capture when the app is backgrounded or the screen locks.
  The recording must be started with the app in the foreground and the screen
  on. A Screen Wake Lock request (`navigator.wakeLock`) is the mitigation;
  support in installed iOS web apps has been inconsistent across versions, so
  it must be feature-detected and tested on Jo's phone, not assumed.
- **Siri Shortcuts / Action Button:** a Shortcut with "Open URL" pointed at
  `https://nobigdealwithjoedeal.com/pro/dashboard.html?capture=1` is the
  available hook. On iOS, URL opens from Shortcuts generally open in
  **Safari, not the installed standalone app**, which has its own storage and
  session. That makes it a poor primary path unless Jo tests it and it lands
  in the installed app. Treat as an experiment to run on his phone, not a
  promise. A real native app with a lock-screen widget or App Intent is the
  only way to get true one-tap-from-lock-screen; out of scope here.

What we can build that works in the installed app:

| Entry | Taps from app open | Customer |
|---|---|---|
| **Big "Record" button on Home/Today** (always visible) | 1 | none yet (record first) |
| **Appointment card "Record this visit"** on Today / Field App stop | 1 | pre-attached |
| **Customer page "Record visit"** (replaces the buried Voice Intel button; also folds in Quick Capture) | 1 | pre-attached |
| **FAB 🎙** (existing) re-pointed at the same recorder | 2 (via dial) | by suggestion |
| **Deep link `?capture=1[&lead=ID]`** (new; also what a Shortcut/QR/NFC tag would call) | 0 after open | optional |
| **Route / D2D stop** | 1 | the stop |

Cold start inside the app should be: tap, recording within about a second.
The microphone permission prompt is one-time; **request it at install/first
open of the recorder, not mid-conversation**.

**Record first, attach after** is the default. The recorder never asks "who is
this" before it starts. The only pre-recording step is, when the company mode
requires it, a **single-tap disclosure reminder** (section 6), not a form.

### 3.2 Linking: one ranked suggestion, always a confirm chip

On **start** capture `{lat, lng, accuracy, ts}` with one
`getCurrentPosition` (8 s timeout, `maximumAge: 15000`, the same options the
Field App uses). Never block recording on it. Store it on the recording, not
on the lead.

Candidate set: the user's tenant leads that are open (not decided; reuse
`stage-roles` `isDecided` like the call matcher). Score each, highest wins,
signals in this order:

1. **Pre-attached** (started from a customer page, appointment card, stop):
   score = certain; skip suggestion.
2. **Today's appointment** within a window (starting within -30/+90 minutes
   of now) AND, if both have coordinates, within about 300 m. The appointment
   alone (no coordinates) is a strong signal at "scheduled right now".
3. **Proximity**: haversine from the fix to the lead, with the fix's
   accuracy folded in (a 65 m accuracy cannot separate two houses 20 m apart).
   Radius 100 m "at the door", 250 m "on the street".
4. **Open job / recency**: leads with an active job or touched in the last
   14 days outrank cold leads at the same distance.
5. **Spoken name**, **after transcription**, using the call matcher
   (`suggestByFacts` / `suggestByContactOrSaid`) on the transcript. It can
   confirm the geo pick or override it when the geo pick contradicts.

Decision table (the "auto-attach" part, all subject to the threshold Jo sets,
section 9):

- **Auto-attach** only when exactly one candidate is strong on two
  independent signals (for example appointment now AND within 250 m, or
  within 100 m AND the name said matches) and nothing else is plausible.
- Otherwise **suggest**: top 3 candidates as chips with the reason ("Today
  2:30, 40 m away", "name said: Smith", "412 Oak Hill Dr, 60 m").
- **Always** show the confirm chip on the saved memo ("Attached to <name>
  Change"), and make Change one tap to the same ranked list. Never attach
  silently without showing it.
- **Never auto-attach** across a contradiction (a different surname or
  house number said), mirroring the call matcher's conflict rules.

**Attach later inbox:** every unattached memo lands in one list ("Unfiled
visits", the Talk Tank view repurposed) with its suggested chips already
computed, a Home badge with a count, and the standard never-forget treatment
(an unattached memo older than N hours becomes a "needs you" row). Nothing is
lost because the audio and transcript exist independently of any customer.

**Several customers in one memo** (a street of neighbors): the analysis step
splits by `callerFacts`-style mentions into segments with timestamps; the
inbox row offers "Split into 2". Phase 3. Until then one memo = one customer
and an unusual memo can be re-attached or duplicated to a second lead.

**Coordinates gap:** before geo is trusted, run a one-time server backfill
geocoding the 135 leads that have an address and no lat/lng, and add a
write-time geocode to the lead save path so new leads get coordinates.
Because Nominatim has a usage policy, do the backfill as a throttled
server job with caching, not from browsers. Until it lands, ranking falls
back to appointment + recency + spoken name.

### 3.3 Extraction: same outputs as call memos

Reuse, do not rebuild. A visit memo runs the **Voice Intel analysis**
(`analyzeTranscript`, with a `callType` of `inspection` or `close` etc.) and
the **call-center notes shape** for the fields the rest of the system already
reads:

- Summary, damage noted, objections, insurance details, red flags (Voice
  Intel as built).
- **Promises:** map `commitments` with `who: rep` to `promises {who: jo}` and
  `who: homeowner/adjuster` to `{who: them}`; write them as **promise tasks**
  (`kind: 'promise'`, `promiseKind` guessed or `callback`, `source: 'visit'`)
  using `functions/promise-logic.js`'s task builder, so they appear on Today,
  Waiting, and the server promise channel exactly like a call promise.
  Add `'visit'` to `SOURCES` (the server and client twins are tested
  byte-identical, so both change together). Check the open
  "needs-you promise channel" work on main before building so the source name
  is accepted end to end.
- **Follow-up date** and `urgent` as in call notes.
- **Measurements / scope facts** ("two layers, about 28 squares, 6/12
  pitch"): add a `scopeFacts` array to the analysis schema, clearly labelled
  as what was **said**, not measured; surface on the customer timeline and
  never write into estimate fields automatically.
- `voiceConsumer`'s insurance backfill only fills empty fields; keep that.
- Activity row on the customer timeline so it sits beside the calls.

### 3.4 Reliability: local-first, resumable, never lose a word

1. **Persist before anything else.** On every `dataavailable` (1 s), append
   the chunk to **IndexedDB** (a new store, patterned on
   `photo-queue-store.js`: its own DB name, per-recording rows, a cap, and a
   quota-exceeded path that tells the rep loudly rather than silently
   dropping). The in-memory array becomes a cache, not the source of truth.
2. **Recording state is a small record** (`id`, start ts, GPS fix, mime,
   chunk count, `leadId?`, `status`), so after an iOS reload the app can find
   a recording that never got a `stop` and offer to **recover** it (assemble
   the saved chunks into a blob, upload as-is).
3. **Upload queue:** when stopped, status `saved on phone`, then a drain loop
   uploads with `uploadBytesResumable` to `audio/{uid}/_inbox/{id}.{ext}`
   (leading `_` is reserved, so the existing lead-bound trigger ignores it by
   design; a new trigger handles it). Retry with exponential backoff
   (30 s, 2 m, 10 m, then on app open and on `online`). Delete the local
   copy only after the server confirms the doc exists.
4. **Visible state on the memo row:** `Recording`, `Saved on phone`,
   `Uploading 63%`, `Transcribing`, `Ready`, `Needs you` (attach), `Failed:
   tap to retry`. A rep on a roof sees "saved on phone" immediately, which is
   the trust-building moment.
5. **Foreground discipline:** request a wake lock while recording; show a
   persistent "keep the screen on" banner with the timer; listen for
   `visibilitychange` and if the page is hidden mid-recording, stop cleanly
   and **commit what exists** (a short, complete memo beats a corrupted long
   one), then raise a local notification-style banner on return ("Recording
   paused when the app closed, 14:02 saved"). Never leave the recorder
   running into a silent dead state.
6. **Max duration:** soft cap 60 minutes with a warning at 50; chunked
   sessions (`part 1`, `part 2`) if Jo keeps going, rather than one giant
   blob.
7. **One recorder module.** Collapse the five MediaRecorder copies behind one
   `NBDVisitRecorder` used by Quick Capture, Voice Intel and the customer
   page, so reliability fixes land once.

### 3.5 Accuracy

- Send a Groq **`prompt`** (vocabulary hint, up to roughly 224 tokens) built
  per memo: the pre-attached or top-suggested customer's name, street and
  town, plus a fixed roofing list (GAF, TAMKO, IKO, Timberline HDZ, Duration,
  ridge vent, drip edge, ice and water shield, ACV, RCV, supplement,
  deductible, adjuster, Cincinnati and NKY town names). Cheap, no model
  change, and improves exactly the failure Jo hits (names, streets).
- **Name post-edit UI:** on the memo, the detected names/addresses are chips
  Jo can tap to correct once; a corrected name is stored as an alias on the
  lead for the matcher next time.
- **Speaker labels, in increasing cost:**
  1. LLM role inference (exists in Voice Intel as `speakers`). Free.
  2. Segment-level "Jo vs them" heuristics: enrol Jo with a 10 s sample and
     compare, or use turn-taking plus the opening "Hi, I'm Jo" pattern.
     Cheap and approximate.
  3. A transcription vendor with true diarization (several exist; Deepgram
     was removed here on 2026-10-04 because its key was never set). Adds a
     second vendor, a new secret, and per-hour cost higher than Groq's
     $0.04/hr. Evaluate on three real memos before committing. Phase 3.
- **Confidence flags:** surface low-confidence stretches (Whisper
  `avg_logprob` / `no_speech_prob` per segment, which Groq returns in
  `verbose_json`) as "check this part" highlights, not as errors.
- Keep the full transcript and audio as the source of truth; the summary is a
  convenience and is labelled as AI-written.

### 3.6 Privacy and consent

- **Disclosure prompt (policy choice, question 3):** a one-tap "I told them
  I'm recording" reminder before the first second, remembered per customer
  for the visit, with the timestamp stored on the recording. Soft by default
  for one-party states, with a stricter attested mode available per company
  (the existing three modes).
- **Fix the default:** when `recordingConsentMode` is unset and the company
  is an Ohio/Kentucky contractor, behave as the decision in question 3, and
  add the missing Settings control for the field.
- **Per-customer "do not record" flag** on the lead: the recorder refuses to
  start (or deletes after) when pre-attached to a flagged customer; the
  suggestion chip shows the flag. Also a "Pause" button so Jo can stop for a
  private aside without ending the memo.
- **Retention:** keep the 90-day default for audio, longer for transcripts
  and summaries (they are the useful part); Jo picks (question 5). Hard
  delete by memo is one tap.
- **Who can read:** audio and transcripts stay owner/admin by default
  (storage.rules unchanged); the **summary and promises** go to the lead
  timeline where the company already sees calls. Office/crew access to raw
  audio is a separate, explicit decision.
- **Never public:** nothing here touches `docs/`, no tokenized URLs on any
  public page, no new public collection.

### 3.7 Cost and degraded mode (Anthropic credit exhausted)

Order of operations, each step durable before the next:

1. Audio saved locally (IndexedDB), then uploaded to Storage.
2. **Transcribe with Groq and write the transcript to Firestore
   immediately** (Voice Intel already does this).
3. Analysis (Claude) is a separate, retryable step. On a provider outage
   (credit, auth, rate limit, 5xx) the memo shows **"Transcript saved, notes
   pending"** with the transcript readable and searchable, and a scheduled
   retry (same classifier PR #2437 introduces for calls: outage means no
   strike, retry automatically, one deduped alert, not a failure).
4. If Groq is also down, the memo stays `Saved, waiting to transcribe`; audio
   is not lost.

This is strictly better than today's `dictate`, which throws away both audio
and transcript when Claude fails. Do not extend `dictate` for visits; give
the visit path the Voice Intel two-stage shape.

## 4. Options and recommendation

| | A. Polish Quick Capture | B. Build on Voice Intel (recommended) | C. New native-ish app / vendor |
|---|---|---|---|
| Audio kept, long memos | needs storage path added | already there (200 MB) | yes |
| Durable analysis, transcript-first | needs rewrite of `dictate` flow | already there | yes |
| Speaker roles, commitments, tasks | would reimplement | already there | vendor-specific |
| Consent model | none | exists (needs default/setting) | build |
| Lock-screen one-tap | no | no | **yes** (the only way) |
| Cost to build | low | **low-medium** | high; second vendor |
| Risk | rebuilds what exists badly | needs an unattached-inbox path | scope, store review, ops |

**Recommend B:** make Voice Intel's pipeline the engine, give it an
"unattached" front door and the ranked attach step, retire Quick Capture's
summarize-and-lose flow into it, and leave a native wrapper as a later
decision once Jo has used the web path for a few weeks.

Server shape for B (sketch, to be validated in the build PR):

- New Storage path `audio/{uid}/_inbox/{recId}.{ext}` (already allowed by
  storage.rules; ignored by `parseAudioPath` because of the leading `_`).
- New trigger `onInboxAudioUploaded` -> writes `users/{uid}/captures/{recId}`
  (the **existing** user-writable collection that Talk Tank already lists, no
  new rules) with transcript, summary, `geo`, `suggestions[]`, `status`.
- New callable `attachVisitCapture({ recId, leadId })`: tenancy check
  (`uploaderMayRecordOn`), writes `leads/{leadId}/recordings/{recId}` so
  **`voiceConsumer` and the existing customer-page list work unchanged**,
  promise tasks via `promise-logic`, sets `captures.linkedLeadId`, moves
  nothing destructive (audio path stays; retention cron's strict pairing
  check means it only reaps the lead-bound copy, so the attach step writes
  `audioPath` to the final `audio/{uid}/{leadId}/...` path by server copy).
- Suggestions computed server-side with the call matcher plus geo, using
  `functions/call-center-logic.js` functions as-is.

## 5. Phased build plan

### Phase 1: quick wins (2 PRs, no geocoding needed)

**PR 1 - durable recorder + record-first + pre-attach**
- `NBDVisitRecorder`: IndexedDB chunk persistence, recover-on-reopen, wake
  lock, visibilitychange commit, saved-on-phone state, one mic permission
  request up front.
- Entry points: Home/Today "Record" button, appointment/stop "Record this
  visit" (pre-attached), customer page "Record visit" (pre-attached),
  `?capture=1[&lead=ID]` deep link, FAB repointed. Add the manifest shortcut
  (Android).
- Upload to `audio/{uid}/_inbox/` with backoff retry; local copy dropped only
  after the server doc exists.
- Do not ask for a customer before recording; ask only the disclosure tap if
  the company mode requires it.

**PR 2 - server pipeline + attach-later inbox + never-forget hookup**
- `onInboxAudioUploaded` (transcript first, analysis second, outage-tolerant
  retry), `attachVisitCapture`, promise-task writes with `source: 'visit'`,
  Talk Tank becomes the "Unfiled visits" inbox with Attach / Change / Re-link,
  Home badge and a needs-you row when a memo sits unattached.
- Suggestions v1 without coordinates: today's appointment window, spoken
  name via the call matcher, recency/open-job. Confirm chip always shown.
- Consent: honor `recordingConsentMode`, add the Settings control, apply the
  Jo-chosen Ohio/Kentucky default; per-customer do-not-record flag.

### Phase 2: geotag suggestions
- Throttled server geocode backfill of the 135 address-only leads and a
  write-time geocode on lead save (counts re-read before and after).
- Capture a fix at record start; proximity + accuracy-aware scoring; "at the
  door / on the street" chips; foreground-only (no background geofencing is
  possible in a web app, state this in the UI copy).
- Auto-attach threshold per Jo's answer, with an undo toast.

### Phase 3: accuracy
- Groq vocabulary `prompt`, name alias learning, low-confidence highlights.
- Multi-customer split in one memo.
- Diarization vendor evaluation on three real memos (go/no-go, cost, second
  secret).
- Optional native wrapper decision.

## 6. Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| iOS suspends or reloads the app mid-memo | Loses the memo, the worst outcome | IndexedDB chunks, recovery on reopen, commit-on-hide, device test on Jo's phone before shipping |
| Wake lock unreliable in installed iOS web apps | Screen locks, recording ends | Feature-detect, visible banner, short-memo-first habit, test matrix |
| Geo suggests the wrong house (65 m accuracy, townhouses) | Wrong customer gets the notes | Two-signal rule for auto-attach, always the confirm chip, undo, contradiction veto |
| Half the leads have no coordinates | Geo looks broken | Phase 2 backfill first; Phase 1 does not depend on it |
| Auto-attach of a sensitive memo to the wrong customer | Privacy and trust | Default to suggest-only until Jo sets the threshold; audit log of attach/re-link |
| Consent expectations differ by customer (spouse, adjuster) | Legal/trust | Disclosure reminder, do-not-record flag, pause button, counsel review of the policy |
| Anthropic outage | No notes | Transcript-first, retry, "notes pending" state |
| Quota (Groq free tier 8 h/day, 2,000 req/day; Voice Intel plan cap) | A heavy day silently fails | Budget meter in the memo status; fall back to "queued, will run tomorrow" |
| Five recorders collapsed into one | Regression in dictate/voicemail | Migrate Quick Capture and Voice Intel first; leave dictate-into-input and D2D alone until proven |
| Strict CSP / no inline | Project invariant | External `defer` module under `docs/pro/js/`, delegated handlers, no `on*` |
| Promise `source` list is mirrored client and server | Byte-identical test would fail | Change both twins and the test together |
| Raw audio is highly sensitive | Leak impact | Keep `audio/{uid}/**` owner/admin, no signed URLs on any public page |

## 7. Legal and policy notes (not legal advice)

- **Ohio** (R.C. 2933.52) and **Kentucky** (KRS 526.010 / 526.020) are
  one-party-consent states: a participant in the conversation may record it.
  An in-person visit where Jo is a party is generally permitted in both.
  Customers or adjusters from other states are possible, and some states
  (for example Illinois, Michigan, Florida, Pennsylvania) require all-party
  consent. **Disclosing the recording up front is the safe default
  everywhere** and is also good customer practice. Confirm with counsel; the
  OH/KY contractor-law research memo (PR #2428, open) is the place to attach
  this question.
- What the product does today: the Quick Capture, voice-memo, dictate and D2D
  paths record with **no disclosure and no consent record**. Only Voice Intel
  has a consent model, and in prod it is unset (defaults to the strictest
  attestation).
- The customer-facing site and contract language should not promise "we do
  not record" or "we always record"; align wording with whichever policy
  Jo picks. A conversation recorded for the customer's own project notes is
  still personal data; delete on request is one tap in this design.

## 8. Test plan

- **Pure logic, unit tests:** suggestion ranking (appointment window,
  distance + accuracy, conflicts, ambiguity returns "no pick"), auto-attach
  rule, promise mapping to the `promise-logic` task shape (client/server
  twins byte-identical), chunk reassembly, backoff schedule. Include
  negative controls (a ranking test that can fail) and positive controls
  (presence of the expected suggestion), per the standing absence-assertion
  rule.
- **Emulator:** Storage `_inbox` upload -> trigger -> `captures` doc; attach
  callable tenancy (cross-tenant attach refused); outage path leaves a
  transcript and retries; kill switch honored; retention untouched.
  Remember the emulator never enforces indexes and a test lead alert can send
  real SMS/email: intercept, do not POST with alerts on.
- **Phone, on Jo's installed iPhone app, the gating test:**
  record 2 min then lock the screen; record then background the app;
  record in airplane mode, then reconnect; kill the app mid-recording and
  reopen (recovery); start from an appointment card, from the Home button,
  from a deep link; 20-minute memo size and upload time on cellular.
  Include the Shortcut "Open URL" experiment and note which browser context
  it opens.
- **Accuracy:** replay three real memos with and without the vocabulary
  prompt; compare name/street error counts side by side.
- **Gate commands** for the build PRs: `node scripts/check-js-syntax.js`,
  `node scripts/check-inline-html-scripts.js`, `node tests/smoke.test.js`,
  the function-map `--check`, and the manifest runner before pushing a suite.

## 9. Questions for Jo

1. **Auto-attach threshold:** suggest-only forever, or auto-attach (with a
   visible Undo) when the top match is on two signals (appointment now AND
   within 250 m, or within 100 m AND your spoken name)? Where is the line
   you are comfortable with?
2. **Record-first default:** OK that the recorder starts instantly with no
   customer chosen, and unfiled memos wait in an inbox that nags you (Home
   badge, "needs you" after how long, 2 h / end of day / next morning)?
3. **Disclosure policy:** do you tell customers you are recording? Pick one:
   (a) a one-tap "I told them" reminder every visit, (b) a one-time standing
   line in the estimate paperwork plus a quiet reminder, (c) nothing. Same
   for adjusters and spouses on site. Also: should we ask counsel about
   customers from other states?
4. **Per-customer do-not-record:** want a flag on the lead (and a Pause
   button during a visit) for people who object?
5. **Retention:** keep raw audio how long (30 / 90 / 365 days), and keep
   transcripts and summaries longer or forever?
6. **Who can see visit memos:** only you, or the office/crew on that job (the
   summary and promises, not raw audio)?
7. **iPhone launch:** are you willing to try the Siri Shortcut / Action Button
   "Open URL" experiment and tell me which app it opens in? And do you want
   the big always-visible Record button on Home even if it takes the place
   of something else?
8. **Memo length:** typical visit length, and is a 60-minute soft cap right?
9. **Promises from a visit:** should "I'll text the number Friday" from a
   visit become the same forced-next-action promise chip as a call, or just a
   task on the customer?
10. **Multiple people on a street:** how often does one memo cover more than
    one customer (door-knocking a block)? That decides if the split step is
    Phase 2 or can wait.
11. **Spend:** OK to add a diarization vendor (second key, higher per-hour
    cost) if three real memos show the LLM speaker guess is not good
    enough, or stay on Groq only?
12. **Geocoding:** OK to run a one-time server geocode backfill for the 135
    address-only leads (read/write on `leads`, lat/lng only), after you see
    the dry-run counts?
