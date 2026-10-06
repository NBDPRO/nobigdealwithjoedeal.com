# Session 2026-08-31 — weekly sweep, two rocks advanced, four cards published

> Power session with Jo live. Five PRs merged to main: #1301 + #1302
> (dependabot), #1303 (Rock 2 telemetry fix), #1304 (Rock 4 Tranche 3
> plan), #1305 (four /our-work cards, 39 → 43). Two multi-agent
> verification workflows ran (6 agents total); both caught things a
> single pass had missed.

## Weekly sweep (Monday cadence) — all green

All 8 local gates clean at baseline. Main CI quiet since 08-26; the two
visible reds were both already-diagnosed (the #1276 deploy transient fixed
by #1278, and the Lead address audit correctly failing on Jo's 4 records).
Dependabot #1301 (44 non-major functions bumps) and #1302 (protobufjs)
merged 19/19 green; #1301's functions deploy completed success. Stray
`nul` file removed from the repo root.

## Rock 2 — the wizard-deletion gate was UNOBSERVABLE; fixed (#1303)

The standing gate ("zero `[estimates.js DEPRECATED]` warns in the prod
log") could never fire: Sentry has no console-capture integration, so a
solo `console.warn` only ever rode along as a breadcrumb on unrelated
*error* events, and no other client log sink exists (`/cspReport` is the
only monitoring HTTP endpoint). "Zero warns observed" was vacuous truth.

Fix: `_warnDeprecatedOnce` now also ships `Sentry.captureMessage(msg,
'warning')` — once per page load per function, only when a deprecated path
runs. **The 30-day zero-warn clock starts at #1303's deploy date
(2026-08-31).** Where to look: Sentry → Issues → `estimates.js
DEPRECATED`. Full mechanics + a reachability nuance (the chooser is also
reachable via estimate-entry.js's V2-missing fallback, so a warn burst
during a deploy window is the fallback, not real usage):
[estimate-engines-audit §2026-08-31](../../docs/dev/estimate-engines-audit.md).

Still needed from Jo before final deletion (unanswered this session):
pre-V2 stored docs — migrate vs read-only; and whether to refresh the
`dashboard.legacy.html` rollback snapshot.

## Rock 4 — Tranche 3 dependency-ordered plan written (#1304)

[globals-tranche3-plan](../../docs/dev/globals-tranche3-plan.md), census
reproducible via the committed `scripts/globals-xref.js`. Headline: the
July "~515 middle band" estimate conflated xref rows with names — the real
2–5-consumer band is **131 names**. 827 assigned globals total: 454
zero-external (277 mechanically safe), 176 one-consumer (6 clean
file-edges), 66 spine — the spine is mostly keep-as-API (Firebase compat
re-exports, `_leads`/`_user` state, `goTo`, house singletons), explicitly
listed so nobody re-audits it. Slice order: T3-0 (shim-blocked residual
first) → T3-A mechanical → T3-B delegate-then-scope → T3-C edges → T3-D
NBD-prefixed APIs → T3-E docs close.

## Four cards published (#1305) — /our-work 39 → 43, 36 priced

| Card | Town | Price | The story |
|---|---|---|---|
| Kalb siding peak reseal | Loveland | unpriced | The 2026-07-29 "Customer BZ" frames — Jo named Terri Kalb; EXIF matched the known 13:39–13:47 visit; no invoice exists in Drive or CRM (searched by name + variants), unpriced by evidence not oversight |
| Wilson wind repair 2023 | **Loveland** | unpriced | Jo guessed "amelia?" — the 2023 JKRC customer book (Drive, Scott's sheet) has him at Apache Trail, which is Miami Twp East / ZIP 45140 = Loveland mailing. Published on document + map evidence, Jo signed off |
| Customer BP EPDM inspection | Loveland | $100–200 | First flat-roof/EPDM card in the gallery. 5 detail frames picked from ~137 raw against the 13-photo report captions; ponding frame needed a 90° rotation (EXIF orientation stripped) |
| By Golly's commercial rebuild | Milford | $73,000–74,000 | Jo cleared the courtesy call AND naming. Combined retail $73,481.40 = $64,011.90 RCV + the Oct tarp $2,086.50 + re-issued repair $7,383.00 (Jo confirmed same job). Only 2 photos exist for the whole job — both carry baked-in claim-annotation circles, no clean originals anywhere (verified exhaustively 08-28); frame 2 cropped top 10% for a partial crew face |

## Techniques proven this session (reusable)

- **Company customer books resolve towns that job folders can't.** Wilson's
  "no town in ANY document" was true of his JOB folder — but the era's
  customer spreadsheet ("2023 JK Roofing Customers (Scott's only)",
  Drive 17jIeEuuNx…) carries a street per customer, and street → ZIP →
  mailing town finishes the job. The neighbor-township trap is real: Jo's
  own memory said Amelia; the street said Loveland. Same doctrine as
  EXIF-beats-assumption, extended to paperwork.
- **Adversarial re-verify catches what a first QA missed, even a good
  one.** The 08-28 Wilson review was careful and still missed a second
  partial crew face (during-shingle-lift-tools). A fresh agent prompted to
  verify-the-claims found it in one pass. Photo sets touching faces get a
  second independent look before publish, always.
- **Every wide angle on a low flat roof leaks the neighbors.** All three
  refused Customer BP frames failed the same way (adjacent houses, yard
  contents, streetscape over the parapet). Flat-roof cards should plan on
  detail shots only.
- **The deprecation-gate lesson generalizes**: before trusting any
  "zero events observed" gate, verify the event CAN reach the sink.
  Absence of evidence needs a live channel to mean anything.

## Jo decisions recorded this session

Kalb = Terri Kalb, Loveland · Customer BP = Loveland · Wilson = Loveland
(sign-off on doc evidence over his Amelia guess) · By Golly's courtesy
call cleared, naming approved, Oct invoices same job · merge #1305.

## Still open (all carried to the 08-31 handoff)

~~GBP/Facebook posting session~~ (DONE — see Addendum 2) · Rock 2
side-decisions (above) · Customer EE card (TAMKO brand-sensitivity, Jo's
call) · draft PR #1299 (INDEX handoff consolidation — needs rebase over
this session's INDEX edit; finish or close) · Sharon Batavia gutter
frames for the thin gutter page (generic illustration only, never
completion-dated).

## Addendum — same-day queue sweep (Jo: "take care of everything here")

Jo answered the four held calls in-session and the sweep executed:

- **Customer EE → PUBLISHED, manufacturer unnamed** (Jo's pick): 44th card,
  `loveland-oh-shingle-samples-2026`, $300–500, roof-inspection. The
  second-look QA caught a background pool + the home's entry ensemble in
  the staging frame (top-30% crop applied) — and flagged that the
  filenames themselves leaked the surname and manufacturer (fixed by the
  re-slug pipeline, a check worth keeping on every future set).
- **Batavia gutter frames → 2 shipped** into the gutter page's "What
  Failing Gutters Look Like" grid as `gutter-condition-closeups-1/2`
  (education imagery, no town, no dates). The two WIDE frames were
  refused — both mapped the prospect's private backyard (covered pool,
  deck, pergola) — same flat/low-angle-leaks-the-neighbors pattern as
  Customer BP; the packed-run frame shipped as a tight 4:3 window instead,
  and the "clear run" frame died in cropping (no story left).
- **Rock 2 pre-V2 docs → READ-ONLY** (no migration) — recorded in
  [estimate-engines-audit item 3](../../docs/dev/estimate-engines-audit.md);
  the deletion PR must keep a minimal viewer for `builder !== 'v2'` docs.
- **Legacy rollback snapshot refreshed** (July 4 → Aug 31 dashboard) per
  the documented `cp` convention; post-decomposition copy is inline-free.
- **PR #1299 self-resolved** — it auto-merged after its branch caught up
  with main; its vault-index CI gate is live (this addendum passes it).
  One stale "Current handoffs (two live lanes)" line it missed was
  demoted here.
- **Photo evidence preserved off the temp drive**: 1.7 GB / 682 files →
  `C:\Users\jonat\NBD-photo-staging-2026-08-31` (EXIF-bearing originals;
  never commit or publish directly).

/our-work ends the day at **44 live projects, 37 priced**.

## Addendum 2 — the marketing lane ran too (same day)

The "still open" list above was written mid-session and is now stale. The
posting session happened, and then some. Full detail in
[POSTING-LOG](../marketing/POSTING-LOG.md); the short version:

- **The whole 08-28 kit shipped, 6 of 6** — all four GBP posts and both
  Facebook variants (the FB page's first posts ever), with three copy
  edits Jo approved after an adversarial review (a competitor-bashing
  line removed, a price anchored to its house, an absolute softened).
- **GBP service area**: at the 20-area hard cap, so Hyde Park was swapped
  out for Lexington, KY. Google has since approved it.
- **All 12 unreplied Google reviews answered**, deliberately claim-free.
  A review-authenticity concern was raised and Jo's answer is recorded.
- **Photo gallery refreshed** — 12 curated images, first in 147 days.
  Photos turn out to be the highest-reach surface on the profile (one is
  past 1,000 views), which reorders the priorities for next time.
- **Two website card heroes swapped** (#1313) after the photo curation
  graded them actively harmful — one was bare decking with a hole in it.

Nine PRs merged today: #1301–#1305, #1310–#1314. **Only lane still open
is Rock 4 Tranche 3 execution.**
