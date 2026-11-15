# Session 2026-11-14: Daily Success audit fixes

This session fixed the findings of the 2026-11-14 read-only audit of Daily Success (`docs/pro/daily-success/`), plus three product decisions Joe made the same day. The work is in 12 draft PRs, and every fix has a test that was seen failing first. Each PR body has the detail; this note is the map.

## PRs and merge order
| PR | Item | Base |
|---|---|---|
| #3065 | #1 the Workout button opened a blank coach screen when nothing was live | main |
| #3066 | #9 and #13: full storage still showed SAVED, and sets were lost silently | main |
| #3072 | #8 and #10: a workout was filed on the wrong day, and the app stayed on yesterday past midnight | **#3066** |
| #3068 → #3069 → #3070 → #3071 | #4 an offline open pushed stale pages over the cloud · #6 the cloud win streak was always 0 · #2 device-only data was not synced or exported · #5 no re-pull on return | stack, in this order |
| #3073 | #12 Sunday review: miss tax on Sundays, unguarded calorie cut | main |
| #3074 | #11 rest-timer alert, plus iPhone insets, landscape zoom and 44 px targets | main |
| #3075 | the brittle and vacuous tests the audit listed (this note rides here) | main |
| #3083 | #7 the KPI tiles removed (Joe's decision) | main |
| #3080 | the coach safety line (Joe's decision) | main |

All 12 branches merge cleanly together, and the combined tree passes the full Daily Success and Workout Coach set.

## Findings that turned out different
- **#3, "sign-out wipes unsynced days", is not reachable.** `NBDAuth.logout()`, the only sign-out path that purges, has no callers. The real buttons (`window._signOut` and raw `signOut`) leave Daily Success data alone. The wipe happens only when a *different* account next signs in on the device, through the account-switch purge.
- **#4 was reproduced.** It was run in Chromium with the vendored Firestore 10.12.2 and the browser offline:
  - `getDocs()` resolves an empty snapshot with `fromCache: true` and does not fail.
  - `getDocsFromServer()` rejects with `unavailable`.

  The sync now reads from the server only. `tests/helpers/ds-sync-harness.js` models this behaviour.
- **Sign-in is not required.** `requiredPlan:'free'` lets a signed-out visitor use the page, with data on the device only (`docs/pro/js/nbd-auth.js` free-page branch).
- **The week-strip "28 px targets" finding was wrong.** The whole column is the button, and it is at least 44 px tall.

## Joe's decisions (2026-11-14)
- Remove the doors, closes and revenue tiles: "the CRM already tracks those". Stored `kpi` and `s-revenue` fields, the CSV columns and the `nbd_gt` sync are kept (#3083).
- Add one short "not medical advice; stop if something hurts" line to the coach. It shows once at first use and stays in the coach settings (#3080).
- No AI workout coach for now. He will revisit after the data-loss fixes and a couple of weeks with the builder.

## Still open
- Progress photos are IndexedDB blobs and stay on the phone. Syncing them needs Storage and `storage.rules`, which is a decision for Joe.
- A real-iPhone pass has not been done for: safe-area insets, the wake lock during a rest, the beep after a reload, and landscape fields. Chromium has no notch and no wake-lock prompt.
- `ds-flow-batch-3`'s 5 s page-load timeout trips on the Windows dev machine, on `main` too; it passes with 30 s.
- Cache `?v=` numbers were not bumped on purpose. JS and CSS are served `max-age=0, must-revalidate`, and the service worker fetches them network-first. Skipping the bump keeps these PRs from conflicting on the same `index.html` lines.
