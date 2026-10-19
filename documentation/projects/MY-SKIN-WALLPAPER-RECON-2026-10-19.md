# My Skin theme wallpapers: spec vs main (2026-10-19)

Jo asked (2026-10-19) to get the per-theme background photos live, with a
choice between real theme wallpaper and the colour theming. This is the recon
against Grabber's "Per-theme backgrounds for My Skin" spec (private; not in the
repo). Build log lives in [MY-SKIN-PER-THEME-2026-10-11](MY-SKIN-PER-THEME-2026-10-11.md).

**Finding: the feature is already built and live.** Nothing in My Skin is behind
a feature flag. It is dark by *user opt-in*: `mySkin.enabled` and
`mySkin.perTheme` both default to false, so everyone keeps today's look until
they switch it on. The only missing piece was one clear control for the choice.

## Matrix

| Spec phase | Item | Status | Where |
|---|---|---|---|
| 1 | Data model `skins/{uid}/themes/{themeId}/{imageId}`, `mySkin` schema 2 (`perTheme`, `show`, `themes`) | built | #2334, `my-skin-logic.js`, `storage.rules` |
| 1 | Resolution order (theme, all-themes, wallpaper, built-in art) | built | `resolveBackground` |
| 1 | No-flash two-layer painter, token race guard, uid-keyed IndexedDB cache, sign-out purge | built | `my-skin.js`, `nbd-auth.js` |
| 1 | Readability guard, per-theme dim/blur/focus/fit/pixel art | built | #2334, #2329 (surface style guard) |
| 1 | "This theme's background" card | built | `#myskinThemeCard` |
| 1 | **One user-facing choice "Color theme / Real theme wallpaper"** | **was partial** (two separate switches: Use My Skin + Different background per theme) | this PR: `Background style` radios |
| 2 | Bulk import: folder + zip, `matchImportName`, review table, 3-way queue, pause/resume | built | #2340, `my-skin-import.js` |
| 2 | Encode worker (OffscreenCanvas, webp), thumbnails, all-themes grid, soft quota | built | #2340, `my-skin-encode-worker.js` |
| 2 | Vendored fflate | **deliberately not done**: own zip-directory reader + `DecompressionStream` (no library, no licence) | #2340 note |
| 3 | Slideshows (interval/shuffle/crossfade, visibility + reduced-motion pause), strip, use-for-all, share with category, removed themes | built | #2342 |
| 4 | Company background sets, suggested or enforced | built | #2347, `my-skin-company.js` |
| 4 | Import into a company set; "set by your company" toast; deletion sweep/export of `companies/{c}/skins/` | missing (follow-ups, not needed for Jo's personal pack) | B4 note |
| 5 | New theme pack | built (A3 #2326) | |
| extra | Ambient accent (design idea 01), hard storage caps | built | #2348, #2343 |

## Hard caps and privacy (verified in code and tests, unchanged)

6 pictures per theme, 3 MB each, 220 theme entries, 300 MB soft / 1 GB hard per
person. Owner-only Storage rules, blob URLs via `getBlob`, no `getDownloadURL`,
nothing under `docs/`, EXIF stripped by the re-encode.

## This PR

`Settings > Appearance > My Skin > Background style`: **Color theme (default)**
or **Real theme wallpaper**. Wallpaper sets `enabled` and `perTheme` true; Color
theme only turns `perTheme` off (global wallpaper, texture, mascot untouched).
The old "Different background per theme" checkbox stays in the page, hidden, as
the single stored binding. No flag needed: defaults are unchanged.

## What is left for Jo

Load the private pack (the import tool is already live): see his private
handoff note in `nbd-ops`. No flag flips are required for this feature.
