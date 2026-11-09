# Blog calendar: 12 Tuesdays from 2026-11-17

Written 2026-11-09 for [CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09](../projects/CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md)
§2 step 4. How a queued post goes live, and the Tuesday / one-per-ISO-week rule, are in
[BLOG-SCHEDULE](BLOG-SCHEDULE.md). Session note: [SESSION-2026-11-09-social-blog](../projects/SESSION-2026-11-09-social-blog.md).

## This is a plan, not a queue

**No post below is in the `POSTS` array, and none should be added there until Jo has read it.** The weekly
scheduled deploy (Tuesdays 09:17 UTC) publishes any future-dated post on its date with nobody watching. Merging a
post's PR is the same as publishing it. So each post:

1. is drafted in its own PR (the post page under `docs/blog/<slug>.html` plus its `POSTS` entry), opened as a
   **draft PR** with the planned date;
2. waits for Jo's read and OK in that PR;
3. merges only after that, and before its Tuesday.

## Rules every post follows

- **One post every Tuesday, never backdated.** The date is the Tuesday below or a later free Tuesday, never earlier
  than the day the post is first committed. If a post misses its week, it moves to the next free Tuesday and the
  weeks after it shift; it never takes an earlier date. `tests/blog-dates-not-backdated-2026-11-04.test.js`
  enforces Tuesday and one post per ISO week for every post dated on or after 2026-11-10.
- **No cost, margin or contractor figures.** None of these posts needs a dollar figure. Retail prices are allowed on
  the site, but leave them out here unless Jo asks for one.
- **Kentucky claim wording.** No post offers to handle, file, negotiate or "help with" an insurance claim, and none
  mentions deductibles. The same rules filter Social Studio captions (`functions/social-claim-wording.js`), so a post
  title that trips them also never gets a "New blog post" share.
- **Job case studies name the town only,** and only for a job that is already public (`consentOnFile: true` in
  `docs/assets/data/projects.json`) or that Jo has ticked for consent in the CRM (`lead.projectConsent.on === true`).
  Never a name, street, house number or photo with GPS. Photos come from the project page's EXIF-stripped copies.
  Leave out the claim and adjuster parts of a project's story.

## The calendar

| # | Tuesday | Type | Working title | Angle | Draw from | CTA |
|---|---|---|---|---|---|---|
| 1 | 2026-11-17 | Seasonal: ice dams | Ice Dams: Why Your Eaves Freeze and What Actually Stops It | Ice dams start in the attic, not on the roof: warm air melts the snow, the eave refreezes it. Heat cables treat the symptom; air sealing, insulation and ventilation treat the cause. What ice-and-water underlayment at the eave does. | [How a Roof Works guide](../../docs/guides/how-a-roof-works.html) (attic airflow, the eave), the "How a Roof Actually Works, Layer by Layer" post, the Blue Ash ventilation project | Text me a photo of your eaves after the next snow and I will tell you what I see. |
| 2 | 2026-11-24 | Job case study | The Thermal Camera Found It First | The Blue Ash, OH job: damp rafter bays found with a thermal camera before anything was opened, then the ventilation fix. Ties back to week 1. | `blue-ash-oh-roof-vents-thermal-2026` in projects.json (public, consent on file), "Why Roofivent Is on My Roofs" | Book a free roof inspection. |
| 3 | 2026-12-01 | Reader question | "Can You Put a Roof On in the Winter?" | Yes, with care: shingle seal strips need warmth to bond, so cold-weather installs get hand-sealing and the right nailing. What changes, what does not, and why a winter schedule can be shorter. | Jo's install practice; the shingle makers' own cold-weather install instructions (GAF, TAMKO) | Get a winter estimate on the calendar. |
| 4 | 2026-12-08 | Seasonal: winter | Gutters Before the Freeze | Clogged gutters hold water at the roof edge, then freeze. Cleaning, screens, and the downspout connection at the base that most people never check. | The gutter projects (`cincinnati-oh-gutter-replacement-screens-2026`, `cincinnati-oh-downspout-connector-repair-2026`), the [siding and gutter buyer's guide](../../docs/guides/siding-gutter-buyers-guide.html) | Ask for a gutter check, or download the guide. |
| 5 | 2026-12-15 | Job case study | Forty-Five Squares, Two Days | The Milford, OH full tear-off: an 8/12 pitch, streaked three-tab off, synthetic underlayment and ice-and-water at the eaves. What a tear-off day looks like from the driveway. | `milford-oh-full-tearoff-replacement-2026` (public, consent on file) | Get a written quote. |
| 6 | 2026-12-22 | Reader question | "My Roof Is Leaking Over the Holidays. What Do I Do Tonight?" | The first hour: catch the water, protect the ceiling, take photos, stay off the roof, call for a tarp. What a same-day tarp is for. | `cincinnati-oh-storm-tarp-replacement-2023` (the same-day tarp only; leave out its claim and adjuster lines) | Call or text me; I tarp the same day when I can. |
| 7 | 2026-12-29 | Seasonal: winter | Snow, Icicles and When to Worry | Most roofs carry normal snow fine. Signs worth a call (sagging, interior stains, big icicles at one spot), and why not to rake or climb with a metal tool. | How a Roof Works guide, week 1's post | Text me a photo if something looks off. |
| 8 | 2027-01-05 | Reader question | "How Do I Compare Two Roof Quotes?" | Same scope or not: tear-off vs. overlay, underlayment, ice-and-water, ventilation, flashing, warranty. Why the lowest number often leaves something out. | The [compare roofing quotes checklist](../../docs/guides/compare-roofing-quotes-checklist.html) | Download the checklist; ask me for a written quote to compare. |
| 9 | 2027-01-12 | Job case study | A 2026 job Jo ticks for consent | The first 2026 job that comes through the consent tick and the photo matcher (plan §1 and §2). If none is ready by early January, use the Newtown, OH steep-pitch job instead: a 10/12 roof, plank decking, why steep work takes longer. | The consented lead's project draft (plan §2 step 2), or `newtown-oh-steep-pitch-replacement-2026` | Book a free roof inspection. |
| 10 | 2027-01-19 | Seasonal: winter wind | Winter Wind and Lifted Shingles | Cold shingles are stiff; a strong gust can crease or lift them. How to spot it from the yard, and why a lifted shingle is a small repair if it is caught early. | The "look up at your roof after a big wind" tip; the Miamisburg, OH wind-damage project (the repair only) | Text me a photo from the yard. |
| 11 | 2027-01-26 | Reader question | "What Is the Difference Between a Shingle Warranty and a Workmanship Warranty?" | Manufacturer coverage vs. the installer's own; what a certified installer adds; what voids a warranty (wrong nailing, missing ventilation). | `docs/assets/data/credentials.json` (GAF Certified, TAMKO Pro Gold, as held), the [home care and warranty card](../../docs/guides/home-care-warranty-card.html) | Ask me which warranty your roof would carry. |
| 12 | 2027-02-02 | Seasonal: spring storm season | Spring Storm Season Starts Now: Photograph Your Roof Before It Hits | Photos of the roof, gutters and siding taken now are your before pictures. The 20-minute walkaround, done in February instead of after the first hail. | The [hail photo baseline sheet](../../docs/guides/hail-photo-baseline-sheet.html), the "Hail Season Prep" post (link to it, do not repeat it) | Download the baseline sheet. |

The mix is three job case studies, five seasonal posts (ice dams, three winter, spring storm season) and four reader
questions, and no two posts of the same type run back to back.

## After a post goes live

Social Studio's Plan N weeks now drafts a "New blog post" share for it on the next Thursday (NBD only, a post live in
the last 21 days that was never shared), read from the deployed `/feed.xml`. Like every Social Studio post, the share
is a draft until Jo approves it.
