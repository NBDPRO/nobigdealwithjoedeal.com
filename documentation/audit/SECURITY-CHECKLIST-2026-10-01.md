# Security checklist audit — 2026-10-01

Jo was handed a 19-item "vibe-coding security" checklist and asked for it to be
run against the repo. There were four read-only audits:

- rules and admin;
- CORS, rate limits, webhooks and debug;
- secrets, tokens, logs and SQL;
- inputs, uploads, XSS and auth.

Every gap marked below was re-verified against the code (and, where it
mattered, read-only against production) before it was fixed. The fixes ship
together; the regression suite is
[security-checklist-2026-10-01](../../tests/security-checklist-2026-10-01.test.js).
All 14 of its fix checks fail on the pre-fix code.

## Verdicts

| Item | Verdict | Notes |
|---|---|---|
| Enable RLS (Firebase rules) | PASS | No `if true`; default-deny at the end of both rule files; no signed-out access; tenant isolation holds |
| Tighten CORS | PASS | Every endpoint uses a fixed 3-origin allowlist; no wildcards; webhooks `cors:false` |
| Parameterized SQL | N/A | No SQL anywhere; no Firestore path or field built from request data |
| Verify email addresses | **FIXED** | `sendEmail` didn't require it; see gap 2 |
| Keep tokens out of localStorage | **FIXED** | The portal view token was cached in localStorage; see gap 7 |
| Hide .env from Git | **FIXED** | Nothing secret was ever committed (gitleaks runs on full history in CI); `.gitignore` gaps closed, gap 5 |
| Validate form inputs | **PARTIAL→FIXED** | `submitPublicLead` validates on the server; the referral form didn't (gap 6) |
| Protect admin routes | PASS | Admin pages are UI-gated, but every admin callable checks the claim server-side |
| Disable production debugging | PASS | Enforced CSP, XFO DENY, HSTS; no source maps; no debug endpoints |
| Server-side API secrets | PASS | ~55 `defineSecret`s; no paid-API key in `docs/` |
| claude-code-security-review | Not installed | Needs an Anthropic key as a repo secret plus per-PR spend; Jo's call |
| Rate limit requests | **PARTIAL→FIXED** | Per-IP limits everywhere; the public AI endpoints had no global cap (gap 3) |
| Validate file uploads | PARTIAL | Size and type limits on every path; SVG removed (gap 8). Open: homeowner portal photos keep EXIF |
| Keep sensitive data from logs | **FIXED** | 3 email and 1 phone log sites now masked (gap 4) |
| Hash passwords | PASS | Firebase Auth only; no password stored, logged or kept locally |
| Verify webhook signatures | PASS | Stripe ×3, Resend, Twilio, Cal.com, Bland, Swath, Hover, BoldSign, all before acting; Thumbtack is a constant-time shared token |
| Server-side permissions | PASS (+ gaps 1, 9) | Claims are server-only; viewers can't write; signed contracts are locked |
| Block XSS | PASS | No `unsafe-inline` or `unsafe-eval`; `script-src-attr 'none'`; no unescaped public-form data found |
| Update dependencies | PASS | Dependabot on npm ×2 and Actions; CI fails closed on HIGH `npm audit` |

## Gaps fixed (most serious first)

1. **Owner powers via an unverified email.** `isOwnerCaller`
   (`functions/handlers/_shared.js`) fell back to an email allowlist without
   checking `email_verified`.
   - A read-only production check showed `jonathandeal459@gmail.com` has **no
     Firebase account**. Self-registration is open, so anyone could have
     signed up with that address and passed the check.
   - That would have given them the unmatched-SMS inbox, uncapped seats, a
     usage-cap bypass and the E2E password.
   - The email fallback now needs `email_verified === true`. Jo's real
     account (`jd@`) is verified and carries the owner claim.
2. **`sendEmail` was a phishing relay for unverified accounts.** Any
   self-registered account could send 200 HTML emails a day from the company
   domain, with free choice of reply-to and attachments. It now returns 403
   `email_unverified`, the same rule the SMS, AI, invite and Stripe paths
   already apply.
3. **Unbounded public AI spend.** `publicFunnelAI` (any prompt, ≤6,000
   chars) and `publicVisualizerAI` had only per-IP caps.
   - Both now share a 300/day cap across all callers
     (`PUBLIC_AI_DAILY_CAP`).
   - If the limiter store fails, they refuse (503).
4. **PII in logs.** `funnel-recovery.js` (×2) and `invites.js` now log a
   `maskEmail` value; `thursday.js` logs the last 4 digits of the phone.
5. **`.gitignore`** now covers `.env.*`, `*.pem/.key/.p12/.pfx`,
   service-account and credentials JSON, and `.runtimeconfig.json`. The one
   tracked env file (non-secret switches) stays tracked.
6. **Referral form input.** Phone and email were stored raw, at any length,
   and the email check let `<` and `>` through. Fields now go through
   `noAngle` and length caps; the email check refuses `< > " '`.
7. **Portal view token** (30-day bearer): the cache moved to
   sessionStorage, and old localStorage copies are deleted.
8. **SVG uploads** on document paths: `isDocType` now lists raster image
   types only. The emulator rules suite has a refused-SVG / allowed-PNG case.
9. **Cal.com booking hijack.** A user could write another tenant's Cal.com
   username onto their own profile and receive that tenant's bookings.
   - The webhook now matches the organizer's Auth email first.
   - The username is a fallback, and only when exactly one account has it.

## Checked and deliberately not changed

- **`TURNSTILE_REQUIRED=true`.** Production already enforces Turnstile: the
  `TURNSTILE_SECRET` version is enabled and bound to `submitPublicLead`.
  Setting the flag in `functions/.env.nobigdeal-pro` would also apply to the
  functions emulator, which has no secret, and would break
  `public-intake.test.js` and `lead-bridge.integration.test.js`. Set it with
  a deploy-time env var instead if it's ever wanted.
- **Firebase web `apiKey` and the Sentry browser DSN:** public by design.

## Open (not fixed here; ranked)

1. **Medium — remote signing stores signer-supplied HTML.** The integrity
   check compares visible text only (`functions/remote-signing.js`), so a
   signature block could carry markup. Sanitize the signature blocks to the
   image and stamp only.
2. **Low — homeowner portal photos keep EXIF/GPS and aren't re-encoded**
   (`functions/portal.js` upload). Re-encode with sharp, as the public-form
   photo path already does.
3. **Low — permanent `?token=` download URLs** (photos, docs, receipts) can't
   be revoked. Move to short-lived signed links (`signImageUrl` exists, but is
   gated on an IAM grant; see the photo-token note).
4. **Low — `adminAI` is reachable by every `company_admin`** (every
   self-serve owner). This is a cost exposure; it's rate-limited and uses
   Haiku.
5. **Low — no server-side MFA check for platform-admin claims.**
6. **Low — OTP / lead-notify limits key on the raw IPv6 address**
   (`verify-functions.js`). Per-phone caps and App Check still apply.
7. **Low — `/leads` rules have no size caps** on name, address or notes.
8. **Info — BoldSign webhook signature format** may not match BoldSign's
   `t=…, s0=…` header. It fails closed (rejects), so it isn't a security
   hole, but real events may be refused. Check BoldSign's docs before
   relying on it.
9. **Info — dead direct-to-Anthropic client fallbacks**
   (`claude-proxy.js`, `ask-joe-main.js`). They can't run, but could be
   deleted.
