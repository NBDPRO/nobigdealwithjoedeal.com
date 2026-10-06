# Next session — brief as of 2026-08-31 (power session close)

> Read this first. Full session record:
> [SESSION-2026-08-31-sweep-rocks-and-four-cards](SESSION-2026-08-31-sweep-rocks-and-four-cards.md).

## State of the world

- **/our-work: 44 live projects, 37 priced** (was 39/34; the same-day
  queue sweep added Customer EE — see the session note's Addendum). New: Kalb
  (Loveland, siding-repair — the first siding card since the strip gap
  analysis), Wilson (Loveland, storm/repair), Customer BP (Loveland,
  **first flat-roof/EPDM card**), By Golly's (Milford, commercial,
  $73–74k, business named with Jo's approval).
- **Every PR from this session is merged**: #1301/#1302 (deps), #1303
  (Rock 2 telemetry), #1304 (Rock 4 Tranche 3 plan), #1305 (four cards).
  Verify the #1305 deploy went green and the four slugs render live if
  that wasn't confirmed before close.
- The weekly agent sweep is DONE for the week of 08-31 (all gates green,
  no rot, dependabot cleared).

## The lanes, in priority order

1. **Rock 2 — the 30-day clock is finally real.** Deprecation warns now
   reach Sentry as events (#1303, deployed 2026-08-31). The wizard-deletion
   gate = zero `startNewEstimateOriginal` warns in Sentry → Issues through
   ~2026-09-30. Jo decided same-day (session-note Addendum): pre-V2 docs
   stay READ-ONLY (the deletion PR keeps a minimal viewer), and the
   `dashboard.legacy.html` snapshot was refreshed 2026-08-31. Weekly
   check is one Sentry search — nothing else blocks the deletion now.
2. **Rock 4 — execute the Tranche 3 plan**:
   [globals-tranche3-plan](../../docs/dev/globals-tranche3-plan.md).
   Start with T3-0 (zone-draw shim unwind at `maps.js:464-468` +
   `damagNearMe` dedup), then T3-A slice 1 (dashboard-actions.js's 33
   mechanically-safe names). Census re-runs via `scripts/globals-xref.js`.
3. ~~Posting~~ **DONE 2026-08-31 — the whole 08-28 kit shipped, 6 of 6.**
   All four GBP posts and both Facebook variants are live (the FB page's
   first posts ever), and **all 12 previously-unreplied Google reviews now
   have owner replies**. The service-area prerequisite was handled by
   swapping Hyde Park → Lexington at the 20-area cap.
   **Also done:** Lexington service-area edit confirmed approved by
   Google, and the **photo gallery refreshed with 12 curated images**
   (first in 147 days). Two website card heroes that the curation pass
   graded actively harmful were swapped in PR #1313.
   **Still worth reading** in [POSTING-LOG](../marketing/POSTING-LOG.md):
   (a) the review-pattern note — the 7–18-week cluster has hallmarks of
   purchased reviews (one describes a *plumbing* job; one account is an
   Indian engineering college); Jo says they are genuine and the replies
   went out on his instruction, worded to claim nothing. Recorded because
   a fake-review purge can suspend an entire profile. (b) the seven
   photo-gap items — **photos out-reach posts on this profile** (one
   gallery image is past 1,000 views), and the biggest miss is that no
   photo shows a human face. Note the constraint before assigning any
   "photograph your truck" task: **Jo drives an unbranded work wagon and
   has no magnets.**
4. ~~Housekeeping: PR #1299~~ DONE — it auto-merged 08-31 after its
   branch caught up with main; its vault-index CI gate is live.

## Held content (Jo's calls, no agent action)

- ~~Customer EE~~ PUBLISHED 08-31, manufacturer unnamed (Jo's call) — card
  `loveland-oh-shingle-samples-2026`, $300–500.
- ~~Sharon Batavia gutter frames~~ SHIPPED 08-31 — two frames into the
  gutter page's failing-gutters grid (`gutter-condition-closeups-1/2`);
  the wide frames were refused for backyard exposure.
- **Siding-replacement strip is still empty and unfillable from Drive**
  (settled 08-28 — do not re-run the search). Live path: the Customer EZ
  proposal (NBD-2026-0811-XXXX Option B, $4,600) — if Jo closes it,
  document as it happens.

## Watch-outs

- ~~Scratchpad evaporation~~ HANDLED 08-31 — everything preserved to
  `C:\Users\jonat\NBD-photo-staging-2026-08-31` (1.7 GB, README inside;
  EXIF-bearing originals — never commit or publish directly).
- Wilson town doctrine: when a job folder has no town, check the ERA'S
  CUSTOMER BOOK in Drive (street → ZIP → mailing town). Details in the
  session note's techniques section.
