# Session 2026-11-09: Social Studio feed from consented jobs, and the 12-week blog calendar

Lane for [CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09](CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09.md) §2, steps 3
and 4. Built in a worktree, not pushed.

## Finding for Jo: Social Studio had no consent gate

Before this change, any finished job (stage-roles `isWon`, install complete or later) with at least one usable photo
could be drafted as a job showcase, by hand (`socialDraftFromJob`) or by Plan N weeks (`socialPlanWeeks`), newest
first. Nothing checked consent. What protected the customer was the town-only privacy filter, the EXIF-stripped
re-encode, and Jo approving every post in `socialApprovePost`.

As the lane asked, this change **does not narrow or widen** that eligibility. It only changes the order: jobs with
Jo's consent tick (`lead.projectConsent.on === true`, the shared contract with the consent-tick lane) come first.
Whether Social Studio should **require** the tick for a job showcase is Jo's call; if yes, it is a one-line filter in
`eligibleJobs` (`functions/social-studio.js`) plus a test.

## What was built

**Consented jobs first** (`functions/social-logic.js`, `functions/social-studio.js`)
- `hasProjectConsent(lead)`: true only for `projectConsent.on === true` (not `'yes'`, not `consentOnFile`).
- `rankShowcaseJobs(list)`: consented first, the existing order kept within each group, nothing added or dropped.
- `eligibleJobs` ranks before its 40-job cut, so a consented job older than the 40 newest is not missed, and returns
  `consented` on each job. The draft picker therefore lists consented jobs on top.
- `planWeeks` ranks its jobs the same way, so the Tuesday showcase picks a consented job over a newer one.

**"New blog post" type** (`kind: 'blog_post'`, label "New blog post")
- Where the post comes from: the functions bundle cannot read the `POSTS` array (it lives under `docs/`, which is
  not deployed with functions). The server reads the **deployed `/feed.xml`** instead, which
  `scripts/build-feed.mjs` builds from `POSTS` at deploy time with only live posts in it.
- `parseBlogFeed` keeps only `https://nobigdealwithjoedeal.com/blog/<slug>` links (an offsite or look-alike host is
  dropped). `blogPostsToShare` keeps posts whose date has passed, published in the last 21 days, and not already
  shared (a `blog_post` with that `blogUrl` in any status but cancelled).
- `socialPlanWeeks` (NBD only: another company never gets NBD's posts, and the feed is not fetched for it) hands
  them to `planWeeks`, where each takes the first Thursday slot on or after its date in place of the tip. The draft
  is text only (Instagram and TikTok are skipped), links the post, and carries `blogUrl`.
- A title that trips the Kentucky or social wording rules (e.g. claim talk) is skipped, never posted. `cleanLabel`
  also refuses a title with a `$`, so a post with a dollar figure in its title is not shared automatically.
- A dead feed (network error, HTTP error) means no blog draft, never a failed plan.
- Drafts are `status: 'draft'`; `socialApprovePost` stays the only way to approved or scheduled.
- No new export: the type rides on `socialPlanWeeks`. `FUNCTIONS_INDEX.md` updated; `gen-function-map --check` clean.
- Client: `KIND_LABELS.blog_post` in `docs/pro/js/social-studio-logic.js` (cache-buster `?v=2` in `social.html`).

**Blog calendar**: [BLOG-CALENDAR-2026-11-17](../runbooks/BLOG-CALENDAR-2026-11-17.md), linked from
[BLOG-SCHEDULE](../runbooks/BLOG-SCHEDULE.md). Twelve Tuesdays, 2026-11-17 to 2027-02-02: three job case studies,
five seasonal (ice dams, winter, spring storm season), four reader questions, each with title, angle, source and CTA.
**No post was added to `POSTS`**: merging a future-dated post auto-publishes it through the weekly scheduled deploy,
so each post waits for Jo's read in its own draft PR.

## Tests

- `tests/social-consent-blog-2026-11-09.test.js` (node bucket, 42 checks). Written first and run red (the missing
  helpers, the Tuesday pick going to the newer unconsented job, no blog drafts), then green. Covers consent and
  ranking, feed parsing against a fixture and against the committed `docs/feed.xml`, which posts get shared, the
  draft shape, the plan slot, and the server loader (NBD only, dead feed, dedupe), which runs when functions deps are
  installed.
- FLOORS 1044/74/1185 to 1045/74/1186.

## Assumptions

- "New" means published within the last 21 days, so the first plan does not share the whole archive.
- The blog share replaces that week's Thursday tip rather than adding a fourth weekly slot.
- Consent ordering applies to the picker list as well as to Plan N weeks.

## Open for Jo

- Should a job showcase **require** the consent tick (see the finding above)?
- Meta auto-publish in production (plan §2 step 3, third bullet) was not checked here: it needs Jo and the console.
- Each calendar post: read and OK in its own draft PR before it merges.
