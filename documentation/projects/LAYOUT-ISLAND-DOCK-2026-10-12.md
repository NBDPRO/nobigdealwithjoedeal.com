# Layout L04 — Island Dock (2026-10-12)

Lane "island-dock" of the CRM style roadmap (Grok's Drive doc "NBD CRM custom
layouts", L04). Foundation: [CRM-LAYOUTS-LANE-2026-10-11](CRM-LAYOUTS-LANE-2026-10-11.md).
Registered as layout id `island` (every surface), lazy like Field App and Focus.

## What a rep sees

| Piece | How it is built |
| --- | --- |
| **No sidebar** | `html[data-layout="island"] .sidebar, #mobile-nav { display: none }`. The app header (search, bell, user menu) is untouched — it owns dropdowns and is always dark |
| **Pill nav (top)** | Today / Pipeline / Schedule / Estimates / Calls + **More**, first child of `.content`. Items come from the real sidebar: an entry the sidebar hides for this role (`#nav-<id>.dn`) is not in the pill. Navigation is `goTo()`. Active item is tinted `--og`; "which page is active" follows the sidebar's own `.ni.active` (MutationObserver), so the pill cannot disagree with the app |
| **More** | A sheet that **clones the sidebar's own entries** (ids stripped), so every page the sidebar offers is one tap away and each entry keeps its `data-action` through the app's one delegate |
| **Dock (bottom)** | **New lead** = `openLeadModal()`; **Filter** / **Sort** click the Pipeline toolbar's own `#crmFiltersBtn` / `#engagementSortBtn` (opening the pipeline first when the rep is elsewhere), so the two toolbars can never disagree. Sort shows pressed from `nbd_crm_sort_engagement` |
| **Home** | A giant **In play · projected** number, then a today timeline. Inserted after the Home header inside `#view-home .view-scroll`; the existing Today list below it is unchanged |
| **Pipeline** | The board's columns are swipeable stage lanes: `scroll-snap` (mandatory on touch / phone, proximity on a mouse so drag-and-drop is not fought), one lane per screen on a phone with the next peeking, plus a lane-tab strip (`#nbdIslandLanes`) that follows the scroll |
| **Job view** | `customer.html` opens with a hero image of the house (below) |

### The "in play" number is PROJECTED

It is the same rule as the Pipeline header's `$N pipeline` (crm-pipeline.js
`pipeVal`): every **job** (`NBDJobs.recordsFor`) that is not lost, not won and
not in production, summed on `jobValue` through the one money reader
(`NBDCustomerEstimateRows.moneyValue`, so `"$45,000"` text works). It is **not**
collected revenue and the card says so ("In play · projected", "projected value,
not money collected"); the word "revenue" does not appear in the layout (a unit
test enforces it). The E2E compares the headline to the Pipeline header's own
number as an independent oracle.

### Glass over the wallpaper

Islands are `color-mix(var(--s2) 82%, transparent)` + `backdrop-filter: blur(var(--glass-blur))`
(the Surface-style dial), so they show `--myskin-wallpaper` through the My Skin
layers. **No wallpaper** (`:root:not(.my-skin-wallpaper)`) gives `body` a soft
radial `--glow2` wash on `--bg` so the glass still has something behind it. Pill
and dock are `--s` at 85% with blur. `prefers-contrast: more` drops the glass
(opaque `--s` / `--s2`, a real border, no blur); Reduce Motion (the setting
`data-motion="reduce"` and the OS media query) drops every transition.

### Job view hero (`js/layouts/island-job.js`)

`customer.html` is its own document and does not run the layout engine. A small
deferred script (one tag, no-op unless it applies) reads `nbd_layout_resolved`
— the cache the engine writes and shape-preboot reads — and, **only when this
screen resolved to island**, loads `css/layouts/island-job.css` and makes the
existing `#coverHero` big: the lead's cover photo, else the earliest
inspection / "before" shot, else the earliest photo, from the photo docs the page
already loaded (`window._customerPhotos`). Nothing is fetched and no URL is
minted. The name card floats over its lower edge; panels become islands.

## Decisions

- **Reuse, not fork.** Kit pieces used: `K.icon`, `K.esc`, `K.fromLead`,
  `K.card` (timeline rows), `K.widget` (Today island), `K.bind` (one delegated
  listener for pill + dock). The kit's only nav adapter is the bottom tab bar;
  a pill with an overflow sheet did not fit it, so the nav markup is the layout's
  own (kit.js is shared with the other layout lanes and was not edited).
- **No boot growth.** Registration is one `register()` in the already-deferred
  `layout-system.js` (+~0.5 KB); script, CSS and the job-view script are lazy.
  No ceiling was raised; no new dashboard.html tag.
- **Header kept.** The app header is a hard-coded dark bar with its own
  dropdowns; making it an island would have meant re-theming its inks. The pill
  sits directly under it.
- **Not built:** a per-job hero on pipeline cards (the rich-cards thumbnail
  already does that), drag-reorder of lanes, an offline cache of the hero.

## Gotchas

- The dock uses `position: fixed` and pads `.view-scroll` / `#kanbanBoard`
  bottom by ~100 px so the last row is never under it.
- `.kanban-col` widths are `!important` in three base sheets; the island rules
  win by specificity (`html[data-layout] .kanban-col`), not by order.
- Duplicate-lead guard: an E2E that saves several leads needs distinct phone
  and street per lead or the second save sits behind a "Possible duplicate"
  dialog and `_saveLead` never resolves.
- Local authed E2E: the emulator ports (8080 / 9099 / 5000) are hard-coded in
  `nbd-emulator-connect.js`, so parallel lanes cannot run it at the same time;
  retry until "port taken" clears.

### Update 2026-10-25: the in-play headline and the jobs store

CI run 40168418082 (`@shard2`): the hero read **$21,900** while the Pipeline header read **$24,980**. Both sum
`NBDJobs.recordsFor(window._leads)` with the same stage rule and money reader, so the gap was the jobs
themselves: the hero painted at `_leadsLoaded` (leads alone; `recordsFor` returns the leads as-is until the jobs
have loaded) and nothing repainted it when `NBDJobs.load()` finished, while the bootstrap re-renders the Pipeline
after that load. The $3,080 was the second jobs other specs had left in the shared emulator.

- **Fix:** `jobs-store.js` `load()` dispatches `nbd:jobs-loaded` on the window once the jobs are in; `island.js`
  repaints Home on it (next to `nbd:data-refreshed` and friends). Pinned in `jobs-stage1` and `layout-island`.
- **Spec:** `layout-island.spec.js` now writes its own second job (admin SDK, stamped like the lead) and waits for
  `NBDJobs.loadedAt()` before reading the Pipeline oracle and polls the hero (`toHaveText`) instead of reading it
  once. Passes alone in 34 s. A control run with the hero listener removed still passed locally: with one tenant on
  an idle emulator the jobs land before the hero's first paint, so the spec cannot force the CI ordering; the
  listener is what covers it when the jobs are slow.
- This spec's 3 × 300 s timeout is what has been cancelling `@shard2` at its 25-min cap since the layouts fix.

## Tests

- `tests/layout-island-2026-10-12.test.js` — in-play rule (positive control,
  deleted / lost / won / job excluded, legacy money text), wording, timeline
  states, registration, CSS scoping / tokens-only / glass fallbacks /
  prefers-contrast / Reduce Motion, nothing written or inline, hero pick.
- `tests/e2e/layout-island.spec.js` (@shard2) — desktop 1280, tablet 820,
  phone 390 × one light + one dark theme × with and without a wallpaper;
  headline = Pipeline header; dock actions drive the real buttons; More;
  lanes; job-view hero; Reduce Motion; contrast.
