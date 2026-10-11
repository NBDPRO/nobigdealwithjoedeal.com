# CRM style, theme and layout integration roadmap — 2026-10-11

**Status:** approved by Jo 2026-10-11 (decisions below); build in progress. Jo's ask (2026-10-11):
integrate **all** of Grok's CRM design work. This note turns three Drive docs
into one ordered build plan, so each slice can be a small PR instead of one
unreviewable mega-branch.

## Sources (Drive › NBD)

| Doc | What it holds |
| --- | --- |
| [Spec: Per-theme backgrounds for My Skin](https://docs.google.com/document/d/10T104pKW01fFb10DOq5UQpXS392Nnjt4JJkR_xqgCus/edit) | Per-theme + slideshow backgrounds, bulk import, company background sets (§18), **12 new themes** (§17), 5 build phases |
| [NBD CRM design ideas](https://docs.google.com/document/d/1S3gwk5-bRu7yfTOp75XwFcaNe93gEEPFXSTjE5Cvcgw/edit) | 12 UI/UX ideas (#01–#12) |
| [NBD CRM custom layouts](https://docs.google.com/document/d/1yV49atxp1TvN8W-JWfXtT29VPq8LEM4ZG36fV6NlwBw/edit) | 8 layouts (L01–L08) + a shared Layout system |

Grok's claims are leads, not facts. Every file and engine name the docs cite was
spot-checked against `origin/main` on 2026-10-11 and **all of them exist**:
`ThemeEngine.previewCSS / previewResolvedColors / tuneAgainst / contrastRatio /
isUnlocked`, `my-skin(.js|-logic.js)`, `theme-achievements.js`, `theme-sounds.js`,
`analytics-kpi.js`, `bottleneck-widget.js`, `almost-there-widget.js`,
`customer-engagement-score.js`, `customer-smart-followup-panel.js`,
`activity-feed.js`, `customer-ai-drafts-panel.js`, `crm-snooze.js`,
`calendar-feed-ui.js`, `photo-queue-recovery.js`, `customer-photo-hub.js`,
`customer-quick-actions.js`, `d2d-tracker-*.js`, `nbdRetryOffline`.

## What exists vs what's new (checked on origin/main)

- **Exists:** My Skin v1 (one wallpaper), 195 themes, `themechange` event,
  `theme-art.css`, overlays, achievements/locked themes, `setKanbanDensity`
  density system, Storm Season theme, a **basic Comfort `autoTheme` on/off
  toggle** (`dashboard-ui-prefs-boot.js`), weather.gov calls in a few modules.
- **Does not exist:** `startViewTransition` (Theme Morph), layout registry /
  `data-layout`, glass-surface setting, Pixel Mode skin, field/sunlight mode,
  per-theme backgrounds, Trophy Case drawer, rule-based auto theme.
- **Known gap the spec calls out:** `my-skin.js` does not listen to
  `themechange` today. Custom Builder dispatches no `themechange` either.

## Overlaps — build once, not twice

| Idea | Same as | Resolution |
| --- | --- | --- |
| #12 Field Sunlight Mode | L08 Field App sunlight | One `:root.sun` token override, shipped with L08 |
| #11 Job map route | L02 Mission Control + L06 Crew Calendar maps | One shared `MapView` component |
| #05 Storm Mode | L02 context switch | One rule engine (#06) owns "storm → theme + layout" |
| #06 Auto theme | Layout "context switch" | Same rules list, two outputs (theme, layout) |
| #01 Ambient accent | Spec §5 `lum` / `images[].accent` | Compute at upload in the per-theme pipeline, not a second canvas pass |
| #02 Glass cards | L01/L03/L04 glass | One `body.surface-glass` + `--glass-*` vars |
| #08 Pixel Mode | L07 Pixel World UI frame | Pixel Mode skin first; the game reuses its frame |
| #09 Trophy Case | L07 area unlocks | Both read `ThemeEngine.unlock/isUnlocked` |

## Build order (each row = one PR or a short PR chain)

Effort is Grok's estimate for one dev; treat as a floor. "Parallel-safe" means it
touches files no other row touches.

### Track A — theme polish (no data model, ship first)
| # | Slice | Effort | Notes |
| --- | --- | --- | --- |
| A1 | **Theme Morph** (#03): `startViewTransition` around `ThemeEngine.apply`, reduced-motion fallback | S | Every later switch (storm, auto, try-for-10-min) uses it |
| A2 | **Custom Builder dispatches `themechange '_custom'`** | XS | Prereq for B1 and A3 |
| A3 | **12 new themes** (§17) + optional `--glow`/`--glow2` with `:where(:root)` defaults | 1–2 d | Update `live-themes.json`, contract/contrast/qa tests. Original SVG tiles only |
| A4 | **Glass card mode** (#02): Solid / Tinted / Glass, readability guard | S–M | Lives in Comfort next to density |
| A5 | **Live preview in picker** (#04) + Favorites/Recent + "Try for 10 min" | M | Scope `previewCSS` to a container |

### Track B — My Skin per-theme backgrounds (spec Phases 1–4, 13.5–18.5 d)
| # | Slice | Effort |
| --- | --- | --- |
| B1 | Phase 1: per-theme single image, switch, fallback, storage rule, tests | 3–4 d |
| B2 | Phase 2: bulk import (zip/folder), grid, thumbnails, vendored fflate | 3–4 d |
| B3 | Phase 3: slideshows + readability guard polish | 3.5–4.5 d |
| B4 | Phase 4: company background sets (admin push) | 4–6 d |
| B5 | **Ambient accent** (#01), per-image accent stored with `lum` | M |

### Track C — rules, storm, habits (independent of B)
| # | Slice | Effort |
| --- | --- | --- |
| C1 | **Auto theme rules** (#06): day cycle + rule list, extends the existing Comfort toggle | M |
| C2 | **Storm Mode** (#05): NWS poll → Storm Season + banner + *draft-only* check-ins | M |
| C3 | **Trophy Case + unlock toasts** (#09) | M |
| C4 | **Command palette 2.0** (#07): scopes, math, themes with preview | M |
| C5 | **Pipeline rich cards** (#10): 4th density value `rich`, aging heat bar | M |

### Track D — layout system and layouts
| # | Slice | Effort |
| --- | --- | --- |
| D0 | Layout registry + `LayoutEngine.apply` + `userSettings.layout` + pre-paint cache; wrap today's dashboard as **L00 Classic** | 3 d |
| D1 | Shared components out of the dashboard (LeadCard, ActionBar, Widget, MapView, nav adapters) | 3–4 d |
| D2 | Layout picker (Settings › Appearance › Layouts) + company default/lock | 2–3 d |
| D3 | **L08 Field App** + Sunlight (#12) | L |
| D4 | **L03 Focus Mode** | M |
| D5 | **L01 Bento Board** | M–L |
| D6 | **L05 Triage Inbox** | M–L |
| D7 | **L02 Mission Control** (+ #11 job map) | L |
| D8 | **L06 Crew Calendar** | L |
| D9 | **L04 Island Dock** | M |

### Track E — pixel (own track, last)
| # | Slice | Effort |
| --- | --- | --- |
| E1 | **Pixel Mode skin** (#08) + dialog-box notifications | M |
| E2 | **L07 Pixel World**: read-only on real CRM data → write actions → roadmap | XL |

**Recommended order:** A1 → A2 → A3 → A4 (a visible win in the first week) →
B1 → B2 → D0–D3 (Field App is Grok's and Jo's highest-value layout) → C2/C1 →
B3 → D4 → rest. Tracks A, B and C do not collide on files, so they can run as
parallel lanes once Jo approves; D depends on A4 (glass) and shares MapView
with C2.

## Guardrails every slice must keep (CI-enforced unless noted)

- **Strict CSP:** new JS is an external `defer` file; no inline scripts, no
  `on*=`. Module workers need `worker-src 'self'` confirmed in `firebase.json`.
- **Privacy:** Jo's personal 208-image pack is **never committed**, never on
  hosting; it goes into `skins/{uid}/themes/` through the importer only.
  Built-in art is original SVG; real sprites are private My Skin only.
- **Storm Mode texts are drafts** that need a Send. Honor quiet hours
  (8am–9pm local), STOP, and the A2P-registered sender; no auto-send.
- **Kentucky claim wording:** Field App, Focus and Storm copy ("hail test
  square vs threshold", "documenting for the adjuster") must not say we
  handle/negotiate the claim or promise an outcome. Run the claim-wording gate.
- **Storage rules:** the new `skins/{uid}/themes/{themeId}/{imageId}` block
  needs `storage-rules.test.js` positive *and* negative controls.
- **Phone-scale testing is a standing rule:** every layout is checked on the
  installed iPhone app and desktop; Field App also in forced-standalone and
  sunlight.
- **Theme contract:** all 195+12 themes must pass `theme-contrast` /
  `crm-theme-contract` / `css-token-resolution`; layouts read tokens only.
- **Money stays in cents; no cost/margin keys under `docs/`** (Bento tiles
  that show revenue read collected-only per the revenue rule).
- Shared checkout: each slice in its own short-path worktree
  (`C:\Users\jonat\nbd-wt-<name>`); explicit file lists on commit.

## Decisions (Jo, 2026-10-11) — all answered

1. **Order and lanes:** approved as written. Tracks A, B, C, D run as parallel
   lanes; each slice is its own worktree + PR.
2. **New themes:** all 12 ship to everyone, today (none Pro-only).
3. **Storm Mode:** **opt-in** — a Settings toggle, off by default. It never
   switches the screen unless the user turned it on.
4. **Quota rules (Jo delegated; set here):**
   - Max **6 images per theme**, enforced client-side and by a Firestore
     rule (`mySkin.themes.size() <= 220`); each stored image <= 3 MB after
     re-encode (`THEME_MAX_STORED_BYTES`), webp 0.82 / jpeg 0.86 fallback.
   - Per-user **soft 300 MB** (warn + block new imports in the UI) and **hard
     1 GB** (server-side check in a Cloud Function on Storage finalize —
     Storage rules cannot count objects). Soft limit ships with B2; the hard
     cap ships with the same PR as the finalize function.
   - Company sets: flat **500 MB** per company for v1; revisit by plan tier
     when there are paying tenants. Company images count against the
     company, never the admin's personal quota.
5. **Spec open questions:** the proposed defaults (doc size stays in
   `userSettings` until 300 KB; admin-visible theme ids OK; one `_custom`
   slot; picture hides the animated overlay by default; phones downscale, no
   `_m` copy; no "Random with picture" in v1; `dragon-ball-super` and
   `legend` stay locked; enforced company set covers backgrounds only;
   Terms get a company-backgrounds clause).
6. **Pixel World:** built in the same effort — Track E runs alongside, v1
   read-only on real CRM data behind a feature flag, then write actions.

## Not in scope / non-goals

Video wallpapers, sharing personal skins between users (company sets only),
changing theme colors from the picture except via Ambient Accent, a native app
shell (Field App ships as a PWA layout first).
