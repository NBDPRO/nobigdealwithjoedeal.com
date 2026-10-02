# Search Console near-miss read (2026-10-02)

This is Jo's "Jev" idea from the idea triage: find searches where the site
is close enough to win. Jo set the rule that **Search Console, not
Semrush**, is the source ("forget semrush always use console instead its
free"). Search Console shows *our* queries, positions and CTR. It does not
show competitors' rankings, so this is a near-miss read, not a competitor
gap.

**Source:** the apex URL-prefix property `https://nobigdealwithjoedeal.com/`,
last 3 months, read in Jo's Chrome. **Caveat:** that property only has data
from **2026-09-26** (it was added 09-27; see the search-console-apex-property
memory). That is about a week: 520 queries, about 1,070 impressions, 6
clicks. Read every number as early signal, not trend.

## Already winning (top 4)

| Query | Impressions | Position |
|---|---|---|
| siding replacement montgomery oh | 16 | 3.8 |
| siding contractor montgomery oh | 10 | 3.5 |
| residential roofing miamisburg oh | 9 | 2.9 |
| no big deal home solutions | 11 | 1.6 |

## Near misses: positions 4–20 with real impressions (43 queries)

The near misses fall into five clusters:

**1. Shingle brand comparisons.** This is the largest cluster.

| Query | Position |
|---|---|
| best shingle brand | 7.1 |
| class 4 shingle brands | 8.1 |
| tamko stormfighter flex 4 reviews | 12.5 |
| tamko vs gaf | 14.4 |
| tamko vs timberline | 12 |
| owens corning vs atlas | 14 |
| gaf vs tamko | 18.4 |

The two comparison posts carry the most impressions on the whole site:
- `/blog/gaf-vs-owens-corning-vs-atlas-shingles`: 168 impressions, position
  10, 2 clicks;
- `/blog/gaf-timberline-vs-tamko-storm-series`: 166 impressions, position
  12.5, 1 click.

**2. LumaNail.** "lumanail" is at 5.5 and "lumanail roofing nails" at 5.5.
`/services/lumanail` has 81 impressions at position 8.1.

**3. Insurance questions.** "does insurance cover hail damage" is at 18.3
and "does insurance cover roof replacement ohio" at 6.9. Any edit here must
pass the Kentucky claim-wording rules.

**4. Town plus service:**
- James Hardie siding: West Chester at 9.8, Mason at 14, Loveland at 18.8.
- Roofing: Montgomery at 12.1, Madeira at 10.2, Indian Hill at 11–12.5.
- Fort Mitchell KY: 6.
- Emergency roof repair, Batavia: 4.3.

**5. Free roof inspection:** 5.3 generally, and "free roof inspection
cincinnati" at 11.2.

**Area pages that are seen but not clicked:** `/areas/amelia-oh` has 144
impressions at position 14.1, and `/areas/mt-orab-oh` has 90 at 10.2.
Neither has a click.

## Mason, the hometown, is on page 3–4

| Query | Position |
|---|---|
| roofing contractor mason oh | 31.6 |
| roof replacement mason oh | 32.2 |
| roofing mason oh | 33.6 |
| james hardie siding mason oh | 22.8 |

`/areas/mason-oh` sits at 33.4. Mason already has the *most* content of any
town: an area page plus 8 service pages and a project write-up. Montgomery,
which ranks top 4, has only an area page and two project write-ups. So
Mason's gap is **competition, not missing pages**. More Mason pages won't
fix it. Reviews and Google Business Profile signals, plus real Mason
project write-ups, are the levers.

## Done now

- **`/blog/gaf-timberline-vs-tamko-storm-series`:** the title "Timberline vs
  TAMKO Impact Shingles for Hail Country" never said "GAF vs TAMKO", which is
  how people search (positions 14–18). It is now **"GAF vs TAMKO: Timberline
  vs Impact Shingles for Hail | NBD"**.
  - The H1, og:title and the article's `headline` already lead with "GAF
    Timberline vs. TAMKO".
  - The `llms.txt` line stays as hand-tuned.

## Wait for a month of data, then

- **Re-run** this read around 2026-10-30, with 4+ weeks on the apex property.
- **Then decide on:**
  - the two comparison posts' meta descriptions, if their CTR stays near 0
    at a top-10 position;
  - the Amelia and Mt Orab area pages (they draw impressions, so check what
    they rank for);
  - a "best shingle brand / class 4 brands" answer block on the comparison
    post, which would serve the 7.1 and 8.1 queries.
- **Mason:** project write-ups, and review requests from Mason customers
  (`review-request-nudge` exists).
