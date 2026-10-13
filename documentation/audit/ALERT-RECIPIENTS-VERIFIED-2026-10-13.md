# Verified alert recipients, per-recipient caps, share-link recipient binding (2026-10-13)

Scope: who NBD-sent staff/owner email and text alerts may go to, and who the
report share-link email may go to. Follow-up to
[LEAD-ALERT-PROVENANCE-2026-10-13](LEAD-ALERT-PROVENANCE-2026-10-13.md), which
bounded the volume and left the recipient unverified. Decision: Jo, "Option B",
2026-10-13. Branch `fix/alert-recipients-verified` (stacked on
`fix/lead-alert-calcom-auth` until that merges).

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
   no tenant-authored text.
5. **`createReportShareToken`**: the email is sent only when the caller's token
   has `email_verified`, and only to the caller's own verified email, the
   subject lead's address, or an address on a lead/customer record in the
   caller's own tenant. Per-caller and per-recipient daily caps. The tenant name
   in the Subject (and the lead first name / report type in the body) is
   stripped of control/bidi/zero-width characters and length-bounded. The link
   is still minted; the response carries `emailBlocked` with the reason.
6. **User-scoped digests** (`weekly-digest`, `dormant-leads`,
   `review-request-nudge`): `users/{uid}.email` is user-writable, so these send
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

`tests/alert-recipients-2026-10-13.test.js` (64 checks) executes the real
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
`tests/firestore-rules.test.js` section 64: 16 checks (control allow + owner /
company_admin / platform admin denied on both collections); opening the
collection reddens exactly the nine alertRecipients checks.

## Not covered / follow-ups

- Twilio Verify for custom SMS numbers (SMS stays owner-Auth-phone only).
- Revoking a confirmed address from the UI (the server doc supports it).
- Siblings reviewed and left alone: `sendEmail` (email_verified required,
  recipient must be on the customer record, 200/day), `createSignRequest`
  (recipient on record, daily cap), the estimate email (per-recipient cap
  already). Left for a decision: `createTeamInvite` does not require the
  caller's email to be verified (owner-only, 30/hour/uid, now per-recipient
  capped); `callWatch` / call-center sweep / morning brief read `users/{NBD
  owner}.email`, which only the platform owner can write.
