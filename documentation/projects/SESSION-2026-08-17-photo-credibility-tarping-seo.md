# SESSION 2026-08-17 — Photo credibility sweep + emergency-tarping SEO

Second lane of the day (same PR #1227 branch as the financing wave). Jo's ask:
"look through all my photos for soft wash and gutter guard / screens to upload
to site for credibility. Maybe even emergency tarping to add it to the SEO
power play list."

## Photo sources — what was actually searched

| Source | Result |
|---|---|
| CRM photo hub (Firebase Storage) | **Unreachable from the web sandbox** — no prod credentials here. Photos came from Drive instead. |
| Drive `COMPANIES/NBD/CUSTOMERS/*` | Mostly **empty scaffolding** (Photos/Docs/Reports subfolders created 2026-08-15 with nothing in them — incl. Gary's and Krista Taft's). A few hold real HEICs (Customer CX ×27, Customer G ×11, Pat S ×3) — unexamined this session, see follow-ups. |
| Drive "Gutters" folder + loose files | 5 HEICs = hail-chalk on downspouts (storm documentation, not guards). 3 loose damaged-gutter JPEGs = **published** (see below). |
| SD-card backup (synced 2026-08-17): DCIM/100MEDIA | 627 DJI photos (DJI_0362–0999), agent-sampled ~54 frames. Job documentation: re-roofs, chalk-marked hail inspections, gutter conditions, algae'd 3-tabs. **No roof tarps** (only ground-protection tarps at tear-offs). |
| SD backup: 101MEDIA | 959 DJI photos, sampled ~28. **Found the tarp**: DJI_0306–0308, cap-nailed blue tarp at a gable base. Also box-gutter reline, failing perforated covers (DJI_0718). |
| SD backup: 107MEDIA | 96 DJI photos, sampled ~18. One flight around a brick house with **expanded-metal gutter screens** along every run — the guards "after" imagery. |
| SD backup: Pictures / Photo | Empty / `.nomedia`. |
| Gmail | **Zero soft-wash jobs in the record** (no proposals, no emails). Gutter jobs confirmed via Drive proposals instead. |

**Provenance rules applied** (these are the precedent for future photo pulls):

- `tarp-covered-roof.avif` in Drive is in the **GAF folder = manufacturer
  marketing asset — never publish as NBD work.**
- Full-house aerials of **prospect** properties (no consent) stay off the
  site. Only anonymous crops ship: roof planes, gutter-line details.
- Condition photos are captioned as **inspection documentation, never job
  claims**. No completed soft-wash job exists in any record — nothing was
  fabricated; the algae drone crop is captioned as what soft wash *treats*.
- The tarp caption avoids claiming the tarp is Jo's own install ("what
  installed-right looks like from my drone") — **Jo: if DJI_0306 is your
  tarp, strengthen the caption to first person at review.**

## What shipped (commits `a474608`, `3d72c0f`, + this one)

1. **`/services/emergency-roof-tarping` — NEW hub** (the "power play" page):
   mitigation-duty/claim-documentation framing, tarp→claim→roof steps, the
   consented tarped→replaced pair from /our-work, cap-nailed tarp close-up
   (DJI_0306 crop), FAQPage schema, links from storm-damage + roof-repair,
   sitemap (+1 = 203), llms.txt. Keyword targets logged in
   [rush-week addendum](../marketing/rush-week-2026-08.md).
2. **`/services/gutter-replacement` — "Guards & Screens" section** (`#guards`):
   3 failure photos (dead screen, leaf-packed run, rotted fascia) + the
   installed-screens after-shot (DJI_0048 crop) + run-by-run quoting
   philosophy lifted from the real Gary/Tate proposals.
3. **`/services/roof-cleaning-soft-wash` — first real photo**: DJI_0586
   cropped to roof planes; north-plane algae streaks vs clean south plane,
   captioned as the condition soft wash treats.
4. All images through `prepare-project-images.mjs` (EXIF/GPS stripped);
   `check-image-privacy` clean at every step.

## Business facts learned (for future featured projects)

- **Customer FV, Cincinnati 45244** (proposal 2026-07-09, $2,450 retail):
  80 LF 5" seamless, fascia included, **new screens on the 45 LF run for tree
  coverage**, reuse attempt on 35 LF. Completion unconfirmed — no receipt in
  Drive. When Jo confirms completion + consent, this is the anchor
  **featured project** for a future gutter-guards page.
- **Customer AH, Cincinnati 45215** (proposal 2026-07-04, $4,800): box-gutter
  → 6" seamless conversion; Leaf Protection add-on +$1,170 across 130 LF.
- Tarping history: JK Roofing invoice (2023) shows commercial emergency
  tarping billed to a carrier — legitimate experience, pre-NBD, not used on
  the site.

## Follow-ups

- ~~(a) photo ownership / (b) tarp attribution~~ — **CONFIRMED by Jo in-session
  2026-08-17: "Every photo is mine."** Tarp + guards captions upgraded to
  first person on the strength of that attestation.
- **Jo at PR review**: confirm Gary's job completed — then a session can
  build the featured project + a dedicated gutter-guards page (next
  power-play candidate, per rush-week addendum).
- Unexamined: Customer CX (27), Customer G (11), Pat S (3) customer
  HEICs — **HEIC decode needs `npm i heic-convert`** (repo sharp lacks HEVC;
  system libheif+libde265 exists). Also two 101MEDIA blocks (DJI_0685–0709,
  0737–0809, ~20MB 48MP frames) exceeded the Drive MCP download cap.
- First documented soft-wash job → full before/after treatment on the
  soft-wash page (currently condition-only, by design).
- City-clone tarping pages: only after the hub shows GSC impressions.
