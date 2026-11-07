# Billing tab: a failed plan read stops showing "Loading…" forever — 2026-11-06

Part of the overnight CRM audit that started 2026-11-06 (harness and findings index:
[CRM-AUDIT-HARNESS-2026-11-06](CRM-AUDIT-HARNESS-2026-11-06.md)).
Test: `tests/billing-state-2026-11-06.test.js`. It passes 9/9 on this branch, and 6 checks fail
against main's code.

| ID | Where | What was wrong | Fix |
|---|---|---|---|
| ST-F37 | `billing-gate.js`, `dashboard-billing-tab.js` | When the subscription read failed, `_loaded` stayed false, which is deliberate: gates fail open and a paid tenant never flashes as Free. But the Billing tab couldn't tell a failure from a read in flight, so it showed "Loading…" forever. | `getPlan()` also reports `loadFailed`, which a failed read sets and a good read clears. `_loaded` is unchanged, so gating behaves exactly as before. On a failure the tab shows "Plan unavailable / Could not load your plan / Nothing about your plan has changed" with a **Try again** button, which re-runs `loadSubscription()` and repaints. A read still in flight keeps "Loading…". |

Not changed: plan gating, checkout and the Stripe portal. `billing-gate.test.js` (59), `unloaded-cache-gates` (72) and `pro-claims-honesty` (110) pass.
