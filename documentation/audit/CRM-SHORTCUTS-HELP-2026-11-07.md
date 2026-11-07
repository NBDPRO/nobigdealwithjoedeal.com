# Keyboard Shortcuts "Got it" closes the panel — 2026-11-07

This is part of the [overnight CRM audit](CRM-AUDIT-HARNESS-2026-11-06.md), finding PL-F23.

The `?` key opens the Keyboard Shortcuts panel (`showShortcutsHelp` in `dashboard-bootstrap.module.js`). The panel had three problems:

- **"Got it" did nothing.** The button's close target was `div[style*=fixed]`. The panel is styled by a class (`dbx-posfixed-top0-lef0`), so `closest()` found nothing. Only a backdrop click closed it.
- **`?` stacked panels.** Pressing it again added a second panel on top of the first.
- **No keyboard close.** There was no Escape, no focus trap and no focus return.

**Fix:**

- The panel has an id, and "Got it" targets `#nbdShortcutsHelp`.
- A second `?` is ignored while the panel is open.
- The panel calls `nbdOverlay.attach`, the shared dialog contract, for Escape, the Tab trap and focus return.

`maps-routing.js` uses the same `div[style*=fixed]` selector, but there it is correct: that overlay is inline-styled `position:fixed`.

`tests/shortcuts-help-close-2026-11-07.test.js` runs the shipped function. It passes 7/7, and 4 checks fail on main.
