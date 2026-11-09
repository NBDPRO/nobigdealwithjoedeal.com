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
| 11 | Stop viewers reading phone_calls transcripts, as a separate fix | Built as its own lane (below) and shipped in the same PR. Briefs themselves are never viewer-readable. |

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

#### Update 2026-11-09 (lane fu-viewers): all four closed

Jo said "close all four". Branch `fu-viewers` (from `6728fcbb4`).

1. **`thursday_calls`**: read is `notViewer() && (old audience)`, like `phone_calls`. Client skips with the quiet note: `customer-calls.js`, the customer timeline (`customer-bootstrap.module.js`), the Thursday widget (`widgets.js`), `thursday-handled.js` (`canRead`). `contact-suggest.js` was already off (it needs `canWrite`).
2. **`phone_texts` / `phone_text_days`**: same rule change. Skipped for a viewer in the Call Center (note now "Calls and texts are hidden for your role."), the customer card, the Home strip and the Inbox (a quiet `ib-note` line). A denial that lands before the claims hydrate still shows as hidden.
3. **Call summaries on leads.** Two parts:
   - **Timeline entries (rules level).** `leads/{id}/activity` read adds `notViewer() || resource.data.source in ['rep', 'visit-capture']`. That is an allowlist, keyed on a field every call-sourced doc already carries (`cube-acr`, `sms-backup`, `thursday`, `call-brief`), so there is no migration. A viewer lists through `NBDCallTimeline.activityQuery` (`where('source', 'in', [...])`). **Why not a denylist:** under the emulator, any `not-in` / `!=` constrained viewer query passed a `!(resource.data.source in [...])` rule and returned a Thursday entry. A negated `.get('source', '')` let even an unconstrained list through. Only the positive `in` / `==` proof held. Side effect: a viewer also loses other server-written sources (webhooks, payments, away hand-backs, voice memos with no `source`). No viewer screen reads them. `smart-followup.js` `_loadConversation` now gets a denial for a viewer and falls back to its no-timeline draft.
   - **Follow-up tasks (moved off the doc).** A rule on `tasks` would have broken viewers' task lists: many tasks have no `source`, and `collectionGroup('tasks')` readers would need the same constraint. So `buildFollowUpTask` (calls and text days) no longer writes `Call: <summary>`. It writes "The summary is on the customer's timeline." and keeps "You said you would". `moveCallToLead` copies an old task through `scrubTaskSummary`. **Backfill not run.** Older `cube-*` / `sms-*` tasks keep the paragraph. A backfill would select `leads/*/tasks` where `source` is `cube-acr` or `sms-backup`, set `notes = scrubTaskSummary(notes)` (only when it changes), dry run by default and `--apply` only with Jo's OK. Thursday's own task (`thursday-<id>`, notes `Summary: ...`) is untouched; that is an open question.
4. **Lead briefs.** `mayReadCallContent(auth)` is false for a viewer. Their brief has no CALL / TEXTS / THURSDAY / PROMISE line, and it never reads or writes the shared `lead_briefs` cache (built from those lines). `canReadLead` is unchanged.

Tests: `tests/firestore-rules.call-content-viewers.test.js` (emulator, wired in ci.yml; 30 of 100 fail on the old rules, 100/100 after), `tests/call-to-close-viewers-2026-11-09.test.js` (node; 35 of 59 fail at `6728fcbb4`, 62/62 after). Pins that said viewers still read texts or Thursday calls were updated in `phone-calls-viewer-hidden-2026-11-09` and `call-center-crm-update-2026-10-03`.

## Lane "estimate" (P1, 2026-11-09)

Branch `ctc-p1-estimate`. The Call Brief sheet's **Start estimate** ("Start repair quote" on a repair call) opens the estimate builder with the caller's choices (job mode, work kind, tier, stories, layers, chimney / skylight flashing), each a "from call" chip whose × puts the old value back. A said square count is a hint beside the area input, never typed in. Repair calls are offered repair templates, inserted only on a tap through `JobTemplates.insertIntoV2`. Autosave holds back until the rep acts; closing untouched undoes every choice. Test: `tests/call-to-close-estimate-prefill-2026-11-09.test.js`.

**For Jo: the deep link differs from design §5.1.** It is `/pro/dashboard.html?lead=<id>&callBrief=<callId>`, not `?edit=<leadId>`: the held `dashboard-bootstrap.module.js` opens the lead *editor* for `?edit=` and the *estimate builder* for `?lead=`, so the existing `?lead=` branch is used and the bootstrap is not edited. The bootstrap cleans its URL before the lazy builder loads, so the customer page also writes a sessionStorage hand-off (`nbd.callBriefLink`: lead id, call id, the brief the callable returned, a time). The builder reads it once, within five minutes, for the same customer and the same call as the URL (when the URL still names one). The hand-off exists only because of that URL clean; editing the bootstrap's parser would remove the need for it.

### Review round (2026-11-09)

- **Kill switch.** The builder no longer reads `leads/{leadId}/call_briefs/{callId}` (clients cannot read `feature_flags/global`, so it could not check `callBriefDisabled` itself). Every brief it uses came from the `callBrief` callable. The sheet awaits the `draft:estimate` log, and `callBriefDecide` refuses when the switch is on, so nothing opens. A hand-typed URL alone prefills nothing.
- **Log wording.** The tap is logged as "tapped Start estimate" (it used to say "opened the estimate builder" before the open had happened). A log that fails for any other reason (network) still opens the builder.
- **Late brief.** If the rep taps or types before the brief lands, its choices are listed as "said on the call, not filled in (you had already started)", never applied, and V3 is not re-opened over the rep's step.
- **Shingle swap.** A call tier that would switch the scope's shingle line (Beyond → HailGuard, Economy → no 3-tab) is listed, not set, so the call never sets the scope and × / an untouched close undo everything.
- **Pending autosave.** A save queued by the rep's last edit is flushed before the prefill arms, and the timer and `_flushDraftNow` skip while the prefill is untouched.
- **Navigation.** The catalog search, the presentation, the packet choice, packet photo toggles and catalog categories no longer count as the rep acting.
- **Accessibility.** `#v2rawSqft` names the said-square-count hint in `aria-describedby`.
- **Phone.** The strip keeps the rep's fold across repaints; on a phone it starts folded once this device has shown one (`localStorage nbd.callStripSeen`).
- **Not done:** chimney / skylight chips have no quote (the brief keeps mentions as yes/no); the chip says "no exact words kept". Keeping a quote for mentions is a `call-brief-logic.js` change for a later lane.

## P1 lane "followup" (2026-11-09): follow-up draft, auto-brief switch, rescue list, objections

Branch `ctc-p1-followup`, from `88eb11bcf`. Builds §5.3, §6 #6 and #7, and the auto-brief item of §9 P1 of [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md).

| Piece | Files | What a user sees |
|---|---|---|
| Follow-up message | `docs/pro/js/call-brief-ui.js`, `css/call-brief.css` | A "Follow-up message" card in the brief sheet, built only from what the person accepted (promises with their own who / kind / date, the follow-up date, the adjuster meeting) in fixed phrases. Text needs written consent on file (`tcpaConsent` + the server's `tcpaConsentAt`, as `sms-consent-declined.js` `consentBasis`); otherwise it says why, and "you can text me" on a call is not consent. "Check and open in Messages" goes through `NBDPhoneShare.share` (the server's ok-to-text check, then Messages; the person presses Send). Email opens the mail app with the draft written (`email_system.js` untouched; there is no non-held CRM email composer). Only a confirmed send is logged (`draft:followupText` / `draft:followupEmail`). |
| Objections | same | Tags for each objection and a named competitor, the words said, a playbook reply from fixed phrases (`PLAYBOOK`; a tenant can override a reply via `companyProfile.callPlaybook.<kind>`), Copy only. Never a lead field (Q4). |
| Auto-brief | `functions/call-brief.js` (`callBriefAuto`, `autoBriefHandler`), `call-brief-logic.js` (`autoBriefTransition`, `filerOf`), `firestore.rules`, `call-center-view.js` | Owner / company_admin see "Auto-brief filed calls: Off" on the Call Center (only with phone calls loaded). On, a person filing a call drafts its brief as that person, through callBrief's gates and caps. Off by default. |
| Rescue list | `docs/pro/js/call-rescue-logic.js`, `call-center-view.js`, `functions/call-center.js` (`rescueDismiss`) | A "Needs a next step" tab: customers whose newest contact is a noted business call 2-30 days old with no promise, follow-up or stage move since. Brief / Follow-up (the existing promise sheet) / Dismiss (with Undo). |

Assumptions: no call settings tab exists, so the switch sits on the Call Center next to the pipeline health line; "business call" = not personal / spam / supplier / sub, on a customer; a customer's own follow-up on or after the call counts as a next step; the rescue logic is fetched when the Call Center opens (not added to the `callcenter` bundle, whose contents three older suites pin). Boot bytes: 0 on both pages.

### Review fixes (2026-11-09, second pass)

- **The owner sees the switch.** `canSetAutoBrief` now allows role `admin`: `mintOwnerClaims` stamps the owner accounts `{ owner: true, role: 'admin' }`, so Jo never saw it before. The suite runs the function with real claim shapes.
- **One tap, one auto-brief.** `attach` re-files every earlier unfiled call from the number (`refileNumber`, `refiledFrom`), each with `attachedBy` = the filer. `autoBriefTransition` now skips a call whose filing was that sweep (until a person moves it, or attaches it themselves, which clears `refiledFrom`). Swept calls still brief on tap.
- **Ghost filer.** `callBriefAuto` checks tenant-guard `isGhost` on the filer, as the callables run `assertNotGhost`.
- **Undone follow-up.** The sheet's follow-up Undo is not logged, so the follow-up message only uses a logged follow-up date while the customer still carries it.
- **Rescue Dismiss** refuses `txt_` ids (the list holds calls only).
- **Cache-busters** bumped: `call-brief-ui.js` v=2, `call-brief.css` v=2, `call-center-view.js` v=28, `customer-calls.js` v=10, `script-loader.js` v=211.
- **Which company the switch sets.** The client writes `companies/{companyId claim || uid}`; the server reads `companies/{call.companyId || call.userId}`. A solo owner sees the switch only when their `companyId` is missing or equals their uid (the rules' `ownsTenantByUid`). A tenant whose calls carry a `companyId` that is not the owner's uid can be switched only by a `company_admin` of that company (or the platform admin), as the rules allow.
- **Handled calls are in "Needs a next step".** A call marked handled with no promise, follow-up or stage move after it still lists: "handled" says someone dealt with the call, not that the customer has a next step. Dismiss takes one off.
- **Trigger cost.** `callBriefAuto` starts on every `phone_calls` update (ingest, notes, facts, handled). The pure transition check returns before any read, but each start is a 512MiB instance holding the Anthropic secret, `maxInstances: 5`; an ingest burst queues behind those. Kept at 512MiB because it runs the same generate and grounding pass as `callBrief`; noted in `FUNCTIONS_INDEX.md`.
- **Not changed: the settings doc's read rule.** A same-company viewer or rep can read `companies/{cid}/settings/callBrief`. It holds one boolean and who set it; narrowing it buys nothing and would hide whether auto-brief is on from the people whose filing triggers it.
