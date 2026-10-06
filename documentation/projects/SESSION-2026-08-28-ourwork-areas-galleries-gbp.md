# Session 2026-08-28 — /our-work build-out: real towns, 3 new priced projects, GBP kit

Jo's ask (verbatim intent): keep building the /our-work galleries with price
ranges; kill the blanket "Greater Cincinnati area" on every job by checking
photo data or asking him per project; add more projects from Drive photos;
draft GMB (and maybe Facebook) posts with picked photos/posters.

Everything below is on branch `content/our-work-areas-galleries-2026-08-28`
(draft PR) — **nothing ships until Jo confirms the three gates in §4**.

## §1 — The location fix: every card now has a real town (EXIF-verified)

The published copies are EXIF-stripped, so a Drive agent hunted the ORIGINAL
files. Two durable discoveries:

- **Drive has a curated "NBD Photo Library"** (folder id
  `1j8eAvgQldNEeRARlXiJiXUXvZtEbEoT9`, uploaded 2026-08-23, 15 category
  subfolders). Files are renamed `REAL_<date>_DJI_<num>_<published-slug>.JPG`
  — full-size originals WITH EXIF, mapping 1:1 onto the published gallery.
  This is the provenance index for every legacy site photo; use it first.
- **This Drive MCP's `read_file_content` returns empty for images and
  `get_file_metadata` has no EXIF block.** Workaround: `download_file_content`
  (harness saves base64 JSON to a tool-result file) → local decode → view /
  EXIF-parse. Files >10MB still fail.

Seed-card towns as applied (EXIF GPS + corroborating docs; approximate towns
are my read of coordinates — Jo sanity-checks on the PR):

| Card (slug) | Was | Now | Evidence |
|---|---|---|---|
| brick-colonial-full-reroof | Greater Cincinnati | **Union, KY** | GPS 38.9575,-84.6691 (2025-04) |
| brick-two-story-drone-verified | Greater Cincinnati | **Milford, OH** | GPS 39.1732,-84.2580 (2025-09) |
| multi-section-complex-roof | Greater Cincinnati | **Sycamore Township, OH** | GPS 39.2506,-84.4131 (2025-10) |
| wind-damage-lifted-shingles | Greater Cincinnati | **Miamisburg, OH** | GPS 39.6281,-84.3111 (2024-09) |
| hail-impact-chalk-marked | Greater Cincinnati | **Mason, OH** | GPS 39.3508,-84.3848 (2025-09) |
| cul-de-sac-full-crew-tearoff | Greater Cincinnati | **Cincinnati, OH** (Kennedy Hts/Silverton) | GPS 39.1968,-84.4465 (2025-05, mlr 1 roll) |
| brick-underlayment-install | Greater Cincinnati | **Sycamore Township, OH** | same property as multi-section (spr 1 roll) |
| valley-flashing-detail | Greater Cincinnati | **Maineville, OH** | GPS 39.3763,-84.3327 (2024-05) |
| two-properties-one-day | Greater Cincinnati | **Evansville, IN** | GPS 38.0137,-87.5963 (2025-07) — out-of-market |
| apartment-complex-tearoff / -complete | Greater Cincinnati | **West Liberty, KY** | JKRC-era customer, 1121 W Main St; GPS 37.9021,-83.2773 (2023-11) |
| aframe-standing-seam-metal | Appalachian Region | **Gatlinburg, TN** | GPS 35.7353,-83.5163 (2026-03) |

Provenance nuance for Jo: several seeds are prior-brand jobs (MLR, SPR, JKRC
eras) and three are out-of-market (Evansville IN, West Liberty KY,
Gatlinburg TN). The old blanket label was factually wrong on those; if Jo
prefers a different treatment (drop a card / region label instead of town),
it's a one-line projects.json edit + restamp.

Bonus finds recorded by the agent: Customer BX job GPS 39.0697,-84.3610;
Customer V = [street address] (Anderson Twp); Customer BR = [street address];
`commercial-apartment-underlayment.jpg` original = `REAL_2023-11-25_DJI_0840`
(that photo is now the 2nd photo on the apartment-tearoff card).

## §2 — Three new featured projects (photos re-encoded, priced, staged)

All three cross-referenced against prod CRM (read-only) for town + value:

1. **cincinnati-oh-full-tearoff-reroof-2026** — Customer BR, [street address]
   , Cincinnati 45216, closed **$22,882** → published range $22,500–23,500.
   Hero + deck top-down from Build Day drone (2026-07-24), finish shot from
   Content/"Aluminum coating" (attribution inferred — confirm). Crew visible
   from above, no faces.
2. **blue-ash-oh-roof-vents-thermal-2026** — Customer BX, Blue Ash, closed
   **$3,145** → range $3,000–3,500. Drone after (7 new Roofivent units),
   HSFTOOLS thermal rafter-bay image (the differentiated content), skylight
   slope before-contrast. GPS on originals matched Blue Ash.
3. **cincinnati-oh-siding-repair-2026** — Customer BZ, 45244,
   completed 2026-07-30, **$400** same-day → range $300–500 + duration
   "Same day". Fills the previously-empty **siding-repair** strip. Photo
   attribution to Customer BZ inferred from the 12-photo report (confirm).

Pipeline as per [PUBLISH-PROJECT](../runbooks/PUBLISH-PROJECT.md): originals
downloaded from Drive → `prepare-project-images.mjs` (EXIF-stripped 800×600
JPG+WebP, auto-rotates EXIF orientation) → appended entries → restamp. Gates
at head of branch: build-projects ✓, catalog-cost-privacy 126 ✓,
check-image-privacy 147 imgs ✓, site-integrity 235 pages ✓,
marketing-polish 53 ✓. (`build-projects --check` red locally is the same
Windows CRLF false-fail as build-sitemap — content-identical restamp,
verified `git diff --quiet`; CI is the authority.)

## §3 — GBP/Facebook kit

[gbp-post-kit-2026-08-28](../marketing/gbp-post-kit-2026-08-28.md): 4 GBP
updates (designer re-roof job post, gutters-priced-honestly job post,
Central-KY announcement, storm-season check) + 2 longer Facebook variants +
4 branded 1200×1200 posters (`gbp-kit-2026-08-28/poster-*.jpg`, generated
with sharp from the already-clean site copies; regenerate with the session's
make-poster script pattern if needed). Square = also Instagram-ready
(@nbdhomesolutions). Posting itself stays Jo's click (or a driven-browser
session with Jo watching). Reminder embedded: add the six Central-KY towns
to the GBP service area before the Lexington post goes up (standing queue
item from 08-25).

## §4 — The three gates Jo must confirm before merge (asked in-session)

1. **Consent**: the three new projects show real (unidentified) houses of
   named customers — Customer BR, Customer BX, Customer BZ. `consentOnFile: true` is
   staged but it is JO's attestation, not the session's. Confirm per job or
   the entry comes out before merge.
2. **Towns**: the table in §1, esp. the three out-of-market reveals and the
   two "my read of GPS" neighborhood calls (Sycamore Twp, Miamisburg).
3. **Price ranges**: $22.5–23.5k / $3–3.5k / $300–500 (from CRM jobValue,
   rounded per runbook). Retail only — no cost figures anywhere.

## §5 — Open leads for future sessions (from the Drive survey)

- **Soft Wash content landed**: 16 HEICs in INTERNAL/Content/Soft Wash
  (IMG_3283–3298, Aug 17). Needs `heic-convert` + Jo's job ID → soft-wash
  feature or /services imagery.
- **Walgreens commercial repair** (Content/"Commercial repair", 10+ JPGs):
  strong commercial-credibility set but prominent third-party branding and
  unknown attribution — Jo's call.
- **"New Build" set** (8 JPGs): new-construction roof w/ Schumacher Homes
  signage — builder-brand visibility, Jo's call.
- **Customer G** (Loveland): gorgeous July drone survey on file; job is
  a 3-tier proposal not yet booked — the moment it closes it's a feature.
- **A-frame card flag**: the live Gatlinburg photo has two recognizable
  people on the deck (one mid-workout). Library companion
  `REAL_2026-03-06_DJI_0680_mountain-cabins-misty` could swap in if Jo wants
  a people-free frame.
- Jennifer Customer DR (Loveland, $17.5k) blocked on the denied Hartford
  claim — not a "completed job" candidate; her folder is inspection-era.
- Customer BR glamour "after" (finished Timberline beauty shot) wasn't in
  reachable files (>10MB originals); his card ships during→deck→coating.
  Swap-in candidate if Jo exports one from his phone/CRM.

## Facts that cost time (don't re-derive)

- CRM `photos` collection has **0 docs for the Customer BR lead** — photo-report
  images aren't keyed by leadId there.
- `estimates` root collection is only 14 docs (mostly unnamed); lead money
  lives in `leads.jobValue` / `estValue`.
- Drive pageToken re-serves pages; folder listings can return `{}` once and
  content on retry — treat empty as "retry once" before concluding empty.
