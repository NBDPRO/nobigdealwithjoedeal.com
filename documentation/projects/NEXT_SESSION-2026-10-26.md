# NEXT_SESSION - 2026-10-26: the overnight site program, the Grabber audit, the Life of a Roofer art adapter

**Session of 2026-10-26 (Jo's "keep working on the site overnight", then the Grabber asset audit).** Continues
[NEXT_SESSION-2026-10-25](NEXT_SESSION-2026-10-25.md); its Needs Jo list still stands except where marked below.

## Where things stand

- **Site fixes, all merged through the queue:** the seven wave-1 PRs (#2746, #2748 to #2753), #2756 (CRM dialogs follow the
  keyboard contract), #2758 (`/storm-report` says so when the lookup failed), #2762 (invisible blog callout links),
  #2763 (six duplicate stylesheet links; retires the R1-10-1 / R1-10-2 pins), #2764 (`/inspect` error under the first bad
  field), #2765 (Active Leads counts open deals only), #2766 (`#DD875F` for stat numbers and headings on navy). The full
  finding list, and what is still open, is in
  [OVERNIGHT-SITE-PROGRAM-2026-10-26](../audit/OVERNIGHT-SITE-PROGRAM-2026-10-26.md).
- **Jo's calls this session:** Active Leads = open deals only; brand orange text on navy becomes `#DD875F` (orange on
  light backgrounds stays `#BD5728`); the 69 KB latin-ext font on `/review` stays (one "ș").
- **Held for Jo:** #2755 (sample-account dashboard panels, Call Center banners, CRM-6), the draft docs PR #2754, and the
  copy and insurance-wording findings (copy-001 to copy-010).
- **CI notes:** `Pro demo zero-network walk` cap raised 20 to 30 min (#2761 earlier). When several PRs queue together each
  one dequeues on a `MERGE_CONFLICT` as the others merge, because they all append a line at the tail of
  `tests/ci-manifest.json`; register a new test mid-array instead (anchor index differs per PR). A `KNOWN BUG` pin must be
  removed in the PR that fixes the bug. A regex test that pins an exact CSS form (`color:var(--orange-light)`) breaks on a
  fallback form (`var(--orange-light,#dd875f)`); widen the pin.

## Grabber (the visuals and story designer)

- The audit of all his Drive deliveries is done (13 areas, 306 families, a ledger with 14 decisions for Jo). The decisions
  that gate anything public: the unlicensed lightning wallpaper in Pixel World v11, the release approval (every
  LICENSE-ART says not for public release until Jo approves), the save format, and the CRM placement.
- **Life of a Roofer** (private repo `jdealtia-sys/life-of-a-roofer`): draft PR #2 (`claude/art-adapter`, stacked on #1) teaches
  the engine Grabber's real formats: the atlas loader (drawScale, pivots, the left-facing row, slices, alternates,
  sheets, portraits; all 282 real atlas JSON files load) and the Tiled map and tileset parser (all 66 maps load). One
  rules test was made deterministic (a past client timestamp instead of `Timestamp.now()`). **Not built, waiting on Jo's
  go-ahead on usage:** the import tool and lock, stage rendering, the UI and HUD, the gallery, the coverage guard, and
  registering Grabber's enemy kinds in the sim (only arenas 1-B and 4-B boot as shipped).
- **CRM games prototype** (Pixel World v11 and Roof Rep v6): the workflow is stopped and can be resumed; never merged
  without Jo; the wallpaper is stripped.
- Grabber is still working. An hourly Drive check reports only what is new (last seen: `TOWNS.md` at 20:20 UTC, the
  other towns' lines and the 17 overworld nails, 48 nails in all). Read `PICKUP-FOR-CODER` and `B22-CODER-HANDOFF`
  before any art work.

## Next, in order

1. Answer the open decisions (Needs Jo above, and the Grabber decisions).
2. If Jo agrees to the usage: the Life of a Roofer import tool and stage rendering.
3. Small safe site items remain only where marked "candidates" in the overnight note (perf-4 is the cheapest).
