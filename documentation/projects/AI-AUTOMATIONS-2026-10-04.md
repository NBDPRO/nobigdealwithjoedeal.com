# AI automations batch — 2026-10-04

Jo approved all ten items from the AI audit. This note says where each one
lives, what it costs, and how to turn each off. Each item was checked against
main before it was built (branch `feat/ai-automations`).

## What changed

| # | What | Where | Off switch |
|---|---|---|---|
| 1 | Smart follow-up drafts now see the last 3 call summaries, Jo's open promises, the last Thursday call and recent text days. This is trimmed to about 600 tokens and fenced as untrusted `<customer_notes>`. | `docs/pro/js/smart-followup.js` (`_loadConversation`, `_conversationFrom`) | — |
| 2 | **Brief me** on the customer page. It is a primary button on a phone and gives a pre-visit summary. Claude Haiku 4.5 runs server-side only. Each brief is cached for 4 h, Refresh works after 10 min, and each user has a daily cap of 60. The morning brief prints one line per appointment. | `functions/lead-brief.js`, `lead-brief-logic.js`, `docs/pro/js/lead-brief.js`, `css/lead-brief.css` | AI kill switch, a free plan or an unverified email gives a brief built from the record only |
| 3 | **One morning email.** The 06:45 brief carries the new leads (was the 07:00 digest), "You said you'd…" (was the 07:15 sweep) and the owner's review asks (was the 08:15 nudge). It sends on days with no appointments when any of those has content. | `functions/morning-brief-absorb.js`, `morning-brief*.js` | `MORNING_BRIEF_ABSORB_ENABLED` (unset it and the three separate emails come back). It also stands down by itself if the brief is in dry run or Jo opted out. |
| 4 | Model ids. The proxy allows Haiku 4.5 and Sonnet 5.5. Deprecated Sonnet 4 is removed. Sonnet 5.5 goes out with thinking off and no temperature. Quick Measure asks for Sonnet 5.5 (its old id was never allowed, so it always silently ran on Haiku). Thursday runs on Opus 5.5 at $4/$20; only the model id changed. analyzeRoofPhoto runs on Sonnet 5.5. | `handlers/_shared.js`, `handlers/ai.js` `shapeForModel`, `tools.js`, `thursday-logic.js`, `handlers/photo.js` | — |
| 5 | AI spend in one place. There are two counter docs, `ai_spend_daily/{ET day}` and `ai_spend_monthly/{month}`, by feature, in integer micro-dollars. The health digest shows "AI spend yesterday / this month". | `functions/ai-spend.js` (the one server price table) | — |
| 6 | Nightly promise cleanup at 02:30 ET. A promise is marked kept only on an explicit, quoted, later timeline entry: the quote must appear word for word and must not use plan wording. Each change is logged to `promise_cleanup_log`. Tasks are never touched. | `functions/promise-cleanup*.js`; `call-center-logic.js` drops kept promises | `PROMISE_CLEANUP_ENABLED` (unset = dry run, which logs proposals only) |
| 7 | Weekly keep-or-cut scorecard in the health digest, covering the last 7 days. Bots: inbox items by bot and CRM calls by tool. Thursday: calls, silent, tests, new leads, existing customers, unreviewed, minutes and extraction cost. | `functions/ops-scorecard.js` | — |
| 8 | The Ask Joe standalone page goes through the proxy only. The sessionStorage key path and the direct browser call to Anthropic are removed. | `docs/pro/js/pages/ask-joe-main.js` | — |
| 9 | **One storm poller.** `stormPoller` runs the reports half, then the alerts half. The TCPA guards are unchanged. | `functions/storm-poller.js`; `storm-watch.js` `runStormWatch`; `sms-functions.js` `runCheckStormAlerts` | the integrations/stormAlerts master switch, `STORM_TEXT_ENABLED` |
| 10 | One-tap **Ask for review** email on the customer page, through the existing review email with `leadId`. `reviewRequestedAt` is stamped only when the platform actually sent it; a mailto handoff no longer counts as asked. It respects #2132's `paidInFullFor` when that is present. | `docs/pro/js/lead-brief.js` `askReview`, `review-engine.js` | role-gate blocks view-only roles |

## Deploy notes

- `stormWatch` and `checkStormAlerts` leave the code. A deploy must delete
  those two deployed functions, or the orphan check flags them.
- `MORNING_BRIEF_ABSORB_ENABLED=true` and `PROMISE_CLEANUP_ENABLED=true` are in
  `functions/.env.nobigdeal-pro`.
- The morning brief now binds `ANTHROPIC_API_KEY` for the per-appointment lines.

## Not touched (Jo decides)

- textInboxIngest / textInboxNotes (they wait on A2P).
- weeklyDigest, dormantLeadNudge, anniversaryAutoTouch and runAbandonRecovery
  (these email homeowners).

## Tests

- `tests/ai-automations-server-2026-10-04.test.js`
- `tests/ai-automations-client-2026-10-04.test.js`
- `tests/e2e/phone-brief-me.spec.js` at 390x844 (`@shard2`)

Every model call in these tests is a stub.
