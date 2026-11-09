# Session 2026-11-09: Call to Close P1 (four lanes, integrated)

Branch `ctc-p1` (worktree `.claude/worktrees/ctc-p1`), from `88eb11bcf` (the P0 + P0b branch). Builds §9 P1 of [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md). Four lanes were built and reviewed in their own worktrees, then cherry-picked here in this order, every commit kept: `ctc-p1-transcribe` (15), `ctc-p1-estimate` (13), `ctc-p1-stage` (20), `ctc-p1-followup` (19). Commits that needed a conflict resolved say so in an `Integration:` line. Nothing was pushed.

Lane notes with the detail: [SESSION-2026-11-09-call-to-close-p1-transcribe](SESSION-2026-11-09-call-to-close-p1-transcribe.md) (transcribe), and the "estimate" and "followup" sections of [SESSION-2026-11-09-call-to-close-p0](SESSION-2026-11-09-call-to-close-p0.md). The stage lane wrote no note; it is summarised below.

## What shipped

| Lane | What a user sees | Server / data |
|---|---|---|
| Transcribe now + segment confidence | "Transcribe now" on a recorded call with no transcript (customer card and Call Center card), for the call's owner, a same-company company_admin / manager, or the platform admin. In the brief, a quote Whisper was unsure of says "Unsure: hard to hear on the recording." A claim # or date from such a quote has no Accept: the person listens and types it. | `callTranscribeNow` (callable, App Check, ghost check, callCenterAction's role test; AI kill switch, `CALL_CENTER_TRANSCRIBE_ENABLED`, `integrations/callCenter.paused`; 10 per user / 30 per company per ET day in `call_transcribe_quota`; a 15-minute `transcribeLease` shared with the schedule). Every transcription stores `segIndex`. `callBriefDecide` refuses a retype field without `retyped: true`. |
| Estimate from the call | "Start estimate" ("Start repair quote" on a repair call) in the sheet's Drafts card. The builder opens with the caller's choices as dashed "from call" chips (× undoes one), a said square count as words beside the area box, and up to 5 job templates (repair templates for a repair call). Nothing is saved until the rep acts; closing untouched undoes every choice. | `docs/pro/js/estimate-call-prefill.js` (pure mapper, lazy). `callBriefDecide` logs `draft:estimate`. Deep link `?lead=<id>&callBrief=<callId>` plus a sessionStorage hand-off carrying the brief the callable returned. |
| Stage moves + said vs. proposal | The Stage card offers "Move to <stage>" in one tap for a plain forward move, through the CRM's own writer and its Undo. Inspected, install_complete, Lost / Archived / Cancelled and any move back ask first (Lost needs a reason). Appointment-setting stages never move from the sheet; signed / job / won are refused twice. When a proposal opens, "Said on a call, not in this proposal" lists call items missing from it, each with "Copy into scope". | `callBriefDecide` item `stage` with `mode` one-tap / confirmed; `fromStage` read from the lead's own `stageHistory`; move-back judged by the tenant's pipeline order (`tenantStageOrders`). `progressStage(target, opts)` and `moveCard(..., { lostReason })`. `docs/pro/js/call-to-close-logic.js`. |
| Follow-up, auto-brief, rescue, objections | A "Follow-up message" card (Text / Email) built only from accepted items in fixed phrases; a text needs written consent on file and goes through `NBDPhoneShare.share` (the server's ok-to-text check). "Objections on the call" with copy-only playbook replies. On the Call Center: "Auto-brief filed calls: Off — Turn on" for the owner / company_admin, and a "Needs a next step" tab (Brief / Follow-up / Dismiss). | `callBriefAuto` (onDocumentUpdated `phone_calls/{callId}`, default off, runs as the filer through `callBrief`'s gates and caps). `companies/{cid}/settings/callBrief` rules. `callCenterAction` `rescueDismiss` / `rescueUndismiss`. |

## Integration work (this branch, after the picks)

- **Conflicts.** `tests/ci-manifest.json` and `FLOORS` (each lane registered its own suites), `functions/index.js` + `FUNCTIONS_INDEX.md` (`callTranscribeNow` and `callBriefAuto` side by side; `callBriefDecide` lists `draft:proposal`, `draft:estimate`, `draft:followupText`, `draft:followupEmail`), `functions/call-brief-logic.js` exports, the `callBriefDecide` item regex, `call-center-view.js` actions (`tx` beside `rescuedismiss`), and `call-brief-ui.js` (three lanes). In the sheet: the stage card keeps the Unsure mark on its quote; Cancel on a confirm keeps a retype box's typed value and also clears the Lost reason.
- **One sheet.** The sections now run: Summary, Customer details, Promises, Follow-up (date), This call, Stage, Objections, Follow-up message, Drafts (estimate, proposal). Drafts stays last because its card ends at the sheet's foot.
- **The cross-lane rule: a hard-to-hear digit is never filled in by one tap anywhere.** The transcribe lane marked fields only. The estimate prefill filled stories / layers with no tap, the follow-up date was one tap and then named in the follow-up message, and a promise's due date was prefilled. Now `sanitizeBrief` marks `scope.stories`, `scope.layers` and the follow-up date like fields (unsure + retype when the value has a digit), `tierInterest` as unsure, and a promise with a due date from an unsure quote as retype. The prefill lists a retype stories / layers as its own line ("Stories was hard to hear on the recording (…), so it is not filled in. Check it and set it yourself.") and never sets it. The sheet's follow-up card has no one-tap button for a retype date, and a retype promise starts with an empty due date. The proposal's copy-only "2-story house" line says it was hard to hear.
- **Auto-brief and every callBrief gate.** Checked, no change: `autoBriefHandler` runs `switchedOff(true)` (aiDisabled + callBriefDisabled), the ghost check on the filer, `loadGated` (callCenterAction's role test, the lead in the call's tenant, the human-filed gate), the cache, verified email + paid plan, the same quota, and the same `generate` (so `segIndex` and the unsure marks apply).
- **Rescue list's Brief button.** Checked, no change: it renders only when `briefGate(c) === 'draft'`, the same gate as the call card. The tab is hidden from viewers.
- **Demo.** `callTranscribeNow` is canned with the no-phone answer; `callBriefAuto` is a trigger (nothing to can); the follow-up text goes through the existing `phoneTextAction` path.
- **Rules / indexes.** One new rules block (`companies/{cid}/settings/callBrief`) with its own CI step and emulator suite. No new composite index: the new client queries (`phone_calls` by `leadId` + `userId` / `companyId`) are equality-only.
- **Cache-bust.** `estimate-v2-ui.js` was changed by the estimate lane with no bump; it is now `v=37` in `script-loader.js` (a cached v=36 would ignore the call prefill).
- **FLOORS** 976/74/1108 → 984/74/1117 (8 node suites, 1 emulator rules suite).

## Final review round (two reviewers, eleven items)

Fixed, test-first, one commit each:

- **Day audio allowance under-counted on overlap (items 1 and 7).** `runTranscribe` wrote `usedSec + out.audioSec`, where `usedSec` was read at the start. A Transcribe-now tap during a scheduled pass (or the reverse) dropped the other run's seconds. The seconds are now added in a transaction on what is stored at the end; a new ET day still starts over.
- **Transcribe now deadline (item 2).** `callTranscribeNow` ran 300 s, the same as Groq's own request timeout, with the FLAC re-encode before and the notes step after. It now runs 540 s (as the schedule, under the 15-minute lease), so a paid transcript is still kept and the quota refund still runs. Found on the way: the Firebase SDK gives up on a callable after 70 s, so the button would have called a long recording a failure while the server was still working. The button now waits 540 s.
- **Builder strip at desktop width (item 6).** In the V3 wizard the "From the call" strip takes the step body's centred 560 px column, so it no longer looks detached from the builder.
- **Auto-brief switch target (item 11).** The Turn on / Turn off button was 36 px tall at desktop width; it is 44 px at every width (`phone-calls.css` `?v=14`; `call-center-filters-2026-10-21` now pins the version as at least 13, not exactly 13).
- **callBriefAuto invocation count (item 8).** Its `FUNCTIONS_INDEX.md` row now names every write it starts on: label, `rescueDismiss`, and both the claim and the clear of a `transcribeLease`, so one transcription is at least three starts.

Checked and left as they are:

- **"Sent from your phone" (item 3).** Not a defect. With `preferSms`, `NBDPhoneShare.share` returns `shared: true` only after the person answers yes to "Did the text go out from your phone?" (or "Did the email go out?"); a no is `cancelled` and nothing is logged. The wording reports what the person confirmed.
- **One-tap stage move on the customer page (item 4).** Not a defect. `progressStage` asks only when `stageMoveNeedsConfirm` is true. A one-tap plan is never Lost / Archived / Cancelled (the same pattern as `stagePlan`'s close-out rule), so it asks only when the 3-day cancellation-window warning applies, the page's deliberate "warn, never block" confirm. Otherwise it is one tap, as on the board.
- **Retype attestation (item 5).** As written under "Decide" below: `retyped: true` is a client attestation that stops mistakes. It does not prove the person typed the value, and the AI's own digits sent back with it are accepted.
- **The server's one-tap check is a log integrity check, not a move gate (item 9).** `callBriefDecide`'s `stageOneTapAllowed` checks the decision-log entry only: by the time it runs, the client has already moved the stage through `progressStage` or `moveCard`. The client's `stagePlan` (`call-to-close-logic.js`) is the real gate, and the writers keep their own confirms.
- **Fuzzy-grounded quotes count as unsure (item 10).** `unsureQuotes` treats a grounded quote it cannot place in the normalised transcript as unsure, so with a `segIndex` present a digit from such a quote always goes to retype. That errs on the safe side. Counting how often it happens in `scripts/eval-call-brief.js` is a P2 follow-up.

## What Jo must run or decide

- **Deploy order.** Functions first (`callTranscribeNow`, `callBriefAuto`, the `callBriefDecide` changes, `rescueDismiss`), then rules (`companies/{cid}/settings/callBrief`), then hosting. The client degrades if hosting lands first (the callables answer not-found and the sheet shows the error).
- **`CALL_CENTER_TRANSCRIBE_ENABLED=true`** must be set for Transcribe now to do anything; until then it refuses with a plain message.
- **Auto-brief stays off** until the owner turns it on from the Call Center. It spends against the same 20 / 60 daily brief quota.
- **Decided here, Jo may overrule:** an unsure promise due date now starts empty (the transcribe lane left this as "ask Jo"; the integration brief says digits from a low-confidence segment are never one-tap anywhere).
- **Decide:** the deep link uses `?lead=` plus a sessionStorage hand-off rather than design §5.1's `?edit=`, because the held `dashboard-bootstrap.module.js` opens the lead editor for `?edit=`. Editing the bootstrap's parser would remove the hand-off.
- **Decide:** the retype gate trusts the client's `retyped: true` (honour-based, stops mistakes, not a deliberate bypass).

## Gaps

- Transcribe now shows on any stored call the user can act on, but the server only takes the owner tenant's calls (single-tenant pipeline until P2).
- `call_transcribe_quota` docs never expire (P2 retention should list them).
- `callBriefAuto` starts on every `phone_calls` update (512 MiB, `maxInstances: 5`); the transition check returns before any read.
- Chimney / skylight chips carry no quote (the brief keeps those mentions as yes / no).
- The sheet has two filled buttons when a follow-up message and a proposal draft both show (Check and open in Messages, Draft proposal). Each is the main act of its own card.
- The stage lane wrote no session note of its own; this note is its record.

## How it was checked

All on the integrated branch:

- `check-js-syntax` clean (2347 files); `check-site-integrity --quiet` 0 failures; `check-inline-html-scripts` clean; `apply-partials --check --diff` clean; `check-vault-index` clean; `run-test-manifest --check` 1117 suites classified, floors current; `gen-function-map --check` up to date (337 functions).
- `dashboard-boot-budget-2026-10-03` 36/36.
- Full node bucket 984/984 (run again after the last fix). `tests/smoke.test.js` 4434 passed, 0 failed.
- Emulator rules, one at a time: `call-brief-settings` 23/23, `call-briefs` 20/20, `cross-tenant` 482/482, `company-docs` 47/47.
- Browser: `pro-demo-zero-network-2026-10-06` 122/122, `crm-layouts-render-2026-10-15` 49/49.
- Test-first for the integration fixes: `call-to-close-segment-confidence-2026-11-09` section 5 went red (8, then 3, then 1) before each fix; 57/57 after. Every `call-to-close-*`, `call-brief-*` and `call-center-*` suite passes.

After the final review round (same branch, five fix commits): `check-js-syntax` clean (2347 files); `run-test-manifest --check` 1117 suites, floors current (no suite added); `check-site-integrity`, `check-inline-html-scripts`, `apply-partials --check`, `gen-function-map --check`, `check-vault-index` clean; `dashboard-boot-budget-2026-10-03` 36/36; full node bucket 984/984; `tests/smoke.test.js` 4434 passed, 0 failed; emulator rules one at a time `call-brief-settings` 23/23, `call-briefs` 20/20, `cross-tenant` 482/482, `company-docs` 47/47; browser `pro-demo-zero-network-2026-10-06` 122/122, `crm-layouts-render-2026-10-15` 49/49. The integrated screenshots were taken again: the builder strip sits in the step column at 1280x800, and the auto-brief button measures 44 px tall at both widths.

Screenshots of the integrated sheet, the Call Center and the builder at 375x812 and 1280x800 (demo account, no network): the section order above, no sideways scroll, no one-tap follow-up for a hard-to-hear date, an empty date on the hard-to-hear promise, the builder listing the hard-to-hear story count as a line and not filling it, 2 rescue rows with one Brief button, Transcribe now on the stored call, nothing blocked by the demo tripwire, no page errors.
