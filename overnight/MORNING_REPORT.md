# Morning report — overnight 2026-11-05 to 06

Nothing was deployed. I merged nothing myself: #2894, #2897, #2899, #2900, #2903 and #2905 went through the merge queue on their own
(the repo's queue/auto-merge, not a command from me). No `gh pr merge`, no pushes to main, no force-pushes.

## TL;DR
- The public site was already near its ceiling (A11y 100, SEO 100, BP 96, CLS 0 on all baseline pages), so the night went to
  **measured geometry/style sweeps of all 298 public pages** and fixing the outliers they found.
- Biggest real fixes: service-page **trust bar was clipped/overlapping on phones** (#2899, merged); **/pro/login desktop was a
  stacked single column** since #2727 (#2900, merged); **48 project pages had a different header** than the rest (#2903).
- Smaller: landmark roles for axe (#2897), area-hero alignment (#2904), phone logo on 6 pages (#2905 merged), 44 px primary CTA
  floor (#2906), last two axe findings (#2907), `/inspect` invalid-field styling (#2909).
- Perf: case-study pages load about a third fewer image bytes (#2908: 221 -> 148 KB phone, 148 -> 97 KB desktop).
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
| [#2904](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2904) | site-visual | area hero "Rather talk?" line centered on phones | L | open |
| [#2906](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2906) | site-ux | primary CTA >= 44 px | L | open |
| [#2907](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2907) | a11y | heading-order + redundant-alt fixes (style measured identical) | L | open |
| [#2908](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2908) | site-perf | 287 new -400 photo copies + srcset on case-study pages | L-M (5.7 MB binaries) | open |
| [#2911](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2911) | site-visual | desktop header on the 33 blog posts and 7 product pages: nav labels no longer wrap to two lines, button 37-67 px -> 33 px on every post, logo no longer squeezed (new `blog-nav-fit.css`, codemod on 40 pages) | L | open |
| [#2913](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2913) | site-visual | 18 service hub pages: header side padding 24 -> 16 px at 1025-1440 px like the other 184 pages (`nav-pad-laptop.css` linked last, link order untouched) | L | open |
| [#2912](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2912) | site-visual | project pages' header at 1025-1440 px matches the standard pages (logo 60 -> 50 px, labels 12.16 -> 11.2 px; generator inline rules, 48 pages) | L | open |
| [#2909](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2909) | site-ux | /inspect: every invalid field looks invalid, clears on edit (script v=9) | L | open |

Merge order: independent. Every PR adds one line to `documentation/INDEX.md` at the same spot, so each merge makes the others
conflict on that file (keep both lines); Auto-fix has been resolving that. Optional checks that were red on some PRs
(Authed E2E shard 2/3, Mobile realtime, Pro demo zero-network, Rendered QC sweep) were red across unrelated PRs and are not
required; the Rendered QC sweep's only finding locally is `/sites/oaks` images 404-ing on a static server that lacks the
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
1. Homepage hero video is 0.9-2 MB on phones: lighter phone cut or skip on slow connections.
2. Service-page hero photos are 800 px wide and upscale about 1.8x on 1440 px screens; needs 1600 px re-exports from the originals.
3. Stray empty folder `C:\c\Users\jonat\AppData\Local\Temp\lhtest` (path slip; I was blocked from deleting it).

## Attempted and reverted / rejected
- Linking `nbd-mobile.css` into project pages (matches the header but changes body margins and hero crop): rejected, header-only fix shipped.
- Chasing mobile TBT: observed long tasks are first style/layout, not script; noise exceeds any gain.
- `<h3>` for the blog fact-box title: would have grown 11.5 -> 16.8 px through a `!important` rule; used a styled span.

## Next-night backlog
1. 1600 px hero re-exports (NEEDS_JOE 2) then a `-1600` srcset step.
2. Re-measure mobile TBT on service pages on a quiet machine / the weekly perf-watch, 3 runs, with and without `text-wrap: balance`.
3. Header families still differ above 1440 px (service hubs 40/56 px side padding vs 16 px on standard pages; a design call, the 1025-1440 px gap was fixed in #2913); `/careers` and `/partners` nav padding (20 px vs 16 px); `/free-roof` first-invalid-field focus (generated script, needs the extractor).

## Rollback
Close any open PR; merged ones revert with `git revert`. No deploys, no data writes, no CRM logins. Worktree
`C:\Users\jonat\nbd-wt-overnight` stays; no quarantine dir was created; my local static server is stopped when this report is final.
