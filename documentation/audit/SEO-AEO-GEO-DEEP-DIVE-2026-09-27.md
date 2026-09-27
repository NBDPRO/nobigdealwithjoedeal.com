# SEO / AEO / GEO deep dive — 2026-09-27

**Asked by Jo:** "how we might rank or score higher in SEO, AEO, GEO and
more … crank out efficiency and maximize visibility in every corner", plus a
Facebook ad for a "CTR Non-Manipulation" service (getmeseo.com, $199/mo for
5 keywords, geo-grid screenshots of "roof repair" around Eden Prairie MN).

**Method:** three parallel read-only lanes — (1) vault ledger of every prior
SEO/local/AEO note, (2) a scripted crawl of all 297 public HTML files under
`docs/` (titles, JSON-LD graph, FAQ-vs-visible text, link graph, town-page
5-gram Jaccard overlap, image bytes), (3) live web research (directories,
SERPs for six money queries, AI-style prompts, live headers). Headline claims
were re-verified by hand before writing this note (the duplicate blog bodies,
the review-nudge cron being enabled). No site files were changed in this PR.

Prior work this builds on (don't redo it):
[local-seo-playbook-2026-07](../marketing/local-seo-playbook-2026-07.md),
[citation-kit-2026-07](../marketing/citation-kit-2026-07.md),
[seo-hardening-2026-07](../qa/seo-hardening-2026-07/REVISED-PLAN.md),
[SESSION-2026-08-17-backlinks-aeo-rush](../projects/SESSION-2026-08-17-backlinks-aeo-rush.md),
[SITE-DEEP-DIVE-2026-08-25](SITE-DEEP-DIVE-2026-08-25.md),
[NEXT_SESSION-2026-09-24](../projects/NEXT_SESSION-2026-09-24.md) §3/§6.

---

## 1. The CTR ad — verdict: don't buy it

"Non-manipulation" is paid human clicks on a Google Business Profile under a
friendlier name. Google's Search spam policy names only *machine-generated*
traffic, which is the loophole the vendor leans on — but the asset being
pumped is the GBP, and GBP enforces a **fake-engagement** policy; owners
report restrictions/suspensions under exactly that label. The screenshots
are one keyword, two weeks, in Minnesota, and the author says he is hiding
the other scans; nothing shows calls. Gains last only as long as the spend,
and a suspension removes NBD from the map pack entirely — for a one-owner
business with no other lead engine that is the worst available trade.

Sources: [Google spam policies](https://developers.google.com/search/docs/essentials/spam-policies),
[GBP community — restricted for "Fake Engagement"](https://support.google.com/business/thread/455627333/business-profile-restricted-for-%E2%80%9Cfake-engagement%E2%80%9D-despite-no-review-requests-or-campaigns?hl=en),
[Map Labs on CTR manipulation](https://maplabs.com/click-through-rate-manipulation/).

The legitimate levers that move the same geo-grid are below: review
velocity, GBP completeness, geo-relevant photos, town pages with real local
substance, consistent citations.

---

## 2. Where NBD actually stands (verified 2026-09-27)

**On-site is technically clean.** 292 indexable pages; 0 duplicate
titles/descriptions, 0 broken internal links, 0 JSON-LD parse errors,
self-canonicals everywhere, sitemap (291 URLs) matches the indexable set
exactly, no missing alt text, robots.txt welcomes every AI crawler, llms.txt
live. The remaining problems are *entity*, *uniqueness* and *authority* —
not hygiene.

**Off-site is nearly empty.** GBP verified, 5.0 ★ / 29 reviews (per
`/api/google-reviews`, 09-20). Yelp 5.0 / 2 (unclaimed). BBB: confirmed no
listing. Not visible anywhere: Angi, HomeAdvisor, Nextdoor, Houzz, Apple
Maps, LinkedIn, YouTube, chambers, TAMKO locator. Backlinks ≈ zero (08-17
baseline, nothing earned since recorded). No Reddit / forum / news mention of
NBD or Joe. Competitors: Rooftop Relief 125+ Google reviews + BBB A+;
Mr. Roof Cincinnati hundreds across platforms.

**SERP snapshot (six money queries).** NBD ranks only for the hail-claim
query (~#7, `/services/hail-damage-cincinnati-oh`) and is named third in an
AI-style answer to "who should I call for hail damage roof claim
Cincinnati". Absent from "roof replacement Mason OH", "roofer Loveland
Ohio", "roof repair Cincinnati", "roofer Florence KY", "roof replacement cost
Cincinnati 2026". **Pattern: directory pages (GAF locator, Angi, BBB, Yelp,
HomeAdvisor) take 3–5 of the top slots on every "roofer + city" query, and
those same directories are what AI answers cite.** Being *on* those
directories is the fastest route into both.

**Brand search leaks the repo.** Searching "nobigdealwithjoedeal" returns
~10 GitHub PRs (session handoffs) and no business profiles. See
[PUBLIC-REPO-COPY-POSTURE-2026-08-31](PUBLIC-REPO-COPY-POSTURE-2026-08-31.md).

---

## 3. Ranked plan

### P0 — on-site defects (Claude can ship; no Jo input needed except §P0.1 facts)

1. **Two blog posts serve the wrong article.**
   `docs/blog/can-i-keep-insurance-check-not-fix-roof.html` and
   `docs/blog/what-to-expect-roof-insurance-adjuster-visit.html` carry the
   body of `does-homeowner-insurance-cover-hail-damage-ohio.html` (identical
   H2s, ~95% text overlap) under their own titles, and have since their first
   commit. Their FAQPage schema asks questions the visible page never
   answers. Both are high-intent insurance queries — NBD's one proven
   ranking lane. Fix: write the real bodies (Joe's facts on mortgage-company
   endorsement / ACV-RCV holdback / adjuster-meeting walkthrough), restamp.
   Interim: noindex or 301 to the hail post.
2. **One business entity, not 150.** The homepage `RoofingContractor` has no
   `@id`; 152 pages each declare their own mini-business with no `@id`; 106
   nodes reference `/#org`, which is only defined (thinly) on `/our-work`.
   Put `"@id":"https://nobigdealwithjoedeal.com/#org"` on the full homepage
   node and reduce every other copy to `{"@id": ".../#org"}` (Service
   `provider`, BlogPosting `publisher`). Same for Joe: one `/#joe` Person
   (`worksFor #org`, `hasCredential` GAF 1162011 / TAMKO 181382, `url
   /about`, `sameAs`) referenced as every post's `author`. This is the
   single biggest AEO/GEO lever — engines build one entity from consistent
   IDs. Add a CI assertion (see §5) so it can't regress.
3. **FAQ schema must match visible text.** 84 of 753 FAQ questions (25
   pages: 23 posts, `/partners`, `/services/gaf-timberline`,
   `/services/tamko-storm-series`) appear nowhere on the page. Render a
   visible "Quick answers" block from the same data.
4. **llms.txt drift.** Lists 31 towns vs 43 area pages (missing Bethel,
   Franklin, Madeira, Miamisburg, Montgomery, New Richmond, Newport KY,
   Newtown, Norwood, Sharonville, Sycamore Township, Union KY); Key Pages
   omits gutter-cleaning, interior-repair, roof-care-plan; no case studies;
   no `llms-full.txt`. Generate it from the sitemap + page metadata and gate
   it, rather than hand-editing again.

### P1 — content that wins local + AI answers

5. **De-duplicate town pages (doorway risk).** 5-gram Jaccard with town
   names masked: `/areas/*` mean 0.45, 162 of 903 pairs > 0.5, worst 0.73
   (erlanger-ky vs fort-mitchell-ky); `roof-inspection-<town>` mean 0.65;
   `siding-replacement-<town>` 0.50. (Hail/storm/replacement/repair town
   pages are fine at ~0.2 — use them as the model.) Each town gets: jobs
   done there (from `projects.json`), local hail/storm history, housing
   stock, permit notes, 4–6 town-specific FAQs **with** FAQPage schema (only
   2 of 43 area pages have it vs 145 of 149 service pages).
6. **Wire the case studies in.** 53 `/our-work/*` pages have 1–2 inbound
   links and a 133-word median. Service-page project strips link to
   `/our-work#svc-…` anchors, not the case pages; area pages don't link
   their town's jobs. Fix in `scripts/build-projects.mjs`, and grow each
   case to 250+ words (problem → scope → timeline → outcome, with photos).
   Real local jobs are the strongest non-doorway proof a town page can carry.
7. **Answer-first service pages.** Top service pages open with 24–56 words
   of marketing copy and 0–1 question H2s; 6 core service pages state no
   price at all. Open each with a 40–60-word direct answer (price range,
   timeline, warranty term), then question-style H2s. Add a visible
   "Reviewed by Joe Deal · <date>" + `dateModified` (0 of 192 service/area
   pages carry a date today).
8. **Own the cost query.** "Roof replacement cost Cincinnati 2026" is won by
   calculators and aggregators; NBD's cost post is ~1,050 words, no tables,
   uncited by AI. Rebuild as a real guide: cost-by-roof-size table,
   cost-by-material table (retail only — cost-privacy gate applies),
   cost-by-suburb section, insurance vs cash, dated.

### P2 — performance

9. 133 pages load 12 render-blocking stylesheets (roof-replacement: 47 KB /
   12 requests). Bundle to 1–2 files at build time.
10. 1,496 of 1,940 `<img>` are PNG, 1 is WebP; 132 distinct images > 100 KB;
    `/our-work` hub references 6 MB. `<picture>` with AVIF/WebP; badges to
    WebP/SVG. Mind the EXIF gate (`check-image-privacy.js`).

### Jo-only — off-site (highest leverage per minute; nobody else can do these)

Ordered by payoff. None of these can be done by Claude (account creation /
claiming / posting are Jo's).

1. **Review velocity.** 29 → 60 in 90 days. The CRM already nudges:
   `reviewRequestNudge` is enabled in prod (`functions/.env.nobigdeal-pro`
   `REVIEW_NUDGE_ENABLED=true`) — the missing step is tapping *send* on each
   nudge. Ask for reviews that mention the town and the job ("roof
   replacement in Mason") — review text is a local-ranking signal.
2. **BBB (Cincinnati) profile + accreditation** — confirmed missing; BBB
   category pages rank top-5 for Mason/Loveland/Cincinnati.
3. **GAF locator profile** — add website + photos, and point customers
   there for a second review; GAF city pages rank top-2 on four of six
   queries. (08-17 note: "no website field found" — recheck.)
4. **Claim Yelp**, fix categories to Roofing/Siding/Gutters (one search
   summary showed masonry/landscaping categories — verify), and **Angi free
   profile** (no paid leads needed).
5. **Apple Business Connect** + recheck **Bing Places / Bing Webmaster**
   (201 URLs discovered, 0 indexed at the 08-17 baseline, never rechecked).
   ChatGPT search leans on Bing; Siri on Apple Maps.
6. **TAMKO locator** (Pro Gold ID 181382 — rep email drafted 08-17, never
   sent), **Nextdoor business page**, **LinkedIn** (Joe + company).
7. **GBP completeness:** post the unposted
   [gbp-services-2026-09-03](../marketing/gbp-services-2026-09-03.md) list
   and the [gbp-post-kit-2026-09-21](../marketing/gbp-post-kit-2026-09-21.md)
   (9 posts, 26 photos — *nothing posted*); record the current categories.
   Weekly posts + geo-relevant job photos.
8. **One earned local mention:** Clermont/Mason chamber listing, or a storm
   story pitch to WCPO / Enquirer. AI answers favour local news + chambers.
9. **A 60-second "Meet Joe" video** on YouTube → `sameAs`, embeds on /about.
10. **Search Console:** capture the baseline that was never taken, and
    request indexing on the 09-24 town pages. Grant Claude read access
    later if a weekly GSC pull is wanted.

---

## 4. Efficiency — make visibility compound instead of hand-cranked

- **IndexNow on deploy.** The key file exists and 9 URLs were pinged once by
  hand on 08-17; nothing automates it (no script or workflow references
  IndexNow). A post-deploy step that pings changed URLs gets Bing/Yandex
  (and so ChatGPT search) re-crawling within hours.
- **Generate, then gate, the AI surfaces.** `llms.txt` (+ `llms-full.txt`)
  built from the sitemap + page meta, with a drift check like
  `build-sitemap.js`. Nothing checks llms.txt today.
- **Entity gate.** Extend `scripts/check-seo-surface.js`: every
  `RoofingContractor`/`Organization` node must be `{"@id": "/#org"}` except
  the homepage's; every FAQPage question must appear in visible text; flag
  town-page pairs above a Jaccard ceiling.
- **Every finished job → content.** `projects.json` already feeds
  `/our-work`; extend the build so a new job automatically appears on its
  town page and its service page, and the case page lands in the sitemap +
  IndexNow ping. One photo upload, four surfaces updated.
- **AEO tracking.** AirOps is connected but has 0 brand kits (re-checked
  2026-09-27) — setting one up with ~25 prompts (the six queries above, in
  question form, per town) gives a weekly measure of AI-answer share instead
  of spot checks.

---

## 5. Stale-doc corrections found during recon

Corrected in place in this PR:
- [GOOGLE-REVIEWS-UNCONFIGURED-2026-09-08](GOOGLE-REVIEWS-UNCONFIGURED-2026-09-08.md)
  — dated update: reviews render live since mid-September.
- [MANUAL-FOR-JO §2](../qa/seo-hardening-2026-07/MANUAL-FOR-JO.md) — the
  www → apex 301 "ACTION NEEDED" was done 08-17 (#1217/#1220).

Flagged, not resolved (need Jo or a separate pass):
- [citation-kit-2026-07](../marketing/citation-kit-2026-07.md) still calls
  the James Hardie Alliance a certification (Jo, 09-22: it's a membership)
  and its service-area block predates Central KY and the 09-24 towns.
- GBP post cadence: monthly (MANUAL-FOR-JO) vs weekly (playbook,
  WEEKLY_CADENCE) — pick one.
- Yelp in `sameAs` while unclaimed (Dana flagged; rush-week doc treats it as
  intended). Claiming it (Jo-only #4) dissolves the question.
- Area-page schema `addressLocality: Goshen` on 24 pages, none on 12,
  omitted elsewhere — Jo to confirm what the public HQ locality should be,
  then make it uniform via the `/#org` node (P0 #2).
- The 2026-09-26 handoff has no SEO section; the latest SEO state before this
  note was NEXT_SESSION-2026-09-24 §3/§6.

Raw crawl data (per-page JSON, overlap matrix) was left in the session
scratchpad; rerun the method above rather than trusting a copy.
