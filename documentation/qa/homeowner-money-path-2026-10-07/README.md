# Homeowner money path: numbers + visual audit (2026-10-07)

Audit only, no product change. This walks the pages a homeowner sees from estimate to receipt: the estimate link (`/pro/estimate-view.html`), the deal room (`/deal/<token>`), e-sign (`/pro/esign.html`), the portal (`/pro/portal.html`), the invoice email, the Stripe landing (`/pro/invoice-success.html`) and the receipt email.

It covers four job shapes, at 390 px (installed-app rules forced) and 1440 px. The earlier [CRM visual audit](../../audit/CRM-VISUAL-AUDIT-2026-10-05.md) covered only the CRM's own screens, and the [2026-06 homeowner sweep](../homeowner-sweep-2026-06-11/STATUS.md) covered the marketing site.

- The full report, with the numbers table and every finding with file:line, lives outside the repo at `C:\Users\jonat\nbd-content\ho-money-audit-2026-10-07.md`.
- The 110 screenshots are in `C:\Users\jonat\nbd-content\ho-money-audit-2026-10-07\<shape>\<page>-<w>.png`. They are not committed: the data is seeded fake data, but the shots stay out of the public repo anyway.

## How it was walked (reusable recipe)

- **Emulators:** auth, firestore, storage, hosting and **functions**, with CI's dummy secrets in `functions/.secret.local`. The emulator log showed 0 "email sent" / "sms queued" lines, and e-sign mail hit the emulator stub.
- **Tenant:** the auth user was created with the NBD platform uid (the `NBD_OWNER_UID` default), so NBD's Zelle, ACH and branding rules apply. The rep built each estimate through the real V3 wizard, then called `EstimateV2UI.sendToHomeowner()`.
- **Real functions:** `createDealAcceptToken`, `createPortalToken`, `getEstimateForView`, `getDealRoom`, `submitDealAcceptance`, the e-sign get/submit pair and `getHomeownerPortalView`. The job spine's deposit draft and `finalInvoiceOnInstall` also ran for real.
- **Payments:** each payment went through the real `invoiceWebhook`, as a `payment_intent.succeeded` event signed with the dummy secret via `stripe.webhooks.generateTestHeaderString`.
- **Stripe was never called.** "Send invoice" was simulated by stamping `stripeHostedUrl`, `stripeChargeCents` and `stripeChargeKind` the way `createStripePaymentLink`'s NBD path does.
- **Two harness gotchas:**
  - The homeowner pages call `127.0.0.1:5001` cross-origin, and the functions only allow the prod origins. The harness relays each call with `route.fetch()` and adds the CORS header.
  - The deal page loads `https://nobigdealwithjoedeal.com/pro/deal-room.js`, i.e. live production JS. Route that URL to the checkout's file, or you are testing prod's script.
- **Clear `_rate_limits_ip` between page loads:** every emulator request comes from 127.0.0.1, so the per-IP limits trip within a minute.

## Numbers verdict

- **Cash under $2k, cash $2k+, and tiered with a non-default tier:** total, deposit, due-now, paid and balance agree on every surface, with one exception. The **invoice email's lines never add up to its total**:
  - `buildInvoiceHtml` prints no Subtotal or Tax row.
  - On a per-SQ job the single line is the pre-tax back-calculation: "Elite tier $22,102.80" over a total of $23,650.
- **Kentucky insurance:** $0 at signing holds everywhere, and the pay link and Zelle are withheld until the release date. But the invoice the rep creates has `depositAmount` 0, so the portal reads **"Balance due $13,250"**. That is before the decision, and again after release, when the plan says $1,000 deductible + $8,000 carrier check now and $4,250 on completion. Rounding is also 1¢ apart between the estimate link and the invoice.

## Top findings

| # | Sev | Finding | Where |
|---|---|---|---|
| H1 | HIGH | The invoice email hides sales tax, so its lines don't add up to its total | `docs/pro/js/invoice-pipeline.js` `buildInvoiceHtml` |
| H2 | HIGH | A KY insurance invoice bills the whole job after release, not deductible + first check, and shows "Balance due" while held | `invoice-pipeline.js` `createOrOpenJobInvoice` deposit; `functions/invoice-charge.js` |
| H3 | HIGH | "Licensed & insured" is still on every deal room; Jo ruled "Fully insured" on 2026-10-05 | `docs/pro/js/close-board.js` trust row + footer |
| H4 | HIGH | A $500 repair deal card promises a 10-year transferable workmanship warranty + GAF System Plus | `close-board.js` tier warranty line ignores `workKind` |
| H5 | HIGH | KY Rounding is −$4.96 on the estimate link vs −$4.95 on the invoice | two footing paths |
| M1 | MED | The portal estimate status says "Sent to you" after a deal-room signature, even when paid in full | deal accept never sets `signatureStatus` |
| M2 | MED | "7 of 8 done" next to "See all 9 steps" | `homeowner-progress.js` total vs `portal.js` `steps.length` |
| M3/M4 | MED | Once paid, the portal shows no paid amounts and no receipt; a deal-room signer gets no signed copy | portal money and documents cards |
| M5 | MED | The deal link still accepts a second signature after e-sign + paid in full | `getDealRoom` only checks deal status |

Already covered by tonight's PRs: none of the above. #2299 (signed price wins, stale deal price blocked) was still open when this was written; every shot is pre-#2299. #2297 and #2298 merged during the walk and don't touch these numbers.

## Checked and clean

- No horizontal overflow on any page at 390 or 1440, no page errors, and no undefined / NaN / `$0.00` leaks in money text.
- KY notices are present (KRS 367.624 cancellation, KRS 304.20-105 assignment-void), and no claim-handling wording appears on any page.
- The deposit rule is the same on every surface.
- Labor warranty by tier in the deal room: 1 / 5 / 10 / 20 / 20, with no "lifetime warranty".
- Zelle reads "(859) 420-7382 or jd@", never info@.
- After a non-default tier pick, the estimate, lead, deposit draft, portal and receipts all follow it.
- After the deposit is paid, the spent deposit link is not offered again (R6-2-6 holds).
