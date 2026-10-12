# Mission Control + job map lane — build log, 2026-10-12

Lane "mission-control" of the CRM layouts track (D7 in
[CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11](CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11.md);
spec: Grok's Drive docs "NBD CRM custom layouts" L02 and "NBD CRM design ideas"
#11). Foundation and how layouts register:
[CRM-LAYOUTS-LANE-2026-10-11](CRM-LAYOUTS-LANE-2026-10-11.md). Storm Mode and the
`nbd:auto-theme` rule seam:
[AUTO-THEME-AND-STORM-MODE-2026-10-11](AUTO-THEME-AND-STORM-MODE-2026-10-11.md).
One PR per slice; update this note in place as a slice changes a fact below.

## M1 — MapView (shared component)

`docs/pro/js/layouts/mapview.js` + `css/layouts/mapview.css`
(`window.NBDMapView`, `require()`-able). Other layouts (Crew Calendar's day map,
Field Map, Pixel World's town) consume it; a layout lists both files in `needs`:

```js
needs: { script: ['js/layouts/kit.js', 'js/layouts/mapview.js'],
         css: ['css/layouts/kit.css', 'css/layouts/mapview.css'] }
```

### Stack decision (verified on main 2026-10-12)

No new vendor. The CRM already ships vendored Leaflet (`/assets/vendor/leaflet`,
the lazy `mapvendor` ScriptLoader bundle) and already draws OpenStreetMap
street tiles in the draw tool (`maps-routing.js`) and the yard-sign map; both
hosts are in the CSP. MapView is a themed shell over those. The main CRM map is
satellite imagery (ArcGIS / USGS), a photograph that cannot be token-themed, so
MapView's default is OSM **streets** with `sat` as an option and `plain` (a
token grid, no network) for tests and offline.

### API

| Call | Notes |
| --- | --- |
| `NBDMapView.create(el, {center, zoom, tiles, scroll})` | Promise. Loads Leaflet on demand. Resolves `null` (never rejects) if it cannot |
| `inst.setPins([...])` | `{id, lat, lng, kind: job/lead/crew/stop/hail/dot, color, num?, title?, size?}`. `0,0`, blank and out-of-range coordinates are dropped (an un-geocoded lead is not a pin in the Gulf of Guinea) |
| `inst.setSwaths([...])` | `{id, rings:[[lat,lng]..], level: warn/gold/red/turf, title?}`. warn/gold/red are hail danger; `turf` is a crew's area in `--orange` |
| `inst.setRoutes([...])` | `{id, points, color?, dashed?}` |
| `inst.fit() / select(id) / popup(id, domNode) / setTiles(mode) / on(name, fn) / invalidate() / destroy()` | `popup` takes a DOM node, never an HTML string. Events: `pinclick`, `swathclick`, `mapclick` |
| pure exports | `pointInRing`, `levelForHail`, `isDarkColor`, `boundsOf`, `normalize*` |

### Theming

Land is `--bg`; rules `--rule`; route `--orange`; **hail swaths and hail pins use
only `--red` / `--gold`** (a test pins this) so danger reads the same in every
theme. The OSM tile pane is recoloured by a CSS filter + blend picked from the
luminance of `--bg` (read through a probe element, so `color-mix()` themes
resolve): dark = inverted and screened onto `--bg`, light = multiplied.
Hail level: >= 1.75" (golf ball) red, smaller gold, unknown "warn".

Two things learned the hard way (E2E, 2026-10-12):

- **A theme does not decide light/dark.** ThemeEngine resolves the mode from the
  user's mode preference (`ThemeEngine.setModePref`), not the theme's native
  mode. MapView re-reads `--bg` on `themechange` AND `modechange`, and again
  60 / 250 / 650 ms later (a Theme Morph lands tokens after the event).
- Leaflet renderers made for **custom panes** sized themselves to 0 px and
  clipped every polygon away. MapView uses the default overlay pane (swaths are
  added before routes, markers sit above).

### Tests

`tests/layout-mapview-2026-10-12.test.js` (node bucket): colour parsing and the
dark/light call, point-in-polygon (incl. a concave notch), normalisers, and the
instance against a fake Leaflet (pins/swaths/routes drawn, select, popup, events,
`themechange`, destroy), plus the CSS contract. Break-tested: hail threshold,
keeping `0,0`, a green swath, and the dark fallback each turn a named assertion
red.

## M2 — L02 Mission Control

`js/layouts/mission.js` (screen) + `mission-logic.js` (pure, require()-able) +
`css/layouts/mission.css`; registered as layout `mission` (every surface; the
panels stack under the map on a phone). Nothing is added to the blocking boot
bytes: kit, MapView, logic and screen all load lazily, only while it is active
(the boot-budget ratchet passes with the ceilings untouched). It is an overlay on
Home like Focus / Field (hidden on every other view).

| Screen | Built from |
| --- | --- |
| Watch | alert rail (left) = active NWS warnings overlapping the service area; map = swath in --red/--gold, customer pins (in-path ones red/gold by hail size), storm reports; "In the path" (right) = customers whose coordinates sit inside a warning polygon, biggest hail first; bottom = storm timeline with play / scrub over the newest storm's reports |
| Customer | hail at the address (largest warned size over it + nearest hail **report** within 3 mi / 72 h, labelled as weather data, never as damage), next action from today's plan rows then the stage, Call / Text / Navigate / Open / Snooze through the kit ActionBar |
| Canvass | the warned area cut into 1-6 turfs balanced by known doors (customer coordinates + the D2D tracker's knocks), door counts, hit rate from the tracker's own HOT dispositions, per-turf rep name, the door-knock script, and the hand-off DRAFT |

### What it reads (no new vendor, no new endpoint)

- **Warnings**: `NBDStormMode.observeWarnings()` — new, read-only: runs the
  existing Storm Mode observe (weather.gov points + alerts, anchors from customer
  coordinates, no coordinate leaves the browser) and returns the qualifying
  warnings with polygon, hail size, headline, expiry. Works with Storm Mode OFF
  (choosing the layout is the rep asking to see the sky); it never touches the
  theme, the banner or drafts. A failed poll shows "feed unavailable, not an
  all-clear" and keeps the last good list. Before the leads have loaded it says
  so instead of "no warnings" (found in the first E2E run).
- **Reports**: `/api/storm-report` (same endpoint the D2D Storms layer uses),
  centred on the median customer. Playback shows the newest storm's reports
  (12 h window) with its real date; a quiet week is labelled, never faked as live.
- **Knocks**: `window._D2DState.knocks` when the tracker is loaded, else one
  `limit(500)` read of `knocks` (company-scoped for owner / admin / manager,
  own otherwise).

### The context switch (storm-mode.js)

When Storm Mode is ON and a warning is active, the banner gains a **Mission
Control** button: an offer, never an automatic switch. Pure `missionOffer()`
(in storm-mode.js `core`) withholds it when the company locked the layout, the
admin's allow-list hides it, it cannot show on this screen, Storm Mode is off,
the banner was dismissed, or Mission Control is already showing. The tap calls
`LayoutEngine.apply('mission', {source:'storm'})` and saves nothing. The top bar
always shows **Switch back**: when the layout was entered by the storm switch it
is `LayoutEngine.refresh()` (the rep's own resolved layout); when Mission Control
IS the rep's pick it steps out to Classic for the session only. On all-clear, a
layout entered by the storm switch is returned automatically and a toast says so
(the theme restore already works the same way). A manual `refresh()` (resize
across a breakpoint, hydrate) also returns to the rep's pick.

### Decisions and findings worth keeping

- **"Send routes to phones" is a draft, and there is no push to phones.** Nothing
  in the data model carries a turf to another device without a rules change, and
  the D2D territory save path stores GeoJSON `coordinates` (nested arrays, which
  Firestore rejects; see SESSION-2026-08-06-swath-api-setup finding 1 for the
  same trap in `parcel_cache`). **Unverified lead:** `saveTerritory` in
  d2d-tracker-core-2026b.js may never be able to persist a drawn zone; check with
  the emulator before relying on it. So the button builds a plain-text turf sheet
  (draft, "Nothing was sent"), the owner copies and shares it himself, and "Open
  the door-knock map" goes to the existing D2D map. A true push needs a `turfs`
  collection + rules + a Field App card (follow-up).
- **There is no stored door-knock script** in the d2d-tracker data (only
  `SalesTraining.getObjections()`, which the Canvass screen appends when
  present). The five lines are the screen's own, claim-safe wording; the test
  runs them through the claim-wording filter. That filter flagged my first stage
  fallback ("free roof inspection"), now "book an inspection".
- Turf cuts are straight lines across the longer side of the warned area
  (Sutherland-Hodgman clip per band), placed at door quantiles so each turf has a
  similar load. Area is conserved (tested within 1%). With no active warning the
  area is the hull of the newest storm's hail reports of 1" or more.
- Not built: live crew trucks (no real source), a geofence switch to the Field
  App, a push of turfs to phones.

### Tests

`tests/layout-mission-2026-10-12.test.js` (65): in-path (0,0 / deleted / test
leads, largest hail wins, no-polygon covers nobody), hail-at-address range and
age, turf area conservation + door balance + vertices stay in bounds, knock
stats, timeline window / UTC parsing, the offer rules, claim wording (with a
control), registry / lazy assets / "no sender" source guard. Break-tested with 9
mutations, each of which reddens a named assertion; the one survivor ("0,0
counted") got a positive control.

`tests/e2e/mission-control.spec.js` (@shard2, three tests; NWS feed, reports and
tiles stubbed, callable plane aborted so no SMS / email can leave): war room at
desktop with light / dark flips and the swath still `--red`, customer panel,
canvass draft, Switch back; iPhone 390 stacked layout + tap targets + no sideways
scroll; the banner offer, no silent switch, and a company lock removing the offer.

## Slice log

| Slice | Status | PR |
| --- | --- | --- |
| M1 MapView | built | #2356 |
| M2 L02 Mission Control | built, stacked on M1 | see PR list |
| M3 #11 job map: crew day route | not started | |
