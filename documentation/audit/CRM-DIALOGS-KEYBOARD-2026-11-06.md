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

## Update — PR steward review (2026-11-06 evening)

1. **Escape now goes to the layer opened last.** The duplicate-customer prompt (an `nbdOverlay` dialog) opens over Add Lead (an `nbdModal`).
   - The bug: `nbd-modal.js` handles Escape on `document` and stops it, and `overlay-a11y.js` listens on `window`, which comes later. So Escape closed Add Lead and left the prompt open.
   - The fix: both files stamp an open order from one shared counter (`window.__nbdLayerSeq`), and `overlay-a11y.js` exposes `nbdOverlay.topSeq()`. `nbdModal`'s Escape handler steps aside when an overlay layer opened after its top modal.
   - Unchanged: a confirm opened over an overlay dialog still closes first, because it is the newer layer.
   - Size: `nbd-modal.js` is parser-blocking, so the addition is kept terse. Shipped blocking bytes stay under the boot budget, 87,027 against a ceiling of 87,040.
2. **Safer initial focus.** The duplicate prompt starts on Cancel, not on the first "open existing" match, so a reflexive Enter no longer navigates away from a half-typed form.

Test: `tests/escape-layering-2026-11-06.test.js` loads the real `nbd-modal.js` and `overlay-a11y.js` into one fake page and dispatches Escape the way a browser does (document listeners, then window). It passes 6/6, and 2 checks fail on the PR head before this commit.
