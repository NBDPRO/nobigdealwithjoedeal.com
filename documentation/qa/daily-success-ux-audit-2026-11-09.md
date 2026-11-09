# Daily Success: layout, flow and navigation audit (2026-11-09)

Scope: `docs/pro/daily-success/` (the shell in `index.html`, `js/app.js`, `css/*.css`, the feature modules, and `ds-firebase-sync.js`), plus the NBD OS links into it (`docs/pro/js/os/home.js`, `coach-logic.js`). This audit was read-only and no repo files were changed. Six review passes (render, layout, flow, wayfinding, control, quick-nav) produced 120+ raw findings, which merge into the 47 below. Items already fixed or decided in the 10-21, 10-22 and 10-25 notes are marked where they come up again, not re-reported as new.

---

## 1. What it feels like today

1. Every time Jo opens the app it lands on the Dashboard. The first screens show Floor Streak, Money, Weight and "Download my data". Today's floors start about 2,000px down, and on a new morning there is no "Today" tab at all, only an unlabeled `+`.
2. On the day page, the first screen and a third go to a poster cover, the same quote printed twice, and the week strip. The page then runs 8 to 9 screens with no index, and the sticky status bar (floors, calories, protein, workout) looks tappable but does nothing.
3. In the default Classic layout nothing ever says "do this next". The app already has that logic (the One Thing engine), but only the One Thing layout shows it.
4. Finishing something leads nowhere. After a workout the score still reads 0/5 floors, and the coach ends on a plain "Close". At 7 pm the wrap-up sits at the bottom of the page, and last night's "tomorrow's non-negotiable" is gone the next morning.
5. On an iPhone the fixed header, tabs and Today bar take 29% to 37% of the screen. Rare and destructive actions (Delete, CSV, PDF) sit in the top strip, half scrolled off the edge. Tapping almost any text field zooms the page sideways.
6. Search finds only typed note text, oldest first. It cannot take Jo to the coach, Money, the weekly review or "yesterday". A hit opens the right day scrolled to the top with the match folded away. The iOS back swipe leaves the app entirely.
7. "● SAVED" means saved on this phone only. Edits can sit unsaved for 30 seconds, failures flash as green success toasts, and the offline pill covers the save status. On a roof with weak signal Jo can't tell what is actually safe.

---

## 2. Top themes

### Theme A: The app never points Jo at the next step of his day
D01 (boots to Dash), D02 (no today page or entry), D03 (no Next-Up in Classic), D04 (completions don't tick floors), D05 (dead-end completions), D06 (wrap-up buried at night), D07 (non-negotiable not carried forward), D08 (Sunday review only on Dash), D09 (no time-of-day awareness), D35 (four competing intention and reflection spots).

### Theme B: No fast way to jump to anything
D10 (Today bar inert, no section index), D11 (status bar scrolls away in six layouts), D23 (search finds text only), D24 (search hit lands at top), D25 (search hard to reach), D26 (no jump or quick-add sheet), D27 (no back or history), D28 (scroll position lost), D34 (Dash rows and empty states not actionable), D46 (no home-screen or Siri entries), D47 (no clear way back to the CRM).

### Theme C: Jo can't always tell where he is or trust what he sees
D29 (today vs past day unclear, × on tabs), D32 (two streaks disagree), D33 (Dash order puts utilities first), D36 (inconsistent "today page" rule), D18 (SAVED means phone only), D19 (30-second save gap), D20 (red errors shown green), D21 (silent sync failures), D22 (silent merges), D30 (delete says "cannot be undone" and has no undo), D31 (one-tap set delete), D14 (Dashboard Delete throws), D43 (rest timer runs unseen).

### Theme D: The phone screen is spent on chrome and decoration, not on the day
D12 (cover and duplicate quote), D13 (two-row header strip), D15 (search layers overlap), D16 (iOS zoom on inputs), D17 (no safe-area padding, badge over title), D37 and D38 (onboarding friction), D44 (two toast systems).

### Theme E: Spacing, type and sizing have no single system
D39 (no tokens, duplicated rules, stacked margins), D40 (11-12px caps everywhere, four title sizes), D41 (sub-44px targets), D42 (ragged section headers), D45 (settings in six places).

---

## 3. Prioritized upgrade plan

### Tier 1: Quick wins (S effort, ship first)

| # | What changes | Where | Why Jo will feel it | Closes |
|---|---|---|---|---|
| Q1 | Open on today. At boot, select today's page if it exists. If not, show an "Open today" card at the top of Dash and a labelled TODAY tab in place of `+`. Do not auto-create blank pages. Read `?go=`/`#go=` (today, floors, food, workout, wrap, review, money, dash) and point the NBD OS widget and coach links at them. | `js/app.js:1116`, `:194`, `:167`, `:707`, `:887`; `docs/pro/js/os/home.js:359,425,427`; `os/coach-logic.js:139` | One tap from the NBD OS nudge lands him on the floors he was told about. | D01, D02 |
| Q2 | All text inputs 16px on phones, so iOS stops zooming. Extend the phone-fit test to assert it. | Last `<style>` block in `index.html` (`@media(max-width:768px)`); `tests/ds-layouts-phone-fit-2026-10-25.test.js` | Tapping into a field no longer shifts the page sideways. | D16 |
| Q3 | Save on the way out. Debounce `collectPage(true)` about 800ms after `markDirty()`, and add `visibilitychange`/`pagehide` save handlers. | `js/app.js:623-624, 240, 436, 805-810, 1114` | Ticked floors survive swiping the app away. | D19 |
| Q4 | Show failures as failures: add `toastErr` mapped to `showToast(msg,'error')` and switch the failure messages to it. | `js/app.js:755`; `workout-coach.js:506,721`; other module failure toasts | A failed workout save reads red, not green. | D20 |
| Q5 | Guard `triggerDel` and `openRename` when `cur<0`, or hide them on Dash. | `js/app.js:168,170` | No more silent or crashing buttons on the Dashboard. | D14 |
| Q6 | Safe-area padding on `.topbar` and `.main`. Stop hard-coding the sync pill at `top:10px` in JS, use a class, and point the phone rule at the right element. | `index.html:63,128,816,841-842`; `ds-firebase-sync.js:66-72` | The title and save status stop sliding under the notch or the Offline pill. | D17 |
| Q7 | Clear tab identity: the today tab reads TODAY with no ×. Past days show "Tue Nov 3" and a "Back to today" chip in the Today bar. One strong active-tab style. The week strip rings the open page, with a separate today dot. | `js/app.js:150,198-201,885`; `index.html:118,801-802` | He always knows which day he is writing into. | D29 (part of D30) |
| Q8 | Drop the duplicate quote (`.qcard` or `.cover-quote`). | `js/app.js:208-212` (buildCover) | Floors move up about 100px immediately. | D12 (part) |
| Q9 | Make the Today bar items buttons: floors go to `#day-score-wrap`, cal/protein open diet and focus food search, workout calls `NBDCoachUI.open()`. Same for the Rings and Cockpit tiles. Use delegated `data-action`. | `js/app.js:315-316`; `day-layout-logic.js:75-83`; `cockpit-ui.js` | The numbers he reads become the way to act on them. | D10 (part) |
| Q10 | A search hit lands on the match: add `data-k` to hits, expand the section, `scrollIntoView` and flash the field. Keep scroll position per view and across background sync. | `js/app.js:630,740,1453`; `ds-firebase-sync.js:308` | No more re-scrolling 5 screens after search, a tab switch or a sync. | D24, D28 |
| Q11 | Wrap-up moves up after 17:00: when EOD state is `prompt`, insert `.eod-wrap` under the Today bar. | `eod-ui.js:59-65`; `eod-logic.js:15` | At 7 pm the first screen asks for the wrap-up. | D06 |
| Q12 | Carry last night forward. On an empty `ms-nonneg`, show yesterday's `tomorrow` value as a "From last night" prefill. This picks up the follow-up deferred in the 10-22 EOD note. | `js/app.js:251`; `eod-logic.js` | The evening commitment greets him in the morning. | D07 |
| Q13 | Name the streaks "Training streak" and "Floor streak" everywhere, and show both side by side. | `quest-ui.js:30`; `review-ui.js:146-154`; `js/app.js:514` | No more "13 here, 0 there". | D32 |
| Q14 | Make Dash floor rows tappable (`toggle-floor`), and turn the Weight and Progress "go to X" copy into "Log weight →" and "Start a workout →" buttons. | `js/app.js:702-707`; `tracker-history-ui.js:42`; `progress-charts-ui.js:35` | Dash stops describing paths and takes him there. | D34 |
| Q15 | Tap targets and small type: `.floor-inp`, `.gpi`, remove-floor ×, week cells, `.fl-x`, `.wc-swap-opt` and `.pg-chip` get a 44px minimum. The 9px `small` captions go to 11px at full opacity. | `index.html:333,376,792-808`; `js/app.js:1057`; `workout-coach.css:43,107`; `eod.css:3`; `checkin.css:3` | Fewer fat-finger misses when editing goals and food rows. | D41, D40 (part) |
| Q16 | Exercise-log row delete uses the existing two-tap "Tap again to remove" arm. | `js/app.js:1460` | Sweaty-hand brushes don't erase sets. | D31 |
| Q17 | Onboarding: sticky footer CTA, Next as the dominant button, a future-date placeholder, and `smartNewPage()` after setup. Persist banner dismissal. | `index.html:1124,1169,839`; `js/app.js:959-969,1073-1092` | First run ends on today, not on Dash, and the banner stays gone. | D37, D38 |
| Q18 | Section headers on phones: one-line 16px title, `min-height:56px`, full-opacity chevron, optional done/total count. | `index.html:175,179-187,398` | The collapsed sections read as a clean map of the day. | D42 |
| Q19 | One toast system with a safe-area-aware bottom inset, lifted above the rest pill. | `js/app.js:1373-1377`; `/pro/js/toast.js:41` | Messages show in one place and don't hide behind the home bar. | D44 |
| Q20 | One shared "is this today's page" rule for `smartNewPage` and the Notebook. Add an explicit "‹ CRM" control. | `js/app.js:167`; `notebook-logic.js:70`; header | No duplicate today pages, and an obvious way back to the CRM. | D36, D47 |

### Tier 2: Flow upgrades (M effort)

| # | What changes | Where | Why Jo will feel it | Closes |
|---|---|---|---|---|
| M1 | **Next-Up strip in every layout** (see section 4). Extend `onething-logic.js` candidates with food/protein, weigh-in, last night's non-negotiable, the Sunday review (when `reviewDue().due`) and the wrap-up. Add a pure `dayPhase(hour)`. Render it as the first slot of the Today bar in Classic. | `onething-logic.js`, `onething-ui.js`, `day-layout-logic.js`, `js/app.js:296-316` | The app always tells him what's next and how many items are left. | D03, D08, D09 |
| M2 | **Completion hand-off.** Each finish surface (coach summary, check-in, food add, wrap-up save) ends with a primary "Next: ___ →" button from M1. "Close" becomes secondary. | `workout-coach.js:599-612`; `checkin-ui.js:33-36`; `eod-ui.js:90`; `food-log.js` | Every win flows into the next step. | D05 |
| M3 | **Auto-ticking floors.** A matcher writes `floormet-<id>` on today's page by date key (not `pages[cur]`) when the coach finishes, protein reaches its target, check-in sleep is logged, or the wrap-up is saved. Record `floormet-src-<id>='auto'`, untick auto floors when a value drops back below target, and show an "auto ✓ · undo" chip. Revive or replace the dead `autoCheckFloors` / `autoCheckRevenueFloor`. | `js/app.js:362-414`; `workout-coach.js:706-731`; food-log, checkin, eod modules | The score reflects what he actually did, without a second manual tick. | D04 (and the C-07 auto-untick concern, which applies once the matcher is wired) |
| M4 | **One-row phone header.** Logo, one status chip, search, and a `⋯` sheet holding New, Rename, CSV, PDF, Appearance, Customize, Guide, and Delete last in danger styling. Retire SAVE only after Q3 ships. Wrap topbar, banner, search bar and tab row in one container and publish `--ds-chrome-h` through a ResizeObserver, replacing every hand-typed offset. | `index.html:63,75,91-96,116,128-129,785-788,816-842,1058-1069`; external JS | About 100 to 140px of screen comes back, and search stops overlapping the tabs. | D13, D15 |
| M5 | **Compact sticky mini-bar** (`.today-mini`) that appears once a layout's static hero scrolls off. Uses an IntersectionObserver and `updateTodayBar` data. | `css/layouts.css:16,46,68,80,116,142`; day-layout JS | Status and Next-Up follow him in every layout. | D11 |
| M6 | **Jump-anywhere sheet** (see section 4): a destination registry, a quick-add row, then search that understands dates and features, lists text hits newest first with field labels, and has keyboard combobox support. Add a thumb-zone Go button and Cmd/Ctrl+K, and give Ctrl+F back to the browser. | new `js/quickjump-logic.js`, `js/quickjump-ui.js`; `js/app.js:739-740,1111`; `notebook-logic.js:78-84` | Two taps from anywhere to anything. | D23, D25, D26 |
| M7 | **Section chip row** under the Today bar (Floors · Food · Train · Body · Wins · Wrap-up · Habits), built from the registry, with the current section highlighted. | `js/app.js:598`; quickjump files | The 9-screen page gets a table of contents. | D10 |
| M8 | **Back works.** A small hash router: `switchTo` and each overlay's `open()` push history, and `popstate` closes the top overlay or returns to the previous view. | `js/app.js`; `workout-coach.js`, `money-ui.js`, `review-ui.js`, `tracker-history-ui.js` | An edge-swipe closes the coach instead of leaving the app. | D27 |
| M9 | **One honest sync chip** driven by `ds-firebase-sync.js`, with four states: saved on phone/syncing, synced at a time, not synced (tap to retry, stays up), signed out. Listen for online/offline, retry with backoff, wrap `savePages` in try/catch, and keep a persistent notice when a merge overwrites local edits or sync pauses. | `js/app.js:160,174,1116`; `ds-firebase-sync.js:65-79,186-187,~246,281-315` | He knows what is safe in the cloud and what is only on the phone. | D18, D21, D22 |
| M10 | **Delete with undo.** Delete immediately, show an 8-second undo toast that restores the page and clears the tombstone, add a "Recently deleted" list in the Notebook, and say where he landed. Delete leaves the tab strip, while the 44px Notebook × stays as the 10-25 note decided. | `js/app.js:168-169,201`; `ds-firebase-sync.js:126-130`; notebook | A mis-tap never costs a day of data. | D30 (with Q7) |
| M11 | **Dash leads with today.** One explicit order list in `renderDash`: Today card (floors, Next-Up, "Open today"), streaks and week, review, goals and pace, Program Dashboard, then a compact Tools group (Money, Weight, Data, Measurements, Photos). Each card has one home. | `js/app.js` renderDash; anchors in `review-ui.js:286`, `money-ui.js:173`, `export-ui.js:100`, `weekstrip-ui.js:30`, `tracker-history-ui.js:76`, `stats-ui.js:51` | Dash answers "how am I doing", not "where are my settings". | D33 |
| M12 | **Phone day header and phase order.** One compact date and quote line on phones, with floors directly under the Today bar. Collapse the legacy Exercise Log once the coach has logged today. | `js/app.js:208-212,598`; `index.html:132-134,399-400` | Actionable content starts on the first screen. | D12 |
| M13 | **One morning slot, one evening slot.** The non-negotiable and top 3 sit together, the wrap-up ticks "Journaled" (through M3), and the legacy Log textareas go into "More notes". Keep the `data-k` keys so saved pages still load. | `js/app.js:131,251,417-419`; `eod-ui.js:30-37` | One clear place to write and a clear sense of what counts. | D35 |
| M14 | **Rest timer that persists and shows.** Persist `rest.until`, and show a slim "Rest m:ss · Skip" bar on the day page and coach card. | `workout-coach.js:119-122,197-199,259-266,643-652` | No mystery alert after the coach is closed. | D43 |
| M15 | **Token and type pass.** Add a `:root` block that mirrors DESIGN.md's foundation tokens (space 4/8/12/16/20/24/32/40/48, type 11/12/13/14/16/20/28, radius 4 badge / 6 chip-input / 8 card / 12 sheet / pill). Remove the duplicate `.pc`/`.ph` rules and the stacked card margins, move inline styles into classes, use one 16px card title and 14px body, and drop the unused Montserrat. Keep DM Mono. Mention the dead `#nbd-pro-nav` CSS in the PR without deleting it. | `index.html:128,132-199,288-292,333,554+`; `workout-coach.css:4-7`; `eod.css:2`; `js/app.js:558-598,887,945` | The page reads as one calm system, and future cards stop reintroducing the same misses. | D39, D40 |

### Tier 3: Bigger moves (L effort, or several M items combined)

| # | What changes | Where | Why Jo will feel it | Closes |
|---|---|---|---|---|
| L1 | **One Settings sheet** with sections Day, Training, Food, Look (labelled "this device") and Data/sync, deep-linking to the existing controls. | `index.html:1060-1061`; `layout-ui.js`, `accent-ui.js`, `js/app.js:714-721`, `workout-coach.js:561`, food card | One place for every target and preference, and he knows which ones sync. | D45 |
| L2 | **Phone Dash as summary tiles.** A 2-column grid of one-line status plus one action, each opening the full card in the existing overlay or sheet pattern. Builds on M11. | renderDash plus each `*-ui.js` mountDash | Dash fits on about one screen. | D33 (phone layer) |
| L3 | **Home-screen and Siri entries.** Document iOS Shortcuts (`?go=workout`, `?go=food`, `?go=wrap`) on the health-shortcut card and the Guide, plus an optional daily-success manifest with shortcuts. | `health-shortcut-ui.js`; new manifest | "Hey Siri, start my workout" opens the coach. | D46 |

Suggested order: Q1–Q6 together, which fix the opening view, input zoom, saving and safety. Then M1+M2+Q11+Q12 as the "Next-Up" release. Then M4+M6+M7+M8 as the "Jump anywhere" release. Then M9–M15. L-items come last.

---

## 4. Design sketch: "Next Up" and "Jump anywhere"

### Next Up (always on screen, every layout)

- **Brain:** `onething-logic.js` already ranks check-in, first unmet floor, workout and wrap-up. Extend `candidates()` with:
  - food or protein under target (from `food-log`)
  - weigh-in not logged
  - "From last night: <non-negotiable>" before 11:00
  - Sunday review when `review-logic.reviewDue().due`
  - the wrap-up from `PROMPT_HOUR`
  
  Add a pure `dayPhase(hour)` (morning before 11, field 11–17, evening from 17) that re-weights the list. When a workout-type floor exists, drop the separate "workout" candidate so the same task isn't listed twice. Keep it all pure and unit-tested.
- **Surface:**
  - In Classic and Log Book, the first slot of the sticky Today bar reads **"Next: Train · Push day [Go →]  3 of 7"**, followed by tappable floors, calories, protein and workout chips (Q9).
  - In hero layouts (Quest, One Thing, Rings, Cockpit, Arcade, Journal), the hero keeps its big version, and `.today-mini` (M5) shows the compact line once the hero scrolls off.
  - On Dash, the Today card shows the same line plus "Open today →".
- **Go:** this reuses the existing delegated `data-onething` handlers in `onething-ui.js:30-38`: scroll and focus the check-in, `toggle-floor`, `NBDCoachUI.open()`, the wrap-up edit, and the review overlay.
- **Hand-off:** each completion surface (M2) renders the next candidate as its primary button. M3 auto-ticks the matching floor, so the count drops right away and an undo chip appears.
- **Past-day mode:** on any page where `p.dk !== today`, the slot becomes **"Viewing Tue Nov 3 · Back to today →"**. On `visibilitychange`, if the date has rolled over, it offers "It's a new day — open today?".

### Jump anywhere (two taps to anything)

- **One registry:** `js/quickjump-logic.js`. Each entry is `{id, label, keywords, open}`, where `open` uses existing openers:
  - `ensureToday()` + `switchTo` for Today
  - a selector for Floors (`#day-score-wrap`), Food (`#flCard`), Weigh-in (`#wtCard`), Habits and Wins
  - `NBDCoachUI.open` for the coach
  - `NBDMoneyUI`, `NBDReviewUI`, `NBDNotebookUI` and `NBDExportUI`
  - Measurements and Photos
  - Appearance and Customize
  - Dash, and back to the CRM
  
  This one registry drives `?go=` deep links (Q1), the section chip row (M7), the Today bar buttons (Q9), the Dash empty-state buttons (Q14), the back-button router (M8) and iOS Shortcuts (L3).
- **Entry points:** a bottom-right thumb-zone **Go** button (safe-area padded), the header search icon, and Cmd/Ctrl+K. Ctrl+F goes back to the browser.
- **Sheet layout** (`js/quickjump-ui.js`, existing overlay pattern, 44px rows), top to bottom:
  1. **Next up:** the same item as the strip.
  2. **Quick add:** favourite-food chips (reusing the `data-fl-action="add"` path), "Start workout", "Tick a floor", "Weigh-in", "Wrap up".
  3. **Go to:** the registry list, filtered as he types.
  4. **Days:** date words ("yesterday", "nov 7", weekdays) through `NBDNotebookLogic.filterEntries`.
  5. **Notes:** page-text hits newest first, labelled by field ("Win: Miller roof…"), capped at 20 with "show all". Choosing one lands on the field (Q10).
- **Safety:** these are external deferred files using delegated `data-action`, with no inline script. Text is escaped and the sheet has combobox/listbox ARIA. Opening the sheet pushes a history entry, so swiping back closes it.

---

## 5. Full findings table

Sources map to the six passes: R = render, L = layout, FL = flow, WF = wayfinding, C = control, QN = quick-nav.

| ID | Dimension | Title | Evidence | Fix | Effort | Impact |
|---|---|---|---|---|---|---|
| D01 | flow / entry | Always boots to Dash; no deep links | `app.js:1116` `cur=-1;renderDash()`; no `location.hash`/`URLSearchParams` in DS js; `os/home.js:359`, `coach-logic.js:139` bare URL (R-F1, FL-F1, WF-02, QN-01) | Open today if it exists; `?go=` routes; point OS links at them | S | 5 |
| D02 | flow / dead end | New day has no page; `+` unlabeled; today's week cell inert; Dash floors card's only button is Reset | `app.js:159,167,194,707,887`; `notebook-logic.js:68-77` (FL-F2) | `ensureToday()`; "Open today" card; TODAY tab; week cell → smart-new-page; drop pointer cursor on inert cells | S | 5 |
| D03 | next stage | Classic never says what's next | `layout-logic.js:15`; `app.js:296-316`; `onething-logic.js:16-26` (R-F2, FL-F3, WF-04) | Next-Up slot in every layout from extended One Thing logic | M | 5 |
| D04 | completion | Completions don't tick floors; auto-floor code dead | `app.js:362-414` no callers; `workout-coach.js:706-731` (FL-F4; C-07 untick risk) | Date-keyed matcher, auto source flag, auto-untick, undo chip | M | 5 |
| D05 | completion | Every finish ends in Close, a toast or nothing | `workout-coach.js:599-612`; `checkin-ui.js:33-36`; `eod-ui.js:90` (FL-F5) | Primary "Next: ___ →" from Next-Up | S | 4 |
| D06 | next stage | Wrap-up buried about 5,400px down at night | `eod-logic.js:15`; `eod-ui.js:59-65` (R-F8, FL-F6) | Move under Today bar when state is `prompt` | S | 4 |
| D07 | day hand-off | Last night's non-negotiable forgotten next morning | `eod-ui.js:36,48`; `app.js:251`; deferred in EOD note 10-22:23 (FL-F9) | "From last night" prefill and morning Next-Up item | S | 4 |
| D08 | weekly stage | Sunday review prompt only on Dash | `review-ui.js:152,281-287`; `review-logic.js:146-150` (FL-F10) | Sunday Next-Up candidate opening review overlay | S | 4 |
| D09 | time awareness | Only two cards and the meal default react to time of day | `checkin-logic.js:12`; `day-layout-logic.js:12`; `app.js:26-36` (FL-F8) | `dayPhase(hour)` for default-open sections and Next-Up; highlight current regiment row | M | 3 |
| D10 | quick nav | Today bar inert; no section index across about 5,200–6,000px | `app.js:315-316,598`; `day-layout-logic.js:75-83`; cockpit tiles (R-F3, FL-F7, WF-03, QN-09, QN-10) | Bar items as buttons; section chip row with current-section highlight | M | 5 |
| D11 | wayfinding | Today bar static in six layouts, scrolls away | `css/layouts.css:16,46,68,80,116,142` (L-F6) | Shared `.today-mini` via IntersectionObserver | M | 4 |
| D12 | density | Cover and duplicate quote push floors about 450px down | `app.js:208-212,598`; `index.html:132-134,399-400` (R-F5, L-F1, FL-F6) | Drop duplicate quote (S); compact phone header, floors first (M) | S/M | 5 |
| D13 | layout / control | 100px two-row header; chrome 29–37% of screen; Delete/CSV/PDF in the strip, partly off-edge | `index.html:816-835,1058-1069`; comment `:820` (R-F4, L-F2, FL-F12, WF-05, WF-07, C-13, QN-08). The scrolling strip was a deliberate #2616 fix; this is the next step. | One-row header with `⋯` sheet; retire SAVE after D19 | M | 5 |
| D14 | control (bug) | Dash DELETE throws, RENAME does nothing | `app.js:168` `tlbl(pages[-1])`; `:170` early return (WF-05) | Guard `cur<0` or hide on Dash | S | 4 |
| D15 | layout | Search bar, results, tabs and banner overlap on phones | `index.html:91-96,96,129,825-835`; z-index `:115` vs `.today-bar` 240 (L-F3, WF-09, QN-05) | One header container and `--ds-chrome-h`; at minimum phone `has-banner .sdrop{top:244px}` | M | 4 |
| D16 | sizing | iOS zooms on inputs under 16px | `.sinp` 12px `:101`, `.ed` 13px `:194`, `.dt input` `:228`, `.gpi` 11px `:333`, `.floor-inp` 12px `:376`, `.fl-in` 14px (L-F5, QN-06) | Phone rule: inputs, selects, textareas and `.ed` at 16px; test it | S | 5 |
| D17 | safe area / overlap | No notch padding; sync pill inline `top:10px` covers title; phone rule targets `#autosave-badge` | `index.html:10-14,63,816,841-842`; `ds-firebase-sync.js:66-72` (L-F4, R-F14, C-03, WF-16) | `env(safe-area-inset-*)` on topbar and main; class-based pill; correct selector | S | 4 |
| D18 | trust | "SAVED" = phone only; shown at boot; cloud pill fades in 2.4s | `app.js:174,1116`; `ds-firebase-sync.js:65-79,~271` (C-01) | One persistent four-state sync chip; online/offline listeners | M | 5 |
| D19 | data safety | Edits sit in memory up to 30s; only `beforeunload` | `app.js:623-624,240,436,805-810,1114` (C-02) | Debounced save; `visibilitychange`/`pagehide` | S | 5 |
| D20 | errors | Every toast, failures included, shows green | `app.js:755`; `workout-coach.js:506,721`; `toast.js:32-33,59` (C-04) | `toastErr` for failure paths | S | 4 |
| D21 | errors | Settings and workout push failures silent; no retry; `savePages` unguarded | `ds-firebase-sync.js:186-187,~246`; `app.js:160` (C-11) | Feed into sync chip; retry with backoff; try/catch and error toast | M | 4 |
| D22 | sync | Merges and "Sync paused" shown only as a 2.4s pill | `ds-firebase-sync.js:281-315` (C-14) | Persistent notice; sticky paused state with reason and Retry | M | 3 |
| D23 | quick nav | Search finds only field text, oldest first, no features, dates or field labels, no keyboard nav; Notebook filter finds different things | `app.js:739-740`; `notebook-logic.js:78-84` (R-F6, FL-F13, WF-10, QN-03, QN-07, QN-13) | Registry-first command search; dates; newest first; labels; combobox | M | 5 |
| D24 | quick nav | Search hit opens day at top with match folded | `app.js:630,1453`; `day-layout-logic.js:12` (WF-10, QN-04) | `data-k` on hits; expand, scroll and flash | S | 4 |
| D25 | reachability | Search top-left; Ctrl+F hijacked | `index.html:827,1059`; `app.js:1111` (QN-08) | Thumb-zone Go button; Cmd/Ctrl+K | S | 4 |
| D26 | quick nav | No jump or quick-add surface though the openers exist | `money-ui.js:193`, `review-ui.js:325`, `notebook-ui.js:132`, `export-ui.js:119`, `workout-coach.js:252`, `food-log.js:101-103` (QN-02) | `quickjump-logic.js` and `quickjump-ui.js` | M | 5 |
| D27 | back | Back swipe leaves the app; no history | grep: no `pushState`/`popstate`/`hashchange` in DS js (WF-01) | Hash router; overlays push history | M | 5 |
| D28 | control | Scroll reset on every view switch and background sync | `app.js:187,630`; `ds-firebase-sync.js:308` (WF-06, QN-15) | Per-view scroll map; keep scroll and focus on sync | S | 4 |
| D29 | orientation | Today tab is a bare date with ×; past day looks the same; active tab weak; date only in scrolling cover | `app.js:150,198-201,885`; `index.html:118,801-802`; `checkin-logic.js:38` (R-F7, FL-F15, WF-12, C-08, QN-16, WF-14) | TODAY label without × on today/active tab; "Back to today" chip; strong active style; ring open page | S | 4 |
| D30 | destructive | "Cannot be undone" though cloud soft-deletes; no undo; lands elsewhere silently | `app.js:168-169`; `ds-firebase-sync.js:126-130` (C-05, WF-14) | Undo toast; Recently deleted list; announce landing | M | 4 |
| D31 | destructive | Exercise-log row deletes on one tap | `app.js:1460` (C-06) | Two-tap arm or undo | S | 3 |
| D32 | trust | Two or three "streaks" disagree | `quest-ui.js:30`; `review-ui.js:146-154`; `app.js:514` (R-F9) | Name them; show both together | S | 3 |
| D33 | hierarchy | Dash puts utilities above today; duplicate cards; order spread across modules | measured: floors at y1982 of 2948; insert anchors in six modules (R-F11, L-F12, FL-F11, WF-11) | One order list; Today card first; Tools group; phone tiles (L2) | M | 4 |
| D34 | control | Dash floor rows and empty states not actionable | `app.js:702-707`; `tracker-history-ui.js:42`; `progress-charts-ui.js:35` (QN-11, QN-12) | `toggle-floor` rows; action buttons | S | 3 |
| D35 | competing stages | Four intention and reflection spots; none ticks "Journaled" | `app.js:131,251,304,417-419`; `eod-ui.js:30-37` (FL-F14) | One morning slot, one evening slot; keep `data-k` keys | M | 3 |
| D36 | predictability | Inconsistent "today page" rule creates duplicates | `app.js:167` vs `notebook-logic.js:70` (WF-13) | One shared rule | S | 2 |
| D37 | onboarding | Long welcome, weak Next, past-date placeholder, ends on Dash | `index.html:839,1124,1169`; `app.js:1073-1092` (R-F13) | Sticky CTA; dominant Next; future placeholder; `smartNewPage()` | S | 3 |
| D38 | onboarding | Banner dismissal not persisted; 96px layout jump | `app.js:959-969`; `index.html:829-830`; `ds-firebase-sync.js:304` (WF-08) | Persist dismissal; render as Dash card | S | 3 |
| D39 | spacing / tokens | No tokens; duplicate `.pc`/`.ph`; mixed radii; card margins stack on parent gap; many inline styles | `index.html:128,139,155,172-179,288,292`; `workout-coach.css:4-5`; `eod.css:2`; 48 inline styles in index, 119 in app.js (R-F10, L-F13, L-F7, L-F8) | `:root` tokens mirroring DESIGN.md; zero child margins; classes over inline styles | M | 4 |
| D40 | typography | Mostly 11–12px tracked caps; four card-title sizes; 9px captions; unused Montserrat | `workout-coach.css:6-7`; `index.html:21,157-199,289`; `eod.css:3` (R-F15, L-F9, L-F10) | 16px titles, 14px body, 11px eyebrows only; drop Montserrat; keep DM Mono | M | 3 |
| D41 | sizing | Sub-44px targets | `index.html:333,376`; `app.js:1057`; `workout-coach.css:43,107` (R-F12, L-F10) | Add to the phone 768px tap-target block | S | 3 |
| D42 | layout | Ragged section header heights; faint chevron | `index.html:175,179-187,398` (L-F11) | One-line 16px title, 56px row, full chevron, status count | S | 3 |
| D43 | timers | Rest timer runs unseen and is lost on reload | `workout-coach.js:119-122,259-266,643-652` (C-09) | Persist `rest.until`; day-page rest bar | M | 3 |
| D44 | toasts | Two toast systems; no safe area; `nbdToast` timer clipping | `app.js:1373-1377`; `toast.js:41`; `workout-coach.css:62` (C-10) | Route through `showToast`; inset; lift above rest pill | S | 3 |
| D45 | settings | Settings spread over six surfaces with different sync rules | `index.html:1060-1061`; `layout-ui.js:5`; `accent-ui.js:5`; `app.js:714-721`; `workout-coach.js:561` (C-12) | One Settings sheet | L | 3 |
| D46 | platform | No home-screen or Siri entry into specific views | no DS manifest; `docs/pro/manifest.json:38` CRM-only (QN-14) | Document Shortcuts for `?go=`; optional manifest | S | 3 |
| D47 | CRM fit | Only way back to the CRM is the wordmark; dead `#nbd-pro-nav` CSS | `index.html:565-776,929` (WF-15) | "‹ CRM" control; flag dead CSS in the PR, delete separately | S | 2 |

---

## 6. Open questions for Jo

1. **What should the app open to?**
   - (a) Today, always.
   - (b) Today until the wrap-up is done, then Dash.
   - (c) Whatever view you last had open.
   - (d) Dash as now, with a big "Open today" card on top.
2. **The cover poster and quote on your phone:**
   - (a) Hide on phones and keep it on desktop.
   - (b) Shrink to one line (date and quote).
   - (c) Keep it, but move it below the floors.
   - (d) Leave it as is.
3. **Should finishing things tick floors for you?**
   - (a) Yes, automatically, with an "auto ✓ · undo" chip.
   - (b) Ask first: "Workout done. Tick the floor?"
   - (c) No, you tick floors by hand.
4. **Where should "jump anywhere" live?**
   - (a) A floating Go button bottom-right, in thumb reach.
   - (b) The search icon in the header only.
   - (c) Both.
5. **What should Dash be?**
   - (a) A one-screen summary of tiles that open full cards.
   - (b) The same full cards, reordered with today first and tools last.
   - (c) Leave the layout as is and just add the Today card on top.
6. **Deleting a day and the SAVE button:**
   - (a) Delete only from the `⋯` menu and the Notebook, with undo, and retire SAVE once autosave-on-close ships.
   - (b) Same, but keep SAVE in the `⋯` menu for peace of mind.
   - (c) Keep delete on the tabs, add undo only, and keep SAVE visible.
