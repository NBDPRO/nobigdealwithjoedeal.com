# NEXT_SESSION, 2026-11-05: GitHub repo sweep, hail swaths, calendar panel, customer portal (lane note)

A lane note, not the live brief: see the **Current handoff** pointer in [INDEX](../INDEX.md). One long session from
2026-11-04 into the 11-05 night. It started as a GitHub repo sweep, then went through what the sweep turned up:
MRMS radar hail swaths, a calendar engine trial and Schedule panel, site markup and accessibility fixes, NOAA links,
then a grilled-out customer portal plan built as seven phases. Another session ran the site + CRM speed lane the
same day ([its note](NEXT_SESSION-2026-11-04-site-crm-speed.md)); this lane stayed out of that.

## Update, 2026-11-06 early (portal chain close-out; supersedes the 11-05 afternoon update where they differ)

- **Landed on `main`:** Phase 1 (#2857), Phase 2 (#2858) and Phase 3, the pay panel (#2859). **Queued:** Phase 7a, add to
  home screen (#2860, ready, squash auto-merge on). **Still drafts, each on the one before:** #2861 (Phase 4), #2862
  (Phase 5), #2863 (Phase 6), #2864 (Phase 7). Next in line is #2861.
- **Customer-facing when they land:** Phase 3 (pay panel, live on merge, no new charge path), Phase 4 (Cal.com
  reschedule/cancel links, live on merge), Phase 5 (key-moment emails, **dark** until `PORTAL_MOMENT_EMAILS_ENABLED` and
  the Messaging Center switch), Phase 6 (Care Plan card; the offer stays hidden until `CARE_PLAN_MODE=live`).
- **The care-plan time bomb is fixed (#2876).** The fixed 2026-10-06 invite date expired at 2026-11-05 15:00 UTC and failed
  every PR's unit bucket until then. The deploy outage is fixed in two steps: #2869 (rules step) and #2878 (index step).
  #2880 is a duplicate of #2878 and should be closed, not merged.
- **What landing a phase actually takes (done three times):**
  1. Point the PR at `main` (`update_pull_request` base). Its base branch is the previous phase's branch until then.
  2. In a scratch worktree on the phase branch, `git merge origin/main`. Because Phases 1-3 landed as **squashes**, expect
     conflicts in the same three files each time: `docs/pro/portal.html` (the `portal.js?v=` cache-buster line),
     `functions/portal.js` or `docs/pro/js/portal.js` (the `require`/helper lines each phase adds beside the same
     anchor), and `tests/ci-manifest.json` (each phase's suite line). Read each hunk. Keep the phase's side. The
     cache-buster must end **above** main's number. The client-file clash can be two phases adding blocks at the same spot:
     keep both, and keep each comment with its own function.
  3. Run the phase's own test, the other portal suites (`portal-project-home`, `-today`, `-pay-panel`, `-progress-steps`,
     `-after-signing`, `money-getting-paid`), `node tests/smoke.test.js` (4432) and `node scripts/check-js-syntax.js`.
  4. Commit **named files only**, push, mark ready, enable squash auto-merge.
- **Trap I fell into:** a scratch worktree has no `functions/node_modules`, so I symlinked another checkout's. Then `git add -A`
  committed the symlink to `main` (#2876 carried it; #2885 removed it). `.gitignore` says `functions/node_modules/` with a
  trailing slash, which does not match a symlink. Remove the symlink before committing, or add paths by name.
- **Auto-merge can sit idle.** `enable_pr_auto_merge` sometimes answers with a blank method and does nothing. When a PR is
  "unstable" long after its checks finished, look at its latest PR run: a run **cancelled by the concurrency group**
  leaves required checks incomplete. Re-run that run once and the PR turns "clean" and queues. A human "Merge when
  ready" click also works.
- **Deploy status when I stopped (about 01:00 UTC 11-06):** the deploy for #2878 (run 42139837400) passed Hosting, the rules tests, **Firestore rules, Firestore indexes and Storage rules** (the index step is fixed), and was running the **Cloud Functions** deploy. Not yet seen: whether Functions and the "fleet must match the code" step finished green. None had shipped since about 02:50 UTC on 11-05, so the receipt-inbox function in #2884 and any new portal functions wait on it. Check that run first.

## Update, 2026-11-05 afternoon (supersedes "In flight" below where they differ)

- **Merged since:** #2846 (Calendar panel), #2848 (NOAA links), #2857 (portal Phase 1), #2872 (this note) and
  #2873 (the Field App e2e fix below).
- **#2858** (portal Phase 2) now targets `main`, is ready and has auto-merge on. **#2859–#2864** are still drafts,
  each on the one before; their CI was cancelled on purpose to keep runners free for the queue. Each gets a fresh
  run when it is pointed at `main`.
- **#2879:** radar hail swaths on the **Storm Center** map, the last "not built" swath item. It is dark like the
  rest, and on auto-merge.
- **Blocking every PR's unit check since 15:00 UTC 11-05:** `tests/care-plan-2026-10-05.test.js` mints a Care Plan
  invite at a fixed 2026-10-06 date with a 30-day expiry that checkout compares to the real clock. Fix: #2876,
  another session's, in the merge queue. Merge `main` into the next portal PR after it lands.
- **The `@shard2` Field App failure was real and is fixed (#2873).** `crew-calendar.spec` leaves a Wed–Thu 07:00
  job on the test rep and saves it through `window._saveLead`, which never stamps `e2eTestData`. So the Field App's
  `emptyToday()` never cleared it, and the spec failed every Wednesday and Thursday.
- **The other `@shard2`/`@shard3` failures** look like load: the Firestore emulator under CI load lets the SDK
  re-send a write that already landed. A create gives `ALREADY_EXISTS`. A `setDoc` carrying
  `createdAt: serverTimestamp()` is re-checked as an *update*, which the estimates rule refuses, so it shows up as
  `PERMISSION_DENIED`. This is not proven by a reproduction. Another session is hardening the seeds (#2871, #2875).

## Merged

| PR | What |
|---|---|
| #2832 | GitHub repo sweep note ([GITHUB-REPO-SWEEP-2026-11-04](../audit/GITHUB-REPO-SWEEP-2026-11-04.md)) + report-only actionlint/zizmor |
| #2833 | CI: actions pinned to SHAs, `persist-credentials: false`, report-only trufflehog + osv-scanner |
| #2834 | Site: speculation rules, view transitions, weekly link check |
| #2835 | EventCalendar trial ([CALENDAR-ENGINE-TRIAL-2026-11-04](CALENDAR-ENGINE-TRIAL-2026-11-04.md)) |
| #2840 | MRMS MESH radar hail swaths on the storm maps, **dark** ([MESH-HAIL-SWATHS-2026-11-04](MESH-HAIL-SWATHS-2026-11-04.md)) |
| #2842 | Markup bugs found by html-validate + report-only HTML check |
| #2843 | The same swaths on the D2D door-knocking map |
| #2853 | Customer portal plan, Jo's grilled decisions + seven phases ([CUSTOMER-PORTAL-PLAN-2026-11-04](CUSTOMER-PORTAL-PLAN-2026-11-04.md)) |
| #2856 | WCAG AA contrast, colour-only links, keyboard-reachable guide tables |

## In flight (end of session)

- **#2846** Calendar panel in the Schedule view (read-only Month/Week/List, lazy-loaded). Ready, auto-merge on.
- **#2848** NOAA storm-event links point at the real event pages again; it also restamps the two new town pages (Independence, Liberty Twp) that main had built with the old links. In the merge queue.
- **#2857** Portal Phase 1 (one next-action button, spoken step states, anonymous first-party counts). Ready, auto-merge on.
- **The portal stack, all drafts, each based on the one before:**

| PR | Phase | Notes |
|---|---|---|
| #2858 | 2 | Build-day Today card (crew company, forecast, rep photo) + CRM **Portal Note** button; `portalNoteOk()` rule |
| #2859 | 3 | Pay panel (Jo chose this over Embedded Checkout: NBD's pay button is a real Stripe Invoice, which cannot be framed). No new charge path. Bank payment in flight hides Pay Now. Fixed: a payment never repainted the portal |
| #2860 | 7a | Add to home screen: manifest with no `start_url` (the token never goes in a file), NBD portals only, no service worker |
| #2861 | 4 | Your appointment: reschedule/cancel on Cal.com, only at inspection or estimate; shared reports on the shelf |
| #2862 | 5 | Key-moment emails with the portal link (booked, build day set, job done). **Dark**. Runbook `documentation/runbooks/PORTAL-MOMENT-EMAILS.md` ships in this PR |
| #2863 | 6 | Roof Care Plan: members see their plan; the offer only when `CARE_PLAN_MODE=live`, NBD only, work done |
| #2864 | 7 | Photos open in a native `<dialog>` viewer instead of a new tab |

**How to land the stack:** as each base merges, merge `main` into the next branch (`git fetch origin main`, merge
`FETCH_HEAD`, never rebase or force-push). The squashed base arrives as add/add conflicts. Check that main's copy
of each file equals the base PR's final head (`git hash-object`); if it does, keep the branch's side. Then point the
PR at `main`, mark it ready and queue it with `gh pr merge N --squash --match-head-commit <sha>`. #2846 was landed
this way. The portal branches live in the worktree `C:\Users\jonat\nbd-wt-portal`.

Repeat conflict spots: `tests/ci-manifest.json` (two PRs add a suite on the same line: keep both) and the pinned
counts in `tests/cron-gate-drift.test.js` / `tests/flags-registry-drift.test.js` (now 46 gates, 53 flags with both
`PORTAL_MOMENT_EMAILS_ENABLED` and main's `RECEIPT_INBOX_ENABLED`).

## Waiting on Jo (Claude cannot write production flags)

1. `feature_flags/global.meshHailEnabled`: turns on the radar hail swaths (storm maps and D2D map, both merged).
2. After #2862 lands: `PORTAL_MOMENT_EMAILS_ENABLED`, plus the Messaging Center switch "Portal key-moment email".
3. After the attorney review: `CARE_PLAN_MODE=live`. The portal's Care Plan offer then appears with no other change.

## Not built (named, not started)

- A per-company "usually replies within" line on the portal.
- Moment emails and the Care Plan offer for tenant companies (each needs its own sender first; NBD only for now).
- Folding `functions/estimate-send.js`'s own portal-token minting into `functions/portal-token-mint.js`.
- ~~The Storm Center map still draws points and hulls~~ done in #2879 (see the update at the top).

## Watch: the flaky shards

`Authed E2E @shard2` and `@shard3` failed many times on PRs that touch none of their pages. The failures: visit
recorder "recording starts with no signal", phone-numbers Sunday review, contract cancel forms, the template library,
the deposit draft and the field app, some with Firestore `PERMISSION_DENIED`. `@stranger` also timed out once waiting
for the dashboard. A re-run passed each time, and the merge-queue runs on main stayed green. Worth its own session if
it keeps costing re-runs.
