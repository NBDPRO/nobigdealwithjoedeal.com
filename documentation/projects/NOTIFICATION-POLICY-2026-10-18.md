# Notification policy — how much the system tells Jo (2026-10-18)

Status: **draft for Jo's sign-off.** Nothing here changes behavior yet. Part of [BUILD-PLAN-2026-10-18](BUILD-PLAN-2026-10-18.md).

## Why

Jo wants the middle ground between too few reminders and an inbox buried in digests. A read-only look at one week of mail to `jd@` (metadata, subjects and snippets only) showed:

- About 20 NBD emails in 7 days, roughly 3 a day: 7 morning briefs, 8 Thumbtack new-lead alerts, 4 Thursday call summaries, 1 Storm Watch.
- Everything except the brief is a real, time-sensitive interrupt. **The brief is the bloat**: about 17 KB, and it repeats the same standing items every day (the same six signed jobs that "need a week", an open-promises count that sits at 17-47 and never shrinks).
- Most of the clutter in the inbox is third-party mail (card issuers, ads, newsletters), which a mail filter handles; no CRM change fixes it.

The consolidation is already half done: the 06:45 morning brief absorbs the 07:00 lead digest and the 08:15 review nudge (`MORNING_BRIEF_ABSORB_ENABLED`), and the Claude office-digest task was retired on 2026-10-16.

## Who does what

| Layer | Job |
|---|---|
| CRM Cloud Functions | Exact and time-critical: alerts, deadlines, expiry, storm, missed calls |
| Claude scheduled routines | Judgement work: triage, drafts, follow-ups. Drafts only; nothing auto-sends to a customer |
| Grokbots | Social and content only (Jo's 2026-10-06 bot-team split) |
| Home-network AI | Overnight local work; results go to Obsidian and one line in the morning brief; never its own email |

## Three tiers

1. **Interrupt (push or text, immediately):** new lead, a customer's missed call, Storm Mode, an outage or failed backup, a company document expiring in 7 days or less.
2. **One morning brief (06:45):** only what is *new or changed* since yesterday, with counts and a link for long standing lists. Includes the home-network overnight line.
3. **Weekly review (Sunday):** the standing lists (signed jobs needing a week, open promises), the money scoreboard and the weekly digest, in one message.

Monthly reports (marketing, overhead) stay monthly.

## Rules

- **Quiet means silent.** No "nothing to report" messages.
- **Delta, not inventory.** A standing item appears in the brief only when it is new, gets worse, or crosses a threshold; otherwise it lives in the weekly list.
- **Caps:** at most one scheduled email a day; at most about three interrupts a day. Anything over the cap goes to the Agent inbox, not email.
- **Quiet hours** for texts and pushes that are not true interrupts.
- **Every merge is reversible:** each old email stays behind its own flag so it can be switched back.

## Build steps (each its own small PR, flags default to current behavior)

1. Morning brief delta mode: new/changed items first, standing lists collapsed to a count plus link.
2. Move the standing lists (signed jobs without a plan, open promises) into the Sunday scoreboard.
3. Retire the separate 07:15/15:15 promises email once step 2 lands, and fold the 14:00 UTC health digest into the brief only when abnormal.
4. Wire in new sources (company-document expiry, home-network overnight line) as brief lines, not new emails.

## Not in scope

Third-party mail filters (Jo applies them; Claude may draft the rules), customer-facing messages, and anything that sends without a human tap.
