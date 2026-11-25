# iPhone vs Android CRM parity (2026-11-25)

Joe's report: the NBD Pro CRM feels "further along" on his Android phone (installed
Chrome app) than on his iPhone (Safari / home-screen app), cause unknown. This note
records what the diagnosis found, what was fixed, and what is still open.

Everything here was read from the code and checked in **Chromium** phone emulation
(iPhone 13 and Pixel 7 profiles). WebKit was not installed on the session machine,
and emulation is not a real device: safe-area insets (notch, Dynamic Island, home
bar), Safari's share-sheet and picker timing, `sms:` handling, and the installed
app's resume behaviour can only be confirmed on a real iPhone.

**Update, same day:** with Joe's OK, Playwright WebKit (build 2370) was installed in a
separate browsers folder, and the checks re-ran with the iPhone on WebKit and Android
on Chromium. Both match: theme-color, the safe-area caps parse, no input under 16px,
the same Create sheet, and every changed script parses (a broken-script control is
caught). One open question: this Windows WebKit draws the Add Lead dropdowns as
light-grey native boxes even though the CSS gives them a dark background, so it needs a
look on the real iPhone before anything is restyled.

## Not the cause

- No code serves the two phones different builds. Online navigations bypass the
  service worker, `/pro/` pages are `no-store`, and JS/CSS are
  `max-age=0, must-revalidate` (`firebase.json`). A fresh launch gets the same
  build on both.
- No CSS nesting; every `backdrop-filter` carries its `-webkit-` twin;
  `viewport-fit=cover` and the `apple-mobile-web-app-*` tags are present; the
  bottom navs pad for the home indicator; no JS builtins older Safari lacks.

## Causes found, and the fix

| Gap | Cause | Fix |
|---|---|---|
| Features missing on the iPhone for a whole session | `docs/pro/js/feature-flags.js` gave up waiting for sign-in after 10 s and never retried a failed read; 47 files read these flags | waits up to 2 min, retries a failed read, re-reads on foreground (10-min TTL kept) |
| Installed app runs an old build for days | the page only reloaded when `sw.js` bytes changed (rare) | `docs/pro/js/safe-reload.js` compares `window.__NBD_RELEASE` with live `/version.json` on foreground and, once per live build, shows the "New version ready" bar; the reload happens on a tap or the next time the app is left while idle (not on resume itself: an upload or an estimate held in memory is invisible to the busy check) |
| Status bar differs | `theme-color="var(--bg)"` is invalid; Android used the manifest's orange | literal `#0A0C0F` on dashboard and customer pages |
| Text body dropped on some iPhones | 13 `sms:` builders used a bare `?body=`; two %-encoded the number | `?&body=` (the shape `phone-share.js` already used) and plain digits; stored missed-call drafts are upgraded where shown or opened (call center, bell, home strip, push click). The server still writes `?body=` so the call-feed golden fixture stays byte-identical |
| D2D voice memo unplayable on iPhone | blob always labelled `audio/webm`; iPhone records mp4 | uses the recorder's type and a matching file extension |
| Estimate share sheet falls to "copy link" on iPhone | share called after a network save; Safari's tap permission had expired | on `NotAllowedError`, one confirm tap retries the sheet (`customer-bootstrap.module.js`, `job-templates-ui.js`) |
| Camera fallback picker silently not opening | `fallback.click()` after an awaited failure | a confirm tap opens the picker (`photo-engine.js`) |
| Map voice control loops error toasts | `onend` restarted after `not-allowed` / `service-not-allowed` | a refusal switches voice control off (`maps-routing.js`) |
| Page zooms when a field is tapped | inputs with no type, date/time inputs, the bulk-bar selects and `.btn`-styled selects stayed under 16px | `mobile-polish.css` 16px rule extended; emulation finds no text field under 16px on the dashboard |
| Sheets under the clock / Dynamic Island in the installed app | bottom sheets at 88-95vh and centred modals with no top inset (`black-translucent` draws the page under the status bar) | D2D, quick knock, Add Lead, call brief, crew drawer, receipt review and numbers sheets capped at the screen minus the top safe area; `.modal-bg` pads the top inset on phones; Add Lead Save clears the home bar |
| Android-only home-screen shortcuts | `manifest.json` `shortcuts` have no iOS equivalent | "Record a Visit" and "New Estimate" added to the + Create sheet |

Pinned by `tests/iphone-parity-2026-11-25.test.js` (fails on the pre-fix code).

## Still open (not fixed in this pass)

- Centred dialogs at 86-92vh in about a dozen feature stylesheets (canvasser,
  claim-core-view, contact-labels, promise, production, product-library,
  social-studio, visit-recorder, winback-view, sort-customers, theme-bridge
  :65/:137) and the `calc(100vh - Npx)` OS dialogs can still reach under the
  status bar in the installed iPhone app. **Fixed in the follow-up PR (same
  day):** each keeps its height but is capped at the screen minus twice the top
  safe area (a centred box starts at (H - h) / 2); the win-back bottom sheet at
  the screen minus one inset; the how-to modal's `#id` rule too, since it
  outranks `.nhm-inner`; and the customer page's Edit Customer modal. Pinned in
  `tests/iphone-parity-2026-11-25.test.js`; checked on WebKit and Chromium.
- `-webkit-user-select` is missing on long-press targets (older iOS selects text);
  `-webkit-text-size-adjust` only applies at 768px and narrower (landscape).
- Kanban drag is HTML5 drag-and-drop only (`crm-pipeline.js`); on touch, moves go
  through the long-press menu or the list view on both phones. **Fixed in a
  follow-up (same day, Joe's pick):** `kanban-touch-drag.js`. On any touch screen
  showing the Board, hold a card ~0.3 s to lift it, drag it to another column
  and let go (the same `moveCard(…, { isDrag: true })` a desktop drop uses).
  Let go without moving and the 0.5 s card menu opens as before. The board
  auto-scrolls at the edges. A touched card is non-draggable for that touch, so
  both phones get the same gesture. Checked with real TouchEvents on WebKit and
  Chromium.
- iPad reports itself as a Mac, so the `/Mobi|Android/` share gate in
  `customer-bootstrap.module.js` skips the share sheet there.
