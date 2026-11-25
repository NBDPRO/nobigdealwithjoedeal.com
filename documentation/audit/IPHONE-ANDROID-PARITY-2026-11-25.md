# iPhone vs Android CRM parity (2026-11-25)

Joe's report: the NBD Pro CRM feels "further along" on his Android phone (installed
Chrome app) than on his iPhone (Safari / home-screen app), cause unknown. This note
records what the diagnosis found, what was fixed, and what is still open.

Everything here was read from the code and checked in **Chromium** phone emulation
(iPhone 13 and Pixel 7 profiles). WebKit was not installed on the session machine,
and emulation is not a real device: safe-area insets (notch, Dynamic Island, home
bar), Safari's share-sheet and picker timing, `sms:` handling, and the installed
app's resume behaviour can only be confirmed on a real iPhone.

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
  status bar in the installed iPhone app. Worth doing once Joe's screenshots
  show which ones he uses.
- `-webkit-user-select` is missing on long-press targets (older iOS selects text);
  `-webkit-text-size-adjust` only applies at 768px and narrower (landscape).
- Kanban drag is HTML5 drag-and-drop only (`crm-pipeline.js`); on touch, moves go
  through the long-press menu or the list view on both phones.
- iPad reports itself as a Mac, so the `/Mobi|Android/` share gate in
  `customer-bootstrap.module.js` skips the share sheet there.
