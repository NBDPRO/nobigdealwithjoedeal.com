# Data breach response — runbook (2026-10-03)

> **Not legal advice.** This is the operating plan. Have a lawyer review it
> once, and call one the moment §3 says "breach". Statute summaries below are
> for orientation only; confirm the current text before relying on a deadline.

## 1. What counts

A **breach** is someone who shouldn't have it getting (or plausibly getting)
personal information we hold. In practice, any of:

- A leaked or committed credential: service-account key, API secret (Stripe,
  Twilio, Resend, Groq, Anthropic, Bland), a CRM user's password or session.
- Firestore / Storage data readable by the wrong person: a rules mistake, a
  public Storage URL with customer documents, a tenant seeing another tenant.
- A lost or stolen phone / laptop that was signed in to NBD Pro or has the
  call-recording Drive folder synced.
- Customer data sent to the wrong person (email, text, export).

**Personal information** here means names with phone, address, email; call
recordings and transcripts; photos of homes; insurance claim numbers, policy
numbers, carrier details; payment details (Stripe holds card data — we don't).

## 2. First hour — contain

1. **Stop the leak.** Rotate the exposed secret ([SECRET_ROTATION](SECRET_ROTATION.md)),
   revoke the user's sessions (Firebase Auth → disable user), fix or revert
   the rule ([ROLLBACK](ROLLBACK.md)), or pause the integration (most
   `integrations/*` config docs have a `paused` / enabled flag).
2. **Keep the evidence.** Don't delete logs or docs. Export the relevant Cloud
   Logging window and note exact times (UTC) in a private incident note.
3. **Write down** what happened, when it was discovered, who discovered it.
   The discovery time starts the legal clocks.

## 3. Same day — assess

- **Whose data?** Owner tenant (NBD's homeowners) vs. an NBD Pro tenant's
  customers vs. NBD Pro users themselves.
- **What data, how many people, which states?** Ohio and Kentucky residents
  are most of it; note any others.
- **Was it actually acquired?** Logs (Cloud Logging, Firestore audit, Storage
  access) — "possible exposure" vs. "confirmed access" matters for notice.
- If personal information was (or reasonably may have been) acquired by an
  unauthorized person → treat it as a breach and **call the lawyer**.

## 4. Notify (with the lawyer)

| Who | Rule of thumb | Source |
|---|---|---|
| **Ohio residents** | Notice in the most expedient time possible, **no later than 45 days** after discovery (law-enforcement delay allowed). If more than 1,000 Ohio residents: also notify the consumer reporting agencies. | Ohio Rev. Code 1349.19 |
| **Kentucky residents** | Notice in the most expedient time possible and without unreasonable delay. If more than 1,000 people: also notify the consumer reporting agencies. | KRS 365.732 |
| **Other states** | Each state has its own breach law; the lawyer maps them. | — |
| **NBD Pro tenants** | When the data is a tenant's customers, NBD acts as their service provider: tell the affected tenant(s) **promptly** so they can meet their own notice duties. Give them what you know: what, when, how many, what you've done. | Contract/terms + state law |
| **Card data** | Stripe holds card data; if Stripe credentials leaked, rotate and contact Stripe support. | Stripe |
| **Law enforcement** | If criminal (theft, intrusion), report; they may ask to delay notice. | — |

Notice content (plain language): what happened, when, what information,
what we're doing, what they can do (watch for phishing calls/texts that use
their claim or address details), how to reach Joe.

## 5. After

- Root cause written up under `documentation/audit/` and linked from INDEX.
- A test or gate that would have caught it (the repo's habit: every fix ships
  with a test that fails on the old code).
- Review who has access: Firebase IAM, GitHub, Drive folder shares, bot keys
  (crmMcp per-bot keys — revoke any unused).

## Contacts to fill in (Joe)

- Lawyer: ______________________
- Insurance (cyber/general liability, if any): ______________________
- Stripe support: dashboard → Help
- Google Cloud / Firebase support: console → Support
