# SESSION 2026-11-09: NBD OS P1 (board, widgets, company home, Daily Success app, Shutdown, wallpapers)

**Lane:** CRM / NBD OS. **Branch:** `os-p1` (worktree `.claude/worktrees/os-p1`), not pushed at the time of writing.
**Design:** [NBD-OS-HOME-DESIGN-2026-11-09](NBD-OS-HOME-DESIGN-2026-11-09.md) §8 "P1" (its "What shipped in P1" section, at the top, points back here).
**Parent plan:** [NBD-OS-PLAN-2026-11-06](NBD-OS-PLAN-2026-11-06.md).
Everything here is dark behind `osLayout` (and `osSystemLayer` for the tray), for every tenant.

## 1. What shipped (six lanes, then one integration pass and one final fix round)

- **Board and drag.** `docs/pro/js/layouts/board-logic.js` (Bento's board math, lifted), the 4-column desk board with 160px rows (one column below 1100px, never hidden), the corner grip, hold-and-drag on the phone, keyboard move/resize.
- **P1 widgets.** Needs you, Storm, Closes this week, Money (cents), Smart Stack with "Why this?"; the urgency ring and frecency on the OS icons.
- **Company home.** `settings/layout` `defaultWidgets['os-phone'|'os-desk']` plus `homeLocked`; Publish to team and Lock team homes in edit mode; rules suite `tests/firestore-rules.os-company-home.test.js`.
- **Daily Success app.** An OS app (same tab, dock, Start, Spotlight); the business half (goals from `companies/{cid}/settings/goals`, today's doors); the kind streak (floors count Mon-Sat, Sunday never breaks it); rules suite `tests/firestore-rules.os-daily-goals.test.js`.
- **Shutdown v1.** The 4 PM - 8 PM widget and the sheet: own leads touched today with no next step, unfiled visits, overdue promises; one tap per row through the follow-up writer, with Undo.
- **Wallpapers.** Time-of-day wallpapers, per-surface wallpaper ids, the picker, My Skin pictures by id with a company lock.

## 2. Decisions made on the way (and why)

- **Goals: done vs left.** The lane asked for "Calls 3 of 10" against goals. Nothing in the CRM counts calls or follow-ups *done*; `nbd_today_summary` holds what is *left*. So only doors (a real count of today's knocks) is shown against a goal ("Doors 4 of 40"); the Today counts stay "left today" and are never set against a goal. No invented numbers. `callsPerDay` and `followUpsPerDay` are stored and rules-validated but **not read yet**, and **nothing in the app writes `settings/goals`**: for now goals can only be set from the Firebase console.
- **Closes this week** ranks with the CRM's own `closes-week-logic.js` (the `closesweek` bundle, the Home card's inputs), not a new ranking.
- **Shutdown's touch signal** is a *human* touch on the rep's own lead from stamps only a person's action writes (`lastContactedAt`, `lastOutboundAt`, a stage entry by this uid, a task completed today, a knock lead made today). `updatedAt`, `stageStartedAt`, `lastInboundAt` and other leads' `createdAt` are not touches. Full rule: the header of `docs/pro/js/os/shutdown-logic.js`.
- **Urgency is the member's own.** The ring and Needs you "waiting" count only new leads owned by the signed-in member (userId, else assignedTo) or by nobody; a teammate's new lead in a manager's `_leads` does not ring (final round).

## 3. Final fix round (2026-11-09)

One commit each, test first:

1. `firestore.indexes.json`: knocks `(userId ASC, createdAt ASC)` for the Daily Success doors count. The query (`userId ==`, `createdAt >=`, no orderBy) sorts ascending; the only index was loadKnocks's `(userId ASC, createdAt DESC)`. Without it, production would fail the count and the Doors line would silently never show. The ds-business suite pins the entry.
2. `functions/agent-mcp-logic.js` `my_today`: sends `missed_yesterday` beside `missed_last_workday` (same value) for one release, so a personal-key prompt reading the old field keeps working.
3. Shutdown catalog `tapReads` is 40 (listAll's `visit_captures` limit: one query, up to 40 billed doc reads), not 1.
4. The 4 PM / 8 PM tick also repaints a Smart Stack whose card on screen is Shutdown (the repaint keeps the pick; no re-pick on a timer).
5. Urgency ring / Needs you "waiting": own leads only (§2).
6. Laptop desk: the Edit Home / Add widget bar is its own row under the board (the column is a flex column, the board scrolls). At 1280x800 the old sticky bar covered the bottom row at first paint.

## 4. Open items and known gaps (for the PR body and the next session)

- **Goals have no editor** (§2). `callsPerDay` / `followUpsPerDay` are unread until something counts calls and follow-ups done.
- **Rules bound the company home lists by type and size only.** `firestore.rules` checks `defaultWidgets['os-phone'|'os-desk']` is a list of 24 or fewer; each item's shape (id, `s`, `cfg` size, `items`) is checked only on the client (`cleanDefaultWidgets`, `companyList`). Rules cannot loop over a list; only the owner or a company_admin can write here, so the risk is low, but the lane's "size/shape bounds" are met for size only.
- **Phone nested scroll.** Phone page 1 scrolls vertically inside the horizontal pager once widgets pass 20 cells, which the 24-item cap allows: the nested-scroll risk in the design's §3.3. It still needs the real-iPhone pass that gates P1 drag.
- **Laptop edit mode.** With the bar now its own row, the Publish to team / Lock team homes buttons above the board also stay put, so in edit mode the board's visible height is about 120px shorter on a 800px-tall laptop. It scrolls; nothing is covered.
- **board-logic.js is a lifted copy, not a re-export.** `bento.js` is unchanged and `tests/nbd-os-board-2026-11-09.test.js` pins parity on a table of inputs. It meets the lane's either/or, but two copies can drift; the design wanted a re-export. Follow-up debt: make `bento.js` call `board-logic.js`.
- **A second timer.** `layouts/os.js` polls for auth claims (`setTimeout` 500 ms, at most 120 times, about a minute, like layout-system's poll), cleared on unmount. The design said "one visibility-aware ticker"; this is bounded and acceptable, but it is a second timer.
- **`my_today.missed_yesterday` is deprecated.** Drop it one release after this ships.
- **Urgency missed-call branch.** The ring's fallback (missed calls under 30 minutes, from the Today plan) is not filtered to the member; for a manager the plan is company-wide. Not changed in this round.
- **Index scanner blind spot.** `scripts/check-firestore-indexes.js` treats an inequality's implicit sort as direction-free, so it passed the doors query against a DESC index. Treating it as ascending flags four more queries outside this lane that rely on a DESC index (`functions/handlers/adjuster-board.js` recordings, `functions/handlers/admin.js` and `functions/integrations/compliance.js` api_usage, `functions/handlers/ai-texting-stats.js` ai_drafts). Check those against production before changing the scanner.

## 5. Verification

Gates and suites run on the branch head: `check-js-syntax`, `run-test-manifest --check`, the dashboard boot budget, the full node bucket, `tests/smoke.test.js`, both new rules emulator suites, and the three browser suites. Screenshots (scratchpad, not committed): the integrated set at 390, 320, 1280 and 1000 wide; the laptop ones re-taken after the desk bar change.
