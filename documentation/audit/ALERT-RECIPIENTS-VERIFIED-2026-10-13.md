# Verified alert recipients, per-recipient caps, share-link recipient binding (2026-10-13)

Scope: who NBD-sent staff/owner email and text alerts may go to, and who the
report share-link email may go to. Follow-up to
[LEAD-ALERT-PROVENANCE-2026-10-13](LEAD-ALERT-PROVENANCE-2026-10-13.md), which
bounded the volume and left the recipient unverified. Decision: Jo, "Option B",
2026-10-13. Branch `fix/alert-recipients-verified` (stacked on
`fix/lead-alert-calcom-auth` until that merges).

## Update 2026-10-13 (later): Jo's decisions and the "tighten more" round

The follow-ups the first review left open are decided and built in this same
PR. Where the sections below (written before) say "left open", this section is
current.

**CALL 1 - owner only.** Only the company OWNER (`companies/{id}.ownerId`)
may request, confirm or revoke a custom alert address. The `alertRecipients`
callable refuses everyone else (status, send and revoke) with an "ask the
owner" message, server-side; the Settings button is also hidden for them. The
emailed confirmation token is honoured only while the person who requested it
is still the current owner (a demoted admin's or former owner's pending link
dies). Confirming now:

1. mails a fixed-copy notice to the OWNER's verified sign-in address (the
   address, a one-press revoke link, and the Settings path) BEFORE recording
   anything - if that mail cannot be sent, nothing is confirmed;
2. REPLACES any earlier confirmed address (one confirmed address at a time, so
   switching among addresses always needs a fresh confirmation);
3. writes an `audit_log` entry (`alert_recipient.confirmed`, masked address,
   hash, actor uid).

Revoke: the link in the notice (a `kind:'revoke'` token on the same
`/alert-confirm/<token>` page, 30 days, GET writes nothing, POST removes, single
use) or the owner-only `revoke` action in Settings. Both audit
(`alert_recipient.revoked`) and tell the owner. The pending confirm token
lives in `alertRecipientTokens` (admin-SDK only, same as before).

**CALL 2 - share-email plan gate.** `createReportShareToken` emails only when
the report's tenant has `subscriptions/{companyId}` on a known paid plan
(starter, foundation, team, growth, professional, enterprise - pinned to
billing.js PLAN_LIMITS by a test) with status `active` or `past_due`, after
the same access-code trial expiry the lead cap applies
(`lead-cap-logic.effectivePlan`). Free, trialing, cancelled, unknown-plan and
missing subscriptions are blocked; a read error fails CLOSED. NBD's own tenant
and a platform admin are exempt. The link is still minted and returned, with
`emailBlocked: 'plan'`, so a Free tenant can copy it and send it themselves.

**Tighten-more items (each with failing-first tests):**

- (a) `createTeamInvite` requires the caller's token `email_verified` (platform
  admin exempt).
- (b) Subject lines of the e-sign link / reminder / signed-copy emails
  (`esign-logic`) and the remote-signing `createSignRequest` mail are built
  from the shared `cleanLabel` (control / bidi / zero-width stripped, bounded).
  The remote-signing Subject used to be the HTML-escaped document name; it is
  now plain text.
- (c) `capRecipients` takes a per-TENANT bucket in front of the all-tenant
  destination counter (share 3 of 5, invites 3 of 5, alerts 60 of 100). A tenant
  that is over its own share is stopped without touching the shared counter, so
  it cannot burn a destination's budget for everyone.
- (d) **Finding: yes.** `submitPublicLead` (handlers/integrations.js) tags a
  public lead with any REAL tenant's `companyId` / `siteKey` supplied by an
  anonymous browser (that is how tenant microsites work), so an anonymous
  caller could use up that tenant's 60/day alert ceiling or the destination
  caps with public-form leads. Mitigations built: (1) public-form-origin alerts
  and trusted-origin alerts (collection `leads`: the Cal.com webhook and the
  Thumbtack bridge, whose doc ids only the authenticated webhook mints) now have
  SEPARATE tenant-ceiling and destination buckets, so a public flood cannot
  starve a booking alert; (2) a per-source-IP-per-tenant daily bucket (10)
  runs BEFORE the tenant ceiling for public-form alerts, so one box cannot
  consume it. **Residual:** an attacker with many source addresses can still use
  up the public bucket (email/SMS alerts for later public leads that day are
  skipped; the CRM lead, bell and push are unaffected). Not built (not small):
  enforcing Turnstile on the public forms (`TURNSTILE_REQUIRED`), and a "your
  alert cap was reached - N more leads are in the CRM" summary mail.
- (e) **Premise check (verified Auth email): holds in the repo.** Nothing
  server-side marks an email verified except the E2E test-user provisioning
  callable (owner-only, fixed NBD-domain address); every `createUser` in
  functions/ is `emailVerified:false` (team adds, access-code logins). Sign-in
  paths in the client are email+password, Google popup, and custom tokens minted
  for access codes (the claim follows the user record, so an unverified user
  stays unverified). The alert policy reads `emailVerified` from the Admin
  SDK, not the client token. **Not checkable from the repo:** which providers
  are enabled in the Firebase console (a SAML/OIDC/Microsoft/Apple provider that
  asserts unverified emails would break the premise) and the "link accounts with
  the same email" setting. Jo should confirm the console lists only Email/Password
  and Google.

### Behaviour changes to know about

- A **company_admin** (and any member who is not the owner) can no longer
  request or confirm a custom alert address; they see "ask the owner".
  Confirmed addresses from before this PR do not exist (the feature is new), so
  nobody loses an already-working address.
- Confirming a second custom address **replaces** the first.
- **Free, trialing and cancelled tenants** can still create a share link but
  the app no longer emails it for them (reason `plan`; the rep copies the
  link). Paying tenants, NBD's own tenant and `past_due` customers are
  unchanged. Includes every 14-day Stripe trial (`status: trialing`): this is
  deliberate per Jo ("not free/trial"); flip `planAllowsShareEmail` to also
  accept `trialing` if trial reps should email.
- An unverified owner/admin can no longer send team invites until they verify
  their own email.
- Public-form alert emails/texts: at most 10 a day per source address per
  tenant; at most 60 a day per tenant; trusted (booking) alerts are counted
  separately.

### Proof (round 2)

`tests/alert-recipients-2026-10-13.test.js` is now 144 checks (sections h-m
are new). Senders stay stubbed at `Module._load`; every absence has a positive
control. Break tests (mutate the fix, confirm WHICH assertion reddens), all red
on the expected assertion: owner check widened to company_admin reddens the
three "company_admin cannot ..." checks; dropping the requested-by-owner check
reddens "requested by a non-owner confirms NOTHING" and the hand-off check;
no owner notice reddens the notice / revoke-link / audit checks; swallowing a
notice failure reddens "notice send failure: NOT confirmed"; merge instead of
replace reddens "replaces the previous confirmed one"; revoke POST not
removing / revoke GET removing each redden the matching revoke check; plan
gate off, read error failing open, NBD exemption removed, trialing allowed,
unknown plan allowed, access-code expiry ignored each redden exactly their own
plan check; invite email_verified gate removed reddens "an UNVERIFIED owner
cannot invite"; each Subject sanitiser removed reddens its own subject check;
tenant bucket removed / counted after the destination reddens the tenant-share
checks; trusted origin sharing the public buckets reddens both "not starved"
checks; per-IP cap removed or counted after the tenant ceiling reddens the IP
checks. Existing suites touched for the new rules: tenant-ownership (share
fixtures now a paid tenant), lead-alert-calcom (trusted bucket namespace),
viewer-callables (comment only).

### Round 3: security-review findings (same day)

- **F1 (HIGH, fixed): a confirmed address must not outlive its owner.** A
  confirmed entry is honoured only while its `requestedBy` is the CURRENT
  `companies/{id}.ownerId` and that owner has a verified, enabled sign-in
  email. A disabled (lapsed) owner voids it; an entry with no `requestedBy`
  is not honoured. `transferCompanyOwnership` also deletes
  `alertRecipients/{companyId}` in its transaction: the new owner re-confirms
  (Jo: drop on transfer).
- **F2:** `send` must carry `expectedEmail` (the address the Settings screen
  displayed); a mismatch with the profile at call time is refused, so an admin
  cannot swap the address between display and click.
- **F3:** the confirm token is claimed in a transaction FIRST (confirmed entry +
  revoke token), THEN the owner is told. If the notice fails or is rate limited
  (`alertNotice:company`, 10/day, same as the removal path) the claim is rolled
  back: the previous confirmed address is restored, the revoke token deleted and
  the confirm token made usable again, and the page returns 503. One notice per
  confirmation.
- **F5:** a watchdog re-send does not debit any bucket (its first attempt did).
- **F6:** no per-IP bucket when the lead carries no address (`clientIp` falls
  back to the string 'unknown', which would otherwise be one shared key).
- **F7:** a revoke link whose address was already replaced or removed says so
  instead of "Removed".
- **F8:** the verified-email check on `createTeamInvite` and on `send` falls
  back to the Auth record when the token claim is stale (claims lag ~1h), like
  `claimInvite`.
- **F9:** a failed audit write is logged as `ALERT_RECIPIENT_AUDIT_MISSING`
  (and the confirm logs that it completed without a row). It does not block the
  confirmation.
- **F4 (residual, accepted):** many source addresses can still use up a tenant's
  public-form ceiling. Added the cheap in-app signal: the first capped alert of
  a day drops one "Lead alerts paused today - leads still arrive in your CRM"
  bell item for the owner (deterministic id, one a day).
- **Thumbtack webhook verified fail-closed before any write:** 503 when
  `THUMBTACK_WEBHOOK_SECRET` is unset, 401 on a missing or wrong token
  (timing-safe compare of hashes), then the `create()`.

Tests: 185 checks in `tests/alert-recipients-2026-10-13.test.js` (sections n-t
new, including the owner-only role matrix with stale claims, an unreadable
company doc, token kind confusion, cap independence, NBD never entering cap
code, the cleanLabel code-point set) plus a hand-off assertion in
`tests/owner-handoff-2026-10-12.test.js`. Each fix was break-tested; the
mutation that reddened nothing by assertion (the `send` Auth fallback) failed
by an uncaught refusal in the test.

## What changed

1. **One shared recipient policy** — `functions/alert-recipients.js`. A
   company's alert recipient is one of:
   - the owner's **verified Firebase Auth email** (companyId is the owner uid),
   - a custom address the owner **confirmed** (NBD emails a one-time link to
     that address; the click is recorded in `alertRecipients/{companyId}`,
     admin-SDK only — rules deny every client read/write), or
   - for an unconfirmed custom value: **ignored**, and the alert falls back to
     the owner's Auth email.
   SMS goes only to the owner's Auth phone number, and only when the company
   opted into SMS alerts by configuring a number that matches it.
   A company that configured no alert contact is still alerted nowhere (Jo,
   2026-10-05). The CRM lead, the in-app bell and the push are never blocked.
2. **`lead-alert.js`** uses the helper for every non-NBD target (new-lead
   alerts for all five public collections, Cal.com bookings, Thumbtack bridge,
   the watchdog re-send all pass through `alertJoe`). NBD's own target is the
   existing constants, untouched: `jd@` and the gmail inbox stay two separate
   addresses.
3. **Per-recipient daily cap** (`RECIPIENT_DAILY_CAP`, 100) keyed on the
   destination address/number across all tenants, via `rate-limit.js`. NBD's own
   constants are exempt (a tenant cannot write them). A limiter error fails
   open. Over the cap the outbox row records `skipped:recipient-capped` and the
   push still goes out.
4. **Confirmation flow** — `alertRecipients` callable (`status` / `send`;
   owner or company_admin; caller's own email must be verified; the address is
   read from the company profile server-side, never from the request; capped
   per company and per destination per day) and the token page
   `/alert-confirm/<token>` (`confirmAlertRecipient`; GET writes nothing, POST
   consumes the token; mirrors `/unsubscribe`). The confirmation mail carries
   no tenant-authored text and no account address; its limits key on the
   canonical inbox (`+tag`, Gmail dots and googlemail folded), add a
   platform-wide daily ceiling, and fail CLOSED on a limiter error. The owner
   is `companies/{id}.ownerId` (a company keeps its id across an owner
   hand-off), a disabled (lapsed/erased) Auth account is never a recipient, and
   an owner lookup error fails closed.
5. **`createReportShareToken`**: the email is sent only when the caller's token
   has `email_verified`, and only to the caller's own verified email, the
   subject lead's address, or an address on a lead/customer record in the
   caller's own tenant. Per-caller and per-recipient daily caps. The tenant name
   in the Subject (and the lead first name / report type in the body) is
   stripped of control/bidi/zero-width characters and length-bounded. The link
   is still minted; the response carries `emailBlocked` with the reason.
6. **User-scoped digests** (`weekly-digest`, `dormant-leads`,
   `review-request-nudge`, `anniversary-touch`): `users/{uid}.email` is user-writable, so these send
   only to the user's verified Auth email (the platform owner's stored address
   passes through; NBD's digests do not move) and honour the per-recipient cap.
7. **`funnel-recovery`**: a visitor-typed address is mailed at most
   `FUNNEL_RECOVERY_RECIPIENT_DAILY_CAP` (3) recovery emails a day.
7a. **`teamInviteEmail`** (same shape as the share link): the company name in
   the Subject is sanitised and one destination gets at most 5 invites a day.
8. **Settings UI** (minimal): a notice under Brand Identity → Contact saying
   "<address> is unconfirmed — lead alerts are going to <auth email> until you
   confirm it" with a Send confirmation email button, and a one-line note when a
   configured alert number is not the sign-in phone.

## Behaviour change to know about

- A non-NBD company whose alert Email is not its owner's verified sign-in email
  and has not been confirmed now gets alerts at the **owner's sign-in email**
  instead. Onboarding sets the alert Email to the owner's own email, so most
  companies are unchanged.
- A non-NBD company with an alert **text** number that is not on the owner's
  sign-in account no longer gets texts (texting is A2P-blocked anyway; no
  Twilio Verify built).
- An owner whose sign-in email is **not verified** and who has not confirmed a
  custom address gets no alert email (bell and push unchanged).
- Report share links: a rep who types an address that is not a customer in
  their company, or whose own email is unverified, gets the link but no email.

## Proof

`tests/alert-recipients-2026-10-13.test.js` (85 checks) executes the real
modules with Resend/Twilio/push/Auth/Firestore stubbed at `Module._load`.
Every absence assertion has a positive control (same fixture, one input
changed, DOES send). Break tests (mutate the fix, confirm which assertion
reddens), all red as expected: raw tenant `alertEmail` reddens "unconfirmed
custom email gets nothing"; confirmed-always-true reddens the "ignored" and
"does not carry over" checks; SMS-any-number reddens "any other number is
ignored"; cap removed reddens "exactly the cap number of emails reach one
destination"; NBD capped reddens "NBD's own alerts are never capped" and
"nothing looked up"; cap failing closed reddens both "limiter outage fails
OPEN" checks; removing the tenant-record check, the `email_verified` check, the
caller cap or the recipient cap each redden exactly the matching share-link
assertion; GET-confirms reddens "GET writes NOTHING"; token-not-consumed
reddens "single-use"; any-member-may-send reddens the permission check;
send-uses-request-email reddens "ONLY to the address on the company profile".
`tests/firestore-rules.test.js` section 64: 25 checks (control allow + owner /
company_admin / platform admin denied on both collections); opening the
collection reddens exactly the nine alertRecipients checks.

## Review follow-ups (first round; resolved - see the update at the top)

- RESOLVED (owner only + owner notice + revoke): a company_admin could request
  a confirmation for the configured alert address.
- The share-link tenant-record rule (c) is satisfiable by a hostile tenant that
  creates a lead with the victim's address; it is bounded by the caller,
  per-recipient and platform-wide caps, and is the same residual
  `createSignRequest` accepts.
- RESOLVED (per-tenant bucket in front of the shared counter): one tenant
  could use up a destination's daily share/invite budget.
- Unverified-Auth-email senders with fixed copy (welcome, dunning, erasure
  confirmation) are outside this policy.

## Not covered / follow-ups

- Twilio Verify for custom SMS numbers (SMS stays owner-Auth-phone only).
- (built in round 2) Revoking a confirmed address: Settings button + owner notice link.
- Siblings reviewed and left alone: `sendEmail` (email_verified required,
  recipient must be on the customer record, 200/day), `createSignRequest`
  (recipient on record, daily cap), the estimate email (per-recipient cap
  already). `createTeamInvite` now requires the caller's verified email (round
  2); `callWatch` / call-center sweep / morning brief read `users/{NBD
  owner}.email`, which only the platform owner can write.
