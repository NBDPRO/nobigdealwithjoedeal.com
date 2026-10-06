# NEXT SESSION — 2026-08-25

Handoff from the 2026-08-25 session (branch `claude/website-audit-blog-strategy-y2ze1c`).
Three lanes ran and all closed: a site-wide deep-dive audit, two new blog posts
born from another blog-sourced homeowner call, and — after Jo confirmed he told
that caller "yes, I service Lexington" and the caller committed his business —
the **Central Kentucky territory expansion** (Lexington flagship + 5-city ring;
Part 2 of the [session note](SESSION-2026-08-25-lexington-call-posts.md)).

## What shipped

- **Two Reader Questions posts** from the Lexington, KY call (same
  Duration-vs-HailGuard question as the 08-17 Colorado Springs caller — the blog is
  now demonstrably generating informed phone calls):
  `/blog/is-the-class-4-upgrade-worth-it` (his State Farm agent quoted **12% off**
  for a Class 4 roof; includes the cosmetic-damage-exclusion caveat, new to the site)
  and `/blog/why-wont-roofing-suppliers-sell-to-homeowners` (he tried to buy
  HailGuard himself; SRS/QXO don't carry it, ABC is account-only — first post on
  supplier-channel reality). Fact-sourcing decisions + exact wiring:
  [SESSION-2026-08-25-lexington-call-posts](SESSION-2026-08-25-lexington-call-posts.md).
- **Deep-dive audit, site is clean**: all gates green, 231-page static passes found
  zero broken refs / JSON-LD errors / placeholder text; rendered sweep 229 pages × 2
  viewports, zero style findings. Three metadata nits fixed (careers + tarping meta
  descriptions, partners title); ten flags confirmed deliberate. Full trail:
  [SITE-DEEP-DIVE-2026-08-25](../audit/SITE-DEEP-DIVE-2026-08-25.md).
- Stale-doc correction: WEEKLY_CADENCE "3 blog drafts" → 2 (financing post published
  08-17).

## Jo's queue (nothing blocking)

1. ~~Post A names State Farm — keep or de-name?~~ **RESOLVED 2026-08-25**: Jo
   confirmed the name stays. No action for anyone; rationale recorded in the
   session note.
2. **Close the Lexington caller** — the site now backs up the "yes" you gave him:
   text him `/areas/lexington-ky` + both posts. His job is the first entry on the
   Lexington job list.
3. **Update your Google Business Profile service area** to add Lexington,
   Georgetown, Nicholasville, Winchester, Richmond, Versailles — the site claims
   the territory now, GBP should match (also added to WEEKLY_CADENCE's one-off
   queue).
4. **Before the first Lexington job**: the paperwork research is done —
   [LEXINGTON-CONTRACTOR-SETUP](../runbooks/LEXINGTON-CONTRACTOR-SETUP.md)
   (2026-08-26). Short version: no KY state roofing license; LFUCG requires
   contractor registration (occupational license + COI, workers-comp-exempt
   path for solo operators). What's left is yours: one call to Building
   Inspection at (859) 258-3770 to settle the conflicting reroof-permit
   answers, then the registration steps in the runbook's checklist.
5. **Finish the Cal.com→CRM wiring** (same evening: the whole Cal.com account was
   audited and rebuilt — [CALCOM-INTEGRATION-2026-08-25](../audit/CALCOM-INTEGRATION-2026-08-25.md)):
   (a) ~~set `CALCOM_WEBHOOK_SECRET` + redeploy~~ **DONE — verified live
   2026-08-26 03:41Z** (unsigned probe → 400 "Missing signature", HMAC-signed
   probe → 200 ok). **Correction 2026-08-28: "bookings now reach the CRM"
   was wrong.** They reached `appointments/{bookingId}`, which the Pipeline
   never queries; any attendee not already a lead was dropped silently. A
   signature probe proves the door opens, not that a lead lands — assert the
   outcome, not the precondition. Cold bookings became CRM leads only with
   #1288 (`f44f346a`, 2026-08-28); see
   [SESSION-2026-08-28-calcom-lead-drop](SESSION-2026-08-28-calcom-lead-drop.md);
   (b) ~~NBD Pro → Settings → Profile → Cal.com username `nobigdeal`~~
   **DONE 2026-08-28.** The old wording was wrong twice over: unset, the
   booking is *dropped* (`no matching rep — booking dropped`, HTTP 200), not
   "arrived but unattached"; and setting it was necessary but **not**
   sufficient — cold bookings still needed #1288 to become CRM leads;
   (c) optional: restrict the "Central Kentucky days" schedule to real trip days;
   (d) **revoke the session API key** if it has no expiry.
6. Carried from 08-20 if not yet done: **send Scott the CURRENT Oaks zip** (7-Zip,
   not PowerShell Compress-Archive).
7. Still yours from the drafts pipeline: the 2 remaining blog drafts need your
   `JO:` inputs (photos / report screenshots) — [drafts README](../drafts/README.md).
8. **Clear the address-audit gate** (~2 min in NBD Pro): complete or retire the
   4 failing leads (Customer AT, Customer X, Customer EW, AJ — all $0), and add the
   missing state on Nick/Gabby Customer BN ($23,600 — one field from mailable).
   IDs + detail:
   [CRM-ADDRESS-INTEGRITY-2026-08-18](../audit/CRM-ADDRESS-INTEGRITY-2026-08-18.md)
   §2026-08-26.

## For the next engineering session

- **Remote-sandbox Playwright recipe** (needed for qc-render-sweep there): the
  container blocks `playwright install`; symlink-shim the preinstalled Chromium
  into a writable `PLAYWRIGHT_BROWSERS_PATH` — details in the audit note's Method §3.
  Also: `/pro/login` + `/pro/register` will time out in that sandbox (they block on
  external Google Fonts CSS) — environment noise, already triaged.
- **Observation filed, decision pending**: `/pro` auth pages still load Google
  Fonts synchronously while the homeowner surface self-hosts — for a future
  Pro-perf session, not a cleanup fix.
- **Blog series runway** (when calls supply facts): Duration FLEX vs HailGuard
  head-to-head; "what a Class 4 certificate looks like" photo post (needs a real
  certificate through the EXIF pipeline).
- **Central KY phase 2** (after Lexington produces jobs): service clusters for the
  5 ring cities (their area pages exist; each city needs the outer-ring trio the
  way Lexington got one), and the first Lexington featured project on /our-work
  the moment a job closes — a real local job photo beats every word on those
  pages. Decisions log is in the session note's Part 2 (incl. why new KY pages
  omit the JSON-LD address block).
- **The scheduled "Lead address audit" workflow is red on every daily fire since
  2026-08-20** — diagnosed 2026-08-26: NOT a missing secret (an unset secret
  skips green); the gate is *correctly* failing on the same 4 records it
  inventoried the day it shipped. Now Jo's queue item 8 above —
  [CRM-ADDRESS-INTEGRITY-2026-08-18](../audit/CRM-ADDRESS-INTEGRITY-2026-08-18.md)
  §2026-08-26 has record IDs and the trendline (50 street-less rows at
  $12,476, Customer BN $23,600 missing one field).
- **Main's Firebase-deploy run for the #1276 merge shows red but the deploy
  landed** (run 32925767669): one GCP "Deadline Exceeded" polling
  `onAiDraftApproved`'s update in chunk 2/3, and the wholesale guard misread
  that failure shape as "nothing deployed" while 166/167 functions verifiably
  updated (calcomWebhook among them — probe-verified) and hosting shipped
  (Lexington booking links serving). No site action needed; `onAiDraftApproved`
  keeps serving its previous revision of identical code and re-deploys on the
  next functions-touching merge. Guard-regex fix **shipped the same night**
  (mode 1b — [DEPLOY-FALSE-GREEN-MODES-2026-08-17](../audit/DEPLOY-FALSE-GREEN-MODES-2026-08-17.md)
  §2026-08-26).
- Standing rules from 08-20 still stand: verify hosting behavior by following
  redirects on a preview channel, never by reading config; assert the outcome, not
  the precondition.
