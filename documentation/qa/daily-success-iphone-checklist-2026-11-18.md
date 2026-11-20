# Daily Success and Workout: real-iPhone checklist (2026-11-18)

Why this exists: the 2026-11-14 audit and the 2026-11-04 handoff both list checks that Chromium cannot do (no notch, no wake-lock prompt, no iPhone audio rules). Joe agreed on 2026-11-18 that nothing new gets built until he has run this once, in the gym, during a real workout, and the fails are fixed. Plan context: [Daily Success session 2026-11-14](../projects/SESSION-2026-11-14-daily-success-audit-fixes.md) and [Workout as its own app, 2026-11-16](../projects/SESSION-2026-11-16-ds-workout-installable.md).

Time: about 10 minutes of extra effort on top of a normal workout. Only report the fails: the step number, what you saw, and a screenshot if you can.

## A. Setup (once)

- [ ] A1. Both apps are on the Home Screen: Daily Success (navy tile) and Workout (orange tile with a dumbbell). If not, Safari > Share > Add to Home Screen from `/pro/daily-success` and `/pro/workout`.
- [ ] A2. Open Workout from its own icon. Signed in? If it shows a sign-in link, tap it, sign in, and confirm you land back in Workout, not the dashboard.
- [ ] A3. Same for Daily Success: if the ⋯ menu shows "Sign in to back up and sync", use it and confirm you land back in Daily Success.

## B. Fit and look (both apps, portrait, then landscape)

- [ ] B1. Nothing sits under the notch or the home bar. Top buttons and bottom buttons are fully tappable.
- [ ] B2. Tap a number field (weight, reps). The page must not zoom in.
- [ ] B3. Turn the phone sideways with a field focused. Fields stay visible and the page does not zoom.
- [ ] B4. Text is readable in daylight at your normal brightness (the outdoor test).

## C. A real workout in the Workout app

- [ ] C1. Start today's workout and log your first lift.
- [ ] C2. **Tap count.** Log one normal set and count the taps from "set done" to ready for the next set: ____ taps. (Decides whether "too many taps per set" is real.)
- [ ] C3. When a rest timer starts, leave the phone alone for 30 seconds. The screen must stay awake (wake lock).
- [ ] C4. Ringer switch on. When the rest ends you hear a beep. (iPhone cannot vibrate a web page, so sound is the only alert.)
- [ ] C5. Start another rest, fully close the app, reopen it from the icon. The rest should still be counting. Tap anywhere once, then let it end: you should hear the beep.
- [ ] C6. Open "Workout history" and look at your last workout. The PRs and numbers look right.
- [ ] C7. Tap "Finish workout". Over the summary you should see "Workout done. Tick the floor?". Tap "Tick it".

## D. The two apps agree

- [ ] D1. Open Daily Success. Today's Exercise Log contains the lifts you just did, once, not twice.
- [ ] D2. The workout floor is ticked once. Close and reopen: nothing is doubled.
- [ ] D3. The sync chip reads Backed up (not Not backed up). If it says Not backed up, tap Retry and note what happens.

## E. Offline (airplane mode)

Do this only after both apps have been opened online at least once today.

- [ ] E1. Turn on airplane mode. Open Workout from the icon. It opens, not a blank page or an error.
- [ ] E2. Start a workout and log a set. It saves ("Saved on this phone").
- [ ] E3. Open Daily Success. It opens and shows today.
- [ ] E4. Turn airplane mode off. Within a minute the status goes to Syncing, then Backed up.
- [ ] E5. Note whether fonts look different offline. That is cosmetic and only matters if it looks wrong.

## F. Three quick answers (no pass or fail)

- [ ] F1. Did you open Daily Success on your own, without a reminder, on most days this week?
- [ ] F2. Do you log RPE on most top sets? (Decides whether the RPE trend is built.)
- [ ] F3. Anything that annoyed you today that is not on this list.

## Results

Fails go here, one per line, in the form `step - what happened - screenshot or not`. The fixes are one small PR each, and nothing from the build list starts until this table is empty.

| Step | What happened | Fixed in |
|---|---|---|
| | | |

## Emulator pass (2026-11-18, Claude, 375x812 Chromium, signed out)

Run before the iPhone pass so Joe only has to test what a laptop cannot. Local static server, no auth emulator. Chromium has no notch, no wake lock prompt, no iOS audio rules, so those steps stay open for the phone.

| Step | Result | Note |
|---|---|---|
| B1 | Partly | Layout fits at 375 px with no overflow. The bottom rest bar uses `env(safe-area-inset-bottom)` (`workout-coach.css:64`). Real notch and home bar still need the phone. |
| B2 / B3 | **Likely fail** | 18 of 60 coach controls are 14 px: the per-set RPE dropdowns (`.wc-rpe`, `workout-coach.css:55`). iOS Safari zooms the page when a field under 16 px takes focus. Weight and reps fields are 16 px. Confirm on the phone. |
| C1 | Pass | Start today's workout opens the coach; first-use safety note shows once. |
| C2 | **2 taps + typing the weight** per set | Tap the weight field, type, tap the check. Reps count from the placeholder. Set 2 does not prefill from set 1, so every set types its weight again on a first-ever workout. Previous-set prefill with history was not exercised. |
| C5 | Partly | The rest timer survives a reload and keeps counting from the clock; the in-progress workout is kept. The post-reload beep needs the phone. |
| C6 | Not run | |
| C7 | Pass | Finish shows the summary (1 set, 675 lb for 135 x 5, correct) and "Workout done. Tick the floor?" with Tick it. |
| D1 / D2 | Pass | Opening today's day page copied the lift into the Exercise Log once; the Today bar shows 1/5 floors and the workout done; a reload did not double it. |
| D3 | Not testable | Needs a signed-in account, so the chip stays at "Saved - signed out". |
| E1 / E2 | Pass | With the server stopped, `/pro/workout/` opened from the service worker with its history, and a set logged and saved offline (1/18 sets, rest timer started). The shell cache had to be seeded by hand on this server (see below). |
| E3 / E4 | Not run | Daily Success offline and the reconnect sync need the phone and a sign-in. |

Findings that are not failures:
- **"Offline mode" badge shows when signed out, not only when offline.** `ds-firebase-sync.js:373` shows it for about 2.4 s on every signed-out load, over the top of the coach card on the Workout page. Wording only; signed in it should not appear.
- **Local-server artifacts, not app bugs.** `/api/google-reviews` 404, the `nosw.txt` probe, and the auth emulator at `127.0.0.1:9099` refusing connections. A plain static server redirects `/pro/workout` to `/pro/workout/`, and the service worker refuses to store a redirected shell (`sw.js` `res.redirected`), so the app-shell cache stayed empty. Production answers both paths with a plain 200 (checked with `curl`), so the shell stores there.
- 30 of 31 same-origin resources the Workout page loads are in the service-worker cache; the one missing is the deliberate kill-switch probe. Google Fonts and Google's auth script come from other hosts and rely on the browser's own cache, so offline text may fall back to system fonts.

## What happens after

Build order once the table is empty, each a draft PR until Joe has seen it on his phone: the "yesterday is blank" banner, the Sunday review prefill, last night's non-negotiable carried into tomorrow, progress charts in the Workout app, and the RPE history trend only if F2 is yes. Success bar: 6 of 7 days logged for four weeks, read from the existing Stats tiles.
