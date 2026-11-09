# NEXT SESSION, 2026-11-09: the build day (NBD OS P1-P3, Call to Close P0-P2, pricing, Jo's follow-ups)

**Start here.** Every phase planned for this run is built and in a PR. This note covers what merged, what is on in production, what is still dark, and what only Jo can decide.

## 1. What merged (branch `claude/funny-hawking-t9zyzm`, one PR at a time through the merge queue)

| PR | What | Note |
|---|---|---|
| #3017 | NBD OS P1 + the supplier pricing tools | [SESSION-2026-11-09-nbd-os-p1](SESSION-2026-11-09-nbd-os-p1.md) |
| #3018 | Call to Close P0 + P0b (grounded Call Brief, promise slots, draft proposal; viewers stop reading call transcripts) | [SESSION-2026-11-09-call-to-close-p0](SESSION-2026-11-09-call-to-close-p0.md) |
| #3019 | NBD OS P2 (Activities, action runner, Peek, Coach AI line, Team board, goals editor) and the leaderboard indexes | [SESSION-2026-11-09-nbd-os-p2](SESSION-2026-11-09-nbd-os-p2.md) |
| #3020 | Call to Close P1 (transcribe now, estimate prefill, one-tap stages, follow-up draft, auto-brief, rescue queue) | [SESSION-2026-11-09-call-to-close-p1](SESSION-2026-11-09-call-to-close-p1.md) |
| #3021 | Pricing: sells raised on 17 SKUs that sold below material cost; builder roll/bundle units fixed | [SUPPLIER-PRICING-SWEEP](SUPPLIER-PRICING-SWEEP-2026-11-09.md) |
| #3022 | Call to Close P2 (walkthrough briefs, split-call merge, retention dry run, multi-tenant feed off, "Who decides") | [SESSION-2026-11-09-call-to-close-p2](SESSION-2026-11-09-call-to-close-p2.md) |
| #3023 | Jo's follow-ups (viewers, Designer lines, eval kit, leaderboard on, prod switch + token tools, production record) | [SESSION-2026-11-09-jo-follow-ups](SESSION-2026-11-09-jo-follow-ups.md) |
| the P3 PR | NBD OS P3 (Pocket, Knock block, privacy lock, wallpaper palette, Saved view + Copy my setup, Nearby), plus this note | [SESSION-2026-11-09-nbd-os-p3](SESSION-2026-11-09-nbd-os-p3.md) |

Check the PR list for any of these not yet merged when you read this; each has auto-merge on.

## 2. Production changes made by hand today (Jo approved each run in chat)

All are recorded, with undo steps, in [PROD-CHANGES-2026-11-09](PROD-CHANGES-2026-11-09.md): NBD's Coach AI line and Call Brief auto-brief switched on; NBD's first cost book imported (the fallback book); the live costs merged for the 17 re-priced SKUs. No cost figures are in the repo.

## 3. On, dark, or waiting

- **On at deploy:** the leaderboard cron (`LEADERBOARD_AGGREGATE_ENABLED=true`, platform-wide, capped per run); the viewer rules (Q11).
- **Dark until Jo turns them on:** NBD OS (`osLayout` / `osSystemLayer`, per company); the retention sweep (`CALL_RETENTION_ENABLED`, dry run logs only); the multi-tenant call feed (global gate + per-company flag; waits on a lawyer's review of recording and consent).
- **Kill switch:** `feature_flags/global.callBriefDisabled` (absent = on).

## 4. What only Jo can decide or run

1. **Q11 (viewers) is not fully closed:** the old-task backfill (described, not written or run), Thursday task titles, promise tasks and "You said you would" lines, `lead.notes` on Thursday-created leads, voicemail rows saved as `rep`. Details in the follow-ups note.
2. **Leaderboard indexes:** confirm they show Enabled in the Firebase console, then check that the first 30-minute run writes `leaderboard/{uid}` rows.
3. **Retention:** read one dry-run log, set any legal holds, then decide on `CALL_RETENTION_ENABLED`.
4. **Live Call Brief eval:** [CALL-BRIEF-LIVE-EVAL](../runbooks/CALL-BRIEF-LIVE-EVAL.md) on about 20 real calls, then set the bars and the model.
5. **Pricing follow-ups (not built, offered):** 50 SKUs (92 tiers) sit under a 15% margin after labor; three stand-in costs may be high; ridge/hip coverage assumes about 25 LF a bundle. The numbers are in the session scratchpad only, never the repo.
6. **NBD OS turn-on** and the real-iPhone pass (Pocket, the double tap, Nearby's location prompt).
7. **The call-feed golden** was re-captured in #3023 for the one field the viewer change moved; overrule it there if that is not wanted.

## 5. Known, not built here

- `@shard2` / `@shard3` authed E2E legs are still not required and not in the merge queue (2026-10-23 decision). `phone-deal-packet` was made resend-safe in #3023.
- Seen in screenshots, older than this run: the phone Pipeline app's sticky card name and FAB stay over the home after Home; at 320px the top bar's logo and filter icon overlap; at 1000px At a Glance M clips; the demo customer card's Calls section says "Loading calls…" for every role.

## 6. Update 2026-11-09 (later): three parked drafts carried

Jo approved shipping three parked drafts through the follow-up branch. Each PR's own change was ported (not merged; their branches were stale) with its tests, manifest line and note:

- **#3008:** Settings tabs opened by a link load (Team no longer shows NBD's "JD" placeholder). Suite `settings-deeplink-tab-hooks-2026-11-07`.
- **#2994:** Keyboard Shortcuts "Got it" closes the panel, and sign-out stops the estimates listener (PL-F23, PL-F27). Suites `shortcuts-help-close-2026-11-07` and `signout-estimates-unsub-2026-11-07`; note [CRM-SHORTCUTS-HELP-2026-11-07](../audit/CRM-SHORTCUTS-HELP-2026-11-07.md). Bootstrap cache key `?v=43`. The bootstrap edits in `docs/pro/js/dashboard-bootstrap.module.js` are three additions and two edited lines. The additions: lines 2605-2607 in `_signOut` (stop the estimates listener before `signOut`), lines 2695-2697 at the top of `showShortcutsHelp` (one copy at a time) and lines 2719-2721 after it (overlay-a11y attach), plus lines 4332-4335 after the estimates listener (`window._unsubscribeEstimates`). The edited lines: line 2699 (the overlay gains `id="nbdShortcutsHelp"`) and line 2714 (the "Got it" `data-target` becomes `#nbdShortcutsHelp`). Those two edited lines are where #2942's rebase is most likely to conflict, and #2942 will also need to bump the cache key past `?v=43`.
- **#2981:** stage emails stop sending NBD's own offer to other companies' homeowners (VW-F151/F152). Suite `email-tenant-2026-11-06`; note [CRM-EMAIL-TENANT-2026-11-06](../audit/CRM-EMAIL-TENANT-2026-11-06.md). NBD's stage emails were compared byte for byte before and after and did not change.

**Dashboard boot budget:** no raise was needed. Shipped local scripts measured 2,627,237 B before and 2,628,313 B after #3008 + #2994, against the 2,631,680 B (2570 KB) ceiling. Template-deferred scripts measured 72,557 B before and 73,193 B after, against 74,752 B.

**Open for Jo: the customer page budget.** `email_system.js` loads at boot on `customer.html`, so #2981 puts that page's shipped local scripts at 1,378,526 B against a 1,378,304 B (1346 KB) ceiling, 222 B over. Raising that ceiling was not part of the approval, so it was not raised. The smallest raise that passes is 1346 to 1347 KB in `CUSTOMER_CEILING.shippedLocalBytes`.
