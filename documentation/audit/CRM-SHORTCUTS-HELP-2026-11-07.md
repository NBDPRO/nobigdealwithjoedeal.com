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

## Also in this PR: PL-F27

Sign-out (`window._signOut`) now stops the live estimates listener before `signOut(auth)`, through a new `window._unsubscribeEstimates`. Until now the listener outlived the token, errored with permission-denied, and its error handler re-fetched during teardown. `tests/signout-estimates-unsub-2026-11-07.test.js` runs the shipped `_signOut` and records the order of calls: 5/5 with the fix, 3 fail on main.

## Held: boot budget

Together the two fixes add about 440 shipped (minified) bytes to `dashboard-bootstrap.module.js`. Main sits 184 bytes under the shipped local-script ceiling in `dashboard-boot-budget-2026-10-03` (2856 KB), so this PR fails that gate as it stands. Raising the ceiling is a deliberate decision for Jo, so the PR stays a draft until he chooses: raise it by 1 KB, or trim bytes elsewhere first.

**Update 2026-11-09:** no longer held. The 2026-11-08 boot-weight batches lowered the shipped local-script ceiling to 2570 KB with headroom for this PR and #3008. Carried onto the NBD OS P3 follow-up branch with Jo's OK (2026-11-09): main + both PRs measures 2,628,313 B shipped of a 2,631,680 B ceiling, so no raise was needed. The bootstrap cache key is now `?v=43`.
