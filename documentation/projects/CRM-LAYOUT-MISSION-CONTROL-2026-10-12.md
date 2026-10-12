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
| `inst.setSwaths([...])` | `{id, rings:[[lat,lng]..], level: warn/gold/red, title?}` |
| `inst.setRoutes([...])` | `{id, points, color?, dashed?}` |
| `inst.fit() / select(id) / popup(id, domNode) / setTiles(mode) / on(name, fn) / destroy()` | `popup` takes a DOM node, never an HTML string. Events: `pinclick`, `swathclick`, `mapclick` |
| pure exports | `pointInRing`, `levelForHail`, `isDarkColor`, `boundsOf`, `normalize*` |

### Theming

Land is `--bg`; rules `--rule`; route `--orange`; **swaths and hail pins use only
`--red` / `--gold`** (a test pins this) so danger reads the same in every theme.
The OSM tile pane is recoloured by a CSS filter + blend picked from the
luminance of `--bg` (read through a probe element, so `color-mix()` themes
resolve): dark theme = inverted and screened onto `--bg`, light theme =
multiplied. It flips on `themechange`. Hail level: >= 1.75" (golf ball) red,
smaller gold, unknown "warn".

### Tests

`tests/layout-mapview-2026-10-12.test.js` (node bucket): colour parsing and the
dark/light call, point-in-polygon (incl. a concave notch), normalisers, and the
instance against a fake Leaflet (pins/swaths/routes drawn, select, popup, events,
`themechange`, destroy), plus the CSS contract. Break-tested: hail threshold,
keeping `0,0`, a green swath, and the dark fallback each turn a named assertion
red.

## Slice log

| Slice | Status | PR |
| --- | --- | --- |
| M1 MapView | built | this PR |
| M2 L02 Mission Control | not started | |
| M3 #11 job map: crew day route | not started | |
