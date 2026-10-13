# Label safety rails — a label must never silently hide a real customer (2026-10-13)

Jo: "we can do all 10" — this is ranked item 5 of the controls audit. It closes
audit finding **C-4** (`documentation/audit/HANDLE-AND-OPTOUT-CONTROLS-2026-10-13.md`)
and the user-facing half of UX walk **H5**
(`documentation/qa/today-ux-walk-2026-10-13/FINDINGS.md`). Design home:
[CONTACT-ROUTING-TREE-2026-10-12](CONTACT-ROUTING-TREE-2026-10-12.md). Numbers in
this note are fictional (555) — the repo is public.

## What was wrong (reproduced before the fix)

| # | Hole | Reachable by |
| --- | --- | --- |
| 1 | `quiet` swallowed an urgent / missed call from a number whose call was **filed on a customer** (no valve for quiet) | one tap: two AI `callType: supplier` calls from a homeowner make Accept default to Supplier (quiet) |
| 2 | `capture: 'off'` on a number that later became a customer stayed silent forever, and skipped texts are never recoverable (the ingest advances the cursor past them) | any personal number that later books an inspection |
| 3 | the sheet allowed `personal + surface + capture off` — a label that says "surface" and records nothing | the Label sheet |
| 4 | Accept chip copy did not say that missed / urgent calls are then dropped; toast read "Only if I promised" | one-tap Accept on Supplier / Sub / Job seeker |
| 5 | nothing told Jo a number he labeled had since become a customer | — |
| 6 | "N people hidden by labels" landed on the default Call Center tab | tap |

## What changed

1. **Lead valve now covers `quiet`** (`functions/call-watch-logic.js`
   `resurfacedNumbers`, mirrored in `docs/pro/js/home-attention.js`): a call from
   a quiet number that is filed on a customer comes back as the same
   "number matches a customer" row hide already had, once per baseline;
   **Keep hidden** moves the baseline. Quiet never bursts (a supplier ringing
   three times is not news). A quiet number that is NOT on a customer behaves
   exactly as before.
2. **Capture-off yields to a newer customer**
   (`functions/contact-labels.js captureOff(labels, digits, leadsOnNumber)`,
   wired in `call-center.js` ingest + transcribe queue and `text-inbox.js`): a
   number whose customer was created **after** the label was last set or
   confirmed is captured again (fails toward keeping the customer). A customer
   that existed when Jo chose it, or one he confirmed with Keep it off, keeps his
   choice. A lead with no `createdAt` is legacy and predates the label.
3. **Reconciliation row on Today** (`contact-labels-logic.js reconcile`,
   `contact-suggest.js`): "<Name> is now a customer — you hid / quieted / stopped
   recording this number as Supplier" with **Unlabel** and **Keep it hidden**.
   One row per person (two labeled numbers on one customer = one row), capped at
   2 with a "+N more" tail, never auto-changes the label, 9 s Undo on both
   buttons, hidden from viewers (they cannot write; reps cannot read labels).
4. **Copy says the effect before the tap** (`LG.effectText`): suggestion chips
   carry "If you accept: ...", a kind that would suppress on a number that is on
   a customer is **never one tap** (opens the sheet with "On customer X"), the
   sheet repaints an effect line for the current choice and explains the usual
   defaults, and the undo bar states the effect instead of "Only if I promised".
5. **Capture-off is honest**: the confirm now says texts that arrive while it is
   off cannot be brought back, that a customer match turns recording back on,
   and, when the number is on a customer, defaults to "Hide only". Capture-off
   forces `policy: hide` (the old doc could say "surface" and record nothing).
6. **Keep hidden has an Undo** (also the existing Today "Keep hidden" button,
   which calls `NBDContactLabels.ack`), and Undo restores the old
   `updatedAtMs` so it does not fake a fresh decision.
7. **"N people hidden by labels" lands on the Labeled list**
   (`contact-labels.js` click listener → `NBDCallCenter.setFilter('labeled')`).

## Decisions (and the one conflict)

- **Quiet vs urgent — NOT changed, by Jo's recorded decision.** The UX walk
  recommended "let urgent through on quiet". Jo's 2026-10-12 evening answer #3
  (top of the routing-tree note) says *"`quiet` stays promise / due-callback
  only"* and gives urgent breakthrough to hidden **personal** numbers only.
  This session did not relitigate that: the safety for the homeowner-typed-as-
  supplier case comes from the **lead valve** (1) and the **effect copy** (4).
  What is still dropped: an urgent call from a quiet number that is on **no**
  customer. If Jo wants urgent through quiet too, it is one line in
  `home-attention.js callNeedsYou` + `call-watch-logic.js callNeedsYou` /
  `reasonFor` (parity matrix will go red until both move).
- **Precedence "explicit label > lead match"** stands for *policy*; what changed
  is that the lead can no longer be invisible: the valve and the reconciliation
  row make Jo say so, once, per baseline.
- Smallest edit in the server lane's file: `call-watch-logic.js
  resurfacedNumbers` (policy check + `quiet` flag, 3 lines). Flagged in the PR.

## Not done / limits

- The valve reads `leadId` on the call row (set at ingest by `matchLead`); a
  *deleted* lead's id would still count. Proxy lines (3+ leads) are never
  matched, as before — labeling one still hides every customer behind it.
- Plain **texts** from a hidden customer are still excluded from the valve
  (`channel === 'text'`); only reconciliation + capture-yield cover them.
- No label history subcollection / "who hid this" (audit C-4 tail) and no owner
  notice when another user hides a number.
- Today row wording for a *quiet* resurfaced person still says "hidden number
  matches a customer" (today-home.js, other lane).
- Not run: the emulator rules suite (rules unchanged) and a real-phone pass.

## Tests

`tests/label-safety-rails-2026-10-13.test.js` (new; valve parity server vs
client, capture-yield, reconcile, suggestions, the Today row in a vm sandbox
with an XSS name, wiring pins) and an ingest-level section in
`tests/personal-capture-off-2026-10-12.test.js`. Two existing fixtures were
updated, not weakened: `contact-suggest-2026-10-12.test.js` put its tagged
number on a customer (so Accept is now two taps there by design) and
`personal-capture-off-2026-10-12.test.js` pinned the old two-argument call.
