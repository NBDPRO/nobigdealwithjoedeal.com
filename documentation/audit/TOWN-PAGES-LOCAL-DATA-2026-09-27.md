# Town pages built on real local data — 2026-09-27

**What changed:** the 43 `/areas/<town>` pages were near-duplicates (the
[SEO/AEO/GEO deep dive](SEO-AEO-GEO-DEEP-DIVE-2026-09-27.md) flagged it as a
doorway-page risk). Each page now carries facts true of that town only, every
one with a source link, stamped from one data file by one generator:

- `site-src/data/towns.json` — the single source (43 towns; ~88 KB).
- `scripts/build-town-pages.mjs` — stamps the regions; `--check` is the CI
  drift gate (`.github/workflows/ci.yml`, next to `build-projects --check`).

## The regions (generator-owned — never hand-edit between the markers)

| Marker | Where | What |
|---|---|---|
| `TOWNWHY` | every area page, inside the "why NBD" section | the four promise cards, 4 phrasings each, *assigned* so no two pages share the same set |
| `TOWNFACTS` | every area page, right after the STORM INFO section | Census median build year + what that typically means for a roof, NOAA storm list (up to 4, newest first, each linked), the permit answer with the issuing office linked, historic review, 1–3 local facts as cards |
| `TOWNFAQ` | every area page, just before `<!-- CTA -->` | 4–5 visible town Q&As + a separate FAQPage JSON-LD block (answers 40–80 words; the generator refuses to stamp one outside that range) |
| `TOWNLOCAL` | `roof-inspection-`, `siding-replacement-`, `siding-repair-<town>` (15 pages) | one "In <Town>:" paragraph inside the local box: build year, permit office, the strongest NOAA event |
| `TOWNSCOPE` | same 15 pages, where the shared "Full Scope" section was | the scope checklist, ordered and annotated per the town's housing era and hail record, + NOAA / permit / historic / tree cards, + a link to the core service page (added by the service-page lane, see the update at the end) |
| `TOWNSVCFAQ` | same 15 pages, where the hand FAQ was | 3 town Q&As (40–80 words) + 2 short generic ones, visible accordion + the page's **only** FAQPage JSON-LD (the hand FAQPage in `<head>` was removed; the generator fails if one reappears outside the region) |

The markers were placed once by a scratch script. A **new area page** needs a
`towns.json` entry and the empty markers (copy them from any existing page);
the generator fails loudly if either is missing. The `<head>`, the existing
JSON-LD blocks, the images and `OURWORK-AREA` were not touched.

## Sources and method

- **Housing:** U.S. Census ACS 2020–2024 5-year, B25035 (median year built)
  and B25003 (tenure), via Census Reporter (the Census API now redirects keyless
  calls). `housing.source` is the Census Reporter profile, linked on the page.
- **Storms:** NOAA NCEI Storm Events bulk files, Jan 2019 – Jun 2026. Events
  whose begin or end point is within `storms.radiusKm` of the town centroid
  (Census 2024 Gazetteer; radius = √(land area/π) + 4 km): hail ≥ 1 in, wind
  ≥ 50 kt or with damage, tornadoes; one per episode + type, ranked tornado >
  hail size > wind speed, top 4 kept. `hailReports` / `hailDays` / `maxHail` /
  `lastHail` count *every* hail report in range, so "no 1-inch hail on the
  record" is only printed when that count is zero. A `basis: "report"` wind
  entry is an NWS damage report carrying the default 50 kt estimate; the page
  calls it a "wind damage report", never a 58 mph gust.
- **Permits:** each town's official page (`permit.url`). `status` is
  `yes | no | unknown | varies`; for `unknown` the page names who to call
  (`permit.ask`) rather than guessing yes or no.
- **Local facts:** official city/county/state pages first, Wikipedia where no
  official page existed. Every fact carries its URL.
- **Copy variety:** every sentence frame has 2–4 phrasings picked by a hash of
  the slug (the why-cards by a max-distance assignment), so the generated text
  is not itself a template clone.

## Before / after (5-gram Jaccard of `<main>` text, nav/footer/script/svg dropped, own town name masked)

| Set | Before mean / max / pairs > 0.4 | After mean / max / pairs > 0.4 |
|---|---|---|
| `/areas/*` (43 pages, 903 pairs) | 0.413 / 0.728 / 439 | **0.157 / 0.307 / 0** |
| `roof-inspection-<town>` (5) | 0.595 / 0.670 / 10 | 0.546 / 0.607 / 10 |
| `siding-replacement-<town>` (5) | 0.504 / 0.529 / 10 | 0.469 / 0.504 / 10 |
| `siding-repair-<town>` (5) | 0.421 / 0.456 / 10 | 0.395 / 0.432 / 3 |

The deep dive measured the area set at 0.45 with a slightly different text
extraction; the numbers above are before/after with the same script. The three
service sets only got the short paragraph the brief asked for — their shared
bulk is the "Full Scope" checklist and the FAQ accordion, a separate lane.

## Claims corrected against the data

- **Mason:** "the 2023 and 2024 spring hail events" — NOAA shows no hail ≥ 1 in
  near Mason in either spring. Rewritten to what NOAA shows (2-in hail near
  Socialville 2020-04-08, 1-in hail in Mason 2023-07-18, EF1 2024-05-07, EF0
  2025-03-30). "Warren County sees some of the most concentrated hail activity"
  removed. `roof-inspection-mason-oh`: "Warren County sees 3–4 significant hail
  events per year" removed.
- **Amelia:** already said "the village that isn't a village anymore"; fixed
  "that decides where your permit gets pulled" (the building permit is Clermont
  County Permit Central either way; the township only sets zoning) and removed
  "Clermont County generates a lot of storm claims".
- **Ranking/frequency claims with no data behind them**, rewritten to the NOAA
  record: Batavia ("ranks among Ohio's top counties for storm claims" — its own
  record has no 1-in hail at all), Lebanon ("some of the highest wind speeds in
  the metro"), Monroe ("some of the metro's most intense storms"), Springboro
  ("above-average storm frequency"), Milford ("one of the more storm-prone
  communities"), Cincinnati ("one of Ohio's most active storm corridors"),
  `roof-inspection-cincinnati-oh` ("5–7 hail events per year"; NOAA: 9 reports
  on 7 days in 7.5 years), Blue Ash ("urban heat" intensification).
- **Wrong direction:** Wilmington ("often sees storms first … gateway for storms
  entering the metro") and Mt. Orab ("first to catch storms moving in from the
  west") — both are east of Cincinnati. West Chester ("catches the leading edge
  before the rest of Cincinnati"). Georgetown ("northern edge of the Bluegrass
  hail track"). All rewritten to their NOAA entries.
- **Checked and left:** Goshen's "2022 tornado" (NOAA: EF2, 2022-07-06, $3.0M);
  Lexington's "most years" (1-in hail in 6 of 8 years); Madeira's 1969 F3 (now
  sourced on the page).

## Caveats (carry these into any rewrite)

- Ohio re-roofs generally need plan approval (OBBS memo 2017-04-04) unless local
  policy treats them as minor repair (Cincinnati, Montgomery County). Kentucky
  leaves single-family permits to local ordinance (815 KAR 7:125), so most KY
  towns are `unknown`, not `no`.
- Design review is `review: true` only where an official page confirms it
  (Cincinnati, Lebanon, Loveland, Springboro, Covington, Newport, Lexington,
  Richmond). National Register listing alone is not roof review.
- NOAA's "DAYTON (HAMILTON Co.)" points are on Eastern Avenue in Cincinnati's
  East End (39.11–39.13 N, 84.44 W); the data labels them that way.
- ZIP lists are by share of land area (≥ 3%), not population.
- Covington and Cincinnati already had an EEAT FAQ block with its own FAQPage;
  they now carry two FAQPage blocks with different questions. Merge them when
  the one-entity JSON-LD lane (#1797) lands.
- ~~Not fixed here, flagged~~ **Fixed later the same day (service-page lane,
  update below):** `hail-damage-maineville-oh` / `-springboro-oh` /
  `-amelia-oh` repeated the "3–4 hail events per year" / "most concentrated"
  framing in body and JSON-LD; `siding-replacement-loveland-oh` said Joe will
  "identify what the insurance policy will and won't cover".

## Updating the data

1. Edit `site-src/data/towns.json` (keep a source URL on everything you add).
2. `node scripts/build-town-pages.mjs`, then `--check`.
3. Run `node tests/claim-wording.test.js` and `node scripts/check-seo-surface.js`
   (FAQ questions must stay visible verbatim).
4. Commit the data file and the restamped pages together.

The NOAA pull stops at June 2026 (NCEI's 2026 file ended there on 2026-09-27).
To refresh storms, re-run the radius search over a newer bulk file and replace
each town's `storms` block; everything else is hand-curated.

## Update 2026-09-27 (later): the town service pages

**Lane:** `seo/town-service-pages-unique`. Same measurement (5-gram Jaccard of
`<main>` text, own town name masked).

| Set (5 pages each) | Before mean / max | After mean / max |
|---|---|---|
| `roof-inspection-<town>` | 0.546 / 0.607 | **0.272 / 0.313** |
| `siding-replacement-<town>` | 0.469 / 0.504 | **0.266 / 0.351** |
| `siding-repair-<town>` | 0.402 / 0.432 | **0.242 / 0.318** |

(The siding-repair baseline reads 0.402 here vs 0.395 above because main moved
between the two measurements.)

**What changed.** The shared "Full Scope" checklist and the four-question hand
FAQ were the bulk of the duplication. Both are now generated (the `TOWNSCOPE`
and `TOWNSVCFAQ` rows in the table at the top):

- The checklist is one list per service, but its **order and per-item notes
  come from the town's Census build-year era** (board vs plywood vs OSB decking,
  box vs ridge venting, flashing generations; for siding: wood /
  asbestos-cement / aluminum / hardboard / builder vinyl, and sheathing type).
  Two towns in the same era get different phrasings (assigned by slug order,
  not hashed). The storm item moves up where NOAA shows hail on 5+ days.
- Cards: the three strongest NOAA events near town with links, the hail line
  (never implies hail where `hailReports` is 0), permits (the re-roof permit on
  inspection pages; a sourced **siding** permit answer on siding pages),
  historic review, and the tree-canopy fact where the town has one.
- FAQ: three town questions (storms / permits / era, 40–80 words each via the
  same `answer()` guard as `TOWNFAQ`) + two short generic ones that link to the
  core service page. The hand FAQPage in `<head>` was removed; the generated
  block is the page's only FAQPage, and the generator fails if another appears.
- New optional `siding` object in `towns.json` (documented in `_about`):
  Cincinnati ("Do I Need a Permit?" lists siding replacement as exempt; the COA
  rule still applies in local districts), Clermont County (its permit list names
  roofing, not siding), Loveland (no siding box on the application; the HPPC
  reviews rehabilitation inside the district). Mason and West Chester have no
  entry, so their pages say no written siding rule was found and name the office.

**Claims fixed.** On the 15 pages: "southwest storm corridor … regular hail"
(West Chester, four places), "Warren County hail events routinely crack…"
(Mason), "the Little Miami River valley's characteristic wind events", "identify
what the insurance policy will and won't cover" and "insurance opportunity"
(Loveland), "claimable", "covered peril under standard homeowners policies" and
the checklist line "Insurance claim assistance" (gone with the generated
FAQ/checklist). Across the other town service sets (74 pages: hail-damage 24,
storm-damage 24, roof-replacement/-repair 19, gutter 5, wood-siding-repair 2)
every numeric-frequency ("3–4 / 5–7 hail events per year", "35+ thunderstorm
days"), ranking ("most active hail corridor", "top counties for storm claims")
and storm-direction ("directly in the path", "hit harder than neighboring
areas", "valley funnels storms") claim was rewritten to that town's NOAA record
in `towns.json`, in body, FAQ (both copies) and meta descriptions. Also:
Blanchester is southwest of Wilmington, not east.

**Claim-wording follow-up (same PR):** hail-damage-wilmington "file without professional advocacy", storm-damage-lebanon "the same level of detail a public adjuster would prepare" and the hail-damage-west-chester FAQ ("walk you through the claim process … navigate this alone") were reworded to the allowed framing, and tests/claim-wording.test.js gained two rules: advocacy-near-claim (claim context in an adjacent sentence; the scanner now passes each sentence its neighbours) and public-adjuster-would. Still worth a human read: hail-damage-maineville "documented and filed Warren County hail claims".