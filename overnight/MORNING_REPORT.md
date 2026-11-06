# Morning report — overnight 2026-11-05 to 06

Nothing was deployed. Update 2026-11-06 morning: at Jo's request ("get every PR in queue to merge") I turned on auto-merge for my PRs; the queue still did every merge. Before that I merged nothing myself: #2894, #2897, #2899, #2900, #2903 and #2905 went through the merge queue on their own
(the repo's queue/auto-merge, not a command from me). No `gh pr merge`, no pushes to main, no force-pushes.

## TL;DR
- The public site was already near its ceiling (A11y 100, SEO 100, BP 96, CLS 0 on all baseline pages), so the night went to
  **measured geometry/style sweeps of all 298 public pages** and fixing the outliers they found.
- Biggest real fixes: service-page **trust bar was clipped/overlapping on phones** (#2899, merged); **/pro/login desktop was a
  stacked single column** since #2727 (#2900, merged); **48 project pages had a different header** than the rest (#2903).
- Smaller: landmark roles for axe (#2897), area-hero alignment (#2904), phone logo on 6 pages (#2905 merged), 44 px primary CTA
  floor (#2906), last two axe findings (#2907), `/inspect` invalid-field styling (#2909).
- Perf: case-study pages load about a third fewer image bytes (#2908: 221 -> 148 KB phone, 148 -> 97 KB desktop).
- **Second phase (daytime, #2922-#2936):** reading full-page screenshots at 390 and 1440 px found layout bugs the metric sweeps missed: the `/blog/` sidebar sat ~10,000 px down the page (#2931), 31 pages had a lone job card beside a 900 px hole (#2930), the `/about` sections did not line up with the hero (#2932), 45 town pages had mixed-case nav (#2936), three hero gradients washed out to grey-peach (#2933), reviewer names wrapped (#2934), the `/areas/` stat row orphaned its fourth stat (#2925), and a few tap-target and type-size fixes (#2922 #2923 #2924 #2935).
- Axe across all 298 pages is clean once #2897 and #2907 land (only `region`, `heading-order`, `image-redundant-alt` existed).

## PRs
| PR | Theme | Summary | Risk | State at last check |
|---|---|---|---|---|
| [#2894](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2894) | pro-ux + tooling | 33 stale `#e8720c` fallbacks -> `#BD5728`; audit scripts | L | merged |
| [#2899](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2899) | site-visual | trust bar fix on phones, desktop alignment, `text-wrap: balance` headings | L | merged |
| [#2900](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2900) | pro-ux | /pro/login split layout restored; login visual baseline re-blessed from CI render | L | merged |
| [#2905](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2905) | site-visual | six pages get the phone logo size | L | merged |
| [#2897](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2897) | a11y | `role=region` on sticky CTA strip + announcement bar (306 files, codemod `--check`) | L (wide, mechanical) | merged |
| [#2903](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2903) | site-visual | project detail pages: header padding + phone logo match the rest (generator) | L | merged |
| [#2904](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2904) | site-visual | area hero "Rather talk?" line centered on phones | L | merged |
| [#2906](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2906) | site-ux | primary CTA >= 44 px | L | open |
| [#2907](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2907) | a11y | heading-order + redundant-alt fixes (style measured identical) | L | open |
| [#2908](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2908) | site-perf | 287 new -400 photo copies + srcset on case-study pages | L-M (5.7 MB binaries) | merged |
| [#2911](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2911) | site-visual | desktop header on the 33 blog posts and 7 product pages: nav labels no longer wrap to two lines, button 37-67 px -> 33 px on every post, logo no longer squeezed (new `blog-nav-fit.css`, codemod on 40 pages) | L | merged |
| [#2914](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2914) | pro-ux | /pro/login phone text: every label under 12 px (9-11 px before) raised to 12 px at 900 px and below; Lighthouse Best Practices 93 -> 96; may need a CI re-bless of the 375/768 px login visual baselines | L | open |
| [#2913](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2913) | site-visual | 18 service hub pages plus /careers and /partners: header side padding 24/20/40/56 -> 16 px at every width like the other 184 pages (`nav-pad-laptop.css` linked last, link order untouched) | L | open |
| [#2912](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2912) | site-visual | project pages' header at 1025-1440 px matches the standard pages (logo 60 -> 50 px, labels 12.16 -> 11.2 px; generator inline rules, 48 pages) | L | merged |
| [#2909](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2909) | site-ux | /inspect: every invalid field looks invalid, clears on edit (script v=9) | L | open |
| [#2915](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2915) | pro-ux | public /pro pages (how-to, register, pricing, terms) failed axe contrast/link/heading/main rules (A11y 83-96): scoped stylesheet with the sanctioned light orange + white-at-72%, underlined in-text links, sidebar labels not headings, terms in `<main>`; how-to 81-98 contrast nodes -> 0; visual regression passed | L | open |
| [#2916](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2916) | pro-ux | /pro/ tour panels `<article role=tabpanel>` -> `<div>` (axe aria-allowed-role), no visual change | L | open |
| [#2917](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2917) | pro-ux | last axe `region` notes on /pro/how-to and /pro/pricing (aria-label + role=contentinfo, attribute-only) | L | open |
| [#2918](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2918) | pro-ux | /pro/how-to scrolled sideways 29 px on a 320 px phone (top bar 324 px wide, code paths past the margin, pill text overflowing at 320 and 768 px); phone-only CSS block + width-independent pill wrap; every public Pro page now has zero overflow at 320-1366 px | L | open |
| [#2919](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2919) | site-visual | DRAFT, needs Jo: /inspect header says the brand once (drops the text wordmark that repeated the logo image, sets the image alt); rewrites a deliberate 2026-11-04 test | L | draft |
| [#2922](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2922) | site-visual | phone tap targets for footer legal links, blog Read Article and partner CTAs (+ slim footers) | L | merged |
| [#2923](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2923) | site-visual | phone Call/Text labels 9.9 px -> about 12 px in the sticky strip | L | merged |
| [#2924](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2924) | site-visual | button press feedback scales to 0.97 (was a 1 px nudge) | L | merged |
| [#2925](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2925) | site-visual | /areas/ hero stats as a 2x2 grid on phones | L | merged |
| [#2926](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2926) | copy | /partners hero: spaced em dash (the only unspaced one on the site) | L | merged |
| [#2927](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2927) | site-visual | homepage eyebrows balance their wrap on phones, dot on line one | L | merged |
| [#2928](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2928) | site-visual | checkmark strip on 124 service/town pages is a left-aligned list on phones | L | merged |
| [#2930](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2930) | site-visual | a lone recent-job card becomes a feature card on desktop (31 pages) | L | merged |
| [#2931](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2931) | site-visual | /blog/ sidebar sits beside the posts (markup closed </main> too late) | L | merged |
| [#2932](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2932) | site-visual | /about sections line up with the hero container on wide screens | L | merged |
| [#2933](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2933) | site-visual | /book, /free-roof, /free-tools hero gradient gets a navy base (no grey-peach corner) | L | merged |
| [#2934](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2934) | site-visual | review cards let the star row wrap under the name (names stop breaking) | L | merged |
| [#2935](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2935) | site-visual | footer social icons get a 44 px tap area on phones | L | merged |
| [#2936](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2936) | site-visual | 45 town pages' desktop nav is uppercase like every other page type | L | merged |
| [#2960](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2960) | site-visual | guide Contents columns line up (li margin truncated at the column break) | L | merged |

State at 2026-11-06 17:50 local (final): every PR listed above is merged (#2894-#2936, plus #2960 guide Contents alignment) except #2919, the /inspect header fix, which Jo pulled out of the queue and set back to draft by hand (left alone; its branch is current with main). Visual-regression note: the required `landing--mobile-375` snapshot is the HOMEPAGE at 375 px; #2927 and #2922 change its height on purpose, so each re-blessed the baseline from its own CI actual, in order (10713 -> 10726 -> 10704 px), after #2929 (another session) had re-blessed it first. The repo's per-PR CI concurrency cancels the older run whenever a new pull_request run starts, so never push to a PR while its CI is running. Four PRs hit INDEX.md adjacency conflicts in the queue (#2910 #2923 #2925 #2936) and were fixed by giving each its own INDEX anchor. Measured and dropped: a fallback font for layout shift (CLS 0.000 on four pages even on throttled slow 4G), a lighter hero-video cut (phone cuts are already 0.7-1.5 MB and load after the page). Still open for Jo: the 1600 px hero photos need the original photos (committed masters are 800 px), and whether the public site should show the Beyond roof tier.

Merge order: independent. Every PR adds one line to `documentation/INDEX.md` at the same spot, so each merge makes the others
conflict on that file (keep both lines); Auto-fix has been resolving that. Optional checks that were red on some PRs
(Authed E2E shard 2/3, Mobile realtime, Pro demo zero-network, Rendered QC sweep) were red across unrelated PRs and are not
required; the Rendered QC sweep's only finding locally is `/sites/oaks` images 404-ing on a static server that lacks the
Read the log of one (the Pro demo zero-network walk on #2915): the job was CANCELLED while `playwright install --with-deps chromium` was still downloading apt packages from the Azure mirror (a few KB/s for minutes); the tests never ran. So the recurring optional-check failures that hit PRs touching no CRM code look like runner/apt timeouts, not code. Not verified for every check.
Firebase rewrites.

## Metrics (local Lighthouse 12.8.2, 2 runs median; machine noise on mobile TBT is about +/-300 ms)
BEFORE: `overnight/METRICS.md`. AFTER (main with #2899 and #2900 merged):
mobile / 94 (was 79), roof-repair 75 (80), roof-inspection 76 (73), /pro/login 98 (95); A11y 100, SEO 100 (login 54 = noindex),
BP 96 unchanged; CLS 0 except `/pro/login` desktop 0.010 -> 0.033 (new split layout, still under 0.1).
Treat the Perf differences as noise: no change touched script or the LCP image. roof-repair mobile TBT read 540 before and 718 after; I
did not isolate whether `text-wrap: balance` costs layout time, so if the Monday perf-watch moves on service pages, check that first.
Screenshots: `overnight/baseline/shots/before/` (only those <= 200 KB are committed). No `report.html` was built.

## Skills/tools
No GitHub skill/tool candidates were adopted (nothing needed importing, and an unreadable import is not worth the risk). Local-only tooling
added: `scripts/overnight-serve.mjs`, `overnight-lh.mjs`, `overnight-shots.mjs`, `overnight-asset-inventory.js`, plus the codemods
`fix-pro-orange-fallback.js`, `fix-region-landmarks.js`, `fix-phone-logo-link.js` and `build-project-thumbs.mjs` (all with `--check`).

## NEEDS_JOE (details in `overnight/NEEDS_JOE.md`)
1. Homepage hero video (0.9-2 MB on phones) already skips on Save-Data, 2g and reduced motion, starts only after load + idle, and deliberately serves 3g the smaller cut; the only open question is whether you want a lighter phone cut.
2. Service-page hero photos are 800 px wide and upscale about 1.8x on 1440 px screens; needs 1600 px re-exports from the originals.
3. /inspect header repeats the brand name (logo image plus text wordmark): my recommended fix is ready as DRAFT [#2919](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2919); it rewrites a deliberate test, so mark it ready or close it.
4. Stray empty folder `C:\c\Users\jonat\AppData\Local\Temp\lhtest` (path slip; I was blocked from deleting it).

## Attempted and reverted / rejected
- Linking `nbd-mobile.css` into project pages (matches the header but changes body margins and hero crop): rejected, header-only fix shipped.
- Chasing mobile TBT: observed long tasks are first style/layout, not script; noise exceeds any gain.
- `<h3>` for the blog fact-box title: would have grown 11.5 -> 16.8 px through a `!important` rule; used a styled span.

## Next-night backlog
1. 1600 px hero re-exports (NEEDS_JOE 2) then a `-1600` srcset step.
2. Re-measure mobile TBT on service pages on a quiet machine / the weekly perf-watch, 3 runs, with and without `text-wrap: balance`.
3. Header families: service hubs, /careers and /partners now share the 16 px side margin at every width (#2913); the project pages and blog/product pages have their own size rules (#2911, #2912).
4. The CRM app pages (dashboard, customer, ...) still load render-blocking Google Fonts CSS although `nbd-fonts-pro.css` self-hosts Barlow; moving them needs a per-page weight audit (several pages ask for 800/900 weights and mono families the sheet does not carry) and belongs to the CRM speed lane. (The public /pro pages are axe-clean once #2915, #2916 and #2917 land.)

## Rollback
Close any open PR; merged ones revert with `git revert`. No deploys, no data writes, no CRM logins. Worktree
`C:\Users\jonat\nbd-wt-overnight` stays; no quarantine dir was created; my local static server is stopped when this report is final.
