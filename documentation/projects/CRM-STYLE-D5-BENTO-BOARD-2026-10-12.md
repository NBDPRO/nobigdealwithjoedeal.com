# CRM style D5 — L01 Bento Board (2026-10-12)

Lane "bento" of the layout roadmap
([CRM-LAYOUTS-LANE-2026-10-11](CRM-LAYOUTS-LANE-2026-10-11.md) has the layout
system this plugs into). One PR. Home as a board of tiles the rep arranges.

## What it is

`docs/pro/js/layouts/bento.js` + `docs/pro/css/layouts/bento.css`, registered as
layout `bento` in `layout-system.js` (every surface; needs the D1 kit; lazy — no
new `<script>` tag, no boot-budget change). Classic Home is untouched; nobody
sees this unless they (or an admin) pick it in Settings > Appearance > Layouts.

| Tile (id) | Built from | Honest label |
| --- | --- | --- |
| `revenue` | `NBDWidgets.WIDGETS['revenue-month']` | Revenue · **collected** (invoice payments by payment date) |
| `pipeline` | `pipeline-value` widget | Pipeline · **projected** |
| `closerate` | `win-rate` widget (`NBDNumbers.closeRate`) | Close rate |
| `today` | adopts the `#todayPlan` node (today-home.js keeps painting it) | Today list |
| `schedule`, `tasks`, `storm`, `hot`, `stale`, `closeboard`, `funnel`, `activity`, `estimates`, `floors`, `sources`, `northstar` | the matching `widgets.js` registry entries, unchanged | their own names |
| `hail` | native: leads with a `hailHit` stamp (hail-cron), top 4 by size | Hail near customers |
| `map` | native: count of leads with lat/lng + "Open the map" | Map |

Each tile is rendered through the shared `NBDLayoutKit.widget()` wrapper, so the
numbers can never disagree with the classic Home. Tile bodies get the widget's
own `wb-<id>` element id (so `nbd:today-rendered` and the revenue re-render
paths keep working); the classic `#widgetGrid` is emptied while Bento is
mounted so ids are not duplicated, and rebuilt (`NBDWidgets.render()`) on
unmount.

## The board

`{widgetId,x,y,w,h}[]` on a 4-column grid, rows 160 px. `NBDBentoLogic` (pure,
unit-tested) owns it: `sanitize` (unknown/duplicate/over-cap/out-of-range),
`pack` (no overlap, gravity; the moved tile keeps its row and the others work
around it), `moveTo/moveBy`, `resizeTo/resizeBy` (per-tile min..max),
`swapOrder` (phone reading order), `add/remove/available`.

- **Phone**: two columns in reading order (y then x); width >= 2 is full width.
  Left/Right in edit mode become earlier/later.
- **Edit board**: per-tile buttons (move, +W/-W/+H/-H, remove) and, on a
  focused tile, arrow keys (Shift = resize, Delete = remove) — the keyboard path
  is primary. Pointer drag (desktop/tablet only) is the convenience. Moves are
  announced in a polite live region. "Add a tile" opens the drawer.
- **Saved** per user at `userSettings/{uid}.layout.layoutState.bento` through
  `LayoutEngine.saveUser` (debounced 700 ms, flushed on Done and on unmount).
  "Reset my board" writes `null`, which falls back to the company default, then
  the built-in one.
- **Company default** (owner / company_admin): "Save as company default" writes
  `companies/{id}/settings/layout.defaultWidgets.bento`. Precedence for the
  board: own saved board > company default > built-in default. A locked company
  layout still wins over the *layout* choice as before (that lives in D2).

## Engine / rules changes (small, generic)

- `normalizeCompany` now carries `defaultWidgets` (<= 8 layouts, each a list of
  <= 24 tiles, <= 4000 chars JSON). **`saveCompany` used to rewrite the doc
  without it** — it would have wiped the board on the next picker save; it now
  carries it forward when a patch omits it.
- `firestore.rules` `layoutDocOk()`: `defaultWidgets` is a map of <= 8 keys and
  `bento`, when present, a list of <= 24. Section 61 of
  `tests/firestore-rules.test.js` gained 9 checks (admin / solo owner allow; rep,
  manager, other-company admin deny; 24 allowed / 25 denied; non-list and
  non-map denied; > 8 layouts denied).

## Tests

- `tests/layout-bento-2026-10-12.test.js` (node bucket): registry, catalogue
  (wrapped ids exist; money labels honest, with a control that the label check
  can fail; the wrapped revenue widget really reads `collectedBetween`), board
  math incl. a 400-step deterministic random walk that must never overlap or
  leave the grid, company default shape, CSS has a class for every emittable
  position, scoped/tokens-only/no inline style, browser half writes only through
  `LayoutEngine` and sends nothing.
- `tests/e2e/bento-board.spec.js` (@shard2): desktop + 390 px, a light and a dark
  theme, Reduce Motion — see the PR for the run.

## Not built / follow-ups

- **Lead view as a bento** (photos / claim / timeline / documents): left as a
  follow-up. The customer page is its own document (`customer.html`) with its
  own tab system; reusing this grid there is a different integration, not cheap.
- "Hail near customers" reads the `hailHit` stamp hail-cron already writes; it
  does not run a fresh storm search (that is server-side, `storm_near_customers`).
- No bento thumbnail in the picker (it shows the generic one) — picker.js is
  shared with the other layout lanes; add a `THUMBS.bento` when they land.
- Tile sizes are a cell grid, not free-form; a tile's content scrolls inside it
  when it is shorter than its widget wants.
