# NEXT_SESSION, 2026-11-17: site CRO + SEO lane (lane note)

*Lane note, not the live brief: see the **Current handoff** pointer in [INDEX](../INDEX.md). The live brief is
[NEXT_SESSION-2026-11-17-pricing](NEXT_SESSION-2026-11-17-pricing.md) (see also
[NEXT_SESSION-2026-11-17-repo-sweep](NEXT_SESSION-2026-11-17-repo-sweep.md)). Companion runbooks:
[VISUAL-BASELINE-REBLESS](../runbooks/VISUAL-BASELINE-REBLESS.md), [MERGE-QUEUE](../runbooks/MERGE-QUEUE.md).*

## What this lane did
Three read-only audits (homeowner persona walkthrough, CRO, SEO) turned into four fix lanes and three follow-up
PRs, plus two claim-wording PRs on 2026-11-18, one draft PR each, all on Jo's answers below. Every PR was merged
through the queue only with all 16 required checks green. **All of the PRs below are merged to `main`
(last one #3169, 2026-11-18).**

| PR | What | State |
|---|---|---|
| #3131 | Pricing: templates + line items use the shop's Settings; its inline-style ratchet failure fixed (rates note became `.jt-ratesnote`) | Merged |
| #3140 | Blog -> city links, `tamko-storm-series` slug renamed (+301), sitemap `lastmod` from real history, free-roof slide off the blog | Merged |
| #3142 | `/inspect`, `/storm-check` (lead saves at the contact step), `/estimate` copy and booking links | Merged |
| #3143 | Town + service pages: book via `/inspect`, one area title pattern (8 GSC-titled towns keep theirs), hail headings, free-roof slide off, Lexington pages kept on their own cal.com event | Merged (ejected from the queue once, see lessons; re-pushed with a conflict fix) |
| #3141 | Homepage: storm line, short booking form, Fully insured chip, AI label on the Thursday video, no free-roof slide | Merged (homepage visual baselines re-blessed twice) |
| #3152 | Financing post "worth pursuing" wording softened; `the-nbd-guarantee` estimate buttons to `/inspect` | Merged |
| #3154 | "Worth pursuing" wording softened on `roof-repair-erlanger-ky`, `roof-replacement-anderson-township-oh`, `roof-replacement-blue-ash-oh` (FAQ + JSON-LD) | Merged |
| #3155 | The free-tool label is "Storm Damage Check" everywhere (partials, nav script, `llms.txt`, 66 pages; new structural test); the URL `/storm-check` is unchanged | Merged |
| #3162 | Insurance-outcome wording off Blue Ash and Anderson Township roof-replacement pages (FAQ + JSON-LD); `/free-tools` card and `llms.txt` describe the Storm Damage Check by what it does, no claim prediction | Merged |
| #3169 | "Worth a claim" sweep: 45 pages + 4 guide Markdown sources, now "I document the damage with photos so you can decide whether to file a claim"; `scripts/worth-a-claim-sweep-2026-11-18.js` + structural test | Merged |

## Jo's decisions (2026-11-17)
- Reply promise everywhere: "Reply within 24 hours, usually the same day".
- Homepage long "Free Estimate" form replaced by the short inspect form (`#contact` kept).
- True and allowed: "free inspection, no deposit to look at your roof"; "24/7 same-day tarping when daylight and weather allow". NOT confirmed, never added: "I don't go door to door".
- Free-roof slide out of the announcement bar everywhere. Footer `/free-roof` link stays.
- Florence's two unsourced comparatives cut; "worth a claim" wording softened to "documents the damage so you can decide whether to file a claim".
- Lexington area/service pages stay on `cal.com/nobigdeal/roof-inspection-lexington`: `/inspect` is hardcoded to the Cincinnati event and cannot route Lexington leads.
- Eight GSC-titled towns (Fort Mitchell, Indian Hill, Amelia, Mt. Orab, Loveland, Montgomery, Mason, Cincinnati) keep their "<Town> Roofer |" titles until Search Console says otherwise.

## Still open (not built)
1. **Done, kept for the record:** the label (#3155), the insurance-coverage wording on Blue Ash / Anderson Township, `/free-tools` and `llms.txt` (#3162), and the "worth a claim" sweep (#3169). `docs/llms-full.txt` still holds the old label until the deploy rebuild regenerates it.
2. **Update 2026-11-26: done.** Jo approved "I document the damage with photos so you can decide whether to file a claim"; `scripts/claim-verdict-sweep-2026-11-26.js` swapped every line below (plus `storm-damage-blanchester-oh`, which the new `claim-verdict` gate rule found), Erlanger's FAQ stays (its answer promises nothing), and the four PDFs were already rebuilt in #3185 (NBD Docs Studio, Typst). Original note: **Claim-wording leftovers, Jo to decide** (outside the approved patterns, left on purpose): "tell you / walk you through whether a claim makes sense" on `siding-repair`, `hail-damage-covington`, `hail-damage-insurance-claim` and three blog posts (`tests/claim-wording.test.js` explicitly allows that exact sentence); roof-repair-fairfield ("advise whether an insurance path makes sense") and roof-repair-florence ("determine whether a repair-level claim ... is appropriate"); Erlanger's FAQ question "Can a roof repair in Erlanger be covered by homeowner's insurance?" (its answer already says it depends on your policy). **The four guide PDFs under `docs/guides/pdf/` still carry the old sentence**: they are built outside this repo's scripts and need regenerating from the updated `site-src/guides/*.md`.
3. **Leftover `/#contact` buttons:** the footer "Get My Free Estimate" (a partial, so a restamp PR) and the "Talk to Joe" / "Send a message" links, which are genuine contact links and were left on purpose.
4. **Reviews strip next to the `/inspect` form** (it sits inside an `nbd:partial` region) and **a dated review beside the quote form on service pages** (`google-reviews-widget.js` fills only the first container).
5. **Teach `/inspect` to pick the Lexington cal.com event from the address**, then move the Lexington pages onto it. Today a Lexington lead on `/inspect` gets Cincinnati slots.
6. **Search Console export needed from Jo** before consolidating the three overlapping blog groups (GAF vs TAMKO, roof financing, Class 4) or pruning the ~190 service-by-city pages. The Cincinnati homepage vs `/areas/cincinnati-oh` cannibalization risk and the 8 retitled towns need the same data.
7. `scripts/wire-free-roof-entry-points.js` now skips slide injection everywhere (#3143's resolution on top of #3141's homepage skip); if the free-roof slide ever returns, that script needs re-enabling on purpose.
8. Unsourced: the per-square price range in the homepage FAQ and the job-card prices need Jo's confirmation that they are real job totals.

## Lessons
- **A homepage change fails `Visual regression (public pro pages)` on purpose** (`landing--*` is `/`). Re-bless from the CI render, only the failing sizes, in one push, and only after that PR's run finishes; a hidden element's CSS can hide a row you did not mean to remove (an empty "on Google" chip: `[hidden]` was overridden by a `display` rule), so re-bless AFTER the last visual fix.
- **A new test can break on top of a sibling PR.** #3143 was ejected from the queue because main gained a BreadcrumbList ("Hail Damage Repair") from another PR that its own test rejects. Run the lane's tests on top of fresh `origin/main` before queueing.
- **Gate counts:** `source-pin-ratchet` rejects new file-text assertions in existing suites; use `tests/lib/src-kit.js` or a vm helper (`tests/lib/quick-form-render.js`). Never `--lower` for other suites' decreases in a lane PR.
- Fresh worktrees need `functions/node_modules` linked from the main checkout; six suites fail without it.
