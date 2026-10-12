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

## Slice B2: bulk import, thumbnails, the all-themes grid, the soft quota

**Import** (`my-skin-import.js`, lazy: nothing loads until "Import a pack…" or
"All theme backgrounds" is pressed). A folder (`webkitdirectory`) or a .zip.
`NBDMySkinLogic.matchImportName` is the spec's reference algorithm: lower-cased
stem is a theme id -> picture 1; `<id>-n` with n 1..6 -> picture n; ignores
`previews/`, `__MACOSX`, dotfiles, csv/md and the 13 category names. Tested
against every live id from `theme-engine.js` (ids only): `<id>.jpg`,
`<id>-2..6`, folders, uppercase, `-7` refused, no false matches. A test also goes
red on purpose if a new theme id ever collides with another id's slideshow slot.
Review table: Replace / Add to slideshow / Skip per theme (themes that already
have pictures default to Skip), Replace all / Add all / Skip all, unmatched list.
Queue: 3 themes at once, each file re-encoded (worker, main thread fallback),
uploaded with its 256 px thumbnail, theme entries committed 25 at a time in one
merge; pause, cancel, retry failed, resume (finished file name+size kept in
`sessionStorage nbd_myskin_import`, re-pick the pack), `beforeunload` warning.

**Zip reading: no library.** The spec asked for a vendored fflate. Instead the
module reads the zip central directory itself
(`NBDMySkinLogic.parseZipDirectory`, unit-tested against zips built in-process)
and inflates with the browser's `DecompressionStream('deflate-raw')` (Chrome 80+,
Safari 16.4+, Firefox 113+; older browsers are told to use Folder). No download,
no vendored code, no licence. Limits: 500 MB zip, 400 entries, 20 MB per
picture, 1.5 GB expanded, Zip64 and encrypted entries refused, and an entry
that inflates past its declared size is cut off (a header that lies about size
cannot make a zip bomb).

**Worker.** `my-skin-encode-worker.js` (OffscreenCanvas, same maths via
`importScripts('my-skin-logic.js?v=3')`; the test pins that cache-buster to the
pages'). `worker-src 'self' blob:` was already in the app CSP. A browser
without OffscreenCanvas, or a format only the page can decode (HEIC on Safari),
falls back to the main-thread encode. Measured in a browser: no long task over
200 ms across an import.

**Thumbnails.** `<imageId>_t`, 256 px webp q0.7, made for every new upload
(single and bulk), flagged `thumb: true` on the entry, deleted with the picture.
`storage.rules` imageId is now `^[a-z0-9]{8,16}(_t)?$` (still owner-only, lossy
only, < 3 MB; emulator cases include a thumbnail read by another user / admin).
Pictures uploaded in B1 have no thumbnail; the grid shows their swatch.

**Grid** ("All theme backgrounds"): by category, swatch + lazy thumbnail
(IntersectionObserver, 200 px), picture count, Locked tag, filters All / Has
picture / Missing / Locked, search. Picking a card edits that theme **without
applying it** (the card says "(not applied)"; Preview applies it through
ThemeEngine). Hover prefetch in the theme picker (`#npm-grid [data-theme-key]`,
set in maps.js): 150 ms debounce, 3 in flight, off on phones and Data Saver.

**Soft quota** (Jo, 300 MB): `usageBytes` = distinct per-theme objects' stored
bytes. The panel shows usage; a single upload to a new theme, the import's
Start button and each file in the queue refuse past 300 MB with a message. This
is UI-only; the hard 1 GB cap is a Cloud Function on Storage finalize (own PR).

## Slice B3: slideshows, the strip, use for all, share, removed themes

**Rules** (pure, `my-skin-logic.js`, unit-tested): `slideshowPlan` turns the
user's interval into a mode (`static` / `load` / `timed`) and applies the
automatic adjustments, which always win: reduced motion = load mode with no
fade, Data Saver = load mode, phones (<= 600 px) = at least 1 min, low battery
(< 20 %, not charging, only where `navigator.getBattery` exists) = paused. The
panel says which one is active. `makeBag`/`nextSlide`: shuffle uses a bag per
cycle and the last picture of a cycle never starts the next; in order starts
with the user's first picture. `loadSlide` steps once per dashboard load or theme
switch (position in `sessionStorage nbd_myskin_pos_<themeId>`, swept at sign-out).
`timerHide/timerShow` keep the remaining time across a hidden tab.

**Painter.** One page-wide timer, reset by every theme change. Only the next
picture is fetched ahead (at interval - 5 s, or at once for 30 s). A hidden tab
clears the timers and resumes with the time left. The editor being open on the
theme being shown holds rotation. New fade = the resolved `fadeMs` (0 under
reduced motion). Changing interval or order re-arms the timer without
restarting the set.

**Settings.** Global defaults (Slideshow defaults: interval, order, crossfade
with Off / 0.4 / 0.8 / 1.5 s presets, "Reset all themes to my default") and a
per-theme "Use my default slideshow settings" checkbox that reveals that
theme's own controls (null = inherit).

**Strip.** Up to 6 pictures per theme: "Add pictures" takes several at once
(first replaces nothing, the rest append; past 6 the toast says so), reorder by
dragging the handle (pointer events) or ArrowUp/ArrowDown on the focused item,
up/down buttons, remove one (the last one clears the theme; objects are deleted
only when nothing else references them).

**Use for all themes** stores `allThemes` with a snapshot of the picture
(`image`), so clearing the host theme never strands it or deletes the object.
**Share with this category** copies the entry (same stored objects, no bytes)
to every theme of the category with none. **Removed themes** (entries whose id
the engine no longer has) are listed in the grid with Move to... and Delete
(two-tap); they are never painted.

Verified in a browser with a fake clock: in order 1,2,3,1,2; shuffle with no
immediate repeat over 9 shows; hidden tab 2 min = no change, resumes with the
time left; reduced motion no rotation; phone 30 s runs at 1 min; keyboard
reorder writes the new order; cap at 6; use for all survives clearing the host.

## Slice B4: company background sets (spec section 18)

**What it is.** A company admin pushes a set of backgrounds, per theme or one
for every theme, as **suggested** (a member can override or hide it) or
**enforced** (a member cannot, apart from raising dim and blur). Personal skins
stay private; company pictures are private bucket objects too, read by members
with `getBlob()`, never public, never in the repo.

**Data.** Storage `companies/{id}/skins/themes/{themeId|_all}/{imageId}[_t]`
(webp/jpeg, < 3 MB; readable by that company's members and platform admin;
writable by its company_admin, or the solo owner of a company of one).
Firestore `companies/{id}/skin/config` (one doc, one listener): `enabled`,
`allowHide`, `show`, `all`, `themes`, `rightsAttestation`, `usage`. The rules refuse
a client write to `usage`/`usageUpdatedAt` (the Cloud Function writes them) and
bound `themes` at 220. Members gain `mySkin.company { show, hide }` and
`mySkin.hidePictures` ("Hide background pictures", beats everything including an
enforced set: accessibility wins).

**Precedence** (`resolveWithCompany`, 8 steps, one unit test per step): company
enforced for the theme; enforced for every theme; personal set; personal "use
for all"; personal global wallpaper; company suggested for the theme; suggested
for every theme; built-in art. Enforced paints even when the member's My Skin is
off; suggested paints for members who never set My Skin up. A member can raise
dim and blur on an enforced picture, never lower the dim below the company's
`minDim` (or the company dim, or the readability floor).

**Member panel.** "Your company's backgrounds" (status, "Show my company's
backgrounds" when `allowHide`), per theme a note ("Set by your company" or
"Your company suggests a background"), Use the company's picture, Hide for this
theme; an enforced theme disables picking, clearing and fit.

**Admin panel** (`my-skin-company.js`, lazy, company_admin or solo owner only):
master switch, "let people turn them off", preview as a team member, the rights
tick (required before any upload), usage bar, add pictures (up to 6 per theme,
or "Every theme"), mode and minimum dim per set, remove a picture or a set.

**Caps.** 6 per theme and < 3 MB (rules), 220 entries (rule), 500 MB per
company (the Storage trigger in #2343 deletes the object that crosses it and
records `usage.rejectedAt`; the panel also refuses before uploading).

**Offboarding / erasure.** A removed member's claims are stripped and
`offboardLock` set, so company reads fail at once; their personal skin is
untouched (`skins` is in `NOT_MOVED_PREFIXES`). Company sets live under
`companies/{id}/`, so they stay when an admin leaves.

**Not done in this slice (follow-ups).** Bulk import into a company set (the
personal import module is not yet target-aware); a "set by your company" toast
on the member's next load; company-deletion sweep and data export of
`companies/{c}/skins/` and `skin/config` (needs the deletion-sweep owner);
the Comfort-tab placement of "Hide background pictures" (it sits in the My Skin
panel for now).

### Proposed Terms / Acceptable Use clause (text only; not a legal edit)

> **Company backgrounds.** If you are an administrator and you upload pictures
> to your company's backgrounds, you confirm that your company owns them or has
> permission to use them and to show them to everyone on your team. NBD Pro
> stores them privately for your company and does not review them. Do not
> upload customer photos, personal information, or material you do not have the
> right to use. You are responsible for what you upload; we may remove content
> that breaks these terms or the law.

Needs counsel's eye before it goes on the Terms page (spec open question 15).

## Open / next

- Storage caps (1 GB per person, 500 MB per company): PR #2343.
- B5: ambient accent.
