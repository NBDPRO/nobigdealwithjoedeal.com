# CRM style integration C3 — Trophy Case + unlock toasts (2026-10-11)

Slice C3 of the CRM style integration (Grok idea #09, Jo-approved 2026-10-11;
roadmap: the C-track in `CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11.md`). Lane
"habits".

## What shipped

- **`themeunlock` event.** `ThemeAchievements.unlock` (the one place a theme is
  *earned*) fires `document` `CustomEvent('themeunlock', {themeKey, name, icon,
  description})`. Unlocks restored from Firestore on boot do not fire it, so
  nothing toasts at login for an old achievement.
- **Console-style unlock toast** (`docs/pro/js/trophy-case.js`): gold medal,
  shine sweep, ~56 CSS-only confetti pieces, the new theme's four swatches
  (`ThemeEngine.previewResolvedColors`), **Try theme** (unlock + `apply`),
  **Trophy Case**, Dismiss. Queued, so two unlocks at once show one after the
  other; hover pauses it. The old yellow banner in `theme-achievements.js` stays
  as the fallback and goes quiet whenever the Trophy Case is loaded (one toast
  per unlock).
- **Trophy Case drawer**: the 10 achievement themes, closest first, earned last,
  with a live progress bar from the achievement store (`getAll` / `getProgress`),
  what is left in each one's own unit ("3 more inspections", "$8K more
  collected"), an **"Almost there"** nudge at 60% and up, and Try theme on the
  earned ones. Opens from the toast, from an **Open Trophy Case** button in the
  Settings > Themes achievements panel, or `NBDTrophyCase.open()` (the command
  palette, C4, can register it as an action).
- **Motion + sound:** Reduce Motion (the OS setting or the Comfort tab's
  `data-motion="reduce"`) drops the shine, the pop and the confetti. The chime goes
  through `ThemeSounds.playNotification`, which mutes itself under Reduce Motion;
  the module also honours ThemeSounds' own on/off.

## Decision: no edit to `theme-engine.js`

The brief said to fire the event from `ThemeEngine.unlock` and to coordinate with
lane "theme-polish". Nothing else earns a theme (`ThemeEngine.unlock` is only
called from `theme-achievements.js`, and after `ThemeAchievements.unlock` has
already added the key), so the event lives one level up and `theme-engine.js` is
untouched: no merge risk with that lane. If a future path calls
`ThemeEngine.unlock` for a real earn, add the dispatch there too.

## Where things live

| Piece | File |
| --- | --- |
| Toast + drawer + pure helpers | `docs/pro/js/trophy-case.js` (`window.NBDTrophyCase`) |
| Styles (tokens only; injected as a `<link>`) | `docs/pro/css/trophy-case.css` |
| Event + panel button | `docs/pro/js/theme-achievements.js` |
| Lazy load | `script-loader.js` `theme` bundle (after `theme-achievements.js`); loader `?v` 195 -> 196 in `dashboard.html` / `customer.html` |
| Test | `tests/trophy-case-2026-10-11.test.js` |

No new boot script: it rides the lazy `theme` bundle, so the boot budget is
unchanged.

## Not done

- The brief's "2 are on today's route" tie-in: the nudges say what is left, not
  what is on today's schedule (no verified route source to read from).
- A header button for the drawer (entry points above are the toast, Settings >
  Themes and the API).
- "Try theme" goes through `ThemeEngine.apply`; when Theme Morph (A1) lands that
  wrapper applies automatically.
