# NEXT_SESSION — 2026-10-13: "never forget anything" + the rest of the layouts landed

**Session of 2026-10-12 → 10-13.** Continues
[NEXT_SESSION-2026-10-12-style-roadmap](NEXT_SESSION-2026-10-12-style-roadmap.md).
Jo said: "keep the lanes going and merge whatever is green", then asked for
the Today screen's contact list to be labelled and routed, then "I feel so
secure in not forgetting things — seriously put in some work on making this
system extremely robust". Claude ran ~10 build lanes, a reliability audit, an
independent security review (twice), a vacuous-test audit, and a merge train
against a slow runner backlog. This note is the restart point.

## What shipped (all on main, deployed unless noted)

| Area | PRs |
| --- | --- |
| **Layouts finished** — Triage Inbox, Crew Calendar, Mission Control (+ MapView M1, job map M3), Island Dock, Bento Board | #2358, #2359, #2360 (#2356, #2365), #2363, #2366 |
| **Customer page ordered for a thumb on a roof** (phone) | #2368 |
| **Contact labels on Today** — design, phase 1, 2a (callWatch reads labels), 2c (personal stops copying), 2b (suggestions: Accept / Not this) | #2369, #2370, #2375, #2386, #2396 (decisions doc #2387) |
| **Promise capture + Waiting-on-them** (design, build) | #2374, #2385 |
| **Never-forget reliability chain** — audit, dead-man for callWatch + ingest, push that reached 0 devices is not "told", Home warns on a failed read, short re-tell ladder, 36 h no-recording alarm, follow-up date pushed on its day, deleted task no longer counts as kept, 8 pm "nothing fell through" ledger, pipeline health strip, urgent push follows the label rule, 45-day promise window, ledger label rule, email rung, Healthchecks docs | #2371, #2372, #2373, #2376, #2379, #2380, #2381, #2382, #2383, #2384, #2395, #2397, #2399, #2400, #2398 |
| **Away mode + backup person** (design, build; dark) | #2377, #2389 |
| **Thursday per-label playbooks, Thursday-handled numbers, block list** (design, build; dark) | #2392, #2393, #2394 |
| **Owner hand-off** (`transferCompanyOwnership`, `ownsTenantByUid`, uid-as-tenant hardening) | #2364 |
| **Owner can lift a STOP recorded by phone** (reason + audit) | #2306 |
| **Boot-budget gate made honest** (template-inert scripts not "blocking"; ceilings lowered 300→192 KB; tokenizer + controls) | #2391 |
| Earlier today / housekeeping | #2355 storm-alerts copy, #2357 Ohio note, #2361 push-functions exports, #2362 Dependabot review, #2177 dep bump; closed #2314, #2390 |

**Still in flight when this was written:** #2388 (daily self-test canary;
restacked onto main, in CI — check `gh pr view 2388`). Held on purpose:
#2316 (old phone quick-wins, needs a human rebase) and #2175 (Stripe 23).

## Notes per lane

- Reliability: [NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12](../audit/NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12.md)
  (failure-mode table, helper interfaces, what unblocks the text delivery loop)
- Labels: [CONTACT-ROUTING-TREE-2026-10-12](CONTACT-ROUTING-TREE-2026-10-12.md)
- Promises: [PROMISE-CAPTURE-2026-10-12](PROMISE-CAPTURE-2026-10-12.md)
- Away mode: [AWAY-MODE-BACKUP-2026-10-12](AWAY-MODE-BACKUP-2026-10-12.md) and
  [as-built](AWAY-MODE-BACKUP-AS-BUILT-2026-10-12.md)
- Thursday: [THURSDAY-LABEL-PLAYBOOKS-2026-10-12](THURSDAY-LABEL-PLAYBOOKS-2026-10-12.md)
- Boot weight: [BOOT-WEIGHT-2026-10-12](../audit/BOOT-WEIGHT-2026-10-12.md)

## How the system behaves now (read before touching Today / callWatch)

- **Promises always surface.** A promise (task `kind:'promise'`) or a due
  callback shows on Today, the Home strip and the Call Center badge even from
  a label-`hide` number (tagged "hidden number"). A hidden *personal* number's
  urgent call breaks through ("Personal · hidden number"); a *spam* number's
  urgent flag does not (a promise from spam still does). `quiet` = promise or
  due callback only. A failed labels read pushes everything (never hide on
  error). One shared rule: `callNeedsYou` / `reasonFor` in
  `functions/call-watch-logic.js` and its Home mirror.
- **Reminders:** callWatch (2-hourly) → re-tell ladder (two more pushes, last
  sticky, then the morning brief; email to Jo's own inbox at the third tell;
  handled / task-done / snoozed-with-a-date drop out; a push that reached 0
  devices doesn't use a rung) → 8 pm ledger (unread until tapped).
- **Watching the watcher:** `leadAlertWatchdog` checks the 2-hourly slot and
  copy/transcribe, alerts by bell + push (08–20 ET) and fails its heartbeat so
  Healthchecks emails Jo. Status in `integrations/pipelineHealth`; strip in
  the Call Center via the owner/admin-only `callPipelineHealth` callable.
- **Today's Promises section** can't be dismissed, only Kept it / Move;
  "missed N times" is red from the second miss. Waiting-on-them appears after
  3 days (setting); Nudge opens a DRAFT in the phone composer, never sends.
- **Unfiled/unknown number promises** ride on the call doc and return on
  their date.
- **Old promises:** beyond 45 days they roll into one "N old promises to
  review" chip (counts people).

## Dark / opt-in switches (nothing below is on for users yet)

| Switch | What it turns on | Needs |
| --- | --- | --- |
| `AWAY_MODE_ENABLED` (server) | the backup person is notified; Away status line, hand-back card and cover list work without it | Jo's go; owner names the backup and approves wording (owner-only) |
| `THURSDAY_LABEL_PLAYBOOKS_ENABLED` (server) + `thursdayLabelPlaybooks` (client) | per-label Thursday playbooks, Thursday-handled numbers, block list | Jo reads §9b/§9c of [THURSDAY-LABEL-PLAYBOOKS-2026-10-12](THURSDAY-LABEL-PLAYBOOKS-2026-10-12.md) and gives an explicit go; **nothing has been written to Bland** |
| Storm Mode | opt-in per user in settings (already shipped) | — |

## Open — needs Jo

1. **Healthchecks:** confirm `HEALTHCHECKS_PING_KEY` is set and the 19 checks
   exist; the dead-man's last-resort email depends on it. Steps:
   [HEALTHCHECKS-SETUP](../runbooks/HEALTHCHECKS-SETUP.md).
2. **Bland prompt review + switch-on order** (Thursday note §9b/§9c).
3. **Daylight iPhone pass on the INSTALLED app** (standing phone rule):
   Today, promise sheet, label sheet + chips, Waiting group, Thursday rows,
   Triage Inbox / Crew Calendar / Bento / Island Dock / Mission Control, Field
   App sunlight, Storm Mode banner. Only 390 px / desktop harnesses so far.
4. **Counsel — Ohio ORC 4722.04** (carried): does materials delivery count as
   "performance begins"; "total cost" of a special-order item = price or
   cost; is the ACV check a down payment. Deposit cap is live.
5. **Owner hand-off open items:** Stripe Connect payouts block the hand-off
   while an account exists; **billing does not move** (old owner's card keeps
   paying; the remove flow says so); a demoted owner keeps access to records
   they authored (OPEN-6); erasing a billed former owner (OPEN-8, counsel).
6. **Stripe 23 (#2175)** held — mergeable, deliberate window; **#2316** needs
   a human rebase or re-slicing (much may be covered by #2368).
7. **Text delivery loop is blocked on A2P** — what unblocks it: A2P 10DLC
   approved, Twilio off trial, `TWILIO_INBOUND_ENABLED` + webhooks,
   `smsSid` stored on customer sends (see the audit's status section).
   Customer texts are not delivered today; do not build on "sent".
8. Defaults I chose that Jo may want different (all reversible): Waiting
   items don't count in "N things today"; Call Center card keeps direct
   Handled + a Promise button; away "backup done" is advisory only and the
   backup is never named to callers; reps have no access to labels; Thursday
   can take every kind except spam, with insurance/customer recommended off
   at first; 21-day Away cap; quiet hours 21:00–08:00 with urgent exempt.
9. **Not built:** voice-note / photo "promise stamp" from the roof; promise
   auto-capture from transcripts (suggestions lane); Waiting derived from
   claim state; external (non-member) backup delivery (A2P); writing the
   hand-back note onto the lead timeline.

## Gotchas learned this session (each cost a cycle)

- **Runner backlog is the bottleneck, not the code.** ~25 queued runs behind
  4 running; each queue entry builds on the previous. Cancel QUEUED
  pull_request runs of stacked children (`gh run cancel`) so merge_group
  runs go first; don't rerun CI needlessly; `gh` GraphQL throws intermittent
  504s — retry. "already queued to merge" from `gh pr merge` means it IS in
  the queue.
- **`gh pr merge --auto --match-head-commit <FULL sha>`** (a short sha fails
  coercion). A new push cancels/changes an armed auto-merge; re-arm pinned.
- **The Bash tool drops backslashes** — regex edits with the Edit tool or
  node script files, never inline. A node script via heredoc "NOT FOUND" was
  this.
- **`git worktree remove --force` follows `node_modules` junctions** and
  empties the shared checkout's packages (happened once; fixed with
  `npm ci`, lockfiles unchanged). Unlink junctions non-recursively first.
- **Comment strippers:** a `/*` inside a `//` comment (e.g.
  `integrations/*`) ate the rest of the file in
  `r5-stagerole-d2d-smslog`. Don't put `/*` in docs JS comments.
- **Guards that bit:** `data-integrity-guards` flags any `deleted: true`
  write without `deletedAt`; `email-unsubscribe` requires every file that
  calls `emails.send()` to be in `SEND_PATHS` (`'internal'` for owner-only
  mail); `pro-claims-honesty` pins Today sections; Thursday's test pins
  `contact-labels.js?v=` / loader versions (loosened to "or later").
- **Boot budget:** blocking bytes now ~170 KB vs a 192 KB ceiling (gate
  excludes `<template>`-inert scripts and says so; deep links like
  `#/settings`, `?settings=billing&connect=return`, `?est=` hydrate Settings
  ~130 KB during boot). Real blocking heavyweights left:
  `dashboard-ui-prefs-boot.js` (42 KB), `script-loader.js`, `demo-mode.js`,
  `standalone-compat.js`, `dashboard-load-status-banner.js`. Local numbers
  are CRLF-inflated; trust CI/LF. Keep `script-loader.js` growth ~0 — register
  bundles lazily from deferred files (`today-home.js` pattern).
- **Stacked PRs after a squash:** `merge -s ours origin/main`, tree to main,
  `git apply --3way` only the PR's own diff, retarget base to main; never
  push to a queued PR. Unique INDEX / `ci-manifest.json` /
  `layout-system.js` slots.
- **Independent review earns its keep:** the away-mode security re-review
  found a real approval-binding gap; the vacuous-test audit found a gate
  hole in #2391 (stray `<template>`). Keep doing both for security-sensitive
  or gate-changing PRs.
- Known flakes: `layout-island` headline expectation, Stranger sign-in
  ("Failed to authenticate, have you run firebase login" — infra), local-only
  `money-paper-2026-09-30` (QR dependency) and CRLF boot-budget.

## Grok (read-only second opinions; verify every claim)

Reached via the Chrome extension on grok.com (see the memory "Talking to
Grok from Claude"). This session: call-tool patterns (screening vs blocking
as separate policies, per-number dismissal, labels on the call record) fed
the labels design; a "never forget" pass added acknowledge-timeout re-trigger,
forced next action on promises, delivery-receipt loop, digest-as-item,
backup auto hand-back, voice-note promise stamp, waiting-on-them filter, and
traps (team-grade escalation, auto-archive hiding drops, trusting push
alone). All leads were verified against code before building.

## Suggested first moves next session

1. `gh pr view 2388` (canary) and `git log origin/main` — confirm the
   queue is empty and deploys are green.
2. Jo: Healthchecks check, then the Bland prompt review; decide switch-on
   order for Away mode and Thursday playbooks.
3. Daylight iPhone pass (item 3 above), then decide the defaults in item 8.
4. Boot-weight round two: the five real blocking heavyweights (changes load
   order; separate small PRs with a Playwright boot before/after).
5. Clean up worktrees (`C:\Users\jonat\nbd-wt-*`, `nbd-ops-mt`); backups of
   dirty ones are on origin as `backup/*` branches.
