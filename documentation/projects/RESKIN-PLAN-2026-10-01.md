# CRM reskin plan — 2026-10-01

## Jo's ask

Jo said:
- "full reskins … not just color options … wallpaper grade complete
  reskins of the CRM … in extreme quality";
- of a competitor's "AI Business OS" CRM he'd screenshotted: "love the look
  … nice and glowy with good color".

## What the code already had

The Repo Lab ([REPO-LAB-2026-10-01](../audit/REPO-LAB-2026-10-01.md)) and
this pilot found that much of the foundation was already
built:

- About 60 color themes (`theme-system.css` and the `theme-engine.js`
  registry).
- `data-density` and `data-shape` settings, independent of color.
- An overlay and wallpaper engine (`theme-overlays.js`) that already
  respects reduced motion.

So a reskin **extends the engine** rather than replacing it. See
`DESIGN.md` → "Appearance engine".

## Why themes only recolored until now

About **4,700 inline style sites** in `docs/pro/js` (166 files) plus **848**
in `dashboard.html` fix spacing, borders, radius and shadow in code:

| File | Inline style sites |
|---|---|
| `document-generator-templates.js` | 336 |
| `vault-page.js` | 209 |
| `expenses.js` | 146 |
| `invoice-pipeline.js` | 142 |
| `widgets.js` | 140 |

Colors mostly flow through tokens; shape and texture mostly don't. A skin
can only restyle what reaches a class or token.

## Plan

1. **Pilot skin: Live Ops** (#1953, opt-in). This is the reference for
   every later skin.
   - A WebGL `shader-gradient` wallpaper overlay: half-resolution, 30fps,
     hidden-tab pause, a still frame under reduced motion, a CSS fallback
     without WebGL, and off in light mode.
   - Frosted cards with cyan edges and glow, uppercase mono labels, and
     glowing rings and bars.
   - Contrast passes AA with a wide margin: `--m` on `--s` is 8.31:1.
2. **Make the most-used screens skin-ready.** Convert inline shape and
   spacing to classes and tokens, highest traffic first: Home widgets,
   Pipeline cards, the customer page, Money, phone nav. Track the count of
   inline style sites as a ratchet so it only goes down.
3. **More skins on the same engine.** Proposed next:
   - **Daylight:** high-contrast for reading a phone on a roof in full sun.
   - **Jobsite:** slate, copper and texture.

   Each skin is a registry entry, a token line, a scoped CSS block and,
   optionally, an overlay.
4. **Design-first for each new skin.** Mock up Home, Pipeline, customer and
   phone views for Jo to react to before building. Figma is connected if Jo
   prefers marking up there.
5. **Quality gates per skin:**
   - contrast (`theme-contrast`);
   - the scoped-CSS pin (each skin's test, like
     `tests/theme-liveops-2026-10-01.test.js`);
   - phone-fit at 412 and 360px;
   - screenshots at 1280 and 390px.

## Open questions for Jo

- Should Live Ops stay in the Professional category or move to Sci-Fi?
- Should Live Ops become the default for Jo's own account once he's used it
  in the field?
- Which skin next: Daylight or Jobsite?
- Tools: no new paid tool is needed. Repo Lab ranks Impeccable as the
  design skill worth trialling, skill only with its hook off, for
  critique and polish passes.

## Update 2026-10-01 (later)

- Step 1 shipped (#1953).
- Step 2 started:
  - `docs/pro/css/ui-primitives.css` took 79 dashboard surfaces off inline
    styles, with a computed-style diff as proof;
  - the inline-style ratchet (#1955) keeps the count falling;
  - Live Ops styles the primitives.
  - Next: `customer.html` and the JS-rendered widgets.
  - 2026-10-02 (batch 4): the 16 document tiles' contents (`.ui-tile-icon` / `-title` / `-sub`) and the 14 Edit Customer labels (`.ui-label`) left inline styles. customer.html is now 315 → 253 inline styles. Zero computed-style diff on 758 elements at 1280 and 390 px; a 1px control moved exactly 16 margin-tops.
  - 2026-10-02 (batch 5): `.ui-page` (6 tab bodies), `.ui-btn-sm` (8 buttons), `.ui-ico-14` / `.ui-ico-13` (14 inline icons) and `.ui-note` (6 notes). customer.html is now 253 → 219 inline styles, with zero computed-style diff. Three estimate-header buttons are governed by `!important` rules (`.est-head-actions > .btn`, `nbd-mobile.css`) that beat the inline style too, so a skin has to restyle those there.
  - 2026-10-02 (batch 6): the skinnable surfaces. `.ui-count` (the 4 jump-nav badges; `display:none` stays inline because `nbdNavCount()` toggles it), `.ui-modal-title` (3), `.ui-sec-title` (2), `.ui-choice` (2), `.ui-pill` (2) and `.ui-label-plain` (3). customer.html is now 219 → 207 inline styles (the 4 badges keep a `display:none` each), with zero computed-style diff. A marker property on all six classes reached exactly 16 elements. What's left is mostly one-off layout (`margin:0`, `flex:1`, single-use spacing), which a skin doesn't need.
  - 2026-10-02 (JS-built, first screen): the product editor modal (`product-library.js` openModal). 38 inline styles became `.ui-label-sm`, `.ui-input` + `.ui-input-box`, `.ui-input-sm`, `.ui-hint` and `.ui-label-strong`, so the fields now follow the Shape presets. Proven IN CONTEXT: signed in on the emulator, `ScriptLoader.loadBundle('estimates')`, `_productLib.openModal()` in add and edit mode at 1280 and 390 px. Zero diff on 135 elements; a marker reached 48. Static dashboard (5,051 elements) and customer (758) also diff clean, apart from animation-timing jitter that main shows against itself. **Lesson:** `.ui-input` already existed (about 10 dashboard fields, Shape-driven). A second `.ui-input` rule with width, padding and a fixed radius would have restyled all of them, and the modal-only diff could not see it. Grep the FULL class list before adding a class, and diff every page that loads ui-primitives.css. A test now pins one `.ui-input` rule.
  - 2026-10-02 (JS-built, second screen): Close Board (`close-board.js` CRM render functions only; the standalone homeowner deal page keeps its inline styles). 19 sites became `.ui-stat`, `.ui-stat-box`, `.ui-field-md`, `.ui-field-xs` and `.ui-caps-label`. Proven in context on all three tabs with animations frozen: zero diff, and a marker reached 4 / 15 / 8 elements. The JS ratchet is now 4101 → 4082.
- Step 4: Daylight and Jobsite are mocked up on the Home screen (the "NBD Pro
  skin candidates" canvas) for Jo to pick.

## Status 2026-10-03 — step 2 progress (JS-built screens)

The JS-screen half of step 2 is now the main track. Each screen gets its
own stylesheet of prefixed classes (for example `wg-`, `rpx-`, `ysx-`),
holding the old inline values exactly. The `docs/pro/js` ratchet went from
**4101 to 2852** on main, and the four PRs still open take it to about 2680.

**Update, end of 2026-10-03:** all 41 screens are merged. The `docs/pro/js` count on main is now **2148** (from 4101). Also merged: [#2083](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2083), which fixes two restyled headings that lost Barlow Condensed and adds the `css-no-js-escapes` guard. The decision-engine multi-line strings (about 12) are the next small pass.

| # | Screen (file) | PR |
|---|---|---|
| 1 | Product editor (`product-library.js`) | [#2001](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2001) |
| 2 | Close Board CRM surfaces | [#2002](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2002) |
| 3 | Expenses | [#2014](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2014) |
| 4 | Storm Center | [#2029](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2029) |
| 5 | Home widgets (`widgets.js`) | [#2030](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2030) |
| 6 | D2D knock tracker | [#2031](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2031) |
| 7 | Customer page panels | [#2040](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2040) |
| 8 | Insurance supplement modal | [#2041](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2041) |
| 9 | Product library | [#2043](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2043) |
| 10 | Customer page panels (second pass) | [#2044](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2044) |
| 11 | Invoice screens | [#2045](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2045) |
| 12 | Money view | [#2051](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2051) |
| 13 | Close Board CRM screens | [#2052](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2052) |
| 14 | Rep OS | [#2063](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2063) |
| 15 | Expenses (the rest) | [#2064](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2064) |
| 16 | Yard signs | [#2065](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2065) |
| 17 | Job Templates (dashboard + customer page) | [#2066](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2066) |
| 18 | Draw tool (`maps-routing.js`) | [#2067](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2067) |
| 19 | CSV lead import | [#2068](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2068) |
| 20 | Message templates manager | [#2069](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2069) |
| 21 | Classic estimate review | [#2070](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2070) |
| 22 | Pipeline cards + follow-ups | [#2071](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2071) |
| 23 | Estimates list, photos, intel card (`dashboard-widgets.js`) | [#2072](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2072) |
| 24 | Voice capture + inbox | [#2074](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2074) |
| 25 | Snooze modals | [#2075](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2075) |
| 26 | Insurance claim panel | [#2076](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2076) |
| 27 | Claim panel + editor (`claim-core`) | [#2077](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2077) |
| 28 | Team manager | [#2078](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2078) |
| 29 | AI texting persona editor | [#2079](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2079) |
| 30 | Job costs & profit panel | [#2080](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2080) |
| 31 | Decision Engine picker | [#2081](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2081) |
| 32 | Storm Center (the rest) | [#2082](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2082) |
| 33 | CSV import + templates manager, multi-line strings | [#2084](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2084) |
| 34 | Past Customers (win-back) | [#2085](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2085) |
| 35 | Reports trends panel | [#2086](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2086) |
| 36 | Voicemail modal (+ the errors-wiped fix) | [#2087](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2087) |
| 37 | Estimate preview sheet | [#2088](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2088) |
| 38 | Snooze modals, multi-line strings | [#2089](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2089) |
| 39 | Dashboard bootstrap surfaces | [#2090](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2090) |
| 40 | Inspection photo editor | [#2091](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2091) |
| 41 | Install-the-app nudge | [#2092](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/2092) |

**The proof, every screen: an in-place swap check.** Sign in on the
emulator and drive the screen through its real states at 1280 and 390 px.
Then, for each element carrying the prefix:

1. Snapshot every computed property.
2. Remove the new classes, put the old inline string back, and snapshot
   again.
3. Restore the element and diff the two snapshots.

Class-sets the states never render are checked synthetically, *inside the
real containers* (for example `#facetList`, a live `.k-card`), so
ancestor-scoped rules apply. A +1px positive control must turn the check
red before a PR ships.

**What stays inline, deliberately:**
- data-driven values (colours from data, computed widths);
- JS-toggled `display:none`;
- every document written into a new window: scope of work, drawing report,
  material takeoff, supplement request, the printed estimate. The page
  stylesheet doesn't exist in those windows, so they use skip ranges in the
  converter.

**Lessons (2026-10-03):**
- Copy CSS values out of JS with the JS escaping removed. A `\'` copied into
  a stylesheet broke `font-family`, and the swap proof compared broken
  against broken, so it stayed green. `tests/css-no-js-escapes-2026-10-03.test.js`
  now guards it.
- Merge-conflict resolvers must strip `\r` and refuse lone CRs. One
  resolver wrote `\r\r\n`, git then treated the file as binary, and the
  result was a whole-file conflict.
- A generated stylesheet's header line must be a real comment. A bare line
  parsed into the first rule's selector and silently dropped that rule
  (Job Templates). The swap proof caught it; a CSS-text test would not have.
- A view opened from `customer.html` needs the stylesheet linked there too.
  Job Templates and the templates manager both open from the customer page.
- Lazy screens take their stylesheet in their ScriptLoader bundle, ahead of
  the script: the Draw tool in `drawtool`, the estimate review in
  `estimates`. A smoke pin anchored on the bundle's first entry
  (`tests/smoke/maps.test.js`) was widened to allow one leading stylesheet.
- `.btn` hosts need a four-class raise, because `body[data-nbd-size] .btn`
  outranks three.
- Check worktrees and open PRs before naming a branch.
  `feat/reskin-home-widgets` already existed (#2030, `widgets.js`), and the
  similar-sounding `dashboard-widgets.js` is a different file.

**Left, by inline count:** the largest remaining files are printed
documents that keep inline styles on purpose:
`document-generator-templates.js`, `inspection-report-engine.js`,
`rep-report-generator.js` and the homeowner `portal.js`. UI candidates still
open: `vault-page.js` (208, check what it is first), `estimate-v2-ui.js`,
`insurance-claim.js`, `lead-snooze.js`, `smart-calendar.js` and the
quick-capture pair.
