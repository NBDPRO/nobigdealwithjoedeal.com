# Session 2026-11-09: Call to Close P1, "Transcribe now" + segment confidence

Branch `ctc-p1-transcribe`, from `88eb11bcf` (P0 + P0b). Builds §9 P1 items 1-2 of [CALL-TO-CLOSE-DESIGN-2026-11-09](CALL-TO-CLOSE-DESIGN-2026-11-09.md) (Q5: transcribe-now is early P1). P0 is in [SESSION-2026-11-09-call-to-close-p0](SESSION-2026-11-09-call-to-close-p0.md).

## What a user sees

- A **Transcribe now** button on a recorded call that has no transcript yet, on the customer card (Calls) and on the Call Center card. Same people as "Draft from this call": the call's owner, a company admin or manager of the same company, the platform admin. Never a viewer, never a sales rep on someone else's call.
- Tapping it opens the call sheet: "Transcribing this call now. A long call can take a minute or two." Then one line of what happened ("Transcribed. The notes are on the call.", "already transcribed", "being transcribed right now", a daily limit, or why the call cannot be transcribed). The card reloads; a filed call then offers Draft from this call.
- In the brief, a quote Whisper was unsure of says **"Unsure: hard to hear on the recording."** A banner says parts of the call were hard to hear. A claim # or date that came from such a quote has **no Accept**: the card says "heard as 44729, but it was hard to hear. Listen and type it", with an empty box and Save / Skip. Insurance fields still get the Kentucky confirm after Save.

## What changed

| Piece | Files | Rule |
|---|---|---|
| Groq confidence | `functions/integrations/voice-intelligence.js` | `transcribeGroqBuffer({ confidence: true })` keeps `avg_logprob` / `no_speech_prob` that verbose_json already returns. Same request; other callers unchanged. |
| Segment index | `functions/call-center-logic.js` `buildSegIndex`, `call-center.js` | Each transcription stores `segIndex: { v, start[], end[], off[], lp[], merged }` on the call (flat number arrays; Firestore has no nested arrays). **Cap: `SEG_MAX` = 400 entries** (about 10 KB). A longer call merges neighbours in equal groups, keeping the first start, last end, first offset and the **worst** logprob. Segments past the stored 100,000-character transcript are dropped. Personal calls store none. |
| Lease | `call-center.js` `claimTranscribe`, `TRANSCRIBE_LEASE_MS` | Both the schedule and Transcribe now claim a call in one transaction (`status === 'stored'`, no live lease at all, its own holder's included: see the review fixes) and write `transcribeLease { by, untilMs }`, 15 minutes (longer than the 540 s run and the 300 s callable). Cleared on every write that ends the call's turn; a dead run's lease expires. |
| One-call pass | `call-center.js` `runTranscribe({ only })` | The same steps for one call: the owner's calls only, capture-off rule, the day audio allowance (it counts against it), no backfills, no `lastTranscribe` record. |
| Callable | `functions/call-transcribe-now.js`, `index.js`, `function-map.json`, `FUNCTIONS_INDEX.md`, demo SDK | `callTranscribeNow { callId }`: App Check, ghost check, callCenterAction's exact role test. A transcript already there is returned (no Groq, no quota, even with AI off). Then the AI kill switch, `CALL_CENTER_TRANSCRIBE_ENABLED`, `callCenter.paused`; only calls the schedule would pick; lease check; **10 per user, 30 per company per ET day** (`call_transcribe_quota`, one transaction; given back when nothing was transcribed, kept on a provider outage). Demo: the no-phone answer. |
| Low-confidence rule | `functions/call-brief-logic.js` `LOW_LOGPROB`, `unsureQuotes`; `call-brief.js` | **Threshold: avg_logprob below −1.0** (Whisper's own `logprob_threshold`). A quote is unsure when every segment under it is below it; one clear segment is enough. A quote the index cannot place is unsure. No index (calls transcribed before this): nothing marked, the P0 brief byte for byte. A field whose value has a digit and whose quote is unsure gets `retype`; `callBriefDecide` refuses it unless the person typed the value (`retyped: true`). |
| Sheet + buttons | `docs/pro/js/call-brief-ui.js`, `css/call-brief.css`, `customer-calls.js`, `call-center-view.js` | `NBDCallBrief.transcribe()` lives in the lazy sheet file; the cards only add `txGate` + one button. Customer page boot growth: **529 bytes shipped** (dashboard 0; call-center-view.js is lazy). |

## Assumptions

- Transcribe now runs the whole pass (transcript **and** notes, timeline entry, task), not the transcript alone, so the call becomes briefable at once. It needs no paid-plan check: with the gate on, the schedule would transcribe the call anyway within 30 minutes.
- Calls outside the owner tenant (the pipeline is single-tenant, design §3.3) are refused with "not in the transcription queue", the same set the schedule picks.
- Dates count as digits for `retype` (a misheard "fifth" / "fifteenth" is as costly as a claim #). Promise due dates are only marked unsure: they are already an editable date box with a confirm.
- `BRIEF_VERSION` is not bumped: a call has a `segIndex` only if it was transcribed by this code, so no cached brief predates its index.
- The day audio counter is still a read-modify-write in the scheduled run; a Transcribe now that lands mid-run can be undercounted by that one call. Groq's own limit still stops a run cleanly.

## Not done

- Quote timestamps (`m:ss` chips from `segIndex.start`) and a numeric unreliable-transcript guard from `no_speech_prob`: the index makes both possible; neither was asked for in this lane.
- No change to who is recorded or where audio goes (Q6).

## How it was checked

Red first (`88eb11bcf`): `call-to-close-transcribe-now-2026-11-09` 17 passed / 54 failed; `call-to-close-segment-confidence-2026-11-09` 7 / 22. Green: 105/105 and 34/34. Screenshots of the demo customer page and Call Center at 375x812 and 1280x800.

## Update 2026-11-09: review fixes

Two reviews of the lane. Fixed, each test-first, one commit each:

- **Same-user double tap ran twice.** `claimTranscribe` let a caller re-claim a live lease with its own `by`, and the callable's `by` is `'now:' + uid`, so a double tap, two tabs, or the Call Center card plus the customer card made two Groq calls, two notes runs and a quota count of 2. Any live lease now refuses the claim. The suite has the same-uid concurrent case.
- **Capture-off said "Transcribed".** The pass files a capture-off number personal without sending audio. It now reports `captureOff`, and the callable answers that the number is marked not to be transcribed.
- **Outage taps were unbounded.** An outage run made a real Groq / Anthropic request, added no strike and gave its quota count back. It now keeps the count, so the daily cap bounds taps during a 429 / 5xx window. Busy and plain failed runs still give it back: busy calls nothing, and a failure is a strike (three per call).
- **Segment boundaries over-flagged.** `unsureQuotes` normalised each segment on its own. A boundary inside a word or a spoken digit run ("four four | seven two nine") split the quote, which then could not be placed and went to retype. When the per-segment join misses, the quote is now placed in the whole normalised transcript, as grounding does. Each segment starts at the normalised length of the text before it (binary search). Prefix normalisation can shift a boundary by a token when number words straddle it ("twenty | five"), which is fine for this purpose.
- **Cancel lost the retyped value.** A Cancel on any confirm cleared every edit box, so cancelling the insurance confirm threw away a claim # typed into the retype box, which has no prefill. A confirm's Cancel now closes only the confirm. An edit box's Cancel closes only that box.

Accepted as they are and recorded here (no code change):

- **The retype gate is honour-based.** `callBriefDecide` trusts the client's `retyped: true`, so a modified client could send the model's own value with that flag. A person still has to send a value, so the gate stops one-tap fills by mistake, not a deliberate bypass.
- **A saved transcript is not returned as "already".** A call with `transcriptSaved` (transcript kept, notes failed in an outage) goes through the switches, the quota and a notes-only run with no Groq call. Returning it as "already" would leave the call un-noted. The client hides the button for these calls, so only a direct API call gets here.
- **Transcribe now on a non-owner call.** `txGate` shows the button on any stored call the user can act on, but the server only takes the owner's calls (the pipeline is single-tenant, design §3.3), so on any other call the tap ends in "not in the transcription queue". Today only the owner tenant has Cube calls. Putting the owner's uid in client code would hard-code NBD (CLAUDE.md), so this waits for P2's per-tenant pipeline.
- **Quota docs never expire.** `call_transcribe_quota` holds one doc per user and per company per ET day, with no TTL. It is small. P2 retention should list it (a TTL on `day`, or a sweep).
- **The day audio counter is read-modify-write.** A scheduled run's `audioSecUsed` write can overwrite a Transcribe now that overlapped it, so that one call is undercounted (see Assumptions). Groq's own limit still stops a run.
- **Promise due dates: Jo to confirm.** Due dates from unsure quotes are marked unsure but not retype, and they rely on the existing date box and confirm. The lane text says digits from low-confidence segments are never one-tap. Adding a promise is already a confirm, not one tap, but **ask Jo** whether an unsure due date should start empty, like a retype field.

Checked again: `call-to-close-transcribe-now-2026-11-09` 114/114, `call-to-close-segment-confidence-2026-11-09` 41/41, plus every call-brief* and call-center* suite.
