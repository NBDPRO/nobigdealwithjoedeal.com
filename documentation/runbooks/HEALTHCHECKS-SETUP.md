# Healthchecks.io — hear within minutes when a cron stops

*Written 2026-09-04 with the heartbeat wrapper (`functions/integrations/heartbeat.js`).
Companion: [ALERT_RESPONSE](ALERT_RESPONSE.md), [SECRET_ROTATION](SECRET_ROTATION.md).*

## Why this and not a Cloud Monitoring alert

Cloud Monitoring cannot express "this daily cron stopped": `conditionAbsent`
caps at 23h30m, shorter than a daily cadence, so an absence policy on a
once-a-day job false-fires every day ([STABILITY-AUDIT-2026-09-04](../audit/STABILITY-AUDIT-2026-09-04.md)).
`migrationsTick` went silent on 2026-08-31 with nothing watching; before that
three backup crons failed every night for weeks behind green-looking
schedules. A heartbeat monitor inverts it: each run **pings** an external
service and the service alerts when the ping does not arrive. Grace periods
are per check, so "daily" and "every minute" are both expressible.

Every `onSchedule` in `functions/` now goes through the wrapper (CI-enforced
by `tests/cron-heartbeat.test.js`): a successful run pings
`https://hc-ping.com/<ping-key>/<slug>`, a throw pings `<slug>/fail` and
rethrows. Until the key is set, every ping is a no-op — nothing changes.

## Jo's steps (about ten minutes)

1. **Create the account and project.** healthchecks.io → Sign up (free
   *Hobbyist* tier: 20 checks, no card). One project, e.g. "NBD Pro".
2. **Copy the project's Ping Key.** Project → *Settings* → *Ping key* →
   *Create*. It is a 22-character string. Slug-style pings need it.
3. **Set the secret** (this is the only code-side step):

   ```bash
   firebase functions:secrets:set HEALTHCHECKS_PING_KEY
   ```

   Paste the ping key. The next deploy binds it to all 25 scheduled
   functions automatically (the wrapper adds it to each one's `secrets`); no
   redeploy is needed for the binding itself if a deploy has run since the
   wrapper merged, but the **new secret version is only picked up on the
   next deploy** of those functions — trigger one, or wait for the next
   merge to `main`.
4. **Create the checks you want, by slug.** Project → *Add Check* → name it,
   set *Slug* to the value from the table below (the code sends exactly
   that), set *Schedule* to "Simple" with the period from the table and the
   grace shown. A slug with no check behind it returns 404 and is ignored,
   so you can create as few as you like and add more later.
5. **Point alerts at your phone.** Project → *Integrations* → email is on by
   default; add Pushover / Signal / Telegram / SMS as you prefer (free tier
   includes email, webhooks, and most chat apps).
6. **Verify.** After the next run of any check, its status turns green and
   the ping log shows a body like `{"outcome":"success","durationMs":1834}`.
   Logs Explorer: `jsonPayload.message="[heartbeat] pinging as slug"` prints
   the slug each instance used the first time it pinged — if a slug there
   differs from this table, use the logged one.

## The 25 slugs

Slug = the export name in kebab-case, derived at run time from
`FUNCTION_TARGET`. Period = how often the cron fires; grace = how late a ping
may be before Healthchecks alerts (generous where a run can be slow).

| Slug | Function | Fires | Suggested period · grace |
|---|---|---|---|
| `email-queue-worker` | emailQueueWorker | every 1 min | 1 min · 10 min |
| `on-appointment-reminder` | onAppointmentReminder | every 15 min | 15 min · 30 min |
| `check-storm-alerts` | checkStormAlerts | every 30 min | 30 min · 1 h |
| `storm-watch` | stormWatch | every 30 min | 30 min · 1 h |
| `run-abandon-recovery` | runAbandonRecovery | every 60 min | 1 h · 2 h |
| `lead-follow-up-sweep` | leadFollowUpSweep | every 3 h | 3 h · 4 h |
| `daily-firestore-backup` | dailyFirestoreBackup | 03:15 ET daily | 1 day · 6 h |
| `firestore-backup-retention` | firestoreBackupRetention | 03:45 ET daily | 1 day · 6 h |
| `audit-log-retention-cron` | auditLogRetentionCron | 03:30 CT daily | 1 day · 6 h |
| `recording-retention-cron` | recordingRetentionCron | 05:00 CT daily | 1 day · 6 h |
| `backup-freshness-cron` | backupFreshnessCron | 06:00 ET daily | 1 day · 3 h |
| `sync-gbp-reviews` | syncGbpReviews | 06:00 ET daily | 1 day · 6 h |
| `stripe-ledger-reconcile` | stripeLedgerReconcile | 06:15 ET daily | 1 day · 6 h |
| `daily-lead-digest` | dailyLeadDigest | 07:00 ET daily | 1 day · 3 h |
| `on-follow-up-due` | onFollowUpDue | 08:00 ET daily | 1 day · 3 h |
| `on-yard-sign-pickup-due` | onYardSignPickupDue | 07:30 ET daily | 1 day · 3 h |
| `anniversary-auto-touch` | anniversaryAutoTouch | 08:00 ET daily | 1 day · 6 h |
| `review-request-nudge` | reviewRequestNudge | 08:15 ET daily | 1 day · 6 h |
| `enforce-lapsed-seats` | enforceLapsedSeats | 09:00 ET daily | 1 day · 6 h |
| `hail-match-cron` | hailMatchCron | 09:00 CT daily | 1 day · 6 h |
| `health-digest-cron` | healthDigestCron | 14:00 UTC daily | 1 day · 6 h |
| `migrations-tick` | migrationsTick | every 24 h | 1 day · 12 h |
| `weekly-digest` | weeklyDigest | Mon 07:00 ET | 1 week · 12 h |
| `dormant-lead-nudge` | dormantLeadNudge | Wed 08:00 ET | 1 week · 12 h |
| `monthly-marketing-report` | monthlyMarketingReport | 1st 07:00 ET | cron `0 7 1 * *` (America/New_York) · 12 h |
| `monthly-overhead-alert-cron` | monthlyOverheadAlertCron | 1st 09:00 ET | cron `0 9 1 * *` (America/New_York) · 12 h |

## Twenty checks for twenty-five crons

The free tier allows 20. Five to leave uncreated, in this order — each is
either observable another way or low-stakes if it silently stops:

1. `firestore-backup-retention` — `backup-freshness-cron` already alarms on
   the backups themselves; retention is cleanup.
2. `recording-retention-cron` — cleanup only.
3. `audit-log-retention-cron` — cleanup only.
4. `anniversary-auto-touch` — marketing nicety.
5. `monthly-overhead-alert-cron` — the money dashboard shows the same figure.

Or pay for the next tier ($5/month for 100 checks) and create all 25.

## What a red check means, and does not mean

- **Red with a `/fail` ping in the log** — the cron ran and threw. Read the
  ping body (`error`) and the function's logs. This is the useful case
  Cloud Monitoring's absence alerts could not distinguish.
- **Red with no ping at all** — the cron did not run to completion, the
  deploy removed it, or the secret is unset (`integrationStatus.healthchecks`
  is `false` in the admin readout). Check the fleet: the orphan detector
  (#1382) and `gcloud scheduler jobs list`.
- **Every check red at once** — the ping key was rotated or the secret is
  the `__unset__` stub. Not 25 outages.
- A ping is a POST with a 5-second timeout that never throws into the cron:
  Healthchecks being down cannot fail the work it monitors.

## Uptime monitors (the other half — vendor config only)

Better Stack's free tier (10 monitors, 1 status page) or Healthchecks' own
paid tiers can watch the public URLs; nothing in code is needed:
`https://nobigdealwithjoedeal.com/`, `/pro/login`, `/api/google-reviews`
(expect HTTP 200 and **not** `"empty":true` once Places is configured),
`/storm-check`, and the `/healthz`-style endpoints if any are added.
