# Call line: an AI credit outage must never retire a call (2026-10-13)

Prod read, 2026-10-13: 14 `phone_calls` stuck at `status: 'stored'`, each with
`transcribeAttempts: 3` and `transcribeError: "anthropic 400: Your credit
balance is too low ..."`. Groq transcribed the audio; the notes step calls
Anthropic; the account was out of credit.

## Root cause

`pickToTranscribe` skipped a call after three strikes unless the stored error
looked like a rate limit (`isRateLimited`). A billing/auth error is not a rate
limit, so every call took three strikes in 90 minutes and was dropped for
good, **including after a top-up**. The run also kept going (paying Groq for
up to 12 transcripts that were thrown away, then re-paying on every retry),
and nothing told Jo.

## What changed

- `classifyProviderError` / `isProviderOutage` (functions/call-center-logic.js):
  one classifier. credit (400 "credit balance is too low", 402), auth (401,
  403, invalid/missing key), rate_limit (429), overloaded (529, 5xx). A call's
  own failure ("notes: no JSON", a timeout, a malformed-request 400) is not an
  outage and still strikes.
- `runTranscribe`: an outage is no strike, stops the run, records
  `lastTranscribe.state = 'provider_outage'` + `integrations/callCenter.providerOutage`.
  Transcription that succeeded is kept on the call (`transcriptSaved`,
  `transcript`; status stays `stored`, so every consumer that already handles
  waiting calls keeps working and a retry re-runs only the notes).
- `pickToTranscribe`: a call whose stored error is an outage is eligible
  regardless of attempts. The 14 stuck calls come back by themselves once the
  provider works; the reopen script is the explicit, auditable version.
- `reextractFacts`: outage = no `factsAttempts` strike, no day-budget spend.
- Signal: one bell (`notifications/ai-outage-<ET day>`) + one push a day, in
  watch hours, for credit/auth only; clears on the first run whose AI step
  works. Rides on the Call Center health strip (`ai_notes` row) and
  `integrations/pipelineHealth.problems` (`ai_provider_outage`, quiet: no second push).
- `scripts/reopen-provider-outage-calls.js`: dry-run default, `--apply`,
  `--project` required, counts only. **Not run.**

## Anthropic call-site audit

| Site | Trigger | On a credit/key outage | Strike / permanent state | Silent |
|---|---|---|---|---|
| call-center.js claudeNotes via runTranscribe | scheduled 30 min | was: strike, run continued, Groq re-paid. Now: no strike, run stops, transcript kept, alert | FIXED | was yes, now bell + push |
| call-center.js reextractFacts | same job | was: factsAttempts+1, 2 = retired forever. Now no strike | FIXED | was yes |
| text-inbox.js textInboxNotes | scheduled hourly | day doc not written, retries next hour | no | logged + failed count only |
| promise-cleanup.js | nightly 02:30 | per-call catch, no state written | no | logged only |
| integrations/thursday.js extract | Firestore trigger | status 'failed' + needs-review inbox, Jo is notified | terminal until manual reprocess | no |
| integrations/voice-intelligence.js callClaudeJson | storage trigger | analysis: status 'failed'; consent check fails closed to quarantined_consent | yes (no retry path since 2026-08-11) | logged + statusError, no push |
| photo-vision.js | photo trigger + callable | trigger: unclassified, no marker, no sweeper | no state, never retried | logged only |
| receipt-vision.js | callable | falls back to manual entry | no | surfaced |
| reel-studio.js callVision | render worker | ran:false, reel 'unchecked', Jo confirms | no | surfaced |
| handlers/ai.js (claudeProxy, publicVisualizerAI, publicFunnelAI, adminAI) | HTTP | status forwarded, budget refunded | no | surfaced |
| handlers/photo.js analyzeRoofPhoto | HTTP | 502, doc untouched | no | surfaced |
| lead-brief.js | callable | fallback brief (source 'fallback'), burns one of 60 daily slots | quota only | user sees fallback |
| dictate.js | callable | HttpsError internal; Groq already paid, cleaned transcript dropped; 30/h counter consumed | quota only | surfaced generic |
| handlers/ai-texting.js generateAIDraft | SMS webhook / trigger | no draft, warn log | rate slot consumed | yes (logged only) |
| morning-brief.js, health-digest.js | scheduled | no Anthropic call | n/a | n/a |

Not fixed here (report only): voice-intelligence terminal `failed` with no
retry path; photo-vision trigger with no sweeper; lead-brief/dictate/ai-texting
burning quota slots on provider failures; thursday `attempts` unused.

## Jo's steps

1. Top up Anthropic credit: console.anthropic.com > Billing. Calls resume on
   the next half-hourly run; the 14 stuck calls re-run by themselves.
2. Optional: approve running `node scripts/reopen-provider-outage-calls.js
   --project nobigdeal-pro` (dry-run first, then `--apply`) to clear the stale
   error text on those 14.
