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
