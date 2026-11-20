# Recordings Bin, Keep, Hold and Erase (2026-11-20)

Jo's ask (2026-11-20): "currently we cant even disregard or trash one only save it unassigned which is why i have several. maybe we bin you
have to confirm to permanently delete ... help me build a perfect fully built out system and function tree for recordings." Decided in a
17-question design round (Q1 to Q17, every one a yes to the recommended answer). Visit recordings first (the red Record button); call
recordings come later on the same Bin.

## What existed before

`docs/pro/js/visit-recorder*.js`, `functions/visit-capture*.js`, [VISIT-CAPTURE-PR2](VISIT-CAPTURE-PR2-2026-10-13.md),
[RECORD-BUTTON](RECORD-BUTTON-2026-11-07.md). A visit is `users/{uid}/visit_captures/{visitId}` with audio at
`audio/{uid}/_inbox/{visitId}.{ext}`. **Discard already existed**, but it destroyed the audio, transcript and notes at once (a two-tap arm, no
modal), only in the Unfiled sheet, the Home "unfiled for over a day" row and the recovery sheet; Recent visits and attached visits had none.
**Keep** was a 24-hour hide of the Home row in localStorage, nothing more. Audio expires at 90 days (`companies.recordingRetentionDays`,
`recordingRetentionCron`); transcripts and notes were kept for ever. There was no erase-a-customer flow, and `legalHold` was honoured for call
briefs only, never for visits.

## The model

Nothing is destroyed by one tap.

| State | Meaning | Nagged? | Audio, transcript, notes |
|---|---|---|---|
| Unassigned | not on a customer | yes | kept; audio expires by the 90-day rule |
| Kept | reviewed, needs no customer | no | kept, searchable in Recent visits |
| Attached | filed on a customer | no | kept; timeline row and tasks on the customer |
| **Binned** | discarded; 30-day Bin | no | **kept** 30 days; filed items retracted |
| Deleted forever | final | n/a | audio, transcript, notes, phone copy all removed |

Any state can also carry a **Hold** (owner / admin): it blocks the Bin's 30-day purge, Delete forever and the 90-day audio expiry until released.

## Function tree

- **Bin** (any rep): one tap with an Undo toast; unassigned or attached; Unfiled sheet, Recent visits, the Home row ("Bin all N").
- **Restore** (from the Bin): back to its previous state; re-filed on the same customer if it was attached.
- **Keep / un-keep** (any rep): a real state.
- **Bulk** select (Attach, Keep, Bin) and swipe-to-Bin in the Unfiled sheet.
- **Delete forever** (owner / admin, Bin only, never a Held one): a confirm that names the visit.
- **Erase all recordings for a customer** (owner / admin): permanent, skips the Bin, typed confirm, skips Held ones and says how many.
- **Hold / Release** (owner / admin).
- **Daily Bin job**: deletes Bin items past 30 days unless Held. **Nothing else is ever deleted automatically** except the audio 90-day rule that
  already existed (audio only; unchanged). Unassigned recordings are never binned or deleted by a rule; only flagged with their age.
- **Owner / admin see everyone's** recordings (Unfiled, Kept, Bin), labeled by rep; a rep sees only their own.
- **Audit log** `companies/{cid}/recording_audit/{id}`: who, what, which visit, when, how many; never a transcript, note, name or address.
  Written BEFORE the delete: no log, no delete.

## How it is built (PR 1: data model, rules, server, daily job, audit; no screens, flag off)

- **Phone writes** (`firestore.rules` `vcKeys`, mirrored by `DOC_FIELDS`): `keptAtMs`, `binnedAtMs`, `hardDeleteAtMs`, `binnedFrom`
  (`unfiled`|`attached`), `binnedLeadId`. The rules pin the deadline: `hardDeleteAtMs == binnedAtMs + 30 days` and `binnedAtMs` within a day of
  the server clock, so a phone cannot set a past deadline (the job would purge early) or a far one (never expires). A write of
  `status:'discarded'` on a recording that is in the Bin is refused: **Delete forever is the server's**.
- **Server-owned** (not in the allowlist): `legalHold`, `holdBy`, `holdAtMs`. The audit collection has no client rule at all (default deny).
- **State machine** (`functions/visit-capture-logic.js` `nextStep`): a binned recording is parked (no new transcription or notes); one that is
  still filed on a customer is un-filed (the phone wrote `leadId: null` and remembered `binnedLeadId`); Restore puts `leadId` back and the
  ordinary finalize files it again. A Held recording the phone discarded is not purged.
- **Jobs and callables** (`functions/visit-capture.js`): `visitBinSweep` (daily 03:40 ET, heartbeat slug `daily-retention`, query
  `collectionGroup('visit_captures').where('hardDeleteAtMs','<=',now)` with a single-field COLLECTION_GROUP index); `visitCaptureAdmin`
  (`list`, `hold`, `release`, `deleteForever`, `eraseCustomer`, `audit`): owner / admin only, never a viewer or manager, the caller's role and
  company from the server, every target checked to be in the caller's company. `retentionSweep` skips Held recordings.
- **Failure behaviour:** a recording whose company cannot be read is left for tomorrow, never deleted unlogged; an audio delete that fails
  goes to `purge_pending` and the existing sweep retries, never to a final state that still holds the audio.

## Known limits (honest)

- **Reps can still delete forever through the old Discard** while the flag is off: the rules cannot tell the flag, and the old Discard
  (`status:'discarded'` on a recording not in the Bin) must keep working until the screens move to the Bin. When the Bin is on for everyone, the
  rules should refuse `status:'discarded'` from the phone altogether. That is a later, deliberate tightening, not in PR 1.
- **A client cannot be stopped from re-binning** a recording over and over (each resets its own 30 days). That only extends their own copy.
- The unfiled list for the admin reads each rep's newest 300 recordings (capped); the Bin and Kept lists are indexed.

## Plan, one PR at a time, each checked on Jo's iPhone before the next

1. **PR 1 (this one):** the above. No screens. Nothing changes for anyone: Discard works as before.
2. **PR 2:** the screens behind the flag `recordingsBin`: Unfiled | Recent | Bin tabs, select mode and bulk actions, swipe-to-Bin, one-tap Bin
   with Undo, Keep, Restore, "audio expires in N days", the Home row's Bin all. Owner / admin tabs through `visitCaptureAdmin`.
3. **PR 3:** the customer-page Recordings section (Hold per recording, Erase for owner / admin with a typed confirm) and Settings.
4. **PR 4:** call recordings on the same Bin (calls are server-ingested from Drive, so this is a different write path).

Flags: the screens ship behind `recordingsBin` on Jo's account first (`feature_flags/{uid}`; Claude cannot write prod flags, Jo flips it and
Claude reads it back), then widened in `feature_flags/_default`.

## Tests

`tests/recordings-bin-logic-2026-11-20.test.js` (the phone's pure logic and phone/server agreement),
`tests/recordings-bin-server-2026-11-20.test.js` (the daily job, the callable, Hold, erase, the state machine, on an in-memory Firestore),
`tests/firestore-rules.visit-captures.test.js` (extended: the pinned deadline, Keep, Restore, the discard guard, Hold and the audit log
server-only; run on the emulator). Each was run against deliberate breakages and fails when the behaviour is broken.
