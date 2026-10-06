# Roof Care Plan — making it real (2026-10-05)

Jo approved the build on 2026-10-05: the Roof Care Plan on
[/services/roof-care-plan](../../docs/services/roof-care-plan.html) becomes a
real, paid membership. Until now the page's "Get My Care Plan" button only led
to the contact form. **Everything ships dark** and Jo turns it on after his own
test.

## Jo's decisions (do not relitigate)

- **Terms are what the page promises.** $199 a year or $19 a month. No
  lock-in, renews until cancelled, cancel anytime. Each year: a professional
  inspection with a written condition report and photos, sealant touch-ups and
  up to 3 shingles (about 30 minutes) on the visit. Priority scheduling after
  storms. 10% off repairs, with pipe boots and bigger fixes quoted at the
  member discount.
- **Two ways to sign up:**
  - (a) Online checkout on the page, through Stripe on NBD's own account.
  - (b) From the CRM: Jo adds a customer and sends them the checkout link. The
    send is Jo's own button press and is never automatic.
- **CRM:**
  - members are visible (a badge on the lead/customer and a members list)
  - 10% off is applied automatically to REPAIR estimates only, as a visible,
    labelled line, "Roof Care Plan member — 10% off repairs". It never applies
    to replacements unless Jo says so later.
  - a yearly inspection reminder task
  - members are listed first on the storm surfaces that already exist

## Shape

The plan is the **platform tenant's own product** (`companyId = NBD_OWNER_UID`),
sold on the platform's Stripe account. It never goes through Connect and never
runs on behalf of another tenant. Every lead it reads or writes is checked to be
in that company. Another tenant's lead with the same email is not linked; a new
NBD lead is made instead (pinned by a test).

| Piece | Where |
|---|---|
| Pure rules (terms, cents, mode, Checkout params, status map, task, alert) | `functions/care-plan-logic.js` |
| Functions: `carePlanPublic` (onRequest, public), `carePlanWebhook` (onRequest, Stripe), `carePlanAdmin` (onCall, App Check, owner only) | `functions/care-plan.js` |
| stripeWebhook skips care-plan objects | `functions/stripe.js` (every case) |
| Ledger tags care-plan charges `product: 'roof_care_plan'` (not NBD Pro revenue) | `functions/stripe-ledger.js` |
| Rules | `firestore.rules`: `careplans` (tenant read, no client write), `careplan_events` / `careplan_config` (closed), `leads.carePlan` (server-only on CREATE and UPDATE) |
| Tests | `tests/care-plan-2026-10-05.test.js` (node), `tests/firestore-rules.cross-tenant.test.js` (emulator), `tests/stripe-ledger-ingest-2026-09-29.test.js` |

### Data

- `careplans/{id}`, written by the server only:
  - `companyId`, `leadId`, `userId`
  - `status`: `pending` / `active` / `past_due` / `cancelled` / `expired`. `active` and `past_due` count as a member; `past_due` keeps the benefits while Stripe retries the card.
  - `interval` (`year` / `month`), `amountCents`, `currency`
  - `stripeCustomerId`, `stripeSubscriptionId`, `stripeCheckoutSessionId`, `currentPeriodEnd`, `cancelAtPeriodEnd`
  - `activatedAt(Ms)`, `cancelledAt`
  - `disclosureVersion`, `disclosureText`, `termsAcceptedAt`
  - `inviteTokenHash`, `inviteExpiresAtMs` (CRM invites only; the hash is removed once the customer joins)
  - copies of the member's name, email, phone and address for the list
- `leads/{id}.carePlan = { carePlanId, status, member, interval, since, renewsAt, endsAt }`. This is the mirror the badge, the discount and the storm ordering read. Clients cannot set it (rules).
- `leads/{id}/tasks/careplan_{id}_y{n}` holds the yearly inspection task:
  - year 1 is due 14 days after joining
  - each later year is due on the anniversary and is created on the first `invoice.paid` of that membership year
  - the id is deterministic, so the task is never duplicated
- `email_queue/careplan-joined-{id}`: ONE alert to Jo when someone joins. Nothing goes to the homeowner except Stripe's own receipt.

### Checkout (both paths go through `carePlanPublic`)

- Checkout Session in `mode: 'subscription'`:
  - inline `price_data` (19900 or 1900 cents) on product `nbd_roof_care_plan`
  - the product is created lazily the first time and is idempotent (custom product id; "already exists" counts as success). No live-mode script.
- `metadata.nbdProduct = 'roof_care_plan'` (with `carePlanId`, `leadId`, `companyId`) goes on the session AND on `subscription_data`.
- **No `client_reference_id`.** stripeWebhook reads that field as an NBD Pro account uid, so a care-plan session carrying it would grant a CRM plan.
- The renewal disclosure shows on Stripe's pay button (`custom_text.submit`) and is recorded on the membership. The page must also show it, with a required consent box (PR 3).
- **Path (a), the public page.** The visitor gives name, email, phone and address.
  - The lead is linked by email, then by `phoneDigits`, inside NBD only.
  - If none matches, a lead is created with the bridge's own mapper: `phoneDigits`, `companyId`, stage New, source "Website — Roof Care Plan".
  - The defences are the public-intake ones: Turnstile, a per-IP limit (10 per 10 minutes, IPv6 /64), and the honeypot. App Check is not used, because `onRequest` cannot enforce it.
- **Path (b), a CRM invite.**
  - `carePlanAdmin {action:'invite', leadId}` returns `https://nobigdealwithjoedeal.com/services/roof-care-plan?invite=<token>`. The link lasts 30 days and is reusable until the customer pays. Only its SHA-256 is stored.
  - Jo sends it from his own phone or email. The server sends nothing.
  - The page opens a checkout for that customer.
- **Cancel anytime:**
  - The success page carries `session_id`. `carePlanPublic {action:'portal', sessionId}` then opens the Stripe Customer Portal, with cancel enabled at period end: no further charges, and the member keeps the time already paid.
  - The portal configuration is created lazily and its id is stored in `careplan_config/stripe`.
  - The portal works **in every mode**, so cancelling never goes dark.
  - Jo can also get a member's portal link from the CRM (`action:'portal'`).

### Webhook

`carePlanWebhook` is its **own Stripe endpoint** with its own signing secret (`STRIPE_CAREPLAN_WEBHOOK_SECRET`).

- It answers 503 until that secret holds a real `whsec_`.
- Idempotency marker: `careplan_events/{eventId}`. It is a separate collection from `stripe_events`, which stripeWebhook and invoiceWebhook already share. The marker is dropped on failure so that Stripe's retry runs again.
- Every event **re-reads the subscription from Stripe** and writes its current state. Out-of-order or late events therefore converge; a stale "active" cannot bring back a cancelled plan (pinned).
- Objects without the tag are ignored, and so is metadata naming another company or a lead that disagrees.
- Events to enable on the endpoint:
  - `checkout.session.completed`
  - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
  - `invoice.paid`, `invoice.payment_failed`

## The dark switch

`CARE_PLAN_MODE` in `functions/.env.nobigdeal-pro` (committed as `off`):

| Mode | What happens |
|---|---|
| `off` (or unset, or anything unrecognised) | Nothing sells. The page keeps "Get My Care Plan" → contact. The CRM shows nothing new. Cancelling through the portal still works. |
| `test` | CRM invite links work. The page shows checkout only with `?preview=careplan`. This is for Jo's own real $19 test. |
| `live` | The page sells to everyone. |

## Build plan (3 PRs)

1. **Data model, rules, Stripe checkout and webhook functions, tests** (this note's PR).
2. **CRM surfaces:**
   - the member badge (kanban card + customer header)
   - a "Care Plan members" list
   - "Add to Care Plan" on the customer page, which mints the invite and offers Copy / Text / Email buttons that open Jo's own apps
   - the inspection task (already made by the webhook)
   - members first on the existing storm lists
   - the visible "Roof Care Plan member — 10% off repairs" line on repair estimates only, with pricing tests (rule e)
3. **Public page checkout** behind the mode: plan picker, the renewal disclosure + required consent box, Turnstile, the success/cancel states and the "Manage or cancel" button. While `off` (or `test` without the preview flag), "Get My Care Plan" still goes to contact.

## Turning it on (Jo)

1. **Stripe Dashboard → Developers → Webhooks → Add endpoint.**
   - URL: `https://us-central1-nobigdeal-pro.cloudfunctions.net/carePlanWebhook`
   - Events: the six listed above
   - Copy its signing secret (`whsec_…`).
2. `firebase functions:secrets:set STRIPE_CAREPLAN_WEBHOOK_SECRET`, then paste it.
3. Set `CARE_PLAN_MODE=test` in `functions/.env.nobigdeal-pro` (a one-line PR) and let it deploy.
4. Do the real $19 test below. Then set `CARE_PLAN_MODE=live`.

## Jo's test (real money, $19)

1. In `test` mode, open `/services/roof-care-plan?preview=careplan`.
2. Choose **monthly**, tick the terms, and pay $19 with your own card.
3. Check that:
   - the CRM lead has the member badge
   - a "yearly inspection (first visit)" task is due in two weeks
   - an alert email reached jd@
   - Stripe shows the subscription
   - the Stripe ledger row is tagged Roof Care Plan, not NBD Pro
4. Click "Manage or cancel" on the thank-you page and cancel. The membership should show "ends <date>", and after Stripe ends it (or after you cancel immediately in the Dashboard) it should show not a member.
5. Refund the $19 in the Stripe Dashboard if you want it back.
6. From the CRM, "Add to Care Plan" on a test lead. Open the link from your phone and confirm checkout opens for that customer. You do not need to pay this time.

## Risks and open items

- **The unmanaged Cloudflare-Worker webhook** on NBD's Stripe account also listens to `checkout.session.completed`. It is not in the repo, so what it does with a care-plan session is unknown (it may email or write something). Care-plan sessions are identifiable by `metadata.nbdProduct = 'roof_care_plan'`, and our handler is idempotent and independent of it. **Jo: check that worker before going live, or have it ignore that tag.**
- **Refunds and proration are not stated** on the page. The portal cancels at period end: no further charges and no partial refund. If Jo wants prorated refunds for yearly members, that is a portal setting and a copy change.
- Stripe sends the receipt and the renewal emails. Whether those are on depends on Jo's Stripe Dashboard email settings.
- The same email paying twice is refused only when a member membership already exists for that lead. Two different emails for one house make two memberships.
