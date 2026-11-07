# Visual baseline re-bless — when a PR changes a pixel on purpose

*Written 2026-11-06 by the PR steward session. Companions: [MERGE-QUEUE](MERGE-QUEUE.md),
[DEPLOY-VERIFICATION](DEPLOY-VERIFICATION.md), [INDEX](../INDEX.md).*

`Visual regression (public pro pages)` is one of the 16 **required** checks. It compares 12 committed
screenshots: `/`, `/pro/login`, `/pro/pricing` and `/pro/register` at 375 / 768 / 1280 px, stored in
`tests/e2e/visual-regression.spec.js-snapshots/<page>--<viewport>-chromium-linux.png`. Note that
`landing--*` is the **homepage** (`/`), not a /pro page, so any site PR that changes the homepage's
height fails this check until its baselines are re-blessed.

## Rules
- **Bless only from the CI render.** Windows or macOS screenshots differ in fonts and anti-aliasing,
  so a locally generated PNG fails in CI.
- **Bless in merge order.** When two PRs change the same page's height, the second must be blessed
  on top of the first *after* the first merges. Otherwise the queue fails whichever lands second.
  (2026-11-05/06: #2929, then #2927, then #2922 each re-blessed `landing--mobile-375`, in order:
  10713 → 10726 → 10704 px.)
- **Copy only the pages your PR changes.** A diff on a page your PR doesn't touch means something
  else moved, so investigate it. Don't bless it.
- **One push.** Every push to a PR re-runs the whole CI (≈100 runner-minutes). Don't push while that
  PR's CI is still running: the per-PR concurrency group cancels the older run.

## Recipe (Git Bash, repo root, on the PR branch)

```bash
gh pr checks <PR>                                   # find the failing "Visual regression" job
gh run list --branch <branch> --workflow ci.yml --limit 3   # its run id
gh run download <run-id> -n visual-regression-output -D /tmp/vr-<PR>
find /tmp/vr-<PR> -name '*-actual.png'               # the CI render of each failing page
```

For each page your PR changes, copy the `-actual.png` over the committed baseline. Use exactly the
baseline's name, `<page>--<viewport>-chromium-linux.png`:

```bash
cp "/tmp/vr-<PR>/test-results/<…>/landing--mobile-375-actual.png" \
   tests/e2e/visual-regression.spec.js-snapshots/landing--mobile-375-chromium-linux.png
git add tests/e2e/visual-regression.spec.js-snapshots/landing--mobile-375-chromium-linux.png
git commit -m "test(visual): re-bless landing--mobile-375 from CI run <run-id> (<why the page changed>)"
git push
```

Look at the actual and the diff PNGs before you copy anything. The diff should show only the change
your PR describes.

## If it still fails after the re-bless
- Another PR that changes the same page merged first. Re-download from **this** PR's newest CI run
  (which now renders on top of the new main) and bless again.
- The page is flaky (live reviews, a late font). Read the spec's notes at
  `tests/e2e/visual-regression.spec.js:55` and `:109` before you touch the spec.
