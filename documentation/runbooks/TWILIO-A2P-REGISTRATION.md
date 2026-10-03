# Twilio A2P 10DLC registration — get the CRM's texts delivered

**Why (checked 2026-10-02, read-only):** the Twilio account is still a
**Trial**, and it has **no A2P brand, no campaign and no Messaging
Service**.

- The CRM sends from one local number (…4855).
- In the last 45 days the CRM sent **23 texts and delivered 0**:
  - 19 failed with error **30034**: the carrier blocks texts from an
    unregistered 10DLC number. All 19 were lead alerts to the business line
    …7382.
  - 4 failed with **21608**: a trial account can only text verified numbers.
- `alert_outbox` still says `smsStatus: sent` for all of them, because
  Twilio *accepted* each one before the carrier blocked it. Email has been
  carrying every alert.

Switching providers (Sent.dm and the like) doesn't avoid this: every US
business texting provider needs the same 10DLC registration. Thursday
(Bland, on (513) 940-5589) doesn't use Twilio. Its own SMS flag is subject
to the same carrier rules for its number.

Jo does these steps in the Twilio console; Claude can't. The text to paste
is below. Fees are small: a one-time brand and campaign vetting fee, plus a
monthly campaign fee. Twilio shows the current amounts. Approval usually
takes a few days to a few weeks.

## Step 1 — Upgrade the account from Trial

Console → **Admin → Account billing → Upgrade**, and add a payment method.
Until this is done, texts only reach verified numbers (21608).

## Step 2 — Register the brand (Standard, because NBD is an LLC with an EIN)

Console → **Messaging → Regulatory Compliance → A2P 10DLC → Register**.
Choose **Standard** (not Sole Proprietor).

| Field | What to enter |
|---|---|
| Legal business name | Exactly as on the IRS EIN letter (the LLC's name) |
| EIN | From the EIN letter |
| Business type | Limited Liability Company |
| Industry | Construction / Home services |
| Website | https://nobigdealwithjoedeal.com |
| Address | The business address on the EIN record |
| Contact | Jo, with the business email and phone |

If the name or address doesn't match the IRS record exactly, the brand is
rejected. That is the most common failure.

## Step 3 — Create the campaign

Use case: **Mixed**. NBD sends customer care, appointment and estimate
notices, account notifications to Jo, and opt-in storm alerts.

**Campaign description:**
> No Big Deal Home Solutions is a roofing and exterior contractor in the
> Cincinnati / Northern Kentucky area. We text homeowners who requested an
> estimate or inspection through our website forms, with appointment
> confirmations and reminders, links to their estimate or contract,
> follow-ups about their project, and invoice and payment receipts. People who
> sign up on our storm alerts page receive severe-weather alerts for their
> zip code (2-4 per season). We also send internal new-lead notifications to
> the business owner's own phone.

**Sample messages:**
1. `No Big Deal Home Solutions: Hi Sarah, your roof inspection is confirmed for Tue Oct 7 at 10:00 AM at 123 Main St. Reply C to confirm or call (859) 420-7382 to reschedule. Reply STOP to opt out.`
2. `No Big Deal Home Solutions: Hi Mike, your estimate is ready: https://nobigdealwithjoedeal.com/e/abc123 — reply with any questions. Reply STOP to opt out.`
3. `No Big Deal Home Solutions: Payment received — $4,000.00 by Zelle on invoice INV-1042. Thank you! Reply STOP to opt out.`
4. `No Big Deal Storm Alert: Hail reported near 45040 this afternoon. If you'd like a free roof check, reply YES. Reply STOP to unsubscribe.`
5. `NBD new lead: Karen R., Mason OH, roof - hail, (513) 555-0142. Open the CRM to follow up.`

These stay inside the Kentucky insurance-job rules. They never say "we
handle your claim", and they never offer advance payment.

**How customers opt in (Message flow / Call to action):**
> Customers opt in on our website forms (for example
> https://nobigdealwithjoedeal.com/estimate,
> https://nobigdealwithjoedeal.com/roof-score and
> https://nobigdealwithjoedeal.com/storm-check), which include an unchecked
> consent checkbox: "I agree to receive my estimate and follow-up
> communication from No Big Deal Home Solutions. Message & data rates may
> apply. Reply STOP to opt out." Storm alert subscribers sign up at
> https://nobigdealwithjoedeal.com/storm-alerts. Our privacy policy is at
> https://nobigdealwithjoedeal.com/privacy.

Check boxes: **Embedded links: yes**, **Phone numbers: yes**, **Age-gated:
no**, **Direct lending: no**.

**Opt-out / help keywords:** STOP, UNSUBSCRIBE, CANCEL, END, QUIT /
HELP, INFO.
- Opt-out reply: `No Big Deal Home Solutions: You're unsubscribed and won't receive more texts. Reply START to resubscribe.`
- Help reply: `No Big Deal Home Solutions: for help call (859) 420-7382 or email info@nobigdealwithjoedeal.com. Msg & data rates may apply. Reply STOP to opt out.`
- Opt-in reply: `No Big Deal Home Solutions: You're subscribed to project updates. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`

## Step 4 — Messaging Service and the number

Console → **Messaging → Services → Create**. Add the sender number (…4855)
to it, then attach the approved campaign to that service. The CRM sends
from `TWILIO_PHONE_NUMBER`, so nothing in the code changes.

## Privacy policy — one sentence reviewers look for

The policy already says "We do not sell, share, or rent your personal
information to third parties for their marketing purposes." Reviewers often
want the mobile-specific line as well. **Pending Jo's OK** to add it to
/privacy:

> No mobile information will be shared with third parties or affiliates for
> marketing or promotional purposes. Text messaging opt-in data and consent
> will not be shared with any third parties.

## After approval — prove it

- Send one test from the CRM, then confirm Twilio shows **delivered** (not
  just "sent").
- The callWatch check in the next PR raises a bell and push notification
  whenever recent texts didn't deliver, so a silent block can't go
  unnoticed again.
