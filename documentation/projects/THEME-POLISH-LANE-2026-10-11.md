# Theme polish lane — 2026-10-11

Lane "theme-polish" of the CRM style integration
(roadmap: `CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11.md`, PR #2322; Track A). One PR per
slice; this note is appended to as each slice lands.

## A1 — Theme Morph (idea #03)

**What shipped.** `ThemeEngine.apply(key, save, opts)` is now a thin wrapper;
the original swap lives on as `ThemeEngine._applyNow`. A deliberate switch
(`save !== false`, or `opts.morph === true`) is wrapped in
`document.startViewTransition` and the new theme grows as a circle from the
element the user last clicked (`clip-path` animated from JS on
`::view-transition-new(root)`).

| Situation | Behaviour |
| --- | --- |
| View Transitions supported, normal motion | circle morph, duration = `--ui-dur-sheet`, easing = `--ui-ease` (the A1-foundation motion tokens) |
| No recent click (auto-theme timer, remote hydrate with `morph:true`) | default root crossfade, no circle |
| Reduce Motion — OS `prefers-reduced-motion` **or** the Comfort toggle (`html[data-motion="reduce"]`) | no view transition; 150 ms colour crossfade via `html.theme-fade` |
| View Transitions unsupported | same 150 ms crossfade |
| `save === false` (boot, Firestore hydrate, mode flip) | instant, synchronous — first paint is never animated |
| Locked theme not yet unlocked / same theme / hidden tab / `opts.morph === false` | instant; the lock gate still bounces to the default |

**ThemeOverlays pause.** The canvas overlay is destroyed and `enabled=false`
before the snapshot (so a particle loop is not running underneath the wipe)
and re-applied for the new theme once `transition.finished` settles. Rapid
back-to-back switches `skipTransition()` the in-flight one; only the latest
resumes the overlays.

**Return value unchanged.** `apply` still returns the applied key
synchronously (callers like `maps.js` rely on it); the swap itself happens in
the transition callback one frame later. Anything that reads
`ThemeEngine.getCurrent()` in the *same tick* after `apply(..., true)` now sees
the previous theme — none of the current callers do, but a new caller that
needs the immediate state should call `_applyNow` (or pass `{ morph: false }`).

**Callers for later slices.** Try-for-10-min / auto-theme / storm: call
`apply(key, false, { morph: true })` (animated, not persisted) and
`apply(prev, false, { morph: true })` to revert. `opts.origin = {x, y}`
overrides the circle origin (use the picker chip's centre).

**Verification.** `tests/theme-morph-2026-10-11.test.js` runs the real engine
in a vm sandbox with a stub DOM (35 checks, break-tested: removing the
reduced-motion gate reddens the reduce-motion rows; removing the overlay pause
reddens the overlay rows). Real Chrome via Playwright against a harness page:
circle clip-path mid-transition at 1280 and 390 px, 150 ms fade class under
`reducedMotion: reduce`, no page errors.

**Files.** `docs/pro/js/theme-engine.js` (wrapper + helpers, `script-loader.js`
cache-bust `?v=8`), `docs/pro/css/theme-system.css` (view-transition pseudo
rules + `html.theme-fade`).

## A3 — the twelve new themes (spec section 17)

**What shipped.** `gameboy-dmg`, `virtual-boy`, `ds-lite`, `pallet-town`,
`poke-center` (light), `mystery-dungeon`, `hoenn-tides`, `mecha-hangar`,
`saturday-morning`, `shingle-crew`, `chalk-line` (light), `tar-paper` —
registered in `ThemeEngine` THEMES (after `maximal`), each with a
`:root[data-theme]` token line and an `--accent-fg` line in `theme-system.css`.
All unlocked for everyone (Jo 2026-10-11: none Pro-only, none locked), so the
picker shows them in their categories with no further wiring: the Settings
picker reads the registry.

**Deliberate deviations from the spec text.**
- `poke-center` accent `#d62d2d` -> `#d12929` (spec claimed >= 4.5:1 on `--bg`;
  measured 4.46). `shingle-crew` muted `#a3a3a8` -> `#a6a6ab` (6.17 -> 6.39 on
  `--s2`, spec floor 6.2). Everything else is the spec's palette verbatim.
- Light themes (`poke-center`, `chalk-line`) use darker semantic
  green/red/gold/blue than the spec's shared `#22c55e`... set, which fail as text
  on a white card.
- `--glow` / `--glow2` ship as optional tokens with `:where(:root)` defaults
  derived from the accent (zero specificity, so the 195 older themes resolve and
  a theme's own line wins). One consumer: a static cards-only hover glow scoped
  to the twelve new themes.
- No `live-themes.json` exists in the repo (it is a Grok-side artifact the spec
  checked against); the registry is the live list.

**Art.** Original tiles only, via `scripts/build-theme-art.mjs`: `shingle-crew`,
`chalk-line`, `tar-paper`, `mecha-hangar`. The seven franchise-named themes stay
colour-only (consistent with the existing "no art for real products" rule); real
sprites belong in a user's private My Skin.

**Verification.** `tests/theme-pack-2026-10-11.test.js` (68 checks: registry,
CSS<->engine mirror, spec contrast floors measured with the shipping math,
`:where` defaults, art scope; break-tested by locking one theme and removing the
defaults). `theme-qa` now covers 207 engine themes x 2 modes + 82 static themes,
3025 checks green; crm-theme-contract, theme-contrast, css-token-resolution,
theme-art, theme-daylight/liveops green. Rendered in real Chrome at 1100 and 390
px (dark: gameboy-dmg, tar-paper, shingle-crew, mecha-hangar; light:
poke-center, chalk-line).

## A4 — Surface style: Solid / Tinted / Glass (idea #02)

**Correction to the roadmap.** "No glass-surface setting exists" was only half
true: Settings > Appearance > Shape & Depth already has `glass`, `liquid`,
`fluent` (Mica) and `spatial` presets with baked-in translucency
(`shape-styles.css`). Surface style is the *orthogonal* axis the design doc
asks for: how see-through the cards are, independent of corner/elevation
character. The CSS is written at specificity 0,2,0 (`:where()` list) so those
0,3,0 presets keep winning where they already paint their own surfaces; Surface
style does its work under Sharp / Linework / Pressed / Soft / Elevated / Tonal /
Clay / Skeuo.

**Where it lives.** Comfort tab (the appearance picker), next to Density and
Text size. `html[data-surface="tinted|glass"]` (absent = Solid = today's look),
mirrored on `body.surface-tinted` / `body.surface-glass` for layout code (D4/D5
glass layouts should key on these). `localStorage nbd_surface_style|blur|frost`,
synced to `userSettings.surfaceStyle|surfaceBlur|surfaceFrost` and hydrated like
`shapeStyle`. Stamped before first paint by `shape-preboot.js`, the same sync
head script that stamps `data-shape`.

**Readability guard.** `--glass-frost-eff` = max(user Frost dial, the smallest
frost at which `--t` on `--s2` stays >= 4.5:1 over BOTH a black and a white
backdrop). It is wallpaper-independent on purpose (so it needs no My Skin
luminance pass and is safe before B-track lands); it re-runs on every
`themechange` / `modechange`. When My Skin gains its per-image luminance, that
value can tighten (never loosen) the guard.

**Fallbacks.** No `backdrop-filter` -> Glass renders as Tinted;
`prefers-contrast: more` -> opaque; blur only on the few big surfaces
(w-card/stat-card/ui-card/panel/sidebar), pipeline cards and rows get
translucency only.

**Verification.** `tests/surface-style-2026-10-11.test.js` (33 checks): guard
== engine contrast math for all 207 themes, setter behaviour in a stub DOM,
CSS scoping/fallbacks, wiring. Break-tested (removing the guard's max() or the
`@supports not` fallback reddens it). smoke 4417, shape-styles, theme-qa,
css-token-resolution green; rendered in Chrome at 900 and 390 px (dark + light
theme over a colourful backdrop).

**A4 placement update.** The setter + guard live in `docs/pro/js/surface-style.js`
in the lazy `theme` bundle, NOT in `dashboard-ui-prefs-boot.js`: the first cut
pushed the render-blocking boot budget over its 300 KB ceiling (Unit suites
caught it). The pre-paint stamp stays in `shape-preboot.js`;
`dashboard-state.js` kicks the bundle for a saved Glass user; `nbdComfortSet`
loads the bundle on demand. Comfort markup uses `.npm-surf-*` classes (the
dashboard inline-style ratchet counts markup).
