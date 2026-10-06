# Wood siding repair — the gap an organic Mason lead walked through anyway (2026-09-03)

**Trigger.** Jo took an organic call from **[street address], Mason, OH**. The
caller said she found him on Google by searching **"wood siding repair"** and then
clicking through *more similar searches*. She sent three photos: rot breaches open
in a painted wood **fascia** board, a closeup of a rot spot beside a gutter hanger,
and a gable corner where fascia has been **wrapped in aluminum coil**.

Jo's ask: *"Let's look at our site and see what is working and what we can do even
better or more of."*

The short version: **she found us in spite of the site, not because of it.** The
word "wood" appears nowhere on any siding page. What worked was the service × city
matrix; what nearly lost the call was that the whole siding surface is written as
if every house in Greater Cincinnati is clad in vinyl.

---

## §1 — What was working (keep doing this)

| Working | Evidence |
|---|---|
| **The service × city matrix put us in the related-search set.** | `siding-repair` is built for only **5 cities** and Mason is one of them (`docs/services/siding-repair-mason-oh.html`). No wood page existed, so Google had to reach us laterally off the siding-repair entity — which is exactly the "more similar searches" path she described. |
| **The Mason cluster is dense and interlinked.** | 8 Mason service pages + `docs/areas/mason-oh.html`, each carrying a "More Services in Mason" grid. |
| **The Mason area page is genuinely local, not boilerplate.** | Names the Mason-Montgomery Road corridor, Kings Mills, Heritage Club and Crooked Tree, and downtown Mason's older steeper-pitch stock. This is the differentiated-content standard the rest of the area pages should be held to. |
| **We already had photographic wood-repair proof — published.** | `montgomery-oh-siding-rot-repair-2026` (painted wood lap siding, rot breaches at two spots, filler + sanded + painted to blend, 5 photos) · `cincinnati-oh-soffit-repair-2026` (two broken soffit boards, cut and painted on the ground first) · `cincinnati-oh-gutter-screens-2026` ("fascia wood included") · `bethel-oh-second-opinion-assessment-2026` (alt text: *"Rotted, delaminating wood trim at a window head on cedar siding"*). |

---

## §2 — The gap, measured

Term coverage across `docs/**/*.html` **before** this session:

| Term | Files |
|---|---|
| `wood siding repair` | **0** |
| `wood rot` · `rotted siding` · `siding rot` · `dry rot` | **0** |
| `fascia repair` | **0** |
| `clapboard` · `T1-11` · `board and batten` | **0** |
| `cedar siding` | 1 — and it is the Loveland *replacement* page |
| `soffit repair` | 1 — the /our-work card, not a service page |
| `wood siding` | 6 mentions on 5 pages, every one incidental |

All 12 siding pages were vinyl-framed. The Mason page's own FAQ said
*"Vinyl siding fades over time"* and *"Mason's builder-grade vinyl."* Its
`serviceType` was `Siding Repair`; the whole scope list was panels, J-channel and
colour matching.

### Three structural findings behind it

1. **Siding is the thinnest service in the matrix.** 12 pages, against 49 roof-*,
   27 storm-*, 27 hail-* and 14 gutter-*. `siding-repair` covers 5 cities;
   `hail-damage` covers 25.

2. **Proof-of-work lived on hub pages only.** The `OURWORK-STRIP` marker existed
   on exactly **8 pages, all hubs** (`scripts/build-projects.mjs` walks every
   `docs/services/*.html`, so city pages were eligible the whole time and simply
   never carried a marker). Every city page — including the one that won this
   call — showed a homeowner zero photographs of finished work.

3. **`STRIP_MAX = 3` hid the wood proof.** The siding-repair strip showed the
   first three `siding-repair` projects in `projects.json` order — Loveland
   peak reseal, Cincinnati third-story, Sharonville gable, **all vinyl**. The
   Montgomery wood rot job was tagged `siding-repair` and never surfaced anywhere
   but `/our-work`.

### The stale doc this contradicts

[`marketing/local-seo-playbook-2026-07`](../marketing/local-seo-playbook-2026-07.md)
names **"cedar siding loveland oh"** as a Search Console query to watch and closes
with *"Loveland cedar capture"* shipped in PR #879. Recon: that capture landed on
`siding-replacement-loveland-oh.html` only. **No siding *repair* page on the site
mentioned cedar at all.** The playbook has been corrected in place with a dated
addendum.

---

## §3 — What shipped

Jo confirmed all four wood categories are work he wants to sell: rotted board
repair/replacement, fascia & soffit, cedar & shake, and wood trim / window-head rot.

**New pages**
- `docs/services/wood-siding-repair.html` — hub. `serviceType: Wood Siding Repair`,
  6 FAQs, full scope list, its own OURWORK strip.
- `docs/services/wood-siding-repair-mason-oh.html` — Mason city page. 6 FAQs
  written to **not overlap** the hub's (hub = service mechanics; Mason = the
  homeowner's situation), so the pair isn't near-duplicate content.

**Taxonomy**
- `wood-siding-repair` added to `SERVICES` in `scripts/build-projects.mjs` (new
  filter button on /our-work) and to `PLAIN_SERVICES` in `scripts/build-sitemap.js`
  (hub → 0.8; `-mason-oh` combo correctly resolves to the tier-1 city at 0.75).
- Three published jobs tagged `wood-siding-repair`: the Montgomery rot repair, the
  Cincinnati soffit boards, and the Bethel second opinion. Both new strips now
  render **real wood work with retail price ranges** instead of vinyl panels.

**The 12 existing siding pages** each got a wood callout box with **per-page copy**
(deliberately not one boilerplate block — [the designer audit](DESIGNER-AUDIT-VERIFICATION-2026-08-15.md)
flagged area-page sameness as a real gap) plus a link into the wood pages. Both
hubs also got a wood FAQ in **the HTML and the FAQPage JSON-LD**.

**First city page with proof.** `wood-siding-repair-mason-oh.html` carries an
`OURWORK-STRIP` marker and links `project-cards.css`. It is the first
`docs/services/*-<city>.html` page on the site to show finished-job photographs.

**Interlinks** — the wood page is now reachable from the Mason grids on
`siding-repair-mason-oh`, `siding-replacement-mason-oh`, `roof-repair-mason-oh`,
`gutter-replacement-mason-oh` and `areas/mason-oh`, plus both siding hubs.
`llms.txt` gained the service lines and the hub entry.

Coverage after: `wood siding repair` **0 → 13 files**, `soffit` 10 → 22,
`fascia` 42 → 53, `cedar` 7 → 14.

### Two defects fixed in passing

- `services/siding-repair.html` shipped `og:description` **and**
  `twitter:description` reading *"Professional **roof replacement** in Greater
  Cincinnati"* — a copy-paste from the roof hub, on the siding page, live. Its
  `twitter:title` was also truncated mid-word (`"…No Big Deal Home S"`). Both fixed.
- The shared hub process module says *"Getting a new roof shouldn't feel like a
  negotiation"* and *"Joe comes out personally, **gets on the roof**"* — roof copy
  on every siding hub. Rewritten on the new wood hub; **still wrong on
  `siding-repair.html` and `siding-replacement.html`** (see §5).

---

## §4 — The content insight worth reusing

The line that unlocked this page, and the one the whole siding surface was missing:

> **Vinyl walls still have wood behind them.**

On virtually every home built in the last 35 years the fascia, soffit, corner
boards and window heads are wood — the vinyl only covers the field of the wall.
That wood is what rots, and it rots *first*, because it is where the gutters, the
roof edge and the flashing all meet. It means "wood siding repair" is not a
niche service for old houses: it is addressable on the entire 1990s–2000s
subdivision stock that the Mason, West Chester and Loveland pages already describe
in vinyl terms.

Second reusable line, and it is a differentiator precisely because it costs us
money: **rot is usually not an insurance claim.** Carriers exclude long-term
moisture damage as maintenance. Saying so on the page, above the fold of the FAQ,
is the same move as the $140 second opinion — and it is the opposite of what every
storm-chaser in the market says.

---

## §5 — Open, and who owns it

**Jo:**
1. **Add the wood services to Google Business Profile.** The site now claims wood
   siding, fascia and soffit repair; GBP does not list them. This is the single
   highest-leverage follow-up — GBP services feed the exact related-search surface
   she came through.
2. **The Mason caller's three photos.** They are a strong /our-work candidate —
   before/after on fascia rot plus an aluminum wrap. They need **consent on file**
   and must go through [PUBLISH-PROJECT](../runbooks/PUBLISH-PROJECT.md)
   (EXIF-stripped re-encoded copies under `docs/assets/`, never a CRM `?token=`
   URL). Not published here; nothing was assumed about permission.
3. Decide on **`Locally Owned — "Goshen, OH — your neighbor"`**, still live on
   6 pages. The [2026-08-18 fix wave](HOMEOWNER-SITE-AUDIT-AND-GOSHEN-FIXES-2026-08-18.md)
   established Jo lives in **Cincinnati** and the warehouse is in Goshen; this
   trust-item survived that sweep and is residency-adjacent in the same way the
   removed copy was. The new wood hub deliberately says *"Owner-operated, not a
   franchise"* instead. Six files, one decision.

**Next session:**
4. **Wood city pages for the tier-1 cities.** ✅ **Loveland shipped 2026-09-03** —
   `/services/wood-siding-repair-loveland-oh`, written from Loveland's own stock
   rather than Mason's: three counties, the Little Miami valley microclimate,
   mature tree cover that keeps north elevations from ever drying, near-grade
   splashback on valley-floor lots, and the **cedar-vs-wood-fiber distinction**
   that is the page's real differentiator (they look alike from the driveway;
   cedar rots where water sits and repairs board by board, wood fiber swells and
   delaminates from the bottom edge and will not hold a patch). Six FAQs, none
   overlapping the hub's or Mason's — 18 distinct questions across the three.
   ✅ **West Chester shipped 2026-09-03** — the newest stock of the three, so it
   leads on something neither of the others could: **on a house this young the rot
   is a missed construction detail, not wood wearing out.** Unsealed butt joints,
   gable trim that went up unprimed on its back, a kick-out flashing left off — and
   the one the area page handed over, that much of Beckett Ridge and Wetherington is
   **on its second roof**, where drip edge gets skipped and gutters get re-hung into
   soft wood. Plus the HOA angle: architectural review boards, and matching an
   approved color rather than a faded wall.
   ✅ **Batavia shipped 2026-09-03** — the oldest stock in the market and the only
   town where the page is about *actual wood siding* rather than trim. Leads on
   **old-growth lumber being better than what would replace it** (which is why a
   century-old clapboard is still there and a 1995 board has gone soft), so the
   honest scope is that sound boards stay. Two things nothing else on the site
   covers: **the exposure** — old boards were milled to whatever the mill was
   running, so a stock width reads wrong from the street and has to be ripped to
   match the actual reveal — and **blown-in insulation plugs**, which wick water
   into the middle of a sound board and give rot in a row of circles rather than
   along the bottom edge. Also talks a village owner *out* of vinyl-over-wood.
   ✅ **Cincinnati shipped 2026-09-03 — the cluster is COMPLETE at all five tier-1
   cities.** The predicted "which era are you in" framing turned out to be the wrong
   one: era diversity is real in Hamilton County but it is not a *reason to call*.
   The actual Cincinnati angle came from two already-published Cincinnati jobs —
   *"one piece of siding worked loose **three stories up**"* and two broken soffit
   boards in the overhang of a **stucco two-story**, with roof protection down before
   the ladders went up. So: **in Cincinnati the wood is not hard to fix, it is hard
   to reach.** Hillside lots put a wall three stories up at the back that is one
   story at the street, and that is why the rot has been left alone. Access is priced
   honestly, protection goes down first, and the page says plainly that a
   ~$700 repair should **not** go through insurance — at or below most deductibles,
   and rot is excluded anyway.

   **The six shipped pages carry 36 distinct FAQ questions with zero repeats**, and
   share nav/footer chrome and essentially nothing else. The per-city angle, so
   Cincinnati does not repeat them:

   | Page | Its angle |
   |---|---|
   | Mason | **Where** the wood is — behind the vinyl (fascia, soffit, trim) |
   | Loveland | **What material** — cedar vs wood fiber, plus valley shade and grade |
   | West Chester | **Why** it rotted — a missed detail, a past re-roof, and the HOA |
   | Batavia | **The wood itself** — old-growth worth saving, exposure, insulation plugs |
   | Cincinnati | **Reaching it** — hillside and upper-story access, protection first, and the deductible answer |
5. **Put an `OURWORK-STRIP` marker on the other city pages.** The mechanism works
   on any `docs/services/*.html` (proved here). ~90 city pages currently show a
   homeowner no photographs. Each needs the marker **and** the
   `project-cards.css` link — the stylesheet is not on city pages today.
6. **Fascia & soffit repair may deserve its own page.** `fascia` now appears on 53
   pages and `soffit` on 22, with two published jobs, but the service has no hub
   of its own — it currently rides inside wood siding repair.
7. **Fix the roof copy on the two siding hubs** (§3) — the wood hub is corrected,
   the originals are not.

---

## §5b — Companion note

The same session found the same shape a third time, in a different service:
[SHED-OUTBUILDING-GAP-2026-09-03](SHED-OUTBUILDING-GAP-2026-09-03.md) — four
outbuilding roofs done and published, zero pages pointing at them. Read together,
the pattern is the real lesson: **/our-work is running ahead of /services.** Jobs get
photographed and published, and nothing goes back to ask whether the site sells the
thing the job proves. Worth a standing check in the weekly sweep: diff the
`services[]` values actually in use on `/our-work` against the `/services/` hub pages
that exist.

## §6 — Gates

All green at baseline and after: `check-js-syntax`, `check-inline-html-scripts`,
`check-image-privacy`, `apply-partials --check --diff`, `build-projects --check`,
`build-sitemap` (dry-run, then `--write`: 218 URLs, +2), `check-site-integrity`
(237 pages, 26,000 internal refs, 0 failures), `check-chrome-governance`,
`marketing-polish-contract` (53 passed).

One mechanism worth recording: **both new pages generate their visible FAQ HTML
from their own `FAQPage` JSON-LD**, so the two cannot drift. The
[2026-08-18 audit](HOMEOWNER-SITE-AUDIT-AND-GOSHEN-FIXES-2026-08-18.md) found
`cincinnati-oh.html` and `covington-ky.html` carrying visible-HTML and JSON-LD
copies of the same FAQ that had drifted into two different wordings. Deriving one
from the other closes that class by construction rather than by review.
