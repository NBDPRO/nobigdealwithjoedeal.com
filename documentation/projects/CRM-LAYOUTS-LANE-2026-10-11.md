# CRM layouts lane (Track D) — build log, 2026-10-11

Lane "layouts" of the CRM style integration (plan: Grok's Drive docs "NBD CRM
custom layouts" and "NBD CRM design ideas", ordered in the style-integration
roadmap PR #2322). One PR per slice; this note is the running log and the
reference for how the layout system works. Update it in place when a slice
changes a fact below.

## How the system works (D0)

| Piece | Where | Notes |
| --- | --- | --- |
| Registry + precedence rule | `docs/pro/js/layout-system.js` part 1 | Pure; `require()`-able. `LayoutRegistry.register / resolve / surfaceFor` |
| Engine | same file, part 2 | `LayoutEngine.apply / refresh / saveUser / implement`; fires `layoutchange` on `document` (mirrors `themechange`) |
| Pre-paint stamp | `docs/pro/js/shape-preboot.js` (second block) | Reads `localStorage nbd_layout_resolved` and stamps `<html data-layout>` / `data-tap` before first paint |
| `--tap` token | `docs/pro/css/layout-system.css` | 56px default, 64px with `data-tap="glove"` |
| User setting | `userSettings/{uid}.layout` | `{ id, byDevice:{phone,tablet,desktop}, layoutState:{<id>:…}, glove }`, merge write, `null` clears a device override |
| Company default / lock | `companies/{companyId}/settings/layout` | `{ defaultLayout, defaultByDevice, allowed, locked }` (rules + UI arrive in D2) |

**Precedence (Jo's rule):** locked company layout > the user's choice > company
default > Classic. A layout is only ever picked for a surface it supports
(phone <= 768px, tablet = touch <= 1180px, else desktop). A lock whose pick
cannot show on this screen resolves to Classic, never to the user's choice.
`allowed` hides layouts from the user's choice and the company default but never
hides Classic.

**Classic** is today's dashboard, unchanged: registered with no script and no
stylesheet. Nobody's experience changes unless they, or their admin, choose
another layout.

### Things a future layout author must know

- **Layout stylesheets scope under `html[data-layout="<id>"]`.** The preboot
  writes the sheet as a parser-inserted `<link>` from `<head>` (so first paint is
  not unstyled), which means it lands *before* the base styles in the cascade.
  The attribute prefix is what wins the specificity fight.
- **Lazy assets by convention:** `js/layouts/<id>.js` calls
  `LayoutEngine.implement('<id>', { mount(ctx), unmount(ctx) })`;
  `css/layouts/<id>.css` is linked only while that layout is active.
- **No new script tags.** `tests/dashboard-boot-budget-2026-10-03.test.js` is a
  ratchet: the preboot rides inside the existing blocking `shape-preboot.js`,
  and registry + engine are ONE deferred file. D0 made one deliberate raise
  (+1 local tag, +24 KB), recorded in that test.
- **The budget test measures bytes with LF on CI.** On Windows with
  `core.autocrlf=true` it reads ~90 KB high and fails locally on a clean
  `origin/main` too; compute LF-normalised sizes before believing it.
- `nbd_layout_resolved` is in the `KEEP` set of `purgeAccountStorage()` (a
  device UI preference, no account data) so a sign-out does not flash Classic on
  the next sign-in; `nbd_layout_prefs` is not, and is purged per account.
- A boot read can answer from Firestore's empty local cache; the engine retries
  `fromCache` misses and, when a read *fails*, keeps the cached company lock
  rather than dropping it.

## Slice log

| Slice | Status | PR |
| --- | --- | --- |
| D0 layout foundation | built, in review | see PR list |
