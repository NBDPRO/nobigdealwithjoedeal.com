# Storm and demand queue — recon (2026-10-22)

Two items, each shrunk to its real gap. Verified against `origin/main` at the
time of writing. No customer data, phone numbers or addresses appear here.

## 1. Storm-to-customer outreach drafts

**Already built (do not rebuild):**

- `storm_near_customers` (`functions/agent-mcp-logic.js` `stormNearCustomers`,
  tool in `agent-mcp.js`): NWS/IEM local storm reports from `storm_events`
  (written by `storm-watch.js`; measured gusts since #2233) matched to leads
  by haversine. Read-only, bot-facing, **active leads only by location, names
  + addresses, no draft**.
- Storm Mode (`docs/pro/js/storm-mode.js`, opt-in, off by default) and the
  callable `fileStormDrafts`: one fixed-wording `draft_text` per customer who
  sat inside a live NWS **warning polygon**, into `agent_inbox`. Owner sends
  from their own phone; `agentDraftAction` re-checks STOP / Do-Not-Text /
  consent / texting switch / quiet hours at send. See
  [AUTO-THEME-AND-STORM-MODE-2026-10-11](AUTO-THEME-AND-STORM-MODE-2026-10-11.md).
- `buildTextDraft` (company name + STOP line + 480 cap),
  `claimWordingProblem` (Kentucky gate), `textGate` (STOP register, company
  DNC, declined form, no phone).

**The real gap:** Storm Mode only fires while a CRM tab is open during a
*warning*, and its wording says "a warning covered your area today". Nothing
turns a **recorded storm report** (hail size / measured gust in `storm_events`)
into a reviewable list that splits **past customers** from **open leads**
with a per-person draft. `storm_events` has no client rule (server-only), so
the CRM cannot read it directly: a callable is needed.

**Plan (small PRs, one at a time):**

1. Backend: pure `functions/storm-outreach-logic.js` (cohorts, distance,
   report-based wording through `buildTextDraft` + claim gate) and two
   owner/admin callables — `listStormOutreach` (read-only; names, address
   stage, miles, draft body; **no phone/email returned**) and
   `fileStormOutreachDrafts` (server recomputes event + distance from
   `storm_events/{key}`, never trusts the client; same gates as
   `fileStormDrafts`; ids `stormrep_<event>_<lead>` via `create()`).
2. Later PR: Storm Center panel in the CRM that calls the two callables.
   Needs a phone check; not started.

Rules honoured: drafts only, nothing sends (Twilio A2P went Verified
2026-10-19, but every outbound path stays behind the fail-closed kill switch
`messaging_controls/global` and per-automation flags, absent = OFF; a draft is
sent by the owner from their own phone, and only a Twilio "delivered" status
proves delivery); email stays
out of scope (existing owner-approval path only); quiet hours 8am-9pm
homeowner-local at send; no claim/outcome/price/insurance words; no "we
handle the claim", no AOB; gate run on all copy.

## 2. Google Business Profile (case 8-9748000042165, project 717435841570)

- **Status:** cannot be read from here. `gcloud` has no signed-in account in
  this sandbox, and the quota read needs one. Per the memory note, approval
  shows as the Cloud Console quota for the My Business APIs moving 0 → 300
  QPM. Requested 2026-09-27 (quoted 7–10 business days, so now overdue):
  **Jo to check Cloud Console quotas / the case email.**
- **Already built, dormant:** `functions/gbp-reviews-sync.js`
  (`syncGbpReviews`, daily, all reviews), `getGoogleReviews` fallback,
  `functions/social-adapters.js` GBP adapter (off unless `SOCIAL_GBP_ENABLED`).
  Setup recipe: `functions/google-reviews.README.md` "Business Profile API".
- **Plan and read-only reviews/insights design:**
  [GBP-READ-ONLY-DESIGN-2026-10-22](GBP-READ-ONLY-DESIGN-2026-10-22.md).
  Nothing that needs the API is built.

## Status (end of session, 2026-10-22)

- **PR 1 (backend) is built and committed on branch
  `claude/storm-demand-e88c51`, but not opened as a PR**: the queue rule is to
  wait until the tracker/Call Center PRs (#2662-#2667) merge or CI is healthy,
  and CI was still backed up (runs queued). Open it, rebase first, when CI
  drains. Files: `functions/storm-outreach-logic.js`, the two callables in
  `functions/agent-mcp.js`, `tests/storm-outreach-2026-10-22.test.js` (48
  checks, mutation-run: every guard goes red when broken), plus the
  function-map / FUNCTIONS_INDEX / index.js / viewer-callables / manifest rows.
- Needs a `functions/` deploy before the callables exist in prod. No flag, no
  rules change, no prod write.
- **PR 2 (CRM panel)** not started: a Storm Center list with tick boxes that
  calls the two callables. Needs a phone-width check.
- GBP: waiting on Jo to read the Cloud Console quota; design is in
  [GBP-READ-ONLY-DESIGN-2026-10-22](GBP-READ-ONLY-DESIGN-2026-10-22.md).
