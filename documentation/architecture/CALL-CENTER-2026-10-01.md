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

## Next stages

- **Transcription.** Google Speech-to-Text v2 (chirp) batch on the `gs://`
  object. It needs the Speech API enabled. Test it on one call with Jo's OK
  before the backlog runs. Cost is roughly 1–2¢ a minute.
- **AI notes.** Claude, using the existing key, writes a summary, action
  items, promised follow-ups and a next date, and adds a timeline note on the
  lead.
- **Call Center screen.** One list of every call, with bucket filters,
  search, and "make a lead" from an `unknown` or `contact` call.
- **Sweep.** Open action items join the morning brief, plus an afternoon
  pass.
- **Texts.** An Android SMS forwarder posts to a secret-keyed endpoint. The
  same sort-don't-filter buckets apply.
