# Open Estimates Follow-Up Board (2026-10-19)

**Why:** about 18 estimates sat in "estimate sent" with a lot of projected value and no clear next touch. Plan 2 of the five plans Jo approved on 2026-10-19. It ships **dark** and **sends nothing**.

**Flag:** `estimateFollowBoard` in `feature_flags/_default` (or per user in `feature_flags/{uid}`). Absent or false = the toolbar button stays hidden, nothing is read or written. Jo flips it in the Firebase console (Claude cannot write prod flags); flags are cached up to 10 minutes.

## Phase 0: audit (what already existed, what was missing)

| Piece | Where | Covers | Gap the board fills |
|---|---|---|---|
| Home card, buckets 2 / 5 / 10+ days, opened or not, pre-written text, stamps `lastEstimateNudgeAt` when Jo shares | `docs/pro/js/estimate-followups.js` | The nudge itself, from Jo's phone share sheet | Starts at day 2, no job-type grouping, no value ordering, no day 14 / 30 close-out, no results |
| `fileLeadTextDraft` callable, one `draft_text` into the Agent inbox, STOP / Do-Not-Text / consent / wording gate, idempotent per template per day | `functions/pixel-draft.js`, `pixel-draft-logic.js` | Safe drafting | Only one estimate wording (`estimate_check_in`), no cadence |
| Marcus `estimates_status`, `draft_text`, `draft_email` | `functions/agent-mcp-logic.js` | Bot-side listing and drafting | Not a phone screen for Jo |
| Agent inbox send path (re-checks STOP, Do Not Text, consent, kill switch, hours) | `docs/pro/js/agent-inbox.js` | Everything about sending | Nothing; untouched |
| `functions/lead-followup.js` | | New web leads only | Left alone |

**N is 3.** The Home card already owns days 2 to 3, so the board starts where a quiet estimate has had no touch from Jo for 3 days and is at least 3 days out (`MIN_DAYS` in the module; the pure `buildBoard` takes a `minDays` option, clamped 1 to 30).

## Phase 1: the board (read-only)

Toolbar button **Estimate follow-ups** (count badge) opens a one-column panel. An open estimate is listed when it is `N`+ days out, quiet `N`+ days, past its next cadence day, not snoozed (snooze or a future follow-up date), not closed / lost / signed / deleted / archived, and not marked do-not-contact:

- grouped **Cash / Insurance / Finance** (the lead's `jobType`, stage as the fallback), each with a count and a **projected** total;
- inside a group: **opened-but-silent first**, then biggest value, then longest quiet;
- shows name (links to the customer), customer-facing job value (`jobValue` only; no cost, margin or contractor field is read), days out, days quiet, last touch, opened or not, and the next step.

Anyone left out is counted, never silently dropped: not due yet, finished the cadence, marked do-not-contact.

**One-tap draft:** **Draft text** calls the existing `fileLeadTextDraft` with `{ leadId, template }` (a key, never words). The server builds the wording, adds the business name and the STOP line, runs the Kentucky wording gate and the STOP / Do-Not-Text / consent checks, and files one `draft_text` in the Agent inbox (once per template per customer per day). If the server refuses, the board shows its words and files nothing. A customer who already has a pending draft shows "Draft waiting in your Agent inbox" and no second button. **Jo edits the draft and sends it from his own phone** in the Agent inbox, which re-checks everything again at send.

**No text consent / STOP / no phone:** the row says "email or call"; **Email wording** shows a copy-only email (never sent, no mailto) with a reminder to add the mailing address and an unsubscribe line. Finance adds a payment-options line (day 3, 7 and 14 emails only, not the day-30 close-out). No business name known = a visible `[your business name]` placeholder, never a hard-coded one.

**I sent it** (or **I called**) stamps `lastEstimateNudgeAt`, `lastEstimateNudgeVia` (`board_text` / `board_email` / `board_call`) and `estimateNudgeCount` through the Home card's own `stampNudge` (exported as `NBDEstimateFollowups.stampNudge`). The board and the Home card therefore share **one stamp** and cannot prompt twice for the same touch.

## Phase 2: cadence and results

Cadence is days since the estimate went out: **3, 7, 14, 30**. The step is the later of "the next one in line" and "the latest cadence day already passed", so a 46-day-old estimate nobody touched gets the day-30 closing wording, not "making sure it came through". After the day-30 message the row leaves the board. A nudge stamped before the estimate was re-sent does not count; the cadence restarts for the new send. Between sends a row stays off the board until it has been quiet N days.

Four fixed wordings in `functions/estimate-follow-templates.js` (keys `est_follow_d3`, `_d7`, `_d14`, `_d30`), added to `ALL_TEMPLATES` in `pixel-draft-logic.js`. Pixel World's own four (`TEMPLATE_KEYS`) are unchanged. Each says the business name and ends with "Reply STOP to opt out." (texts only). None mentions the claim, an adjuster, coverage, a deductible, advance payment, a waiver or rebate, assignment of benefits, a guarantee, a price, or a deadline; none says "licensed", "in-house" or "employees". One neutral wording serves every job type, so no per-lead branching is needed to stay safe. The client's copy-only email lines are pinned equal to the server lines by the test.

**Results tab** (follow-ups Jo sent in the last 90 days): follow-ups sent, replied (customer's last reply after the last follow-up), opened after, signed since, median days from sent to signed. **Signed value and open pipeline are labelled projected.** The only revenue figure is **Collected from those jobs**, the real ledger sum (`NBDRevenue.collectedByLead`, payments dated, refunds off) loaded only when the Results tab opens; if it cannot load it says "Not loaded" and shows no number.

## What it does not do

No automatic send, no text, no email, no mailto, no `sms_log` row, no new callable, no change to `lead-followup.js`, the Agent inbox, the kill switch (`messaging_controls/global`) or any messaging code. The only server change is data: four more template keys for the existing draft callable (a deploy of `fileLeadTextDraft` is needed for the keys to be accepted; until then the callable answers invalid-argument and the board shows that). Customer texting is OFF today; texts go one to one from Jo's own phone.

## Known limits (follow-ups, not built)

- Counsel has not ruled whether estimate follow-ups are marketing (messaging rules reference, "HOLD" list). Drafts to Jo are fine; any automation (plan P4) needs Jo's explicit go and counsel.
- Waiting-draft detection reads `agent_inbox`, which only the owner and company admins can read; for other roles the callable's once-a-day idempotency is the only guard.
- Estimates the CRM only knows through the Home card's old nudge count use that count as "touches since sent".
- Replies come from `lastInboundAt` / `lastReplyAt`; if those are not stamped for a customer, the reply is not counted.
- The Chief of Staff weekly line (plan item) is not built.
- `docs/pro/dashboard.html` already has a missing close tag on `#leadSourceFixerBtn` (browsers auto-close it; not touched here).

## Verification

`tests/estimate-follow-board-2026-10-19.test.js` (registered in `tests/ci-manifest.json`): qualifying rules and cadence math, grouping and sort, channel rules, every wording through the real builder and Kentucky gate (with a positive control that the scan can fail), results math, the real module in a vm sandbox (flag off / viewer / member render, read and write nothing; flag-on positive control; Draft sends exactly `{leadId, template}`; refusal shown; I-sent-it goes through the shared stamp), and source guards (no network, no send, no write of its own). 19 mutations tried: 17 killed, 1 equivalent (a duplicate `available()` guard already enforced by the click delegate), 1 weak mutant re-run properly and killed. Related: [SPEED-TO-LEAD-2026-10-19](SPEED-TO-LEAD-2026-10-19.md), [LEAD-SOURCE-FIXER-2026-10-19](LEAD-SOURCE-FIXER-2026-10-19.md).
