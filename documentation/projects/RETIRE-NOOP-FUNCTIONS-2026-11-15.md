# Retire six dead Cloud Functions (2026-11-15)

Joe approved the retire on 2026-11-15 (wave-1 cleanup, item 7).

## What this PR removes

| Function | Where | Why dead |
|---|---|---|
| `auditSubscriptions`, `auditUsers`, `auditAccessCodes`, `auditCompanies` | `functions/audit-log.js` | No-op Firestore triggers since the 2026-06-08 dedup; `audit-triggers.js` writes those collections. They fire on every write and do nothing. |
| `imageProxy` | `functions/handlers/photo.js` | 410 stub since R-03 (2026-04-15). No caller; zero Cloud Run requests in 60 days. |
| `setStorageCors` | `functions/handlers/photo.js` | Admin-only one-shot CORS setter. No caller; zero requests in 60 days. |

Kept on purpose: `auditInvoices` (the only audit writer for `invoices/*`) and `manageMessagingControls` (the owner's messaging kill switch, not dead).

Also removed: `function-map.json` rows, `FUNCTIONS_INDEX.md` rows, the `rate-limit-policy.js` `setStorageCors` entry, the `viewer-callables` verdicts, and the imageProxy 410-stub assertions in `tests/smoke/photo.test.js` (replaced by "is gone" assertions).

## The two-step rule (deploys never delete)

1. This PR merges and deploys: the next deploy no longer defines the six functions, but the old revisions stay live.
2. After that deploy is green, someone runs, once:

```
firebase functions:delete auditUsers auditCompanies auditAccessCodes auditSubscriptions imageProxy setStorageCors --project nobigdeal-pro --force
```

Then confirm with `firebase functions:list --project nobigdeal-pro` that exactly those six are gone and nothing else changed. Never run step 2 before step 1 has deployed: the next deploy of the old code would recreate them.

## The fleet check (added after the conductor asked)

The deploy job's "Fleet must match the code" step (`scripts/check-function-orphans.js`) FAILS on any deployed function whose export is gone. Deploys name functions explicitly and never delete, so between this PR's deploy and the manual `functions:delete` the six would show as orphans and turn the deploy job red. This PR therefore lists the six in `ALLOW_ORPHANS` with dated reasons (and `tests/function-orphans.test.js` O14 allows exactly those six names).

3. After `functions:delete` is confirmed, a small follow-up PR deletes those six allow-list lines and restores O14 to "empty". Until then do not add anything else to `ALLOW_ORPHANS`.
