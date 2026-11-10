# NEXT SESSION, 2026-11-09 (close): after the build day

**Start here.** This follows [NEXT_SESSION-2026-11-09-build-day](NEXT_SESSION-2026-11-09-build-day.md), which still covers NBD OS P1-P3, Call to Close P0-P2 and the first pricing fix. This note covers the three PRs that followed Jo's grill answers, and the work left. Everything still left needs Jo or a person with GitHub access.

## 1. What merged after the build day

| PR | What |
|---|---|
| #3025 | **Q11 viewer privacy:**<br>- Generic call-task titles for viewers, with the call text in the viewer-closed `task_call_text` sidecar.<br>- Thursday lead notes moved onto the call.<br>- Voicemail rows filed under their own source.<br>- The task-summary and voicemail cleanup scripts.<br><br>**Also carried:** the five parked drafts #3008, #2994, #2981, #2941 (eave band) and #2942 (settings restore), and the [content/photos/credentials plan](CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md). |
| #3027 | **Plan step 1:**<br>- Credentials: the AI assistant list and the llms.txt line are generated from `credentials.json`.<br>- `installCompletedAt`, recorded once per job.<br>- EXIF date and GPS on every photo upload path.<br>- The weekly Tuesday hosting deploy, the generated llms blog list, and the Tuesday-only post rule. |
| #3028 | **The 20% price floor:** 54 SKUs, 160 tiers; RoofIVent stays at MSRP.<br><br>**The second Q11 cleanup:** `scripts/backfill-q11-call-text.js`, not run. |

Check the PR list if #3028 still shows open. It has auto-merge on.

## 2. Waiting on Jo (needs a Firestore token for `firestore.googleapis.com`; the form was declined on 11-09)

Each item starts as a counts-only dry run. Every write needs Jo's OK for that specific run (CLAUDE.md rule f).

1. **Q11 cleanups, in this order:**
   - `scripts/backfill-q11-task-summaries.js`
   - `scripts/retag-voicemail-activity.js`
   - `scripts/backfill-q11-call-text.js`

   Dry run all three first, then `--apply` each on Jo's go. Text days re-noted after filing are skipped as "edited", and the dry run shows how many.
2. **Cost book v3:** a dry-run diff of the corrected stand-in costs (flash_009, flash_010, acc_007) against prod. The private file is in the 11-09 session scratchpad only.
3. **Leaderboard:**
   - Confirm the indexes are Enabled.
   - Confirm the first 30-minute run wrote `leaderboard/{uid}` rows.
4. **Retention:**
   - Read one `CALL_RETENTION_ENABLED` dry-run log and summarize it for Jo.
   - Jo sets any legal holds and decides; Jo chose "review the log, then decide".
5. **NBD OS on for all of NBD** (Jo's answer). This is the flags write for `osLayout` and `osSystemLayer` on NBD's company.
   - The real-iPhone pass is still owed: Pocket, the double tap, and Nearby's location prompt.

## 3. Parked, needs a person with GitHub access

- **The James Hardie line in the footer disclaimer** (plan §3 item 3) was reverted from #3027 in b149ab675.
  - **Why it was reverted:** the longer disclaimer wraps one more line, and the required visual-regression job then fails on the landing page.
  - **No wording fits:** a local measure on 11-09 found no wording that names Hardie and keeps the line count at 375 px without trimming the manufacturers' own disclaimer text, and that text should not be trimmed.
  - **To land it:**
    1. Revert b149ab675.
    2. Delete `tests/e2e/visual-regression.spec.js-snapshots/` in the same PR, so the job generates baselines.
    3. Download that run's `visual-regression-output` artifact and commit the PNGs back. The sandbox proxy blocks the artifact storage host.
    4. The smoke pin on the snapshots directory must pass again before merge.

## 4. Jo's answers on 11-09 (so they are not asked again)

- **Price floor:** ship as listed. **RoofIVent:** stay at MSRP.
- **Second Q11 cleanup:** write it, dry run first. Built in #3028.
- **Insurance fields on the lead:** stay viewer-readable.
- **TAMKO and American Operator verify links:** stay generic.
- **Retention:** review the log, then decide.
- **NBD OS:** on for all of NBD.

## 5. Next plan steps (from the plan note, not started)

- The consent tick on a job, and "Draft project page".
- `scripts/match-job-photos.js`, which Jo runs on his own computer.
- The 12-week blog calendar and the Social Studio feed.
- Each new credential as Jo obtains it: the insurance carrier plus a COI on request, Haag, BBB, and OSHA 10/30.

## Update 2026-11-10: what merged after this brief, and what waits on Jo

Merged since the close: **#3029** (content plan steps 2-4: the project-page consent tick, `scripts/draft-project-page.mjs`, `scripts/match-job-photos.js`, Social Studio consented-jobs-first and the "New blog post" draft type, the 12-week [blog calendar](../runbooks/BLOG-CALENDAR-2026-11-17.md)), **#3030** (Daily Success quick wins), **#3031** (flow batch 2: honest sync chip, back button that stays in the app, persistent rest timer, spacing and type tokens) and **#3032** (flow batch 3).

- **Daily Success audit:** [daily-success-ux-audit-2026-11-09](../qa/daily-success-ux-audit-2026-11-09.md). Jo asked not to be interrupted, so the six open decisions were built on the safest default each. The defaults and the one-line flip for each are in [SESSION-2026-11-09-ds-flow-batch-3](SESSION-2026-11-09-ds-flow-batch-3.md). Tier 3 items from the audit are not built.
- **Photo matcher:** merged, not run. It must run on Jo's own computer in a session started there (Claude Desktop, or `claude remote-control` in the repo folder), dry run first, then `--apply` only with Jo's OK for that run (CLAUDE.md rule f).
- **Blog calendar:** no post is in `POSTS`. A merged future-dated post auto-publishes through the scheduled deploy, so each waits for Jo's read.
- **Google Business posting** stays off (`SOCIAL_GBP_ENABLED`) until Google approves API access (case 8-9748000042165).
- **Still waiting on Jo, unchanged:** the prod runs (Q11 cleanups, cost book v3 diff, leaderboard check, retention log, NBD OS on for all of NBD; each needs a Firestore token and Jo's OK per run), the Hardie footer line (needs CI visual baselines committed from GitHub), and a real-iPhone pass over the Daily Success PRs (no zoom on field tap, floors survive swiping away, back swipe stays in the app, the Open today card and ⋯ menu, undo after delete).
- **Sandbox notes:** a symlinked `tests/node_modules` makes browser tests pick a Playwright with no matching browser (run them without it). A squash-merged PR leaves the old branch history on the remote, so a plain push after restarting the branch from main is rejected; merge the remote branch in with `-X ours` and confirm the tree is unchanged.
