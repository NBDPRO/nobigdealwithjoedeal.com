# Automatic STOP / HELP / START replies name the business (2026-10-13)

Row 14 and follow-up 1 of
[TWILIO-A2P-REAPPLY-PACKET-2026-10-13](TWILIO-A2P-REAPPLY-PACKET-2026-10-13.md):
the replies the `incomingSMS` webhook sends back for a keyword said "NBD Pro"
(the CRM product) while the registered campaign sender is the roofing
business, "No Big Deal Home Solutions". Carrier reviewers check that the
HELP and opt-out replies name the brand the consumer opted in to.

Nothing was sent to anyone and nothing was changed in Twilio. The
`incomingSMS` handler was driven with the test world's stubbed Twilio.

## What changed

New `functions/sms-keyword-replies.js` (pure strings plus one brand lookup);
`functions/sms-functions.js` calls it in the STOP, HELP and START branches.
The opt-out mechanics are untouched: the register write, the Do Not Text copy,
the consent stamp and the owner STOP-lift run exactly where they did, and the
brand lookup runs after them, so a failed lookup can never undo a STOP.

| Keyword | Before | After (NBD's line / unknown number) |
|---|---|---|
| STOP | `You've been unsubscribed from NBD Pro SMS. Reply START to resume, HELP for help.` | `No Big Deal Home Solutions: You're unsubscribed and won't get any more texts from this number. Reply START to resubscribe.` (105 chars) |
| HELP | `NBD Pro: Msg & data rates may apply. Reply STOP to unsubscribe. Support: (859) 420-7382.` | `No Big Deal Home Solutions: for help call (859) 420-7382 or email jd@nobigdealwithjoedeal.com. Msg & data rates may apply. Reply STOP to opt out.` (143) |
| START | `Welcome back to NBD Pro SMS. Reply STOP anytime to unsubscribe.` | `No Big Deal Home Solutions: You're subscribed to our texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.` (147) |

All three are one SMS segment, GSM-7 (straight apostrophe, no emoji). These
are the packet's section 5 strings, except START, which the packet drafted as
"...to texts about your request..." (162 characters, two segments). The packet
and runbook were updated to the 147-character version. **Paste that one into
the Twilio campaign** so the registered text equals what the code sends.

A second fix rode along: the old replies put a bare `&` ("Msg & data") inside
the TwiML, which is not well-formed XML. The text is now XML-escaped
(`Msg &amp; data` renders as `&`).

## Which business answers

`resolveBrand` looks at the Twilio `To` of the inbound message:

1. It is the global sender (`TWILIO_PHONE_NUMBER`), or there is no `To`:
   **NBD**. A tenant cannot take over NBD's line by typing it into its own
   profile (tested).
2. Exactly one `companyProfile` names it as `brand.integrations.twilioNumber`:
   **that tenant**: its `brand.name` (else legal / short / company name) and
   its `brand.contact.phone`. A tenant with no name set is "This business",
   never "No Big Deal". A tenant with no phone gets "for help reply to this
   text", never NBD's number.
3. No match, two tenants claiming one number, or a read error: **NBD** (the
   spec'd fallback; a warning is logged for the ambiguous case).

Names are cut at 30 characters on a word boundary so a reply stays one
segment.

`incomingSMS` now lists `TWILIO_PHONE_NUMBER` in its secrets so it can tell
NBD's line from another. That secret already exists (the senders use it).

## Evidence

- `tests/sms-keyword-replies-2026-10-13.test.js`, 68 assertions. Failing-first
  against the old handler: 32 red. Every absence assertion ("NBD Pro" absent,
  "No Big Deal" absent for a tenant) is paired with a presence control, so a
  blanked reply cannot pass.
- Break-tests (module mutated, the suite re-run, the mutation reverted):
  dropping the own-number shortcut reddens only the "tenant types NBD's number"
  pair; removing the XML escape reddens only the two well-formedness checks;
  making a tenant fall back to NBD's brand reddens the tenant STOP / HELP /
  START rows; putting "NBD Pro" back in HELP reddens every HELP row, not STOP
  or START; letting an ambiguous number pick a tenant reddens only the
  two-tenants pair.
- `tests/review-r6-money-texting-2026-10-07.test.js` R6-3-10 ("KNOWN BUG")
  flipped to a fixed assertion. `tests/lib/sms-compliance-world.js` learned
  dotted `where` paths, a `secrets` override and `queryThrows`.

## Mismatches found, not edited

- **Runbook vs packet email.** The runbook's older step-3 text gave
  `info@nobigdealwithjoedeal.com` in the HELP reply; the packet (and now the
  code) use `jd@` (marketing; info@ is for documents). The runbook table is
  updated; the older step-3 block was left as history.
- **`docs/terms.html:466`** lists STOP, END, CANCEL, UNSUBSCRIBE, QUIT; the
  registered and coded list also has STOPALL, OPTOUT, REVOKE (packet row 5
  nit, unchanged). Not edited: the Privacy / Terms rewrite is pending.
- Consent labels (`/inspect`, `/storm-alerts`, `/estimate`, home) say "Reply
  STOP to opt out, HELP for help" and name "No Big Deal Home Solutions": they
  agree with the new replies. "NBD Pro" appears on `/privacy` and `/terms`
  only as the contractor software product (`docs/privacy.html:607-608`, the
  footer door), never about texting.

## Needs Jo

1. In the new campaign, paste the START reply from the table above (147
   characters) in place of the packet's first draft.
2. Twilio's Messaging Service **Advanced Opt-Out** answers STOP / HELP before
   the webhook does (`functions/twilio-line-logic.js`), so the strings
   registered in the campaign are the ones carriers see; this change makes the
   webhook's fallback agree with them. Confirm Advanced Opt-Out's own
   messages in the console say the same thing.
3. Per-tenant branding only matters once a tenant has its own registered
   number (`brand.integrations.twilioNumber`; no UI sets it yet). Until then
   every inbound to the shared line answers as NBD, which is correct: the
   shared number is NBD's registered brand and other tenants' texting fails
   closed.
