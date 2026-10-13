# Away mode: hand-back note on the lead timeline (2026-10-13)

*Closes deferred item 3 of [AWAY-MODE-BACKUP-2026-10-12](AWAY-MODE-BACKUP-2026-10-12.md) section 8 ("Writing the hand-back one-liner onto the lead's timeline") and the last "Not built" away-mode line of [NEXT_SESSION-2026-10-13](NEXT_SESSION-2026-10-13.md). Companion to [AWAY-MODE-BACKUP-AS-BUILT-2026-10-12](AWAY-MODE-BACKUP-AS-BUILT-2026-10-12.md).*

## What it does

When an Away window is handed back (Jo taps I'm back, or the window expires),
every item the backup touched that is **still open** already becomes a row on
the Home "While you were away" card. Now each such row is also filed on the
matching customer's timeline, so the line is there when Jo opens the lead:

> **While you were away · Sam**: Sam: Called, no answer

- Path: `leads/{leadId}/activity/away-{windowId}-{phone10}` (admin SDK).
- Shape: `type: 'away_handback'`, `source: 'away-mode'`, `userId` / `companyId`
  = the company, `label`, `summary` (the backup's one-liner), `backupSaysDone`,
  `awayWindowId`, **`startedAtMs`** (what the timeline sorts by) and
  **`createdAt`** (server time; what `promise-cleanup` and `lead-brief` order by).
  Both order fields are written on purpose: a writer that omits the field a
  reader orders by makes the doc vanish.
- Writer: `fileHandBackTimeline()` in `functions/away-mode.js`, called from
  `doHandBack()`. Reader: `fromAwayHandBack()` in `docs/pro/js/call-timeline.js`,
  already on the customer page's `loadTimeline` path (no new script tag).

## Safety rules (each has a test in section T of `tests/away-mode-2026-10-12.test.js`)

- **Dark.** Written only when `AWAY_MODE_ENABLED=true`: the tick passes `live`,
  the I'm-back callable passes the same env gate. With the switch off the
  ledger / status hand-back works exactly as before and **no lead is written**.
- **Internal only.** Nothing is sent to a customer and nobody is notified. The
  note is a timeline row for staff.
- **Only an unambiguous match.** The lead is found by `phoneDigits` within the
  same company (`userId` or `companyId`); zero matches, a number on two or more
  live leads (an office or proxy line), a soft-deleted lead and a row with no
  phone (a `thursday:` key) are all skipped. A note on the wrong customer is
  worse than no note.
- **Idempotent.** Deterministic id + create-if-absent; a repeat hand-back is a
  no-op and never moves the timestamp.
- **Best effort.** A failure is logged and never blocks the hand-back.
- **Escaped.** The server strips control / bidi characters; the client returns
  plain strings and the customer page's renderer escapes every field. The
  backup's note is a teammate's typed text about a customer's call.
- **Not evidence.** `promise-cleanup-logic.evidenceAfter` skips
  `away_handback` entries: a backup's "done" is advisory (confirmed decision)
  and must not mark one of Jo's promises kept.
- **Not in the PDF report.** The report gather leaves the internal away line out.

## Change to an existing contract

The source-contract test used to assert that `away-mode.js` "never writes a
lead doc". It now asserts the narrower, still-true statement: the only
lead-side write is the `activity/away-` note, and only behind the timeline
flag; it still never writes a lead doc itself, nor a call, text-day, task or
customer doc.

## Not changed

- No `firestore.rules` change: the write is admin-SDK and the existing
  `activity` read rule already covers the readers.
- `customer.html` cache-busters bumped (`call-timeline.js` v=3,
  `customer-bootstrap.module.js` v=28).

## For Jo

Nothing to do until away mode is turned on. When `AWAY_MODE_ENABLED` goes
true, the first hand-back with a touched, still-open item writes these notes.
