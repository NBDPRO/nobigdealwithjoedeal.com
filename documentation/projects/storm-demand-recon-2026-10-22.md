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

## Update 2026-10-23

- **PR 1 merged** (#2679): recon, GBP design, the two callables.
- **Do the callables ship with the normal deploy?** Yes. `.github/workflows/firebase-deploy.yml`
  runs on a push to `main` whose paths include `functions/**` (and `docs/**`), and its
  functions steps run on `push`; PR 1 touched `functions/`, so
  `listStormOutreach` and `fileStormOutreachDrafts` ship with that deploy. No
  manual deploy is needed. (Not run or watched from this session; confirm the
  deploy went green before relying on the tab.)
- **PR 2 (CRM panel)**: a new **Outreach** tab in Storm Center
  (`docs/pro/js/storm-outreach-ui.js`, loaded in the `storm` bundle). Tick
  past customers / open leads near a recorded report, preview each draft,
  file the ticked ones. The browser sends only the report key and lead ids;
  wording, distance and the STOP / Do-Not-Text gates are server-side. Owner
  and company admins only. Nothing sends from the tab: the owner sends from
  the Agent inbox. Checked at 360 / 390 / 412 px, light and dark: no
  horizontal overflow, 22px tick boxes, 44px file button; each row has an
  accessible name and a tied label; test
  `tests/storm-outreach-ui-2026-10-23.test.js` (32 checks, 10 mutations red).
- **Jo items:** read the GBP Cloud Console quota (case 8-9748000042165, 0 =
  pending, 300 = approved). Still parked: reviews/insights build.
- **PR 3 (2026-10-23):** Outreach tab gains a radius control (1 / 3 / 5 / 10 mi,
  sent to both callables, clamped and re-measured server-side) and per-report
  Select everyone I can text / Clear (only rows that can be ticked). UI only; no
  backend change; still drafts only. Test now 45 checks, 9 more mutations red.
- **PR 4 (2026-10-23), hardening from the overnight audit (pass 2):** finding 3
  fixed (the Outreach tab drops customers, drafts and ticks when the account
  changes in the same tab, and ignores an answer still in flight for the old
  account); finding 5 fixed in part (filing refuses a report older than 60 days
  or undated; **no rate limit added**, still open); finding 4 was already
  fail-closed (`textGate` refuses a null opt-out read) and is now pinned by a
  test with a control. Backend suite 53 checks, UI suite 50, mutations red.
