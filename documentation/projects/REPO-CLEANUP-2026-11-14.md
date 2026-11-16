# Repo cleanup, wave 1 (2026-11-14)

Source: the read-only cleanup audit from the same day. Nothing here changes behaviour.

## Done in this PR

- Removed `read-files.js` (root scratch script, hard-coded local paths, no references).
- Removed `docs/pro/js/demo-reveal.js` (no page loaded it).
- Removed the calendar-trial trio: `docs/pro/calendar-trial.html`, `docs/pro/js/calendar-trial.js`, `docs/pro/css/calendar-trial.css`. They referenced only each other; no `firebase.json` entry, no test, no manifest line. The vendored EventCalendar build and `schedule-ec-events.js` stay.
- `.gitignore`: added `scratch-*.log`.
- `functions/FUNCTIONS_INDEX.md`: dropped the rows for four functions that are no longer exported (`sendEstimateForSignature`, `esignWebhook`, `stormWatch`, `checkStormAlerts`); the guard pin R1-10-5 in `tests/merge-leftovers-guard-2026-10-05.test.js` is removed with them. `adminAI` stays a note below the Admin table on purpose: the drift-guard smoke test cannot see its gate.

## Retire later (not done: needs Joe and a manual undeploy)

The deploy never deletes a function. Removing an export leaves the old revision live, so each removal is two steps: delete the export in a PR, then undeploy by hand.

- `auditSubscriptions`, `auditUsers`, `auditAccessCodes`, `auditCompanies` (`functions/audit-log.js`): no-op Firestore triggers that fire on every write. Undeploy: `firebase functions:delete auditUsers auditCompanies auditAccessCodes auditSubscriptions --project nobigdeal-pro --force`.
- `imageProxy` (`functions/handlers/photo.js`): a 410 stub; Cloud Run request logs show zero calls in the retained window. Undeploy: `firebase functions:delete imageProxy --project nobigdeal-pro --force`.
- `setStorageCors` (`functions/handlers/photo.js`): admin-only one-shot bucket CORS setter, no caller in the repo, zero calls in the logs. If removed also drop its rows in `function-map.json`, `rate-limit-policy.js`, `FUNCTIONS_INDEX.md` and `tests/viewer-callables.test.js`.
- Keep `manageMessagingControls`: it is the owner kill switch for every customer-facing send, not a no-op.
