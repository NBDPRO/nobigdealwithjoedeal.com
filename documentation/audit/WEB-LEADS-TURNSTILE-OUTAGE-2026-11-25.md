# Web leads outage: Turnstile required with a stub secret (2026-11-25)

Found during a website deep dive (which pages and tools under-perform). Read-only
checks against production; the only change is the flag flip in this PR.

## What happened

- 2026-10-13: `TURNSTILE_REQUIRED=true` went live in `functions/.env.nobigdeal-pro`.
  Its comment said this was safe because `TURNSTILE_SECRET` was enabled.
- It was not a real secret. Secret Manager holds one version (created
  2026-04-14), and it is the 9-character `__unset__` deploy stub, which
  `hasSecret()` treats as unset.
- So `verifyTurnstile` (`functions/integrations/turnstile.js:47`) took the
  fail-closed branch for every request and `submitPublicLead` answered
  `403 turnstile-required` without storing anything.
- Logs (the `_Default` bucket keeps 30 days): **12 POSTs to `submitpubliclead`,
  12 × 403, 0 stored**, each with the matching ERROR line. Real browsers (iPhone,
  Android, Mac), referer the homepage; one visitor retried 6 times on 2026-10-29.
  Their details were never saved and cannot be recovered.
- Every form that calls `submitPublicLead` was down: /inspect, /estimate,
  /storm-check, /roof-score, /storm-report, /storm-alerts, /free-roof, the
  homepage form and the quick form on town/service pages. `carePlanPublic` and
  `submitReferral` call the same verifier. Cal.com booking was unaffected.
- The visitor saw the "call or text Joe" fallback, and no analytics event fires
  on a failed submit, so nothing surfaced it for six weeks.

## Fix

`TURNSTILE_REQUIRED=false` (the runbook's Emergency step). With the secret
still the stub, the verifier returns to its unconfigured passthrough: honeypot
and per-IP rate limit only, the protection the forms had before 2026-10-13. The
contract test pin is flipped to `false` on purpose.

To turn enforcement back on, see the dated update at the top of the Emergency
section in [TURNSTILE-SETUP](../runbooks/TURNSTILE-SETUP.md): store the real
secret for the deployed site key, redeploy, confirm a real submit returns 200,
then set the flag back to `true` and flip the pin.

## Volume context (all-time counts, read 2026-11-25)

| Collection | Docs | Latest | CRM mirror |
|---|---|---|---|
| `inspect_leads` | 7 (5 `/storm-report`, 2 `/storm-check`, **0 `/inspect`**) | 2026-07-05 | 2 bridged, both later deleted; 5 predate the 2026-06-08 bridge |
| `estimate_leads` | 3 | 2026-04-09 | 0 (predate the bridge) |
| `contact_leads` | 4 (homepage) | 2026-09-22 | 3 |
| `free_roof_entries`, `storm_alert_subscribers` | 0 | | |

So the outage cost about six weeks of leads, but volume was already low before
it. The `/inspect` form itself has never stored a submission since it was wired
on 2026-05-23; that needs its own investigation once submits work again.

## Follow-ups

1. **Done 2026-11-25:** GA4 event `lead_submit_failed` (kind, page source,
   HTTP status, server reason code, had_token; no PII) on every failure path
   of `docs/assets/js/public-lead-submit.js`, guarded by
   `tests/lead-submit-failure-signal-2026-11-25.test.js`.
2. **Done 2026-11-25:** alert policy `alert-lead-submit-failures.json`, live as
   `alertPolicies/15171325019131919808` (see `monitoring/README.md` §12).
3. **Answered 2026-11-25:** after the fix deployed, a test submit on /inspect
   returned 200, was stored and bridged to the CRM (then moved to the Deleted
   bin). It was the first stored /inspect submission, so the form works; its
   zero before was low traffic plus this outage.
4. The CRM source report counts by `source` (kind), not `sourcePage` (tool),
   so the storm tools and /inspect are indistinguishable there.
