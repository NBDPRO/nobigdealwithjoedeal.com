# Delete-confirm and duplicate-customer dialogs work from the keyboard — 2026-11-06

From the 2026-11-06 full CRM audit (PL-F16, PL-F17; scorecard on the `crm/2026-11-06-tooling` branch). Tier A.

Both dialogs were self-built and never joined the shared keyboard contract `window.nbdOverlay`
(`docs/pro/js/overlay-a11y.js`): no dialog role, focus stayed on the board behind, Escape did nothing, and the
single-letter hotkeys stayed live behind them. The duplicate-customer prompt's promise never even settled on
Escape. Both now call `nbdOverlay.attach` (Escape = the dialog's own Cancel; focus in, trapped, returned).
"Open existing" from the duplicate prompt now asks before it navigates away from an Add Lead form that has typed
content (notes were lost before).

Real dashboard, local emulator (scripts/audit/harness.js):

| | main | now |
|---|---|---|
| Delete confirm: role / focus inside / Escape closes | none / no / no | dialog+aria-modal / yes / yes (nothing deleted) |
| Duplicate prompt: role / focus inside / Escape | none / no / ignored (promise never settled) | dialog / yes / cancels |

`tests/dialogs-keyboard-2026-11-06.test.js` pins the wiring (10/10; 6 fail on main). Left for later: the
customer-card popups (CU-F15) — `customer.html` doesn't load overlay-a11y.js yet.
