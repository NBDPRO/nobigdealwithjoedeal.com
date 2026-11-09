# Weekly scheduled deploy, generated llms.txt blog list, Tuesday cadence (2026-11-09)

Built from [CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09](CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md) §2 step 5
(the branch is now rebased onto the base that carries the plan; its dated "Built" section points here). Branch `sched-deploy`. The runbook is [BLOG-SCHEDULE](../runbooks/BLOG-SCHEDULE.md).

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
   - A `due` job (no secrets, read-only token) decides; when nothing is due, nothing deploys. (First version: the
     strict checks on the committed files. Since the review round below: the live site.)
   - When something is due, the job runs exactly the steps of a `scope=hosting` run and nothing on the
     functions, rules, indexes or storage side. It never commits.
   - `deploy` and `verify-live` gained `!cancelled()`. Without it, the `due` job being skipped on push would
     have skipped both.

   Suite: `tests/scheduled-deploy-2026-11-09.test.js`, which evaluates every step's `if:` for each trigger.
   actionlint 1.7.7 is clean. `zizmor --offline` reports the same 3 findings main has, and no new ones.
4. **Cadence in the dates test**: posts published on or after 2026-11-10 must fall on a Tuesday, one per ISO
   week (`tests/blog-dates-not-backdated-2026-11-04.test.js`).

## Review round (2026-11-09)

An independent review asked for changes. Acted on, test first, one commit each:

1. **Rebased** onto `claude/funny-hawking-t9zyzm` (34 commits behind). FLOORS re-measured on top of the base's.
2. **No cap on the lag rule.** `lagCuts()` looked back 12 go-live dates. Nothing forces a restamp, so 12 weeks
   without one would have turned `build-feed.mjs` and `build-llms --check-regions` red on every PR. Every live
   date is now a candidate cut (date-gated-checks: a feed 13 dates behind passes).
3. **`due` reads the live site.** It compared the committed files, so (a) once the repo copy lagged it fired
   every Tuesday, and (b) a pending scheduled run that cancelled a pending push run then deployed hosting at
   `main` and stamped `main`'s sha, hiding that the push's functions / rules never shipped. Now
   `node scripts/verify-live-deploy.js due` (pure `decideDue()`): another run active = skip; live behind `main`
   on a deploy path, or stamp unreadable = fail loudly (fix: a `scope=all` run); else due only when a post or
   project date falls after the live stamp's `deployedAt` day. The schedule never dispatches the backend.
4. **Docs corrected.** A new post dated on or after the newest live post, added without a restamp, passes CI
   (the lag rule cannot tell it apart); the first report said it fails. "Never backdated" is enforced only for
   `SEASONAL_MAP`, not for new `POSTS` dates. The runbook says both.

Not changed: the IndexNow ping stays push-only (open item below).

## Open

- Scheduled go-lives are not pinged to IndexNow, because the ping diffs push SHAs. A follow-up could ping the
  newly live URLs from the `due` result.
- A scheduled run that finds live behind `main` fails and waits for a person to run `scope=all`; it does not
  re-dispatch itself (the schedule never deploys the backend). The push path's `verify-live` self-heal is
  unchanged.
- The repo copies of the generated files lag the live site until the next restamp. This is accepted by design,
  and CI says so.
