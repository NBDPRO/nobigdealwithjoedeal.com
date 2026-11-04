# Daily Success: the notebook (2026-10-25)

**Jo, 2026-10-25:** "treat daily success pages more like a notebook, something closer to what OneNote does in sorting and
filing. Not a forever expanding horizontal slider."

## What changed

- **The tab row no longer grows.** It used to render one tab per page, so a daily habit became a 100+ tab strip that scrolled
  sideways with no scrollbar. It now shows at most five tabs: `Dash` · `Today` (the first page dated today) · the open page
  (when it is not Today) · `Notebook (n)` · `+`. Everything else lives in the notebook.
- **The notebook drawer** (`Notebook` tab, or "Open notebook" on the dashboard's All Pages card) files every page by month,
  newest month first and newest day first inside a month, with the weekday and the day's doors/closes beside each row. The
  current month is open; older months are folded (`<details>`). A filter box narrows by name, date digits, weekday or month. Each
  row switches to that page; the `×` beside it runs the existing delete confirm.
- **The dashboard's All Pages card** uses the same filing (month dividers, newest first) instead of insertion order.
- A dialog in the a11y sense: `role=dialog`, `aria-modal`, focus moves to the open page's row (its month is unfolded first) or the
  filter, Tab stays inside, Escape and the backdrop close it, focus returns to the Notebook tab.

## Files

- `docs/pro/daily-success/js/notebook-logic.js` — pure: `groupByMonth`, `tabSet`, `filterEntries` (no DOM; `module.exports`
  for tests, `window.NBDNotebook` in the page).
- `docs/pro/daily-success/js/notebook-ui.js` — the drawer. Reads app.js's `pages` / `cur` by name (top-level `let`, so not
  `window.*`), calls `switchTo`, `triggerDel`, `smartNewPage`, `tlbl`, `todayKey`.
- `docs/pro/daily-success/css/notebook.css` — drawer, the Notebook tab's count badge, the dashboard month dividers. Theme
  variables only, so it works in every skin and layout.
- `docs/pro/daily-success/js/app.js` — `renderTabs()` builds from `NBDNotebook.tabSet`; the All Pages card maps
  `NBDNotebook.groupByMonth`. `renderTabs` dispatches `nbd-pages-changed` so an open drawer re-files after a cloud merge.
- `tests/daily-success-notebook-2026-10-25.test.js` (34 checks, node bucket).

## Not changed

- The `pages` array and its storage shape (`nbd_dsp_v1`) are untouched: the notebook is a view. `cur` stays an index into the
  array, which is why every entry carries `idx`.
- Phone floors (44 px tabs and rows), the tab `×` hit area and the theme-sweep rules on `.tab .tx` are the same CSS as before.

## Open

- The drawer could remember folded/unfolded months per device (localStorage) if Jo wants it; today it re-derives (current
  month open) on every open.
- A "This week" strip at the top of the drawer was considered and left out: the dashboard already has the week dots.
