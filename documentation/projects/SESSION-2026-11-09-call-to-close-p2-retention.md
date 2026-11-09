# Session 2026-11-09: Call to Close P2, lane "retention" (Q7)

Branch `ctc-p2-retention`, from `d1f7bfe0c`. Builds Jo's Q7 answer in [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md) §11: briefs and transcripts are kept 24 months, the CRM's audio copies 12 months, and the Drive originals are never touched. Earlier lanes: [P0](SESSION-2026-11-09-call-to-close-p0.md), [P1](SESSION-2026-11-09-call-to-close-p1.md).

## What shipped

| Piece | Files | What it does |
|---|---|---|
| Pure logic | `functions/call-retention-logic.js` | Calendar-month age math in America/New_York, holds, which fields to strip, the audio path check, the audit row. No firebase imports. |
| Scheduled sweep | `functions/call-retention.js` (`callRetention`, daily 03:20 ET) | Three phases: audio, transcript, brief. Bounded pages, a cursor, a deadline, a dry run. |
| Wiring | `functions/index.js`, `function-map.json`, `FUNCTIONS_INDEX.md`, `cron-gates.js`, `flags-registry.js`, `integrations/heartbeat-plan.js` (shared `daily-retention` check), `documentation/runbooks/HEALTHCHECKS-SETUP.md`, `firestore.indexes.json` (collection-group index on `call_briefs.generatedAtMs`) | |
| Tests | `tests/call-to-close-retention-2026-11-09.test.js` (node bucket); pins raised in `cron-gate-drift` (48) and `flags-registry-drift` (55) | |

Nothing changes in the browser. No page, script tag or rule changed.

## What it does, phase by phase

1. **Audio (12 months).** A `phone_calls` doc older than 12 months that still has `storagePath`: the Storage object is deleted (`ignoreNotFound`), then the call gets `storagePath: null`, `audioRemoved: 'retention'`, `retention.audioDeletedAtMs`. A call still `stored` (its audio never transcribed) also becomes `listed`, the status a call with no CRM audio already has, so it leaves the transcribe queue and the Pipeline Health "waiting" count. Only a path of the shape `calls/{the call's userId}/...` is ever deleted. Any other path is counted as `badPath` and left alone.
2. **Transcript (24 months).** A `phone_calls` doc older than 24 months: `transcript`, `segIndex`, `summary`, `callerFacts` become `null`, `promises` and `actionItems` become `[]`, `transcriptSaved: false`, and `retention.transcriptStrippedAtMs` is set. The call's brief at `leads/{leadId}/call_briefs/{callId}` is deleted with it. **The `phone_calls` doc is never deleted**: its date, number, customer, duration, status and `driveFileId` stay.
3. **Brief (24 months).** Any `leads/{leadId}/call_briefs/{callId}` with `generatedAtMs` over 24 months old is deleted. A doc named `call_briefs` anywhere else is never touched (`collection-group-paths.js` `matchDocPath`).

**Age.** Calendar months in ET. On ET day D a record is past N months when its date is before 00:00 ET on D minus N months, with the day clamped to the end of a shorter month (Aug 31 minus 6 months is Feb 28, or Feb 29 in a leap year). A call counts from the **later** of `startedAtMs` and `createdAtMs` (when the CRM filed it), so a recording imported late is kept from its import, never less. A brief counts from `generatedAtMs`. A record with neither date is never touched.

**Holds (chosen here; tell me if you want it different).** A record is skipped and counted, never deleted, when any of these is true:
- the call has `legalHold === true`;
- its lead has `legalHold === true`;
- its lead has an **open insurance claim**, unless `claimStatus` is "Paid Out" (your explicit close, which also clears a stale stage or claim number). Open means any one of:
  - `claimStatus` set and not "No Claim" ("Denied" counts as open, because a denied claim is the one most often disputed; off-list values such as the old `in_progress` count too);
  - `claimStage` past filing: anything but `initial_inspection`, `documentation` or `completed` (claim-core.js `STAGE_TO_STATUS`, copied server-side and pinned by the test). The claim panel writes `claimStage` with no `claimStatus` when ClaimCore is not loaded, and the lead modal saves "No Claim" by default, so "No Claim" does not clear an open stage;
  - the lead's pipeline `stage` is on the insurance track (`claim_filed` through `supplement_approved`, ky-insurance-law.js `INSURANCE_STAGES`);
  - a `claimNumber` is on file.

  A carrier alone is **not** a hold: intake records the homeowner's insurer before any claim exists. Tell me if you want it to be one.

Both flags are set by hand in the Firestore console for now (there is no button). A hold covers every phase.

**Bounds.** Pages of 100, at most 1000 records a phase a run, a deadline one minute inside the 540-second timeout. Each phase keeps a cursor (its date field plus the doc id or path) in `system/callRetention`, so the next run starts where this one stopped. Ties on the same millisecond are safe (one ingest run files many calls with the same `createdAtMs`). Every 30 days the pass starts again from the oldest record, so a lifted hold is looked at again. A record whose write failed goes on that phase's retry list in `system/callRetention` (at most 100) and is tried first on the next night's run, not left for the rescan.

**Audit.** Every deletion writes one `call_retention_log` row. Transcript and brief rows go in the same batch as the change. Audio cannot (a Storage delete is not part of a Firestore batch), so its row is written **first**, with `state: 'pending'`, then the object is deleted, then the call patch and `state: 'done'` commit together. A failed delete marks the row `failed` and keeps `storagePath`; a failed patch leaves the row `pending` and the call on the retry list, and the retry finishes the patch even if a hold landed in between (the audio is already gone). So a deleted object always has a row. Each row holds: kind (`audio`, `transcript`, `brief`), call id, lead id, owner and company, doc path, Storage path, the fields stripped, the age date, the cutoff, the policy months, the Drive file id (for the record), the run id and time. Never a transcript, quote or summary. The collection and `system/callRetention` are server-only: no rule opens them, and the catch-all at the end of `firestore.rules` denies every client.

**Never touched.** The Drive original (the sweep never loads a Drive client); the timeline entries on the lead (`activity/cube-<id>`, which copy the call summary and promises: they are the CRM's business record, see the open question below); `thursday_calls`, `phone_texts` and `phone_text_days`.

## Read this before you turn it on (review round, 2026-11-09)

What Q7 covers today, and what it does not. Each of these keeps data **longer** than Q7 says, never shorter; none deletes more.

- **The AI notes have more than one copy.** Stripping `summary` and `promises` from `phone_calls` leaves the same summary and promises in the customer's timeline entry `leads/{id}/activity/cube-{callId}` (`call-center-logic.js` `buildCallActivity`) and in the follow-up task made from the call (`buildFollowUpTask`). Both are kept with no limit. So "transcripts 24 months" today means the transcript and the call's own notes; the customer timeline still shows what the call said. **Open question 1 needs your answer** before Q7 is fully met.
- **Thursday recordings are not covered.** `thursday_calls` and the visit-capture transcripts keep their transcripts with no limit (open question 4). Q7 is not fully covered until they are.
- **The backlog is counted from its import, not from the call.** A call's age counts from the later of its start time and `createdAtMs`, and `createdAtMs` is when the CRM filed it (`buildCallDoc`). The Cube ACR history backfilled from Drive in October 2026 therefore counts from October 2026, whatever the real call date: a 2023 call keeps its CRM audio until October 2027 and its transcript until October 2028. **Nothing from that backlog is removed for 12 / 24 months after the import.** If Q7 meant "24 months from the call", say so and the age date becomes `startedAtMs` alone.
- **Deleting a brief deletes its decisions too.** A brief's `decisions[]` (every accept / edit / reject on it, including an insurance acknowledgement) goes with the brief at 24 months. Leads with an open claim are held, so a claim in flight keeps them.
- **Orphaned audio is not swept.** Only the object a call's `storagePath` names is ever deleted. A CRM audio file under `calls/{owner}/` that no call points at (an upload whose call write failed, or a personal-call delete that cleared the path but not the object) stays. Sweeping those means listing Storage and dating by the object's own time with no call to check a hold against: a new kind of deletion, so it waits for your OK (open question 5).
- **"Not personal" brings old audio back.** The Call Center's Not personal action re-copies the recording from Drive to a new `storagePath` on the old call. The audio phase's cursor is already past that call, so the copy stays until the next 30-day rescan picks it up (at most about 30 days past the 12 months).

## Runbook for Jo

The gate is `CALL_RETENTION_ENABLED` on the `callRetention` function. Unset (the default) is a **dry run**: it reads, counts and logs what it would do and writes nothing, not even its cursor.

1. **Deploy** the function and the new index (`firebase deploy --only functions:callRetention,firestore:indexes`). Wait until the `call_briefs.generatedAtMs` collection-group index shows Enabled in the console; until then the brief phase stops with `stoppedBy: 'error'` and is logged; the other two phases still run and save their cursors.
2. **Read a dry run.** After 03:20 ET, open the function's logs and find `[callRetention]`. `phases.audio.eligible`, `phases.transcript.eligible` and `phases.brief.eligible` are what a live run would remove (the first 1000 of each); `held` counts by reason; `badPath` should be 0. A dry run always starts from the oldest record, so the count is the same each day until you turn it on. `phases.<phase>.pastCutoff` is the whole backlog: every record dated before that phase's cutoff (one count query, dry run only), including any already done, so it is an upper bound on what the live runs will work through.
3. **Set any legal holds first.** On a lead or a call, add the field `legalHold` = `true` (boolean). Open claims are held automatically.
4. **Turn it on.** Set `CALL_RETENTION_ENABLED=true` on the function (in `functions/.env.nobigdeal-pro` or the console) and redeploy. Each run removes up to 1000 records a phase, so a backlog clears over a few nights.
5. **Check it.** In Firestore, `call_retention_log` has one row per deletion; `system/callRetention` shows the cursors and the last run's counts. A stripped call shows `retention.transcriptStrippedAtMs`; a call whose audio was removed shows `audioRemoved: 'retention'`.
6. **Stop it.** Unset the variable (or set anything other than `true`) and redeploy. It goes back to the dry run at once. Nothing it removed can be restored from the CRM; the Drive original of every call is still in Jo's Drive (`driveFileId` on the call).

## Assumptions

- Retention is one policy for every tenant (24 / 12 months), not a per-company setting. Today only NBD has phone calls.
- "Transcript fields" means the transcript, its segment index and the AI notes made from it (summary, promises, caller facts, action items). `callType`, `status`, `urgent` and `followUpDate` stay, so the Call Center's lists still sort the call.
- A brief goes when its call's transcript goes, as well as at 24 months from when it was made, so a quote never outlives the transcript it came from.
- A failed record is counted and logged; the cursor moves past it, and the next run retries it from the retry list (the 30-day rescan is the backstop if the list overflows at 100).

## Open questions for Jo

1. Should the call's timeline entry on the customer (summary and promises copied at filing time) also be stripped at 24 months? It is left alone now, as a business note.
2. Is "Denied" an open claim for the hold? It is now.
3. Should a hold have a button on the customer card? Today it is a console field.
4. `thursday_calls` (Thursday recordings) and visit-capture transcripts also keep transcripts. Q7 named the Cube ACR calls only; until these are covered, Q7 is only partly met.
5. Should the sweep also delete CRM audio under `calls/{owner}/` that no call points at (orphans), dated by the object's own upload time?
6. Should the age of a backfilled call count from the call itself (`startedAtMs`) instead of its import? Today the October 2026 backfill is kept until October 2027 (audio) and October 2028 (transcripts).

## How it was checked

Red before green: the new suite against `d1f7bfe0c` failed 83 checks and then threw (the modules did not exist). After: all checks pass. Gates: see the lane return.

Process note (review round): in the first round both modules were written before the test file, and the red-before evidence was rebuilt afterwards by running the finished suite against `d1f7bfe0c`. That evidence is real but thin: it fails because the modules are missing, not because each behaviour is wrong. The review-round fixes (open claim on `claimStage` / the insurance track / a claim number; the audio audit row before the delete and the retry list; `stored` to `listed`; the dry-run backlog count; the flag's group) were each written test-first: the new checks were run and seen failing for the behaviour they name before the fix, one commit each.

**Scale (later work).** Every phase pages through every `phone_calls` (or brief) record dated before its cutoff, including ones already stripped or without audio, and they count toward the 1000-a-phase cap. The 30-day rescan starts again from the oldest. Once one phase has more than about 30,000 pre-cutoff records, a pass cannot reach newly aged records before the next rescan resets it. Fine at today's volume; the fix then is a filter on `retention.*` or a separate done marker.
