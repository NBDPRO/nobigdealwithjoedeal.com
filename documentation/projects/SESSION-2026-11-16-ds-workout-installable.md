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
| Test (57 checks): manifests, every icon PNG walked chunk by chunk, script-version parity between the two pages, the helpers against app.js, the status line, the shell entry, the headers, the mirrored theme tokens. | `tests/ds-workout-installable-2026-11-16.test.js` |

`workout-coach.js`, `workout-coach-logic.js` and `ds-firebase-sync.js` are unchanged.

## How the two apps stay in step

- **Android (Chrome):** installed apps on one site share storage. A workout finished in Workout is in Daily Success the next
  time it draws, signed in or not.
- **iPhone:** every home-screen app has its own storage, separate from Safari and from each other. The two apps meet only through
  the account: sign in inside each one, and `ds-firebase-sync.js` does the rest (it pulls on sign-in and again each time the app
  comes back to the front). Signed out, an iPhone app only has what was logged in that app.

## Known gaps (not built here)

1. **No sign-in link inside Daily Success.** The tracker has never had one: on a browser the dashboard's sign-in carries over.
   An iPhone home-screen install starts signed out, with no way in. Workout has the link (`#waSignIn`); Daily Success needs the same
   before the iPhone install is useful with existing data. Small change, but it touches the tracker's header or menu, so it is Jo's call where it goes.
2. **`/pro/login` does not come back.** After signing in it lands on the CRM dashboard, not the app that sent it. On a phone that
   means: sign in, then reopen the app from the home screen. A return path is a login-flow change and was left alone.
3. **A workout finished in Workout is not copied into today's Exercise Log table** on the day page (the coach only does that when
   today's page is on screen, which it never is here). Everything that reads `nbd_ds_workouts` still sees it. The
   "tick the workout floor?" prompt (`floor-tick-ui.js`, the `nbd-ds-did` event) also only fires inside Daily Success.
4. **Workout is the default dark theme only.** The coach's full-screen logger is dark in every Daily Success theme already; only the
   small card would differ.
5. **Not checked on a real phone.** Checked here: the page in headless Chromium at 390 x 844 (card, start a workout, Back closes
   the logger, no console errors). Not checked: the Android install prompt, iPhone Add to Home Screen, sign-in from inside an
   installed iPhone app, the offline open after an install.

## Verify on the phone after deploy

1. Android: open `/pro/daily-success` in Chrome, menu, Add to Home screen / Install. Repeat at `/pro/workout`. Expect two icons, two names, and NBD Pro untouched.
2. iPhone: the same two addresses in Safari, Share, Add to Home Screen.
3. Open Workout, start a workout, tick a set, close the app, reopen: the live workout is still there.
4. Airplane mode, reopen Workout (after one online visit): it opens.
