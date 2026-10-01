# NEXT_SESSION — 2026-10-01 (the 09-30 night session)

Follows [NEXT_SESSION-2026-09-30-part2](NEXT_SESSION-2026-09-30-part2.md).
Jo said "keep going" and answered three questions mid-session. Everything
below is merged unless it says otherwise.

## §0 Read first

- **The Insurance Claim panel follows the job type now** (#1942; verify it
  merged). The shared check lives in `docs/pro/js/ky-insurance-law.js`
  (`normJobType`, `claimSignals`, `hasClaimSignals`, `claimPanelMode`).
  - The functions/ copy must stay byte-identical; the test pins it.
  - `isInsurance` (Kentucky law) is deliberately over-inclusive and
    unchanged.
  - The deposit rule deliberately keys off the estimate's own mode.
- **"NBD Jobs" Google Calendar now also carries:**
  - yard-sign pickups (#1940): all-day, FREE, overdue rolls to today;
  - timed D2D follow-ups (#1941): the newest knock per door decides, 30 min,
    BUSY.
  - Both MUST be in `reconcile`, because `planSync` deletes managed events
    nobody wants.
- **Watcher gotcha:** a pushed fix commit makes the old watcher print HEAD
  MOVED and exit, which is correct. Start a new watcher with the new pin.
- **Local manifest:** `deploy-failure-parse`, `deploy-api-enable-step` and
  `sentry-release-stamp-step` fail on Windows only; they pass in CI.

## §1 Shipped (PR → what)

| PR | What |
|---|---|
| #1937 | Jobs panel: each job's own direct costs and margin |
| #1938 | API Analytics page: phone-height iframe (was 150px), Haiku 4.5 at $1/$5 (was $0.80/$4, ~20% low; vision cost constants too), chronological gap-filled chart, 7-day-average projection, no duplicate nav when embedded |
| #1915 | functions non-major deps (firebase-admin, resend, sharp) |
| #1939 | Ask Joe context, daily briefing, forecast count every JOB (lead-source ROI and money-dashboard margin stay per customer, on purpose) |
| #1940 | Yard-sign pickups → NBD Jobs calendar |
| #1826 | @sentry/node 10 → 11 (Jo: "upgrade it") |
| #1941 | Timed D2D follow-ups → calendar, the newest knock per door |
| #1942 | Claim panel steps 1–4 + the shared insurance check (Jo) |
| #1943 | lead-artifact-cleanup cold-start flake: the first check waits 60s |

## §2 Verify next session

- **Sentry 11 in production.** It initializes lazily, on the first captured
  error, so look for `Sentry init skipped` (bad) or `Sentry initialized`
  (good) in the function logs. Read-only:
  `gcloud logging read 'textPayload:"Sentry" OR jsonPayload.message:"Sentry"' --freshness=1d`.
- **The first 05:45 reconcile with signs + knocks** writes
  `integrations/googleCalendar.lastSync`, which should show `signs` and
  `knocks` counts. A read of it is enough.
- **Copycat watch runs 10-01 12:15 UTC.** Its 09-01 red was rate-limit noise,
  fixed the same day (440a5e27). A red now is real.

## §3 Open — Jo's hands

- Unchanged from [09-30 part 2 §2](NEXT_SESSION-2026-09-30-part2.md):
  - Yard Signs "Put them on the map";
  - Drive filing share;
  - the Thursday builder Reference Variable plus a test call;
  - the Bland balance.

## §4 Next lanes

- **Claim Details editor** (`claim-core.js` ClaimPanel) still shows on every
  customer. The same `claimPanelMode` could gate it. Not asked yet.
- **Claim progress per job:** `claimStage`, `claimHistory` and
  `checklist_*` are not in `JOB_FIELDS`, so a second job shows the first
  job's claim progress. Proposed to Jo; not yet approved.
- **Later, bigger:** fold the claim panel's checklists into the matching
  insurance pipeline steps and retire the separate 11-step list.
- **Server-side street-address requirement** on intake: after the week of
  cache turnover, around 2026-10-07.
- Untyped customers (116 of 166) fill in as Jo answers the panel's
  "Insurance job?" prompt.
