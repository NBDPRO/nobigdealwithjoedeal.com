# Blog schedule: one post every Tuesday, and the deploy that publishes it

Written 2026-11-09 with the weekly scheduled deploy
([note](../projects/SCHEDULED-DEPLOY-AND-BLOG-CADENCE-2026-11-09.md)). The plan behind it is
[CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09](../projects/CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md) §2.

## The rules

- **One post every Tuesday.** From 2026-11-10, every entry in the `POSTS` array
  (`docs/assets/js/inline/c00f1acac9.js`) must be dated on a Tuesday, and no two posts may share an
  ISO week (Monday to Sunday). Earlier posts are grandfathered.
- **Never backdated.** A post's date is never before the day it was first committed.
- Enforcement (corrected 2026-11-09 after review): `tests/blog-dates-not-backdated-2026-11-04.test.js` enforces
  the Tuesday / one-per-ISO-week rule for every `POSTS` entry dated on or after 2026-11-10. "Never backdated" is
  enforced only for the `SEASONAL_MAP` entries in `scripts/rebuild-blog-index.js` (each against its recorded
  first-commit date). A new `POSTS` date is **not** checked against its commit date: that one is on the author and
  the reviewer.

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

1. **Asks whether anything is due**, against the **live site** (changed 2026-11-09 after review). The `due`
   job runs `node scripts/verify-live-deploy.js due`, which reads the live `/version.json`:
   - If another deploy run is queued or running, it skips: that run ships `main`, regeneration included.
   - If live is behind `main` on a deploy path (a push deploy this pending scheduled run cancelled, since
     the `firebase-deploy` concurrency group keeps only one pending run, or a push deploy that failed before
     Hosting), or the stamp cannot be read, the run **fails loudly** and deploys nothing. A hosting-only run
     would stamp `main`'s sha and `verify-live` would then read green although the functions, rules and
     indexes never shipped. Fix it with a full run: Actions tab, `scope: all`
     (`gh workflow run firebase-deploy.yml --ref main -f scope=all`). That run also publishes the post.
   - Otherwise it is due only when a post or project date falls after the day of the last hosting deploy
     (`deployedAt` in `/version.json`) and on or before today. Nothing new: the deploy job is skipped and
     the run ends green, even while the repo copy lags.
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
command. There is no limit on how far behind the repo copy may be (the first version capped it at 12
go-live dates, which would have turned CI red after 12 unrestamped weeks). Any other difference, such as a
hand edit, a retitled post, or a new post dated before the newest live post without a restamp, still fails.
The rule lives in `scripts/lib/date-gate.mjs`, and `tests/date-gated-checks-2026-11-09.test.js` covers it.

**What the lag rule cannot catch:** a new post dated on or after the newest live post (today, say) and added
without `build-feed.mjs --write` / `build-llms.mjs --write-regions` also passes, because "stamped the day before
it" explains it exactly. The live site is still right (the deploy regenerates it), but CI no longer reminds
you to restamp. Restamp in the same PR anyway (step 3 above).

## Running it by hand

- Publish today without waiting: run the workflow from the Actions tab with `scope: hosting`.
- See what the scheduled run would decide: `node scripts/verify-live-deploy.js due` (needs the live site and
  `gh`; read-only, it deploys nothing).
- See how far the repo copy lags today's render: `node scripts/build-feed.mjs --strict` and
  `node scripts/build-projects.mjs --check --strict`.
- Render as of a given day (testing only): add `--live-on=YYYY-MM-DD` to any of the three generators.
