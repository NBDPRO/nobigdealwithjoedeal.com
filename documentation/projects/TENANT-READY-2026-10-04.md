# Tenant-ready NBD Pro — 2026-10-04

Jo approved the whole scope: **NBD Pro has to work for a new contractor without Jo's help.** Prod at the start: 3 companies, 2 non-NBD (both empty), 0 Stripe Connect accounts. Branch `feat/pro-tenant-ready`. PR #2142 (tenant site publish gate) was read first; this work feature-detects its "Publish my site" action and does not touch its files' logic.

**The rule for every change:** each new setting defaults to NBD's current values **for NBD only** (the platform tenant = companyId/uid `1phDv…`). Every other company starts neutral. NBD's own behaviour is unchanged (every unit test section has an NBD control).

## What each item became

| # | Item | Where |
|---|---|---|
| 1 | Package prices are company-wide | Settings Save All writes `companyProfile.pricing.tierRates` (the engine already honoured it at calc time); the tier inputs paint from the company; factory reset clears it. `EstimateBuilderV2.effectiveTierRates()`; V3 cards print it; close board uses `tierOrder()`. |
| 2 | Imports don't eat the lead cap | One-time **1,000-lead import allowance** per company (`subscriptions.importAllowanceUsed`); `NBDBilling.importCapacity()`; the import screen shows how many rows will import before Confirm. |
| 3 | NBD-only marketing defaults blank | `company-profile.js _legal()` now also blanks financePartner (Acorn), services, valueProps ("Lifetime workmanship warranty on every tier"), tagline for non-NBD; payment terms follow the company deposit rule. Doc templates read `_legal()` and drop the financing/services/value blocks when blank. |
| 4 | Per-company business rules | `docs/pro/js/tenant-rules.js` + Settings → Estimates → **Business Rules** (`tenant-rules-settings.js`): tiers offered, names, card notes, warranty sentence, shingle locks, cash deposit rule. `estimate-config.js` tierLabel / tierWarrantyText / tierWarrantyBlurb / checkTierShingles / new tierOrder and `deposit-rule.js config()` ask it first. Tax + permit editors already existed (company pricing); non-NBD base is 0% tax / $0 permits. Server deposit draft reads the company rule (`tenant-ops-logic depositConfigFor`). **Kentucky insurance holds are untouched — keyed to the property's state.** Onboarding placeholders neutral. |
| 5 | Setup checklist + empty pipeline | `setup-checklist.js` on Home for a non-NBD owner: brand → import → prices → team (or "I work solo") → Stripe → publish site (only when #2142's `_publishSite` exists) → first estimate. Empty board leads with **Import leads (CSV)**; sample leads use a separate 20-lead allowance. |
| 6 | Admin Tenants + onboarding mail | `/admin/tenants.html` → `adminListTenants` (role admin or the NBD owner uid). `onCompanyCreated` trigger queues a signup alert to Jo (`PLATFORM_ALERT_EMAIL`, default jd@) and a welcome email to the owner. Stripe `customer.subscription.trial_will_end` queues a trial-ending email to the contractor. All via `email_queue` with deterministic ids. |
| 7 | Connect Stripe prompt | Invoice detail shows "Card payments are not set up yet … Connect Stripe" before the send (not for NBD, paid, linked or KY-hold invoices). |
| 8 | Homeowner emails show the contractor | `sendEmail`: non-NBD From = `"<brand name>" <platform address>`, Reply-To = company business email. NBD unchanged. Custom sending domains: later. |
| 9 | Logo upload | `uploadCompanyLogo` (sharp re-encode → PNG, EXIF/GPS dropped) → `tenant-logos/{cid}/{sha}.png`, served by `tenantLogo` at `/tenant-logo/**` (firebase.json rewrite). Never a `?token=` link. |
| 10 | Export + cancellation grace | `exportCompanyData` → one ZIP (JSON + CSV) named after the company; photos get 24-hour signed links best-effort (signing needs the IAM grant — see photo-token memory), permanent token links stripped. CSV exports are company-named (`nbd-…` for NBD only). A **paid** plan that ends → `readOnlyUntil` = +30 days (rules refuse new leads; the CRM is view-only via role-gate), then Free limits. |
| 11 | Server-side lead cap | firestore.rules `leadMeterOk`: every client lead create carries `meter` (manual/import/sample); `meterLeadCreate` trigger counts it and writes `leadCap {plan, blockedUntil}` at the cap; rules refuse creates while blocked (plan change or new month reopens). NBD, platform admins, owner-claim exempt. `trackUsage('leads')` no longer counts (no double count). Google Calendar sync verified **single-tenant** (one "NBD Jobs" calendar, owner-keyed queries) — left NBD-only and labelled in the pricing FAQ with auto-invoice-after-e-sign. |
| 12 | Seat stepper | Verified already dark behind `window.NBD_SEAT_ADDON_ENABLED`; `functions/SEAT_BILLING_ACTIVATION.md` corrected with the final switch step. |

## Things Jo has to do once (not code)

- Stripe Dashboard → Webhooks → the subscription endpoint → add event **`customer.subscription.trial_will_end`**.
- Optional: set `PLATFORM_ALERT_EMAIL` on the functions if signup alerts should go somewhere other than jd@.
- Seat billing: follow `functions/SEAT_BILLING_ACTIVATION.md` (now 5 steps).

## Decisions made in the lane (flag if wrong)

- Non-NBD tier **rates** keep the published starter rates (an estimate is never $0); V3 shows "These are starter prices" and the checklist keeps "Set your prices" open until the company saves its own.
- Non-NBD **deposit** default is *no cash deposit* until the company sets a rule.
- The E2E test company now adopts NBD's rules explicitly in `tests/e2e/fixtures/seed-emulator.js`, so the existing engine specs keep pricing the NBD way; the neutral start is proven by `tests/e2e/phone-tenant-setup.spec.js`.

## Tests

- `tests/tenant-ready-2026-10-04.test.js` (node bucket) — one section per item, NBD controls, cross-tenant checks (meter, export, tenants list).
- `tests/firestore-rules.test.js` §48 — the lead cap (16 checks; 7 go the wrong way on main's rules).
- `tests/e2e/phone-tenant-setup.spec.js` @shard2 — fresh company at 390 × 844: checklist → set prices → saved on the company → V3 quotes them.
