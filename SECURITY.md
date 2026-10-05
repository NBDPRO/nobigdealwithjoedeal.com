# Security Policy

We take security seriously. Find a bug before an attacker does and we'll fix it fast.

## Reporting a vulnerability

**Preferred:** email `security@nobigdealwithjoedeal.com` with the subject line `[NBD Pro Security]`.
Include a description, reproduction steps, and your assessment of impact.

**For GitHub users:** if the repo is public, you can open a private vulnerability report
via `Security → Report a vulnerability`. Do NOT open a regular Issue — those are public.

**Response SLA:**

| Severity                  | First response | Fix target                 |
| ------------------------- | -------------- | -------------------------- |
| Critical (RCE, auth bypass, data breach) | 24 hours  | ≤ 7 days            |
| High (privilege escalation, PII leak)    | 3 days    | ≤ 30 days           |
| Medium / Low              | 1 week         | Best-effort                |

We do not currently run a paid bounty program but we will publicly credit
responsible reporters in the release notes for the fix (with permission).

## In scope

- **Firebase project:** `nobigdeal-pro`
- **Production domains:** `nobigdealwithjoedeal.com`, `www.nobigdealwithjoedeal.com`
  (redirects to the apex), `nobigdeal-pro.web.app`, `nobigdeal-pro.firebaseapp.com`
  (the Firebase Auth `authDomain` — used by ~20 client files, must stay reachable).
  **Corrected 2026-09-14** — this line used to name `nbd-pro.web.app`, which has
  never existed (the Firebase project is `nobigdeal-pro`; that string is a typo
  that also survived in two functions' CORS allowlists until the same date — see
  `functions/report-sharing.js` / `functions/calendar-feed.js`).
- **Cloud Functions:** everything under `functions/` — public endpoints and callables
- **Firestore rules:** `firestore.rules`
- **Storage rules:** `storage.rules`
- **Client auth + role handling:** `docs/pro/js/nbd-auth.js`, `docs/pro/js/admin-manager.js`
- **Homeowner portal:** `docs/pro/portal.html` + `getHomeownerPortalView` / `createPortalToken`
- **Webhooks:** `stripeWebhook`, `invoiceWebhook`, `calcomWebhook`,
  `measurementWebhook`, `incomingSMS`, `thumbtackWebhook`,
  `stripeConnectWebhook` (the last two added 2026-09-14 — they were always
  live and signature-gated, just never listed here; `swathWebhook` and the
  BoldSign `esignWebhook` were removed from source 2026-10-04)

## Out of scope

- Theoretical attacks that require physical access to a signed-in device
- DoS that requires 10k+ concurrent clients (we rely on Firebase quota + per-IP / per-uid rate limits)
- Third-party vendor vulnerabilities (report directly to Instant Roofer / Regrid / etc.
  — we'll coordinate if their issue affects us)
- Social engineering the on-call engineer
- Missing security headers on third-party iframes we embed (Cal.com)

## Current security posture (for researchers)

- **Auth:** Firebase Auth + custom-claim roles (`admin`, `company_admin`, `manager`, `sales_rep`, `viewer`).
  `admin` is platform-global and NEVER grantable through any UI path — only via
  `scripts/grant-admin-claim.js` run manually.
- **App Check:** every **callable** (`onCall`) declares `enforceAppCheck: true`, and that
  is where the option is honoured. It is **NOT** an `onRequest` control:
  firebase-functions reads `enforceAppCheck` only in the callable wrapper
  (`HttpsOptions` is declared `Omit<GlobalOptions,'region'|'enforceAppCheck'>`), and it is
  not serialized into the deployed endpoint, so there is no platform-side fallback either.
  16 `onRequest` handlers carried the option as dead config until 2026-08-02; it was removed
  rather than left in place looking like a protection. HTTP endpoints are gated by webhook
  signature verification, ID-token checks, or per-IP rate limits — see each handler's header.
  Site key is set in `window.__NBD_APP_CHECK_KEY`.
- **Firestore rules:** default-deny, explicit per-collection allowlists. Rules tests in
  `tests/firestore-rules.test.js` run on every PR.
- **Storage rules:** content-type + size + owner enforcement per path.
- **Rate limiting:** Firestore-backed fixed-window limiter (`functions/rate-limit.js`). Every mutation callable
  has a per-uid cap (`callableRateLimit`).
- **Audit log:** every write to `users/`, `leads/`, `companies/`, `access_codes/`,
  `subscriptions/` triggers a redacted entry in `audit_log/`. Platform-admin-read only.
- **GDPR:** Article 20 export (`exportMyData`) + Article 17 two-step erasure
  (`requestAccountErasure` + `confirmAccountErasure`).
- **Session hygiene:** `registerDeviceFingerprint` + `user_devices/{uid}/seen/{hash}`
  is built to fire a Slack alert on new-device sign-in, but it does not fire
  today: no client caller invokes it (removed under "D9" in
  `dashboard-bootstrap.module.js` — the function was never deployed when
  that call shipped, so every load 401'd) and the function itself no-ops
  until `SLACK_WEBHOOK_URL` is provisioned, which it is not. **Corrected
  2026-09-14** — provisioning the secret alone is not enough; the client
  call needs to come back too.
- **Secrets:** all API keys live in Firebase Secret Manager. Never in the repo.
  Secret inventory in `scripts/deploy-runbook.sh`.

## Key rotation

### Routine (every 90 days)

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set STRIPE_SECRET_KEY
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET
firebase functions:secrets:set RESEND_API_KEY
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase deploy --only functions
```

After deploy, revoke the old key on the vendor dashboard (Stripe, Anthropic, etc.).

### Under suspected compromise (any secret)

1. Rotate the secret immediately via the vendor dashboard.
2. Run `scripts/deploy-runbook.sh` with the new value.
3. From an admin session, call `rotateAccessCodes` to kill any dependent code.
4. Run `SELECT * FROM audit_log WHERE ts > <incident-time>` — look for unusual
   role grants, portal-token mints, or deletion patterns.
5. Post a short incident note in `#nbd-ops` Slack.

## Reviewer checklist (in every PR)

The template at `.github/pull_request_template.md` enforces this — not optional on
security-sensitive diffs (see `.github/CODEOWNERS` for the list).

- [ ] New `onCall` functions have `enforceAppCheck: true` + rate limit + tenant scoping.
      New `onRequest` functions have signature verification / an ID-token check /
      a per-IP rate limit instead — `enforceAppCheck` is a no-op there (see the
      App Check note above).
- [ ] New Firestore collections have explicit default-deny rules + a test.
- [ ] New sub-processors are disclosed in `docs/privacy.html`.
- [ ] New PII fields are handled by the redactor in `functions/audit-triggers.js`.
- [ ] No new inline `onclick=` handlers (migrate to delegated `data-action=`).

## Retired surfaces

These endpoints are intentionally no longer part of the platform.
Listed here so an auditor / future dev doesn't resurrect one by
accident:

- **Cloudflare Worker `nbd-ai-proxy`** (all repo callers removed
  2026-06-17 — pending deletion in the Cloudflare dashboard; repo
  files removed 2026-04-15). The worker was a raw Anthropic/Gemini
  passthrough guarded only by an Origin header, which is bypassed
  when the header is absent — no auth, no rate limit, no model/token
  cap. An earlier note that it "returns 410 Gone / attack surface
  zero" was inaccurate: the endpoint was live and still in active use
  until the migration below.

  - **Public funnels (migrated 2026-06-17):** the `estimate.html`
    instant-estimator and the storm self-check now call the gated
    Firebase `publicFunnelAI` (per-IP rate limit keyed on the IPv6 /64
    prefix + server-forced cheap Claude model + capped `max_tokens` +
    text-only). **This endpoint is unauthenticated** — it previously
    claimed App Check here, which was never in effect on `onRequest`
    (see the App Check note above).
  - **Admin tools (migrated 2026-06-17):** the vault session-parsers
    (`vault.html`, `vault-page.js`) and `project-codex` now call the
    gated `adminAI` Cloud Function (Firebase ID token + admin-tier
    role + capped Claude). `admin/js/pages/analytics.js` only ever
    rendered mock data — its dead worker constant was removed. (Note:
    there is no Gemini text key server-side; these tools are Claude
    now, not Gemini.)

  No code path reaches the worker anymore and its origin has been
  dropped from `firebase.json` `connect-src`.

  **Ops action still required**: delete the `nbd-ai-proxy` worker in
  the Cloudflare dashboard. Until that manual step is done the live
  endpoint remains a reachable, unauthenticated AI proxy (cost-abuse
  surface) even though nothing we ship calls it — treat its removal
  as a priority, not cleanup. **Confirmed 2026-09-14 via the Cloudflare
  API that this is worse than "still live": the CORS lock only checks a
  present Origin header, so a POST with no Origin header at all still
  passes the gate** and forwards to Anthropic with the account's
  original (never rotated) key.

  **Three more workers were found in the same account, same date, none
  previously documented here**: `nbd-ai-visualizer` (still answers with
  `Access-Control-Allow-Origin: *` — an arbitrary origin can call it; its
  own OpenAI billing was never funded, capping the exposure, not closing
  it) and `nbd-mailerlite` / `nbd-stripe-webhook` (both still exist in
  the account with their `workers.dev` route disabled — not deleted, as
  a 2026-09-05 audit note and this file's own history once claimed).
  Delete all four in the same pass; rotate the Anthropic key bound to
  `nbd-ai-proxy` once it's gone.

- **`imageProxy` Cloud Function** (retired 2026-04-15, R-03). The
  function streamed Storage bytes through Cloud Functions, which
  doubled egress cost and starved the instance pool at scale. It
  also echoed attacker-chosen Content-Types from Storage metadata
  to the client (stored-XSS vector, H-01). Replacement is
  `signImageUrl` + the `NBDSignedUrl` client helper — clients get
  a 15-minute v4-signed Storage URL and fetch bytes directly from
  `storage.googleapis.com`. A 410 Gone stub remains at the
  `imageProxy` endpoint for stale clients; deletable after 7+ days
  of zero calls in Cloud Logging.

## Version history

- **2026-04** — v1.0 policy published.
- **2026-04-15** — retired-surfaces section added (nbd-ai-proxy
  Worker files removed; imageProxy function replaced with 410 stub).
- **2026-06-17** — corrected the nbd-ai-proxy status (it was live, not
  410) and removed every repo caller: public estimate + storm funnels
  now use the gated `publicFunnelAI`; the vault parsers + project-codex
  use the gated `adminAI`. Worker origin dropped from the CSP; only the
  Cloudflare-dashboard deletion remains.
- **2026-09-14** — deliberate decision, not an oversight: this repo
  stays public this quarter. The tradeoff (full CRM logic, Firestore
  rules, function names, and webhook list are all cloneable) is
  accepted in exchange for building in the open; the source-visible
  `LICENSE` at the repo root already reflects this. The one asset this
  visibility genuinely leaked — the Xactimate-style catalog's published
  material + labor unit costs — is addressed by rotating those figures
  (`scripts/cost-rotation.js`, `tests/cost-basis-ledger.js`) rather than
  by hiding the repo, since a history rewrite would not undo any clone
  already taken. Revisit only if a competitor is shown to have acted on
  the clone, not on the theoretical exposure alone. Corrected the same
  date: `nbd-pro.web.app` → the real hosts (see "In scope" above); the
  Slack new-device alert and the reviewer-checklist App-Check bullet
  (both above) were also stale.
