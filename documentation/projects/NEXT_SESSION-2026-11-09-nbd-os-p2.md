# NEXT SESSION (NBD OS P2 lane), 2026-11-09

The NBD OS P2 lane only, not the live brief: see the **Current handoff** pointer in [INDEX](../INDEX.md). What was built and why is in [SESSION-2026-11-09-nbd-os-p2](SESSION-2026-11-09-nbd-os-p2.md); the design is [NBD-OS-HOME-DESIGN-2026-11-09](NBD-OS-HOME-DESIGN-2026-11-09.md).

## Where it stands

- Branch `os-p2` (worktree `.claude/worktrees/os-p2`) sits on `os-p1`. Not pushed. All of it is dark behind `osLayout` / `osSystemLayer`.
- Open the PR as a draft after `os-p1` lands (or stacked on it). The PR body should carry §2 of the session note: the Smart Stack reading (Shutdown replaces Coach), the "In a home" scope (home surfaces only, not the phone apps), coachLine as `read-paid` for viewers, and the one-company dry run.

## What waits on Jo

1. Turn on `LEADERBOARD_AGGREGATE_ENABLED` once the new composite indexes in `firestore.indexes.json` are deployed. Until then the run logs one company's counts every 30 minutes and writes nothing.
2. Per company, `companyProfile.coachAiEnabled` for the Coach AI line (an owner switch in the Coach). Stop it with the `coachLineDisabled` or `aiDisabled` kill switch.
3. The real-iPhone pass for phone drag, page 1's nested scroll, and the P2 phone sheets (Peek, Recap, modes).

## Next steps

- P3 per the design's §8.
- Watch the first live `leaderboard_aggregate_run` logs for `failed` and `partial`.

## Sandbox tips

- The browser suites (pro-demo-zero-network and the other two) need Playwright `chromium_headless_shell-1254`; this sandbox had `-1243`. Run them from `tests/` with `node -r <shim>` where the shim points Playwright's launch at the 1243 binary. CI installs its own browser.
- Emulator suites: `env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npx firebase-tools emulators:exec ...`.
