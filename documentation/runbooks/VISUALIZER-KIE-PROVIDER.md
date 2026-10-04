# Runbook — Flip the visualizer image-gen provider to kie.ai

> **RETIRED 2026-10-04 — do not follow.** The kie.ai provider was never
> switched on (`KIE_API_KEY` held the deploy's `__unset__` stub), so it was
> removed: Replicate is the visualizer's only image provider, still behind
> `VISUALIZER_IMAGEGEN_ENABLED` (default OFF). `IMAGEGEN_PROVIDER` is no
> longer read. See the vendor cost and lock-in audit (`documentation/audit/VENDOR-COST-LOCKIN-2026-10-04.md`, Lane C — on PR #2157 until it merges). After the deploy, Jo deletes the `KIE_API_KEY`
> secret. Kept below as history only.

**When:** you want the homeowner visualizer's image generation to run on
kie.ai instead of Replicate (same Flux Kontext model family, typically
cheaper per image — verify current pricing first). The seam shipped dark in
#1181 (2026-08-05); all engineering is done. Flipping it is config only —
no deploy, no code change — and rolling back is the same steps in reverse.

> The feature itself is separately gated by `VISUALIZER_IMAGEGEN_ENABLED`
> (default OFF) — see `functions/FUNCTIONS_INDEX.md` and
> `SPEND_KILLSWITCH.md`. This runbook only changes WHICH provider serves it.

## Before you flip (10 min)

1. **Verify pricing** at kie.ai for `flux-kontext-pro` and
   `flux-kontext-max` against Replicate's current per-image cost — the
   "typically cheaper" claim in the code header is from 2026-08-05.
2. **Known quality caveat:** kie.ai has no `match_input_image` aspect-ratio
   mode, so output framing can differ from Replicate's. That's the one
   thing needing human eyes — plan a side-by-side QA (step 4).

## Flip (15 min)

1. Create a kie.ai account and API key.
2. Set the secret:
   ```
   firebase functions:secrets:set KIE_API_KEY
   ```
3. Set the provider env var on the `visualizerImageGen` function
   (Console → Functions → visualizerImageGen → environment variables, or
   redeploy with the env set):
   ```
   IMAGEGEN_PROVIDER=kie
   ```
   Optional model overrides (no redeploy needed): `KIE_MODEL`,
   `KIE_SHINGLE_MODEL` — default mapping is `flux-kontext-pro`, with
   `flux-kontext-max` where Replicate used kontext-max.
4. **Side-by-side QA:** run the same 3–4 visualizer jobs (at least one
   shingle swap) under each provider and compare framing/quality. Flip
   `IMAGEGEN_PROVIDER` back and forth as needed — the response shape is
   identical, the frontend never notices.

## Verify

- Admin → integration status shows `KIE_API_KEY` populated
  (`functions/handlers/integrations.js` readout).
- A visualizer run succeeds and Cloud Logging shows no
  `provider_not_configured` errors.
- Misconfig behavior is loud by design: `IMAGEGEN_PROVIDER=kie` with no
  key returns 503 `provider_not_configured` — it never silently falls back
  to Replicate.

## Rollback

Unset `IMAGEGEN_PROVIDER` (or set `replicate`). The default is Replicate;
the KIE_API_KEY secret can stay set harmlessly.
