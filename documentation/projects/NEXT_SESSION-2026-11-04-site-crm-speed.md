# NEXT_SESSION, 2026-11-04: site fixes, copy decisions, speed audit and the CRM speed-up (lane note)

A lane note, not the live brief: see the **Current handoff** pointer in [INDEX](../INDEX.md). One long session on
2026-11-04 covered site fixes, Jo's copy and wording decisions, a measured speed audit, and the CRM speed-up plan
through Phase 2b. Another session was working on site markup, the Schedule calendar, storm/D2D, and CI hygiene the
same day; this lane stayed out of those.

## Where the PRs stand (end of session)

Merged: #2817 (`/storm-alerts` error placement, Reports "+100%"), #2818 (Recent Activity actions on their own row),
#2819 (perf-4 note), #2820 (Jo-approved claim/supplement wording, 43 cities, US spellings, slashless URLs), #2821 (Free
Roof rules), #2822 (inspection 45 min to an hour, adjuster visit 30 to 90 minutes).

In the merge queue or CI, all set to merge:

| PR | What |
|---|---|
| #2823 | Credentials: James Hardie Alliance and American Operator memberships, /review supplier strip split, IKO out of the disclaimer |
| #2824 | Blog dates: no post dated before it existed, spread weekly; the `rebuild-blog-index.js` byline regex and dateModified bugs fixed; guard test |
| #2825 | Town pages for Liberty Township and Independence (a separate session) |
| #2826 | Speed audit note `documentation/audit/PERF-AUDIT-2026-11-04.md` |
| #2827 | Speed fixes: GA loaded on interaction or 3.5 s after load, lazy 80 px review avatars, -400/-640 project photos |
| #2828 | Small audit fixes: /inspect logo alt, CRM bell badge contrast and label, credential badge WebP |
| #2829 | CRM header wordmark readable in all 207 themes (`--orange-on-header`) |
| #2830 | CRM speed-up plan `documentation/projects/CRM-SPEED-UP-PLAN-2026-11-04.md` |
| #2831 | Phase 1.1: bundle files download in parallel (expenses 9.1 → 3.7 s at 150 ms RTT) |
| #2836 | Phase 1.2: modulepreload of the boot module graph (imports start ~0.6 s earlier) |
| #2837 | Phase 2 design `documentation/projects/CRM-SPEED-UP-PHASE2-DESIGN-2026-11-04.md` |
| #2838 → #2841 → #2844 | Phase 2 steps 1-3, stacked: dead duplicate functions removed; `scripts/concat-shipped.js`; the join turned on for deploys |
| #2850 | **Draft**, Phase 2b: joining lazy ScriptLoader bundles, switched off (no workflow passes `--bundles`) |

**A known queue conflict:** #2831 and #2838 both add a line after `theme-contrast.test.js` in `tests/ci-manifest.json`.
If #2831 merges first, #2838 gets dequeued as unmergeable. The resolution (keep both lines) is already committed in
the local worktree `C:\Users\jonat\nbd-wt-dedupe`; push it once the branch unlocks. #2841 needs the same.
#2844 already carries both.

## Jo's decisions today (also in memory)

- **Wording:** the copy drafts were approved as written (#2820).
- **Free Roof:** Jo picks by need (not a drawing), one entry per household, every Ohio town plus NKY (not the
  Lexington area), no fixed dates yet.
- **Visit lengths:** inspection 45 minutes to an hour, adjuster visit 30 to 90 minutes. Cal.com was set to 60/60/90
  and read back (via Claude in Chrome; Jo accepted Cal.com's new Terms himself).
- **Credentials:** Jo is a James Hardie Alliance member; add American Operator; /review suppliers are "Where I buy
  materials"; IKO stays out until approved.
- **Blog:** spread out over time, never dated before a post existed.
- **Service area:** keep Liberty Township and Independence (town pages are #2825).
- **Speed fixes:** yes to all three, including the GA trade-off (a visit that bounces before any interaction in the
  first seconds isn't counted).
- **CRM speed-up:** yes to Phases 1 and 2, steps 1-3.

## Waiting on Jo

1. Source for the "50-year" claims: siding-replacement ("50-year manufacturer warranty on siding panels") and
   roof-replacement-florence-ky (shingles "rated for 50 years").
2. llms.txt names United Restore (mitigation partner), Acorn Finance and the TAMKO HailGuard warranty. Add them to
   Credentials, or remove them?
3. Optional: the James Hardie Alliance member ID. Tell Claude when IKO approves.
4. **An iPhone check after #2827 and #2844 deploy:** does the CRM feel faster, and does anything look wrong?
   If it does, set the repository variable `NBD_CONCAT` to `0`.
5. **For Sentry source maps:** the repo has no Sentry secret. Jo would create a Sentry auth token (org:read +
   project:releases) and add it as `SENTRY_AUTH_TOKEN`, and Claude then wires the upload into the deploy. Today the
   maps exist only as a 30-day artifact, so error traces are minified.

## Next work, in order

1. **Live speed re-run after #2827 deploys.** Lighthouse 12.6.0, mobile, the same six pages, two runs each. Compare
   with the baseline table in PERF-AUDIT-2026-11-04 and append the result there.
2. **Live CRM check after #2844 deploys.** Baseline (Jo's signed-in desktop Chrome, warm, visible tab): FCP 3.27
   and 3.33 s, DCL 3.1-4.6 s, load 4.6-6.8 s. Method: Claude in Chrome, navigate, wait 10 s, read the navigation
   and paint entries, 2+ runs. The resource buffer caps at 250, so request counts don't work there. Keep the
   join on only if it's faster.
3. **Phase 2b (#2850):** turn on `--bundles` only after step 2 holds up. In the lab it cut requests a lot (all
   bundles: 373 → 129 tags) but time only on fast links (estimates 1.23 → 0.99 s at 20 Mbps). The expected win is
   repeat visits (fewer service-worker revalidations).
4. **Boot CSS (measured, not built).** Style recalculation is the largest CPU cost at boot: about 2.5 s at 4×
   throttle, over 86 recalcs. Across all 8 layouts at phone and desktop width, only 40 of 99 stylesheets are used
   at boot; about 59 sheets (around 40 % of 6,290 rules) never are. Loading those late would make each restyle about
   40 % cheaper and remove about 54 render-blocking files. **Not covered yet:** role-specific homes (crew,
   canvasser). The first-open unstyled-flash risk also needs a plan: put each sheet in its view's ScriptLoader
   bundle, plus an idle preload. Measure the role homes first.
5. Small leftovers: the roof guide's illustrations still say "centre"/"centreline" (an SVG regenerate:
   `build-illustrations.mjs --svg`, then the pinned svgo, then `--stamp`).

## Lessons from today (each cost real time)

- **Text-parsing shipped JS breaks after minify.** A layout-bound regex read `script-loader.js`'s BUNDLES as empty
  once it was minified. The fix was reading the real object by running the file in a vm. Run checks on the minified
  output too, not just the source.
- **A service worker's fetches ignore DevTools network throttling.** Bundle timings had to come from a bare page
  with no service worker.
- **A Lighthouse score on the sample CRM varies by ±4 s between identical runs.** Compare a mechanism instead (when
  a request starts), not the score.
- **The browser's resource-timing buffer stops at 250 entries,** which silently caps request counts.
- **Two PRs adding a line after the same anchor in `tests/ci-manifest.json`** conflict in the queue. Pick different
  anchors, or merge the other branch in early. A queued PR's branch is locked, so it can't be fixed until it's
  dequeued.
- **Deploys can sit "queued" for an hour** while the merge queue's CI holds the runners. That's not stuck; it waits.
