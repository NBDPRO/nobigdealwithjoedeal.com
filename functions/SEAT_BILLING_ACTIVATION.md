# Activating self-serve paid seats

**Status:** code-complete, **dark** until one Stripe price + one secret exist. No engineering work remains — this is a Stripe/config task.

> **Update 2026-10-04 (tenant-ready lane — verified on main):** the stepper is now **hidden for everyone**, card-billed owners included, until a client switch is flipped: `docs/pro/js/dashboard-team-tab.js` renders it only when `window.NBD_SEAT_ADDON_ENABLED === true`. The 2026-09-14 correction below ("any card-billed owner DOES see the stepper") is no longer true. So activation is the four steps below **plus step 5**. `STRIPE_PRICE_SEAT` does not exist in Secret Manager yet; until it does, nothing a contractor can click reaches `setCompanySeatCount`.

## How it already works

- **Server:** `functions/handlers/seats.js` → `setCompanySeatCount` callable. Adds/removes a per-seat line item (`STRIPE_PRICE_SEAT` × qty) on the company's existing plan subscription, with proration (`always_invoice`), `payment_behavior: error_if_incomplete`, an occupied-seat guard (can't reduce below active members), and reduction rollback. Wired at `functions/index.js`.
- **Client:** `docs/pro/js/dashboard-team-tab.js` → `_renderSeatBuy` / `_applySeatBuy` already render the seat stepper and call `setCompanySeatCount`. It **self-hides** when seat buying isn't available, which is why nothing shows today. **Corrected 2026-09-14 — this is only true for access-code / free / enterprise-founder accounts. Any normal card-billed owner on a real Stripe checkout subscription (`pl.source === 'checkout'`, non-free, finite rep cap) DOES see the stepper — `dashboard-team-tab.js`'s own predicate around `host.style.display = ''` shows it for exactly that case, unconditional on whether `STRIPE_PRICE_SEAT` is actually a real price. Clicking "+" for such an owner calls `setCompanySeatCount`, which fails closed with a toast (server-side `startsWith('price_')` check below) rather than the control never appearing. Not a functional bug — the failure is safe and visible — but "which is why nothing shows today" overstates how dark this surface actually is.**
- **Gate:** `seats.js:141-142` (line drifted from `137-138`) reads `STRIPE_PRICE_SEAT.value()` and no-ops unless it `startsWith('price_')`. A placeholder value is a valid, deployable "off" state; a real `price_…` turns the feature on.
- **Deploy guard:** the `secrets: [... STRIPE_PRICE_SEAT ...]` binding means a Firebase functions deploy **fails** until the secret exists in Secret Manager — so you must create the secret (even as a placeholder) before the next functions deploy.

## Steps (you)

1. **Create a recurring per-seat Price in Stripe** — in **test mode** first, then **live**.
   - Product: e.g. "Additional Seat"; Price: recurring, monthly (match your plan interval), your per-seat amount. Copy the `price_…` id from each mode.
2. **Set the secret** (from `functions/`):
   ```bash
   firebase functions:secrets:set STRIPE_PRICE_SEAT
   ```
   Paste the **live** `price_…` when prompted. (For a test-mode dry run, set it to the test `price_…` against a test project/env first.)
3. **Redeploy the seat function** so it picks up the secret:
   ```bash
   firebase deploy --only functions:setCompanySeatCount
   ```
   > Per the deploy notes: keep this a single, targeted deploy (don't chain it behind other function deploys), and never drop function memory below 256 MiB.
4. **Validate in test mode** (closes the open "$0 seat-buy validation" item):
   - Open **Team** as an owner → the seat stepper should now render.
   - Buy 1 seat → confirm the Stripe subscription gains a seat line item, proration invoices correctly, and `subscriptions/{companyId}.purchasedSeats` increments.
   - Reduce back down → confirm the occupied-seat guard blocks reducing below active members, and a valid reduction removes the line item.

5. **Turn the stepper on** (after step 4 passes): add `window.NBD_SEAT_ADDON_ENABLED = true;` to an always-loaded config script on `docs/pro/dashboard.html` (e.g. a one-line `js/seat-addon-flag.js`, loaded with `defer` — never an inline script), bump its `?v=`, and deploy hosting. Removing that line hides the stepper again without touching Stripe.

## Notes

- `unmatched_sms` / seat data is per-**company**; seat enforcement already reads `purchasedSeats` + `PLAN_LIMITS` (see `functions/billing.js`) — no consumer changes needed.
- Plan-tier **feature gating** (locking premium features behind tiers) is intentionally **not** part of this — it would reverse the current single-tier decision (`maps.js: _nbdUnlocked = () => true`) and is a product call, not a config step.
