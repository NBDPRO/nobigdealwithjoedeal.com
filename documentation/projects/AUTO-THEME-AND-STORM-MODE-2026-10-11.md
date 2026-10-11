# Auto theme rules + Storm Mode — build notes (2026-10-11)

Lane "rules" of the CRM style roadmap
(`CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11`, PR #2322 — not merged when this
was written; slices **C1** and **C2**). Spec: Drive "NBD CRM design ideas" #05 and #06.

## C1 — Auto theme rules (this PR)

### What was there

The Comfort "Auto theme by time" toggle (`nbd_auto_theme`, `dashboard-ui.js`
`nbdAutoThemeStart/Stop/ApplyForNow`) was **never started at boot** — a
`setInterval` only ran in the session where the toggle was flipped, so it
silently did nothing after any reload. It also applied with `save=true`, so
every automatic switch overwrote the theme the rep had chosen.

### What changed

- `docs/pro/js/auto-theme.js` (lazy `theme` bundle) owns switching now;
  `nbdAutoThemeStart/Stop` delegate to it when it is loaded (legacy path kept
  as the fallback while the bundle downloads).
- `dashboard-state.js` also loads the theme bundle at boot when
  `nbd_auto_theme === '1'`, so a default-theme user with Auto on still runs it.
- Settings > Appearance > **Auto** panel (`#autoThemePanel`, filled by JS).
- Rules + on/off live on `userSettings/{uid}.autoTheme` (JSON). A
  `nbd_auto_theme_cfg` localStorage copy only paints boot; it is not in the
  logout KEEP list, so it is wiped on sign-out (it can hold a rounded
  location). The Comfort flag key `nbd_auto_theme` is unchanged.

### Behaviour

| Piece | Rule |
| --- | --- |
| Sun | NOAA fractional-year calc, no API; Cincinnati unless the rep taps "Use my location" (rounded to 0.01 degree, about a mile) |
| Phases | Dawn = sunrise −30..+60 min, Day, Dusk = sunset −60..+30 min, Night |
| Rules (default order, reorderable, each switchable) | Storm alert > At a customer's address (GPS) > Day cycle > Rainy forecast > Fallback |
| Hand-pick | pauses Auto until the next **local** midnight ("Resume Auto now" in the panel) |
| Never switches | while a modal / estimate editor is open (retries next tick); while another feature holds the scheduler |
| Saved theme | automatic switches use `ThemeEngine.apply(key, false)` — the theme the rep chose is never overwritten |
| Locked / unknown themes | skipped, never applied |
| Rain | weather.gov `points` → `forecastHourly`, cached 30 min, only fetched when the rainy rule is on and has a theme |
| Customer address | only when the rep ticks the box AND the browser already granted location (a timer never prompts); within 150 m of a lead with coordinates; nothing stored or logged |

Boot grace: `themechange` events in the first 10 s (engine init + Firestore
self-heal re-apply the saved theme) are not counted as hand-picks.

### Seams for other lanes

- `NBDAutoTheme.applyTheme(key)` / internal `paint(key)` — **the single place
  to swap in Theme Morph** (`startViewTransition`) when lane "theme-polish"
  lands; nothing else calls `ThemeEngine.apply` for automatic switches.
- `NBDAutoTheme.registerRule(id, label, fn(ctx, cfg, phase) -> themeKey|null)`
  and the `nbd:auto-theme` document event `{theme, rule, phase}` — the layout
  context switch (idea L02 / Field App) plugs the same rule list in here.
- `NBDAutoTheme.setContext({storm, onJobSite, raining})`,
  `hold(token)` / `release(token)`.

### Tests

`tests/auto-theme-rules.test.js` (node bucket): NOAA times vs published
Cincinnati solstice times (±6 min) and polar day/night, phase edges, rule
order / off / fallthrough / extra rules, config repair, rain parsing, and the
scheduler glue in a vm sandbox with an **injected clock** (TZ pinned to
America/New_York so UTC CI agrees). Break-tested: removing the modal guard,
the own-apply guard, the midnight computation, the rule-off check, `save=false`
and the locked-theme check each turns a named assertion red.

### Not done / follow-ups

- No pre-paint stamp: on reload the saved theme paints first and Auto applies
  within ~1 s of the bundle loading (a brief flash for users whose Auto theme
  differs from their saved one).
- Job-site detection uses every lead with coordinates, not only open jobs.

## C2 — Storm Mode

_Added in the Storm Mode PR._
