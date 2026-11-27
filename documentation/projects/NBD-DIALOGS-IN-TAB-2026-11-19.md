# NBD Pro dialogs live in the tab (2026-11-19)

Native `confirm()` / `alert()` / `prompt()` sit outside the page DOM. They block
CDP, so Claude in Chrome, Playwright and other agents time out on screenshots,
`find` and `read_page`, and the tab looks frozen when it is waiting on the
dialog (found sending a PDF for signature from `/pro/esign-setup`).

## What was wrong

- `window.nbdConfirm` / `nbdPrompt` already existed, but only in
  `docs/pro/js/standalone-compat.js` **inside the installed PWA**
  (`if (!isStandalone) return;` sat above them). In a normal browser tab every
  `window.nbdConfirm || native` idiom fell through to the native dialog.
- Pages that never load `standalone-compat.js` (esign-setup, photo-review,
  understand, project-codex, pricing, ai-tree) had no provider at all.

## What changed

- `standalone-compat.js` (dashboard + customer pages): the dialogs and the
  `alert()` reroute are defined in every browser; the installed-app patches
  (window.open, link interception, safe area) stay standalone-only. Dialog has
  `role="dialog"`, `aria-modal`, stable ids `nbd-dialog`, `nbd-dialog-confirm`,
  `nbd-dialog-cancel`, `nbd-dialog-input` (+ `data-testid`), and Enter no longer
  confirms while Cancel has focus. Byte-neutral for the dashboard shipped-bytes
  ceiling: paid for by dropping a dead passive `touchmove` listener (it never
  called preventDefault) and a duplicate CSS line.
- New `docs/pro/js/nbd-dialog.js` for pages without `standalone-compat.js`
  (same contract, focus trap, Esc = cancel, Enter = confirm, danger style via
  `nbdConfirm({title, message, confirmText, cancelText, danger})`). It yields to
  an existing provider.
- Direct native `prompt()` sites now `await window.nbdPrompt(...)`: copy-link
  boxes (review-ui, clipboard-fix, customer-bootstrap, dashboard-api,
  inspection-report-engine, job-templates-ui), doc-preflight signer label,
  maps-customers view name, maps-routing line length and structure rename,
  nbd-doc-viewer signing email, photo-editor callout/text, project-codex,
  widgets monthly goal, `_prospectPrompt`.
- `alert()` is routed globally on every page that loads a provider, so the
  ~12 alert sites need no per-site edit.
- Guards: `tests/nbd-dialog-2026-11-19.test.js` (contract, provider on every
  page that needs one, exact allowlist of remaining native prompt/alert) and
  `tests/e2e/pro-dialogs.spec.js` (DOM dialog, click-through, Esc/Enter, no
  native dialog event). Run the spec against a local serve; it needs the new files.

## Allowlist (remaining native text, with reasons)

- `nbdPrompt || window.prompt` tails in customer-gallery-share, estimate-crm-ops,
  invoice-pipeline: unreachable once a provider loads.
- `deal-room.js` (2 alerts): public customer deal-room page, no CRM scripts.
- Native `confirm` fallbacks after `window.nbdConfirm ||` stay (pwa-confirm-guard
  allowlist); every page using them now loads a provider.

## Follow-ups

- Dashboard bytes are at the ceiling (2613 KB). Any future dashboard JS needs the
  conductor's single raise.
- iPhone feel of the in-tab dialogs in the installed app is untested here.
