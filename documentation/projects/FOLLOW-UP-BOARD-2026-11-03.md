# Follow-up board (2026-11-03)

Extends the [Open Estimates Follow-Up Board](ESTIMATE-FOLLOW-BOARD-2026-10-19.md) into one owner screen that ranks who needs Jo next. It ships **dark** and **sends nothing**: every button either files a draft in the Agent inbox for Jo to edit and send himself, stamps one lead field, or snoozes.

**Flag:** `followUpBoard` in `feature_flags/_default` (or per user in `feature_flags/{uid}`). Absent or false = the toolbar button stays hidden, nothing is read or written, and the server refuses the `fu_*` wordings. The older `estimateFollowBoard` flag is unchanged and does not unlock this.

## Ranking (Jo, 2026-11-03)

1. **Customers waiting on your reply**: `lastInboundAt` (or a portal message, `lastHomeownerMessageAt`) is newer than Jo's last answer and at least 2 hours old.
2. **Estimates you promised**: `estimatePromisedAt` is set, no estimate shared since (`lastSharedAt` / `estimateSentAt`; a stage move does not count), flagged once the promise is 4 hours old.
3. **Estimates sent, no answer**: the existing board's rules (`buildBoard`), unchanged.
4. **New leads nobody has touched**: stage New, 3+ days old, nothing from Jo, no customer message sitting there.

A lead shows once, in the highest section. Inside a section: biggest `jobValue` (projected) first, then oldest. Do-not-contact and snoozed leads are counted, not shown. Lost, won, signed, deleted and archived leads are out.

## What changed

- **Inbound stamp (server).** `incomingSMS` used to write `lastContactedAt` on an inbound text, so a customer reply looked like a touch by Jo and hid the estimate. It now goes through `functions/inbound-stamp.js` and writes `lastInboundAt`, `lastInboundVia`, `unreadInbound` (nothing for a possible STOP). Portal messages stamp `lastInboundAt` too. Eight readers that used `lastContactedAt` as "any activity" also read `lastInboundAt`, so a lead that just wrote is not called stale.
- **`estimatePromisedAt`** (ms). Set by "I promised an estimate" on the board (search a customer, tap). `window.NBDFollowUpBoard.markPromised(leadId)` is public so a customer-card button can call it later.
- **"I replied"** stamps `lastOutboundAt` (needed for Thumbtack, where Jo answers inside the Thumbtack app).
- **Drafts.** Three new template keys (`fu_reply_ack`, `fu_promise_est`, `fu_new_checkin`) on the existing `fileLeadTextDraft`, same gates, refused server-side unless `followUpBoard` is on.
- Files: `docs/pro/js/follow-up-board-logic.js` (pure), `follow-up-board.js` (screen), `docs/pro/css/follow-up-board.css`, `functions/follow-up-templates.js`, `functions/inbound-stamp.js`. Tests: `tests/follow-up-board-2026-11-03.test.js`, `tests/inbound-stamp-2026-11-03.test.js`.

## Not built (and why)

- **Thumbtack message link.** `thumbtack_messages` stores the raw payload only and no real message delivery exists in the repo to read the shape from (`functions/integrations/thumbtack-logic.js` says to tighten once one is read). A trigger written blind could stamp the wrong lead. Needs one real delivery with name and phone blanked. Until then Thumbtack rows are cleared with **I replied** or **Snooze**.
- Morning digest, email draft callable, "close as lost" button: not in this round's scope (design note `Money/Design - Follow-up Board 2026-11-03`).
- Counsel should read `fu_new_checkin` (a first-touch check-in) before the flag goes on.
