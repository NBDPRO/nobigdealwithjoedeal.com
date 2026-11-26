# AI route evals (current model vs Claude Haiku 5.5)

Roadmap step 15 (2026-11-25). One small eval per server AI route that runs
through `functions/ai-client.js`. Each compares the route's current model
(`functions/ai-models.js`) with `claude-haiku-5-5` on a fixed, invented input
(made-up names, no customer data), and scores the answer with the checks the
route already runs in production: its sanitizer (`sanitizeNotes`,
`sanitizeCallerFacts`, `sanitizeVisitNotes`), the promise cleanup's
`verifyVerdicts`, and "no invented numbers" (every number in the answer's
prose appears in the prompt).

**Not run in CI.** It calls the live Anthropic API and spends money (about a
cent for the default run). Nothing here writes to Firestore.

## Run it

```bash
cd functions && npm ci && cd ..                 # @anthropic-ai/sdk
node tests/ai-evals/run-evals.js --self-check   # no API: the checks pass a good answer, fail a non-answer
ANTHROPIC_API_KEY=... node tests/ai-evals/run-evals.js             # 3 runs per route per model
ANTHROPIC_API_KEY=... node tests/ai-evals/run-evals.js --runs 5 --routes promise-cleanup,text-notes
```

Use a key you are allowed to spend from; never paste it into a file. The
script prints one row per route and model (passes, stop reasons, average
tokens, cost per call, which checks failed) and a verdict per route.

## Switching a route to Haiku 5.5

A route switches only when its Haiku 5.5 row passes every run. The switch is
a one-line change to that route's `model` in `functions/ai-models.js`, in its
own PR, with Joe's OK (this PR does not make it). Then re-run the eval on the
PR and paste the table into its description.

The evals go through `functions/ai-client.js`, so they send the same API
version the routes send (`anthropic-version: 2023-06-01`, pinned there). The
step-15 PR itself has not been run live: the current-model rows are the
check that a migrated route still ends with `end_turn`, not `max_tokens`.

Haiku 5.5 thinks by default (adaptive, effort `medium`) and thinking tokens
count against `max_tokens`. If a Haiku 5.5 row shows `max_tokens` stop
reasons, the route's `maxTokens` needs room for thinking before it can switch.

## Files

- `evals.js`: the cases, one per route (`CASES[route]`: system, prompt, score)
- `run-evals.js`: the runner and the table
- `tests/ai-client-registry-2026-11-25.test.js` (CI): every migrated route has
  a case here, and each case fails a non-answer
