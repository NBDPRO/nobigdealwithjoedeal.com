# Town title test + local depth (2026-11-27)

Two changes to the `/areas/<town>` pages, from Search Console data. Linked
from [INDEX](../INDEX.md). Follows [GSC-CONTENT-MERGES-2026-11-26](GSC-CONTENT-MERGES-2026-11-26.md),
which kept the 8 "&lt;Town&gt; Roofer" titles.

**Re-check after 2027-01-15.** Compare each group's impressions, clicks and
average position for the 8 weeks after the change against the "before" numbers
below. Google needs a few weeks to pick up new titles, so don't read it earlier.

## The data (before)

Search Console, apex URL-prefix property, **Sep 26 - Nov 24 2026** (about 2
months; nothing earlier exists in the property). Town pages: 14.8K
impressions, 6 clicks, average positions 20-28.

| Town | Impressions | Avg position | Title before 2026-11-27 |
|---|---:|---:|---|
| Florence KY | 2,181 | 23.8 | Roofing, Siding & Gutters in … |
| West Chester OH | 1,774 | 19.9 | Roofing, Siding & Gutters in … |
| Milford OH | 1,625 | 25.8 | Roofing, Siding & Gutters in … |
| Covington KY | 1,343 | 28.1 | Roofing, Siding & Gutters in … |
| Batavia OH | 1,222 | 14.1 | Roofing, Siding & Gutters in … |
| Amelia OH | 911 | 13.3 | Roofer |
| Cincinnati OH | 805 | 24.6 | Roofer |
| Fort Mitchell KY | 671 | 9.7 | Roofer |
| Indian Hill OH | 637 | 9.8 | Roofer |
| Loveland OH | 538 | 16.1 | Roofer |
| Mt Orab OH | 430 | 10.5 | Roofer |
| Mason OH | 385 | 24.4 | Roofer |
| Montgomery OH | 41 | 13.9 | Roofer |

Example query: "roofing west chester ohio", 257 impressions, 0 clicks.

The 13 towns above make up about 12.6K of the 14.8K. The other ~2.2K is spread
over the remaining 32 towns, whose per-town numbers were **not captured**
(Claude in Chrome was not connected on 2026-11-27). Pull them from Search
Console for the same date range at the re-check, so the small towns' "before"
is read from the same window.

## 1. Title test

**Question:** the 8 "Roofer" towns rank at 9.7-13 (most of them) against 14-28
for the rest. Is that the title, or the towns?

**Change (2026-11-27):** the test towns' `<title>` went from
"Roofing, Siding & Gutters in &lt;Town&gt;, &lt;ST&gt; | NBD" to
"&lt;Town&gt;, &lt;ST&gt; Roofer | Roofing, Siding & Gutters | NBD" (52-57
characters; the same pattern Loveland already uses). Only `<title>` changed:
H1, meta description, og/twitter titles and JSON-LD names are untouched, as on
the 8 original Roofer towns.

**Design: matched pairs.** Each test town is paired with a control town of the
same county or area, similar housing and similar size. Only 5 non-Roofer towns
had numbers in hand, so the big three Jo named (West Chester, Milford,
Covington) are in the test and the other two large ones (Florence, Batavia)
are the main controls.

| Pair | Test (retitled) | Control (unchanged) | Why paired |
|---|---|---|---|
| 1 | West Chester OH (1,774 / 19.9) | Florence KY (2,181 / 23.8) | biggest suburbs, 1980s-90s housing |
| 2 | Milford OH (1,625 / 25.8) | Batavia OH (1,222 / 14.1) | Clermont County, older town centers |
| 3 | Covington KY (1,343 / 28.1) | Newport KY (not captured) | Ohio River cities, pre-war housing |
| 4 | Erlanger KY (not captured) | Independence KY (not captured) | Kenton County suburbs |
| 5 | Fairfield OH (not captured) | Liberty Township OH (not captured) | Butler County |
| 6 | Blue Ash OH (not captured) | Sharonville OH (not captured) | NE Hamilton County |
| 7 | Lebanon OH (not captured) | Springboro OH (not captured) | Warren County |

Known totals: test 4,742 impressions over 3 towns (weighted position ~24.3);
control 3,403 over 2 towns (~20.3). The test side starts heavier and ranks
worse, so read each pair's **change**, not the raw group gap.

Anderson Township was left out: its Roofer title would be 61 characters.

Guard: `tests/town-cta-seo-2026-11-17.test.js` section 5 (`TITLE_TEST` set)
pins the 7 test titles; every other town keeps its pattern.

**At the re-check:** if most test towns gained position or clicks against their
control, roll the Roofer title out to the controls too. If not, the 9.7-13
ranks were the towns, and the titles can go either way.

## 2. Local depth for the 6 towns with the most impressions

Florence, West Chester, Milford, Covington, Batavia and Amelia each got a new
generator-owned section, `TOWNDEPTH` ("Housing stock"), placed just above
"Services Available in &lt;Town&gt;". It comes from a new optional `depth`
entry per town in `site-src/data/towns.json`, stamped by
`scripts/build-town-pages.mjs`. A town without `depth` gets no section; a page
with the markers but no data fails the build.

What it says:

- **Year-built mix** from Census ACS 2020-2024, table B25034 (housing units,
  via Census Reporter): share before 1960, '60s-'70s, '80s-'90s, since 2000,
  and the detached single-family share (table B25024). Then a short read of the
  two biggest eras in roof terms, labelled as a pattern, not a diagnosis.
- **Neighborhoods / local rules**, each with a source link:
  - Florence: the Main Street district (buildings back to the 1840s, once
    "Stringtown") and its Certificate of Appropriateness rule; small roofing
    repairs that match material, design and color are exempt, and roof pitch or
    height changes are barred (Boone County Planning Commission, Florence Main
    Street study, 2022).
  - Covington: West Side-Main Strasse (National Register 1983, 1825-1899),
    Wallace Woods (1983), Austinberg (1987), West Covington (annexed 1916).
  - West Chester: Wetherington (club established 1991, opened 1992, 450 acres);
    township growth 2,545 (1950) to 54,895 (2000).
  - Milford: Promont (1865, National Register 1980).
  - Batavia: the WPA courthouse (dedicated 1936; first courthouse 1829).
  - Amelia: village established 1900, dissolved 2019 (Pierce Township).
- **Jobs posted from that town**: every project in
  `docs/assets/data/projects.json` whose city matches and whose
  `/our-work/<slug>` page exists, with pre-2026 jobs labelled as work from
  before No Big Deal. Florence and Covington have none yet; their section
  points to the nearest-jobs block at the top of the page.

Sources checked but **not used** (weak or wrong): milfordhistory.org is Milford,
*Michigan*; ameliavillage.com is a repurposed domain; Olde West Chester's 1817
platting, Wetherington's 2002 gates, Milford's "three blocks" in 1806,
Batavia's 1842 incorporation and Amelia's never-platted history were only on one
weak source. No public HOA document with roof or shingle-color rules was found
for any of the six towns.

Four of the six (West Chester, Milford, Batavia, Amelia) already had a
hand-written "The &lt;Town&gt; Roofs I Actually See" section. It was left as it
is; the new section adds the Census mix, sources and jobs rather than
repeating its neighborhood notes.

## How to refresh

Census numbers: `https://api.censusreporter.org/1.0/data/show/latest?table_ids=B25034,B25024&geo_ids=<geoid>`
(the geoids are in each town's `depth.built.source`). Edit `towns.json`, run
`node scripts/build-town-pages.mjs`, commit data and pages together.
