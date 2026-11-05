# MRMS MESH radar hail swaths — 2026-11-04

**Status:** built and **dark**. The cron does nothing until Jo sets
`feature_flags/global.meshHailEnabled = true` in the Firebase console (Claude
cannot write production flags). The Mission layout draws whatever days exist,
so turning it on makes the layer appear with no client release.

**Why:** the GitHub repo sweep (`documentation/audit/GITHUB-REPO-SWEEP-2026-11-04.md`,
[PR #2832](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/2832))
second pass found this independently in all three of its sources: the
feature-mining agent, the problem-first agent and Grok. The storm layers so
far are **points**: IEM Local Storm Reports, NCEI SWDI `nx3hail` radar cells,
and NWS warning polygons. NOAA's MRMS **MESH** (Maximum Estimated Size of
Hail) is a continuous ~1 km radar grid. It shows where hail likely fell
*between* the reports, as size bands.

## How it works

| Piece | What |
|---|---|
| `functions/integrations/mesh-hail-logic.js` | Pure. A GRIB2 reader for exactly NOAA's MESH shape (template 3.0 grid, 5.41 PNG packing, 16-bit), a no-dependency PNG decoder (all five row filters), a crop to the service box, and a cell-boundary tracer into polygons with holes for the 0.75 / 1 / 1.5 / 2 in bands. Anything else NOAA might change (template, bitmap, bit depth, scan order) **throws**, so a format change fails loudly and never draws a wrong map. |
| `functions/integrations/mesh-hail.js` | `meshHailCron`, daily 13:20 UTC. It fetches the 24-hour max file valid 12:00 UTC from the public bucket (`s3://noaa-mrms-pds/CONUS/MESH_Max_1440min_00.50/`, keyless, ~350 KB), writes `hail_mesh/{YYYY-MM-DD}` (the UTC day the window ends) with `bandsJson`, `maxIn` and `polygonCount`, and stamps `fetchedAt`. A day with no hail still writes a doc. A missing file writes nothing (no fake "no hail"). The heartbeat goes to the shared `daily-syncs` check. |
| `firestore.rules` `hail_mesh/{ymd}` | Signed-in, non-anonymous users read it (public NOAA data, no tenant data inside). **No client writes**: a rep who could write a day could paint a fake swath over a neighbourhood. |
| `docs/pro/js/hail-mesh-swaths.js` | Turns stored days into `MapView.setSwaths` items: `[outer, ...holes]`, gold below 1.75", red at 1.75" and up (MapView's rule). Every title reads **"Radar estimate (NOAA MRMS) · hail 1"+ · storm day ending Jun 26"**. A bad doc is skipped, and a failed read resolves `[]` so the other layers keep drawing. |
| `docs/pro/js/layouts/mission.js` | `loadMesh()` runs on mount and on Refresh. It reads the last 3 days with one `getDoc` each (no query, so no index) and appends them to the Watch map and to the Route map behind the existing "Hail swaths" chip. |

**Service box:** 38.55–39.75 N, 85.25–83.65 W (Cincinnati metro, NKY and the
nearby Ohio counties). That's 162 × 122 grid cells, decoded in about 0.5 s.

## Validation against real data (outside CI)

- **Geolocation:** MRMS file 2026-04-15 12Z, a big upper-Midwest hail day (WI/MN).
  - **84 of 106** IEM ground reports of 1"+ hail fell inside the 0.75" swath polygons.
  - Shifting the swath 1° east dropped that to **4**.
  - The polygon test and a direct cell lookup agreed exactly (84 = 84), so the tracing loses nothing.
  - That day came to 64 KB of JSON over a box larger than ours. A Firestore doc holds 1 MB.
- **Local:** 2026-06-26 gave a 0.93" peak at 38.685 N / 84.515 W (Boone County). Today (November) is correctly empty.
- **Map render:** the same April day was drawn through the real `NBDMapView` on a throwaway harness page (not committed). All 163 polygons render, including 5 with holes, and the swaths line up with the ground-report dots in the expected SW→NE storm tracks.

## Tests

- `tests/mesh-hail-2026-11-04.test.js` (52 checks, node bucket). It uses synthetic GRIB2/PNG built byte by byte in NOAA's shape, row filters 0–4, and seeded noise.
  - **Shapes covered:** a block with a hole, two regions touching only at a corner, specks dropped, the format-drift throws, file picking, the dark gate (string `"true"` is not on), the end-to-end day with fakes, the client mapper, and the Mission wiring.
  - **Break-tested** with six mutations, all red: saddle turn reversed, holes never attached, Paeth → Up (the shape fixture alone missed this, so the noise check was added), mm offset dropped, flag made truthy, and Average/Sub broken.
- `tests/firestore-rules.hail-mesh.test.js` (26 checks, emulator, its own CI step). It has positive controls.
  - Mutating `write: if false` to `if isAuth()` reddens it, and so does mutating `read: if isAuth()` to `if false`.

## Honesty and compliance

MESH is a **radar estimate**. It can under-state hail in tilted or high-shear
storms and over-state it elsewhere.
- **Canvassing aid only.** Never quote a MESH size to a homeowner or an adjuster as fact. The Kentucky claim-wording rules still apply.
- The map title carries "Radar estimate" and the NOAA attribution NOAA asks for.

## Not done (next, if wanted)

1. **Jo flips `meshHailEnabled`**, then checks for a `hail_mesh/<today>` doc after 13:20 UTC.
2. **Backfill** past storm days by calling `runMeshDay(ymd)` for each date. Only the last 3 days show today.
3. **D2D door-knocking map: DONE** (stacked PR after this one). The Storms layer draws the last 7 days of swaths *under* the report dots and adds a legend line ("Radar hail swaths, last 7 days: N (M at 1.75"+)" · "not a measured size") only when there are some. It never says "no radar hail". Covered by `tests/d2d-mesh-swaths-2026-11-04.test.js` (20 checks, four mutations red). **Storm Center** still uses points only.
4. **Hail-hit stamping** (`hailMatchCron`) could also test leads against MESH polygons, not only report radii.
