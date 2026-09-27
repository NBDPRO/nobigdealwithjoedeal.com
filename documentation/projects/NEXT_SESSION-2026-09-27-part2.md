# NEXT SESSION — 2026-09-27 (part 2: SEO / AEO / GEO + Kentucky compliance)

A second lane on 09-27, separate from the Thursday/Bland lane in
[NEXT_SESSION-2026-09-27](NEXT_SESSION-2026-09-27.md) (still the brief for
Thursday). Jo asked for a deep dive on ranking in search + AI answers "in every
corner", then said "work through everything… keep doing autonomous work".
Plan and findings: [SEO-AEO-GEO-DEEP-DIVE-2026-09-27](../audit/SEO-AEO-GEO-DEEP-DIVE-2026-09-27.md).

Two things surfaced that are **not SEO** and matter more — read §0 first.

## §0 — Read first

1. **Kentucky insurance-job law vs the CRM (compliance).** Verified from the
   enrolled act (2026 Ky. Acts ch. 54 / SB 153; contracts on/after 2026-07-15)
   and KRS 304.20-105. Every CRM contract carries an insurance-assignment clause
   (void in KY, printed even on cash jobs), AOB/Work Authorization text says the
   contractor *negotiates* the claim, no statutory notices / detachable Notice of
   Cancellation, deductible due at signing on insurance jobs (367.626 bars
   advance payment), $200 referral bonus (> $100 cap on insured jobs), and a rep
   playbook called deductible absorption "legal in OH/KY". Full recon:
   [KY-INSURANCE-JOB-CRM-2026-09-27](../audit/KY-INSURANCE-JOB-CRM-2026-09-27.md).
   **Draft PR #1801** builds only the [SAFE] items (KY detection, verbatim
   notices, 2× Notice of Cancellation, lien clause, AOB off for KY / off cash
   jobs everywhere, negotiate-language removed, FTC 3-day form actually
   attached, timezone-correct signing dates). **Needs Jo's OK + his [JOE]
   decisions:** business mailing/physical address on KY contracts, deposit
   deferral reading for KY insurance jobs, referral-bonus cap, direction-to-pay
   wording, Ohio AOB policy, File-Claim/supplement workflow. Not legal advice —
   a KY attorney should confirm.
2. **Public site claim wording is now KY-compliant** (#1798): "I handle the
   insurance claim for you" was on 224+ pages (451 hits). Gate:
   `tests/claim-wording.test.js`. Never write that Joe handles / negotiates /
   advocates on the claim or is an insurance/claims specialist/expert. Allowed:
   inspects and documents damage, writes the estimate, meets the adjuster after
   the homeowner files.
3. **Ohio re-roofs generally DO need a permit** (OAC 4101:8 + 2017 Board of
   Building Standards memo; 17 of 31 OH towns confirmed). Operational note for
   Jo, not a site bug — sourced in `site-src/data/towns.json`.

## §1 — Merged (all green; deploy triggers on docs/**)

| PR | What |
|---|---|
| #1791 | Deep-dive plan + CTR-service verdict (don't buy paid "CTR non-manipulation"; GBP fake-engagement risk) |
| #1792 | /our-work case studies linked from service + area pages and back out (inbound links median 1 → 11) |
| #1793 | llms.txt generated regions (areas/services/case studies) gated in CI; llms-full.txt regenerated at deploy; **IndexNow ping after every prod deploy** |
| #1794 | /areas Ohio count fix + citation kit refresh (Hardie = membership) |
| #1795 | FAQPage questions must be visible on the page (+ gate); 69 hidden Q&As surfaced, 8 contradicting ones removed |
| #1798 | KY-compliant claim wording site-wide + `claim-wording` gate; landing visual re-blessed from CI actuals |
| #1799 | Vault note: KY law vs CRM |
| #1800 | WebP/AVIF `<picture>` on ~950 imgs; /our-work LCP 4.7 → 2.5 s; case pages 2.5 → 1.5 s; image-privacy gate scans AVIF |
| #1804 | 43 town pages on real data (Census, NOAA, permits, historic review, 146 sourced facts) + 189 town FAQs; overlap 0.41/0.73 → 0.16/0.31; `build-town-pages.mjs --check` in CI |
| #1805 | Older job prices keep price + year but get "Priced in <year>…" context; tier deltas fixed to +9%/+21% (guarantee page is the source) |
| #1806 | Duplicate jobs merged (Newport siding, brick tear-off, Sycamore Twp, West Liberty) with 8 × 301s + `ourwork-retired-slugs` test |
| #1807 | Homeowner web manifest + lettered 192/512 icons + `apple-mobile-web-app-title` "No Big Deal"; `data-nosnippet` on all 300 GAF/TAMKO disclaimers (Google was using one as the homepage snippet) |
| #1808 | Footer says the name once; single GAF badge on Timberline; manufacturer "straight from the source" links + visualizer guidance (use theirs first; ours carries a simulation disclaimer) |
| #1809 | Town service pages (inspection / siding) de-templated on local data (0.55→0.27, 0.47→0.27, 0.40→0.24); NOAA-checked storm claims on 74 more pages; claim-wording gate learns `advocacy-near-claim` + `public-adjuster-would` |

## §2 — Open PRs

| PR | State | Blocker |
|---|---|---|
| #1797 | draft, green locally | **Jo: public city.** One `addressLocality` line in `site-src/partials/schema-entity.html` (now "Goshen"). Jo wants off the Goshen framing but the warehouse is there; must match the GBP city. Ask if the warehouse mailing address is Milford 45150. Then `node scripts/apply-partials.js`, un-draft, merge. The single `#org`/`#joe` entity is the biggest AEO/GEO lever. |
| #1810 | CI (rebased on #1809, tree identical to the CI-tested stack) | "TAMKO Storm Series" → `/services/tamko-impact-resistant-shingles` (5 × 301s + `tamko-page-rename` test); manufacturer-verified color counts (HDZ 23, UHDZ 6); LumaNail Inc.; landing visual re-blessed from CI actuals. Merge when green. Blog URL `gaf-timberline-vs-tamko-storm-series` kept on purpose. |
| #1811 | CI | 155 oversized WebPs re-encoded or dropped (−33%); `hero-format` rule understands `<picture>`. Rebase after #1810 and re-run `build-projects.mjs` if it conflicts. |
| #1796 | draft | Jo's read-through of the two rewritten insurance posts (5 JOE-CONFIRM items). When it merges, remove their entries from the FAQ-visible allowlist and the entity-gate pending list. |
| #1802 | draft | Answer-first leads on 25 core service pages. Paused for price validation: 6 `PRICE-PENDING` markers; quotes By Golly's 2023 price without a year. |
| #1803 | draft | Rebuilt 2026 cost guide (tables, tiers +9/+21). Jo review; 4 `PRICE-PENDING` comments. The live guide is stale ($650–$750/sq, "3-tab") — merge soon after review. |
| #1801 | draft | CRM KY contracts — see §0.1. |

## §3 — Waiting on Jo (all asked in chat; answers unblock work)

- City/ZIP on the warehouse mailing address + the GBP city (→ #1797).
- **14 price questions** (scratchpad `price-lane/price-questions-for-joe.md`, sent): Milford 45 sq billed vs measured, 9 undated jobs' years, Instant Estimate default, Class 4 delta, small-job minimums vs cards, free vs paid inspection, Roof Care Plan $149 vs CRM $450, add-on prices, delivery charge mention.
- Original list: prices for tarping / soft wash / siding / interior / shed / commercial / NBD Build; top 8–10 towns; listing status (LinkedIn, YouTube, Nextdoor, Yelp claim, Angi, Apple, BBB, GAF website field); **yes/no: CRM review-request text asks for town + job**; 60-s "Meet Joe" video; Search Console read access.
- Six contradictions (insurer-first vs contractor-first after a storm, OH filing deadline, 1 vs 1–2 day replacement, inspection age, Timberline colors — now fixed in #1810, architectural vs 3-tab delta).
- 10 job stories (sent as `job-stories-top10.md`); gutter-screens hero may show the OLD guard.
- Off-site actions only Jo can do (deep-dive note §3 "Jo-only"): BBB, GAF locator website field, claim Yelp + Angi, Apple Business Connect, recheck Bing, TAMKO locator, Nextdoor, LinkedIn, post the unposted GBP kits weekly (Jo chose **weekly**), one local press/chamber mention.
- Search Console: URL-inspect + Request Indexing on the apex homepage (Google still shows the old blue roofline favicon for the **www** host); add a Domain property. GSC shows brand query 22 clicks / 247 impressions / pos 2.9 (90 d).
- After deploy: re-test a **fresh Brave bookmark** (Brave picks the largest sized `rel=icon`; #1807 added 192/512 lettered PNGs).
- Semrush MCP is connected but the account has **no API units**.
- **Business Profile API allowlist requested 2026-09-27** (Jo live, from jonathandeal459@gmail.com, project  / 717435841570): case **8-9748000042165**, Google quotes 7–10 business days. On approval (Cloud Console quota 0 → 300 QPM) follow  "Business Profile API (all reviews)" — Jo must sign in himself for the OAuth refresh token. Unlocks all reviews, newest first.
- Reviews widget: #1814 sorts newest first + hides the "FDP Python…" reviewer (Jo's ask); a stacked lane adds an honest "N new reviews this month" line from Google's count history.

## §4 — Follow-ups nobody has claimed

- 156 project WebPs are larger than their JPEGs — re-encode (AVIF wins today, so not urgent).
- `check-seo-surface` "hero-format" warnings: eager heroes served via `<picture>` AVIF lack a `.webp` sibling — teach the gate about `<picture>` or add WebPs.
- Covington & Cincinnati area pages carry two FAQPage blocks (town FAQ + existing) — merge after #1797 lands.
- Estimate wizard metal/flat/siding prices are market placeholders, not CRM numbers (Jo question 14).
- `docs/pro/js/sales-training-engine.js` still coaches the "insurance restoration specialist" pitch (exempted as rep-only in #1801's scan) — reword.
- Verify after the next deploy: IndexNow step ran (deploy log), `llms-full.txt` regenerated, `/manifest.webmanifest` 200 with `application/manifest+json`, and the 301s from #1806.
- The public repo's PRs rank for the brand term "nobigdealwithjoedeal" — Jo chose to leave the repo public and push it down with real profiles.
- AirOps AEO tracking: 0 brand kits; set up ~25 prompts to measure AI-answer share weekly.

## §5 — Lessons from this lane

- **Merge order for generator-touching PRs:** several PRs regenerated the same
  stamped regions (`build-projects`, `build-town-pages`, partials). Merge one,
  then rebase the next and **re-run the generators** instead of hand-merging
  regions; bump `run-test-manifest.js` FLOORS with the exact line it prints.
- **Test the combined tree, not just the text merge:** `git merge-tree` clean
  isn't enough when shared templates changed — build main+PR in a throwaway
  `--detach` worktree and run the gates there.
- **Rendered QC sweep "page-error … Timeout 20000ms"** on 5 scattered pages at
  different viewports = runner load, not content. A fresh push re-runs it.
- **Brave vs Safari icons:** Safari uses `apple-touch-icon`; Brave takes the
  biggest *sized* `rel=icon`. Without sized PNG icons it fell back to the
  wordless 16–48 px roofline. Google caches favicons per hostname.
- **Verify a surprising agent claim before acting:** the "exposed base rates"
  in the estimate script were retail (×1.12–1.25 = the published $610–$825),
  not costs; the KY statute claims were read from the enrolled act PDF.
