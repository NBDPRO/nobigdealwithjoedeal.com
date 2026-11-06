# Pipeline board: four ways to act on the wrong lead, closed — 2026-11-06

From the 2026-11-06 full CRM audit (PL-F03, PL-F04, PL-F05, PL-F07; scorecard on the
`crm/2026-11-06-tooling` branch, `overnight/crm/SCORECARD.md`).

## The past incident, located
Two records were once corrupted by "clicking a board card while the search was still filtering". A trace of
every board path (plain click, arrows, ⋮, right-click, list view, follow-up strip, Show all, chips, hotkeys)
found they all read the lead id from the clicked element at click time — except the **phone long-press menu**
(`kanban-context-menu.js`). It captured the card under the finger at touchstart and opened 500 ms later; the
search re-renders 250 ms after typing. Type, then long-press the first card: the board re-filters under the
finger and a menu with no name opens for the card that USED to be there — the first card of the unfiltered
column. "Move to stage" then moved the wrong lead.

## Fixes
- **PL-F03 (P0):** no menu when the pressed card is no longer on the page (`card.isConnected`); the primary menu
  now shows the lead's name at the top.
- **PL-F07 (P1):** "+ → Photo" used `_cardDetailLeadId` even after the mobile job detail closed, so the camera
  saved to the last customer viewed. It now counts only while a detail surface is open (both call sites).
- **PL-F05 (P1):** bulk-selected cards lost their highlight on re-render while bulk actions still applied to
  them; `renderColumnCards` re-applies it.
- **PL-F04 (P1):** a drop on an empty column (board-level `window.drop`) moved without the dragged job id, so a
  customer's second-job card moved their active job; it now carries the job id like the per-column handler.

## Proof
`tests/board-wrong-record-guards-2026-11-06.test.js` runs the real menu module and the real
`renderColumnCards` / `window.drop` source: 9/9 on the fix; against main the 5 guarded assertions fail and the 4
positive controls pass. Local harness: `#/crm` and `#/home` load with no page errors for owner and rep.

## Gotcha found on the way
Restoring a file with `git show <rev>:path > path` writes LF into this CRLF checkout (it emits the normalized
blob), and splicing CRLF text into it gives a mixed file. Keep a byte copy before a break-test and restore from it.
