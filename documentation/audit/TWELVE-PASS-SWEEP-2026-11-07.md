# Twelve-pass sweep (2026-11-07)

Goal set by Jo: keep sweeping until a dozen different passes in a row find
nothing meaningful. Each pass was a different kind of check across the public
site (not the CRM). The one pass that found something (contrast) was fixed and
the count restarted; the twelve below ran after it and were clean.

## The pass that found something

| Pass | Result |
| --- | --- |
| Computed text contrast (1440 and 390, non-image backgrounds) | `/our-work` "After" label white on green 2.93:1 and "During" 4.32:1; "The NBD Guarantee" badge brand orange on navy 3.04:1. Fixed (`#15803D` / `#B91C1C` label backgrounds; badge `#DD875F`). |

## The twelve clean passes

| # | Pass | What was checked | Result |
| --- | --- | --- | --- |
| 1 | Keyboard focus | Tab through 20 representative pages, every focusable has an outline or shadow | clean |
| 2 | Image sharpness | Each selected image decoded on its own vs device pixels needed, 1x desktop and 3x phone | desktop hero photos at 800 px are the known CRM-export item; American Operator dark banner is 1.5x on 3x phones, designer art with no larger dark variant; nothing else. (A first run used `naturalWidth`, which is density-corrected for `srcset` and reports false positives; redone with a decode.) |
| 3 | Structured data | 1,269 JSON-LD blocks parse; Question/Article/Breadcrumb fields; FAQ questions visible on the page | clean |
| 4 | Reduced motion | Infinite animations running under `prefers-reduced-motion` on 20 pages; control without it finds the `/storm-alerts` pulse | clean |
| 5 | Forms | Static scan and live-DOM accessible names | only honeypots, which are `aria-hidden` and `tabindex="-1"` |
| 6 | Tiny text | Visible text under 11 px at 390 | tags, badges and legal fine print at 9.6 to 10.9 px; nothing body-level |
| 7 | Duplicate ids / dead anchors | 309 pages; regexes proven with a planted duplicate | clean |
| 8 | Link hygiene | 29,129 links: `target=_blank` without `noopener`, empty links, `href="#"`, absolute self-links, bad `tel:` | clean |
| 9 | Contact consistency | Every phone number and email on the site | only (859) 420-7382 and jd@; the rest are form placeholders |
| 10 | 1920 px | Screenshots of four key pages | clean; the service pages' mix of 5%-padded full-width blocks and centred 880 to 1200 px panels is by design (the same offset exists at 1440), a prototype override did not take effect and would create a 1500 px discontinuity, reverted |
| 11 | Landscape phone (844x390) | Fixed header and bottom bar height, overflow | 108 px header on most pages, no bottom bar, no overflow |
| 12 | iPad portrait (820 wide) | Screenshots of four key pages | clean; a lone third job card on a 2-column grid and 128 to 156 px between sections are normal grid and section rhythm |

Earlier in the day, other sweeps (console and network, structure and meta,
horizontal overflow at 320/768/1280, tap targets at 375) were also clean apart
from items already fixed in their own PRs.

## Left alone, on purpose

- Hero photos at 800 px on desktop: 10 of 12 need CRM exports from Jo.
- The service pages' left-edge structure at wide widths (see pass 10).
- Phone emoji on the four older CTA bands (needs a markup change).
