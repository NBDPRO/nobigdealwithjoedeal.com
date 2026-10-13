# /estimate — SMS consent on first paint (2026-10-13)

Twilio rejected the A2P campaign with 30909 (reviewer could not verify the
call to action). Finding 2 of
[TWILIO-A2P-REAPPLY-PACKET-2026-10-13](TWILIO-A2P-REAPPLY-PACKET-2026-10-13.md):
`/estimate` hid the phone field and consent box on step 5 of a 5-step wizard,
so a reviewer who opened the URL saw only an address box. Jo approved fixing
the page so `/estimate` can be listed in the registered opt-in flow.

## What a reviewer sees now (no clicks)

Step 1 of `/estimate` holds, under the address field: **First name**,
**Phone number**, and the **unchecked** consent checkbox with the standard
sentence — "I agree to receive my estimate and follow-up communication from
No Big Deal Home Solutions by call or text at the number above. Message
frequency varies. Message & data rates may apply. Reply STOP to opt out,
HELP for help. Consent is not a condition of purchase. Privacy Policy ·
Terms" — with both links beside the box. Wording is byte-for-byte the
existing label (pinned by `tests/sms-consent-a2p-2026-10-05.test.js`); no
Privacy/Terms page and no registered-campaign text was touched.

At 390x844 the phone field is inside the first screen and the checkbox sits a
short scroll below it; 320 px also has no sideways scroll.

## What changed

- `docs/estimate.html` — first name, phone (+ the dormant OTP row) and the
  consent box moved from `#step5` into `#step1`, same ids. Step 5 keeps last
  name, email (both optional), a recap line ("Sending to Pat at (513)
  555-0100.") and Submit. Step counters unchanged ("of 5", five dots).
- `docs/assets/js/inline/4053149b2f.js` — `validateStep(1)` now also requires
  first name, a 10-digit phone and the ticked box (it only READS the box; it
  never sets it). No map lookup starts while the contact fields are wrong.
  Error marks clear as the visitor fixes them. `submitAndGetEstimate`,
  `skipOtpAndRequestCall` and the `tcpaConsent` payload field are untouched —
  one consent path, the server stamps `tcpaConsentAt/Text/Source` as before.
- Cache-busters: loader `?v=2` on the page tag, wizard `?v=2` inside the
  loader.

## Behaviour change to know about

The phone number is now asked for **before** the ballpark, not after it, and
Continue on step 1 requires the consent box (Submit already required it).
That is the price of a visible opt-in on the URL the reviewer opens. If the
funnel's conversion drops, the alternative is a read-only consent notice on
step 1 with the real box kept on step 5 — which would not show a phone field
on first paint, so it would not satisfy the reviewer.

## Tests

- `tests/estimate-sms-consent-first-paint-2026-10-13.test.js` (new, in the
  `node` bucket of `tests/ci-manifest.json`) — where the box sits: in `#step1`,
  step 1 is the active step, no hidden ancestor, unchecked, wizard never sets
  it true, disclosure + both links, phone before the label, ids unique, step 5
  holds no second copy, counters honest.
- `tests/estimate-funnel-unblock-2026-10-03.test.js` section 2b — Continue
  refused without consent / first name / full phone (and "use as typed"), box
  never ticked for the visitor, step 5 recap, values survive Back/Next,
  Submit live on step 5.
- `tests/e2e/phone-estimate-funnel.spec.js` — first-paint assertions at
  390x844 (phone + checkbox + disclosure + both links visible, unchecked,
  >= 44 px target, no overflow), Continue refused without consent, then the
  full run and the `submitPublicLead` payload (`tcpaConsent: true`). Every
  network call is intercepted; it refuses non-local base URLs.

## Not covered

- A real iPhone (installed app / Safari). Verified in headless Chromium only.
- Other pages with a phone field and no consent box (`/free-roof`,
  `/services/roof-care-plan`, `/sites/*`) were not touched; the server only
  texts documents that carry a stored `tcpaConsent: true`, so they fail
  closed, but they are not part of the opt-in flow list either.
