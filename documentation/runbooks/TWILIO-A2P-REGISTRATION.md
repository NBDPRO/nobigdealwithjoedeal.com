# Twilio A2P 10DLC registration — get the CRM's texts delivered

## 2026-10-04 update — ready to submit (start here)

Everything below this section is the 2026-10-02 first draft. Where the two
differ, **this section wins**. Three changes from the draft:

- **Brand type is now Low-Volume Standard, not Standard.** It costs less and
  is plenty for NBD's volume.
- **Sample messages are now the real templates from the code.** The draft's
  samples were made up.
- **/privacy now has the text-message terms TCR checks for** (message
  frequency, carrier line, HELP). They're in this PR, at
  `/privacy#sms-terms`.

Twilio's requirements were checked on **2026-10-04** against Twilio's docs:
- *A2P 10DLC — Gather Business Information* (updated 2026-06-22)
- *A2P 10DLC Brand Registration* and *Campaign Registration* (both updated
  2026-09-25)
- *A2P 10DLC overview* (updated 2026-07-07)

Nothing was submitted to Twilio, and no Twilio API was called.

### Jo: the 3 things to decide or know

1. **Have the IRS EIN letter (CP-575) in hand.** The repo knows the name
   "No Big Deal Home Solutions, LLC" and "Campton, KY 41301", but not the
   street address or the EIN. The legal name, EIN and address must match
   the IRS record **exactly**, or the brand is rejected. That is the most
   common failure.
   - **If the LLC has an EIN** (expected), use **Low-Volume Standard**.
   - **If there is no EIN**, use **Sole Proprietor** instead (path B below).
     Never pick Sole Proprietor if an EIN exists. TCR rejects it, and you
     pay the fees anyway.
2. **Upgrade and register in the same sitting, then keep texting from your
   own phone until the campaign shows Approved.**
   - Cost is about **$20 one-time**: $4.50 brand + $15 campaign vetting.
   - Then about **$1.50/month** for the Low-Volume Mixed campaign, plus
     small per-text carrier fees.
   - The brand is usually approved within minutes to a few days. The
     campaign is usually approved in 1 to 3 weeks.
   - Why it matters: once upgraded, a text to a customer is accepted and
     then silently blocked by the carrier until the campaign is approved
     (see "Order matters" below).
3. **Two weak spots a reviewer could flag.** If the campaign is rejected,
   fix these first:
   - **No standalone Terms page for homeowners.** The only terms on the
     site are the NBD Pro software terms. This PR adds text-message terms
     to the privacy policy at `/privacy#sms-terms`, and that's what goes in
     the "Terms" URL. Twilio's rule is "terms hosted on your own domain",
     which this meets. If a reviewer still rejects it for terms, the fix is
     a short `/terms` page (a follow-up PR).
   - **The automatic STOP and HELP replies say "NBD Pro"**, not "No Big
     Deal Home Solutions" (`functions/sms-functions.js`, the inbound
     webhook). They still work, and the brand name is only *recommended*
     in those replies. A one-line follow-up PR can rename them.

### Path A — Low-Volume Standard brand (the LLC has an EIN) — recommended

Why this type:
- NBD sends a few texts a day. Low-Volume Standard allows about 6,000 a day
  across carriers.
- It skips Standard's $41.50 secondary vetting.
- It allows the cheap Low-Volume Mixed campaign.
- It can be upgraded to Standard later if volume ever grows.

**Brand form:**

| Field | Enter |
|---|---|
| Brand type | Low-Volume Standard |
| Legal business name | Exactly as on the EIN letter, e.g. `No Big Deal Home Solutions, LLC` (copy the letter, punctuation included) |
| DBA / brand name | `No Big Deal Home Solutions` |
| Tax ID (EIN) | From the EIN letter |
| Business type | Limited Liability Corporation |
| Industry | Construction |
| Business registration | USA: EIN |
| Regions of operation | USA and Canada → pick **USA** |
| Company status | Private (not publicly traded) |
| Website | `https://nobigdealwithjoedeal.com` |
| Address | The street address on the EIN letter (Campton, KY 41301) |
| Authorized contact | Joe Deal, Owner, `jd@nobigdealwithjoedeal.com`, `+1 859 420 7382` |
| Customer support email | `jd@nobigdealwithjoedeal.com` |

### Path B — Sole Proprietor brand (only if there is NO EIN)

- Use Jo's own legal name, home address and mobile number.
- Twilio texts that mobile a one-time PIN to confirm, so have the phone
  ready.
- You get one campaign, with use case "Sole Proprietor", about 1,000 texts
  a day to T-Mobile.
- Use the same description, message flow and samples as below.

### Campaign — copy and paste

**Use case:** Low Volume Mixed (on Path B, the only option is "Sole
Proprietor").

**Campaign description** (40–4096 characters):

```
No Big Deal Home Solutions is a roofing and exterior contractor serving the Cincinnati and Northern Kentucky area. We text homeowners who request an estimate or inspection on our website and tick the consent box: a confirmation that we received their request, appointment confirmations, and follow-ups about their estimate, project and payments. Homeowners who sign up on our Storm Alerts page get a text when hail or severe weather is reported near their zip code (usually 2-4 per season). We also send new-lead notifications to the business owner's own phone.
```

**Message flow / call to action** (40–2049 characters):

```
End users opt in on our website, nobigdealwithjoedeal.com. Every form that asks for a phone number has an unchecked consent checkbox, and the form will not submit until it is ticked. Forms: the estimate request at https://nobigdealwithjoedeal.com/estimate, the inspection request at https://nobigdealwithjoedeal.com/inspect, the homepage form at https://nobigdealwithjoedeal.com/, Storm Check at https://nobigdealwithjoedeal.com/storm-check, Roof Score at https://nobigdealwithjoedeal.com/roof-score, the storm report at https://nobigdealwithjoedeal.com/storm-report, the Storm Alerts signup at https://nobigdealwithjoedeal.com/storm-alerts, and the quick request form on our service and area pages (for example https://nobigdealwithjoedeal.com/areas/batavia-oh). Checkbox wording on the estimate form: "I agree to receive my estimate and follow-up communication from No Big Deal Home Solutions. Message & data rates may apply. Reply STOP to opt out." Checkbox wording on all other forms: "I agree to receive my results and follow-up communication from No Big Deal Home Solutions by call or text at the number above. Message & data rates may apply. Reply STOP to opt out. Not a condition of purchase." The Storm Alerts page also says: "We'll only text you when severe weather actually hits your zip code. Usually 2-4 times per season. Reply STOP to unsubscribe anytime." We record the time, the wording shown and the page for every consent. Customers who call our business line (859) 420-7382 or meet the owner in person may also ask to be texted about their appointment; we text them only about that request. Privacy policy: https://nobigdealwithjoedeal.com/privacy. Text message terms: https://nobigdealwithjoedeal.com/privacy#sms-terms
```

**Privacy policy URL:** `https://nobigdealwithjoedeal.com/privacy`
**Terms and conditions URL:** `https://nobigdealwithjoedeal.com/privacy#sms-terms`

**Sample messages.** These are the real templates in the code, with
[brackets] for the parts that change. Paste 1–4; 5 is optional.

1. Lead acknowledgement (`functions/lead-alert.js`, `ackHomeownerSms`):
```
[First name] — got your estimate request. This is Joe with No Big Deal Home Solutions — I'll call you shortly. Urgent? Call/text me at (859) 420-7382. Reply STOP to opt out.
```
2. Storm alert to subscribers (`functions/storm-watch.js`):
```
NBD Storm Alert: [1.25" hail] reported near [city]. If your roof took it, Joe documents damage free before you call insurance: nobigdealwithjoedeal.com/storm-check or call/text (859) 420-7382. Reply STOP to opt out.
```
3. Appointment confirmation (`functions/sms-functions.js`, template `appointment`):
```
Hi [name]! [rep name] from NBD confirming our upcoming roof inspection on [date] at [time]. Looking forward to it!
```
4. New-lead alert to the owner's own phone (`functions/lead-alert.js`, `smsBody`):
```
🔔 NBD lead — [form name] ([source])
[customer name] · [phone]
[address]
Concern: [concern]
```
5. Follow-up after a visit (`functions/sms-functions.js`, template `interested`):
```
Hey [name]! This is [rep name] from NBD Home Solutions. Great chatting today — I'd love to take a closer look at your roof. Let me know a good time!
```

**Checkboxes:**
- Embedded links: **Yes**
- Embedded phone numbers: **Yes**
- Age-gated content: **No**
- Direct lending or loan arrangement: **No**

**Keywords and replies.** Enter exactly what the code sends today, so the
record matches reality (`functions/sms-functions.js`, inbound webhook):

| Field | Enter |
|---|---|
| Opt-out keywords | `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT` |
| Opt-out reply | `You've been unsubscribed from NBD Pro SMS. Reply START to resume, HELP for help.` |
| Help keywords | `HELP, INFO` |
| Help reply | `NBD Pro: Msg & data rates may apply. Reply STOP to unsubscribe. Support: (859) 420-7382.` |
| Opt-in keywords | `START, UNSTOP` |
| Opt-in reply | `Welcome back to NBD Pro SMS. Reply STOP anytime to unsubscribe.` |

If the form insists the opt-in reply name the brand and say how to get
help, use this instead:
`No Big Deal Home Solutions: you're subscribed to texts about your request. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`
That version differs from what the code sends, so file the rename
follow-up from item 3 above.

All five samples stay inside the Kentucky insurance-job rules: no "we
handle your claim", no advance-payment offer. Sample 2's "documents damage
free before you call insurance" is an inspection offer, not claim handling.

### Jo: tap-by-tap (phone)

Twilio moved this menu in 2026. If you don't see **Trust Hub**, use the
older path: **Messaging → Regulatory Compliance → Onboarding**.

1. Log in at console.twilio.com, open the menu (☰) and go to **Admin →
   Account billing → Upgrade account**. Add a card and confirm. *(Do steps
   2–6 straight after this, in the same sitting.)*
2. Menu → **Trust Hub → Customer Profiles**. Create the **Primary Customer
   Profile** with the Path A brand-form values above. Submit it; it's
   usually approved quickly.
3. Menu → **Trust Hub → Registrations → A2P Brands → Create A2P Brand**.
   Choose **Low-Volume Standard**, fill it from the table, and submit.
   ($4.50)
4. When the brand shows **Approved**: **Registrations → A2P Campaigns →
   Create A2P Campaign**. Pick the brand, then **Create a new Messaging
   Service** and name it `NBD CRM`.
5. Use case **Low Volume Mixed**. Paste the description, message flow,
   privacy and terms URLs, samples 1–4 (and 5 if you like), the four
   checkboxes, and the keyword/reply table. Submit. ($15 vetting)
6. **Messaging → Services → NBD CRM → Sender Pool → Add Senders** → add the
   CRM number ending **4855**. The code sends from `TWILIO_PHONE_NUMBER`,
   so nothing in the code changes.
7. Wait for the campaign to show **Approved**. Until then, text customers
   from your own phone.
8. After approval, send one text from the CRM to your own phone. Check
   **Monitor → Logs → Messaging** shows **Delivered** (not just "Sent").
   Then tell Claude, and the automatic texts (lead acknowledgement, storm
   alerts) can be switched on.

### Before you hit Submit — what this PR checked

- **Privacy policy (`/privacy` §5):**
  - The mobile non-sharing sentence was already there (#2056).
  - New in this PR, under `#sms-terms`: who texts and why, "message
    frequency varies" (storm alerts 2–4 a season, matching
    `/storm-alerts`), "Message and data rates may apply", STOP and HELP,
    not a condition of purchase, and carriers not liable.
  - `tests/legal-disclosures-2026-10-03.test.js` §6 checks each of these.
    It also checks that the STOP/HELP claims and the phone number match
    the inbound webhook.
- **Consent checkbox:** on every public form that collects a phone number
  (#2121). Each one is unchecked by default, and the form won't submit
  until it is ticked. The wording is quoted above; its single source is
  `functions/tcpa-consent.js` `CONSENT_TEXTS`. Pages: `/estimate`
  (estimate wording), and `/`, `/inspect`, `/storm-check`, `/roof-score`,
  `/storm-report`, `/storm-alerts` plus the quick form on 185 service and
  area pages (general wording).
- **Door-knock templates** (`D2D_SMS_TEMPLATES` in
  `functions/sms-functions.js`: `storm_damage`, `ins_has_claim`,
  `not_home`): only send these to someone who gave you their number and
  agreed to a text. A text to a stranger's number is exactly what 10DLC
  filtering blocks, and it can get the campaign suspended.
- **Texts you type by hand in the CRM** don't add "Reply STOP to opt out".
  Add it yourself to the first text you send a new person.

---

## 2026-10-02 first draft (kept for history; the section above supersedes it where they differ)

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

### Step 1 — Upgrade the account from Trial

Console → **Admin → Account billing → Upgrade**, and add a payment method.
Until this is done, texts only reach verified numbers (21608).

> **⚠ Order matters: upgrade and register together, not upgrade first.**
>
> Today a text you send to a customer from the CRM fails *immediately*
> with 21608, because of the trial account. `nbd-comms.js` sees that error
> and opens your phone's Messages app instead, so the customer still gets
> the text, from your own phone.
>
> Once you upgrade, Twilio *accepts* those texts. If the campaign isn't
> approved yet, the carrier then blocks them later (30034). There's no
> error at send time, so the Messages fallback never runs and the text is
> silently lost.
>
> So: upgrade, then submit the brand and campaign the same sitting. Until
> the campaign shows **Approved**, keep texting customers from your own
> phone. The callWatch bell ("texts are not delivering") and the dashboard
> alert banner will show any text that gets lost in that window.
> (Checked 2026-10-02: automatic customer texts — storm, lead
> acknowledgement, anniversary — are all switched off, so only texts you
> send by hand are affected.)

### Step 2 — Register the brand (Standard, because NBD is an LLC with an EIN)

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

### Step 3 — Create the campaign

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

### Step 4 — Messaging Service and the number

Console → **Messaging → Services → Create**. Add the sender number (…4855)
to it, then attach the approved campaign to that service. The CRM sends
from `TWILIO_PHONE_NUMBER`, so nothing in the code changes.

### Privacy policy — one sentence reviewers look for

The policy already says "We do not sell, share, or rent your personal
information to third parties for their marketing purposes." Reviewers often
want the mobile-specific line as well. **Added to /privacy §5 (Jo approved
2026-10-02, PR #2056):**

> No mobile information will be shared with third parties or affiliates for
> marketing or promotional purposes. Text messaging opt-in data and consent
> will not be shared with any third parties.

### After approval — prove it

- Send one test from the CRM, then confirm Twilio shows **delivered** (not
  just "sent").
- The callWatch check in the next PR raises a bell and push notification
  whenever recent texts didn't deliver, so a silent block can't go
  unnoticed again.
