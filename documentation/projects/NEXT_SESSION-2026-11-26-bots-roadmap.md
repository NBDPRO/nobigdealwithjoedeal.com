# Next session: bots, agents and schedules roadmap (2026-11-26)

This is a lane handoff, not the live brief. The Current handoff pointer in [INDEX](../INDEX.md) still names the live one.

- **Audit and roadmap:** [BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22](../audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md). Its §5 progress blocks have the step-by-step detail.

## Where it stands

All 17 roadmap steps are done, merged or in the merge queue:

| Step | What | PR / where |
|---|---|---|
| 1-4 | Unattended permission stall, morning run, agent-settings check, merge autopilot by `hold` label | local ops tooling (see audit §5) |
| 5 | A customer is asked for a review once | #3235 |
| 6 | One owner per inbox topic; `dedupe_key` | #3240 + local prompts |
| 7 | What's live in Bland, read-only | #3239 |
| 8 | Quinn gate: warn + one extra tap, `withdraw_item`, wider social wording gate | #3246 |
| 9a | Server AI prompts fence customer text | #3236 |
| 9b + 10 | Bot door hides contacts; runtime kill switches; key provenance; Thursday off switch; Grok twin keys revoked | #3264 |
| 11 | Heartbeat ledger + `cronDeadman`, daytime alerts | #3237 |
| 12 | One AI plan gate + $1.38/day spend breaker | #3242 |
| 12/13 | A tripped breaker reaches Joe (company cap: bell + push; platform/public cap: text) | #3266 |
| 13 | One owner-notify path (texts Joe) + Scheduled-checks issue | #3247 |
| 14 | Dead desktop tasks archived and deleted | local |
| 15 | Official Anthropic SDK client + model/prompt registry, back-office routes first | #3265 |
| 16 | One customer send window, 8am-8pm in the recipient's time; cron manifest | #3243 |
| 17A | Dark, read-only server mail feed | #3254 |
| 17B | Office planner on the server (dark) | #3267, in the merge queue at handoff |
| 17C | One call record: Thursday calls in `phone_calls`; Thursday audio under retention | #3268 |

## Waiting on Joe (nothing here is automatic)

**Thursday (Bland)**
- Add the `from` Reference Variable on staging, test, then promote 0.7.0. Production 0.6.2 still has the banned phrase. See [THURSDAY-BLAND §14](../architecture/THURSDAY-BLAND-2026-09-26.md).

**Local settings and tooling**
- Make the step-3 agent app settings changes (private note).
- Run `nbd-ops/narrow-repo-write-rules.js` yourself.

**Turn-ons (all ship dark)**
- **Mail feed:** set the secrets per [MAIL-FEED-SETUP](../runbooks/MAIL-FEED-SETUP.md), then `MAIL_FEED_ENABLED`.
- **Office planner:** `OFFICE_PLANNER_ENABLED`, then `officePlanner: true` on NBD's `agent_settings`.
- **Thursday retention:** `CALL_RETENTION_THURSDAY_ENABLED`. It is a dry run by default.
- **Platform tenant:** `platformTenant: true` on NBD's subscriptions doc.

**Not sent yet**
- The Grok bot brief amendments (AMEND-001) are drafted in the local Agent Hub and not sent.

## Follow-ups

- **Demo-walk flake:** "New knock: focus is back on the button" fails now and then. `goTo('d2d')` plus the `hashchange` handler run `D2D.init` twice, and the second render replaces the opener. The fix is running in its own session.
- **`@stranger` E2E:** the sign-up/onboarding test times out now and then across unrelated PRs, without a code cause. Watch it; if it starts failing every run, investigate.
- **E-sign reminders:** `esignReminderSweep` runs hourly but is filed under the daily heartbeat check. That is harmless.
- **Review asks across time zones:** they run once a day at 10:00 ET, so a Pacific-time customer is never asked (see audit step 16).
- **Bot instructions wording:** they now say no *customer* contacts are returned, because `rules_reference` keeps the company's own payment line.

## Lessons from this lane

- **Merge, don't rebase.** The safety guard blocks force-push and `git reset --hard`. To update a PR, merge `origin/main` in a fresh worktree.
- **Check the parent before keeping your side.** When a stacked branch's parent squash-merges, the conflicts usually resolve to "ours", but only after checking that ours really contains main's change.
- **Two PRs that each add a gate or flag will collide.** Their count pins conflict, so the second to merge needs both names and the count raised by one.
- **Most red checks were not real failures.** Queue runs cancel PR-event runs, so a red "Pro demo walk" is often a cancellation. Read the job conclusion before diagnosing.
- **Review merged stacked branches separately before opening the PR.** That review is what found the 8 bugs above.
