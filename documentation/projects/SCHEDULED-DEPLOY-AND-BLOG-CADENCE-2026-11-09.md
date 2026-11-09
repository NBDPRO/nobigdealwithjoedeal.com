# Weekly scheduled deploy, generated llms.txt blog list, Tuesday cadence (2026-11-09)

Built from `CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09` §2 step 5 (the plan note lives on the `plan-note`
branch; it is not in this tree). Branch `sched-deploy`. The runbook is [BLOG-SCHEDULE](../runbooks/BLOG-SCHEDULE.md).

## Built

1. **Date-aware drift checks** (`scripts/lib/date-gate.mjs`). `build-feed.mjs` and `build-projects.mjs --check`
   compared the committed tree with a render for today. That turned every PR red on the morning a future-dated
   post or project went live, until someone restamped. Now a check passes when the committed output is exactly
   today's render or an earlier cut day's ("stamped before item X's date"). It names the dates and the fix.
   `--strict` keeps the exact-today rule, and `--live-on=YYYY-MM-DD` renders as of a day. The default output
   is byte-identical to before.
   Suite: `tests/date-gated-checks-2026-11-09.test.js`.
2. **`LLMS:BLOG` region** in `docs/llms.txt`, built by `scripts/build-llms.mjs` from the `POSTS` array: live
   posts only, contractor-audience posts left out, in the sitemap and not noindex, sorted A to Z by URL, with
   existing lines kept verbatim. It added the missing `/blog/color-matching-paint-why-it-takes-so-long`.
   `--check-regions` covers it, with the same lag allowance.
   Suite: `tests/llms-blog-region-2026-11-09.test.js`.
3. **Weekly scheduled deploy**: cron `17 9 * * 2` (Tuesday 04:17 EST / 05:17 EDT) in
   `.github/workflows/firebase-deploy.yml`.
   - A `due` job (no secrets, read-only token) runs the strict checks. When nothing is due, nothing deploys.
   - When something is due, the job runs exactly the steps of a `scope=hosting` run and nothing on the
     functions, rules, indexes or storage side. It never commits.
   - `deploy` and `verify-live` gained `!cancelled()`. Without it, the `due` job being skipped on push would
     have skipped both.

   Suite: `tests/scheduled-deploy-2026-11-09.test.js`, which evaluates every step's `if:` for each trigger.
   actionlint 1.7.7 is clean. `zizmor --offline` reports the same 3 findings main has, and no new ones.
4. **Cadence in the dates test**: posts published on or after 2026-11-10 must fall on a Tuesday, one per ISO
   week (`tests/blog-dates-not-backdated-2026-11-04.test.js`).

## Open

- Scheduled go-lives are not pinged to IndexNow, because the ping diffs push SHAs. A follow-up could ping the
  newly live URLs from the `due` result.
- `verify-live` on a scheduled run can still re-dispatch `scope=all` once, but only when the live site is behind
  `main` on a deploy path (a missed push deploy). That is the existing self-heal, not the schedule.
- The repo copies of the generated files lag the live site until the next restamp. This is accepted by design,
  and CI says so.
