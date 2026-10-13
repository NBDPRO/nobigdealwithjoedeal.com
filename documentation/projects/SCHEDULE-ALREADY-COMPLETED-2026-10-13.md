# Schedule: "Already completed" on missed rows (2026-10-13)

Jo, on the Schedule view's Plan jobs panel (the "Needs a date" rows for Rachel
Henry, Rose Tran and others): *"We need to be able to say already completed on
anything that missed scheduling and it forwards it to the next stage."*

Answers Jo gave before the build:

1. Target stage = **Install Done** (`install_complete`).
2. Ask for the **completion date each time**, defaulting to today, so a job
   done weeks ago is dated correctly.
3. **Quiet by default** — no drip, review request, auto Before & After report
   or any other customer-facing send.

## Which rows get the button

`schedule-planner-logic.js` — `rowsFor` now returns `missed` as well as
`needs` and `scheduled`, and `completedOffer(lead, order, o)` decides the
button per row.

| Row | Gets "Already completed"? |
|---|---|
| Needs a date (no day, or a planned week that went by) | yes, if the offer rule passes |
| **Missed** (new group): `scheduledDate` — or the last day of a multi-day project — is before today and the job never advanced | yes, if the offer rule passes |
| Next 30 days (today or later) | no — it has not missed anything |
| Already Install Done or later, lost, deleted | not listed at all |
| Estimate-stage lead (via "Show all open leads") | listed, **no button** — the sale was never made |

Before this change a past-dated job that never advanced was in **no** list
(`rowsFor` only kept `today … today+30`), which is how work "that missed
scheduling" went invisible. Missed uses the same stage filter as Needs
(committed work unless "Show all open leads"), shows "Was set for <day> — it
never moved on", most overdue first, and has the same row controls (re-plan it
instead, or Clear the date).

The offer rule (`completedOffer`) — a forward move on the lead's **own** track,
reusing the `crewMoveOffer` shape: `install_complete` must be on the track and
after the current stage, the current stage must be at or past
`contract_signed`, the stage must not be won or lost, no open warranty claim,
not deleted / not a prospect, and the viewer / teammate rules of `moveCard`
(viewer never; a rep only on their own leads; company_admin / manager on their
tenant's; platform admin anywhere). A warranty or service lead whose track has
no Install Done never gets it. It is re-judged at tap time.

## What the write does

One transaction through `stage-write.js commitStageChange(id,
'install_complete', oldStage, { backfill: { date, skipped, unchecked } })` —
same race guards (`STAGE_RACE_NOOP` / `STAGE_RACE_LOST`) as a kanban move; it
deliberately does **not** go through `moveCard`, because the required-field
gate lives there and a backfill must not be blocked by gates for steps it
skipped. In one patch:

- `stage`, `stageRole`, `updatedAt`, `stageHistory` event (`backfill: true`,
  `completedOn`, `reason: 'missed_scheduling'`, and the `skipped` /
  `unchecked` lists — the intermediate stages jumped over and the required
  fields that were not checked);
- `completedAt` = the chosen day at local noon. This is the field
  winback-logic, anniversary-touch, social-studio, agent-mcp and ai-texting
  already read (they fall back `completedAt → installCompletedAt →
  stageStartedAt`; nothing ever wrote `installCompletedAt`, so no parallel
  field was invented);
- `stageStartedAt` = the same day (it entered Install Done on that day, so
  "days in stage" and the paid-in-full recency window are true);
- `completedBackfill` = `{ date, quiet: true, reason, by, byUid, at, token,
  fromStage }` — **the quiet flag** every automation below checks. `token` is
  the history event's timestamp; Undo only fires while it is still on the lead;
- an activity note: `Marked already completed on Oct 1, 2026 (missed
  scheduling)` (+ ` — skipped …; not checked: …` when something was bypassed).

The date is validated twice (planner `completionIssue`, write
`completionDateIssue`; a test pins them to the same table): real YYYY-MM-DD
day, not after today, not before 2015.

After success: the row leaves the list, the board / card chips refresh, toast
`Marked completed ✓ - now Install Done` with **Undo** for 10 seconds.
`undoBackfillCompletion` restores stage / role / stageStartedAt (and closedAt
if the move stamped it) from the server copy it captured inside the
transaction, nulls `completedAt` and `completedBackfill`, appends an undo
event to `stageHistory` (history is never rewritten) and files an undo note —
and refuses with `UNDO_STALE`, writing nothing, if the lead is no longer at
Install Done under the same token (anything moved it since).

## Quiet: who honours the flag

Server automations ask `functions/quiet-backfill.js isQuietBackfill(doc)`, not
the bare flag: **quiet ⇔ the most recent `stageHistory` entry that landed on
`install_complete` was a backfill** (no such entry → the flag decides). The
flag is a lead-level field while a customer can have several jobs (the jobs
mirror copies `stageHistory` per job but not the flag), and a job dragged back
and finished for real later must not stay muted. Client engines check the flag
itself, which `commitStageChange` now clears when a normal move takes the lead
back to open work.

Muted (each has an absence assertion **and** a positive control in
`tests/schedule-already-completed-2026-10-13.test.js`):

| Automation | What it would have done | How it is muted |
|---|---|---|
| `EmailDrip.onStageChange` (stage-write.js) | "Stage email ready" toast to the rep | `!backfill` guard in `commitStageChange` |
| `autoBeforeAfterOnStage` → photo-report `onInstallComplete` | files the homeowner Before & After report | `!backfill` guard (and no `photos` bundle load) |
| `finalInvoiceOnInstall` (functions/install-final-invoice.js) | drafts the final invoice + "Send final invoice" task | skipped on the write that **sets** the flag (`isQuietBackfillEntry`) — a later ordinary re-entry still drafts |
| `reviewRequestNudge` (functions/review-request-nudge.js), both lanes (active job and other jobs) | review-ask bell + digest to the rep | `isQuietBackfill(lead)` / `isQuietBackfill(job)` |
| `anniversaryAutoTouch` (functions/anniversary-touch.js) | 1-year check-in bell + digest | `isQuietBackfill(lead)` |
| job spine `requestReviewTaskIfPaid` (functions/job-spine.js) | "Request Review" task at paid in full | `quiet_backfill` |
| homeowner portal rating card + Google review link + `submitCustomerRating` gate (functions/portal.js) | the "How did we do?" card and the public-review nudge, shown to the **homeowner** once paid in full | `canRate` false, no `googleReviewUrl`, write gate refuses |
| referral bonus (functions/referral-rewards.js `projectClosed`) | credits $100 owed to the referrer the moment the lead is at a won stage | not "closed" while a quiet backfill sits at Install Done; credits when the job moves **past** it. Undo cannot reverse a payout, so it must not fire on the tap |
| review-engine bell, review deck / Home count, Ask Joe morning "Ask for review" | review prompts to the rep | `completedBackfill` filter |
| bots' `post_job` (agent-mcp-logic.js) | lists finished jobs for review suggestions | `quiet_backfill: true` on the row |

Dates are made true rather than muted: the homeowner tracker's step date reads
the history entry's `completedOn` for a backfill (its `timestamp` is when
somebody tapped — it doubles as the Undo token), and `winback-logic completedMs`
prefers `completedAt` over `closedAt` for a backfill (`closedAt` is when the
sale was keyed in, which can be weeks after the job finished).

**Nothing here ever sent to a customer** on its own — every automation above is
a prompt or draft for the rep, the drip toast says "open their customer page",
and the one homeowner-visible surface (the portal rating card) is now gated.

Deliberately **not** muted (internal bookkeeping, nothing reaches a homeowner —
say so if you want it silenced too):

- the stage's own next-step tasks (`StageChecklist` Close-Out Checklist,
  `NBDProduction` "After photos + walkthrough") — the "forwards it to the next
  stage" part. They are due today for a job finished long ago; Undo does not
  delete them;
- audit log, Google Calendar sync, jobs mirror, the homeowner portal's progress
  tracker (it shows the install step as reached, dated by the real day —
  display only, truthful);
- rep-initiated tools: the customer page "Ask for review" button (the rep taps
  it), the Past Customers win-back list (now has a correct `completedAt`; the
  rep still taps Send).

## Review findings (silent-failure + security reviewers, run before the PR)

Fixed from the review: the job-lane review nudge ignored the flag; the homeowner
tracker dated the step by the tap; the portal rating card + Google link were not
gated; the referral bonus would credit on a tap Undo cannot reverse; a drag-back
left the flag and a stale `completedAt` on the lead (and could let an old Undo
fire again); a non-transactional fallback let a backfill through without an
Undo token; winback read `closedAt` first; cache-busters on the changed served
scripts; the bots' review suggestion. Left as noted: the quiet flag is advisory
at the rules layer (a rep with write on their own lead can forge it — it only
silences owner-visible nudges, no cross-tenant reach); `closedAt` is "now" for
a lead with no sale date while `completedAt` is backdated, so "closed this
month" reports and "completed" reads can disagree by design; no check that the
completion day is after the contract day (a sale keyed in late is exactly the
use case).

## Decisions worth Jo's eyes

- **The final-invoice draft is skipped for a backfill**, and the app says so
  ("No final invoice was drafted for this one…"). A job marked finished after
  the fact may have been billed and paid long ago, and a stray "Send final
  invoice" task is how a duplicate invoice reaches a homeowner. Final Photos
  still files its own "Final Invoice" task when the job moves on. Create the
  invoice from the customer page when one is genuinely owed.
- **Review asks stay off for that job** — the nudge, the spine task, the deck
  and the homeowner's rating card — until a genuine re-completion (drag it
  back, finish it for real). Jo's rule was "no review requests for
  backfills"; this is the strict reading of it.
- **The referral bonus waits for the job to move past Install Done** instead of
  crediting on the tap.
- `stageStartedAt` is set to the completion day, not "now".

## Not built / follow-ups

- customer.html stage area: not added — it needs its own date prompt (a native
  `prompt()` is a no-op in the installed app) and a second copy of the confirm
  UI; the right shape is a shared sheet module, a separate slice.
- No "Create invoice" offer after a backfill (the kanban's offer lives inside
  crm-pipeline.js module scope and `moveCard` is bypassed on purpose).
- Other jobs of a multi-job customer are untouched (the planner row is the
  customer's active job).
- Not verified on a real iPhone (see the PR).

## Tests

- `tests/schedule-already-completed-2026-10-13.test.js` — rows, offer matrix,
  date table + parity, the exact patch / note / history in a vm of the real
  stage-write.js, the quiet suppressions with controls, Undo, UI wiring.
  Break-tested: 41 single-guard mutations, each reddening the intended
  assertion (the portal's three gates share one source-regex assertion).
- `tests/e2e/phone-already-completed.spec.js` — authed emulator spec at
  390x844 in the installed app (`@shard2`); 4/4 on the local emulator in
  Chrome with iPhone emulation (not Safari).
