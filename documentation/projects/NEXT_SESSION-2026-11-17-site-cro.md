# NEXT_SESSION, 2026-11-17: site CRO + SEO lane (lane note)

*Lane note, not the live brief: see the **Current handoff** pointer in [INDEX](../INDEX.md). The live brief is
[NEXT_SESSION-2026-11-17-pricing](NEXT_SESSION-2026-11-17-pricing.md) (see also
[NEXT_SESSION-2026-11-17-repo-sweep](NEXT_SESSION-2026-11-17-repo-sweep.md)). Companion runbooks:
[VISUAL-BASELINE-REBLESS](../runbooks/VISUAL-BASELINE-REBLESS.md), [MERGE-QUEUE](../runbooks/MERGE-QUEUE.md).*

## What this lane did
Three read-only audits (homeowner persona walkthrough, CRO, SEO) turned into four fix lanes and three follow-up
PRs, one draft PR each, all on Jo's answers below. Every PR was merged through the queue only with all 16
required checks green, one at a time. **All of the PRs below are merged to `main` (queue empty, 2026-11-17).**

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

## Jo's decisions (2026-11-17)
- Reply promise everywhere: "Reply within 24 hours, usually the same day".
- Homepage long "Free Estimate" form replaced by the short inspect form (`#contact` kept).
- True and allowed: "free inspection, no deposit to look at your roof"; "24/7 same-day tarping when daylight and weather allow". NOT confirmed, never added: "I don't go door to door".
- Free-roof slide out of the announcement bar everywhere. Footer `/free-roof` link stays.
- Florence's two unsourced comparatives cut; "worth a claim" wording softened to "documents the damage so you can decide whether to file a claim".
- Lexington area/service pages stay on `cal.com/nobigdeal/roof-inspection-lexington`: `/inspect` is hardcoded to the Cincinnati event and cannot route Lexington leads.
- Eight GSC-titled towns (Fort Mitchell, Indian Hill, Amelia, Mt. Orab, Loveland, Montgomery, Mason, Cincinnati) keep their "<Town> Roofer |" titles until Search Console says otherwise.

## Still open (not built)
1. **Prose still implying a claim prediction** (the label itself is done in #3155): the `/free-tools` card ("a quick yes/no read on whether ... worth filing an insurance claim") and `docs/llms.txt`'s description ("worth an insurance claim"). `docs/llms-full.txt` still holds the old label until the deploy rebuild regenerates it.
2. **Insurance-coverage and supplement wording on service pages, Jo to decide** (noticed in #3154, not changed): Blue Ash "most Ohio homeowner's policies will cover the cost minus your deductible" (FAQ + JSON-LD) and "the replacement may be covered by insurance"; Anderson Township "Storm or hail damage is what standard Ohio homeowner's policies are written for", "insurance claims here are worth the effort to document thoroughly" and "I ... supplement when the initial estimate comes in short"; Erlanger's FAQ question "Can a roof repair in Erlanger be covered by homeowner's insurance?".
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
