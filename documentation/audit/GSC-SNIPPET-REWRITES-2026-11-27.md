# Search snippet rewrites for high-impression pages (2026-11-27)

Goal: raise click-through on 11 pages Google already shows a lot, by
rewriting `<title>`, meta description and the og/twitter title and
description. H1s and body copy were not touched. Linked from
[INDEX](../INDEX.md). Follows [GSC-CONTENT-MERGES-2026-11-26](GSC-CONTENT-MERGES-2026-11-26.md).

**Re-check after 2027-01-20.** Pull the same 11 pages in Search Console
(page filter, the 8 weeks after this PR merged) and compare CTR and position
against the baseline below. Judge CTR only; a title change that moves a page
from position 20 to 19 is noise.

## Baseline (Search Console, Sep 26 - Nov 24 2026)

| Page | Impressions | CTR | Avg position |
|---|---|---|---|
| /blog/gaf-timberline-vs-tamko-impact-resistant-shingles (was `-storm-series`, 301 since #3140) | 3,163 | 0.9% | 8.9 |
| /blog/gaf-vs-owens-corning-vs-atlas-shingles | 2,238 | 0.7% | 9.0 |
| /blog/gaf-timberline-hdz-vs-tamko-stormfighter-flex | 1,705 | 1.5% | 10.9 |
| /services/lumanail | 1,385 | 1% | 6.1 |
| /blog/architectural-shingles-vs-3-tab | 1,034 | 0.1% | 19.6 |
| /services/hail-damage-insurance-claim | 881 | 0% | 12.6 |
| /services/roof-repair-covington-ky | 827 | 0% | 26.0 |
| /services/roof-inspection | 686 | 0% | 20.1 |
| /services/gaf-timberline | 663 | 0.9% | 9.8 |
| /blog/why-wont-roofing-suppliers-sell-to-homeowners | 592 | 1.4% | 7.2 |
| /visualizer | 536 | 1.7% | 19.3 |

The baseline for the TAMKO post is the old `-storm-series` URL's numbers. When
re-checking, add up both URLs, because Google may still report some
impressions under the old one.

Expected upside: the page-1 pages (positions 6-11: TAMKO, Owens Corning, HDZ
vs Flex, LumaNail, Timberline, suppliers) are where a snippet change can move
clicks. The three pages at position 19-26 (3-tab, roof inspection, Covington)
mostly have a ranking problem. A better snippet helps once they reach page 1.

## Cannibalization check (nbd-seo-inhouse agent, 2026-11-27)

Before any title changed, the agent checked every page title and H1 under `docs/`. What it found and what we did:

- **TAMKO post vs HDZ-vs-Flex post vs services/tamko-impact-resistant-shingles.** The TAMKO post now leads with the brand pair "GAF vs TAMKO Shingles". The HDZ post leads with the model pair "Timberline HDZ vs StormFighter Flex". Neither leads with "impact-resistant", because the TAMKO service page owns that phrase. The TAMKO post's description still names StormFighter Flex, because `seo-gsc-titles-2026-10-07` pins it.
- **LumaNail vs blog/why-i-install-lumanail-on-every-elite-roof.** "Why I Use Them" came out of the service page title. The blog owns that angle. The service page now describes the product.
- **Hail hub vs the 30 storm-damage-&lt;town&gt; pages, the claim guide and the claim blogs.** The title uses "Inspection & Claim Documentation". It does not use "Repair" (the town pages own that), "how to file" (the guide and the blogs own that), or any wording about outcomes.
- **Roof inspection hub vs /inspect ("Free Roof Inspection").** The description no longer starts with "Free", so it doesn't compete with /inspect. The title keeps the region pattern that `seo-hub-vs-town-2026-10-06` pins.
- **GAF Timberline service page vs blog/why-class-4-impact-shingles.** The "Class 4 earns an insurance discount" line came out of the description. The Class 4 post owns that topic, and the line leaned toward an insurance outcome.
- **Flagged, not changed:**
  - services/storm-damage-covington-ky's title ("Hail & Storm Damage Roof Repair in Covington, KY") contains the exact string "Roof Repair in Covington, KY". Whether to change it is Jo's call.
  - /inspect vs the roof-inspection hub for "free roof inspection". Pull the page+query split in GSC first.

## Before / after

Titles are measured with " | NBD" included. Descriptions run 148-155 characters.

| Page | Before | After |
|---|---|---|
| TAMKO post | GAF vs TAMKO: Timberline vs Impact Shingles for Hail \| NBD | GAF vs TAMKO Shingles: Timberline or Impact-Rated? \| NBD |
| | GAF Timberline vs TAMKO Titan XT, StormFighter Flex and HailGuard: wind, Class 3 vs Class 4 impact, and warranties, from a roofer certified with both. | GAF Timberline vs TAMKO StormFighter Flex, Titan XT and HailGuard: wind, Class 3 vs Class 4 hail ratings and warranties, from a roofer certified with both. |
| GAF vs OC vs Atlas | GAF vs Owens Corning vs Atlas: Best Shingle Brand? \| NBD | GAF vs Owens Corning vs Atlas Shingles: 2026 Guide \| NBD |
| | GAF vs Owens Corning vs Atlas from a Cincinnati roofer: wind ratings, warranties, Class 4 impact lines, and the shingle brand I actually recommend. | Which shingle brand is best? A Cincinnati roofer compares GAF, Owens Corning and Atlas on wind ratings, warranties and Class 4 lines, and picks per job. |
| HDZ vs Flex | GAF HDZ vs TAMKO StormFighter Flex: A Roofer's Review \| NBD | Timberline HDZ vs StormFighter Flex: A Roofer's Review \| NBD |
| | A reader outside hail country asked me: GAF Timberline HDZ or TAMKO StormFighter Flex? Looks, warranty, wind and hail ratings: a roofer's honest review. | Timberline HDZ or StormFighter Flex? If hail isn't your problem, don't pay for the hail solution. Looks, wind, impact rating and warranty, compared. |
| LumaNail | LumaNail Orange Roofing Nails: Why I Use Them \| NBD | LumaNail Orange Roofing Nails: Ring-Shank, UV-Reactive \| NBD |
| | LumaNail is the orange, ring-shank, UV-reactive roofing nail. Why it's standard on every NBD Elite roof: if you can't see the nail, you can't check it. | LumaNail is the orange, ring-shank, UV-reactive roofing nail. How it works, why a bad nail shows before the next course, and if it affects your warranty. |
| 3-tab | Architectural vs 3-Tab Shingles: Real Cost Difference \| NBD | Architectural vs 3-Tab Shingles: Cost & Wind Ratings \| NBD |
| | What architectural shingles actually cost vs 3-tab, and when the upgrade genuinely matters — straight answers from a Cincinnati roofer. | Architectural vs 3-tab shingles from a Cincinnati roofer: 60-70 vs 110-130 mph wind ratings, the real price gap, and when the upgrade actually pays off. |
| Hail hub | Hail Damage Claim Inspections in Greater Cincinnati & NKY \| NBD | Hail Damage Roof Inspection & Claim Documentation \| NBD |
| | Hail damage inspection and claim documentation in Greater Cincinnati. Joe documents the damage, meets your adjuster after you file, and writes supplements for you to send. | Think hail hit your roof? Free inspection in Greater Cincinnati and NKY: every hit photographed and measured, so you can decide whether to file a claim. |
| Covington repair | Roof Repair in Covington, KY \| NBD | Roof Repair in Covington, KY \| Free Leak Inspection \| NBD |
| | Roof repair in Covington, KY. Free leak inspection, flashing & shingle repair. Flat and low-slope roof expertise. Kenton County. Call Joe: (859) 420-7382. | Roof leak in Covington, KY? A free inspection finds the source: flashing, shingles or the flat sections on older rowhouses. Honest repair-or-replace call. |
| Roof inspection hub | Roof Inspection in Greater Cincinnati & Northern KY \| NBD (unchanged: test-pinned region pattern) | same |
| | Roof inspection across Greater Cincinnati and Northern Kentucky: I get on the roof myself and give you an honest verbal assessment. Photo report $150. | Roof inspection across Greater Cincinnati and Northern Kentucky: I get on the roof myself, photograph every concern, tell you straight. Free; report $150. |
| GAF Timberline | GAF Timberline NS · HDZ · UHDZ — Every Color & Spec \| NBD | GAF Timberline Colors & Specs: NS vs HDZ vs UHDZ \| NBD |
| | A GAF Certified contractor's deep dive on Timberline NS, HDZ, and UHDZ — colors, warranties, and when Class 4 earns an insurance discount. | GAF Timberline NS vs HDZ vs UHDZ: all 23 HDZ colors, wind and Class 4 ratings, and the System Plus warranty, from a GAF Certified Cincinnati roofer. |
| Suppliers post | Why Roofing Suppliers Won't Sell You Shingles \| NBD | Can Homeowners Buy Shingles From a Roofing Supplier? \| NBD |
| | He tried to buy TAMKO HailGuard himself — SRS and QXO don't carry it, and ABC Supply is account-only now. Why distributors went contractor-only, explained. | Mostly no. ABC Supply is account-only now, and SRS and QXO don't carry TAMKO HailGuard. Why distributors went contractor-only, and what to do instead. |
| Visualizer | AI Home Visualizer \| See Your New Roof & Siding \| NBD | Free Roof & Siding Visualizer: See Colors on Your Home \| NBD |
| | Upload a photo of your home and see what new roofing, siding, or gutters would look like — before you spend a dollar. Free Roof Visualizer from No Big Deal. | Upload a photo of your house and preview new shingle, siding and gutter colors with AI. Free, no signup, any brand, plus links to GAF and TAMKO tools. |

og:title and twitter:title follow the new title without " | NBD". The hail hub and roof inspection pages keep a longer region-suffixed version. og:description and twitter:description match the new description, with two exceptions:
- the TAMKO post keeps its own social line;
- the suppliers post keeps its story-led og title ("He Tried to Buy His Own Shingles"), and its twitter description now matches the og description.

Every number and fact in the new copy is already on the page itself:
- the 60-70 / 110-130 mph wind ratings;
- the 23 HDZ colors;
- "no signup" on the visualizer;
- the $150 report;
- the flat sections on Covington's pre-war rowhouses;
- the ABC/SRS/QXO findings.

## Out of scope (other open work)

- All `/areas/*` pages, because the #3300 title A/B test is running on them.
- `services/roof-replacement`.
- `interior-repair`, `roof-inspection-cincinnati-oh` and `commercial-roofing` (#3298, #3302).
- The homepage.
