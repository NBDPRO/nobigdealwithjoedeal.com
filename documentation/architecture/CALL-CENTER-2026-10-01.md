# Call Center: Cube ACR recordings into the CRM (2026-10-01)

**What Jo asked for:**
- the phone's call recordings go into the CRM automatically, on a timer;
- they get transcribed and AI-sorted;
- a sweep once or twice a day flags anything forgotten.

Jo's answers:
- the recorder is **Cube ACR**, saving to Drive at *Documents › Cube ACR*;
- **every** call goes in: "half or more customers are contacts in my phone
  plus random numbers that gets hard to filter";
- **calls first, then texts.**

This note covers stage 1, the ingest.
- Stage 2: transcription and AI notes.
- Stage 3: the daily "you said you'd…" sweep.
- Stage 4: texts.

## The source

Cube ACR writes one folder per day: `Cube ACR/<YYYY-MM-DD>/<file>.m4a`. The
call's facts live in the file name. There are three shapes; the names below
are invented:

```
2026-09-30 17-06-55 (phone) Pat Example NBD Customer (+1 812-555-0113) ↗.m4a   saved contact, Jo's tag
2026-09-30 15-47-26 (phone) Example Property Claims (1 877-555-9386) ↗.m4a     toll-free, no "+"
2026-09-30 17-12-33 (phone) +1 800-555-1370 ↙.m4a                             not a saved contact
```

- `↗` means outgoing and `↙` means incoming.
- The time is the phone's local time (America/New_York).
- Jo's contact tags (`NBD Customer`, `NBD Referral`, `NBD Sub`, `NBD Vendor`)
  become `tags` and are stripped from the display name.

## Sort, never filter

Every recording is filed. Each one lands in a `bucket`:

| bucket | when |
|---|---|
| `customer` | the number is on a lead (phoneDigits / phone / alt phone fields) |
| `insurance` | the contact label names a carrier or a claims/adjuster line |
| `contact` | a saved phone contact the CRM doesn't know yet |
| `unknown` | a bare number |

If several leads share a number, the most recently touched one wins. The
others are kept as `alternateLeadIds`, and the card shows a "Number on N
customers" chip.

## Moving parts

- **`functions/call-center-logic.js`**: pure logic covering the file-name
  parser, phone index, matcher, buckets, doc ids, the folder window and the
  doc shape. Tested by `tests/call-center-logic-2026-10-01.test.js`.
- **`functions/call-center.js`**: `callCenterIngest`, running every 30 minutes.
  - **Access:** the functions' service account reads the folder with
    `drive.readonly`. It finds the one folder named "Cube ACR" that it can
    see, so **no folder id is committed to this public repo**. The id is
    pinned on `integrations/callCenter.folderId` after the first run.
  - **Scope:** the first run reaches back **90 days** (`backfillFrom`
    overrides this). Each run handles at most **40 files**.
  - **Cursor:** stored as `cursorYmd`. It only moves past a day whose files all
    filed, and today's folder is always re-listed.
  - **Re-runs:** a re-run is a no-op, because the doc id is `cube_<driveId>`
    and existence is read once per day folder with `getAll`.
  - **Writes:** `phone_calls/cube_<driveId>` holds userId/companyId = owner,
    direction, phoneDigits, contactName, tags, bucket, leadId and storagePath.
    The status is `stored`; the transcript and summary are null until
    stage 2.
  - **Audio:** stored at `calls/{owner}/cube-acr/<ymd>/cube_<driveId>.m4a`,
    under the existing `calls/{uid}` storage rule (owner reads, nobody
    writes from a client).
  - **Dry run:** unless `CALL_CENTER_INGEST_ENABLED=true` (registered in
    `cron-gates.js`), it lists and counts only. The counts go to
    `integrations/callCenter.lastRun`: no names, no numbers, no audio, no
    call docs.
  - **Pause:** setting `integrations/callCenter.paused: true` stops it.
  - Tested by `tests/call-center-ingest-2026-10-01.test.js` (stubbed Drive,
    in-memory store; break-tested on the dedupe).
- **`firestore.rules` `phone_calls`**: reads mirror `thursday_calls` (the
  owner, an admin, or a same-company reader; sales_rep is denied). There are
  no client writes. Nine checks live in `firestore-rules.cross-tenant.test.js`.
  The `userId`/`companyId` + `startedAtMs` indexes are in
  `firestore.indexes.json`.
- **Erasure and export:** `phone_calls` is registered in
  `integrations/user-owned.js`. `calls/` was already a Storage prefix.
- **Customer card:** `docs/pro/js/customer-calls.js` (v3) lists the lead's
  `phone_calls` alongside Thursday's calls, newest first. Each card shows
  direction, contact and a "Play recording" button. Playback streams through
  Storage `getBlob` into a `blob:` `<audio>` element, never a download URL.
  The play button is a 44px target. Covered by
  `tests/e2e/call-center-card.spec.js` (@shard2); dropping the `phone_calls`
  read turns it red.

## Turning it on (Jo-side)

1. In Drive, share **Documents › Cube ACR** with
   `717435841570-compute@developer.gserviceaccount.com` as a **Viewer**.
2. ~~Enable the **Google Drive API** on project nobigdeal-pro.~~ **Done
   2026-10-01** on Jo's say-so (`gcloud services enable drive.googleapis.com`).
   Step 1 is done too: the service account is a Viewer on the folder.
3. Deploy, then read `integrations/callCenter.lastRun`. A dry run reports the
   folder count and the per-bucket counts.
4. Set `CALL_CENTER_INGEST_ENABLED=true` on the `callCenterIngest` revision.
5. **Transcripts:** with Jo's OK, put one call id on
   `integrations/callCenter.transcribeOnly` and read the result. Then set
   `CALL_CENTER_TRANSCRIBE_ENABLED=true` on `callCenterTranscribe`.

## Stage 2: transcripts and AI notes (built 2026-10-01)

`callCenterTranscribe` runs every 30 minutes.

**Transcription**
- It uses **Groq Whisper-large-v3-turbo**, through the same helper and key
  that Voice Intelligence uses (`transcribeGroqBuffer`).
- This replaced the Speech-to-Text plan: Groq needs no new Google API and its
  free tier covers this volume (25 MB a file, 8 h of audio a day).
- **Limits:** we cap at 7.5 h a day (raised from 6 h on 2026-10-01, Jo), at most 12 calls a run, newest first, and
  3 tries per call. Anything over 25 MB is marked `too_large`.

**Notes**
- **Claude Haiku** (`NOTES_SYSTEM` in `call-center-logic.js`) returns the
  call type, a summary, who promised what (with ISO dates), a follow-up date
  and an urgent flag.
- `sanitizeNotes` drops anything malformed rather than trusting it.

**Where results go**
- The `phone_calls` doc gets `status: 'noted'` plus the transcript and notes.
- The customer timeline gets `leads/{id}/activity/cube-{id}`.
- The lead gets **one** task, `leads/{id}/tasks/cube-{id}`, only when Jo
  promised something or a follow-up date came out of the call. It is
  created with `create()` only, so a re-run never un-ticks a done task.

**Personal calls:** if the model calls one "personal", no transcript is
kept, the summary is just "Personal call.", and nothing is filed on any lead.
Jo records every call, family ones included.

**Gating**
- With `CALL_CENTER_TRANSCRIBE_ENABLED=true`, the backlog runs.
- With the gate off, only the ids listed in
  `integrations/callCenter.transcribeOnly` run. That list is Jo's one-call
  test, and it clears itself after the run.
- The AI kill switch also stops it.

**Customer card:** the card shows the summary, a "You / They" list of
promises, the follow-up date and an Urgent chip.

**Tests:** `tests/call-center-notes-2026-10-01.test.js` has 31 checks; the
personal-call privacy rule was break-tested. The card E2E also asserts that
the notes render.

## Stage 3: the Call Center screen, the reminder sweep, sidecars (built 2026-10-01)

**First production dry run (counts only), 2026-10-01 13:52 UTC**
- 77 day folders hold **477 recordings** from the last 90 days.
- By bucket:
  - 51 customer
  - 3 insurance
  - 328 contact (saved in the phone, not in the CRM)
  - 95 unknown
- The run also "skipped" 477 files. They turned out to be Cube's per-call
  sidecars (below), which are now read rather than counted as skips.

**Sidecars.** Each recording has a `<same name>.json` alongside it:
`{"duration":"<ms>","loc":"<lat;lng>","callee":"+1…","addr":"<street address>","direction":"…"}`.
- `parseSidecar` keeps **only the duration**.
- `loc` and `addr` are where Jo's phone was during the call. They are
  never stored, and the ingest test proves it.
- Calls under 15 s (missed calls, hang-ups) are stored as `status: 'short'`
  and never transcribed.

**Call Center view (`#/calls`)**
- Code: `docs/pro/js/call-center-view.js`, lazy bundle `callcenter`,
  sidebar plus the phone More drawer.
- **Filters:** Needs attention, All, Customers, Insurance, Contacts, Unknown.
  - **Original rule:** "Needs attention" meant not handled, not personal, and
    at least one of: Jo promised something, a follow-up is due, it is
    urgent, or there is no customer on file.
  - **Superseded 2026-10-02:** that rule flagged 439 of 488 calls, because
    every saved-contact call in the backlog counted. The rule is now
    `callNeedsYou` in `docs/pro/js/home-attention.js`, shared with the new
    📞 item on the Home "needs you" strip.
  - **The new rule:** the call is from the last 14 days, not handled and not
    personal, and is urgent, carries a promise Jo made, has a follow-up date
    that has come, or is an insurance line or unknown number with no
    customer on file.
  - An unknown number counts even as a missed (short) inbound call. A saved
    contact only counts through a promise.
  - On production it flags **49**: 16 promises, 31 unknown numbers, and 2
    insurance lines.
  - Tests are in `tests/home-attention-yard-chip-2026-09-29.test.js`.
- **Search:** name, number digits, summary, transcript.
- **Per call:** Play (getBlob into a `blob:` URL), Open customer,
  ✓ Handled / Not handled, Attach to customer… (a datalist of leads), and
  + New lead (`_saveLead`, then attach).
- The nav badge shows the "needs attention" count.
- Tested by `tests/e2e/call-center-view.spec.js` (@shard2, 390px).

**`callCenterAction` (onCall, App Check)** is the screen's only write path,
because `phone_calls` is server-written.
- **Who may use it:** the call's owner, an admin, or a same-company
  company_admin or manager. Viewers and sales reps are refused.
- **`attach`:**
  - checks the lead is in the same tenant;
  - files the call on it;
  - puts the caller's number on the lead, filling blanks only
    (`phonePatchForLead`), so the next call from that number matches by
    itself;
  - for a noted call, writes the timeline entry and a create-only follow-up
    task.
- Tested by `tests/call-center-action-2026-10-01.test.js` (23 checks).

**`callCenterSweep`** runs at 07:15 and 15:15 ET and sends one INTERNAL
email to Jo, listing:
- open cube tasks due today or earlier;
- urgent calls from the last 36 h;
- calls with no customer on file where Jo promised something or a
  follow-up date has come.

Handled calls are skipped, and nothing open means no email. It stays DRY-RUN
unless `CALL_CENTER_SWEEP_ENABLED=true`. It is registered in
`email-suppression.js` SEND_PATHS as internal. Tested by
`tests/call-center-sweep-2026-10-01.test.js` (15 checks, including
escaping).

## Stage 4: texts (built 2026-10-01)

**Source.** Jo's phone is Android (Cube ACR is Android-only), so texts come
from **SMS Backup & Restore** (free).
- Its scheduled backup writes `sms-<YYYYMMDDHHMMSS>.xml` to the Drive folder
  `SMSBackupRestore`. Each file holds every text, received and sent,
  including MMS.
- This captures Jo's replies too, which an SMS forwarder can't. It also needs
  no new number and no public endpoint.

**`textInboxIngest`** (`functions/text-inbox.js`) runs every 30 minutes.
- **Which file:** only the newest `sms-*.xml`. `calls-*.xml` call-log
  backups are ignored. The same file with the same `modifiedTime` is a
  no-op.
- **How far back:** texts newer than the cursor minus 3 days, or the last 90
  days on the first run.
- **No duplicates:** doc ids are content hashes, so the overlap between full
  backups never duplicates a text.
- **Where results go:** `phone_texts` docs, matched to the lead by phone and
  bucketed like calls.
- **Short codes** (5–6 digit senders: 2FA codes, bank and delivery alerts)
  are **never stored**. This was break-tested.
- **Status doc:** counts only, on `integrations/textInbox`. Setting
  `paused: true` stops it.
- **Gate:** DRY-RUN unless `TEXT_INBOX_ENABLED=true`.

**Parser.** `functions/text-inbox-logic.js` is a dependency-free regex scan
over `<sms …/>` and `<mms>…<parts>`.
- It decodes entities, including emoji character references.
- MMS dates are in seconds; it converts them.
- Group MMS is flagged.
- Photos become "[n photos]"; the images themselves aren't copied yet.

**Rules.** `phone_texts` has the same readers as `phone_calls`, and no
client writes (9 cross-tenant checks). Indexes: `userId|companyId +
sentAtMs`, and `leadId + userId + sentAtMs`. Registered for erasure and
export.

**Customer page.** The Calls section shows "💬 Texts from your phone": a
chat thread, oldest to newest, with the newest 80 in view. Covered by the
card E2E, which checks that a text containing `<b>` renders as text and
never as HTML.

**Turning it on (Jo-side)**
1. Install **SMS Backup & Restore** and back up Messages to **Google Drive**
   on a schedule (hourly, or as often as it allows).
2. Share the Drive folder **SMSBackupRestore** with
   `717435841570-compute@developer.gserviceaccount.com` as a Viewer.
3. The dry run reports counts; then set `TEXT_INBOX_ENABLED=true`.

## Jo's go-aheads (2026-10-01)

- **Copying:** "Yes, all 90 days" turned the ingest on
  (`CALL_CENTER_INGEST_ENABLED=true` in `functions/.env.nobigdeal-pro`).
- **Transcripts:** "Yes, test one call" means one recent customer call goes
  on `integrations/callCenter.transcribeOnly` first. The backlog gate stays
  off until Jo has seen that call's notes.
- **Personal calls:** "Delete the CRM copy" means that once the model marks a
  call personal, `runTranscribe` deletes the Storage object and sets
  `storagePath: null, audioRemoved: 'personal'`. The original stays in Jo's
  Drive, so a misjudged call can still be recovered there.
- **The one-call test (the same afternoon).** It ran on a 63 s customer
  call from Jul 9. The summary was right. Of the promises, two were Jo's
  (arrive Mon 10–12, install and haul trash) and one was the customer's
  (review the emailed document). It also created **one stale task**, dated
  Jul 14, which led to the 14-day rule below.
- **14-day task window** (`TASK_WINDOW_MS`):
  - Only calls from the last 14 days create follow-up tasks, whether the
    task comes from transcription or from attaching a call.
  - In the sweep, the "no customer on file" item only counts recent calls.
  - Backlog calls still get their notes and timeline entry.
  - Break-tested.
- **"Yes, turn it on"** set `CALL_CENTER_TRANSCRIBE_ENABLED=true`.
- **"Yes, both times"** set `CALL_CENTER_SWEEP_ENABLED=true`.

## "It wasn't personal" (2026-10-01)

Personal calls lose their CRM audio and their notes, so a misjudged business
call needs a way back. The Call Center screen shows **It wasn't personal** on
any call marked personal. It calls `callCenterAction` with `notpersonal`,
which:
- re-copies the recording from Jo's Drive using the call's `driveFileId`
  (the original never left), into the same private `calls/` path;
- sets `status: 'stored'` and `notPersonal: true`, and resets the attempts,
  so the call goes back into the transcription queue.

On the next pass, `runTranscribe` overrides any "personal" verdict on a
`notPersonal` call and files it as business. That override was
break-tested. Only a call already marked personal can be redone, and
viewers are refused.

Tests: the action suite has the precondition, viewer, re-copy and requeue
checks. The notes suite checks the override. The view E2E checks that the
button sends the action.

## Text notes: texted promises join the sweep (built 2026-10-01)

**`textInboxNotes`** (`functions/text-inbox.js`) runs every hour.
- It groups the last 3 days of `phone_texts` into **conversation-days**
  (one number, one Eastern day). Group texts are skipped, because it is
  unclear who promised what.
- A day is noted once it has been **quiet for 2 h**.
- It is re-noted only when its signature (the set of messages) changes. At
  most 30 days are noted per run.

**The notes**
- Claude Haiku reads the day as `Jo:` / `Them:` lines.
- `TEXT_NOTES_SYSTEM` and `buildTextNotesPrompt` are in
  `text-inbox-logic.js`.
- The output goes through the calls' `sanitizeNotes`.

**Where results go**
- `phone_text_days/txt_<digits>_<ymd>` (`channel: 'text'`). Its readers
  mirror `phone_texts`, and clients cannot write.
- A customer timeline entry at `leads/{id}/activity/sms-{dayId}`.
- For days within 14 days, one create-only task at
  `leads/{id}/tasks/sms-{dayId}` when Jo promised something.
- Personal days keep "Personal texts." and file nothing.

**`callCenterSweep`** now reads noted text days alongside calls. It looks
up their `sms-` tasks, and the email marks those items "texts".

It runs DRY-RUN (counts only) unless `TEXT_NOTES_ENABLED=true`, and the AI
kill switch also stops it. Turn it on after texts are flowing
(`TEXT_INBOX_ENABLED`) and Jo says go.

Tests: `tests/text-notes-2026-10-01.test.js` has 14 checks, break-tested on
the signature skip. There are 6 rules checks.

## Texts in the Call Center (2026-10-02)

Days of texts (`phone_text_days`, noted by `textInboxNotes`) now show in the
Call Center beside the calls, and have a **Texts** tab of their own.
- **Each card shows** who it was with, the message count, the AI summary,
  the You/They promises, the follow-up date, Open customer, and
  ✓ Handled / Not handled.
- **Handled:** `callCenterAction` accepts `txt_<digits>_<ymd>` ids (same
  audience), but only for handled / unhandled. `attach` is refused, because
  the text ingest already matches texts to customers.
- **"Needs attention" and Home:** both use `callNeedsYou` for text days
  too. The Home strip adds the owner's newest 100 text days, so a texted
  promise counts as a promise.
- **Indexes:** `phone_text_days` by `userId` / `companyId` + `startedAtMs`.
- **Tests:** action +4, home-attention +1, and a view E2E that seeds a text
  day, checks the card and tab, and presses Handled.
- **The E2E snoozes the push prompt.** The "Turn on appointment reminders"
  prompt slid over the Handled button. The fix is the
  `nbd_push_optin_snoozed_until` snooze the other specs already use.


## Next stages

- **MMS photos.** Today they only count as "[n photos]". Copying them would
  mean EXIF-stripping them first (they could land on a lead's photos).

## Update 2026-10-02: Groq rate limits no longer drop calls

A read-only error sweep found 39 `call_center_transcribe_failed` warnings
between 08:09 and 11:11 UTC. All of them were Groq's free tier saying "Rate
limit reached for model `whisper-large-v3-turbo` … seconds of audio per
hour". Groq caps audio per **hour** as well as per day.

**The bug:** each rejection counted as one of a call's 3 strikes, and
`pickToTranscribe` skips a call at 3. A busy hour therefore dropped calls
**for good**. Production at the time, read-only:
- 172 calls stored;
- **6 stuck at 3 strikes, every one with a rate-limit error (117 minutes of
  audio)**;
- 9 more partway there;
- 157 never tried.

**The fix:**
- `L.isRateLimited(err)` matches status 429 or the stored message.
- On a rate limit, `runTranscribe` records the error and `rateLimitedAtMs`
  but adds **no strike**, then **stops the run**, because every later call
  would be refused too. The half-hourly schedule picks up from there.
- `pickToTranscribe` treats a call whose last error was a rate limit as
  eligible even at 3 strikes. The 6 dropped calls recover on their own, with
  no production edits.
- Real failures still count a strike, and 3 real failures still skip the
  call.

Tests: `call-center-notes` §8. Break-tested: with the rate-limit branch
disabled, all three run-level checks go red.
