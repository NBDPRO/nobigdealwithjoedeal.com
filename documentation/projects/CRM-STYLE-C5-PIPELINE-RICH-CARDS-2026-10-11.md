# CRM style integration C5 — Pipeline rich cards (2026-10-11)

Slice C5 of the CRM style integration (Grok idea #10, Jo-approved 2026-10-11;
roadmap: the C-track in `CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11.md`, PR #2322).
Lane "habits".

## What shipped

- **A 4th card density, `rich`**, on the existing `setKanbanDensity` /
  `data-density` system (`dashboard-ui.js`). It joins Compact / Comfortable /
  Spacious in Settings > Card Density and in the Tools-menu cycle. The three
  classic sizes render exactly as before: the rich block is `''` unless
  `data-density="rich"`.
- **Card style switch Compact / Rich / Photo** in a strip above the board. Photo
  is `rich` with a banner photo (`data-rich-style="photo"`); the sub-style is
  remembered in `nbd-kanban-rich-style` (same per-device storage as density).
  Tapping the lit button returns to Comfortable.
- **Per card (rich):** roof thumbnail, squares, Insurance / Retail chip, "Hail
  verified" chip (only when `hail-cron` stamped `lead.hailHit`), aging heat bar,
  next step + due, rep avatar. The column count / $ total were already in the
  column header.
- **Board strip:** Open (count, projected $), Weighted (projected $), Going cold
  (count). Going cold is a board filter through `NBDLeadFilters` (name
  `going-cold`); Open clears it. Totals follow what the board shows.

## Where things live

| Piece | File |
| --- | --- |
| Card block, heat/SLA, strip, filter | `docs/pro/js/pipeline-rich-cards.js` (`window.NBDPipelineRich`) |
| Styles (tokens only) | `docs/pro/css/pipeline-rich-cards.css` |
| Hooks | `crm-pipeline.js` buildCard (`richBlock`) + end of `renderLeads` (`afterRender`); `dashboard-ui.js` (`rich`, `nbd:density-changed`) |
| Test | `tests/pipeline-rich-cards-2026-10-11.test.js` |

## Rules the slice keeps

- **Revenue wording:** every figure is pipeline money and says "projected";
  "revenue" stays collected-only. The test fails if the module prints "revenue".
- **Weighted** uses the Forecast panel's own table (`Forecasting.STAGE_PROB`)
  blended with the company's history (`ForecastEmpirical`), so the strip and the
  Home forecast agree.
- **Photos:** the lead's cover URL, else the earliest "before" shot from the
  already-loaded `NBDPhotoCache` bag, using the 200px `thumbUrl` variant (the
  photo style asks for the full image). The module asks `NBDPhotoCache.ensure`
  for at most 60 leads per paint (the cache batches `in` queries); it never mints
  a token URL, never reads Storage, and only http(s) URLs are used.
- **Strict CSP:** external defer file, no inline handlers, one delegated click
  listener, no `style=` attributes (the heat bar is ten `<i>` segments + classes).

## Stage targets (the SLA table) — Jo to tune

The heat bar compares days in stage with a per-stage target. Green under 50% of
the target, gold to 100%, red at or past it ("going cold"). The defaults are mine,
not Jo's: `NBDPipelineRich.SLA` in `pipeline-rich-cards.js` (new 2, contacted 5,
inspected 5, claim filed 10, adjuster meeting 10, estimate submitted 7, cash
estimate / negotiating 7, contract signed 7, permit 14, materials ordered 14,
install in progress 5, collections 30; anything unlisted 7). A per-company
override is a one-line `window.NBDPipelineRich.SLA[stage] = days` today; a
Settings screen for it is not built.

## Boot budget

`dashboard-boot-budget-2026-10-03.test.js` was raised on its own two lines:
+1 local script, +30 KB. The file is read synchronously by `buildCard`, so it
could not be lazy without painting the first board without the strip.

## Verified

Unit test (53 checks, break-tested), `inline-style-ratchet`,
`css-token-resolution`, `crm-theme-contract`, `theme-contrast`, the kanban
suites, `smoke`. Browser: the sample account (`/pro/explore`) in real Chromium at
1440 px and 390 px (iPhone, touch) on the Dark "nbd-original" and Light "paper"
themes: compact / rich / photo, Going cold on and off, no horizontal overflow.

## Not done

- A Settings screen to edit the stage targets per company.
- Drag-to-reorder of rich-card elements, and a rich style for the phone **list**
  view (the list keeps its own card).
- Rep avatars show initials only (no profile photos exist in the CRM).
