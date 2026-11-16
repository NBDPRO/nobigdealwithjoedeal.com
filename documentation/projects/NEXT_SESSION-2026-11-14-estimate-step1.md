# /estimate saves the lead at step 1 — session note (2026-11-14)

Lane note, not the live brief. Branch `claude/estimate-save-step1-2026-11-14`.

## Why
A homeowner gave name and phone at step 1 of `/estimate`, saw the ballpark at
step 4, and the lead only saved at step 5, so anyone who left after the price
was lost (homeowner-site review, 2026-11-14).

## Joe's decisions (2026-11-14)
1. Save the lead when the homeowner taps Continue at step 1, with the consent
   line shown at that step.
2. A lead that never finishes shows in the CRM as "started an estimate", apart
   from finished ones; finishing updates the same lead (no duplicate).
3. No automatic message to these leads, and the path must not start sending
   one if the automations are switched on later without a deliberate choice.

## How it works
- Step 1 Continue → `submitPublicLead('estimate', {..., estimateStage:'started', wantsFollowUp:true})`
  in the background (Continue never waits; failures are silent and retried on
  the next forward step). Same gateway, same gates: per-IP rate limit,
  Turnstile, honeypot, the M-04 allowlist, the phone rule, the intake guard.
- The response's one-time grant (`photoToken`, public-lead-photos.js) is the
  `leadToken` for later saves. A changed step 1 or the step-5 finish sends it;
  `functions/estimate-funnel.js` updates the SAME `estimate_leads` doc and its
  CRM card inside `submitPublicLead`, after every gate. Any refusal falls back to
  the old full create. A retried finish (lost answer) is answered with the same id.
- Bounds per grant: an estimate grant only; the doc must still be started; 10
  updates; a step-1 change within the grant's 60 minutes; the finish within 24h
  of step 1, once. Finishing re-opens the grant for the thank-you screen.
- CRM card: `estimateStage: 'started'` and a first note line "Started an
  estimate on the website and has not finished it yet…". The finish flips it to
  `completed`, drops that line and adds the estimate lines. Source label is
  unchanged (attribution keys on it).
- Alerts: Joe gets "Instant Estimate (started, not finished)" at step 1 and
  "Instant Estimate (finished)" on the finish (`leadAlertEstimateFinished`,
  `functions/estimate-funnel-triggers.js`). The homeowner gets nothing from this
  path: `lead-alert.js` skips both acks for a started estimate, the finish alert
  passes `ack:false`, and `lead-followup.js` skips a started estimate.
- `leadBridgeEstimateUpdate` re-applies the idempotent card patch, so a consent
  change or the finish reaches the card even if the inline write failed.
- Consent: the box stays optional on step 1. A change after the save is applied
  at once: untick → `tcpaConsent:false` + `tcpaConsentWithdrawnAt`; re-tick or a
  new number under a ticked box → `tcpaConsentRenewedAt`; every change is
  appended to `tcpaConsentHistory`. The original `tcpaConsentAt` is never
  overwritten. `sms-consent-declined.js` dates a decline by its withdrawal.
- A moved address voids the old roof measurement (`publicMeasurementVoid`) and
  notes it on the card.

## Open (Joe)
- Consent wording: the compliance agent suggested "about the estimate I'm
  starting here" instead of "my estimate request". Not changed: the text is
  registered for A2P and quoted on /sms-program. Joe's call.
- A finished estimate no longer gets the homeowner ack email/text (they ran
  only on create, and were switched off anyway). Turning them on for finished
  estimates is a deliberate later change.
- GA `generate_lead` now fires at step 1, not step 5.
- The paid roof measurement now also runs for people who leave after step 1
  (same daily cap and kill switch).

## Deploy note
Hosting goes live ~20 minutes before functions. In that window the new page
talks to the old server: step 1 saves as a normal lead and the finish creates a
second one marked as a repeat (no alert). Automations are off, so nothing is
texted. Deploying functions first avoids it.

## Tests
`tests/estimate-step1-save-2026-11-14.test.js` drives the real wizard,
gateway, alert, follow-up, bridge and consent code against fakes.
