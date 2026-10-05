# Client error alerts — runbook (2026-10-04)

**What this is for.** Before 2026-10-04 an error in the CRM on Jo's iPhone reached
nobody. The dashboard's global `error` / `unhandledrejection` handlers only wrote
to the console. `cspReport` only logged (about 103 warnings in 2 days, and nobody
watched them). All nine live Cloud Monitoring policies watch the server side. Sentry
is configured (`docs/pro/js/sentry-config.js`), but nothing pages Jo from it.

This PR adds three pieces:

1. **`docs/pro/js/client-error-reporter.js`** is deferred on `dashboard.html` and
   `customer.html`. It catches uncaught errors, unhandled rejections and
   server-fault callable failures (`internal`, `unknown`, `not-found`, `unimplemented`,
   `data-loss` through `window._httpsCallable`). For each **distinct** error it
   sends one report to `/api/client-error`.
   - Each report holds: message and trimmed stack (both scrubbed), page, view, build
     (`loader-<script-loader ?v>`), user agent, standalone, online, and a SHA-256
     hash of the uid.
   - Scrubbed out: emails, phones, long digit runs, street addresses, tokens and all
     URL query strings. The raw uid and lead data are never sent.
   - Each signature is sent once per tab session. A page load sends at most 10
     reports and a tab session at most 25.
   - It sends nothing on localhost or under automation unless
     `window.__NBD_CLIENT_ERRORS_LOCAL === true`. CI E2E calls production functions,
     so test errors must not page Jo.
2. **The `clientError` function** (`functions/handlers/monitoring.js`) is public,
   because an error can happen before sign-in.
   - It accepts POST only, with a 4 KiB cap (larger bodies get 413).
   - It allows 30 reports a minute per IP and 30 a minute per uid hash, using the
     existing limiter (over the limit gets 429).
   - It scrubs and bounds the payload again (`functions/client-error-logic.js`; a bad
     shape gets 400) and recomputes the signature itself.
   - It writes **one** `ERROR` log line: `jsonPayload.event="client_error"` with
     `sig`, `kind`, `errorMessage`, `stack`, `page`, `view`, `build`, `userAgent`,
     `standalone`, `online` and `uidHash`. No Firestore document is written per
     error. The limiter's counter document is the only write.
3. **Three alert policies** live as JSON in `monitoring/`, like the other nine. They
   are **not created yet.** Jo runs the commands below after the PR deploys.

| file | fires when | notifies |
|---|---|---|
| `alert-client-error-new-signature.json` | a `client_error` signature not seen in the last 7 days | once per signature, then at most daily while it keeps happening; auto-closes after 7 days |
| `alert-client-error-spike.json` | more than 20 client errors in 15 min, across all sessions | at most once per incident; auto-closes 1 h after it clears |
| `alert-csp-report-spike.json` | more than 40 CSP warnings in 1 h (baseline ~2/h) | at most once per incident |

The "new" in "new signature" comes from Cloud Logging behaviour, not from extra code.
With label extractors, each combination of extracted label values gets its own
alert timeline. A sig that is already open does not open a second alert. Google
caps one log-based policy at **20 notifications/day** and **2 new alerts/minute**.
A flood of distinct sigs is the spike policy's job.

## Jo: turning the alerts on (after this PR is deployed)

Run these from Git Bash, signed in to gcloud as the project owner. They are
read-only until step 4.

1. **Check that the function is live and public.** A 204 is good:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://nobigdealwithjoedeal.com/api/client-error \
     -H "Content-Type: text/plain" \
     --data '{"kind":"manual","message":"runbook smoke test","page":"runbook"}'
   ```
   - **403** means Cloud Run has no `allUsers` invoker binding. That is the
     2026-10-02 cspReport failure. Fix it with
     `gcloud run services add-iam-policy-binding clienterror --region=us-central1 --member=allUsers --role=roles/run.invoker --project=nobigdeal-pro`.
   - **404** means the deploy has not landed yet.
2. **Check that the smoke-test line was logged** (wait about 30 s):
   ```bash
   gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="clienterror" AND jsonPayload.event="client_error"' \
     --project nobigdeal-pro --freshness 10m --limit 5 --format 'value(severity,jsonPayload.sig,jsonPayload.errorMessage)'
   ```
   You should see `ERROR  <12-hex sig>  runbook smoke test`.
3. **List the existing policies first.** Running a create twice makes a duplicate:
   ```bash
   gcloud alpha monitoring policies list --project=nobigdeal-pro --format="value(name,displayName)"
   gcloud alpha monitoring channels list --project=nobigdeal-pro --format="value(name,displayName)"
   ```
   - Neither "Client error" nor "CSP violation spike" should be listed.
   - The channel list is a positive control. It must show the two "Joe - Primary"
     channels (`…/11974029248665804510` and `…/7729093229259591605`) that the three
     JSON files already name. If it is empty, gcloud is not authenticated, and an
     empty policy list proves nothing.
   - On Windows the em dash prints as `?`. The stored name is still correct.
4. **Create the three policies** from the repo root:
   ```bash
   gcloud alpha monitoring policies create --policy-from-file=monitoring/alert-client-error-new-signature.json --project=nobigdeal-pro
   gcloud alpha monitoring policies create --policy-from-file=monitoring/alert-client-error-spike.json --project=nobigdeal-pro
   gcloud alpha monitoring policies create --policy-from-file=monitoring/alert-csp-report-spike.json --project=nobigdeal-pro
   ```
5. **Prove the new-signature policy fires.** Send one report with a message nobody
   has sent before:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" -X POST https://nobigdealwithjoedeal.com/api/client-error \
     -H "Content-Type: text/plain" \
     --data "{\"kind\":\"manual\",\"message\":\"alert test $(date +%s)\",\"page\":\"runbook\"}"
   ```
   - An email and SMS should arrive within about 5 minutes.
   - The digits in the message are normalised out of the signature, so a second run
     the same week does **not** notify. To test again, change the words.
   - Close the incident in the console afterwards.
6. **Record it.** Add the three policy ids to the live-status table in
   `monitoring/README.md`.

Rollback: `gcloud alpha monitoring policies delete <name> --project=nobigdeal-pro`
removes a policy. To silence the reporter itself, delete the
`client-error-reporter.js` `<script>` tag from both pages. The server endpoint is
harmless without it.

## Reading a client error

```bash
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="clienterror" AND jsonPayload.event="client_error" AND jsonPayload.sig="<sig from the alert>"' \
  --project nobigdeal-pro --limit 20 --format json
```

- **`build`** is the `script-loader.js?v=` the page loaded. If it is older than the
  current one in `dashboard.html`, the phone is running stale JS. Ask Jo to
  force-quit and reopen the installed app.
- **`standalone: true`** is the home-screen app, and **`online: false`** means it
  happened offline. Many "failed to fetch" errors are just the phone losing signal.
- **`kind: callable`** messages read
  `callable <functionName> [<code>] <message>`. `not-found` usually means the
  client calls a function that is not deployed, which is a dead-call bug.
- **`uidHash`** is the first 16 hex characters of SHA-256 of
  `"nbd-client-error:" + uid`. To check whether it is Jo, hash his uid the same way.
  The log never holds the uid itself.

## Gaps this does not cover (by design)

- Errors thrown before the deferred reporter runs (the first parse of
  `dashboard.html`) are missed. Sentry's eager `sentry-init.js` still covers them.
- Files that import `httpsCallable` straight from the SDK, instead of through
  `window._httpsCallable`, are not observed. Their uncaught rejections are still
  reported as `unhandledrejection`.
- Network failures and expected refusals (`permission-denied`,
  `resource-exhausted`, `invalid-argument`, `unavailable`, `deadline-exceeded`) are
  deliberately not reported.
- Pages other than `dashboard.html` and `customer.html` do not load the reporter.
