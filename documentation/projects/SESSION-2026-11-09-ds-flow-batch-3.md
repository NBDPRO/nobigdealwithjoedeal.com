# Session 2026-11-09: Daily Success flow batch 3 (Jo's six decisions, safest defaults)

Source: [the UX audit](../qa/daily-success-ux-audit-2026-11-09.md), sections 3, 4 and 6. Builds on [the quick wins](SESSION-2026-11-09-ds-quick-wins.md) and
[flow batch 2](SESSION-2026-11-09-ds-flow-batch-2.md). Jo asked not to be interrupted, so every item that waited on one of his six open questions was built with
the SAFEST default, and each is one line to flip (table below, every flip is proved in the test). Saved-page data keys are unchanged: `nbd_dsp_v1`,
`ms-nonneg`, `floormet-*`, `fit-focus`. Skipped on purpose: M5 (compact mini-bar), M13, and all Tier 3.

## Jo's six decisions: the default chosen and how to flip it

| # | Decision (audit section 6) | Default built | Why it is the safest | Flip it (exact change) |
|---|---|---|---|---|
| 1 | What the app opens to | **(d)** The Dashboard stays the landing view, with an "Open today" card on top and a labelled TODAY tab (no x). `?go=` / `#go=` deep links work. | Same landing view Jo is used to; nothing is created or hidden. The new card and tab are only additions. | **Today always (a):** `js/app.js`, `const DS_OPEN_TO='dash';` becomes `'today'` (opens today's page when it exists; nothing is created at boot). Remove the card: `js/nextup-ui.js`, `DASH_TODAY_CARD = false`. |
| 2 | Cover poster and quote on phones | **(b)** One line on phones (date + quote); poster kept on desktop; the duplicate quote card is gone. | Nothing is hidden, only compacted. The quote text is still on the page once. | **Hide on phones (a):** in `css/flow-batch-3.css`, the single `@media (max-width:768px)` block, add `.cover{display:none}`. **Leave as it was (d):** delete that block. **Bring the second quote card back:** `js/app.js`, `const DS_COVER_QCARD=false;` becomes `true`. |
| 3 | Should finishing things tick floors | **(b)** Ask first: "Workout done. Tick the floor?" with one tap and an Undo. Never silent. | A wrong tick changes the score and the streak; a question costs one tap. Wrong guesses are impossible. | **Auto + "Ticked, Undo" chip (a):** `js/floor-tick-ui.js`, `const FLOOR_TICK_MODE = 'ask';` becomes `'auto'`. **By hand (c):** `'off'`. |
| 4 | Where "jump anywhere" lives | **(c)** Both: a thumb-zone Go button and the header search icon open ONE sheet. | Covers both reaching styles; the two entries share the sheet, so nothing diverges. | **Icon only (b):** `js/quickjump-ui.js`, `const GO_BUTTON = true;` becomes `false`. **Button only (a):** also delete the `data-action="qj-open"` icon button in the `.topbar` of `index.html`. |
| 5 | What the Dash should be | **(c)** Layout untouched; a Today card (floors, Next-Up, Open today) added at the top. | The existing cards are untouched, so nothing Jo relies on moves. | **No card:** `js/nextup-ui.js`, `DASH_TODAY_CARD = false`. **(a) tiles / (b) reorder:** not built (audit L2 / M11 full). |
| 6 | Deleting a day and the SAVE button | **(b)** Delete and SAVE live in the header `⋯` menu (Delete last, danger). Delete is immediate with an 8-second Undo toast; Notebook has "Recently deleted". SAVE stays in the menu. | A mis-tap never costs a day: undo restores the page and clears the tombstone, and the page is kept 30 days on the phone. SAVE is kept for peace of mind. | **Ask before deleting:** `js/app.js`, `const DS_CONFIRM_DELETE=false;` becomes `true`. **Retire SAVE (a):** delete the `data-action="save-now"` line in the `#dsMenu` block of `index.html` (autosave on close already ships, Q3). **Keep Delete on the tabs (c):** re-add a `<button class="tx" data-action="trigger-del-tab" data-tab-idx="${tab.idx}">×</button>` after the label in `renderTabs()` (the handler is still there). |

## Built

| # | What shipped | Where |
|---|---|---|
| Q1 / Q7 | **Open-to.** Dashboard stays the landing view. An "Open today" card sits first in the Dash (`.nu-today`). The unlabeled `+` is a labelled **TODAY** tab: with a page for today it is the Today tab (no x on any tab); without one it reads `+ TODAY` and starts today when tapped. Nothing is created at boot. `?go=today\|floors\|food\|workout\|wrap\|review\|money\|dash` (or `#go=`) runs once at load, then is taken out of the address bar (a reload does not repeat it); an unknown target does nothing; a link that needs today's page creates it, because the link asked for it. The NBD OS floors widget links to `?go=floors` (one link for all its rows, still one tap target), its "Open Daily Success" button and business-only rows to `?go=today`, and the Coach's "you missed your floors" action to `?go=floors`. The dock/app tile is unchanged. | `js/app.js` (`renderTabs`), `js/quickjump-logic.js` (`parseGo`), `js/quickjump-ui.js`, `js/nextup-ui.js`, `docs/pro/js/os/home.js`, `docs/pro/js/os/coach-logic.js` |
| Q8 / Q12 | **Cover.** On screens up to 768 px the cover is one band: date and quote on one line (poster title, eyebrow and corner hidden). Desktop keeps the poster. The orange "Today's Mindset" card (the same quote again) is gone. | `css/flow-batch-3.css`, `js/app.js` (`buildCover`, `DS_COVER_QCARD`) |
| M3 (ask-first) | **Floors are never ticked silently.** The coach finishing, protein crossing its target, a good night's sleep in the check-in (OK or Good, a rough night asks nothing), and the wrap-up saving raise `nbd-ds-did`. `#dsTick` asks "Workout done. Tick the floor?" (or the protein / sleep / wrap-up wording) with Tick it and Not now; a tap writes the same `floormet-<id>` key the manual tap writes, by date (`setFloorByDk`), whichever day or the Dash is open, then offers Undo for 8 seconds. Not now is remembered for that kind and day. Floors are matched by the words in their labels, so a custom "Lift weights" still matches. Protein is watched only for a CROSSING while the page is open (the first number is a baseline). | `js/floor-tick-logic.js`, `js/floor-tick-ui.js`, `js/app.js` (`setFloorByDk`), `workout-coach.js`, `checkin-ui.js`, `eod-ui.js` |
| M6 / M7 | **Jump anywhere.** A Go button (bottom right, 56 px, safe-area padded) and the header search icon open one sheet (dialog, combobox/listbox, arrow keys + Enter, back swipe closes it, Ctrl/Cmd+K opens it; Ctrl/Cmd+F is the browser's again): Next up, Quick add (favourite foods, Start workout, Tick a floor, Weigh-in, Wrap up), Go to (the registry), and as you type Days (`yesterday`, `nov 7`, `fri`, `2026-11-07`, month and name matches) and Notes (text hits **newest day first**, each labelled `Win:` / `Non-negotiable:` / ..., capped at 20 with "Show all"; choosing one lands on the field, flashed). Under the Today bar a chip row (Floors, Food, Train, Body, Wins, Wrap-up, Habits) jumps to each section, opens it, and marks the one on screen. A jump of more than 1.5 screens is instant instead of a long smooth crawl. | `js/quickjump-logic.js`, `js/quickjump-ui.js`, `css/flow-batch-3.css`, `js/app.js` (`scrollToEl`) |
| M11 (minimal) | **Dash Today card.** Layout untouched. The card shows the date, floors met (each floor a 44 px button that ticks on today's page), the Next-Up line and "Open today". | `js/nextup-ui.js` |
| M4 / M10 | **Header `⋯` menu.** The header is one 52 px row at every width (it was two rows, 100 px, on phones): sync chip, search icon, `⋯`. The menu holds Back to the CRM, Save now, New, Rename, CSV, PDF, Appearance, Customize, Guide, and Delete last in danger styling. Delete removes the page at once and shows an 8-second Undo toast (what happened, where Jo landed). Undo restores the page where it was and clears its tombstone; the page also waits 30 days in **Recently deleted** (Notebook, this device, ten at most) with a Restore button. The sync push now writes `deleted:false` so a restored page also clears a soft delete the cloud may already hold. | `index.html`, `js/menu-ui.js`, `js/app.js` (`deletePageAt`, `restoreDeleted`), `js/notebook-logic.js`, `js/notebook-ui.js`, `ds-firebase-sync.js` |
| M1 | **Next-Up strip, every layout.** `#nextup` sits under the Today bar in all eight layouts: "Next: Train - Push day [Go]  3 left". `onething-logic.js` gained a pure `dayPhase(hour)` (morning before 11, field to 17, evening from 17) and `nextUp()`, which adds protein under target, weigh-in (mornings), last night's non-negotiable (before 11), the Sunday review and the wrap-up, reorders by phase (evening puts the wrap-up first), and lets a workout-type floor swallow the separate "workout" candidate. `candidates()` and `nextThing()` are unchanged, so the One Thing layout is the same. On a past day the strip says "Viewing Tue Nov 3" and offers "Back to today". | `js/onething-logic.js`, `js/nextup-ui.js` |
| M2 | **Finish surfaces end with "Next: ...".** The coach summary, the check-in's done card and the wrap-up's saved card end with a primary button naming the next thing (it skips the thing just finished; a finished workout also skips the workout floor). In the coach, Close becomes the secondary button, and the hand-off closes the coach first. Food-add is not a finish surface and was left alone. | `workout-coach.js`, `checkin-ui.js`, `eod-ui.js`, `js/nextup-ui.js`, `css/flow-batch-3.css` |
| Q11 | **Wrap-up moves up after 17:00.** While today's wrap-up is waiting (state `prompt`) the card sits under the Today bar; saved or skipped, it returns to its quiet place below the Daily Log. | `eod-ui.js` |
| Q12 | **Last night carried forward.** An empty "Today's non-negotiable" shows "From last night: <yesterday's answer>" with a Use it button. It never fills the field by itself; Use it types it in and it saves under `ms-nonneg`. Only yesterday counts as last night (`carryForward` in `eod-logic.js`). Next-Up offers the same before 11:00. | `eod-logic.js`, `eod-ui.js` |

Asset versions (`?v=`) were bumped for each changed script; `flow-batch-3.css?v=1` and six new scripts are in `index.html`. `app.js` is loaded without a version, as before.

## Tests (red first)

- New: `tests/ds-flow-batch-3-2026-11-09.test.js` (pure modules in node, then Chromium on the hosting server, a fixed clock for the morning / evening checks). Run before any code
  changed: the five pure-module groups failed on missing files and the first browser group failed and stopped at a null click ("Open today" card absent, tab row still
  `NOV 9, 26x` and `+`). Now **231 passed, 0 failed**, including one check per flip switch above (the test serves each script with the one-line change from the table and
  proves the behaviour flips). Wired in `tests/ci-manifest.json` (wired-individually), `ci.yml` (after the flow batch 2 step) and `FLOORS.disk` (1192 to 1193).
- Updated to the new intent (not weakened): `daily-success-phone-readability` (one-row phone header, menu instead of ten header controls, default offsets), `daily-success-day-layout`
  (Today bar offsets 102 / 198), `ds-quick-wins` (delete is immediate with an Undo toast), `daily-success-sync` (the tombstone is in `deletePageAt`, tab labels still escaped),
  `nbd-os-daily-success`, `nbd-os-ds-business` and `nbd-os-coach` (the links carry `?go=floors` / `?go=today`).
- Green and unchanged: every other `ds-*`, `daily-success-*` and `nbd-os-ds-*` suite including the phone-fit sweep (88 layout x theme x width renders), the dashboard boot-budget test.

## Assumptions

- "Safest default" for decision 1 is (d): the Dashboard stays. The TODAY tab and Open today card are additions only.
- Delete has no confirm box by default (the Undo and Recently deleted are the safety net, per audit M10); the box is one constant away.
- Sleep counts for the floor question only at OK or Good; a rough night does not offer a "Sleep 7+ hrs" floor.
- "Last night" is yesterday only. Recently deleted lives on this device only (it is not synced).
- The chip row and the Next-Up strip scroll with the page (they are not sticky): a sticky mini-bar is M5, skipped. The Go button is always reachable.
- On a phone the header keeps the NBD PRO logo (the way back to the CRM, also in the menu) and hides only the divider.

## Left alone, for the notes

- The old header search bar (`#sbar`, `toggleSearch`, `doSearch`, the `search-jump` action) is no longer reachable from the UI (the icon opens the sheet). It is left in place and
  not deleted; `trigger-del-tab` is likewise an unused handler now.
- `smoke.test.js` fails 8 checks here before and after (missing `firebase-functions` dependency: gbp-reviews, photo-vision, receipt-vision); unrelated.
- The rest bar (`#dsRestBar`) and the toasts share the bottom of a phone: see the review round below (measured at 320 and 360 px, now stacked in one column).
- Not built: M5, M13, Tier 3 (L1 settings sheet, L2 Dash tiles, L3 Siri / home-screen entries).

## Review round (same day): five findings, test-first

Each has a test in `tests/ds-flow-batch-3-2026-11-09.test.js` (section "review fixes"), written first and seen red.

1. **Restored page dropped again by the next pull (medium): fixed.** Undo / Restore now also writes the page id to a device-local marker, `nbd_dsp_restored`.
   `mergePages(local, cloud, tombstones, restored)` keeps a restored page even when the cloud copy still says `deleted:true`; a successful push of that page clears the
   marker; deleting the page again removes it. Saved-page keys are unchanged (`nbd_dsp_restored` is new and device-local; `purgeAccountStorage` clears it like the other `nbd_` keys).
2. **Notebook delete of another page lost unsaved typing (low-medium): fixed.** `deletePageAt` always collects the page on screen first, and a delete of a different page
   leaves you on the page you were on (the open page is found again by identity). Deleting the open page still moves to the one before it.
3. **Protein prompt on page open (low-medium): fixed.** A crossing now needs a user action in the last 3 seconds (typing in a meal field or a tap inside the food card).
   The total filling in when a page opens no longer asks. Cost: none for real use, since both ways of logging protein are those two actions.
4. **Menu keyboard (low): fixed.** Tab closes the menu and leaves focus on the ⋯ button, Home and End jump to the first and last item, and choosing an item returns focus to the
   button (a dialog the choice opens keeps its own focus).
5. **Go button vs toasts (low): measured, partly pushed back.** Stacking was already correct and the toasts did not cover the Go button, but at 320 and 360 px the undo toast and the
   tick prompt overlapped each other when the prompt wrapped to several lines, and a running rest bar covered the Go button (it peeked 6 px above the bar). Fixed: both toasts now sit
   in one fixed column (`#dsToasts`) so they stack, and the Go button hides while the rest bar is up. `.main` bottom padding left as is: the toasts are transient and each has a
   dismiss (Not now, x).

