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

   Paste the ping key. The next deploy binds it to every scheduled
   function automatically (the wrapper adds it to each one's `secrets`); no
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

## The 18 checks to create (37 crons)

**Updated 2026-10-04.** There are now 37 scheduled functions and the free tier
holds 20 checks, so the slug each cron pings comes from an explicit plan,
[`functions/integrations/heartbeat-plan.js`](../../functions/integrations/heartbeat-plan.js),
not just its name. `tests/cron-heartbeat.test.js` fails CI if a cron is
missing from the plan, if the plan needs more than 20 checks, or if this
table drifts from it.

- **Dedicated** (one cron): the slug is the export name in kebab-case — the
  same slug it always sent, so a check you already created keeps working.
- **Shared** (several crons, same cadence): any member's throw still pings
  `<slug>/fail` and turns the check red; what a shared check cannot see is
  one member silently stopping while a sibling keeps pinging. Only crons where
  that is low-stakes are grouped.

| Slug | Crons that ping it | Period | Grace | Why |
|---|---|---|---|---|
| `email-queue-worker` | emailQueueWorker | 1 minute | 10 minutes | every outbound email rides this queue |
| `on-appointment-reminder` | onAppointmentReminder | 15 minutes | 30 minutes | appointment reminders |
| `daily-firestore-backup` | dailyFirestoreBackup | 1 day | 6 hours | the nightly backup |
| `backup-freshness-cron` | backupFreshnessCron | 1 day | 3 hours | the alarm on the backup |
| `migrations-tick` | migrationsTick | 1 day | 12 hours | went silent 2026-08-31 with nothing watching |
| `stripe-ledger-reconcile` | stripeLedgerReconcile | 1 day | 6 hours | money ledger |
| `enforce-lapsed-seats` | enforceLapsedSeats | 1 day | 6 hours | billing / seat access |
| `health-digest-cron` | healthDigestCron | 1 day | 6 hours | daily health digest |
| `lead-follow-up-sweep` | leadFollowUpSweep | 3 hours | 4 hours | follow-up to untouched new leads |
| `storm-crons` | checkStormAlerts, stormWatch | 30 minutes | 1 hour | storm alert texts + NWS storm watch |
| `calls-texts-ingest` | callCenterIngest, callCenterTranscribe, textInboxIngest | 30 minutes | 1 hour | call recordings, transcripts, texts in |
| `hourly-crons` | runAbandonRecovery, textInboxNotes | 1 hour | 2 hours | abandoned-estimate recovery + text notes |
| `call-followups` | callWatch, callCenterSweep | 12 hours | 1 hour | call watch (2h, 08-20 ET) + promise sweep (07:15/15:15 ET) |
| `daily-retention` | firestoreBackupRetention, auditLogRetentionCron, recordingRetentionCron, pdfRenderRetention | 1 day | 6 hours | cleanup / retention jobs |
| `daily-customer-touches` | dailyLeadDigest, morningBrief, onFollowUpDue, onYardSignPickupDue, anniversaryAutoTouch, reviewRequestNudge, onAfterInstallDay | 1 day | 6 hours | morning digests + nudges to Jo (not homeowners) |
| `daily-syncs` | syncGbpReviews, googleCalendarReconcile, hailMatchCron | 1 day | 6 hours | GBP reviews, Google Calendar reconcile, hail match |
| `weekly-crons` | weeklyDigest, dormantLeadNudge, weeklyVendorConfigExport | 1 week | 12 hours | weekly digest (Mon) + dormant-lead nudge (Wed) + vendor-config export (Sun) |
| `monthly-crons` | monthlyMarketingReport, monthlyOverheadAlertCron | cron 0 7 1 * * (America/New_York) | 12 hours | marketing report + overhead alert, 1st of month |

That is 18 of 20 — two spare for the next high-stakes cron.

**If you created checks from the old 25-slug table:** the dedicated ones above
keep working. These old slugs no longer receive pings and will go red — delete
them: `check-storm-alerts`, `storm-watch`, `run-abandon-recovery`,
`firestore-backup-retention`, `audit-log-retention-cron`,
`recording-retention-cron`, `sync-gbp-reviews`,
`google-calendar-reconcile`, `daily-lead-digest`, `on-follow-up-due`,
`on-yard-sign-pickup-due`, `anniversary-auto-touch`,
`review-request-nudge`, `hail-match-cron`, `weekly-digest`,
`dormant-lead-nudge`, `monthly-marketing-report`,
`monthly-overhead-alert-cron`.

Adding a cron: give it a PLAN entry (a dedicated slug + a CHECKS row while
there is room, otherwise join the closest-cadence group), add its row here,
and create the check.

## What a red check means, and does not mean

- **Red with a `/fail` ping in the log** — the cron ran and threw. Read the
  ping body (`error`) and the function's logs. This is the useful case
  Cloud Monitoring's absence alerts could not distinguish.
- **Red with no ping at all** — the cron did not run to completion, the
  deploy removed it, or the secret is unset (`integrationStatus.healthchecks`
  is `false` in the admin readout). Check the fleet: the orphan detector
  (#1382) and `gcloud scheduler jobs list`.
- **Every check red at once** — the ping key was rotated or the secret is
  the `__unset__` stub. Not 18 outages.
- A ping is a POST with a 5-second timeout that never throws into the cron:
  Healthchecks being down cannot fail the work it monitors.

## Uptime monitors (the other half — vendor config only)

Better Stack's free tier (10 monitors, 1 status page) or Healthchecks' own
paid tiers can watch the public URLs; nothing in code is needed:
`https://nobigdealwithjoedeal.com/`, `/pro/login`, `/api/google-reviews`
(expect HTTP 200 and **not** `"empty":true` once Places is configured),
`/storm-check`, and the `/healthz`-style endpoints if any are added.
