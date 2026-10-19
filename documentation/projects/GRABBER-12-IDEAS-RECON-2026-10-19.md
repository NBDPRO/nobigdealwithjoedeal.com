# Grabber's 12 design ideas: what is on main (recon, 2026-10-19)

Jo said "Grok and I did 12 mockups, I don't think half made the cut." Source:
Drive doc "NBD CRM design ideas" (id `1S3gwk5-bRu7yfTOp75XwFcaNe93gEEPFXSTjE5Cvcgw`).
Recon of `origin/main` at `caec4e04`. Method: grep each idea's spec phrases
across `docs/pro/`, find the PR in `git log`, check a CALLER (loader, `dashboard.html`,
`script-loader.js`, Settings markup) and a test.

**Result: all 12 are on main, and 11 of 12 shipped in the 2026-10-11/12 style
roadmap run** (see [NEXT_SESSION-2026-10-12-style-roadmap](NEXT_SESSION-2026-10-12-style-roadmap.md)
and [CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11](CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11.md)).
Nothing is wholly missing. What is left are four small gaps inside #02, #11, #12
(and one question on #08), listed below. Almost none of these ideas sit behind a
`feature_flags` flag: they are **opt-in settings** (Settings > Appearance,
Comfort, Layout picker) that are off until a person turns them on. So there is
no flag for Jo to flip for most of them.

| # | Idea | Status | Evidence (file / PR) | Reachable how |
| --- | --- | --- | --- | --- |
| 01 | Ambient accent from wallpaper | built | `my-skin.js` (`ambientLock` at 817, 1373, 1448; `tintAllowed` 821), `my-skin-logic.js:124`, test `my-skin-ambient-2026-10`, #2348 | Settings > My Skin: Follow wallpaper, Tint surfaces, Lock for this theme |
| 02 | Glass card mode | built, one gap | `surface-style.js` (blur 136-181, `--glass-frost-eff` 96-100), `shape-preboot.js:40-48`, test `surface-style-2026-10-11`, #2329 | Comfort: Surface style Solid / Tinted / Glass + blur and frost sliders. **Gap:** the readability guard reads theme colors only; `surface-style.js` has no wallpaper-luminance sample, so a bright photo under glass is not detected (spec: raise frost when wallpaper makes text < 4.5:1) |
| 03 | Theme Morph | built | `theme-engine.js` (`startViewTransition`, `pauseOverlays` 6071), `theme-system.css`, test `theme-morph-2026-10-11`, #2324 | Every theme switch; also Storm Mode and Trophy "Try theme" (`trophy-case.js:158`) |
| 04 | Live preview in theme picker | built (mostly) | `theme-preview.js` (Try 10 min 255-270, Favorite line 12/22, recent), test `theme-preview-2026-10-11`, loaded by `script-loader.js:383`, #2333 | Theme picker split view. Minor: preview is one dashboard card; the spec's Pipeline / Estimate PDF / Phone tabs are not there |
| 05 | Storm Mode | built | `storm-mode.js` (`body.storm-alert` 421, `keepTheme` 268, banner links to Storm Watch, drafts), `css/storm-mode.css`, tests `storm-mode`, `storm-mode-drafts-2026-10-11`, #2332; Mission Control #2360 shares the swath code | Settings > Appearance > Storm Mode, **off by default** (Jo's 10-12 decision). Drafts only, never sends |
| 06 | Auto theme | built | `auto-theme.js` (NOAA sun calc, rule stack Storm > GPS > Day cycle > Rain > Fallback), `dashboard.html:3651`, test `auto-theme-rules`, #2325 | Settings > Appearance > Auto |
| 07 | Command palette 2.0 | built | `command-palette-scopes.js` (`@ # > t: =`, `evalMath` 286, never eval, usage ranking 307), lazy-loaded from `command-palette.js:194`, test `command-palette-scopes-2026-10-11`, #2338 | Ctrl/Cmd-K palette |
| 08 | Pixel Mode | built | `pixel-mode.js`, `pixel-mode-core.js`, `pixel-logic.js` (Party), `pixel-world*.js`, `css/pixel-mode.css` (Press Start 2P + VT323), `dashboard.html:932,3830`, tests `pixel-mode`, `pixel-world`, `pixel-draft`, #2327 #2341 #2345 | Settings card (skin, scanlines, dialog notifications). Sprites are canvas-drawn, original. The spec's "every screen" skin is the L-size part and is only partial by design |
| 09 | Achievement toasts + Trophy Case | built | `trophy-case.js` (`themeunlock` listener 381, almost-there `NEAR` 29), `theme-achievements.js:230`, `css/trophy-case.css`, test `trophy-case-2026-10-11`, #2335 | Toasts fire on unlock; Trophy Case drawer in the theme area. Minor: "almost there" does not yet cite today's route |
| 10 | Pipeline rich cards | built | `pipeline-rich-cards.js` (rich / photo density, Hail verified chip 135, going-cold filter, Open / Weighted / Going cold strip), `css/pipeline-rich-cards.css`, test `pipeline-rich-cards-2026-10-11`, `dashboard.html:162,7213`, #2330 | Pipeline board card-style switch Compact / Rich / Photo |
| 11 | Job map: crew day route | partial | `layouts/mission.js` + `routeplan.js` (nearest-neighbour + 2-opt; real drive times #2506), stage pins, layers bar (jobs, leads, swaths, roof age), "On my way" draft (413), tests `layout-mission-2026-10-12`, #2360 #2365 #2506 | Mission Control layout. **Gaps:** Crews chip is a disabled stub ("No live crew locations are collected yet", `mission.js:435`: there is no truck-location data source); no "safe to be on a roof" weather chip on the stop or route (only hail/wind warnings) |
| 12 | Field Sunlight Mode | partial | `layouts/field.js` (Sun toggle 173, stored `nbd_field_sun`, `html.sun`; test-square Capture with +/- counter and carrier-threshold hint 367-397), `layouts/picker.js:225,349` (Glove mode = 64px taps), test `layout-field-2026-10-11`, #2349 | Field App layout only. **Gaps:** the spec's `body.field-mode` token reset in Comfort (usable in *any* layout/screen) does not exist, sunlight is scoped to the Field layout; it does not turn on automatically at a job site (auto-theme's GPS rule is not hooked to it); glove checklist with per-item photo counts is not separate from the 64px tap setting |

## What is actually left to build (smallest first)

1. **#12 sunlight everywhere + job-site auto-on.** Promote Sun from Field-layout
   class to a Comfort setting that works on every layout, and let the auto-theme
   at-a-customer rule (`NBDAutoTheme.registerRule`, `nbd:auto-theme` event) turn
   it on. Biggest field win; touches `layouts/field.js`, `dashboard-ui.js`, CSS.
2. **#11 roofing-weather chip.** "Safe to work on a roof" from the weather.gov
   hourly forecast Auto theme already caches (wind, precip, lightning). Mission
   route header + stop popover. Crews/trucks stay out until there is a location
   source (that is a data question for Jo, not a code one).
3. **#02 wallpaper-aware glass guard.** Sample the My Skin wallpaper luminance
   under the content area and raise `--glass-frost-eff`. This reads
   My Skin state, so it must be coordinated with the per-theme wallpapers
   session (do not edit `my-skin*.js`, `my-skin.css`, `storage.rules` here).
4. **#04 preview tabs** (Pipeline / Phone) and **#09** route-aware nudges: polish,
   only if Jo wants them.

## What needs Jo

- Confirm he is happy that #1-#10 exist already (the "half" he remembers
  missing are most likely the layouts: Field, Mission, Crew, Focus, Inbox,
  Bento, Island, all on main since 10-13).
- A real **phone / daylight pass** (standing rule) on Sunlight, Storm banner,
  rich cards on the installed iPhone app. Nothing here was exercised on a device.
- Whether to build live crew locations for #11 (needs a data source decision).
