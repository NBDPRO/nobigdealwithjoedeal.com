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

> **Update 2026-11-09 (P2 integration, `ctc-p2`):** the retention item below is closed: `callRetention` sweeps `visit_*` briefs at 24 months (held by the customer's claim / legal hold and the visit's `legalHold`), and a walkthrough brief now marks hard-to-hear quotes (the visit pipeline stores `segIndex`). See [SESSION-2026-11-09-call-to-close-p2](SESSION-2026-11-09-call-to-close-p2.md).

- "Said on a call, not in this proposal" (`call-to-close-logic.js` `loadLeadBriefs`) reads only phone-call briefs; walkthrough briefs are not in that check yet.
- Accepting the summary does not repaint the timeline until the page reloads (the button passes no `onChange`, to keep the boot-loaded code small).
- Retention: there is **no sweeper for `leads/*/call_briefs` in `functions/`** (Q7 default: briefs 24 months; design §9 lists retention as its own P2 item), and walkthrough briefs add more transcript-derived text to that collection. Account erasure covers them (they live under `leads/`), but nothing purges by age. **When the retention lane lands it must sweep `visit_*` briefs as well as phone-call briefs** (same collection, ids `visit_<visitId>`, `generatedAtMs` on every doc). Tracked here on purpose; not built in this lane.

## How it was checked

Red before green, against `d1f7bfe0c`: the server suite 22 passed / 62 failed, the UI suite 12 / 10, the rules suite 19 / 6. Boot growth on `customer.html`: 594 shipped bytes (787 readable); `dashboard.html` 0. Screenshots of the timeline button, the sample account's quiet answer, the filled sheet and the proposal list at 375x812 and 1280x800; `window.__NBD_DEMO__.blocked` empty.

## Review round (2026-11-09)

Two reviewers, 13 items, deduped. Each fix is test-first, one commit.

| Item | Fix |
|---|---|
| A stored `visit_<visitId>` brief is never checked against the caller's `visitUid` (ids are client-chosen; visit-capture.js `visit_id_conflict` was the only guard) | `callBrief` / `callBriefDecide` refuse (permission-denied) a stored walkthrough brief whose `visitUid` is not the caller's, before it is served, regenerated over or decided. |
| `loadGatedVisit` answered not-found before the role test (an existence oracle on `users/{uid}/visit_captures/{id}`) | A missing visit runs `canActOnVisit` against the recorder's company first: a caller who may not act gets the same permission-denied as for a real one. |
| `groundQuote` was a bare substring match ("2 layers" grounded in "12 layers"); on the walkthrough path `digitsInQuote` is always true, so the digit rule rested on it | Whole-word match (both sides are single-space-joined tokens, padded with spaces). Applies to every brief quote; every call-brief / call-to-close suite still passes. |
| `MONEY_RE` missed "15k", "fifteen thousand", "8 hundred" | Dropped too; "hundred" / "thousand" followed by an area or length unit ("fifteen hundred square feet") is a measurement and is kept. |
| A failed sheet load made the tap silent (`.catch(() => {})`) | The call card's toast: "Could not open the call brief. Try again in a moment." |
| Every walkthrough button had the same accessible name | `aria-label="Brief this walkthrough from <time>"` (visible words lead: label in name). |
| The button borrowed the receipt button's class | Its own `tl-row-btn` (44px, 6px top margin) in `invoice-pipeline.css`, `?v=7`. |
| scope_facts are paraphrases, so production may keep few | The eval kit (`scripts/eval-call-brief.js`) takes walkthrough cases (`source: 'visit'`, `scopeFacts`) and reports **scope kept** per case and overall; one synthetic fixture (4 of 6 kept). Jo's live run on real walkthroughs is the measurement. |
| Retention (Q7) has no sweeper for `call_briefs` | Not built here (its own P2 lane); tracked in "Not done" above, including `visit_*`. |
| Accepting the summary does not repaint the timeline | Left as is (already in "Not done"; no `onChange`, to keep the boot path small). |

Boot growth of this round on `customer.html`: +96 readable bytes in `call-timeline.js`, +71 in `customer-bootstrap.module.js` (shipped 1344 KB of 1346 KB). Re-shot on the demo at 375x812 and 1280x800 (the row, the sample's quiet answer, the toast when the sheet cannot load); the button reads `doc-btn tl-row-btn`, 44px, with a per-visit `aria-label`; `window.__NBD_DEMO__.blocked` empty. The toast shares the bottom edge with the demo's Sample account bar on a phone; that is the page-wide toast position, not this button's.
