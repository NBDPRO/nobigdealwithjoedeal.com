# What a homeowner sees after booking (2026-11-27)

The goal is fewer no-shows. This note traces what happens right after each lead form succeeds, splits what cal.com controls from what we control, and records what changed in this PR. Linked from [INDEX](../INDEX.md).

## On the page, per form

| Form | Before | After this PR |
|---|---|---|
| `/inspect` ([inspect-form.js](../../docs/assets/js/inspect-form.js) `showSuccess`) | Green panel. "Contact me" choice: "Joe will reply within 24 hours, usually the same day" plus the phone number. Calendar choice: "Pick your time" plus a **Pick My Time** link to cal.com (Cincinnati or Lexington event via [inspect-region.js](../../docs/assets/js/inspect-region.js), #3187), opened in a new tab. Then the optional "Add details" step. | A **What happens next** list inside the panel: when Joe reaches out (or, for the calendar choice, that Cal.com emails the confirmation with a reschedule link), Joe on the roof himself, 45 minutes to an hour, photos free and no deposit, being home preferred but not required, and the number to change the time. |
| Quick form: homepage short inspect form, town and service pages ([quick-lead-form.js](../../docs/assets/js/quick-lead-form.js)) | One line ("Got it! Reply within 24 hours, usually the same day." on the homepage), then the intake block: a calendar button (and a popup) for the calendar choice, or "Joe will reach out to set a time". | The same list under the message. The visit length shows only where the heading says Inspection (no `data-service`). The intake block's contact line is suppressed (`quietContact`), because the list's first line says it. |
| `/roof-check` result ([roof-check.js](../../docs/assets/js/roof-check.js) `renderResult`) | Joe's take, then **Book my free inspection** (cal.com) and Call. | A one-paragraph visit note under the Book button. |
| `/estimate` | The results step already explains the visit (45 to 60 minutes, attic, being home optional) next to the cal.com link. | Unchanged. |

The GA4 events from #3286 (`form_step_complete`, `form_step_view`, `form_error`, `lead_submit`) are untouched. `tests/lead-form-feedback-2026-10-26.test.js` still passes.

### Add to calendar: not possible on our page today

Every booking happens on cal.com, in a new tab. Our page never learns the time, so there's nothing to put in an .ics file. Cal.com's own confirmation email already carries the calendar invite. To show the booked time on our site, cal.com's event setting **Redirect on booking** would have to send the booker back to a page of ours with the booking details. That's a cal.com setting for Jo, plus a small page; it isn't built.

## Messages after the request

| Message | Who controls it | Gate | Notes |
|---|---|---|---|
| Cal.com booking confirmation email (time, calendar invite, reschedule and cancel links) and any cal.com reminders | **cal.com** (event settings in Jo's cal.com account) | n/a | We can't change its wording from the repo. Bookings themselves get **no** ack from us: `alertPlan` passes `ack:false` for them ([lead-alert.js](../../functions/lead-alert.js)). |
| Lead ack **email** (`ackHomeowner`, `lead_ack_email`) | **us** | `messaging_controls` `leadAckEmail` plus the global email switch; default off. One per inbox per 24 h. | Transactional. Goes only to form leads with an email at create time. On `/inspect` the email is asked only on the "Add details" step, after the lead exists, so most `/inspect` leads never get it. The main audience is the quick form (`contact_leads`). **Reworded in this PR** (below). |
| Lead ack **text** (`ackHomeownerSms`, `lead_ack_text`) | **us** | `LEAD_ACK_SMS_ENABLED` + `leadAckSms` + stored TCPA consent + STOP list + 8am-9pm + send-once. | Only for `estimate_leads` and `inspect_leads`. Its body matches **registered A2P sample #1 word for word** ([TWILIO-A2P-REAPPLY-PACKET](../projects/TWILIO-A2P-REAPPLY-PACKET-2026-10-13.md)). **Not changed.** The proposal for Jo is below. |
| 20-48 h follow-up email ([lead-followup.js](../../functions/lead-followup.js), `lead_followup_email`) | **us** | `LEAD_FOLLOWUP_ENABLED`; commercial (needs the company mailing address). | Not changed. Flags below. |
| Appointment reminder ([push-functions.js](../../functions/push-functions.js) `onAppointmentReminder`) | **us** | n/a | A push to the rep, not the homeowner. |

### Ack email: new wording

The subject stays "Got it — Joe here. What happens next" (`tests/public-intake-hardening-2026-10-15.test.js` pins it). The body is now built from per-form paragraphs (`ACK_NEXT`, `ACK_VISIT`) shared by the HTML and text versions:

- Every form: "This is Joe. Your request came straight to my phone, not a call center. I look at every one myself."
- The reply promise: "I'll call or text you within 24 hours, usually the same day." Inspect leads instead get "If you already picked a time on my calendar, you're set. Cal.com emails your confirmation…"
- The visit (inspect, contact, storm): free, no deposit, Joe on the roof, 45 minutes to an hour, photos free, the $150 written report only if wanted, being home preferred but not required.
- Estimate leads get no visit block, because /estimate also covers siding and gutters. Free Roof entries get only the shared lines; nothing approved says what happens after an entry.

No credentials or sales lines, so it stays transactional under CAN-SPAM (primary-purpose test, 16 CFR 316.3). The Free Roof and storm-signup branches fit the transactional definition less well. The cheap hedge is the follow-up email's `Suppression.applyFooter`, which is a code change for Jo and counsel.

## For Jo (not done)

1. **Ack text.** Today it says "Got your estimate request… I'll call you shortly" to `/inspect` requesters too. The two em dashes also force the slower encoding, so it can bill as 3 segments. Proposed body (plain ASCII, about 154 characters): `{First}, it's Joe with No Big Deal Home Solutions. Got your request. I'll call or text within 24 hrs, usually same day: (859) 420-7382. Reply STOP to opt out.` It would **not** match sample #1 word for word. So: update the sample in the Twilio console first, ask Twilio whether editing a Verified campaign's samples triggers a review, then change the code and its test pins (`sms-optional-consent-brand`, `messaging-automations`, `estimate-step1-save`).
2. **Follow-up email timing.** The follow-up email starts at 20 h (`WINDOW_YOUNGEST_H`), so "we haven't connected yet" can land inside the 24-hour promise. Raising it to 24 is a one-line code change.
3. **Follow-up email after a cal.com booking.** An `/inspect` requester who then books on cal.com gets a separate `leads` doc, so their own card may still read `new`. They could then get the "haven't connected" email. Not traced further.
4. **Storm signup header.** "Got your storm damage report." also goes to `general` storm-alert signups.
5. **Cal.com wording.** The confirmation and reminder emails are set in cal.com. Check that each inspection event's confirmation says how long the visit takes and that being home is preferred, not required.
