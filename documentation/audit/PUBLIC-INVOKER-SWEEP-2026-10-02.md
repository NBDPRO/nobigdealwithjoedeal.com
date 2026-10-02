# Public-invoker sweep: four functions Cloud Run was silently refusing (2026-10-02)

Found during a read-only error sweep of production function logs. That
sweep also found the Groq rate-limit bug, fixed in #2004; see
[CALL-CENTER-2026-10-01](../architecture/CALL-CENTER-2026-10-01.md).

## Why it matters

Gen2 Cloud Functions run on Cloud Run, which checks **IAM before any code
runs**. A browser-facing function needs the `allUsers` → `roles/run.invoker`
binding, and its handler then does the real auth: an ID token, a role check,
App Check. Without the binding, every browser request gets a 403 at Cloud
Run, because a Firebase ID token is not an IAM credential. The handler never
runs and the function's own logs show nothing.

## What the sweep found

All 137 https and callable functions were checked with
`gcloud run services get-iam-policy … --format=json`, read-only.

| Function | Kind | Who calls it | Evidence |
|---|---|---|---|
| `cspReport` | onRequest | every browser, for CSP violations | **261 / 261 requests 403 in 7 days**: CSP monitoring was blind |
| `sendEmail` | onRequest | CRM email (`nbd-comms.js`, Close Board, email system) | no requests in 30 days, so impact unknown; the CRM falls back to the mail app |
| `sendSMS` | onRequest | CRM texts | no requests in 30 days; `sendQueuedSMS`, with the same options, still had the binding |
| `extractReceiptData` | **onCall** | Expenses receipt scan | no requests in 30 days |

The other 133 all had the binding. None of the four was made private on
purpose: nothing in git history or the vault says so, and each handler
enforces its own auth.

## Fix

- **The three onRequest functions** now declare `invoker: 'public'` in code,
  the same fix the Stripe functions got on 2026-07-16 (`functions/stripe.js`).
  Every deploy re-applies the binding, so it can't be lost again.
  `tests/public-invoker-2026-10-02.test.js` pins all four onRequest names,
  including `sendQueuedSMS`, and was break-tested.
- **`extractReceiptData` is not fixable in code.** firebase-functions reads
  `invoker` only for `onRequest`, and the Firebase CLI makes a callable
  public only when the function is **created**. It needs a one-off grant,
  which is a production IAM write. **Done 2026-10-02 with Jo's OK** ("yes
  run it"). Read back: `allUsers` → `run.invoker`. Verified: an unauthenticated
  POST now gets the handler's own `401 UNAUTHENTICATED` JSON instead of Cloud
  Run's 403 HTML page. The command, for the record:

  ```bash
  gcloud run services add-iam-policy-binding extractreceiptdata --region us-central1 --project nobigdeal-pro --member=allUsers --role=roles/run.invoker
  ```

## How to re-run the sweep

The pitfall: `--format="value(bindings.members)"` prints **nothing** for the
nested list. Read naively, that makes 205 of 223 services look non-public.
The first pass here did exactly that, and checking two "missing" callables
by hand caught it. Use `--format=json` and parse it, and report any gcloud
error as an error rather than as "not public".
