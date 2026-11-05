# NEXT_SESSION, 2026-11-05: GitHub repo sweep, hail swaths, calendar panel, customer portal (lane note)

A lane note, not the live brief: see the **Current handoff** pointer in [INDEX](../INDEX.md). One long session from
2026-11-04 into the 11-05 night. It started as a GitHub repo sweep, then went through what the sweep turned up:
MRMS radar hail swaths, a calendar engine trial and Schedule panel, site markup and accessibility fixes, NOAA links,
then a grilled-out customer portal plan built as seven phases. Another session ran the site + CRM speed lane the
same day ([its note](NEXT_SESSION-2026-11-04-site-crm-speed.md)); this lane stayed out of that.

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
- The Storm Center map still draws points and hulls; it does not use the `NBDHailMeshSwaths` layer yet.

## Watch: the flaky shards

`Authed E2E @shard2` and `@shard3` failed many times on PRs that touch none of their pages. The failures: visit
recorder "recording starts with no signal", phone-numbers Sunday review, contract cancel forms, the template library,
the deposit draft and the field app, some with Firestore `PERMISSION_DENIED`. `@stranger` also timed out once waiting
for the dashboard. A re-run passed each time, and the merge-queue runs on main stayed green. Worth its own session if
it keeps costing re-runs.
