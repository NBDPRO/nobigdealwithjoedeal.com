# Twilio line → CRM: go-live (2026-10-06)

NBD's Twilio number **(937) 764-4855** now has CRM endpoints for inbound
texts, delivery receipts and inbound calls. They shipped **DARK**: until the
switch below is flipped, every endpoint answers fixed TwiML and reads or
writes nothing. Code: `functions/twilio-line.js` (I/O) and
`functions/twilio-line-logic.js` (pure rules). Tests:
`tests/twilio-line-2026-10-06.test.js`. Related:
[TWILIO-A2P-REGISTRATION](TWILIO-A2P-REGISTRATION.md) (the A2P campaign,
submitted 2026-10-06, must be approved first).

## Endpoints

| URL (HTTP POST) | Function | What it does when live |
|---|---|---|
| `https://nobigdealwithjoedeal.com/api/twilio/sms` | `twilioSmsWebhook` | Matches the sender to an NBD lead by `phoneDigits`, writes an `sms_log` row (direction inbound, leadId + uid + date), a timeline note and a bell. Unknown number: an Agent inbox item "Text from an unknown number" (last 4 digits only) plus an `unmatched_sms` row (Admin → Inbound texts, where it can become a customer). STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT / REVOKE / OPTOUT go into `sms_opt_outs` (canonical key) and flag the lead; START / UNSTOP clears both key shapes; HELP is logged only. Always returns an empty `<Response/>`. |
| `https://nobigdealwithjoedeal.com/api/twilio/sms-status` | `twilioSmsStatus` | On delivered / failed / undelivered, stamps `deliveryStatus` on the outbound `sms_log` row with that MessageSid. The first final answer wins. |
| `https://nobigdealwithjoedeal.com/api/twilio/voice` | `twilioVoiceWebhook` | Forwards the call to `TWILIO_VOICE_FORWARD_TO` (Jo's cell). Caller ID = the **caller's own number** (Jo's decision, 2026-10-06), falling back to the Twilio number when the caller is missing, anonymous/restricted or not a valid US number. 25 s ring. No recording, no AI. |
| `https://nobigdealwithjoedeal.com/api/twilio/voice-status` | `twilioVoiceDialStatus` | The `<Dial>` action (Twilio calls it by itself; nothing to configure). Logs "answered (duration)" or "missed" on the matching lead, plus a bell for a missed call; an unknown missed caller becomes an Agent inbox item (last 4 only). |

Every live request must carry a valid `X-Twilio-Signature` made with the
`TWILIO_AUTH_TOKEN` secret. Missing or stub secret: SMS and status answer 503
(the voice line plays the "please call" message). Bad signature: 403. Nothing
on this line sends a text, calls Twilio's API, or makes an AI draft.

**Dark behaviour** (`TWILIO_INBOUND_ENABLED` anything but `true`): texts and
status callbacks get 200 + empty TwiML, and nothing is recorded. A call hears
"Thanks for calling No Big Deal Home Solutions. Please call 8 5 9, 4 2 0,
7 3 8 2" and is hung up on. It is not forwarded.

## Go-live steps (Jo approves each; Claude can do the console clicks)

1. **Wait for A2P approval.** In Twilio Console → Messaging → Regulatory
   Compliance → Campaigns, the campaign shows Verified and (937) 764-4855 is in
   its Messaging Service sender pool.
2. **Check the secret.** `TWILIO_AUTH_TOKEN` in Secret Manager must be the
   account's current primary Auth Token (Console → Account → API keys &
   tokens). Upgrading from trial does not change it. If it was rotated, Jo
   runs `firebase functions:secrets:set TWILIO_AUTH_TOKEN` himself. Never
   paste the token into chat. The next functions deploy picks up the new
   version.
3. **Flip the switch.** A one-line PR that sets
   `TWILIO_INBOUND_ENABLED=true` in `functions/.env.nobigdeal-pro`. A push to
   main deploys it. Live check: `curl -s -o /dev/null -w "%{http_code}" -X POST
   https://nobigdealwithjoedeal.com/api/twilio/sms`. Before the flip this
   prints **200**; after the flip it prints **403**, because an unsigned
   request is refused.
4. **Point the number at the CRM.** Do this after step 3, or texts are lost
   while the line is dark.
   - Messaging Service (the one holding the number) → **Integration** →
     Incoming messages → "Send a webhook" → Request URL
     `https://nobigdealwithjoedeal.com/api/twilio/sms` (HTTP POST). Delivery
     Status Callback: `https://nobigdealwithjoedeal.com/api/twilio/sms-status`.
     Leave Advanced Opt-Out ON. It sends the STOP/HELP replies, and the CRM
     only records them.
   - Phone Numbers → Active numbers → (937) 764-4855 → **Voice
     Configuration** → "A call comes in" → Webhook
     `https://nobigdealwithjoedeal.com/api/twilio/voice` (HTTP POST). Leave the
     fallback and the call-status URL blank.
   - Replace the `demo.twilio.com` URLs. Do **not** use the old `incomingSMS`
     function URL (see the notes below).
5. **Test with Jo's phone.**
   - Text the number from a phone that is on a customer card. A note shows on
     the timeline and the bell rings.
   - Text STOP from a test phone. Twilio replies, and `sms_opt_outs` gets a
     10-digit doc. Then text START to clear it.
   - Call the number. Jo's cell rings and shows the CALLING phone's number (a withheld number shows (937) 764-4855). Decline the
     call: a "Missed call" note lands on the card.

**Rollback:** set `TWILIO_INBOUND_ENABLED=false` (PR + deploy), or point the
webhooks back. Both work without the other.

## Known limits (decide later; none of these block go-live)

- **Caller ID.** Forwarded calls show the caller's own number (Jo, 2026-10-06),
  so Jo can't tell from the screen alone that a call came in on the NBD line.
  A withheld/anonymous caller shows the Twilio number. Unknown missed callers
  also get an inbox item (last 4 digits only).
- **Voicemail counts as answered.** If Jo's cell sends the call to voicemail,
  Twilio reports the call as completed, so the note says answered.
- **Delivery receipts.** The CRM's send paths send with `from` = the number,
  not through the Messaging Service, and don't set a per-message
  `statusCallback`. So the service-level Delivery Status Callback may not
  fire for them. The endpoint is ready; wiring `statusCallback` into the
  send paths is a separate change, because it touches the send code.
- **`incomingSMS`** (`functions/sms-functions.js`) is still deployed, but no
  number points at it. It answers STOP/HELP/START with its own `<Message>`
  replies, which would double-reply next to Advanced Opt-Out. It also
  generates AI drafts. Keep it off the number; retiring it is a separate
  change.
- **Tenant.** The line matches NBD's leads only (`NBD_OWNER_UID`). A text
  from a number that only another tenant holds is filed as unknown.
- There was no separate Do-Not-Call list in the code. `sms_opt_outs`
  (`functions/sms-optout.js`) is the opt-out register every send path
  checks, and this line writes to it.
