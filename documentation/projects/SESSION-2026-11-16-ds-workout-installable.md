# Session 2026-11-16: Daily Success and Workout as two home-screen apps

Jo's ask: set the workout and Daily Success up well enough on their own that each can be saved as its own web app on his
phone (iPhone and Android), with a new icon for each. He was unsure whether to split the workout out of Daily Success and
asked for a decision after looking at how it is built.

## The decision: split the screen, keep one set of data

**Workout gets its own page (`/pro/workout`). Daily Success keeps its Coach card. Both read and write the same workouts.**

What the code says:

- The coach was already two layers. The rules (`daily-success/js/workout-coach-logic.js`, `window.NBDCoach`) touch no page.
  The screen (`workout-coach.js`) reaches into the Daily Success page in a handful of places, every one behind a
  `typeof ... === 'function'` guard: `todayKey`, `toast` / `toastErr`, `dsSettingsChanged`, `savePages` / `collectPage` /
  `renderPage` (the write into the day page's Exercise Log), `buildFitnessSection` (where the card is hung), `NBDNav`.
- Workouts already have their own store: `localStorage nbd_ds_workouts` and `users/{uid}/ds_workouts`, apart from the day pages
  (`nbd_dsp_v1`, `users/{uid}/ds_pages`).
- More than 20 Daily Success modules READ that store: floors and the Today bar, XP, quests, the heatmap, the Sunday review,
  stats, progress charts, export, the cockpit. A second, separate workout store would silently empty every one of them.

So:

| Option | Verdict |
|---|---|
| A second icon that opens Daily Success with the coach open | Rejected. It is still the whole tracker underneath: about 70 scripts, the tabs, the day pages. Not its own app. |
| A fully separate app with its own data | Rejected. Breaks the 20+ readers above, and needs a second sync path for the same lifts. |
| **Own page, shared data** | **Built.** With Daily Success in mind: nothing it shows changes. Without it in mind: the page loads only the coach (11 scripts), works signed out, and never needs the tracker open. |

## What shipped

| What | Where |
|---|---|
| Daily Success manifest: own `id` / `scope` / `start_url` (`/pro/daily-success`), own icons. The page links it and its own 180 px iPhone icon. | `docs/pro/daily-success.webmanifest`, `docs/pro/daily-success/index.html` (head only) |
| Workout manifest (`/pro/workout`, name "Workout Coach", short name "Workout"). | `docs/pro/workout.webmanifest` |
| The standalone Workout page. Loads the SAME coach files at the SAME `?v=` as the Daily Success page, so there is one copy of the coach and one offline cache entry per file. | `docs/pro/workout/index.html`, `workout-app.css` |
| `workout-shell.js`: the five helpers app.js gives the coach (`todayKey`, `toast`, `toastErr`, `dsSettingsChanged`, `savePages`), same behaviour. Loaded before the coach. | `docs/pro/workout/js/workout-shell.js` |
| `workout-app.js`: draws the card, the date, the backup status (Saved on this phone / Syncing / Backed up / Not backed up + Retry), the sign-in link when signed out, and asks for the offline shell. | `docs/pro/workout/js/workout-app.js` |
| Icons: navy tile with an orange progress ring and a check (Daily Success); orange tile with a white dumbbell (Workout). SVG sources, and PNGs at 192 / 512 ("any" and "maskable") and 180 (iPhone). | `docs/pro/img/ds-icon*.{svg,png}`, `workout-icon*.{svg,png}`, `ds-apple-touch-icon.png`, `workout-apple-touch-icon.png`; built by `scripts/render-app-icons.js` |
| Offline shell for `/pro/workout` (same rules as the tracker's: stored only when the page asks, marker-checked). | `docs/pro/sw.js` (`APP_SHELLS`, `NO_CACHE_HTML`) |
| Hosting: `/pro/workout` and `/pro/workout/**` get the tracker's CSP, no-store and noindex; both manifests are served as `application/manifest+json`. | `firebase.json` |
| Sign-in item in the Daily Success header menu ("Sign in to back up and sync", third, after Save now), shown only while signed out. Hidden items are skipped by the menu's keyboard focus. | `docs/pro/daily-success/index.html`, `js/menu-ui.js`, `css/flow-batch-3.css` |
| Test (66 checks, structure and behaviour through `tests/lib/src-kit.js`): manifests, every icon PNG walked chunk by chunk, script-version parity between the two pages, the helpers against app.js, the status line, the shell entry (sw.js run in a vm), the headers, the mirrored theme tokens, the sign-in item. | `tests/ds-workout-installable-2026-11-16.test.js` |

`workout-coach-logic.js` and `ds-firebase-sync.js` are unchanged. `workout-coach.js` was unchanged on 2026-11-16 and gained the Exercise Log copy on 2026-11-17 (Known gaps, item 3).

CI note: the first push failed `tests/source-pin-ratchet.test.js` (a new suite may hold at most 5 assertions on file text; the first
version of this suite had 22). The suite was rewritten to ask structural questions and run the code instead.

## How the two apps stay in step

- **Android (Chrome):** installed apps on one site share storage. A workout finished in Workout is in Daily Success the next
  time it draws, signed in or not.
- **iPhone:** every home-screen app has its own storage, separate from Safari and from each other. The two apps meet only through
  the account: sign in inside each one, and `ds-firebase-sync.js` does the rest (it pulls on sign-in and again each time the app
  comes back to the front). Signed out, an iPhone app only has what was logged in that app.

## Known gaps (not built here)

1. ~~No sign-in link inside Daily Success.~~ **Added the same day** (Jo: "add the sign in link to daily success too"): a menu item,
   shown only while signed out. It is third in the menu, not first, because the menu's keyboard test
   (`tests/ds-flow-batch-3-2026-11-09.test.js`) counts on the first two items staying where they are.
2. ~~`/pro/login` does not come back.~~ **Fixed the same day** (Jo: "make login send me back to the app after sign in"). The two
   sign-in links open `/pro/login?redirect=workout` / `?redirect=daily-success`. The query is a NAME, looked up in a fixed list in
   `docs/pro/js/login-return.js`; `pages/login.js` (`POST_LOGIN_DEST`) asks it after the existing `redirect=pricing` rule and before the
   dashboard fallback. A URL, a path or any other value is ignored, so the login page cannot be pointed anywhere else.
   Not exercised with a real sign-in here (no credentials were used): the lookup and the wiring are tested, the full round trip is not.
3. ~~A workout finished in Workout is not copied into today's Exercise Log.~~ **Built 2026-11-17** (Jo: "copy the workout into
   today's exercise log too"). A session now carries `inLog`: Finish saves it as `false`, and `true` once its lifts are on a day page.
   The Daily Success page is still the only writer of day pages: when a day's own page is on screen it copies every `inLog === false`
   session for that date into the Exercise Log (after the rows already there), then marks the session with a newer `mt` and pushes it,
   so no other screen or device copies it again. It runs when a day page is drawn, when the sync calls `NBDCoachUI.refresh()`, and when
   the app comes back to the front. Sessions saved before the field existed are never copied (their rows may already be on the page).
   A refused page save puts the page and the session back; a focused field is never redrawn away. `workout-coach.js` is at `?v=30` on
   both pages. Test: `tests/coach-exercise-log-copy-2026-11-17.test.js` (33 checks; ten deliberate breaks of the code were each caught).
   **The floor prompt (same day, Jo: "make the floor tick prompt work from the workout app too"):** when the copy lands, the coach raises the
   same `nbd-ds-did { kind: 'workout', dk }` event Finish raises, so `floor-tick-ui.js` asks "Workout done. Tick the floor?" for a workout
   finished in the Workout app. It is asked in Daily Success, on that day's page, not inside the Workout app: the floors, the day pages and
   `setFloorByDk` live in the tracker, and the tracker stays the only writer of day pages. Still ask-first (Jo's decision 3): a floor already
   met, or a Not now for that day, shows nothing. `workout-coach.js` is at `?v=31`. Checked in headless Chromium with a session seeded as the
   Workout app leaves it: lifts copied, prompt shown, Tick it met the floor, nothing doubled after a reload.
   **Asked inside the Workout app (same day, Jo: "Yes, ask in Workout"):** Finish now names the workout in its event (`id`), and
   `workout-app.js` shows "Workout done. Tick the floor?" over the summary. The answer is stored on the session by
   `NBDCoachUI.answerFloor(id, 'yes' | 'no')` (`tick`, newer `mt`, pushed); nothing is ticked on that screen. Daily Success applies a yes
   with `NBDFloorTickUI.tickFor('workout', dk)` (new in `floor-tick-ui.js`: no second question, the usual Ticked / Undo chip), once per
   day, then sets `tick: 'done'`. It does this from the Dashboard too (on load, after a sync, on return to the app), since a floor is set
   by date. A no is never asked again; no answer at all means Daily Success asks when it copies the workout in. An answer waits while
   that day has no page yet or the save is refused. The Workout app only asks when there is a floor a workout ticks (Jo's own floors
   from `nbd_user_config`, else the default set). Versions: `workout-coach.js?v=32`, `floor-tick-ui.js?v=3`, `workout-app.js?v=2`,
   `workout-app.css?v=2`; the Workout page now also loads `floor-tick-logic.js` at the Daily Success version.
   Tests: section 9 and 10 of `tests/coach-exercise-log-copy-2026-11-17.test.js` (58 checks in all) and section 9 of
   `tests/ds-workout-installable-2026-11-16.test.js` (88 in all); fifteen deliberate breaks of the new code were each caught.
   Checked in headless Chromium with both apps in one profile (shared storage, the Android case): Finish, prompt on top of the summary,
   Tick it, then Daily Success opened on the Dashboard with the floor ticked and no second question, and today's page got the lifts.
   Not checked: the iPhone path, where the answer has to travel through the account sync.
4. ~~Workout is the default dark theme only.~~ **Built 2026-11-17** (Jo: "make the workout app follow my daily success theme too").
   `docs/pro/workout/js/workout-theme.js` reads the keys Daily Success saves its theme under, in the same order (`nbd_pro_theme`, then
   `nbd-theme`, then `ds-theme`), and sets `data-theme` in `<head>` before the first paint. `workout-app.css` (`?v=3`) carries the token
   blocks of all ten built-in skins, generated from the Daily Success page's own rules; the test compares 16 tokens x 10 skins. The accent
   (`nbd_ds_accent`) is laid over the skin with `NBDAccent.vars`, judged against the skin's card colour, as `accent-ui.js` does. The header
   bar and the floor prompt sit on `--bar`, which is dark in every skin, so their text is a fixed light colour.
   Checked in headless Chromium: for each skin (and light + a teal accent) both pages computed the same ten colours, and no text on the
   Workout home screen measured under 4.5:1. Ten deliberate breaks: nine caught; the tenth showed a redundant line, which was removed.
   **The look follows the account, and the apps may differ (same day, Jo: "Yes, sync it" and "we can allow for different themes across
   apps if desired too").** `docs/pro/daily-success/js/look-sync.js` keeps two small records that `ds-firebase-sync.js` (`?v=13`) syncs like
   the other settings, newest stamp wins:
   - `nbd_ds_look = { theme, accent }` (`userSettings.dsLook`): the Daily Success look. `app.js nbdApplyTheme` and `accent-ui.js set()`
     (`?v=2`) call `NBDLook.changed()`. This is the route the 2026-06-10 note inside `nbdApplyTheme` asked for.
   - `nbd_wk_look = { theme, accent }` (`userSettings.dsWkLook`): the Workout app's OWN theme and accent, `''` = same as Daily Success;
     accent `'none'` = the theme's own colour (Daily Success calls it "Theme default"). Device keys `nbd_wk_theme`, `nbd_wk_accent`; set
     from the Theme and Accent controls on the Workout page (`workout-theme.js setOwn` / `setOwnAccent`). The accent was shared at first;
     Jo asked for its own the same day ("let workout have its own accent too"). Theme and accent change independently, and neither
     touches the Daily Success look. Versions after that: `look-sync.js?v=2`, `workout-theme.js?v=2`, `workout-app.js?v=4`,
     `workout-app.css?v=5`.
   Two records because the sync replaces a record whole: a Workout-only pick on a phone that has not yet received the Daily Success look
   must not send "default" with it. For the same reason a device with nothing picked writes nothing, and a look that predates this is
   seeded WITHOUT a stamp, so it only reaches the cloud when the cloud has none. A restored record is applied through the page's own
   functions on Daily Success, and by writing the device keys and repainting on the Workout app; applying it is not re-stamped.
   Tests: `tests/look-sync-2026-11-17.test.js` (47 checks: two phones, one fake cloud, the real `look-sync.js` and the real
   `ds-firebase-sync.js` for every sync) and sections 10-12 of `tests/ds-workout-installable-2026-11-16.test.js` (132 in all). Nineteen
   deliberate breaks of the theme sync and fifteen of the accent, all caught (one only after a check was tightened). The accent in
   headless Chromium: Daily Success on Ocean + Teal; Workout picked Rose, then Theme default, then Same as Daily Success; Daily Success
   stayed Teal throughout; the Start button stayed at 4.5:1 or better across 2 themes x 8 accents. Headless Chromium, one profile: Workout picked Ember, Daily Success
   stayed default then picked Ocean + Teal, Workout stayed Ember, "Same as Daily Success" took it to Ocean + Teal.
   **Custom themes (same day, after #3122 merged; Jo: "make custom themes work in the workout app too").**
   - Finding first: **Daily Success itself only half-applies a saved custom theme.** `nbdApplyTheme` sets `--bg`, `--bar` and the accent;
     the Text and Muted colours are saved (`nbd-customs`: `{ id: 'custom-<time>', name, accent, bg, s, tc, m }`) but only the live preview
     (`_nbdApplyCustomVars`) ever uses them, and no stylesheet block matches `data-theme="custom-..."`, so `--paper`, `--ink`, `--rule` and
     `--muted` are EMPTY. Measured in headless Chromium: cards stay cream (`rgb(245,243,239)`) and body text is black on whatever
     background was picked. NOT fixed here (it touches every tracker module's colours); it is Jo's call.
   - So the Workout app does not copy that. `workout-theme.js` (`?v=3`) reads `nbd-customs`, checks each entry (custom id, five six-digit
     hex colours) and `derive()` sets the page's colours inline from all five. Because the colours are free picks it keeps the result
     readable: text under 4.5:1 on its surface becomes black or white, muted under 3:1 becomes the text colour, an accent that cannot
     carry text falls back to the text colour, and accent-filled buttons take black or white text. The page and the cards / bar get
     separate text colours (they can be far apart). `workout-app.css` (`?v=6`) gained `--wa-*` hooks for this; every hook falls back
     to the value the ten built-in skins always used.
   - The Theme control lists this device's custom themes in a "Custom" group, so one can also be the Workout app's own theme.
   - `look-sync.js` (`?v=3`): a record that names a custom theme carries its definition (`custom: { id, name, accent, bg, s, tc, m }`).
     `restore()` adds it to the device list, and to app.js's in-memory `_nbd_customs` on Daily Success, before the theme is applied, so a
     phone that never made the theme can draw it. A definition is only accepted for the theme the record names.
   - Tests: `look-sync` 64 checks, `ds-workout-installable` 154 (400 random five-colour themes, every text colour measured). 27 deliberate
     breaks, all caught (one only after a check was added). Headless Chromium: five sample themes incl. a light page with dark cards, a
     pale accent and deliberately unreadable picks, nothing under 4.5:1 (muted 3:1) on the home screen or the floor prompt; the ten
     built-in skins unchanged; a synced custom theme arriving on each real page is drawn, listed, and survives a reload.
   - Not covered: inside the coach's full-screen logger the muted / rule colours of a LIGHT theme sit on its fixed dark background (true
     of the built-in light skins in Daily Success too); only its accent-filled buttons were made safe.
   **Daily Success fixed too (same day; Jo: "Yes, fix it"), and both apps now draw a custom theme from ONE function.**
   - `docs/pro/daily-success/js/custom-theme-logic.js` (`NBDCustomTheme`): what counts as a custom theme, and `derive()`, the full token
     row from the five colours. The Workout app's own copy of this (above) was removed; `workout-theme.js` (`?v=4`) and `look-sync.js`
     both use it. Loaded before `app.js` on Daily Success and before `workout-theme.js` on the Workout app.
   - `app.js`: `_nbdLayCustom(t)` lays the row inline in `nbdApplyTheme` and at boot; `_nbdClearCustom()` takes it off before the next
     theme. `accent-ui.js` (`?v=3`) re-applied the theme's RAW accent and cleared `--ac-text` / `--ac-on-dark` every time `data-theme`
     changed; for a custom theme it now uses the derived fill and puts those two back.
   - What `derive()` keeps true, because the tracker's styles count on it: the bar carries light text (a light surface cannot be the bar:
     the theme's dark text colour is, else near-black, as Warm Paper does); `--on-dark` / `--ac-on-dark` read on the bar AND on the three
     surfaces that stay dark in every skin (coach logger, week-glance panel, onboarding banner); every accent-FILLED control paints white
     text on `--ac`, so an accent too pale for white is darkened, keeping its hue, only as far as needed (the accent as picked is still
     used as text where it reads). Text under 4.5:1 becomes black or white; readable picks are used exactly as chosen.
   - Three page rules assumed a built-in skin: `body` colour now `var(--page-ink,var(--ink))`; the accent words on the banner use
     `--ac-on-dark`; a ghost button on the banner takes `--on-dark` (this one was also 1.5:1 on the built-in Light and Warm Paper skins,
     so those improved); under `[data-theme^="custom-"]` the "not earned" box takes the page accent. The two rules older suites pin
     (`daily-success-theme-sweep`, `daily-success-themes`) are byte-identical; the new behaviour is in separate rules.
   - Measured with a live sweep in headless Chromium (every piece of text on the Dashboard and today's page against what is behind it):
     before, a custom theme had 11-14 low spots (down to 1.3:1) and Light / Warm Paper had 2; after, 0 for all six custom samples (dark,
     light, light page + dark cards, dark page + light cards, pale accent, unreadable picks) and 0 for default / light / paper / midnight.
     Both apps compute identical tokens for a custom theme. The sweep is a manual script, not a CI test.
   - Tests: `tests/custom-theme-2026-11-17.test.js` (34 checks; 400 random themes x 25 colour pairings), `ds-workout-installable` 151,
     `look-sync` 64. 38 deliberate breaks, all caught (one only after a check was tightened).
   - ~~Not swept: the overlays, the Notebook, the other seven layouts.~~ **Swept after #3124 merged (Jo: "sweep the overlays and other
     layouts for custom themes too").** 37 screens: the Dashboard and day page of all eight layouts, eighteen overlays (Money, Sunday
     review, Notebook, quick jump, export, history import, coach logger / settings / history, appearance, customize, welcome guide,
     how-to, header menu, search, rename, delete, floor prompt) and the Workout app's logger. About 2,890 pieces of text per theme,
     only text that is really on top at its own centre point, each against what is behind it.

     | Theme | low-contrast spots before | after |
     |---|---|---|
     | Default | 24 | 1 (Quest's XP badge, 4.49:1) |
     | Light | 31 | 0 |
     | Warm Paper | not measured | 0 |
     | custom dark | 30 | 0 |
     | custom light | 41 | 0 |
     | custom light page + dark cards | 26 | 0 |
     | custom dark page + light cards | 39 | 0 |
     | custom pale accent | 41 | 0 |

     Custom themes were about level with the built-in skins: almost every spot was a bug the built-in skins had too. Fixed at the source:
     the check-in caption (the accent at 70% opacity, 3.2-3.8:1 in every skin) is the muted colour; Cockpit's HUD label rule also hit the
     check-in card's labels (same class name, `.ck-l`: 1.6:1 on Light); the welcome guide's "Pick your layout" heading had no colour and
     inherited the card ink on a dark panel (1:1 on Light), and its accent words used the button fill; the How-to panel's titles, step
     numbers and subtitle; a ghost button on the search bar and a caption on the review overlay used the card colours on a dark surface;
     Journal's field labels (4.4:1). Custom-only: `derive()` now also keeps the muted and on-dark colours readable at 80% opacity (several
     captions are drawn faded) and on a panel with a light tint over it. The property test caught a real edge there: with clashing hues
     the faded colour can measure BETTER than the full one, so both are checked. `custom-theme-logic.js?v=2`, `layouts.css?v=14`,
     `checkin.css?v=2`. `tests/custom-theme-2026-11-17.test.js` is at 45 checks; 20 deliberate breaks, all caught (one showed a
     redundant line, which was removed).
   - Still not swept: print, the PDF export, tablet / desktop widths, and overlays that need data to open (a workout summary with PRs,
     a filled Sunday review). The sweep skips text over a gradient or an image. It is a manual script, not a CI test.
   **Limits:** (a) a pale custom accent shows darker on buttons than the colour picked (its text uses still show it as picked); (b) NOT exercised against the real cloud or on a phone: the sync is tested against the harness's fake Firestore;
   (c) a pick made in the first seconds on a brand-new install, before its first sync has finished, is stamped newer than the look chosen
   elsewhere and wins; (d) the records are account data, cleared on an account switch (the Daily Success device theme stays, the Workout
   app's own theme goes back to following until the account's copy arrives).
5. **Not checked on a real phone.** Checked here: the page in headless Chromium at 390 x 844 (card, start a workout, Back closes
   the logger, no console errors). Not checked: the Android install prompt, iPhone Add to Home Screen, sign-in from inside an
   installed iPhone app, the offline open after an install.

## Verify on the phone after deploy

1. Android: open `/pro/daily-success` in Chrome, menu, Add to Home screen / Install. Repeat at `/pro/workout`. Expect two icons, two names, and NBD Pro untouched.
2. iPhone: the same two addresses in Safari, Share, Add to Home Screen.
3. Open Workout, start a workout, tick a set, close the app, reopen: the live workout is still there.
4. Airplane mode, reopen Workout (after one online visit): it opens.
