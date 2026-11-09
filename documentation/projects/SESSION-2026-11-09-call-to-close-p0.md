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
- **Not changed (worth a follow-up decision):** `phone_texts`, `phone_text_days` and `thursday_calls` are still readable by viewers (Thursday's call docs carry `call.transcript` too). Q11 named `phone_calls` only. Storage `calls/` was already owner-only. The full list is under "Follow-ups for Jo" below.

## Evidence

- Red before (emulator, `tests/firestore-rules.cross-tenant.test.js` on the old rules): 478 passed, **4 failed**. The four were viewer get, viewer companyId query, viewer own-uid get and viewer own-uid query, each "WAS ALLOWED".
- Green after: 482/482. These still read: the call's userId (sales_rep), a solo owner with no role, company_admin (get and companyId query), manager (including a call owned by a viewer), and the platform admin. Cross-tenant company_admin / manager, anon and no-claim users are still denied.
- Client suite `tests/phone-calls-viewer-hidden-2026-11-09.test.js` (node bucket): 12 of 23 failed against the HEAD client files, and 23/23 pass after the fix.

## Review round (2026-11-09)

- Stale comments fixed: `firestore.rules` contact_suggestions and careplans now name `thursday_calls` as the tenant reader set, and the TEXT INBOX header in `tests/firestore-rules.cross-tenant.test.js` no longer says phone_texts has "the same readers as phone_calls".
- `storage.rules` `calls/{uid}/**` keeps `isOwner(uid)`. Its comment now says why: a viewer can reach only audio filed under their own uid, they can no longer learn the path from `phone_calls`, and only the tenant owner's uid has calls (`functions/call-center.js` files them under `OWNER`).
- Claims-timing edge: a `phone_calls` read sent before `window._userClaims` hydrates goes out with role `''` and is denied for a viewer. `call-center-view.js`, `home-attention.js` and `layouts/inbox.js` now check the role again when the read fails, so that denial shows as "hidden", not as "Could not load". `customer-calls.js` already swallows read errors and picks its note at render time. Red test commit first, then the fix (`tests/phone-calls-viewer-hidden-2026-11-09.test.js`, 27/30, then 30/30).
- Not redone: the first commit holds both the red test and the fix. The red state was proven against the old rules (478/482), so only the history is affected. The commit was not rewritten.
- Accepted as is: on a 375px phone, the Call Center's "Calls are hidden for your role." note sits under the demo banner and bottom nav until you scroll. It is legible and has `role="status"`.

## Follow-ups for Jo (outside Q11, the same kind of PII)

Q11 named `phone_calls`, so these were left alone. Each needs Jo's decision. **The PR body must ask Jo about them directly**, because Q11's aim (viewers don't read call transcripts) is not fully met while they stay open:

1. **`thursday_calls` is viewer-readable and carries `call.transcript`.** The customer card still renders Thursday calls for a viewer (`customer-calls.js` reads `thursday_calls` for every role). Closing it means the same `notViewer()` change on `match /thursday_calls/{docId}`, plus the client skips.
2. **`phone_texts` / `phone_text_days`** (message bodies and per-day text notes) are viewer-readable. This was already listed as skipped in the first pass.
3. **Call summaries and notes copied to leads.** `callCenterAction` `attach` / `move` (`functions/call-center.js` `attachCallToLead` / `moveCallToLead`) put the call's timeline entry and follow-up task on the lead. A viewer reads lead activity and tasks, so the AI summary reaches them that way.
4. **Lead briefs.** `functions/lead-brief-logic.js` `canReadLead` lets a same-company `viewer` through and builds `CALL <date>: <summary>` lines from lead activity. Briefs are not a P0 viewer surface (Q2 / Q9). **The Call to Close brief lane must not widen `canReadLead` for viewers.** If anything, a viewer's brief should drop the CALL lines.
