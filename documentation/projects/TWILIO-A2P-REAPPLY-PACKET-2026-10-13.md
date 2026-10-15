# Twilio A2P reapply packet — 2026-10-13

Jo asked for a read-only Twilio check, a compliance review of the public
Privacy / Terms / consent pages, and a paste-ready reapply packet ("check in
Twilio ... then we can do 5 and reapply"). This note is all three.

Nothing was submitted, created, updated or deleted in Twilio (GET requests
only, credentials read from Secret Manager into memory, never printed). No
public page was edited. No text or email was sent. Phone numbers appear as
last-4 only, except the business line (859) 420-7382, which is printed on
every public page and is part of the text Jo pastes.

This supersedes the runbook's 2026-10-04 "ready to submit" section where they
differ: the runbook still says the account is a Trial with no brand. That is
no longer true (see below). The runbook is
[TWILIO-A2P-REGISTRATION](../runbooks/TWILIO-A2P-REGISTRATION.md); the
texting-law fixes are in
[TEXTING-COMPLIANCE-2026-10-05](../audit/TEXTING-COMPLIANCE-2026-10-05.md).

> **Update 2026-10-13 (item 12 / "Better, a small page PR" below): fixed on
> branch `fix/estimate-sms-consent-visible` — merged as #2424 (2026-10-13).**
> `/estimate` now shows the first-name and phone fields and the unchecked SMS
> consent box (full disclosure, Privacy Policy · Terms beside it) on step 1,
> on first paint, with no interaction. So `/estimate` can be listed as the
> third URL in the message flow. One sentence in section 5's paste-ready text
> was out of date and is now corrected in section 5 below ("on its first
> screen, next to the first name and mobile number fields"); `/estimate` is
> listed as URL 3 in the message flow.
> Details and evidence:
> [ESTIMATE-SMS-CONSENT-FIRST-PAINT-2026-10-13](ESTIMATE-SMS-CONSENT-FIRST-PAINT-2026-10-13.md).

> **Update 2026-10-13 (row 14 / follow-up 1: code strings now match the
> registered strings).** The automatic STOP / HELP / START replies in
> `functions/sms-functions.js` no longer say "NBD Pro"; they are built by
> `functions/sms-keyword-replies.js` and are exactly the section 5 "Keywords
> and replies" strings below, with brand "No Big Deal Home Solutions" for
> NBD's line and any unknown number. One string changed from the first draft
> of this packet: the opt-in reply is now `No Big Deal Home Solutions: You're
> subscribed to our texts. Msg frequency varies. Msg & data rates may apply.
> Reply HELP for help, STOP to opt out.` (the earlier "...about your
> request..." wording was 162 characters, two segments; this is 147). Paste
> that one. True once the PR is merged and deployed. Details:
> [SMS-KEYWORD-REPLIES-BRAND-2026-10-13](SMS-KEYWORD-REPLIES-BRAND-2026-10-13.md).

> **Update 2026-10-15: rejected twice now, same reason.** Twilio has
> rejected the campaign **two times** with "rejected due to issues verifying
> the Call to Action (CTA) provided for the campaign", error **30909**, field
> **MESSAGE_FLOW** (the 2026-10-06 submission described in section 3, and
> the resubmission after it). The most likely remaining cause: the
> **registered brand is "No Big Deal Solutions LLC"**, but the consent boxes
> and every page footer said only "No Big Deal Home Solutions"; the LLC
> appeared only on `/terms`. A reviewer matching the brand to the opt-in
> could not find it beside any checkbox. Fixed on branch
> `fix/sms-cta-brand-2026-10-15`:
> every consent box now reads "text messages and calls from No Big Deal Home
> Solutions (No Big Deal Solutions LLC) ... about [the form's own topic],
> including [message types]" (stored wording versions v3 in
> `functions/tcpa-consent.js`); every public footer says "No Big Deal Home
> Solutions is a d/b/a of No Big Deal Solutions LLC." and links the new
> **https://nobigdealwithjoedeal.com/sms-program** page, which shows a
> phone-width screenshot of each of the three opt-in forms with its exact
> consent wording. Section 5's message flow and campaign description below
> are rewritten to match: they name the LLC and the d/b/a, point the reviewer
> to `/sms-program` as the screenshot proof page, quote the new wording, and
> no longer say customers can text us first. Resubmit only after that PR is
> merged and the hosting deploy is green (the reviewer reads the live pages).

## 1. The one-paragraph answer

The brand is **approved**, the account is **already upgraded to Full**, and
the one campaign was **rejected (FAILED) with Twilio error 30909: "issues
verifying the Call to Action (CTA)", field MESSAGE_FLOW.** So the ordering
trap in the runbook has already sprung: the account is Full while no campaign
is approved, which means every text the CRM sends is accepted by Twilio and
then blocked by the carrier (30034). Today that only hits Jo's own lead
alerts to the business line (email and push cover those, #2307), and it will
silently eat any customer text sent from the CRM until a campaign is
approved. To fix it: change the pages as listed in section 4, then create a
new campaign with the section 5 fields.

## 2. Twilio status (read-only check, 2026-10-13)

| Item | Status | Detail |
|---|---|---|
| Account type | **Full**, active | Was Trial on 2026-10-02. The last trial error (21608) was 2026-10-04, so the upgrade landed between 10-04 and 10-06 |
| CRM sender | one local number ending **4855** | SMS, voice and MMS capable. Not toll-free. Inbound webhook is set |
| Verified caller ID | ending 7382 | The business line |
| Customer Profile (Trust Hub) | **twilio-approved** | Created 2026-10-06, friendly name "No Big Deal Solutions LLC" |
| Trust Products | 2, both **twilio-approved** | Created 2026-10-06 |
| A2P Brand | **APPROVED**, type **STANDARD**, identity VERIFIED | Created 2026-10-06 02:18Z, approved 05:54Z. No failure reason. (The runbook recommended Low-Volume Standard; Jo registered Standard. It is approved, so nothing to redo) |
| Messaging Service | 1: "Low Volume Mixed A2P Messaging Service" | Created 2026-10-06 06:11Z. Sender pool: the 4855 number |
| A2P Campaign | **FAILED** | Use case LOW_VOLUME. `campaign_id` null (never issued). See section 3 |
| Toll-free verification | none | Not used |
| Inbound texts, last 45 days | 0 | |
| Outbound texts, last 45 days | **33 sent, 0 delivered** | 28 undelivered (30034), 5 failed (21608) |

Outbound breakdown (33 messages, 2026-09-04 through 2026-10-13):

| Status / error | Count | To | Dates |
|---|---|---|---|
| undelivered, **30034** (sender not registered to an approved campaign) | 28 | all to the business line ending 7382 (Jo's lead alerts) | Sep 4 (5), 17 (2), 21, 22, 24, 30 (5); Oct 1, 2, 4, 5 (3), 7 (2), 9 (2), 12 (2), 13 |
| failed, **21608** (Trial account, unverified recipient) | 5 | all to one number ending 0142 | Sep 6 (3), Sep 28, Oct 4 |

Reading it: every 30034 since the upgrade (Oct 4 onward, 11 texts, the last
one today) is the ordering trap in the wild. No customer has been texted from
the CRM in this window (only two numbers appear), so no customer text has
been lost yet. The 5 x 21608 are all before the upgrade.

## 3. Why the campaign was rejected

**Twilio's own text** (campaign `errors`, nothing else is returned):

> The campaign submission has been reviewed and rejected due to issues
> verifying the Call to Action (CTA) provided for the campaign.
> error_code **30909**, fields: **MESSAGE_FLOW**

The Twilio API does not return a rejection date; the campaign record's
`date_created` and `date_updated` are both 2026-10-06 06:11:13Z. The repo's
history says Twilio's first rejection was "Terms and Conditions issues" and
Twilio error 30564 on 2026-10-06 (commit e7e3d9a1, PR #2238). The campaign on
file is the 30909 one.

What the reviewer saw at submission time versus now (this is inference from
the record; Twilio does not say which of these tripped 30909):

1. **The Terms link did not exist yet.** The campaign was created at 06:11Z
   on 10-06. The `/terms` page and the "Privacy Policy · Terms" consent links
   merged at 11:08Z the same day (#2238). The submitted message flow cites
   `/terms` and a consent label with a Terms link, which the reviewer could
   not have found when they looked.
2. **The `/estimate` opt-in is not visible.** The submitted message flow
   lists `/inspect` and `/estimate`. On `/estimate` the consent box is on
   step 5 of a 5-step wizard (`docs/estimate.html:894`); a reviewer who opens
   the URL sees "What's Your Address?" and no consent or phone field. The
   reviewer can't verify the CTA there.
3. **Verbal / in-person opt-in.** The submitted flow said "Homeowners met in
   person give verbal consent, which the rep records in our CRM". Reviewers
   cannot verify that, and it is the kind of claim that fails CTA checks.
4. **The registered HELP and opt-out replies don't name the brand.** HELP is
   "Reply STOP to unsubscribe. Msg&Data Rates May Apply." and the opt-out
   reply has no brand. Twilio recommends the brand in both. This is not what
   30909 names, but it is cheap to fix on the new submission.
5. **The sample messages were made up**, not the real templates (the
   runbook's own 2026-10-04 section says to use real ones). Example: sample
   2 and 4 link to `/deal/abc123` and `/pay/xyz`.

Treat 1 and 2 as the likely cause and fix all five.

A failed campaign can't be edited into approval; it is resubmitted as a new
campaign (and the $15 campaign vetting fee is charged again). Confirm the
exact fee on the Twilio screen before Jo submits.

## 4. What must be true on the public pages BEFORE resubmitting

Checked against `origin/main` at 8cf8b10a (2026-10-13 15:13Z). The live site
(nobigdealwithjoedeal.com) serves the same wording: `/terms` 200, program
name present, the mobile-information sentence present on `/privacy`, and the
new consent label on `/estimate`.

| # | Requirement | Result | Where |
|---|---|---|---|
| 1 | Program name | **PASS** | `docs/terms.html:442-444` ("No Big Deal Home Solutions text messages", sent by No Big Deal Solutions LLC, DBA No Big Deal Home Solutions) |
| 2 | Program description (what the texts are about) | **PASS** | `docs/terms.html:445-455`; `docs/privacy.html:614` |
| 3 | Message frequency | **PASS** | `docs/terms.html:459-460` ("varies", storm alerts 2-4 per season); `docs/privacy.html:627`; every consent label ("Message frequency varies") |
| 4 | "Msg & data rates may apply" | **PASS** | `docs/terms.html:462-463`; `docs/privacy.html:628`; `docs/inspect.html:454` |
| 5 | STOP language | **PASS** (one nit) | `docs/terms.html:466`; `docs/privacy.html:629`. Nit: terms lists STOP/END/CANCEL/UNSUBSCRIBE/QUIT, the registered list also has STOPALL/OPTOUT/REVOKE. Harmless, but make the page and the form match |
| 6 | HELP language + contact | **PASS** | `docs/terms.html:467` (phone and jd@ email); `docs/privacy.html:629` |
| 7 | No sharing of mobile info with third parties/affiliates for marketing | **PASS** | `docs/privacy.html:622` and `docs/terms.html:473-475`, both with the "opt-in data and consent will not be shared" sentence. Note the privacy page also says xAI bots read customer names and addresses but never phone numbers (`docs/privacy.html:600`), so the sentence stays true; keep it that way |
| 8 | Business contact info on Terms/Privacy | **PASS** | `docs/terms.html:504-510` (legal name, phone, email, service area). No street address; TCR does not require one on the page |
| 9 | Consent is not a condition of purchase | **PASS** | `docs/terms.html:456-457` (bold), `docs/privacy.html:630`, every consent label |
| 10 | Carrier liability / delivery | **PASS** | `docs/terms.html:471`, `docs/privacy.html:630` |
| 11 | Consent checkbox links to BOTH Privacy and Terms, beside the box | **PASS** | `docs/inspect.html:454`, `docs/estimate.html:894`, `docs/index.html:1051` (and storm-check, roof-score, storm-report, storm-alerts, `docs/assets/js/quick-lead-form.js`): `Privacy Policy · Terms` to `/privacy#sms-terms` and `/terms`; box unchecked and required |
| 12 | The reviewer can SEE the opt-in on every URL named in the message flow | **FAIL for `/estimate`; PASS for `/inspect` and `/storm-alerts`** | `/estimate`: consent box on step 5 of 5 behind an address and satellite-confirm step (`docs/estimate.html:629-894`). `/inspect` shows name, address, mobile phone and consent in one form (`docs/inspect.html:427-454`). `/storm-alerts` has the phone field and consent in one form (`docs/storm-alerts.html:454-471`) |
| 13 | Opt-in proof: what is recorded | **PASS** | `tcpaConsent: true`, `tcpaConsentAt`, `tcpaConsentText` (the exact wording's version id) and `tcpaConsentSource` (page path) are written per lead (`functions/tcpa-consent.js:132-205`, `docs/assets/js/inspect-form.js:309`). Wording versions v2 are the live ones |
| 14 | Automatic STOP/HELP/START replies name the brand | **FAIL** (fixed on `fix/sms-stop-help-brand-name`, see the update at the top) | `functions/sms-functions.js:1596,1605,1636` still say "NBD Pro". The Messaging Service's Advanced Opt-Out answers STOP/HELP first (`functions/twilio-line-logic.js:23-24`), so the registered strings are the ones that matter. Fix them in the Twilio campaign fields (section 5) and rename the code strings in a follow-up |
| 15 | Privacy page does not contradict the checkbox flow | **PASS** (fixed 2026-10-15, `fix/sms-consent-wording-2026-10-15`) | The TCPA notice in `docs/privacy.html` section 5 used to say that by providing a phone number and submitting an estimate request "you consent to receive" texts and calls, which reads as consent-by-submission. It now says texts go only to customers who check the SMS consent box. `/terms` already said opt-in is by checking the box |
| 16 | Terms page "Last updated" | **PASS** | `docs/terms.html:428` ("October 6, 2026") |

**So the page work before reapplying is one item (12), plus the optional
nits in 5, 14 and 15.** Choose one:

- **Easiest, no page change:** do not list `/estimate` in the new message
  flow. Use `/inspect` and `/storm-alerts` only (section 5 does this). The
  /estimate form still collects consent; it just isn't offered to the
  reviewer as proof.
- **Better, a small page PR:** put a short consent notice or a visible
  "text-message terms" line on `/estimate` step 1, so the reviewer sees it
  without finishing the wizard. If this is done, `/estimate` can come back
  into the message flow.

### What is NOT landed (Grok's Privacy / Terms rewrite)

Jo said Privacy and Terms are being rewritten with Grok. **Nothing from that
rewrite is on `origin/main`, and no open PR touches `docs/privacy.html` or
`docs/terms.html`.** Last change to each: 2026-10-07 (`3bd3cde2`, an
unrelated Our Work fix). The open PRs on 2026-10-13 are dependabot bumps,
#2414, #2410 and #2316; none is legal text. The branches named
`feat/homeowner-terms-page` and friends are the already-merged #2237/#2238
work, not a new rewrite.

So the pages above are the *current* ones, and they already pass. Any
Grok-written version is **unverified** until each row in the table is
re-checked against it. In particular, a rewrite must keep:

- the "No mobile information will be shared with third parties or
  affiliates ..." sentence verbatim in `/privacy` (Twilio looks for this),
- the "Program name", frequency, rates, STOP, HELP and "not a condition of
  purchase" items on `/terms`,
- the `#sms-terms` anchor on `/privacy` and the `/terms` URL (the consent
  labels and pinned tests link to them).

Do not resubmit against a rewrite that hasn't been merged and deployed: the
reviewer reads the live pages.

### Kentucky / Ohio cautions

The 2026-10-05 texting audit has **no Kentucky- or Ohio-specific texting
rules** in it. What it does model is quiet hours 8am-9pm in the homeowner's
time zone (FL/OK/MD/WA end at 8pm), the STOP and Do Not Text list, door-knock
consent, and the per-company switch. Open items from it that touch the
campaign:

- The auto STOP/HELP replies still say "NBD Pro" (row 14).
- Texas's Sunday-noon rule is not modelled (not a NBD market).
- Nothing in the repo records Kentucky's or Ohio's own telephone-solicitation
  hours or registration rules. That is a gap, not a clearance: the
  `nbd-compliance-reference` agent has those as unfilled slots. Ask counsel
  before any marketing-style sequence goes out; the transactional and
  opted-in texts in this campaign are the low-risk class.
- **Kentucky insurance jobs** (`KY-CLAIM-WORDING-2026-09-27`): sample
  messages must not say "we handle/negotiate your claim", offer advance
  payment, or promise a deductible outcome. All three samples in section 5
  stay inside that. Do not let a reviewer-friendly rewrite add "we'll help
  with your insurance claim".

## 5. Paste-ready campaign fields

Create a **new** A2P campaign on the existing approved brand and the existing
Messaging Service ("Low Volume Mixed A2P Messaging Service", sender 4855).
Brand is already approved, so there is no brand step.

**Use case:** Low Volume Mixed (same as before, so the sender and fees match
what's already set up).

**Campaign description:**

```
No Big Deal Solutions LLC, doing business as No Big Deal Home Solutions, is a roofing, siding and gutter contractor serving the Greater Cincinnati, Ohio and Northern Kentucky area. We text homeowners who asked us to: a confirmation that we got their inspection or estimate request, appointment confirmations and reminders, updates about their estimate and project, and invoice and payment notices. Homeowners who sign up on our Storm Alerts page get a text when hail or severe weather is reported near their zip code, usually 2-4 per season. We only text people who checked an unchecked consent box on one of our website forms (shown at https://nobigdealwithjoedeal.com/sms-program). Customers can reply STOP to opt out or HELP for help at any time.
```

(2026-10-15: the "We also send new-lead notices to the business owner's own
phone." sentence is removed, together with the old sample that was that
internal alert. The sample list is now three: lead acknowledgement, storm
alert, START reply. Later on 2026-10-15, after the second 30909: the
description opens with the registered LLC and its d/b/a, and "or who texted
us first" is gone, so the only opt-in it describes is the website box.)

**Message flow / call to action** (this is the field Twilio rejected, so it
is written to be verifiable by someone who only opens the URLs):

```
Opt-in happens only on our website, nobigdealwithjoedeal.com, run by No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions (the registered brand). The customer checks an SMS consent checkbox that is never pre-checked; only people who check it get texts. Proof page with a screenshot of each form's consent box and its exact wording: https://nobigdealwithjoedeal.com/sms-program

1) Free inspection request: https://nobigdealwithjoedeal.com/inspect (name, address, mobile phone, consent checkbox, "Request Free Inspection" button). Checkbox optional.
2) Estimate request: https://nobigdealwithjoedeal.com/estimate (first name, phone and the consent checkbox on the first screen, "Continue" button). Checkbox optional.
3) Storm Alerts signup: https://nobigdealwithjoedeal.com/storm-alerts (first name, phone, ZIP, concern, consent checkbox marked "(required)", "Sign Me Up" button). Checkbox required; the form cannot be sent without it.

Exact wording on /inspect: "I agree to receive text messages and calls from No Big Deal Home Solutions (No Big Deal Solutions LLC) at the number above about my inspection request, including appointment confirmations and reminders, estimate and project updates, and replies to my questions. Message frequency varies. Message & data rates may apply. Reply STOP to opt out, HELP for help. Consent is not a condition of purchase. Privacy Policy · Terms". /estimate is identical except "about my estimate request". /storm-alerts says "about severe weather near my ZIP code (storm alerts, usually 2–4 per season) and related follow-up, such as inspection scheduling and replies to my questions", then the same disclosures. "Privacy Policy" links to https://nobigdealwithjoedeal.com/privacy#sms-terms and "Terms" to https://nobigdealwithjoedeal.com/terms.

If the box is left unchecked, we send no automatic texts. For each consent we store the time, the exact wording shown and the page.
```

2026-10-15, after the second 30909 rejection (`fix/sms-cta-brand-2026-10-15`):
the flow now opens with the registered brand, **No Big Deal Solutions LLC
d/b/a No Big Deal Home Solutions**; it sends the reviewer to
`https://nobigdealwithjoedeal.com/sms-program`, which shows a 390px
screenshot of each form's phone field, consent box and submit button
with the exact wording under it; it quotes the NEW v3 consent wording
(LLC named, message types listed); and the old closing sentence
"Customers can also text us first at (859) 420-7382; we reply only about
their message." is **removed**, so the only opt-in described is the
website checkbox. The flow is 1923 characters (limit 2048).

Changed from the rejected version, on purpose: the in-person
verbal-consent line is gone, and `/estimate` is listed as a proof URL now
that its consent box is on the first screen (#2424). 2026-10-15: the three
URLs are numbered in one list, the /estimate wording is quoted and the
/storm-alerts field list matches the page. Later on 2026-10-15
(`fix/sms-optin-and-brand-2026-10-15`): the box is **optional** on
`/inspect` and `/estimate` (and on the homepage form, the on-page quick
form, `/storm-check`, `/roof-score` and `/storm-report`), so a reviewer
who tries the form without ticking it can still send it, which is what
`/terms` has always said ("you can still request an inspection or estimate
without it"). Those two boxes no longer carry the "(required)" marker or
`aria-required`; `/storm-alerts` keeps both. The server saves a lead
without consent (`tcpaConsent: false`) and alerts Joe, and no automatic text
goes to that homeowner (see "Who gets an automatic text" below).

**Privacy policy URL:** `https://nobigdealwithjoedeal.com/privacy`
**Terms and conditions URL:** `https://nobigdealwithjoedeal.com/terms`
(Not `/privacy#sms-terms`. The earlier submission used the anchor and was
rejected for Terms; `/terms` exists now.)

**Sample messages.** Paste these three. Each is the real customer-facing
text exactly as the code produces it (source in brackets); `{braces}` mark
the variable parts. Every one names **No Big Deal Home Solutions** in full.

1. Lead acknowledgement, sent once to a homeowner who ticked the box (`functions/lead-alert.js` `ackHomeownerSms`; with no first name on file it starts "Got your estimate request."):
```
{first_name} — got your estimate request. This is Joe with No Big Deal Home Solutions — I'll call you shortly. Urgent? Call/text me at (859) 420-7382. Reply STOP to opt out.
```
2. Storm alert to Storm Alerts subscribers (`functions/storm-watch.js:273`; `{event}` is like `1.25" hail`, `{city}` is the reported place):
```
No Big Deal Home Solutions Storm Alert: {event} reported near {city}. If your roof took it, Joe documents damage free before you call insurance: nobigdealwithjoedeal.com/storm-check or call/text (859) 420-7382. Reply STOP to opt out.
```
3. Opt-in confirmation, sent when a customer texts START (`functions/sms-keyword-replies.js` `startReply`, NBD brand):
```
No Big Deal Home Solutions: You're subscribed to our texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.
```

All three match the code word for word once `fix/sms-optin-and-brand-2026-10-15`
is merged and its functions deploy has run (merging to `main` deploys
functions automatically, `.github/workflows/firebase-deploy.yml`; check that
run is green before submitting). `tests/sms-optional-consent-brand-2026-10-15.test.js`
pins samples 1 and 3 and the storm template.

**Other customer texts, renamed but not pasted.** The NWS-warning storm text
(`functions/sms-functions.js` `runCheckStormAlerts`, to the same
subscribers) now starts "⛈️ No Big Deal Home Solutions Storm Alert:". The six
door-knock templates (`D2D_SMS_TEMPLATES`, `NBD_D2D_COMPANY`, and the CRM
tracker's `_d2dCompany` in `docs/pro/js/d2d-tracker-core-2026b.js`) say
"from No Big Deal Home Solutions". They are not pasted as samples because they
go only to a number whose door-knock record carries the rep's note that the
homeowner agreed to texts (`knockHasConsent`), a consent path the web-only
message flow does not describe. The AI first-touch opener now reads "this is
Joe's assistant with No Big Deal Home Solutions"; AI replies are drafts a
person approves.

**Who gets an automatic text** (what the message flow promises, as the code
enforces it):

| Automatic homeowner text | Gate on consent |
|---|---|
| Lead acknowledgement (`lead-alert.js` `ackHomeownerSms`) | Only when the lead carries `tcpaConsent === true` (`tcpa-consent.js` `smsAckGate`), plus `LEAD_ACK_SMS_ENABLED`, STOP / Do Not Text, the texting switch and quiet hours. `false` or absent: no text, logged `no_stored_consent` |
| Storm alerts (`storm-watch.js`, `sms-functions.js` `runCheckStormAlerts`) | Only subscribers whose signup stored `tcpaConsent === true` (`storm-sms-guard.js`); /storm-alerts requires the box |
| Approved AI reply (`sms-functions.js` `onAiDraftApproved`) | `sms-consent-declined.js`: a `tcpaConsent: false` number is refused unless it texted us in the last 7 days |
| CRM sends labelled as campaigns (review ask, referral code, win-back, estimate follow-up, lead_ack, sequence) | `sms-consent-declined.js` `AUTOMATED_SOURCES`: refused for a declined number, no inbound exemption |
| Door-knock texts | Only with the knock's own explicit yes (`knockHasConsent`) |

Joe's own new-lead alert (text, email, push) still fires for every lead,
with or without consent; it goes to the business, not the homeowner.

Before pasting, re-read each against the code line named in brackets.

**Checkboxes:** Embedded links **Yes**. Embedded phone numbers **Yes**.
Age-gated content **No**. Direct lending or loan arrangement **No**.

**Keywords and replies** (include the brand in HELP and opt-out; the
registered strings are what the carrier sees):

| Field | Enter |
|---|---|
| Opt-out keywords | `STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, OPTOUT, REVOKE` |
| Opt-out reply | `No Big Deal Home Solutions: You're unsubscribed and won't get any more texts from this number. Reply START to resubscribe.` |
| Help keywords | `HELP, INFO` |
| Help reply | `No Big Deal Home Solutions: for help call (859) 420-7382 or email jd@nobigdealwithjoedeal.com. Msg & data rates may apply. Reply STOP to opt out.` |
| Opt-in keywords | `START, UNSTOP` |
| Opt-in reply | `No Big Deal Home Solutions: You're subscribed to our texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.` |

(jd@ is the marketing address and the one the Terms page shows; info@ is for
documents. Don't mix them.)

## 6. The ordering trap, and what it means now

The memory and runbook rule was: do not upgrade the trial before the
campaign is approved, because a Full account accepts the text and the carrier
silently blocks it (30034), and the trial's immediate 21608 error was what
triggered the Messages-app fallback.

**That trap is already live.** The account is Full; the campaign is FAILED.
Do not "undo" it (there's no downgrade to make; the brand and profile are
approved and valuable). Instead:

- **Keep texting customers from Jo's own phone** until the new campaign
  shows **Approved**. The Messages-app fallback in `nbd-comms.js` does not
  fire on a Full account, so a text sent from the CRM to a customer will
  look sent and not arrive. The callWatch bell ("texts are not delivering")
  and the alert-health banner still catch it.
- Do not switch on the automatic customer texts (lead acknowledgement,
  storm, anniversary) until a CRM test text to Jo's own phone shows
  **Delivered** in Twilio, not just "sent".
- Lead alerts to the business line keep failing until approval. Email and
  push carry them (#2307), so nothing is lost.

## 7. What Jo must click himself

Claude can't and must not do any of these; every one is in the Twilio
console.

1. Decide on item 12 (leave `/estimate` out of the flow, or ask for the small
   page PR first). If the page PR is chosen, wait for it to deploy before
   step 3.
2. Open Twilio, **Messaging > Regulatory Compliance** (or **Trust Hub >
   Registrations > A2P Campaigns**). Look at the existing FAILED campaign's
   rejection text once and confirm it matches section 3 (the API gave only
   30909 on MESSAGE_FLOW).
3. **Create a new A2P campaign**: same brand, same Messaging Service, use
   case Low Volume Mixed, paste the section 5 fields. Check the fee on the
   screen before confirming.
4. Make sure the sender ending 4855 is in the service's sender pool (it is
   today) and the campaign is attached.
5. Wait. Brand approval was hours; campaigns are usually 1 to 3 weeks.
6. When it shows Approved: send one test text from the CRM to Jo's own
   phone, confirm **Delivered** in Monitor > Logs > Messaging, then tell
   Claude so the automatic texts can be switched on and the stale rows in
   the runbook can be closed out.

## 8. Follow-ups (not done in this PR)

- Rename the "NBD Pro" STOP/HELP/START strings in
  `functions/sms-functions.js:1596,1605,1636` (or confirm Advanced Opt-Out
  makes them unreachable on NBD's line).
- Visible consent notice on `/estimate` step 1 (row 12), optional.
- Stale comment in `functions/tcpa-consent.js` says `/inspect` has no
  checkbox; it has had one since #2225.
- Correct the runbook's 2026-10-04 "ready to submit" section in place once
  the new campaign is submitted (its brand type, terms URL and message flow
  are all superseded by this note).
- **Storm alerts need a confirm-YES (double opt-in) step before
  `STORM_TEXT_ENABLED` goes on** (2026-10-15, public intake hardening PR).
  `/storm-alerts` accepts any typed phone number, so a stranger can sign
  someone else up. The subscriber must reply YES to a confirmation text
  before the first storm alert. Separate design; code comments mark the gate
  in `functions/storm-watch.js` and `functions/sms-functions.js`.
- Counsel question: Kentucky and Ohio telephone-solicitation hours and
  registration, for any marketing-style sequence.
- (2026-10-15) Done in `fix/sms-optin-and-brand-2026-10-15`: the
  customer-facing SMS strings that said only "NBD" now say "No Big Deal Home
  Solutions" (`storm-watch.js`, the `sms-functions.js` storm cron, the
  door-knock templates and `NBD_D2D_COMPANY`, the CRM tracker's
  `_d2dCompany`, the AI first-touch opener in `handlers/ai-texting.js` and
  `handlers/ai-persona.js`), and the SMS box is optional on `/inspect` and
  `/estimate`, so the forms now match `/terms`. Left alone: the
  anniversary script in `functions/anniversary-touch.js` is a suggested
  script in a rep email (the rep sends it by hand, for any tenant), not an
  automatic text.
