# Cloud Monitoring alert policies — NBD Pro

These policies detect abuse and spend anomalies across the `nobigdeal-pro`
Firebase project. Apply each one in Google Cloud Monitoring either through
the console or the `gcloud` CLI.

## Live status (2026-09-13)

**Nine policies are live; two are held.** Until 2026-09-13 none were live.
Every condition was replayed against the previous 7 days of production data
before creation, which found and fixed three defects. Record, replay table and
rollback: [ALERT-POLICIES-LIVE-2026-09-13](../documentation/audit/ALERT-POLICIES-LIVE-2026-09-13.md).

| file | live policy id | state |
|---|---|---|
| `alert-turnstile-token-present.json` | 15802792625691337472 | live |
| `alert-backup-cron-stale.json` | 4583991940756031706 | live |
| `alert-email-queue-worker-stale.json` | 13778878090024007435 | live (fixed first) |
| `alert-function-latency.json` | 10772729232835340080 | live |
| `alert-functions-error-rate.json` | 9423454652957568708 | live (fixed first) |
| `alert-rate-limit-spike.json` | 13778878090024008942 | live |
| `alert-tenant-microsite-errors.json` | 14764694890411614899 | live |
| `alert-validateAccessCode-bruteforce.json` | 5276308824995125595 | live |
| `alert-voice-processing-failures.json` | 4594628795274947618 | live |
| `alert-claude-budget-exceeded.json` | — | **held**: cannot fire as intended until a code change logs the budget event |
| `alert-migrations-tick-stale.json` | — | **held**: disabled by design (a daily absence is not expressible) |
| `alert-client-error-new-signature.json` | — | **not yet created** (2026-10-04) — Jo runs [CLIENT-ERROR-ALERTS](../documentation/runbooks/CLIENT-ERROR-ALERTS.md) after the clientError deploy |
| `alert-client-error-spike.json` | — | **not yet created** (2026-10-04) — same runbook |
| `alert-csp-report-spike.json` | — | **not yet created** (2026-10-04) — same runbook |

**Do not run the create commands below for a live policy** — it makes a
duplicate. List first:
`gcloud alpha monitoring policies list --project=nobigdeal-pro --format="value(name,displayName)"`
(on Windows the em dashes print as `?`; the stored names are correct).

## Importing via gcloud

Authenticated as a project owner / monitoring admin:

```bash
# Brute-force detection on validateAccessCode
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-validateAccessCode-bruteforce.json \
  --project=nobigdeal-pro

# Cloud Functions 5xx / error-rate spike
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-functions-error-rate.json \
  --project=nobigdeal-pro

# Anthropic daily token budget exceeded
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-claude-budget-exceeded.json \
  --project=nobigdeal-pro

# Rate-limit 429 spike
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-rate-limit-spike.json \
  --project=nobigdeal-pro

# Backup cron stale (nightly Firestore export missing > 26h)
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-backup-cron-stale.json \
  --project=nobigdeal-pro

# Voice-intelligence processing failure rate
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-voice-processing-failures.json \
  --project=nobigdeal-pro

# emailQueueWorker stale > 30m (silent stop = no GDPR/dunning emails)
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-email-queue-worker-stale.json \
  --project=nobigdeal-pro

# migrationsTick stale > 26h (daily migration tick stopped firing)
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-migrations-tick-stale.json \
  --project=nobigdeal-pro

# User-facing function latency p95 high (slow/timeout, not caught by error-rate)
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-function-latency.json \
  --project=nobigdeal-pro

# First real Turnstile token on a public lead (ALREADY LIVE — see §11; do not re-create)
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-turnstile-token-present.json \
  --project=nobigdeal-pro
```

> **Scheduled-job staleness (Audit #4):** the `*-stale` policies use
> `conditionAbsent` against a per-run heartbeat log. `emailQueueWorker` and
> `migrationsTick` emit a heartbeat on **every** run (even no-op/skipped
> runs) precisely so a silent stop is detectable. If you add a new critical
> cron, give it an unconditional success log and a matching staleness policy.

Before running, edit each JSON file and replace `NOTIFICATION_CHANNEL_ID` with
Joe's Cloud Monitoring notification channel ID (SMS or email). You can list
channels with:

```bash
gcloud alpha monitoring channels list --project=nobigdeal-pro
```

## Individual alerts

### 1. `alert-validateAccessCode-bruteforce.json`
Fires on **any** `access_code_invalid` warning (a matched-log condition cannot
count; the old "more than 20 in 5 minutes" was never true), notifying at most
every 5 minutes. A single homeowner typo will trigger it; a burst of repeated
notifications is the brute-force signal.

### 2. `alert-functions-error-rate.json`
Fires when any of eight user-facing services (claudeproxy,
createcheckoutsession, validateaccesscode, imageproxy, publicvisualizerai,
renderpdf, submitpubliclead, stripewebhook) logs **more than 50 ERROR entries
in a 5-minute window**. Until 2026-09-13 its `ALIGN_RATE` aligner made that a
per-second threshold that could never be reached; it is `ALIGN_DELTA` now.

### 3. `alert-claude-budget-exceeded.json` — held, not deployable yet
Meant to fire on a `Daily AI budget exceeded` response, but that text is only
ever an HTTP response body (`functions/handlers/ai.js:201`), never a log line,
and the filter's `claudeProxy` service name matches nothing. Disabled until
the code logs a distinct budget event; the file's documentation says how.

### 4. `alert-rate-limit-spike.json`
Fires on **any** `rate_limit_denied` warning from any namespace
(publicVisualizerAI, claudeProxy, validateAccessCode, etc), notifying at most
every 10 minutes. The old "more than 200 denials in 10 minutes" was never what
a matched-log condition does. CI E2E calls production functions, so a CI
burst can trip it.

### 5. Billing budget (set in Cloud Billing console, not here)
In Cloud Billing → Budgets, set a **$50/day** budget on the project with a
50%/90%/100% threshold. Email + SMS to Joe.

> ⚠️ A Cloud Billing budget **alerts** — it does **not** stop spend. It is
> not a kill-switch. See the cost section of the Audit #4 report.

### 6. `alert-backup-cron-stale.json`
Fires when `backupFreshnessCron` logs the `backup_freshness.stale` error
(`functions/backup-freshness.js:120`), i.e. it found the latest Firestore
export too old, or could not read the backup bucket at all. Notifies at most
hourly. Restore capability may be
compromised — see `documentation/runbooks/RESTORE_FROM_BACKUP.md`.

### 7. `alert-voice-processing-failures.json`
Fires on **any** `voice: pipeline failed` error from `onaudiouploaded`,
notifying at most hourly (a matched-log condition cannot compute the "> 5%
over 1h" rate this section used to claim). Usually a missing/rotated
`GROQ_API_KEY`/`ANTHROPIC_API_KEY` or a client audio regression.

### 8. `alert-email-queue-worker-stale.json`
Fires when `emailqueueworker` writes **no log entries at all for 30 minutes**.
The worker runs every minute; a gap means GDPR-erasure confirmations and
Stripe dunning emails have silently stopped sending. It sums all of the
service's series first (`REDUCE_SUM`); without that, every deploy retired a
revision's series and would have paged.

### 9. `alert-migrations-tick-stale.json` — held, disabled by design
Would fire when `migrationsTick` misses its heartbeat for **> 26h**, but an
absence condition cannot exceed 23h30m, so it would false-fire daily. The fix
is code that checks heartbeat age and logs an error; see
`documentation/runbooks/HEALTHCHECKS-SETUP.md` for the cron heartbeat
alternative.

### 10. `alert-function-latency.json`
Fires when **p95 request latency > 30s** on a user-facing callable
(claudeProxy, renderPdf, analyzeRoofPhoto, analyzePhotoVision, etc).
Complements the error-rate policy, which only catches *thrown* errors —
this catches *slow / timing-out* requests before they 504.

### 11. `alert-turnstile-token-present.json` — **LIVE since 2026-09-13**
Fires when `submitPublicLead` logs `turnstileTokenPresent=true`, i.e. a real
public lead arrived carrying a Cloudflare Turnstile token. Good news, not an
incident: it is the signal the enforcement decision in
`documentation/runbooks/TURNSTILE-SETUP.md` waits on. At most one email + SMS
per day (`notificationRateLimit` 86400s), to the same two "Joe - Primary"
channels as the other policies here.

Created as `projects/nobigdeal-pro/alertPolicies/15802792625691337472` and
read back field-for-field over the REST API. It was **the only alert policy
in the project** at the time: the others in this directory were never
applied (see `documentation/audit/STABILITY-AUDIT-2026-09-04.md`).

It checks token **presence**, not validity: nothing verifies a token while
`TURNSTILE_SECRET` is unset. The log carries `kind` + doc `id` but not the
page, so read the lead doc's `source` to see which surface produced it.
Disable the policy once enough trues have been seen.

Two Windows traps hit while creating it:
- `gcloud` prints non-ASCII as `?` on a Windows console, so the em dash in
  the display name *looked* corrupted even though it was stored correctly.
  Read back over REST (`curl` + `gcloud auth print-access-token`) before
  concluding a policy was mangled. The same substitution can defeat
  `scripts/ops-setup.sh`'s skip-if-display-name-exists `grep`, which would
  then create a **duplicate**. List policies before running it from Windows.
- An empty `policies list` is a real `[]` only if the same command lists the
  two notification channels. Run that positive control.

### Stripe webhook delivery (Stripe dashboard, not here)
Stripe webhook **non-delivery** (bad signature, endpoint down) produces no
GCP logs, so a Cloud Monitoring alert can't see it and a staleness alert
would false-positive on a low-volume account. Configure alerting in
**Stripe Dashboard → Developers → Webhooks** (Stripe emails on repeated
delivery failures). Webhook handlers that *throw* are still caught by the
functions-error-rate policy.

## Ongoing monitoring

You should check these dashboards at least daily for the first 30 days after
deploy:
- **Cloud Logging** — `resource.type="cloud_run_revision"` with
  `severity>=WARNING`
- **Cloud Monitoring** — Alert Policies list (should be green)
- **Twilio Console** — Usage → last 7 days
- **Anthropic Console** — Usage → last 7 days
- **Stripe Dashboard** — Payments + Disputes

# Tenant microsite config errors (Oaks + all /sites/t/ tenants down)
gcloud alpha monitoring policies create \
  --policy-from-file=monitoring/alert-tenant-microsite-errors.json \
  --project=nobigdeal-pro
