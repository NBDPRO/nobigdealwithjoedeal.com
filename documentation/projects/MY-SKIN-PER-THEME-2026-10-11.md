# My Skin: a background for every theme (2026-10-11)

Living note for the "Per-theme backgrounds for My Skin" build (spec: the Drive
doc of that name; plan: [CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11](CRM-STYLE-INTEGRATION-ROADMAP-2026-10-11.md)). Slices ship as separate PRs; each one appends its section.

Privacy contract (unchanged and non-negotiable): the pictures are a user's own,
live in `skins/{uid}/…` (owner-only, no admin read), are read with `getBlob()`
and shown through `blob:` URLs, and are never a token download URL. **Jo's
208-image pack is never committed, never under `docs/`, never in a shared
folder.** Nothing in the repo is a real picture; tests use ids and synthetic
canvases only.

## Decisions (Jo, 2026-10-11)

| Decision | Value |
|---|---|
| Images per theme | max 6 |
| Stored image | <= 3 MB, webp 0.82 (jpeg fallback), long edge <= 2560 |
| Firestore guard | `mySkin.themes.size() <= 220` in `firestore.rules` |
| Hard cap | 1 GB per user, a Cloud Function on Storage finalize (its own PR) |
| Soft cap | 300 MB: warn and block new imports in the UI |
| Custom Builder | one `_custom` slot for all custom palettes |
| Animated overlay | a picture hides it by default (`hideOverlay: false` keeps it) |
| Phones | downscale on the device; no `_m` copy |
| "Random with picture" | not in v1 |

## Slice A2: Custom Builder announces `_custom` (PR #2323)

`applyCustomTheme()` dispatches `themechange` with `detail: '_custom'`;
`resetCustomTheme()` dispatches the real current theme id. The auto-theme
"remember my manual pick" listener in `dashboard-ui.js` ignores any key that
starts with `_` (it would otherwise store `_custom` as the day/night theme and
try to apply it later).

## Slice B1: per-theme single picture (this PR)

**Data model.** `userSettings/{uid}.mySkin` gains `schema: 2`, `perTheme`,
`show`, `themes: { <themeId>: { images: [...], dim, blur, position, fit,
pixelated, hideOverlay, interval, shuffle, fadeMs, updatedAt } }` and
`allThemes`. A schema-1 doc normalises to `perTheme: false`, so painting is
byte-for-byte what it was. `normalize()` caps 6 images per theme and 220
entries and drops bad ids and paths.

**Resolution** (`resolveBackground`): My Skin off -> nothing; with the
per-theme switch on: the theme's own pictures, then "use for all themes", then
the global wallpaper, then the theme's built-in art.

**Painter** (`my-skin.js`). With `perTheme` on, two fixed layers
(`#nbdSkinA` / `#nbdSkinB`) replace the `::before` wallpaper. The next picture
is fetched (memory LRU -> IndexedDB -> `getBlob`), decoded with `img.decode()`
on the hidden layer, then swapped in, so the old picture stays up until the new
one is ready. A switch that lands mid-fade first jumps the fading layer to full
opacity so no frame ever shows bare `--bg` (found by sampling opacity per frame
in a browser, 2026-10-11). The veil uses the live theme `--bg`, so it recolours
in the same frame as the theme. With `perTheme` off nothing changes (legacy
`::before` path).

**Cache.** Memory: 8 entries / 40 MB decoded estimate, pinned = on screen,
evicted URLs revoked. Disk: IndexedDB `nbd-myskin` / `blobs`, key
`{uid}|{themeId}|{imageId}|{v}`, 150 MB budget oldest-first. IndexedDB, **not**
Cache Storage: `sw.js` activate deletes every cache it doesn't know. Wiped by
`NBDMySkin.purgeLocal()` from `NBDAuth.purgeAccountStorage()` (sign-out and
account switch) and by `login-reset.js`.

**Readability guard** (`effectiveDim`): bright picture under a dark veil raises
the floor (0.55 + (lumCenter - 0.45) * 0.6, cap 0.8); a dark/busy picture under
a light veil floors at 0.65 (0.72 when the centre is dark); then the dim rises
in 0.05 steps until `--t` reads at 4.5:1 and `--m` at 3:1 over the composited
colour. `prefers-contrast: more` forces dim >= 0.8 and blur >= 4; phones cap
blur at 6. "Use my dim setting anyway" (`dimOverride`) opts out of the floor.
Stats (`lum`, `lumCenter`, `avg`) are computed at upload from a 32x32 sample.

**Custom Builder.** The builder sets `html[data-custom-theme="1"]` (cleared on
reset) so My Skin keys the background `_custom` while the custom palette is on,
even if a later theme pick fires `themechange` (the custom inline variables keep
winning visually until Reset).

**Writes.** One theme = one dotted-path `updateDoc` (`mySkin.themes.<id>`);
delete = `deleteField()`. The global `save()` is a `setDoc` merge that never
lists `themes`, so another device's (or an older client's) entries survive. A
removed global slot now also deletes its field (a merge alone cannot).

**Rules.** `storage.rules` `skins/{uid}/themes/{themeId}/{imageId}`: owner-only,
`^(_custom|[a-z0-9-]{1,40})$`, `^[a-z0-9]{8,16}$`, < 3 MB, webp/jpeg. Emulator
cases (positive and negative controls, incl. offboardLock) are in
`storage-rules.test.js`; the 220 guard is in `firestore.rules` with cases in
`firestore-rules.test.js` (`create, update` only: a delete has no
`request.resource`).

**Boot budget.** `dashboard-boot-budget` `localBytes` ceiling raised
4.4 -> 4.55 MB for my-skin.js (17 -> 49 KB) and my-skin-logic.js (7 -> 22 KB);
all deferred, blocking bytes unchanged.

### Verifying (no real art needed)

- `node tests/my-skin-per-theme-2026-10.test.js` (logic, rules text, contract)
- `node tests/my-skin-2026-10-01.test.js` (the original contract still holds)
- storage + firestore rules under the emulator (see CLAUDE.md for the proxy env)
- Browser: a throwaway harness served the real `#myskinPanel` markup with fake
  Storage/Firestore SDK modules and synthetic canvas pictures; sampled layer
  opacity per animation frame across switches (cached, 350 ms latency, rapid,
  mid-crossfade), real encode (3200x1800 -> 2560x1440 webp), dotted-path writes,
  clear, `purgeLocal`, and an iPhone-width pass (blur capped at 6, no overflow).

## Open / next

- B2: bulk import (zip/folder, fflate vendored), thumbnails (`_t` suffix needs a
  rules change), preview grid, soft 300 MB UI cap.
- Hard 1 GB cap Cloud Function: its own PR.
- B3: slideshows (the `images[]` list, interval/shuffle/fade settings and the
  per-theme fields are already normalised; B1 paints `images[0]`).
- B4: company sets (spec section 18). B5: ambient accent.
