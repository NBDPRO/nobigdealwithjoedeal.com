# Manufacturer source links + visualizer guidance — 2026-09-27

Jo's asks (from his iPhone, 2026-09-27): the footer said the name three
times; `/services/gaf-timberline` showed the GAF Certified badge twice in a
row; every product-line page should send people to the manufacturer's own
page and color list ("don't just take my word for it"); and every visualizer
is a simulation — recommend the manufacturer's own tool where one exists.

Branch `site/footer-badges-mfr-links`. What shipped:

- **Footer** — the `NO BIG DEAL` heading and the script tagline under the
  logo are gone from `site-src/partials/footer-extended.html` and
  `footer-blog.html` (51 stamped pages) and from 8 hand-built footers
  (`areas/index`, `the-pledge`, `visualizer`, and the five component pages).
  The logo image already carries both. The homepage (`docs/index.html`,
  hand-authored footer) never had them: its footer is logo + description.
  The `NBD PRO` / `Pro Resources for Contractors` headings on
  `docs/pro/blog/*` are a different brand line and were left alone.
- **One GAF badge** on `gaf-timberline`: the hero copy was removed. The kept
  one sits in "Why it matters you're hiring a GAF Certified roofer", has the
  fuller label and the verify link, and explains what the badge means.
  No other product page repeated a badge back-to-back.
- **"Straight From the Manufacturer" blocks** (`docs/assets/css/mfr-source.css`,
  one shared stylesheet, no inline styles) on gaf-timberline,
  tamko-storm-series, gaf-pivot-boot, roofivent, lumanail, the-nbd-build,
  the-nbd-guarantee, roof-replacement and siding-replacement.
- **Visualizers** — the product pages point to the manufacturer's tool first,
  with ours as the fallback. The /visualizer page has a "Know the brand? Use
  theirs first" band, and a plain simulation disclaimer appears everywhere
  ours is offered in page copy. The /free-tools card wording was also changed.
  The homepage tile was left alone to keep the `landing` visual baseline
  stable.

## Link verification

gaf.com returns 403 to every automated fetch (WebFetch and curl), so the GAF
URLs are **verified via search**: gaf.com-restricted search results show
each URL with the title below. Everything else loaded (200) and the page
content was checked.

| Line | URL | Result | Page title |
|---|---|---|---|
| GAF Timberline NS | gaf.com/en-us/roofing-materials/residential-roofing-materials/shingles/timberline-ns | 403 · via search | Timberline NS Shingles (Natural Shadow) \| GAF Roofing |
| GAF Timberline HDZ | …/shingles/timberline-hdz | 403 · via search | Timberline HDZ: GAF's #1-selling shingle |
| GAF Timberline UHDZ | …/shingles/timberline-uhdz-with-ultramat | 403 · via search | Timberline UHDZ with UltraMat: Class 4 Shingles |
| GAF colors | gaf.com/en-us/plan-design/design-your-roof/shingle-color-guide | 403 · via search | GAF's Guide to Roof Shingle Colors |
| GAF Pivot boot | …/rooftop-accessories/master-flow-pivot-pipe-boot-flashing | 403 · via search | Master Flow Pivot Pipe Boot Flashing \| GAF Roofing |
| GAF visualizer | gaf.com/en-us/plan-design/design-your-roof | 403 · via search | GAF Virtual Remodeler: Roof and Shingle Color Visualizer |
| TAMKO Heritage | tamko.com/heritage | 200 | Heritage Architectural Shingles \| TAMKO |
| TAMKO Titan XT | tamko.com/titanxt | 200 | Titan XT Architectural Shingles \| TAMKO |
| TAMKO StormFighter FLEX | tamko.com/flex | 200 | StormFighter FLEX Polymer-Modified Shingles \| TAMKO |
| TAMKO HailGuard | tamko.com/hailguard | 200 | TAMKO HailGuard |
| TAMKO colors | tamko.com/all-shingles | 200 | Residential Roofing Shingles \| TAMKO |
| TAMKO visualizer | tamko.com/design-studio | 200 | Design Studio |
| HardiePlank | jameshardie.com/product-catalog/exterior-siding-products/hardie-plank-lap-siding/ | 200 | Hardie Plank Lap Siding \| James Hardie |
| ColorPlus colors | jameshardie.com/statement-collection-colors/ | 200 | The Statement Collection \| James Hardie |
| Hardie visualizer | jameshardie.com/hardie-designer/ | 403 (Cloudflare) · via search | Visualize your Siding Project with Hardie Designer |
| LP visualizer | homevisualizer.lpcorp.com/ | 200 (JS app, linked from LP's own pages) | Renoworks app shell |
| Royal vinyl siding | westlakeroyalbuildingproducts.com/siding-and-accessories/royal-siding | 200 | Royal Vinyl Siding \| Lap, Dutchlap, Board & Batten |
| Royal products/colors | …/royal-siding/our-products | 200 | Explore Royal Vinyl Siding Products |
| Royal visualizer | westlakeroyalbuildingproducts.com/design-tool | 200 | Exterior Home Design Tool |
| Polaris vinyl siding | polarissiding.com/traditional-siding | 200 | Traditional Siding — Polaris Siding |
| Roofivent iVent Pipe (PP-1) | roofivent.com/produkt/ivent-pipe-penetration/ | 200 | iVent Pipe Penetration – ROOFIVENT |
| Roofivent iVent ECO | roofivent.com/produkt/ivent-eco/ | 200 | iVENT eco – ROOFIVENT |
| Roofivent iVent ROTO | roofivent.com/produkt/ivent-roto/ | 200 | iVENT roto – ROOFIVENT |
| Roofivent iVent FLOW | roofivent.com/produkt/ivent-flow/ | 200 | iVENT flow – ROOFIVENT |
| LumaNail | lumanail.com/ | 200 | LumaNail - Lumanail |

Links we checked and did **not** use: `jameshardie.com/why-hardie/colorplus-technology`
redirects to a generic page and `/colorplus-technology/` is a 404.
`tamko.com/storm-series` is a 404. `tamko.com/styles/heritage` sends you to a
ZIP-code gate. `virtualremodeler.gaf.com` refused the connection.

## Where the site and the manufacturers disagree

Only the Titan XT sub-line and the Pivot impact rows were changed. The rest is reported here for a rewrite.

- **"TAMKO Storm Series" is our name, not TAMKO's.** It doesn't appear on
  tamko.com, and `/storm-series` returns 404. The TAMKO block now says so in
  Joe's voice. The page title, nav and URL still use it.
- **Titan XT:** the site said "14 colors" and TAMKO lists 20. The sub-line
  now says these are the 14 Joe gets asked about most and links TAMKO's full
  list. Titan XT is UL 2218 **Class 3**, which the site already says.
- **Timberline HDZ:** the site says "22 stocked colors". GAF lists 9
  national + 10 regional + 4 Bold Definition colors (nationwide since
  Jan 2026) = 23. These numbers come from GAF search snippets because the
  page itself 403s. "Stocked" is a local claim, so it was left as is.
- **Timberline UHDZ:** `blog/why-class-4-impact-shingles.html` says "12
  stocked colors" and GAF lists 6. GAF also notes that only UltraMat-labelled
  bundles carry Class 4.
- **Timberline color count:** `blog/gaf-vs-owens-corning-vs-atlas-shingles.html`
  says "Timberline comes in 30+ colors". No single Timberline line comes
  close, so this needs a rewrite.
- **Heritage:** TAMKO's own page contradicts itself — its color slider has 11
  swatches, while its FAQ says "a focused collection of five colors". Don't
  publish a count.
- **Siding:** siding-replacement's copy names Polaris + Royal vinyl, and the
  `<title>` says "Vinyl & Hardie". The block covers all three. Polaris is
  Modern Builders Supply's private-label brand (made by StyleCrest), not
  Alside, and has no visualizer we could find.
- **Pivot boot (fixed here):** GAF says the boot passes a test "modeled
  after" UL 2218 Class 4 and "is not listed or classified for impact
  resistance by any testing agency". The spec row and the compare row on
  `gaf-pivot-boot` said "UL 2218 Class 4"; both now say what GAF says.
- **LumaNail:** "LumaTuff, Inc." (used in our schema and partner credit)
  never appears on lumanail.com. Only third-party sources connect the two
  names. Worth confirming with the supplier.
