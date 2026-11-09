# Session 2026-11-09: Call to Close P0 + P0b (built)

Branch `ctc-p0` (worktree `.claude/worktrees/ctc-p0`), from `2c2647142`. Builds §9 P0 steps 0-7 and P0b of [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md). Jo accepted the recommended default for every §11 question; what each one means for this build is in the table below.

## What shipped

| Step | Files | What it does |
|---|---|---|
| 0, eval harness | `scripts/eval-call-brief.js`, `tests/fixtures/call-brief-eval.json` | Scores briefs with the callable's own prompt, sanitising and gate: field precision and recall, claim # exact match, promise who + kind, unreliable transcripts caught, the gate. Offline by default (canned answers, no network). `--live` with `ANTHROPIC_API_KEY` asks the real model; `--model` picks Haiku 4.5 or Sonnet 5.5; `--cases <dir>` reads Jo's real labelled calls kept outside the repo; `--bar-*` exits 1 under a bar. Seven synthetic cases: claim, repair, replace, angry, Spanish, cut-off, shared number. |
| 1, pure logic | `functions/call-brief-logic.js` | Prompt (tenant name, region and stages from the tenant; transcript fenced and neutralised; notes never sent; no sampling parameters); strict json_schema with no money field; speech normalising (number words, digit-by-digit claim numbers, "H as in Henry"); quote grounding; the digit rule; spoken dates resolved by the server on the call date (0-120 days ahead for a due date, up to 3 years back for a date of loss); instruction-shaped quotes dropped and flagged; unreliable transcripts (the model's flag, plus the server's too-little-speech and Spanish guards) blank everything but the summary. A call never suggests a signed contract, a job stage or a won stage. |
| 2, callables | `functions/call-brief.js`, `killswitch.js` (`isCallBriefDisabled`), `lead-brief.js` (exports `aiAllowed`), `index.js`, `FUNCTIONS_INDEX.md`, `function-map.json` | `callBrief`: App Check, ghost check, `aiDisabled` + `callBriefDisabled`, exactly callCenterAction's role test, the lead in the call's tenant, the human-filed gate, cache (version + transcript hash; a re-tap is free; a forced refresh inside 10 minutes serves the stored brief), verified email + paid plan, and quotas of 20 per user and 60 per company per ET day in one transaction. Writes `leads/{leadId}/call_briefs/{callId}` server-side. `callBriefDecide`: one item per call, append-only `decisions[]`, fill-empty field writes (never an overwrite), the insurance-job acknowledgement for carrier, claim # and an insurance job type, one summary note per call. |
| 3, callCenterAction | `functions/call-center.js` | Promise `slot` 0-5: 0 or absent is byte-identical to before (pinned against a golden captured from the old code); n > 0 writes `promise-<callId>-<n>`, never retires the generic task, still marks the call handled. A move (and attaching a filed call elsewhere) deletes the old lead's brief. |
| 4, rules | `firestore.rules`, `.github/workflows/ci.yml` | `leads/{leadId}/call_briefs/{callId}`: read is callCenterAction's audience read off the call with `get()`, only while the call is filed on that lead; `write: if false`. |
| 5 + P0b, sheet | `docs/pro/js/call-brief-ui.js`, `docs/pro/css/call-brief.css` | Lazy `<dialog>`: summary (Add to timeline confirms first), field diff (Accept / Edit / Skip, KY warning + confirm on carrier, claim # and an insurance job type), promises (You / Them toggle, kind, date, Add + confirm, sent with its slot), follow-up only when it differs (lazy `followup-deck.js`), Mark handled, read-only stage card, Draft proposal (P0b). |
| 6, buttons + demo | `docs/pro/js/customer-calls.js`, `docs/pro/js/call-center-view.js`, `docs/pro/demo-sdk/firebase-functions.js` | `briefGate` on both cards: "Draft from this call" for a human-filed call, "Confirm the customer first" (the existing file action) for an auto-matched one or a shared number. Demo: `callBrief` / `callBriefDecide` CANNED with the no-phone answer. |
| 7, docs | this note, the design note's update, `INDEX.md` | |

## Jo's answers (§11) and what they mean here

| Q | Answer | In this build |
|---|---|---|
| 1 | One click opens a filled-in draft he finishes; P0b now | Draft proposal on the customer page. Only the Project Description is seeded, from fixed phrases (work kind, damage, mentions; no numbers), and only when the customer has none. Scope items are shown as a "From the call" list beside the scope field, never seeded. On #/calls the sheet links to the customer instead (DocPreflight reads the customer page's lead). |
| 2 | Brief on tap only | No trigger, no schedule. |
| 3 | Accept may fill claim fields one at a time with the warning | Yes; the server also refuses carrier / claim # / insurance job type without `confirmedInsurance`. |
| 4 | Decision-makers / objections not lead fields yet | Kept in the brief, not shown, never written. |
| 5 | Transcribe-now is early P1 | Not built. |
| 6 | Lawyer review before anything goes beyond NBD | Documented only. Nothing here changes who is recorded or where audio goes. The brief sends a transcript NBD already stores to Anthropic, the same path the notes pass uses. |
| 7 | Retention later (P2) | Not built. Briefs sit under the lead, so account erasure covers them. |
| 8 | Repair calls use the builder (P1) | Not built. |
| 9 | Sales reps do not get briefs | The callCenterAction role set exactly; a rep who does not own the call is refused by the callable, the rules and the button. |
| 10 | Do not seed docOverrides | Scope items are never seeded. |
| 11 | Stop viewers reading phone_calls transcripts, as a separate fix | Not in this PR. Briefs themselves are never viewer-readable. |

## Assumptions (the safer reading where the design left room)

- A filled field is never overwritten from the sheet. "Needs Edit" in §4 is read as: change it on the customer card. Edit in the sheet only changes the value written into an empty field.
- The follow-up date is a new top-level brief fact (`followUp`), so "changes only when it differs" has a date to compare.
- "Them" promises always become `waiting` (waiting on the customer); the toggle flips the kind back to the model's kind for "You".
- A filed call attached to a different customer also loses its old brief (the design named only a move).
- The server's spoken-date reading wins over the model's date when the words resolve.
- Script `?v=` query strings were not bumped (recent changes to these files did not bump them either).

## Not done, and why

- The real eval on about 20 NBD calls: needs prod transcripts and API spend (Jo's run: `node scripts/eval-call-brief.js --live --cases <dir>`, then with `--model claude-sonnet-5-5`, then set the bars). Haiku 4.5 stays the default until it runs.
- Confirming Jo's account passes `aiAllowed` and that `CALL_CENTER_TRANSCRIBE_ENABLED` is on: needs prod access.
- Deploy and the `callBriefDisabled` flag doc in `feature_flags/global` (absent = on).

## How it was checked

Red before green: logic, callable, slot (the slot-0 golden passed on the old code while slot 1 failed), rules (5 allow controls denied with no rule) and buttons all failed first. Gates: see the PR body. Screenshots of the sheet on the sample account at 375x812 and 1280x800 (summary, field diff, claim # confirm, promises, promise confirm, stage, drafts, the seeded proposal); the walk found five layout and copy problems, fixed in `3db267e78`.

## Lane "viewer": Q11, viewers no longer read call transcripts

Design: [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md). Jo took the default for Q11: stop viewers reading `phone_calls`, as a separate fix. Branch `ctc-viewer-fix`, based on `2c2647142`.

### What changed

- **`firestore.rules` `match /phone_calls/{docId}`**: read is now `notViewer() && (isOwner(userId) || isAdmin() || (role in [company_admin, manager] && sameCompanyAsResource()))`. Before, it allowed `isCompanyReader()`, which includes `viewer`. The new read set is the same audience as the `callCenterAction` role test in `functions/call-center.js`. A viewer is refused even for a call filed under the viewer's own uid, because the doc holds the full transcript, the recording path and the AI notes. Writes are still `false` (server only). `.get('role', '')` keeps a solo operator with no role claim from throwing (NEW-5).
- **Client surfaces that read `phone_calls`** (found by grepping `docs/`), and what each now does for a viewer:
  | Surface | Read | Viewer before the rule change | Now |
  |---|---|---|---|
  | `call-center-view.js` `fetchFrom` (Call Center, #/calls) | own userId + companyId | the two denied reads would show "Could not load your calls" | the read is skipped, and a quiet note says "Calls are hidden for your role." (texts still show) |
  | `customer-calls.js` `fetchCalls` (customer card, Calls) | leadId and by-number, userId + companyId | errors were swallowed and the card said "No calls yet" | `phone_calls` is skipped, Thursday calls still show, and the note says "Calls from your phone are hidden for your role." |
  | `home-attention.js` (Home strip) | own userId, recent + old | `callsFailed` / `oldFailed` warnings | both reads skipped; texts still count |
  | `layouts/inbox.js` `loadCalls` | own userId | the feed errors, and the banner says "could not load calls and texts" | the calls read is skipped; texts still load |
  | `speed-to-lead.js` `matchCalls` | own userId | already off for viewers (`available()`) | unchanged |
  `care-plan-members.js` and `call-center-filters-logic.js` mention `phone_calls` only in comments. Server readers use the Admin SDK, so the rule change does not affect them.
- **Not changed (worth a follow-up decision):** `phone_texts`, `phone_text_days` and `thursday_calls` are still readable by viewers (Thursday's call docs carry `call.transcript` too). Q11 named `phone_calls` only. Storage `calls/` was already owner-only. The full list is under "Follow-ups for Jo" below.

### Evidence

- Red before (emulator, `tests/firestore-rules.cross-tenant.test.js` on the old rules): 478 passed, **4 failed**. The four were viewer get, viewer companyId query, viewer own-uid get and viewer own-uid query, each "WAS ALLOWED".
- Green after: 482/482. These still read: the call's userId (sales_rep), a solo owner with no role, company_admin (get and companyId query), manager (including a call owned by a viewer), and the platform admin. Cross-tenant company_admin / manager, anon and no-claim users are still denied.
- Client suite `tests/phone-calls-viewer-hidden-2026-11-09.test.js` (node bucket): 12 of 23 failed against the HEAD client files, and 23/23 pass after the fix.

### Review round (2026-11-09)

- Stale comments fixed: `firestore.rules` contact_suggestions and careplans now name `thursday_calls` as the tenant reader set, and the TEXT INBOX header in `tests/firestore-rules.cross-tenant.test.js` no longer says phone_texts has "the same readers as phone_calls".
- `storage.rules` `calls/{uid}/**` keeps `isOwner(uid)`. Its comment now says why: a viewer can reach only audio filed under their own uid, they can no longer learn the path from `phone_calls`, and only the tenant owner's uid has calls (`functions/call-center.js` files them under `OWNER`).
- Claims-timing edge: a `phone_calls` read sent before `window._userClaims` hydrates goes out with role `''` and is denied for a viewer. `call-center-view.js`, `home-attention.js` and `layouts/inbox.js` now check the role again when the read fails, so that denial shows as "hidden", not as "Could not load". `customer-calls.js` already swallows read errors and picks its note at render time. Red test commit first, then the fix (`tests/phone-calls-viewer-hidden-2026-11-09.test.js`, 27/30, then 30/30).
- Not redone: the first commit holds both the red test and the fix. The red state was proven against the old rules (478/482), so only the history is affected. The commit was not rewritten.
- Accepted as is: on a 375px phone, the Call Center's "Calls are hidden for your role." note sits under the demo banner and bottom nav until you scroll. It is legible and has `role="status"`.

### Follow-ups for Jo (outside Q11, the same kind of PII)

Q11 named `phone_calls`, so these were left alone. Each needs Jo's decision. **The PR body must ask Jo about them directly**, because Q11's aim (viewers don't read call transcripts) is not fully met while they stay open:

1. **`thursday_calls` is viewer-readable and carries `call.transcript`.** The customer card still renders Thursday calls for a viewer (`customer-calls.js` reads `thursday_calls` for every role). Closing it means the same `notViewer()` change on `match /thursday_calls/{docId}`, plus the client skips.
2. **`phone_texts` / `phone_text_days`** (message bodies and per-day text notes) are viewer-readable. This was already listed as skipped in the first pass.
3. **Call summaries and notes copied to leads.** `callCenterAction` `attach` / `move` (`functions/call-center.js` `attachCallToLead` / `moveCallToLead`) put the call's timeline entry and follow-up task on the lead. A viewer reads lead activity and tasks, so the AI summary reaches them that way.
4. **Lead briefs.** `functions/lead-brief-logic.js` `canReadLead` lets a same-company `viewer` through and builds `CALL <date>: <summary>` lines from lead activity. Briefs are not a P0 viewer surface (Q2 / Q9). **The Call to Close brief lane must not widen `canReadLead` for viewers.** If anything, a viewer's brief should drop the CALL lines.
