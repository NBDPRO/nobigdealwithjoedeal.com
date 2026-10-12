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

- `NBDAutoTheme.applyTheme(key)` / internal `paint(key)` — the single place an
  automatic switch happens. Theme Morph (A1, #2324) had already merged: it calls
  `ThemeEngine.apply(key, false, {morph:true, origin})`, so automatic switches
  crossfade (no click to grow from) and Storm Mode grows the circle from the
  banner. The themechange arrives a frame later, which is why a switch we
  caused is matched by an expected-key window, not a sync flag.
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

## C2 — Storm Mode (opt-in)

**Jo's decision:** a Settings toggle, OFF by default; it never changes the
screen unless turned on. Settings > Appearance > **Storm Mode**.

### Flow

`docs/pro/js/storm-mode.js` (lazy theme bundle, after auto-theme.js), polling
every 5 min while the tab is visible:

1. **Service area** = the customers' own coordinates (leads with lat/lng; the
   company profile's service area is free text, there is no ZIP list). Up to 4
   quarter-degree grid-cell centres go to weather.gov `points` (cached) to get
   county / forecast-zone codes + state; then one `alerts/active?area=<state>`
   per state. No address or customer coordinate leaves the browser.
2. **Qualifies:** WARNINGS only — Severe Thunderstorm, Tornado, High Wind,
   Extreme Wind (status Actual, not Cancel, not expired). Watches/advisories do
   not. Polygon warnings: point-in-polygon against customer coordinates.
   Zone-only warnings (no polygon): UGC overlap with the anchors — banner and
   theme, but **no recipient list**, so no drafts.
3. **Active:** stash the theme, hold Auto theme, switch to Storm Season
   (`apply(key,false)`, never saved), `body.storm-alert` (accent #FACC15,
   `css/storm-mode.css`, loaded on demand), banner with Open Storm Watch /
   Keep my theme / Dismiss. "Banner only" setting skips the theme + accent.
4. **All-clear** = two consecutive *successful* empty polls (a failed poll is
   never an all-clear). Theme restored (unless the user hand-picked one
   mid-storm), Auto released.
5. **Drafts** (only now, after the storm has passed, and only if the setting is
   on): callable `fileStormDrafts` files one `draft_text` per customer who was
   inside a warned polygon into `agent_inbox`. Pending event state survives a
   reload for 24 h; ids are `storm_<event>_<lead>` + `create()` so a second
   device/tab files nothing twice.

### SMS rules — where each is enforced

| Rule | Where |
| --- | --- |
| Nothing sends without a human Send | The callable never texts, never writes `sms_log`; the owner sends from their own phone through the Agent inbox (`agentDraftAction` 'sent') |
| STOP register / company Do Not Text / declined consent / no phone | At filing (`L.textGate` + `OptOut.isOptedOut` — skipped, counted by reason, never named) **and again** at send |
| Quiet hours 8am-9pm homeowner-local, texting switch | At send (`PhoneText.okToText` in 'sent'/'check'); a draft filed at 2am just waits |
| Wording | Fixed server template (company name + STOP line via `buildTextDraft`, Kentucky claim-wording gate); the client sends ids + hazard only. No claim / outcome / price / insurance words |
| A2P sender | N/A while drafts go from the owner's own phone; the `TWILIO_INBOUND_ENABLED` TODO in agent-mcp.js is where a business-line send would re-enter, behind the same checks |

`fix/storm-messaging-safety` is merged (as #2114, squashed — the branch
itself is not an ancestor): it guards the *server-side automatic* storm texts
(storm-watch subscribers), a different path; Storm Mode adds no automatic
sender.

### Tests

`tests/storm-mode.test.js` (alert qualification, polygon / anchor maths, state
machine, glue in a vm sandbox with an injected clock and stubbed NWS: OFF means
no theme / DOM / network effect) and
`tests/storm-mode-drafts-2026-10-11.test.js` (fixed wording, skips by reason,
idempotence, role gate, 40 cap). Break-tested on both sides. New callable
registered in `function-map.json` and `viewer-callables.test.js`.

### Not done / follow-ups

- Needs a deploy of `functions/` for drafts to file (theme + banner work
  without it; the draft call fails quietly and retries for 24 h).
- Polls only while the CRM tab is open — by design ("only while the app is
  open"); a storm that passes with the app closed is not detected afterwards.
- The Auto panel's "Storm alert" rule is satisfied by Storm Mode's hold, not by
  `setContext({storm})`; if a layout engine wants the same signal it should
  listen for `body.storm-alert`.
- Banner position is fixed top-centre; verify against the live header on iPhone
  before relying on it in the field.
