# Session 2026-11-09: Call to Close P2, lane "walkthrough" (built)

Branch `ctc-p2-walkthrough`, from `d1f7bfe0c` (the P1 branch). Builds design §6 #11 of [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md): an in-person inspection walkthrough (a visit recording, `users/{uid}/visit_captures/{visitId}`) gets the same Call Brief sheet as a phone call. Earlier lanes: [SESSION-2026-11-09-call-to-close-p0](SESSION-2026-11-09-call-to-close-p0.md), [SESSION-2026-11-09-call-to-close-p1](SESSION-2026-11-09-call-to-close-p1.md).

## What a user sees

On a customer's timeline, a visit recording that has notes shows **Brief this walkthrough** to the person who recorded it, a company_admin or manager, or the platform admin (never a viewer, never another rep). One tap opens the Call Brief sheet, worded for a walkthrough: the summary with its quotes, the customer details (fill-empty, one at a time, the Kentucky insurance warning on carrier / claim #), the follow-up date, the stage suggestion, objections, the follow-up message ("thanks for having us out") and Drafts. The promises said at the walkthrough are listed as "already tasks on this customer" (the visit pipeline filed them when the walkthrough was attached), so there is no Add and no "Mark handled". Start estimate opens the builder with the walkthrough's stories, layers and flashing mentions as "from call" chips; Draft proposal shows a "From the walkthrough" list beside the scope field. Nothing is pre-ticked, sent, priced or signed.

## Server

| Piece | Where | What |
|---|---|---|
| Logic | `functions/call-brief-logic.js` | `canActOnVisit` (callCenterAction's test with the recorder as the owner), `visitBriefProblem` (only a `ready` visit: notes ran, so the consent check and the personal / do-not-record purges ran; filed on the customer; not discarded), the in-person prompt (`source: 'visit'`; the phone prompt is byte-identical), `groundScopeFacts` and `mergeVisitScope`. |
| Callables | `functions/call-brief.js` | `callBrief` / `callBriefDecide` take `{ visitId, visitUid }` as well as `{ callId }`. Same kill switches, plan check, 20 / 60 day quota and cache. The customer must be in the recorder's tenant. Stored at `leads/{leadId}/call_briefs/visit_<visitId>` with `source`, `visitId`, `visitUid`. Promises and `handled` are refused on a walkthrough. |
| Detach / move | `functions/visit-capture.js` `retract` | Deletes the old customer's walkthrough brief (only the one this person made). |
| Rules | `firestore.rules` `call_briefs` | `visit_<id>`: read by the recorder, admin, or a company_admin / manager of the brief's company, only while the visit is still filed on this lead, and only when the id is `visit_` + the stored `visitId`. Writes stay server-only. |

**scope_facts.** The visit notes' `scopeFacts` (`visit-capture-logic.js` `sanitizeVisitNotes`, which nothing read before) are model output, so they never reach the brief's model. The server keeps a fact only when its own words ground in the walkthrough transcript, drops any that talk money (price, cost, dollars, deductible, ACV, warranty, total) or read like instructions, and then fills only what the brief left empty: stories / layers (digit rule kept), the gutters / chimney / skylight / decking mentions, said quantities (hints, never a number in the area box), and `scope.visitFacts` for the proposal list.

## Assumptions (the safer reading)

- "Filed on a customer by a person" for a visit = `attachedLeadId` set: only a person sets it (a pre-attach from the customer page or the attach callable; the server's suggestion chips never attach).
- Only `pipelineStatus: 'ready'` is briefable. `notes_failed` has a transcript but its notes never ran, so the personal and do-not-record checks on the notes did not either.
- The client gate does not compare companies: the activity rules already keep other companies' rows off the page. The server and the rules compare them.
- Walkthroughs have no per-segment confidence (`segIndex`), so no quote is marked unsure.
- The builder's chips still say "from call" (`estimate-v2-ui.js` untouched).
- The Call Center keeps loading the sheet as `?v=2` (it never opens a walkthrough); the customer page loads `?v=3`.
- Auto-brief stays phone-only (Jo's Q2: briefs on tap).

## Not done

- "Said on a call, not in this proposal" (`call-to-close-logic.js` `loadLeadBriefs`) reads only phone-call briefs; walkthrough briefs are not in that check yet.
- Accepting the summary does not repaint the timeline until the page reloads (the button passes no `onChange`, to keep the boot-loaded code small).
- Retention of walkthrough briefs follows the brief retention lane (they live under `leads/`, so account erasure covers them).

## How it was checked

Red before green, against `d1f7bfe0c`: the server suite 22 passed / 62 failed, the UI suite 12 / 10, the rules suite 19 / 6. Boot growth on `customer.html`: 594 shipped bytes (787 readable); `dashboard.html` 0. Screenshots of the timeline button, the sample account's quiet answer, the filled sheet and the proposal list at 375x812 and 1280x800; `window.__NBD_DEMO__.blocked` empty.
