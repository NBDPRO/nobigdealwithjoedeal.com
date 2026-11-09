# Blog schedule: one post every Tuesday, and the deploy that publishes it

Written 2026-11-09 with the weekly scheduled deploy
([note](../projects/SCHEDULED-DEPLOY-AND-BLOG-CADENCE-2026-11-09.md)). The plan behind it is
`CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09` §2.

## The rules

- **One post every Tuesday.** From 2026-11-10, every entry in the `POSTS` array
  (`docs/assets/js/inline/c00f1acac9.js`) must be dated on a Tuesday, and no two posts may share an
  ISO week (Monday to Sunday). Earlier posts are grandfathered.
- **Never backdated.** A post's date is never before the day it was first committed.
- Both are CI-enforced by `tests/blog-dates-not-backdated-2026-11-04.test.js`.

## Queueing a post

1. Write the post page under `docs/blog/<slug>.html` with its `published` date in the future (a Tuesday).
2. Add its entry to the top of `POSTS` with the same `published` date. Until that date the blog index
   shows it as a countdown card and nothing else lists it.
3. Restamp what you can today, then open the PR:
   `node scripts/build-blog-index.mjs docs/assets/js/inline/c00f1acac9.js docs/blog/index.html`,
   `node scripts/build-feed.mjs --write`, `node scripts/build-llms.mjs --write-regions`,
   `node scripts/build-sitemap.js --write`. A future post changes none of the date-gated lists yet;
   that is expected.

Projects in `docs/assets/data/projects.json` work the same way: a future `published` date stages the job
([PUBLISH-PROJECT](PUBLISH-PROJECT.md)).

## How a queued post goes live

`.github/workflows/firebase-deploy.yml` runs on every push to `main` **and every Tuesday at 09:17 UTC**
(04:17 EST, 05:17 EDT). A scheduled run:

1. **Asks whether anything is due.** The `due` job runs `node scripts/build-feed.mjs --strict` and
   `node scripts/build-projects.mjs --check --strict`. If both pass, nothing went live since the committed
   files were stamped: the deploy job is skipped and the run ends green.
2. **Deploys hosting only.** If something is due, the deploy job runs exactly the steps a `scope=hosting`
   manual run does. The generators rebuild the blog index, `feed.xml`, `llms.txt` (including the
   `LLMS:BLOG` list), `llms-full.txt`, the sitemap and the project pages inside the job, and Hosting
   ships that tree. Functions, Firestore rules and indexes, and Storage rules are never deployed by the
   schedule.
3. **Commits nothing.** `main` only changes through PRs. The repo copies of those generated files catch up
   the next time someone restamps them (step 3 above, in any PR).
4. `verify-live` then checks that the live `/version.json` carries this commit.

The IndexNow ping runs on push deploys only, so a post that goes live on the schedule is not pinged that
morning.

## Why CI stays green while the repo copy lags

Between the Tuesday a post goes live and the next restamp, the committed `feed.xml`, the `OURWORK-*`
regions and the `LLMS:BLOG` region are one or more posts behind the live site. The CI drift gates
(`build-feed.mjs`, `build-projects.mjs --check`, `build-llms.mjs --check-regions`) accept that: they
pass when the committed file is exactly today's render **or an earlier day's** (items whose date passed
since the last stamp), and print an `OK (lags the live site)` line naming the dates and the restamp
command. Any other difference, such as a hand edit, a retitled post, or a new post dated in the past
without a restamp, still fails. The rule lives in `scripts/lib/date-gate.mjs`, and
`tests/date-gated-checks-2026-11-09.test.js` covers it.

## Running it by hand

- Publish today without waiting: run the workflow from the Actions tab with `scope: hosting`.
- See what is due: `node scripts/build-feed.mjs --strict` and `node scripts/build-projects.mjs --check --strict`.
- Render as of a given day (testing only): add `--live-on=YYYY-MM-DD` to any of the three generators.
