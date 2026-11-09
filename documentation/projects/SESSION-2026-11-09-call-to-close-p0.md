# Session 2026-11-09: Call to Close P0 (lane "viewer": Q11, viewers no longer read call transcripts)

Design: [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md). Jo took the default for Q11: stop viewers reading `phone_calls`, as a separate fix. Branch `ctc-viewer-fix`, based on `2c2647142`.

## What changed

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
- **Not changed (worth a follow-up decision):** `phone_texts`, `phone_text_days` and `thursday_calls` are still readable by viewers (Thursday's call docs carry `call.transcript` too). Q11 named `phone_calls` only. Storage `calls/` was already owner-only.

## Evidence

- Red before (emulator, `tests/firestore-rules.cross-tenant.test.js` on the old rules): 478 passed, **4 failed**. The four were viewer get, viewer companyId query, viewer own-uid get and viewer own-uid query, each "WAS ALLOWED".
- Green after: 482/482. These still read: the call's userId (sales_rep), a solo owner with no role, company_admin (get and companyId query), manager (including a call owned by a viewer), and the platform admin. Cross-tenant company_admin / manager, anon and no-claim users are still denied.
- Client suite `tests/phone-calls-viewer-hidden-2026-11-09.test.js` (node bucket): 12 of 23 failed against the HEAD client files, and 23/23 pass after the fix.
