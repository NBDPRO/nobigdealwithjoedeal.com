# Daily lead-gateway probe (2026-11-26)

Follow-up 5 of the ten Joe approved on 2026-11-26 after the
[web-leads Turnstile outage](../audit/WEB-LEADS-TURNSTILE-OUTAGE-2026-11-25.md).
Every website lead form returned 403 from 2026-10-13 to 2026-11-25, and nothing
said so. The alarms added on 2026-11-25 (the GA4 `lead_submit_failed` event and
`monitoring/alert-lead-submit-failures.json`) fire only when a homeowner submits,
and the site gets a few submits a month. This probe makes a submit every
morning, so a broken gateway shows up even with no traffic.

## Joe's choices (2026-11-26)

| Question | Choice |
|---|---|
| How the gateway knows it is the probe | A Google ID token for the project's own runtime service account. No new secret and nothing to set up. |
| Turnstile | Check its setup: the flag on with the stub secret fails; a real secret is checked with Cloudflare using a dummy token. |
| A failed probe | `notifyOwner` severity `alert`: one text (daytime, inside the 4-a-day cap), plus bell and push. |
| No leads for a while | Bell and push only (no text) after 14 days without a stored website lead, once per quiet stretch. |

## How it works

- `leadGatewayProbe` (`functions/lead-gateway-probe.js`) runs daily at 09:00 ET.
  For each public lead kind (guide, contact, estimate, storm, free_roof, inspect)
  it POSTs a body built from the gateway's own field spec to the live
  `submitPublicLead`. Each request carries the site Origin, the `x-nbd-lead-probe`
  header, and an ID token in `x-nbd-probe-token`, minted by the metadata server
  with the gateway URL as its audience.
- `submitPublicLead` (`functions/handlers/integrations.js`) checks the token first
  (`functions/lead-probe-auth.js`). The token must be signed by Google, carry the
  gateway URL as its audience, and belong to the function's own service account
  with a verified email. A request that only claims to be the probe gets 403 and
  costs nothing else. The probe then passes through every gate a real submit
  passes: the per-IP limit, Turnstile setup (`turnstilePosture` in
  `functions/integrations/turnstile.js`), the honeypot, and kind, field and phone
  validation. It gets `200 { probe: true }` back before any tenant read, started
  estimate update, flood or duplicate bucket, or Firestore `add`. No lead is
  stored, nothing is bridged to the CRM, and no text or email goes out.
- A probe passes when it gets a 200, `probe: true`, and a CORS allow-origin for
  `https://nobigdealwithjoedeal.com`. On any failure, Joe gets the alert text,
  the run throws (a heartbeat `/fail` on the shared `daily-syncs` check), and the
  failed 4xx/5xx also trips the 2026-11-25 email policy.
- After the probes, the cron reads the newest `createdAt` of NBD's own leads
  (no `companyId`, so a tenant microsite lead never resets the clock) in every
  public lead collection. If the newest is more than 14 days old, it sends one bell notice.
  `system/leadGatewayProbe.quietNotifiedNewestMs` keeps that notice from
  repeating. A read error skips the notice rather than inventing one.

## Why it cannot create a lead

- The gateway answers the probe before any of its writes. The suite proves this
  with every kind against the real handler: no `add`, no registry read, and no
  bucket other than the per-IP limiter (`tests/lead-gateway-probe-2026-11-26.test.js`).
- Every probe body sets the honeypot to the sentinel `nbd-lead-probe`. If a
  gateway without probe mode ever got the probe (for example a partial deploy),
  the honeypot path would pretend success and store nothing, and the cron would
  report "not a probe answer". The suite proves both sides of this.
- The data is fictional: phone 513-555-0100, email `lead-probe@example.com`.
- Nothing was run against production for this change.

## Security review (2026-11-26)

An independent read found nothing critical, high or medium. Two lows were fixed
before the PR: a forged probe header is now counted by the per-IP limiter like
any other caller, and the quiet clock ignores tenant leads. One low is by
design: "self" is the default compute service account, which every function in
the project runs as, so any of them could pass the probe check. That gains
nothing, because probe mode stores, reads and sends nothing. A dedicated
service account for `submitPublicLead` and `leadGatewayProbe` would narrow it.

## What it cannot see

- A broken Turnstile widget in the browser (a page that mints no token). The GA4
  `lead_submit_failed` event (`had_token`) covers that.
- Problems after the store step: the CRM bridge, lead alerts, the homeowner ack.
  `leadAlertWatchdog` and the pipeline dead-man cover those.
- Each page's own JavaScript. This probe tests the server's contract, not the
  pages.

## After deploy

1. Nothing to create: the token comes from the runtime service account, and the
   heartbeat rides the existing `daily-syncs` check.
2. The first 09:00 ET run should log `leadGatewayProbe` with `ok: true` and six
   `submitPublicLead: probe ok` lines in `submitpubliclead`.
3. If it fails because the token is refused (`probe refused` /
   `wrong-account`), the gateway and the cron are running as different service
   accounts. Check the logs. The probe stores nothing either way.
