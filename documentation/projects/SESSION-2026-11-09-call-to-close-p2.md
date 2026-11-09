# Session 2026-11-09: Call to Close P2, five lanes integrated on `ctc-p2`

Branch `ctc-p2`, from `d1f7bfe0c` (Call to Close P1 + NBD OS P2). Design: [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md). P1 before it: [SESSION-2026-11-09-call-to-close-p1](SESSION-2026-11-09-call-to-close-p1.md). Not pushed.

The five lanes were cherry-picked in this order, every commit kept: walkthrough (21), split-call merge (13), retention (8), tenant feed (12), decision map (12). A commit whose pick conflicted carries an `Integration:` line in its message saying how it was resolved (12 of them). Then the cross-lane rules below were built test first, one commit each.

## What shipped (per lane)

| Lane | What a user sees | Lane note |
|---|---|---|
| Walkthrough (§6 #11) | "Brief this walkthrough" on a visit recording with notes, on the customer's timeline (the recorder, a company_admin / manager, or admin). The same Call Brief sheet, worded for a walkthrough. `callBrief` / `callBriefDecide` take `{ visitId, visitUid }`; stored at `leads/{leadId}/call_briefs/visit_<visitId>`. | [SESSION-2026-11-09-call-to-close-p2-walkthrough](SESSION-2026-11-09-call-to-close-p2-walkthrough.md) |
| Split-call merge (§9) | "Looks like one call. Merge?" on two calls from the same number, the second starting within 10 minutes of the first's end. `callCenterAction merge` / `unmerge`; the first call's brief reads both transcripts. | Design note, "Update (P2 lane `ctc-p2-splitmerge`)" |
| Retention (Q7) | Nothing on screen. `callRetention`, daily 03:20 ET: CRM audio after 12 months, transcripts and briefs after 24. Dry run until `CALL_RETENTION_ENABLED=true`. | [SESSION-2026-11-09-call-to-close-p2-retention](SESSION-2026-11-09-call-to-close-p2-retention.md) |
| Tenant feed (Q6) | Nothing for NBD (its pass is pinned byte for byte). Another tenant's Drive recordings can be fed in, dark behind `CALL_CENTER_MULTI_TENANT_ENABLED` and the tenant's own config. | [SESSION-2026-11-09-call-to-close-p2-tenantfeed](SESSION-2026-11-09-call-to-close-p2-tenantfeed.md) |
| Decision map (§6 #5) + P1 leftovers | "Who decides" in the sheet (copy only), one filled button per sheet, flashing chips need their words, quota TTLs, `callBriefAuto` field compare and 256 MiB, the promise retype rule on the server. | [SESSION-2026-11-09-call-to-close-p1](SESSION-2026-11-09-call-to-close-p1.md), "Update (P2 lane dmmap)" |

## Integration decisions

- **One sheet, one order.** `call-brief-ui.js` renders: banners, summary, customer details, promises, follow-up date, this call (phone only), stage, objections, who decides, follow-up message, drafts (estimate, proposal). One filled button, picked by `primaryAct()`. On a walkthrough every heading and badge says "at the walkthrough" (Who decides now says "Heard at the walkthrough").
- **Cache-busting.** The walkthrough and split-merge lanes had already moved `call-brief-ui.js` to `?v=3` and `call-center-view.js` to `?v=29`; decision map wanted the same numbers. Kept as is: they are still above what P1 shipped (`v=2` / `v=28`), and `customer-calls.js` is `v=11`, `script-loader.js` is `v=212` on both pages. Boot budget 36/36.
- **`call-brief.js`.** `gateFor(data)` picks the walkthrough or the call gate; `briefInput` then reads the merged transcript for a call (a visit has no `mergedFrom`, so it reads its own). Both the visit's `source / visitId / visitUid` and the call's `mergedFrom` are stored on the brief.
- **Flags.** The registry pins 56 flags (`CALL_RETENTION_ENABLED` and `CALL_CENTER_MULTI_TENANT_ENABLED` both added).
- **FLOORS** 1008 / 74 / 1145.
- **Which note.** The task named this note `SESSION-2026-11-09-call-to-close-p1.md`, but that file is P1's own session note and already exists. Reading it as a typo for the P2 note, this file is new and the P1 note is unchanged by the integration.

## Cross-lane rules (built here, test first)

1. **A merged call's brief** keeps the low-confidence and digit rules: the joined `segIndex` covers both halves (split-merge lane, unchanged here). **Retention holds a merged pair together:** a hold on either call or its customer keeps both halves (`merged_partner_hold`), so a held brief never loses the redial. An unheld pair goes like any two calls. Retention suite §7b.
2. **A walkthrough brief keeps the same rules.** The visit pipeline now asks Groq for per-segment confidence and stores `segIndex` with the transcript (`visit-capture.js`, the call pipeline's `buildSegIndex`; set to null by a purge). The brief marks a story or layer count heard in a hard-to-hear stretch as retype, and a chimney / skylight mention there as unsure. A walkthrough's chimney / skylight fact keeps its words in `mentionQuotes`, so Start estimate shows the flashing as a chip with its words (the decision-map rule) and not as the "no exact words" line. Walkthrough suite §6.
3. **Retention covers walkthrough briefs.** A `visit_<visitId>` brief goes at 24 months like any brief (it has no `phone_calls` doc), held by its customer's claim or legal hold and by `legalHold: true` on its visit. Retention suite §7b.
4. **Multi-tenant and retention.** The sweep is collection-wide, so a tenant's calls age out on the same policy; only audio under `calls/{that call's own owner}/` is deleted, and a path into anyone else's folder stays a `badPath`. Ingest never re-creates a call it already filed, so a stripped call is not re-fed. Retention suite §7b.
5. **The decision-maker list never writes lead fields.** `callBriefDecide` accepts only its fixed item list, so `people:*`, `who:*` and any `field:` that is not one of the seven lead fields are refused and the lead is untouched. Walkthrough suite §6 (on a walkthrough); the decision-map suite covers calls.

## What Jo must run or decide

1. **Deploy** functions `callBrief`, `callBriefDecide`, `callBriefAuto`, `callCenterAction`, `callCenterIngest`, `callCenterTranscribe`, `callTranscribeNow`, `callRetention`, the visit-capture functions (the pipeline now stores `segIndex`), `coachLine`, plus `firestore:rules` and `firestore:indexes` (the `call_briefs.generatedAtMs` collection-group index and three TTL policies). A push to `main` through the merge queue does the hosting part.
2. **Retention:** read one dry run, set any legal holds, then set `CALL_RETENTION_ENABLED=true` (runbook in the retention note). Open questions there (timeline entries, "Denied" as open, a hold button, Thursday and visit transcripts, orphan audio, backfill age).
3. **Tenant feed:** no tenant is switched on before the lawyer review of recording and consent (Q6). The steps are in the tenant-feed note.
4. **Split-call merge:** confirm the two readings in the design note (a promise found only on the redial still surfaces; an unfiled redial stays unfiled).
5. **Walkthrough:** the live eval of walkthrough cases (`scripts/eval-call-brief.js`, `source: 'visit'`) on real recordings, to see how many scope facts survive grounding.

## Gaps (not built)

- Visit recordings made before this deploy have no `segIndex`, so their walkthrough briefs mark nothing unsure (the digit rule still applies).
- Visit transcripts themselves (`users/{uid}/visit_captures`) and `thursday_calls` are not swept by retention; only the briefs made from walkthroughs are (retention note, question 4).
- The sheet's footer Close button is under 44 px tall at desktop width (44 px on a phone); not changed here.
- The sheet does not say on a merged call's brief that it read two recordings (the Call Center card does).

## Screenshots (375x812 and 1280x800, the sample account)

The integrated sheet for a merged call and for a walkthrough (every section), the Call Center merge suggestion, "Brief this walkthrough" on the timeline, and the estimate builder opened from a walkthrough. No page errors, no network calls blocked, no sideways scroll; every new button 44 px. One problem found and fixed: the builder's strip said "From the call" and "Gutters mentioned on the call" for a walkthrough; it now says "From the walkthrough" and "at the walkthrough" (estimate-prefill suite, 3 red then green).

## How it was checked

Each cross-lane rule was seen failing before its fix (retention §7b: 4 red; walkthrough §6: 11 red; walkthrough-ui wording: 1 red; estimate-prefill wording: 3 red). Gates on the final head: syntax, site integrity, inline scripts, partials, vault index, manifest check (1008 / 74 / 1145), boot budget 36/36, the full node bucket, smoke 4434/4434, the rules emulator suites one at a time (call-briefs-visit 25, call-feed 21, call-briefs 20, cross-tenant 482, company-docs 47), and the two browser suites (pro-demo-zero-network 122, crm-layouts-render 49).
