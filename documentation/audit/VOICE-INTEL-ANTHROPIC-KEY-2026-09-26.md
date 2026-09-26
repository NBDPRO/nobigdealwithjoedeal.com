# Voice Intel: Claude analysis could never run (2026-09-26)

**Result.** Every Voice Intel recording would have ended
`status:'failed'`, `statusError:'[anthropic-not-configured] ANTHROPIC_API_KEY secret is unset'`,
after Groq had already transcribed it. `voiceConsumer` only fires on
`status:'complete'`, so it would never have run either. The key was bound and
set the whole time. The code asked the wrong function about it. **No customer
was affected, because nobody has ever made a recording:** production has zero
recording documents (see [Production check](#production-check)).

Fixed on branch `fix/voice-intel-anthropic-key`. The same change adds a
tenancy check, because the fix would otherwise have made a known cross-tenant
hole work (see [Why the tenancy check ships with it](#why-the-tenancy-check-ships-with-it)).

This is **not a new finding**. [STABILITY-AUDIT-2026-09-04](STABILITY-AUDIT-2026-09-04.md)
confirmed it as "dead-wiring" three weeks ago, and it was never picked up. It
was found again during the Thursday/Bland recon. That audit's entry now points
here.

## The defect

`functions/integrations/voice-intelligence.js` `callClaudeJson`:

```js
if (!hasSecret('ANTHROPIC_API_KEY')) throw new VoiceError('anthropic-not-configured', …);
…
'x-api-key': getSecret('ANTHROPIC_API_KEY')
```

`hasSecret()` in `functions/integrations/_shared.js` begins with
`if (!SECRETS[name]) return false;`. `SECRETS` is the integration-secret
registry, and `ANTHROPIC_API_KEY` has never been in it. So the gate was
hard-coded `false`. `getSecret()` would have returned `null` for the same reason.

The module already had the right handle,
`const ANTHROPIC_API_KEY_FOR_VOICE = defineSecret('ANTHROPIC_API_KEY')`, and it
is bound in `onAudioUploaded`'s `secrets:` list. Nothing read it.

The two call sites and what each one did with the error:

| Step | Mode | Outcome under the bug |
|---|---|---|
| `analyzeTranscript` | every mode | `failed`, `[anthropic-not-configured]`, after Groq was paid |
| `checkVerbalConsent` | `two_party_verbal` only | `quarantined_consent`, "consent check failed: …". It failed closed, so every verbal-mode recording was quarantined. |

The failed runs also never counted toward the budget. `incrementVoiceUsage`
only runs on completion, so the `voice_audioSec` counter stayed at 0. Every
upload paid Groq, and the daily cap never moved.

## The fix

`callClaudeJson` now reads the bare param through `secretValue()`, the helper
`dictate.js` and `handlers/ai-texting.js` already use. It trims the value, and
it treats the deploy's `__unset__` stub as unset.

```js
const apiKey = secretValue(ANTHROPIC_API_KEY_FOR_VOICE); // '__unset__' stub → null
if (!apiKey) throw new VoiceError('anthropic-not-configured', …);
```

**Why not register `ANTHROPIC_API_KEY` in `SECRETS` instead.** Grep found
exactly two `hasSecret/getSecret('ANTHROPIC_API_KEY')` sites in `functions/`,
and both are the ones fixed here. Registering the name would change behaviour
elsewhere. `hasSecret()` would start answering `true` for it in every module
that loads the registry. Worse, `integrationStatus` (`functions/handlers/integrations.js`)
declares `secrets: Object.values(SECRETS)`, so registering would also mount
the Anthropic key on that admin callable at the next deploy. The bare param
changes nothing outside this function. The test asserts that the key is still absent from `SECRETS`.

## Why the tenancy check ships with it

The 09-04 audit also confirmed "onAudioUploaded treats a client-chosen Storage
path segment as a lead id with no tenancy check". `storage.rules` lets any
signed-in user write `audio/{theirUid}/{anything}/{anything}.webm`, and
`processRecording` used the second segment as `leadId` without checking it.

While analysis could not run, that hole ended at a `failed` row. With analysis
working, a recording planted on another tenant's lead would complete. Then
`voiceConsumer` would create tasks on that lead and backfill its empty
insurance fields. The planted row is stamped with the uploader's `userId`, so
the uploader could also read back the summary, which is written with the
homeowner's name in the prompt.

`processRecording` now resolves the caller's context first and refuses any
lead the uploader may not record on: `uploaderMayRecordOn(lead, uid, companyId)`.
The lead must be the uploader's own (`lead.userId === uid`), or it must be in
the uploader's company (`lead.companyId === users/{uid}.companyId`).
`firestore.rules` keeps `users/{uid}.companyId` server-only, so the company
side is trustworthy. A missing lead is refused. The refusal comes **before
every write**, because the kill-switch and over-budget branches used to write
a `failed` doc under the path's lead id too. It also comes before any vendor
call. It writes nothing and returns `{ ok:true, skipped:'lead_not_accessible' }`.

What it does to other paths:

- **D2D voice memos.** These upload to `audio/{uid}/d2d/…`. There is no
  `leads/d2d` doc, so they are refused without a write. #1777 fixes the same
  rows in `parseAudioPath` with `isReservedLeadId()`. The two fixes are
  complementary, and both should land.
- **Known edge.** A manager recording on a teammate's *legacy* lead, one with
  no `companyId`, is refused. The UI's listener would then wait for a row that
  never arrives. Every lead created since company tenancy carries
  `companyId`.

## Cost: the two gates still apply

`processRecording` runs these checks in order:

1. idempotency
2. **tenancy** (new)
3. **kill switch**, `feature_flags/global.voiceIntelDisabled`
4. **daily budget**, `checkBudget`
5. Groq
6. consent check (Claude, verbal mode only)
7. analysis (Claude)

Both spend gates still come before the first vendor call, and the test pins
that neither the switch nor the over-budget path calls Groq or Anthropic.

- `aiDisabled` does **not** stop voice. That is deliberate: voice has its own
  flag (`killswitch.js`, and [SPEND_KILLSWITCH](../runbooks/SPEND_KILLSWITCH.md)).
  The test pins this too.
- **Unit cost is small.** Groq Whisper costs about $0.04 per audio hour.
  Analysis runs on Haiku 4.5 (model pinned in code) at about 2k tokens in and
  600 out, so well under a cent per recording.
- **The caps are 30× looser than their comments say.** `VOICE_COMPANY_BUDGET_SEC`
  is compared against a *daily* counter (`api_usage_daily/{date}__co__{id}`).
  Its values are monthly figures, though. For example, `foundation: 72000`
  carries the comment "20 hr/mo ≈ 2400s/day", but 72000 s is 20 hours a
  **day**. At that ceiling one company tops out near $1 to $2 a day. That is
  harmless at current scale, but the numbers should be fixed deliberately.
  `gauntlet-regressions.test.js` pins `team: 126000`, so a fix means editing
  that test too. Not changed here.
- **Budget accrues only on completion.** A run that transcribes (Groq billed)
  and then fails at analysis adds nothing to `voice_audioSec`. It is bounded by
  the kill switch, not by the cap. Not changed here.
- **Still open from 09-04:** a 200 MB upload is accepted and buffered, but
  Groq's documented cap is 25 MB. It fails at Groq, before Claude, so it costs
  no Anthropic spend. It matters now that the pipeline can complete.

## Production check

This was read-only, using ADC on `nobigdeal-pro` on 2026-09-26. The scripts
live in the session scratchpad and are not committed.

| Query | Result |
|---|---|
| `collectionGroup('recordings')`, all docs by status and error | **0 docs**, so there are no statuses or errors to break down |
| Positive control: `collection('leads').count()` | 263 |
| Positive control: `collectionGroup('tasks').count()` | 18 |
| Storage `audio/` prefix | 2 objects, both `audio/<uid>/d2d/…webm`, **0 bytes**, 2026-07-15 and 2026-07-30 |
| `api_usage_daily` where `voice_audioSec > 0` | 0 |
| `feature_flags/global` | no doc, so the kill switch is off |
| `onAudioUploaded` / `voiceConsumer` | deployed, ACTIVE; last 30 days of logs show only startup and deploy lines |
| `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | both real values, not the stub (only length was checked; values were not printed) |

So the pipeline has never processed a real recording. After this deploys, the
first real upload will spend real Groq and Anthropic money.

## Tests

`tests/voice-intel-anthropic-key.test.js` is in the node bucket, and FLOORS
moved from 192/68/282 to 193/68/283. It runs the real `processRecording`
against an in-memory Firestore and Storage (swapped in for `firebase-admin`
through `Module._load`) with a stubbed `fetch`. It asserts outcomes: the
status written, the `x-api-key` Anthropic receives, and which vendors were
called. It does not match source text. It has 35 checks.

Break-tests, run on 2026-09-26:

- **Old gate restored.** With `hasSecret`/`getSecret` back in place, 13 checks
  go red, with the production symptom verbatim:
  `failed / [anthropic-not-configured] ANTHROPIC_API_KEY secret is unset`, and
  `quarantined_consent` in verbal mode. The gate and refusal checks stay green,
  which is correct, because none of those paths reaches Claude.
- **Tenancy disabled.** With `uploaderMayRecordOn` changed to `return true`,
  9 checks go red, all in the TENANCY section. The foreign lead gets a
  completed recording, Groq and Anthropic are called, and the kill-switch and
  over-budget paths plant their `failed` doc on the foreign lead.

## Merge notes

- #1777 is also in `voice-intelligence.js`, in `parseAudioPath` and the
  require block. This change touches the `_shared` require line,
  `callClaudeJson`, the top of `processRecording` and the exports. Run
  merge-tree before merging whichever of the two goes second.
- `scripts/run-test-manifest.js` FLOORS and `tests/ci-manifest.json` also move
  in #1780, #1782 and #1783. Whoever merges last re-measures with `--check`.
- **This needs a functions deploy.** Nothing changes for users until
  `onAudioUploaded` redeploys.
