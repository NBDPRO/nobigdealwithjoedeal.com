/**
 * functions/stripe.js — Stripe Cloud Functions.
 *
 * L-03 continuation. Six handlers extracted verbatim from
 * functions/index.js: createCheckoutSession, stripeWebhook,
 * createCustomerPortalSession, getSubscriptionStatus,
 * createStripePaymentLink, invoiceWebhook.
 *
 * index.js loads this via `Object.assign(exports, require('./stripe'))`
 * — same pattern used for functions/portal.js (L-03).
 *
 * No behaviour change. Every handler keeps its exact config
 * (maxInstances, concurrency, timeoutSeconds, minInstances, memory,
 * secrets, cors) and body. NOTE: the onRequest handlers here previously
 * also carried `enforceAppCheck: true`, which firebase-functions honours on
 * onCall ONLY. It was removed 2026-08-02 as dead config — these endpoints
 * are gated by Stripe webhook signature verification and per-IP limits, not
 * by App Check. See handlers/ai.js for the full write-up.
 */

'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue } = require('firebase-admin/firestore');
// Kentucky insurance-job payment hold (KRS 367.626) — byte-identical copy of
// docs/pro/js/ky-insurance-law.js.
const KyLaw = require('./ky-insurance-law');
// Lazy require (2026-08-07): the stripe SDK is ~20 MB of parse weight that
// every deployed function paid at cold start (index.js pulls this module
// eagerly). Required on first client construction instead.
let Stripe = null;

// Pin the Stripe API version explicitly. stripe-node 14.x defaults to
// '2023-10-16'; without an explicit pin, bumping the SDK (e.g. #654 → v22)
// would silently change the API version every request uses — altering webhook
// event shapes + checkout behavior on the LIVE billing path. Pinning to the
// version we already run makes any SDK upgrade behavior-neutral; a deliberate
// API-version upgrade is then a separate, testable change.
const STRIPE_API_VERSION = '2023-10-16';

// ═══════════════════════════════════════════════════════════════════════
// WHERE THE MONEY GOES — read this before touching the gate.
// ═══════════════════════════════════════════════════════════════════════
// Stripe here serves TWO different money flows through ONE client on the
// PLATFORM's secret key:
//
//   1. Subscription billing — a contractor paying us for NBD Pro. The money is
//      ours. Correct on the platform key. Untouched by this gate.
//   2. Invoice payment links — a contractor's HOMEOWNER paying the CONTRACTOR
//      for a roof. That money is the contractor's. It is NOT ours to collect.
//
// REWRITTEN 2026-07-3x (Connect phase 3). The premise this block used to carry
// — "there is no Stripe Connect in this codebase, grep and see" — is now FALSE,
// deliberately. Flow 2 used to settle every tenant's customer payments into the
// PLATFORM balance, correct while we were the only tenant but not one minute
// after anyone else could sign up. The reasons were never cosmetic:
//   - chargebacks hit our account and our dispute rate, for work we did not do
//   - the 1099-K reports their revenue as ours
//   - collecting funds on behalf of other businesses is regulated activity;
//     Connect exists precisely so a platform doesn't have to be licensed for it
//   - we would owe every contractor a manual payout, forever
//
// So createStripePaymentLink now mints a DESTINATION charge for a tenant whose
// connectAccounts/{companyId} mirror satisfies mayCollectOnline() AND who holds
// a live subscription — that money settles into THEIR account, net of the
// platform fee. The platform tenant keeps minting on the platform account,
// fee-free. Everyone else is still refused (403) and collects via markPaid.
//
// DO NOT relax the refusal to "warn and continue". Minting the link is the act
// that takes the money; a warning the rep clicks past does not change where it goes.
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

// True only for the platform tenant. Solo convention is companyId == owner uid,
// so accept either the claim or the raw uid — a platform admin operating without
// a companyId claim must not be locked out of our own invoicing.
function isPlatformTenant(decoded) {
  if (!decoded) return false;
  const companyId = decoded.companyId || null;
  return decoded.uid === NBD_OWNER_UID || companyId === NBD_OWNER_UID;
}

const connectLogic = require('./stripe-connect-logic');

// D6: Connect-routed mints additionally require a LIVE subscription. Same
// status set as createCheckoutSession's double-bill guard — which keeps its
// OWN in-function copy: the LIVE_SUB_STATUS literal there is pinned INSIDE
// that block by tests/gauntlet-regressions.test.js:995-1004, so do NOT
// hoist/deduplicate. Deliberately NOT shared.js requirePaidSubscription
// (shared.js:132-135): that helper excludes past_due/unpaid/incomplete —
// but a dunning tenant still holds a chargeable sub and must keep
// collecting from homeowners (rule: checkout-gate-live-sub-not-entitlement).
// Consequence, accepted: access-code/free tenants (no stripeSubscriptionId)
// cannot Connect-mint even when fully onboarded.
const CONNECT_MINT_LIVE_SUB = { active: 1, trialing: 1, past_due: 1, unpaid: 1, incomplete: 1 };
function hasLiveSubscription(sub) {
  const s = sub || {};
  return !!(s.stripeSubscriptionId && CONNECT_MINT_LIVE_SUB[String(s.status)]);
}

// Shared helpers (B2).
const { requireAuth, viewOnlyRefusal } = require('./shared');
const { httpRateLimit } = require('./integrations/upstash-ratelimit');
const stageRoles = require('./stage-roles');

// setCustomUserClaims REPLACES the entire claim set. Writing a bare billing
// patch ({ plan, subscriptionStatus, stripeCustomerId }) therefore WIPES a
// user's role/companyId on every billing event — turning a tenant company_admin
// into a no-companyId account, which (a) breaks their own company-scoped
// Firestore access and (b) makes them a cross-tenant takeover target for the
// team-admin callables. Always read-then-merge so identity claims survive.
async function mergeCustomClaims(uid, patch) {
  // Read-then-merge is only safe when the READ succeeds. On a transient getUser
  // failure, writing a bare patch would strip role/companyId — the exact wipe
  // this helper exists to prevent — so abort and let the next billing event
  // re-sync (the subscriptions/{uid} doc is written separately and survives).
  let existing;
  try { existing = (await getAuth().getUser(uid)).customClaims || {}; }
  catch (e) {
    logger.error('mergeCustomClaims_abort_getUser_failed', { uid, err: e.message });
    return;
  }
  await getAuth().setCustomUserClaims(uid, { ...existing, ...patch });
}

// Stripe secrets. Redeclared here because defineSecret scope is
// per-module. index.js still declares them too for claudeProxy +
// other endpoints. Both declarations resolve to the SAME underlying
// Secret Manager entry — no duplication at runtime.
const STRIPE_SECRET_KEY         = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET     = defineSecret('STRIPE_WEBHOOK_SECRET');
// Stripe issues a DISTINCT signing secret per webhook endpoint, but both
// endpoints used to verify against the single STRIPE_WEBHOOK_SECRET — so the
// moment that secret was set to the subscription endpoint's whsec, every
// invoiceWebhook delivery would fail verification forever. invoiceWebhook now
// prefers this dedicated secret and falls back to the legacy shared one while
// the value is still the PENDING-ROTATION placeholder (2026-07-16).
const STRIPE_INVOICE_WEBHOOK_SECRET = defineSecret('STRIPE_INVOICE_WEBHOOK_SECRET');
const STRIPE_PRICE_FOUNDATION   = defineSecret('STRIPE_PRICE_FOUNDATION');
const STRIPE_PRICE_PROFESSIONAL = defineSecret('STRIPE_PRICE_PROFESSIONAL');
// Team ($149/mo, 2 seats) — the mid-tier between Starter and Growth. Set this
// secret to the Team recurring Stripe Price ID after creating the product.
const STRIPE_PRICE_TEAM         = defineSecret('STRIPE_PRICE_TEAM');

// Slack alert webhook — IMPORTED, never re-declared. Both webhooks in this
// file post to Slack (the E1 dunning wing and alertInvoicePaymentEvent), and
// neither declared this secret until 2026-07-30, so at runtime
// process.env.SLACK_WEBHOOK_URL was undefined, hasSecret() was false, and
// EVERY postSlack call returned { posted:false, reason:'unconfigured' } and
// was discarded — the #1146 audit's findings 1 + 11. A second local
// defineSecret('SLACK_WEBHOOK_URL') would bind the env var but leave
// integrations/_shared.js's hasSecret()/getSecret() reading THEIR param
// object, so take the registry's object itself and there is only ever one.
// NOTE (2026-07-30): binding alone does not deliver anything — prod's
// SLACK_WEBHOOK_URL still holds only the deploy workflow's '__unset__' stub
// version, which hasSecret() also treats as unconfigured. Slack stays dark
// until the owner runs `firebase functions:secrets:set SLACK_WEBHOOK_URL`.
// That is exactly why the owner-facing copy must ALSO have an email channel
// (alertInvoicePaymentEvent's ownerUid) and not live in slackBlocks alone.
const { SECRETS: INTEGRATION_SECRETS } = require('./integrations/_shared');

// ── Shared Stripe client ────────────────────────────────────────────
// Single source for the SDK instance across all 5 handlers (was a separate
// `new Stripe(SECRET.value(), …)` in each). Two things this centralizes:
//   1. TRIM the secret key. A stored STRIPE_SECRET_KEY with a trailing newline
//      (how it got pasted into Secret Manager) made the SDK throw ERR_INVALID_CHAR
//      setting the Authorization header → surfaced as an opaque "An error
//      occurred with our connection to Stripe. Request was retried N times" 500,
//      which looks like a Stripe outage but is purely the tainted key. .trim()
//      kills it. (Supersedes the per-site trim in draft PR #711.)
//   2. maxNetworkRetries + a bounded timeout so a transient network blip
//      self-heals instead of bubbling up as a 500.
// Memoized: the key is constant per deployment, so one client is reused across
// warm invocations. value() is read lazily (inside the handler, where the secret
// is bound) — never at module load.
let _stripeClient = null;
function getStripe() {
  if (_stripeClient) return _stripeClient;
  const raw = STRIPE_SECRET_KEY.value();
  const key = String(raw == null ? '' : raw).trim();
  if (!key) throw new Error('STRIPE_SECRET_KEY is empty/unset');
  Stripe = Stripe || require('stripe');
  _stripeClient = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20000,
  });
  return _stripeClient;
}

// CORS origins — same allowlist as index.js + portal.js. Deliberately
// duplicated for module independence (matches portal.js precedent).
const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// ── Plan + purchased-seat derivation from a subscription's line items ──
// Both webhook cases used to read items.data[0] only. That breaks the moment
// a subscription carries a SECOND line item (the per-seat add-on, Route 1):
// if the seat item happens to sort first, checkout.session.completed derives
// "unknown price" and silently DOWNGRADES a paying tenant to starter, and
// customer.subscription.updated freezes them on the stale stored plan.
// Scan every item instead: the item whose price is in PRICE_TO_PLAN names the
// plan; every OTHER item's quantity is a purchased extra seat. This read path
// needs no seat-price secret — it works by exclusion, so it deploys before
// STRIPE_PRICE_SEAT exists and stays correct after.
// `priceToPlan` is passed in because the map is built per-request from
// secrets (.value() only resolves inside a handler).
function derivePlanAndSeats(items, priceToPlan) {
  const data = items && Array.isArray(items.data) ? items.data : [];
  let plan = null;
  let purchasedSeats = 0;
  for (const item of data) {
    const priceId = item && item.price && item.price.id;
    const mapped = priceId ? priceToPlan[priceId] : undefined;
    if (mapped) {
      // First plan-price item wins; a duplicate plan item is anomalous and
      // must never be counted as seats.
      if (!plan) plan = mapped;
    } else {
      const qty = Math.floor(Number(item && item.quantity));
      if (Number.isFinite(qty) && qty > 0) purchasedSeats += qty;
    }
  }
  return { plan, purchasedSeats };
}

exports.createCheckoutSession = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [STRIPE_SECRET_KEY, STRIPE_PRICE_FOUNDATION, STRIPE_PRICE_PROFESSIONAL, STRIPE_PRICE_TEAM],
    // Explicit public ingress: browser fetch calls this directly. Declared in
    // code so a redeploy can never drop the allUsers run.invoker binding again
    // (2026-07-16: stripewebhook/getsubscriptionstatus/createcustomerportalsession
    // shipped with EMPTY invoker IAM and 403'd every request pre-handler).
    // Auth stays enforced in-code (requireAuth / Stripe signatures).
    invoker: 'public',
    // R-05 sizing: conversion funnel spike — if 10k trial users are
    // prompted to subscribe at once (email campaign, end-of-trial
    // cron), the checkout click-through rate of 5-10% still maps to
    // 500-1000 concurrent checkout creates. Old 20×40 = 800 was
    // right at the edge; 50×40 = 2000 gives 2× headroom. Stripe
    // API latency (~400ms) keeps instances busy briefly per call.
    maxInstances: 50,
    concurrency: 40,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Per-IP rate limit — 10 checkout sessions / hour from a single IP.
    if (!(await httpRateLimit(req, res, 'createCheckoutSession:ip', 10, 3_600_000))) return;

    const authResult = await requireAuth(req);
    if (authResult.error) { res.status(authResult.error.status).json(authResult.error.body); return; }
    const { decoded } = authResult;
    // 2026-09-25 (decision B): a viewer is read-only — no plan purchase for
    // the company (the subscription is keyed to companyId below).
    const viewOnly = viewOnlyRefusal(decoded);
    if (viewOnly) { res.status(viewOnly.status).json(viewOnly.body); return; }
    if (!decoded.email) { res.status(401).json({ error: 'Account has no email' }); return; }
    // Unverified email no longer blocks checkout: the ID token already proves
    // account ownership, Stripe's hosted checkout re-collects the receipt
    // email, and the hard 403 sat exactly at the moment of buying intent — a
    // fresh signup couldn't pay until they went hunting for the verification
    // email (product audit 2026-07, funnel break #3). Logged for visibility.
    if (!decoded.email_verified) {
      logger.info('createCheckoutSession_unverified_email_proceeding', { uid: decoded.uid });
    }

    try {
      const { plan } = req.body;

      // Validate plan — accept both old names (foundation/professional)
      // and new names (starter/growth) for backwards compatibility
      const VALID_PLANS = ['foundation', 'professional', 'starter', 'team', 'growth'];
      if (!VALID_PLANS.includes(plan)) {
        res.status(400).json({ error: 'Invalid plan. Must be starter, team, growth, foundation, or professional.' });
        return;
      }
      // Normalize old names → new names for consistent storage (team is already canonical).
      const normalizedPlan = plan === 'foundation' ? 'starter' : (plan === 'professional' ? 'growth' : plan);
      // Remove the "free subscription while checkout is open" loophole — any prior
      // client-side self-write to subscriptions gets overwritten on webhook return
      // anyway, but the rules now block client writes entirely.

      // Get price ID based on plan
      // Maps both old and new plan names to Stripe Price IDs.
      // STRIPE_PRICE_FOUNDATION = Starter ($99/mo), STRIPE_PRICE_PROFESSIONAL =
      // Growth ($299/mo — the price sold on /pro/pricing and in the Terms table;
      // the Stripe price object is the charged truth, keep them in sync).
      const priceId = normalizedPlan === 'starter' ? STRIPE_PRICE_FOUNDATION.value()
        : normalizedPlan === 'team' ? STRIPE_PRICE_TEAM.value()
        : STRIPE_PRICE_PROFESSIONAL.value();

      // Billing is keyed to the COMPANY, not the purchaser (locked decision:
      // subscriptions/{companyId}). For solo owners companyId == uid; for a
      // company_admin buying on the owner's behalf this keeps the entitlement
      // on the company doc that nbd-auth/billing-gate/trackUsage actually read,
      // instead of stranding it under the admin's own uid.
      const billingKey = decoded.companyId || decoded.uid;

      // DOUBLE-BILL GUARD (server chokepoint). #977 gates the billing-tab
      // client-side, but the pricing-page plan-intent auto-resume
      // (#975/#976/#978) reaches this endpoint without that guard: a tenant
      // with a live Stripe sub who completes a second Checkout mints a SECOND
      // subscription, and the webhook's merge-set then overwrites
      // stripeCustomerId/stripeSubscriptionId on subscriptions/{billingKey} —
      // orphaning the first sub (still charging, unreachable via the portal).
      // Same statuses as the client rule: dunning states still hold a
      // chargeable sub, so they must use the portal, never a fresh Checkout.
      // Docs without a stripeSubscriptionId (free seed {status:'none'},
      // access-code comps, cancelled-and-cleared) pass — buying is their
      // legitimate path in.
      const LIVE_SUB_STATUS = { active: 1, trialing: 1, past_due: 1, unpaid: 1, incomplete: 1 };
      const guardSnap = await getFirestore().doc('subscriptions/' + billingKey).get();
      const guardSub = guardSnap.exists ? (guardSnap.data() || {}) : {};
      if (guardSub.stripeSubscriptionId && LIVE_SUB_STATUS[String(guardSub.status)]) {
        logger.info('checkout_blocked_live_sub', { uid: decoded.uid, billingKey, status: guardSub.status });
        res.status(409).json({
          error: 'already_subscribed',
          message: 'This company already has an active subscription. Manage or change your plan from Dashboard → Settings → Billing.',
        });
        return;
      }

      // Initialize Stripe
      const stripe = getStripe();

      // Create Checkout Session
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        success_url: `https://nobigdealwithjoedeal.com/pro/stripe-success.html?session_id={CHECKOUT_SESSION_ID}&plan=${normalizedPlan}`,
        cancel_url: 'https://nobigdealwithjoedeal.com/pro/pricing.html?cancelled=true',
        client_reference_id: billingKey,
        customer_email: decoded.email,
        metadata: {
          firebaseUid: decoded.uid,
          companyId: billingKey,
          plan: normalizedPlan,
        },
        // 14-day trial on the paid team tiers (Team + Growth). Hosted Checkout
        // still collects a card up front (payment_method_collection defaults to
        // 'always'); the pricing page copy matches. Starter has no trial.
        ...((normalizedPlan === 'growth' || normalizedPlan === 'team') ? {
          subscription_data: { trial_period_days: 14 }
        } : {}),
      });

      logger.info('checkout_session_created', { sessionId: session.id, uid: decoded.uid, plan });

      res.json({ url: session.url });

    } catch (e) {
      logger.error('createCheckoutSession error', { err: e.message });
      if (e.code === 'auth/id-token-expired') {
        res.status(401).json({ error: 'Token expired — please re-authenticate' });
      } else {
        res.status(500).json({ error: 'Failed to create checkout session' });
      }
    }
  }
);

exports.stripeWebhook = onRequest(
  {
    cors: false, // Webhook should not use CORS
    // Stripe's servers call this unauthenticated — public ingress is
    // REQUIRED. Declared in code because this service shipped with an
    // empty invoker IAM policy (2026-07-16): every Stripe delivery
    // 403'd at Google's front door and no subscription was ever
    // activated. Security = signature verification below, not IAM.
    invoker: 'public',
    // F-08: price secrets are read inside the handler to map
    // Stripe Price IDs to our plan tier. Must be declared here
    // so .value() resolves at runtime.
    // SLACK_WEBHOOK_URL: the E1 dunning wing below posts to Slack. Without
    // the declaration that post was a guaranteed no-op (see the import).
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
              STRIPE_PRICE_FOUNDATION, STRIPE_PRICE_PROFESSIONAL, STRIPE_PRICE_TEAM,
              INTEGRATION_SECRETS.SLACK_WEBHOOK_URL],
    // R-05 sizing: Stripe's retry fanout (up to 15 retries over 3
    // days on failure) + bulk billing cycle events (invoice.paid
    // fires for every active sub on billing day) can burst. Old
    // maxInstances:10 was enough for steady state but tight for
    // month-start. 20 with Cloud Run's default concurrency (80)
    // gives headroom for a few hundred concurrent webhook deliveries.
    maxInstances: 20,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const stripe = getStripe();
    const sig = req.headers['stripe-signature'];
    // '__unset__' stub → null, never a candidate. Bare .value() has no such
    // guard — if this secret is ever unbound in prod, '__unset__' would be
    // handed to constructEvent as the HMAC key, and anyone who signs a
    // payload with that PUBLIC, documented literal would pass verification.
    // Fail closed instead, same posture as every sibling webhook verifier
    // (invoiceWebhook below, calcomWebhook, thumbtackWebhook, swathWebhook,
    // measurementWebhook, esign's webhook).
    const { secretValue } = require('./integrations/_shared');
    const webhookSecret = secretValue(STRIPE_WEBHOOK_SECRET);
    if (!webhookSecret) {
      logger.error('stripeWebhook: STRIPE_WEBHOOK_SECRET not set — rejecting unsigned request');
      res.status(503).json({ error: 'Webhook not configured' });
      return;
    }

    // H-6: Stripe requires the RAW request body for signature
    // verification. If rawBody is missing (middleware re-parsed as
    // JSON, body-parser mounted before onRequest, etc.) we MUST
    // reject rather than fall back to req.body — the fallback would
    // either never verify OR accept a forged event if the signature
    // library is lenient. Explicit check + explicit tolerance.
    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      logger.error('stripeWebhook missing rawBody — misconfigured middleware');
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (typeof sig !== 'string' || !sig.length) {
      res.status(400).json({ error: 'Missing Stripe signature' });
      return;
    }

    let event;
    try {
      // 300s tolerance is Stripe's default; setting it explicitly so
      // it's not silently widened by a future SDK upgrade.
      event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret, 300);
    } catch (e) {
      logger.error('stripeWebhook signature verification failed', { err: e.message });
      res.status(400).json({ error: 'Webhook signature verification failed' });
      return;
    }

    try {
      const db = getFirestore();

      // ── Idempotency guard ──
      // Stripe retries webhooks up to 15 times. F-07: the previous
      // check-then-write pattern left a window where two concurrent
      // deliveries of the same event.id could both pass the exists()
      // check and both process. Use create() — atomic, fails if the
      // doc already exists.
      const eventRef = db.doc(`stripe_events/${event.id}`);
      try {
        await eventRef.create({
          type: event.type,
          processedAt: FieldValue.serverTimestamp()
        });
      } catch (e) {
        // code 6 = ALREADY_EXISTS. Duplicate delivery — ack Stripe so
        // it stops retrying, but do nothing else.
        if (e.code === 6 || /already exists/i.test(String(e.message))) {
          logger.info('stripeWebhook.duplicate_event', { eventId: event.id });
          res.json({ received: true, duplicate: true });
          return;
        }
        throw e;
      }

      // ═══════════════════════════════════════════════════
      // PLAN TIER EXTRACTION HELPER
      // Maps Stripe Price IDs to NBD plan tiers. The IDs
      // are set as Firebase secrets. Unknown prices fall
      // back to 'starter'. NOTE: Enterprise has NO Stripe
      // path at all — custom-priced deals are granted by a
      // manual admin write of subscriptions/{companyId}
      // (plan:'enterprise') + claims; nothing here can mint
      // an enterprise plan (metadata allowlist below is
      // starter/growth only).
      // Hoisted out of the switch (was previously inline in
      // customer.subscription.updated only — see F-08) so
      // checkout.session.completed can apply the same
      // price-ID-trusted derivation (Audit G).
      // ═══════════════════════════════════════════════════
      const PRICE_TO_PLAN = {
        [STRIPE_PRICE_FOUNDATION.value()]:   'starter',
        [STRIPE_PRICE_TEAM.value()]:         'team',
        [STRIPE_PRICE_PROFESSIONAL.value()]: 'growth'
      };

      switch (event.type) {

        case 'checkout.session.completed': {
          const session = event.data.object;
          const uid = session.client_reference_id;
          const customerId = session.customer;

          if (!uid) {
            logger.warn('stripeWebhook.checkout_session_completed missing client_reference_id');
            break;
          }

          // Audit G: derive plan from the Stripe Price ID, not from
          // session.metadata. F-08 already flagged this trust pattern
          // for customer.subscription.updated; it applied just as much
          // to checkout.session.completed but the fix wasn't carried
          // forward. Stripe Dashboard metadata is editable by anyone
          // with Stripe write access, so trusting metadata.plan for
          // tier grants made a free "enterprise" promotion one click
          // away. Price IDs are immutable secrets known only to deploy.
          //
          // Fall back to metadata.plan only if the subscription lookup
          // fails AND the value is one we'd accept (defensive — should
          // never happen for a real checkout session, but better than
          // silently downgrading a paying customer to 'starter').
          let plan = 'starter';
          // Real Stripe status, not an 'active' literal: a Growth checkout
          // starts a 14-day trial, so the true status is 'trialing' until the
          // first charge. Both count as paid everywhere (nbd-auth treats
          // active+trialing identically); writing the truth keeps the client
          // badge honest and spares a confusing flip on the first
          // subscription.updated event. Unknown/failed lookup → 'active'
          // (errs in the customer's favor).
          let subStatus = 'active';
          // Per-seat add-ons (Route 1): extra rep seats bought as additional
          // subscription-item quantity. Derived by exclusion (non-plan items),
          // persisted on the sub doc so the invite/assign/lapse cap sites can
          // grant base + purchased without any Stripe read.
          let purchasedSeats = 0;
          try {
            if (session.subscription) {
              const sub = await stripe.subscriptions.retrieve(session.subscription, {
                expand: ['items.data.price']
              });
              if (sub.status === 'trialing' || sub.status === 'active') subStatus = sub.status;
              const derived = derivePlanAndSeats(sub.items, PRICE_TO_PLAN);
              if (derived.plan) {
                plan = derived.plan;
                purchasedSeats = derived.purchasedSeats;
                // Tripwire: until the per-seat charging path (Route 1b)
                // ships, our checkout mints single-item subs only — any
                // nonzero here means an unexpected extra line item.
                if (purchasedSeats > 0) {
                  logger.info('purchased_seats_derived', { uid, purchasedSeats, sessionId: session.id });
                }
              } else {
                logger.warn('stripeWebhook.checkout_session_completed unknown_price', {
                  uid, priceId: sub.items?.data?.[0]?.price?.id || '', sessionId: session.id
                });
              }
            }
          } catch (e) {
            logger.warn('stripeWebhook.checkout_session_completed sub_lookup_failed', {
              uid, sessionId: session.id, err: e.message
            });
            // Fall back to metadata ONLY for the small allowlist we mint.
            const ALLOWED_FROM_METADATA = new Set(['starter', 'team', 'growth']);
            const meta = session.metadata?.plan;
            if (ALLOWED_FROM_METADATA.has(meta)) plan = meta;
          }

          const subData = {
            plan,
            status: subStatus,
            purchasedSeats,
            stripeSessionId: session.id,
            stripeCustomerId: customerId,
            stripeSubscriptionId: session.subscription || null,
            source: 'checkout',
            // Clear any lapse state — a fresh subscription ends the pause
            // lifecycle (cancelledAt survives merge writes otherwise and
            // the enforcement cron keys off it).
            lapseEnforced: false,
            cancelledAt: FieldValue.delete(),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            // Usage counters — reset on subscription start
            usage: { leads: 0, reports: 0, aiCalls: 0, cycleStart: new Date().toISOString() }
          };

          // Seed/advance the subscription.updated ordering high-water mark
          // (see the customer.subscription.updated case below for the full
          // rationale). checkout.session.completed and subscription.updated
          // deliveries for the SAME subscription race independently — Stripe
          // retries a transiently-failed checkout event on its own schedule,
          // which can arrive AFTER a later subscription.updated already
          // advanced the watermark past this event's created time. Writing
          // this event's timestamp unconditionally would then REWIND the
          // watermark, letting a still-later stale event slip through the
          // updated-case guard. Take the max of what's already stored and
          // this event's timestamp, never overwrite backwards.
          const priorSnap = await db.doc(`subscriptions/${uid}`).get();
          const priorLastEvent = typeof priorSnap.get('lastSubEventAt') === 'number'
            ? priorSnap.get('lastSubEventAt') : 0;
          const thisEventCreated = typeof event.created === 'number' ? event.created : 0;
          subData.lastSubEventAt = Math.max(priorLastEvent, thisEventCreated) || FieldValue.delete();

          await db.doc(`subscriptions/${uid}`).set(subData, { merge: true });

          // Reactivation after a lapse: restore exactly the seats the lapse
          // cron paused (deactivatedReason 'lapse'); owner-deactivated
          // members stay off. Non-fatal — a failure here must never break
          // subscription activation itself.
          try {
            const { reactivateLapsedSeats } = require('./lapse-enforcement');
            // Pass the new plan so a downgrade-on-return (e.g. Growth lapse →
            // Starter re-subscribe) restores only up to the new seat cap
            // instead of every previously-paused rep. purchasedSeats widens
            // that cap by the seats the tenant is still paying for.
            await reactivateLapsedSeats(db, uid, plan, purchasedSeats);
          } catch (e) {
            logger.warn('lapse_reactivation_failed', { uid, err: e.message });
          }

          // ── Set Firebase Auth custom claims ──
          // These claims are available in Firestore security rules
          // via request.auth.token.plan and in client JS via
          // user.getIdTokenResult().claims.plan
          try {
            await mergeCustomClaims(uid, {
              plan,
              subscriptionStatus: subStatus,
              stripeCustomerId: customerId
            });
            logger.info('custom_claims_set', { uid, plan });
          } catch (claimErr) {
            logger.error('custom_claims_failed', { uid, err: claimErr.message });
          }

          logger.info('subscription_activated', { uid, plan, sessionId: session.id });
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object;
          const customerId = subscription.customer;

          const snapshot = await db
            .collection('subscriptions')
            .where('stripeCustomerId', '==', customerId)
            .limit(1)
            .get();

          if (snapshot.empty) {
            logger.warn('stripeWebhook.subscription_updated no matching user', { customerId });
            break;
          }

          const subDoc = snapshot.docs[0];
          const uid = subDoc.id;
          const stored = subDoc.data() || {};

          // Event-ordering guard (Route 1b). Stripe does NOT guarantee webhook
          // delivery order. Two rapid subscription changes — e.g. the seat
          // stepper going 3 → 5 — can arrive reversed; without this, the stale
          // event's line-item snapshot overwrites the fresh one and the tenant
          // pays for 5 seats but is granted 3 (or the reverse: 3 paid, 5
          // granted) until the NEXT subscription event, possibly the monthly
          // renewal. Skip any event older than the newest we've applied to this
          // doc. event.created is unix seconds; same-second ties still process
          // (human-paced clicks + a confirm dialog never tie), and the stamp is
          // written in the same update() below so it advances monotonically.
          const eventCreated = typeof event.created === 'number' ? event.created : 0;
          const lastApplied = typeof stored.lastSubEventAt === 'number' ? stored.lastSubEventAt : 0;
          if (eventCreated && eventCreated < lastApplied) {
            logger.info('stripeWebhook.subscription_updated stale_event_skipped',
              { uid, eventCreated, lastApplied });
            break;
          }

          // F-08: derive plan from Stripe Price ID via the hoisted
          // PRICE_TO_PLAN map at the top of the switch (Audit G
          // promoted it so checkout.session.completed can apply the
          // same defense). Stripe metadata is editable in the
          // dashboard — trusting it for authorization puts tier grants
          // one click from anyone with Stripe write access. Price IDs
          // are immutable secrets known only to deploy.
          // Scans ALL line items (not [0]) so a per-seat add-on item can
          // never shadow the plan price; its quantity syncs purchasedSeats
          // (this event fires on every seat-quantity change).
          const derived = derivePlanAndSeats(subscription.items, PRICE_TO_PLAN);
          const plan = derived.plan || stored.plan || 'starter';
          // No recognizable plan price (secret rotation mid-flight, foreign
          // sub) → keep the stored seat count rather than zeroing a
          // paid-for entitlement on ambiguous data.
          const purchasedSeats = derived.plan
            ? derived.purchasedSeats
            : Math.max(0, Number(stored.purchasedSeats) || 0);
          // Tripwire — see checkout.session.completed: nonzero is unexpected
          // until Route 1b's seat-charging callable exists.
          if (purchasedSeats > 0 && purchasedSeats !== stored.purchasedSeats) {
            logger.info('purchased_seats_derived', { uid, purchasedSeats, subscriptionId: subscription.id });
          }

          await subDoc.ref.update({
            plan,
            purchasedSeats,
            status: subscription.status,
            stripeSubscriptionId: subscription.id,
            currentPeriodEnd: subscription.current_period_end
              ? new Date(subscription.current_period_end * 1000).toISOString()
              : null,
            cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
            // Advance the ordering high-water mark so a later-delivered but
            // older-created event is skipped (see the guard above). Preserve
            // the prior mark if this event lacks a created timestamp, so a
            // malformed event can't erase the watermark and reopen the race.
            lastSubEventAt: eventCreated || lastApplied || FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });

          // Sync custom claims
          try {
            await mergeCustomClaims(uid, {
              plan,
              subscriptionStatus: subscription.status,
              stripeCustomerId: customerId
            });
          } catch (e) { logger.warn('claims_update_failed', { uid, err: e.message }); }

          logger.info('subscription_updated', { uid, plan, status: subscription.status });
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object;
          const customerId = subscription.customer;

          const snapshot = await db
            .collection('subscriptions')
            .where('stripeCustomerId', '==', customerId)
            .limit(1)
            .get();

          if (snapshot.empty) {
            logger.warn('stripeWebhook.subscription_deleted no matching user', { customerId });
            break;
          }

          const subDoc = snapshot.docs[0];
          const uid = subDoc.id;
          const stored = subDoc.data() || {};

          // Same event-ordering guard as customer.subscription.updated (Route
          // 1b). Without it, deletion sat OUTSIDE the ordering protocol: a
          // subscription.updated delivery that transiently fails (marker
          // deleted, Stripe retries later) can arrive AFTER a subsequent
          // .deleted has already cancelled the sub — the stale .updated retry
          // would resurrect the cancelled plan/status/purchasedSeats and wipe
          // lapse enforcement. Skip any delete event older than the newest
          // event already applied to this doc; a genuinely out-of-order
          // delete (rare — deletion is terminal) simply waits for Stripe's
          // retry, which redelivers the same terminal state.
          const eventCreated = typeof event.created === 'number' ? event.created : 0;
          const lastApplied = typeof stored.lastSubEventAt === 'number' ? stored.lastSubEventAt : 0;
          if (eventCreated && eventCreated < lastApplied) {
            logger.info('stripeWebhook.subscription_deleted stale_event_skipped',
              { uid, eventCreated, lastApplied });
            break;
          }

          await subDoc.ref.update({
            plan: 'free',
            status: 'cancelled',
            // The Stripe subscription is gone — any per-seat add-on items
            // died with it. Server cap sites already ignore purchasedSeats on
            // a non-entitled sub; clearing it keeps the client mirror honest.
            purchasedSeats: 0,
            // Anchors the lapse grace period (gauntlet batch 2): the daily
            // enforceLapsedSeats cron pauses team seats LAPSE_GRACE_DAYS
            // after this stamp; lapseEnforced is cleared on reactivation.
            cancelledAt: FieldValue.serverTimestamp(),
            lapseEnforced: false,
            // Advance the watermark so a still-later stale .updated retry is
            // caught by the guard above (this event IS the newest applied).
            lastSubEventAt: eventCreated || lastApplied || FieldValue.delete(),
            updatedAt: FieldValue.serverTimestamp(),
          });

          // Downgrade custom claims to free
          try {
            await mergeCustomClaims(uid, {
              plan: 'free',
              subscriptionStatus: 'cancelled',
              stripeCustomerId: customerId
            });
          } catch (e) { logger.warn('claims_downgrade_failed', { uid, err: e.message }); }

          logger.info('subscription_cancelled', { uid });
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const customerId = invoice.customer;

          const snapshot = await db
            .collection('subscriptions')
            .where('stripeCustomerId', '==', customerId)
            .limit(1)
            .get();

          if (snapshot.empty) {
            logger.warn('stripeWebhook.invoice_payment_failed no matching user', { customerId });
            break;
          }

          const subDoc = snapshot.docs[0];
          const uid = subDoc.id;

          await subDoc.ref.update({
            status: 'past_due',
            updatedAt: FieldValue.serverTimestamp(),
          });

          // Update claims to past_due so client can show warning
          try {
            await mergeCustomClaims(uid, {
              plan: subDoc.data().plan || 'free',
              subscriptionStatus: 'past_due',
              stripeCustomerId: customerId
            });
          } catch (e) { logger.warn('claims_pastdue_failed', { uid, err: e.message }); }

          // E1: dunning. Enqueue an email to the rep, Slack the ops
          // channel, and stamp a lead activity row if the invoice
          // has a leadId on its metadata (auto-invoice C5 sets it).
          try {
            const userRecord = await getAuth().getUser(uid);
            const email = userRecord.email;
            const leadId = (invoice.metadata && invoice.metadata.leadId) || null;
            const estimateId = (invoice.metadata && invoice.metadata.estimateId) || null;
            const amount = ((invoice.amount_due || 0) / 100).toFixed(2);

            if (email) {
              await db.collection('email_queue').add({
                to: email,
                subject: 'Payment failed — $' + amount + ' — NBD Pro',
                bodyPlain:
                  'A customer payment attempt just failed.\n\n' +
                  'Invoice: ' + invoice.id + '\n' +
                  'Amount:  $' + amount + '\n' +
                  (invoice.hosted_invoice_url
                    ? 'Link:    ' + invoice.hosted_invoice_url + '\n'
                    : '') +
                  '\nReach out to the customer to update their card. Stripe will auto-retry 3 more times.',
                status: 'pending',   // F-wave fix: worker filters on this field
                createdAt: FieldValue.serverTimestamp(),
                source: 'stripe_dunning'
              });
            }

            if (leadId) {
              await db.collection('leads/' + leadId + '/activity').add({
                userId: uid,
                type: 'stripe_payment_failed',
                label: 'Payment failed ($' + amount + ')',
                stripeInvoiceId: invoice.id,
                stripeCustomerId: customerId,
                amountCents: invoice.amount_due || 0,
                hostedInvoiceUrl: invoice.hosted_invoice_url || null,
                createdAt: FieldValue.serverTimestamp()
              });
            }

            // Slack — only posts when SLACK_WEBHOOK_URL secret is set.
            const slack = require('./integrations/slack');
            if (typeof slack.postSlack === 'function') {
              await slack.postSlack({
                text: '💳 Payment failed ($' + amount + ')',
                blocks: [{
                  type: 'section',
                  text: {
                    type: 'mrkdwn',
                    text:
                      '*💳 Stripe payment failed*\n' +
                      'Amount: *$' + amount + '*\n' +
                      'Invoice: `' + invoice.id + '`\n' +
                      (estimateId ? 'Estimate: `' + estimateId + '`\n' : '') +
                      (leadId ? 'Lead: `' + leadId + '`\n' : '') +
                      (invoice.hosted_invoice_url ? 'Hosted: ' + invoice.hosted_invoice_url : '')
                  }
                }]
              });
            }
          } catch (e) {
            logger.warn('dunning: enqueue failed', { err: e.message });
          }

          logger.warn('invoice_payment_failed', { uid, invoiceId: invoice.id });
          break;
        }

        // ── Invoice paid — reset monthly usage counters ──
        case 'invoice.paid': {
          const invoice = event.data.object;
          const customerId = invoice.customer;
          if (invoice.billing_reason !== 'subscription_cycle') break;

          const snapshot = await db
            .collection('subscriptions')
            .where('stripeCustomerId', '==', customerId)
            .limit(1)
            .get();
          if (!snapshot.empty) {
            const subDoc = snapshot.docs[0];
            await subDoc.ref.update({
              'usage.leads': 0,
              'usage.reports': 0,
              'usage.aiCalls': 0,
              'usage.cycleStart': new Date().toISOString(),
              updatedAt: FieldValue.serverTimestamp()
            });
            logger.info('usage_counters_reset', { uid: subDoc.id });
          }
          break;
        }

        default:
          logger.info('stripeWebhook.unhandled_event_type', { type: event.type });
      }

      res.json({ received: true });

    } catch (e) {
      logger.error('stripeWebhook processing error', { err: e.message });
      // The idempotency marker stripe_events/{event.id} is written BEFORE the
      // switch body. If processing then threw (a transient Firestore blip /
      // deadline on the subscriptions write), returning 500 alone is not
      // enough: Stripe retries the delivery, but the retry hits the create()
      // guard, sees ALREADY_EXISTS, and short-circuits as a duplicate doing
      // ZERO work — so a paid tenant's entitlement doc + claims (or a
      // cancellation / past_due flag) are lost permanently, with no
      // reconciliation path. Delete the marker so the retry re-processes from
      // scratch. The handlers' writes are all idempotent (merge/update + reset),
      // so a re-run is safe. `db` is scoped inside the try; use getFirestore()
      // (same memoized instance).
      if (event && event.id) {
        try {
          await getFirestore().doc(`stripe_events/${event.id}`).delete();
        } catch (delErr) {
          logger.error('stripeWebhook marker cleanup failed — event may not retry',
            { eventId: event.id, err: delErr.message });
        }
      }
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

exports.createCustomerPortalSession = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [STRIPE_SECRET_KEY],
    invoker: 'public', // see createCheckoutSession — auth enforced in-code
    maxInstances: 20,
    concurrency: 40,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    if (!(await httpRateLimit(req, res, 'createCustomerPortalSession:ip', 20, 3_600_000))) return;

    const authResult = await requireAuth(req);
    if (authResult.error) { res.status(authResult.error.status).json(authResult.error.body); return; }
    const { decoded } = authResult;
    // 2026-09-25 (decision B): a viewer is read-only. The Stripe billing
    // portal is where the COMPANY's subscription and payment method are
    // managed (what it allows is Stripe's portal configuration) — refused
    // for a viewer. (Any other member reaching it is a pre-existing
    // question, unchanged here.)
    const viewOnly = viewOnlyRefusal(decoded);
    if (viewOnly) { res.status(viewOnly.status).json(viewOnly.body); return; }

    try {
      const db = getFirestore();
      // Billing docs live at subscriptions/{companyId} (== owner uid for solo
      // operators). Resolve via the companyId claim so company admins can
      // reach the portal for their company's subscription.
      const billingKey = decoded.companyId || decoded.uid;
      const subscriptionSnap = await db.doc(`subscriptions/${billingKey}`).get();

      // A FREE tenant now has a subscriptions doc (canonical single source of
      // truth) — but it carries NO stripeCustomerId. Treat "no doc" and "doc
      // without a Stripe customer" identically: there is no Stripe billing to
      // manage, so 404 and let the client route the user to pricing (that's
      // how it already handled the absent-doc case). Without folding these two,
      // seeding the free doc would flip free users from a 404 (→ pricing) to a
      // 400 (→ error toast) — a regression.
      const customerId = subscriptionSnap.exists ? subscriptionSnap.data().stripeCustomerId : null;
      if (!customerId) {
        res.status(404).json({ error: 'No subscription found for this company' });
        return;
      }

      const stripe = getStripe();

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: customerId,
        // /pro/settings does not exist (Settings is a view inside the
        // dashboard) — it 404'd every portal return. Land on the dashboard.
        return_url: 'https://nobigdealwithjoedeal.com/pro/dashboard',
      });

      logger.info('billing_portal_session_created', { uid: decoded.uid });

      res.json({ url: portalSession.url });

    } catch (e) {
      logger.error('createCustomerPortalSession error', { err: e.message });
      if (e.code === 'auth/id-token-expired') {
        res.status(401).json({ error: 'Token expired — please re-authenticate' });
      } else {
        res.status(500).json({ error: 'Failed to create billing portal session' });
      }
    }
  }
);

exports.getSubscriptionStatus = onRequest(
  {
    cors: CORS_ORIGINS,
    invoker: 'public', // see createCheckoutSession — auth enforced in-code
    // R-05 sizing: called on every pro-surface page load (the NBDAuth
    // init path at docs/pro/js/nbd-auth.js fetches the subscription
    // doc directly via Firestore, but this function is the server-
    // authoritative fallback and is called by billing-status panels
    // on dashboard/settings/stripe-success). A 10k concurrent page-
    // load spike maps directly onto this endpoint. Old 50×80 = 4k
    // ceiling 429'd legitimate users. 200×80 = 16k headroom.
    maxInstances: 200,
    concurrency: 80,
    // minInstances was 2, to prevent a "1s loading spinner on every
    // dashboard open". Measured 2026-09-05: that spinner cost ~$14.94/mo
    // — warm instances across four functions were 84% of the whole GCP
    // bill (~$70/mo) versus ~$8/mo of real request serving. The 1s is
    // back, on the first billing-panel load after an idle window only.
    // ~$8.10/mo per warm 256MiB instance if reinstated.
    minInstances: 0,
    timeoutSeconds: 10,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const authResult = await requireAuth(req);
    if (authResult.error) { res.status(authResult.error.status).json(authResult.error.body); return; }
    const { decoded } = authResult;

    try {
      const db = getFirestore();
      // Same companyId-first resolution as the portal: a team member's
      // entitlement comes from their COMPANY's subscription doc.
      const billingKey = decoded.companyId || decoded.uid;
      const subscriptionSnap = await db.doc(`subscriptions/${billingKey}`).get();

      if (!subscriptionSnap.exists) {
        res.json({ status: 'none', plan: null });
        return;
      }

      const data = subscriptionSnap.data();
      res.json({
        status: data.status,
        plan: data.plan,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
      });

    } catch (e) {
      logger.error('getSubscriptionStatus error', { err: e.message });
      if (e.code === 'auth/id-token-expired') {
        res.status(401).json({ error: 'Token expired — please re-authenticate' });
      } else {
        res.status(500).json({ error: 'Failed to retrieve subscription status' });
      }
    }
  }
);

exports.createStripePaymentLink = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [STRIPE_SECRET_KEY],
    invoker: 'public', // see createCheckoutSession — auth enforced in-code
    maxInstances: 20,
    concurrency: 40,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    if (!(await httpRateLimit(req, res, 'createStripePaymentLink:ip', 30, 60_000))) return;

    const authResult = await requireAuth(req);
    if (authResult.error) { res.status(authResult.error.status).json(authResult.error.body); return; }
    const { decoded } = authResult;
    // 2026-09-25 (decision B): a viewer is read-only. The tenancy check
    // below admits ANY member of the invoice's tenant; minting a link (and
    // deactivating the prior one) is refused for a viewer first.
    const viewOnly = viewOnlyRefusal(decoded);
    if (viewOnly) { res.status(viewOnly.status).json(viewOnly.body); return; }

    // ── Three-way capability gate (#1123 lift, phase 3) ──────────────────
    //   1. Platform tenant → mint exactly as before: no destination routing,
    //      no fee (isPlatformTenant stays the fast path; D2: the fee never
    //      applies to the platform tenant's own mints).
    //   2. Other tenant with a ready Connect account (mayCollectOnline over
    //      the admin-SDK-only connectAccounts/{companyId} mirror) AND a live
    //      subscription (incl. past_due — see hasLiveSubscription) →
    //      destination-charge mint on their behalf.
    //   3. Everyone else → 403 ONLINE_PAYMENTS_UNAVAILABLE. Same error code
    //      as before, refusal still BEFORE any Stripe call, and the refusal
    //      branch RETURNS — never "warn and continue".
    const tenantId = decoded.companyId || decoded.uid;
    let connectState = null; // null ⇒ platform mint (no destination, no fee)
    if (!isPlatformTenant(decoded)) {
      const gateDb = getFirestore();
      const [connectSnap, subSnap] = await Promise.all([
        gateDb.doc('connectAccounts/' + tenantId).get(),
        gateDb.doc('subscriptions/' + tenantId).get(),
      ]);
      const state = connectSnap.exists ? (connectSnap.data() || {}) : null;
      const allowTestMode = connectLogic.connectTestModeAllowed(process.env); // D9
      const capable = !!state && connectLogic.mayCollectOnline(state, { allowTestMode });
      const liveSub = hasLiveSubscription(subSnap.exists ? subSnap.data() : null);
      if (!capable || !liveSub) {
        logger.info('payment_link_refused_tenant', {
          uid: decoded.uid, companyId: tenantId,
          reason: !capable ? 'connect_not_ready' : 'no_live_subscription',
        });
        res.status(403).json({
          error: 'ONLINE_PAYMENTS_UNAVAILABLE',
          message: 'Online card payment isn\'t available for your account yet. '
            + 'Send the invoice and record check, cash or card under Mark Paid.',
        });
        return;
      }
      connectState = state;
    }

    try {
      const { invoiceId } = req.body;

      if (!invoiceId) {
        res.status(400).json({ error: 'invoiceId required' });
        return;
      }

      // Fetch invoice from Firestore
      const db = getFirestore();
      const invoiceSnap = await db.collection('invoices').doc(invoiceId).get();

      if (!invoiceSnap.exists) {
        res.status(404).json({ error: 'Invoice not found' });
        return;
      }

      const invoice = invoiceSnap.data();

      // D5: ownership = TENANCY, not authorship. Any authenticated member of
      // the invoice's tenant may mint or regenerate (the owner regenerating a
      // rep's link; markPaid's balance-change regen from any seat). Legacy
      // invoices without a companyId stamp fall back to the creator's uid.
      const invoiceTenant = invoice.companyId || null;
      const sameTenant = invoiceTenant
        ? invoiceTenant === tenantId
        : invoice.createdBy === decoded.uid;
      if (!sameTenant) {
        res.status(403).json({ error: 'Unauthorized' });
        return;
      }

      // ── Kentucky insurance jobs: no payment link inside the window ──────
      // KRS 367.626 (2026 Ky. Acts ch. 54) bars requiring any payment on a
      // Kentucky insurance job until the cancellation period ends. Jo's rule
      // (2026-09-27): the link is withheld until the rep records the date the
      // carrier's written coverage decision arrived (lead.carrierDecisionAt)
      // AND 5 business days have passed; an invoice the rep marked emergency
      // tarp/repair work (367.626(3)) is exempt. Classification is the
      // server's own (ky-insurance-law.js) — the client's kyInsuranceHold flag
      // can only ADD the hold. Refused BEFORE any Stripe call.
      if (invoice.emergencyServices !== true) {
        let kyLead = null;
        if (invoice.leadId) {
          try {
            const ls = await db.collection('leads').doc(String(invoice.leadId)).get();
            kyLead = ls.exists ? (ls.data() || {}) : null;
          } catch (leadErr) {
            logger.warn('payment_link_ky_lead_read_failed', { invoiceId, err: leadErr && leadErr.message });
          }
        }
        let tz = KyLaw.DEFAULT_TIME_ZONE;
        try {
          const ps = await db.collection('companyProfile').doc(String(tenantId)).get();
          if (ps.exists) tz = KyLaw.resolveTimeZone(ps.data() || {});
        } catch (_) { /* default zone */ }
        const hold = KyLaw.payLinkHold(kyLead, invoice, Date.now(), tz);
        if (hold.held) {
          logger.info('payment_link_refused_ky_window', { invoiceId, uid: decoded.uid, companyId: tenantId,
            hasDecision: !!(kyLead && kyLead.carrierDecisionAt) });
          res.status(409).json({
            error: 'KY_CANCELLATION_WINDOW',
            message: KyLaw.MSG.payLinkHeld,
            releaseDate: hold.releaseDate || null,
          });
          return;
        }
      }

      // Recompute totals server-side from canonical product prices where possible.
      // For items with a productId, look up the catalog; otherwise use the
      // client-provided total but enforce sanity bounds to block $0.01/absurd values.
      const MIN_CENTS = 100;            // $1.00 minimum per line
      const MAX_CENTS = 10_000_000;     // $100k maximum per line
      const lineItems = [];
      for (const item of (invoice.items || [])) {
        let cents;
        if (item.productId) {
          const prodSnap = await db.doc(`products/${item.productId}`).get();
          if (prodSnap.exists && prodSnap.data().userId === decoded.uid) {
            const unit = prodSnap.data().unitPrice;
            const qty = Math.max(1, Number(item.quantity) || 1);
            if (typeof unit === 'number' && unit > 0) {
              cents = Math.round(unit * qty * 100);
            }
          }
        }
        if (cents === undefined) {
          cents = Math.round(Number(item.total || 0) * 100);
        }
        if (!Number.isFinite(cents) || cents < MIN_CENTS || cents > MAX_CENTS) {
          res.status(400).json({ error: 'Line item amount out of allowed range' });
          return;
        }
        lineItems.push({
          price_data: {
            currency: 'usd',
            product_data: {
              name: String(item.description || 'Invoice line item').slice(0, 250),
              description: `Invoice ${invoiceId}`,
            },
            unit_amount: cents,
          },
          quantity: 1,
        });
      }
      if (lineItems.length === 0) {
        res.status(400).json({ error: 'Invoice has no line items' });
        return;
      }

      // ── Sales-tax line + total reconciliation (H3, money bug) ─────────
      // invoice.items hold TAX-EXCLUSIVE line totals; the invoice's sales
      // tax lives only in invoice.tax / invoice.total. Without an explicit
      // tax line the payment link would charge the pre-tax subtotal, so the
      // customer underpays by the entire tax and the contractor eats it.
      // Append a dedicated tax line, then assert the link total reconciles
      // to invoice.total to the penny before we ever create the link.
      const productSumCents = lineItems.reduce(
        (sum, li) => sum + li.price_data.unit_amount * li.quantity, 0);
      const expectedTotalCents = Math.round(Number(invoice.total || 0) * 100);
      const taxCents = Math.round(Number(invoice.tax || 0) * 100);

      if (!Number.isFinite(taxCents) || taxCents < 0 || taxCents > MAX_CENTS) {
        res.status(400).json({ error: 'Invoice tax amount out of allowed range' });
        return;
      }
      if (taxCents > 0) {
        lineItems.push({
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Sales Tax',
              description: `Invoice ${invoiceId}`,
            },
            unit_amount: taxCents,
          },
          quantity: 1,
        });
      }

      // The charged total must equal invoice.total. Line totals from the
      // estimate engine are full-precision floats (fractional quantities ×
      // per-unit cents), so the sum of per-line rounding can drift a few
      // cents from the stored total — allow a tolerance that scales with
      // line count but stays far below any real tax amount, so a genuine
      // mismatch (e.g. a missing tax line, or a server-recomputed line that
      // diverges from the client total) still trips the guard and we refuse
      // to charge rather than bill the wrong amount.
      const linkTotalCents = lineItems.reduce(
        (sum, li) => sum + li.price_data.unit_amount * li.quantity, 0);
      const reconcileTolCents = Math.max(2, lineItems.length);
      if (Math.abs(linkTotalCents - expectedTotalCents) > reconcileTolCents) {
        logger.error('payment_link_total_mismatch', {
          invoiceId, uid: decoded.uid,
          productSumCents, taxCents, linkTotalCents, expectedTotalCents,
        });
        res.status(400).json({ error: 'Invoice total does not reconcile; refusing to create payment link' });
        return;
      }

      // ── Charge only the OUTSTANDING BALANCE, not the face value ──────────
      // A rep can record a cash/check deposit (invoice.amountPaid) BEFORE
      // sending the online link — the documented flow is a deposit at signing
      // (docs/pro/js/deposit-rule.js since 2026-09-25: 50% on cash jobs of
      // $2,000+, the deductible + ACV payment on insurance claims; it was
      // "50% deposit due upon scheduling"). Charging invoice.total again would OVERCHARGE the
      // homeowner by the deposit, and invoiceWebhook would then erase the
      // deposit from the ledger. The itemized lines above are validated to sum
      // to invoice.total (an integrity check); when a deposit exists they
      // overstate the charge, so swap to a single balance-due line reconciled
      // to (total − amountPaid).
      const amountPaidCents = Math.max(0, Math.round(Number(invoice.amountPaid || 0) * 100));
      const balanceDueCents = expectedTotalCents - amountPaidCents;
      if (balanceDueCents < MIN_CENTS) {
        res.status(400).json({ error: 'This invoice is already paid in full — nothing to charge.' });
        return;
      }
      let chargeLineItems = lineItems;
      if (amountPaidCents > 0) {
        chargeLineItems = [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Balance due — Invoice ${invoiceId}`,
              description: `Remaining balance after $${(amountPaidCents / 100).toFixed(2)} already paid`,
            },
            unit_amount: balanceDueCents,
          },
          quantity: 1,
        }];
      }

      const stripe = getStripe();

      // Deactivate any PRIOR link on this invoice before minting a new one.
      // The link is regenerated whenever the balance changes (a deposit is
      // recorded); without deactivating the old one, the stale full-amount
      // link stays payable and would overcharge the homeowner (or let both
      // links be paid → double-collect). stripeInvoiceId stores the prior
      // paymentLink id. Non-fatal — a failed deactivate must not block issuing
      // the corrected link.
      const priorLinkId = invoice.stripeInvoiceId;
      if (typeof priorLinkId === 'string' && priorLinkId.startsWith('plink_')) {
        try {
          await stripe.paymentLinks.update(priorLinkId, { active: false });
        } catch (deErr) {
          logger.warn('prior_payment_link_deactivate_failed', { invoiceId, priorLinkId, err: deErr.message });
        }
      }

      // D2: platform fee, Connect mints only (3.4% + 30 cents = Stripe
      // 2.9%+30c pass-through + 0.5% platform margin; clamped below the
      // charge; balanceDueCents is already >= MIN_CENTS here).
      const feeCents = connectState ? connectLogic.platformFeeCents(balanceDueCents) : 0;
      // D5: companyId in BOTH metadata sets so invoiceWebhook's tamper check
      // can key on tenancy (legacy links carry only userId — see the webhook
      // fallback). chargedCents unchanged (#980).
      const linkMetadata = {
        invoiceId: String(invoiceId),
        userId: decoded.uid,
        companyId: tenantId,
        chargedCents: String(balanceDueCents),
      };
      const paymentLink = await stripe.paymentLinks.create({
        line_items: chargeLineItems,
        // Single-use: without this the link is reusable and a homeowner (or a
        // double-click) can pay it repeatedly, each payment firing a fresh
        // payment_intent the event-idempotency guard can't dedupe — an
        // uncredited overcharge. One completed session closes the link.
        restrictions: { completed_sessions: { limit: 1 } },
        metadata: linkMetadata,
        payment_intent_data: { metadata: linkMetadata },
        after_completion: {
          type: 'redirect',
          redirect: {
            url: `https://nobigdealwithjoedeal.com/pro/invoice-success.html?invoiceId=${encodeURIComponent(invoiceId)}`,
          },
        },
        // D1: DESTINATION charge minted for the tenant's connected account
        // (settlement merchant = connected account). These three are
        // TOP-LEVEL PaymentLink create params — payment_intent_data on links
        // carries only metadata/statement_descriptor/transfer_group. Every
        // object (plink_, session, PI, charge, dispute) stays on the
        // PLATFORM account, so the prior-plink_ deactivation above, the
        // single-use restriction, invoiceWebhook's payment_intent.succeeded
        // flow, and the invoice-success redirect keep working unchanged.
        // The fee nets out of the tenant's SETTLEMENT, not the charge — the
        // PI's amount/amount_received remain the full homeowner payment.
        // No statement_descriptor: with the tenant as settlement merchant,
        // Stripe uses the CONNECTED account's business-profile descriptor,
        // which is exactly what the homeowner should see.
        ...(connectState ? {
          on_behalf_of: connectState.accountId,
          transfer_data: { destination: connectState.accountId },
          application_fee_amount: feeCents,
        } : {}),
      });

      logger.info('payment_link_created', {
        invoiceId, uid: decoded.uid, paymentLinkId: paymentLink.id,
        connect: !!connectState,
        destination: connectState ? connectState.accountId : null,
        feeCents,
      });
      res.json({ url: paymentLink.url, paymentLinkId: paymentLink.id });

    } catch (e) {
      logger.error('createStripePaymentLink error', { uid: decoded.uid, err: e.message });
      res.status(500).json({ error: 'Failed to create payment link' });
    }
  }
);

// ── Phase-3 payment-event visibility (D3) ────────────────────────────────
// Mirrors the E1 dunning pattern (stripeWebhook invoice.payment_failed,
// stripe.js:795-855): email_queue + lead activity + Slack. Best-effort —
// failures log-and-continue so an alert hiccup never 500s the webhook after
// the critical work (e.g. a reversal) has already committed.
//
// TWO AUDIENCES, DIFFERENT TEXT (2026-07-30, #1146 audit findings 1 + 11):
//   opts.uid      → the tenant rep who minted the payment link (meta.userId).
//                   Gets the customer-facing narrative. On a Connect-routed
//                   charge this is STRUCTURALLY never the platform owner —
//                   only NON-platform tenants mint destination charges — so it
//                   is never the right recipient for "the platform is out $X".
//   opts.ownerUid → the platform owner (NBD_OWNER_UID). OPTIONAL; omit it and
//                   this block is a no-op, so every existing caller is
//                   unchanged. Pass it with opts.ownerSubject/opts.ownerBody
//                   to deliver owner-only, act-now copy that used to live in
//                   slackBlocks alone — i.e. nowhere, because Slack has never
//                   been configured in prod (see the SLACK_WEBHOOK_URL import).
// The owner block runs FIRST and owns its own try/catch: a deleted/bad tenant
// uid must not be able to swallow the owner's copy, which is the half nobody
// else is watching. email_queue is the channel because it demonstrably works.
async function alertInvoicePaymentEvent(db, opts) {
  if (opts.ownerUid) {
    // Deliberately NOT deduped against opts.uid. On the platform tenant's own
    // invoices both resolve to the same mailbox, but the two mails carry
    // DIFFERENT text; a duplicate email is a far cheaper failure than dropping
    // the only copy that says what to do.
    let ownerEmail = null;
    let undeliverable = null;
    try {
      ownerEmail = (await getAuth().getUser(String(opts.ownerUid))).email || null;
    } catch (e) {
      undeliverable = 'getUser_failed: ' + e.message;
    }
    if (!undeliverable && !ownerEmail) undeliverable = 'no_email_on_owner_record';
    if (!undeliverable) {
      try {
        await db.collection('email_queue').add({
          to: ownerEmail,
          subject: opts.ownerSubject || opts.emailSubject,
          bodyPlain: opts.ownerBody || opts.emailBody,
          status: 'pending', // worker filters on status, not source
          createdAt: FieldValue.serverTimestamp(),
          source: opts.source || 'stripe_dunning',
          audience: 'platform_owner',
        });
      } catch (e) {
        undeliverable = 'enqueue_failed: ' + e.message;
      }
    }
    if (undeliverable) {
      // A caller asked for an owner alert and NO channel delivered it. Loud,
      // distinct, and carrying the copy itself, so the instruction survives in
      // Cloud Logging instead of evaporating the way the Slack half did.
      logger.error('payment_event_owner_alert_undeliverable', {
        ownerUid: String(opts.ownerUid),
        invoiceId: opts.invoiceId || null,
        source: opts.source || null,
        reason: undeliverable,
        ownerSubject: opts.ownerSubject || opts.emailSubject || null,
        ownerBody: opts.ownerBody || opts.emailBody || null,
      });
    }
  }
  try {
    if (opts.uid) {
      const email = (await getAuth().getUser(opts.uid)).email;
      if (email) {
        await db.collection('email_queue').add({
          to: email,
          subject: opts.emailSubject,
          bodyPlain: opts.emailBody,
          status: 'pending', // worker filters on status, not source
          createdAt: FieldValue.serverTimestamp(),
          source: opts.source || 'stripe_dunning',
        });
      }
    }
    if (opts.leadId && opts.activity) {
      await db.collection('leads/' + opts.leadId + '/activity').add(
        Object.assign({}, opts.activity, { createdAt: FieldValue.serverTimestamp() }));
    }
    const slack = require('./integrations/slack'); // same in-function require as the E1 wing
    if (typeof slack.postSlack === 'function') {
      const posted = await slack.postSlack({ text: opts.slackText, blocks: opts.slackBlocks });
      // #1146 finding 11: this result used to be discarded, so a dropped alert
      // and a delivered one were indistinguishable. 'unconfigured' is the
      // KNOWN prod state (the secret still holds the deploy stub) and is not
      // an incident — the owner email above is the channel that works; any
      // OTHER failure means a wired Slack actually refused the post.
      if (!posted || !posted.posted) {
        const reason = (posted && (posted.reason || posted.status)) || 'unknown';
        const detail = {
          invoiceId: opts.invoiceId || null,
          source: opts.source || null,
          reason,
        };
        if (reason === 'unconfigured') logger.warn('payment_event_slack_not_delivered', detail);
        else logger.error('payment_event_slack_not_delivered', detail);
      }
    }
  } catch (e) {
    logger.warn('payment_event_alert_failed', { invoiceId: opts.invoiceId || null, err: e.message });
  }
}

// Resolve mint context from a charge/dispute. The PI's metadata carries
// invoiceId/userId/companyId (payment_intent_data.metadata is NOT copied
// onto the Charge — always read the PI). The invoice read is for
// leadId/ownership VISIBILITY ONLY — never mutated by any phase-3 branch
// (refund/dispute ledger unwind is deferred to phase 4). Errors PROPAGATE:
// the outer catch deletes the stripe_events marker so Stripe's retry
// re-resolves — safe because every effect upstream is idempotency-keyed.
async function resolveInvoiceContext(db, stripe, paymentIntentId) {
  let meta = {};
  if (paymentIntentId) {
    const pi = await stripe.paymentIntents.retrieve(String(paymentIntentId));
    meta = pi.metadata || {};
  }
  let invoice = null;
  if (meta.invoiceId) {
    const snap = await db.collection('invoices').doc(String(meta.invoiceId)).get();
    invoice = snap.exists ? snap.data() : null;
  }
  return { meta, invoice };
}

exports.invoiceWebhook = onRequest(
  {
    cors: false, // Webhook should not use CORS
    invoker: 'public', // Stripe calls unauthenticated — see stripeWebhook
    // SLACK_WEBHOOK_URL: every dispute/refund alert this handler raises routes
    // its Slack half through alertInvoicePaymentEvent. Undeclared, that half
    // was dropped in silence (see the import).
    secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_INVOICE_WEBHOOK_SECRET,
              INTEGRATION_SECRETS.SLACK_WEBHOOK_URL],
    // R-05 sizing: payment_intent.succeeded fanout on bulk billing
    // days. 10 is a reasonable ceiling now that we've grown;
    // mirrors stripeWebhook's headroom without over-provisioning.
    maxInstances: 10,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Hoisted to function scope so the outer catch can read event.id for the
    // idempotency-marker cleanup (mirrors stripeWebhook).
    let event = null;
    try {
      const signature = req.headers['stripe-signature'] || '';
      const stripe = getStripe();

      // H-6: same rawBody requirement as stripeWebhook. The previous
      // `req.rawBody || req.body` fallback is a footgun — it gives
      // stripe.constructEvent a parsed object that never yields a
      // valid signature match, silently 400ing legit events, or (on
      // older SDKs) re-serialising into a different byte sequence
      // and accepting forgeries.
      if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
        logger.error('invoiceWebhook missing rawBody');
        res.status(400).json({ error: 'Invalid request body' });
        return;
      }
      if (!signature) {
        res.status(400).json({ error: 'Missing signature' });
        return;
      }

      // Verify Stripe signature with explicit replay tolerance. Prefer the
      // endpoint's OWN signing secret; fall back to the legacy shared secret
      // so deliveries keep verifying during the rotation window (the
      // dedicated secret starts life as a PENDING-ROTATION placeholder).
      const candidates = [];
      const { secretValue } = require('./integrations/_shared'); // '__unset__' stub → null, never a candidate
      const dedicated = secretValue(STRIPE_INVOICE_WEBHOOK_SECRET) || '';
      if (dedicated.startsWith('whsec_')) candidates.push(dedicated);
      const legacy = secretValue(STRIPE_WEBHOOK_SECRET) || '';
      if (legacy) candidates.push(legacy);

      let lastErr = null;
      for (const secret of candidates) {
        try {
          event = stripe.webhooks.constructEvent(req.rawBody, signature, secret, 300);
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!event) {
        logger.error('invoiceWebhook signature verification failed', { err: lastErr && lastErr.message });
        res.status(400).json({ error: 'Invalid signature' });
        return;
      }

      // ── Idempotency guard ──
      // Mirrors the stripeWebhook pattern (F-07). Stripe retries up to
      // 15 times on transient failure; the current "update invoice to
      // paid" body is idempotent for the invoice doc itself, but any
      // future side effects (receipt emails, Slack notifications,
      // analytics events) MUST NOT fire twice — so gate the whole
      // handler behind an atomic create() that fails on duplicate.
      const db = getFirestore();
      const eventRef = db.doc(`stripe_events/${event.id}`);
      try {
        await eventRef.create({
          type: event.type,
          source: 'invoiceWebhook',
          processedAt: FieldValue.serverTimestamp()
        });
      } catch (e) {
        if (e.code === 6 || /already exists/i.test(String(e.message))) {
          logger.info('invoiceWebhook.duplicate_event', { eventId: event.id });
          res.json({ received: true, duplicate: true });
          return;
        }
        throw e;
      }

      // Handle payment_intent.succeeded event
      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const metadata = paymentIntent.metadata || {};
        const invoiceId = metadata.invoiceId;
        const claimedUserId = metadata.userId;

        if (invoiceId) {
          const invRef = db.collection('invoices').doc(invoiceId);

          // Credit inside a transaction keyed on the paymentIntent id so the
          // credit is IDEMPOTENT AT THE DATA LEVEL — not dependent on the event
          // marker. The additive math (newPaid = priorPaid + received) is NOT
          // safe to re-run: if invRef.update commits server-side but the ack is
          // lost, the outer catch deletes the stripe_events marker and Stripe
          // retries the same event; without this guard the retry re-reads an
          // invoice whose amountPaid ALREADY includes this payment and adds it a
          // SECOND time (double-credit, invoice over-paid, partial wrongly
          // flipped 'paid'). Recording paymentIntent.id in paidIntentIds and
          // skipping when it's already present makes the retry a true no-op.
          const creditResult = await db.runTransaction(async (tx) => {
            const invSnap = await tx.get(invRef);
            if (!invSnap.exists) return { skipped: 'not_found' };
            const inv = invSnap.data();
            // D5: tenancy tamper check. Phase-3 mints stamp companyId into PI
            // metadata — compare tenancy when both sides have it. Links minted
            // BEFORE the rekey carry only userId: fall back to the original
            // createdBy comparison for those (legacy invoices may also lack
            // companyId). Absent metadata still passes, as before.
            const claimedCompanyId = metadata.companyId;
            if (claimedCompanyId && inv.companyId) {
              if (inv.companyId !== claimedCompanyId) {
                return { skipped: 'owner_mismatch', actualCompanyId: inv.companyId, actualCreatedBy: inv.createdBy };
              }
            } else if (claimedUserId && inv.createdBy !== claimedUserId) {
              return { skipped: 'owner_mismatch', actualCreatedBy: inv.createdBy };
            }
            // Idempotency ledger: this exact payment was already credited.
            const applied = Array.isArray(inv.paidIntentIds) ? inv.paidIntentIds : [];
            if (applied.includes(paymentIntent.id)) return { skipped: 'already_applied' };

            // Credit the ACTUAL amount Stripe collected (amount_received, in
            // cents) cumulatively onto any prior payment — the link charges only
            // the outstanding balance, and a rep may have recorded a cash deposit
            // first. Mirrors the client markPaid() cumulative math.
            // Destination-charge note: the platform fee nets out of the tenant
            // SETTLEMENT, not the charge — amount_received is still the full
            // homeowner payment, so the payments[] ledger contract
            // (money-dashboard/analytics-kpi/leaderboard paymentsOf) is unchanged.
            const total = Number(inv.total) || 0;
            const receivedCents = Number(paymentIntent.amount_received);
            const received = Number.isFinite(receivedCents) && receivedCents > 0
              ? Math.round(receivedCents) / 100 : 0;
            const priorPaid = Number(inv.amountPaid) || 0;
            const newPaid = Math.round((priorPaid + received) * 100) / 100;
            const newBalanceDue = Math.max(0, Math.round((total - newPaid) * 100) / 100);
            const fullyPaid = newBalanceDue === 0;
            // Append-only cash ledger (read-modify-write inside the txn so a
            // retry that already applied this paymentIntent never double-pushes).
            // Each entry keeps its own receipt date — multi-payment invoices
            // must attribute deposits and balance payoffs to different periods
            // in Money/Analytics (lastPaymentAt alone is overwritten every credit).
            const priorPayments = Array.isArray(inv.payments) ? inv.payments.slice() : [];
            if (received > 0) {
              priorPayments.push({
                amount: received,
                at: new Date(),
                method: 'stripe',
                paymentIntentId: paymentIntent.id,
              });
            }
            tx.update(invRef, {
              // status/paidAt flip to 'paid' ONLY when the balance reaches zero
              // — a deposit-sized online payment leaves the invoice open.
              status: fullyPaid ? 'paid' : (inv.status || 'sent'),
              paidAt: fullyPaid ? FieldValue.serverTimestamp() : (inv.paidAt || null),
              // Stamped on EVERY payment (incl. partials) so the money dashboard
              // can attribute collected cash to the year it was received, not
              // only once the invoice is fully settled.
              lastPaymentAt: FieldValue.serverTimestamp(),
              payments: priorPayments,
              stripePaymentIntentId: paymentIntent.id,
              // Append-only idempotency ledger (arrayUnion dedupes) — the
              // authoritative guard against a re-run double-credit.
              paidIntentIds: FieldValue.arrayUnion(paymentIntent.id),
              balanceDue: newBalanceDue,
              depositPaid: newPaid >= (Number(inv.depositAmount) || 0),
              amountPaid: newPaid,
              updatedAt: FieldValue.serverTimestamp(),
            });
            return { credited: true, fullyPaid, received, newPaid, newBalanceDue, leadId: inv.leadId };
          });

          if (creditResult.skipped === 'not_found') {
            logger.warn('invoiceWebhook: invoice not found', { invoiceId });
          } else if (creditResult.skipped === 'owner_mismatch') {
            // Metadata tampering — event recorded, but not marked paid.
            logger.error('invoiceWebhook: metadata userId mismatch', {
              invoiceId, claimedUserId, actualCreatedBy: creditResult.actualCreatedBy,
              claimedCompanyId: metadata.companyId || null,
              actualCompanyId: creditResult.actualCompanyId || null,
            });
          } else if (creditResult.skipped === 'already_applied') {
            logger.info('invoiceWebhook: paymentIntent already credited — idempotent skip',
              { invoiceId, paymentIntentId: paymentIntent.id });
          } else if (creditResult.credited) {
            logger.info('invoice_payment_recorded', {
              invoiceId, received: creditResult.received, newPaid: creditResult.newPaid,
              newBalanceDue: creditResult.newBalanceDue, fullyPaid: creditResult.fullyPaid,
            });

            // ── Auto-advance kanban stage on FULL payment ─────────────
            // Close the loop: when the homeowner pays the invoice OFF via
            // Stripe, bump the card to 'final_payment'. Gate on fullyPaid —
            // a deposit-sized online payment must NOT advance the lead to
            // final payment (the balance is still open). Runs only when the
            // credit was actually applied (never on an idempotent replay).
            // The CRM's `STAGE_META` treats final_payment/closed as
            // won-revenue stages.
            //
            // Idempotency: only auto-advance if the lead is currently
            // pre-final-payment AND not already lost. Never overwrite
            // a manually-set 'closed' or 'lost' state.
            if (creditResult.fullyPaid && creditResult.leadId) {
              try {
                const leadRef = db.collection('leads').doc(creditResult.leadId);
                const leadSnap = await leadRef.get();
                if (leadSnap.exists) {
                  const lead = leadSnap.data();
                  const curStage = (lead.stage || '').toLowerCase();
                  // Stages we won't override (already at-or-past final payment, or lost).
                  const PROTECTED = new Set(['final_payment', 'closed', 'lost']);
                  if (!PROTECTED.has(curStage)) {
                    await leadRef.update({
                      stage: 'final_payment',
                      _stageKey: 'final_payment',
                      // Stamp stageRole alongside stage, same as every client
                      // stage-mutation path (#981's persisted-stageRole-wins
                      // rule — functions/stage-roles.js roleFor()). Without
                      // this, a custom-pipeline tenant's lead keeps its STALE
                      // pre-payoff role (e.g. 'active') because persisted
                      // always wins over derived: review-request-nudge.js and
                      // the $100 referral-reward system both read roleFor()
                      // and silently never fire for a Stripe-paid job.
                      // 'final_payment' is a hardcoded built-in key here (not
                      // the lead's arbitrary custom stage), so its role is
                      // unambiguous — no client-side derivation needed.
                      stageRole: stageRoles.roleFromKey('final_payment'),
                      stageStartedAt: FieldValue.serverTimestamp(),
                      autoAdvancedFromInvoiceId: invoiceId,
                      autoAdvancedAt: FieldValue.serverTimestamp(),
                      updatedAt: FieldValue.serverTimestamp(),
                    });
                    logger.info('lead_auto_advanced_on_payment', {
                      invoiceId, leadId: creditResult.leadId, fromStage: curStage
                    });
                  }
                }
              } catch (advanceErr) {
                // Non-fatal — invoice is already marked paid, just log.
                logger.warn('lead_auto_advance_failed', {
                  invoiceId, leadId: creditResult.leadId, err: advanceErr.message
                });
              }
            }
          }
        }
      } else if (event.type === 'charge.dispute.created'
                 || event.type === 'charge.dispute.funds_withdrawn') {
        // API-version note for every branch below: webhook payloads arrive in
        // the ENDPOINT's configured version (2026-02-25.clover today) while
        // this SDK client is pinned to STRIPE_API_VERSION '2023-10-16' for the
        // calls it MAKES. So read event fields off event.data.object exactly as
        // delivered, and treat retrieve() results as 2023-10-16 shapes (that is
        // where charge.transfer comes from).
        //
        // D3: under destination routing a chargeback DEBITS THE PLATFORM
        // (plus Stripe's dispute fee, which no reversal recovers — see the
        // fee note in the alert copy below). Recovery = reverse the transfer
        // attached to the disputed charge so the contractor, not the
        // platform, bears the disputed principal. NO invoice-ledger mutation
        // (phase 4).
        //
        // REWRITTEN 2026-07-30 (#1146 audit findings 2 + 6). The premise
        // above used to be "a charge.dispute.created delivery means the
        // platform has been debited, so recover". FALSE for an INQUIRY
        // (Amex/Discover retrieval, status warning_*): Stripe withdraws
        // nothing, and no outcome event ever gives an inquiry-time claw-back
        // back — an inquiry cannot close 'won'. On a $10k invoice the old
        // behaviour parked ~$9.6k of the contractor's money in the platform
        // balance indefinitely. So recovery now waits for the DEBIT, which
        // makes this a TWO-EVENT branch:
        //   - charge.dispute.created         — always alerts; recovers only
        //                                      if funds are already withdrawn
        //   - charge.dispute.funds_withdrawn — the escalation/withdrawal
        //                                      event; recovers when the debit
        //                                      actually lands
        // RUNBOOK — the endpoint's registered event list GREW. All four of
        // charge.dispute.created, charge.dispute.funds_withdrawn,
        // charge.dispute.closed and charge.refunded must be enabled on the
        // invoiceWebhook endpoint in the Stripe dashboard. Registering
        // created WITHOUT funds_withdrawn is the dangerous half-state: an
        // inquiry that escalates into a real chargeback would then never be
        // recovered and the platform eats the full charge.
        // Deliberately NOT handled: charge.dispute.updated. It carries no
        // money truth (a status flip alone does not move funds) and would
        // only duplicate alerts; funds_withdrawn is the debit itself.
        //
        // REWRITTEN 2026-07-30 (close-out audit of #1145). This comment used
        // to read "Reversal FIRST and its errors PROPAGATE (marker-delete →
        // Stripe retry re-runs it; the dispute-keyed idempotencyKey makes the
        // re-run a no-op). Alerts after, best-effort." — i.e. a propagating
        // reversal was DELIBERATE. That premise was wrong twice over:
        //   1. the alert sat AFTER the reversal, so a reversal failure told
        //      the owner NOTHING — the chargeback itself landed in silence,
        //      which is the one thing this branch exists to prevent;
        //   2. the failure this call actually hits is `balance_insufficient`
        //      on a daily-payout Express account — the NORMAL state, and
        //      PERMANENT: no amount of retrying makes a spent balance
        //      reversible. Stripe would retry the delivery for ~3 days and
        //      auto-disable an endpoint that keeps 500ing, which would stop
        //      payment_intent.succeeded from crediting invoices for EVERY
        //      tenant, platform included. A recovery we cannot make today is
        //      never worth the credit path.
        // So the reversal is now NON-FATAL in its own try/catch: the owner is
        // ALWAYS alerted that a chargeback opened, and the alert distinguishes
        // "recovered from the contractor" from "RECOVERY FAILED, the platform
        // is out this money". Marker discipline is UNCHANGED for genuine
        // infrastructure errors elsewhere in the branch (the charge/PI reads,
        // Firestore) — only this one money call is swallowed. The
        // dispute-keyed idempotencyKey stays: those other errors still delete
        // the marker and Stripe's retry must not double-reverse.
        const dispute = event.data.object;
        const isWithdrawalEvent = event.type === 'charge.dispute.funds_withdrawn';
        const charge = await stripe.charges.retrieve(String(dispute.charge), { expand: ['transfer'] });
        const decision = connectLogic.decideDisputeReversal(dispute, charge);

        // PRE-MONEY READ, and load-bearing: has THIS dispute already clawed
        // this transfer back? Two callers need the answer.
        //   1. The two events above both fire within seconds on an ordinary
        //      chargeback. The dispute-keyed idempotencyKey alone is not
        //      enough: on a PARTIAL dispute the second delivery re-derives a
        //      SMALLER amount off the already-mutated transfer, which is the
        //      same key with different params — Stripe answers 400
        //      idempotency_error and we would render "RECOVERY FAILED" for a
        //      reversal that succeeded.
        //   2. A redelivery after a post-money throw (audit finding 4) sees
        //      amount_reversed == amount, decides 'nothing_to_reverse', and
        //      without this would tell the contractor in writing that nothing
        //      was pulled from their payout balance after it was.
        // This read PROPAGATES on failure, like the charges.retrieve above
        // it: no money has moved yet, so deleting the marker and letting
        // Stripe retry is the honest outcome. Skipping the recovery on a
        // transient blip would forfeit it permanently instead.
        let priorReversalId = null;
        if (decision.transferId) {
          const priorRevs = await stripe.transfers.listReversals(decision.transferId, { limit: 100 });
          for (const rev of (priorRevs && priorRevs.data) || []) {
            const rm = (rev && rev.metadata) || {};
            if (String(rm.disputeId || '') === String(dispute.id)
                && String(rm.source || '') === 'nbd_dispute_auto_reversal') {
              priorReversalId = String(rev.id);
              break;
            }
          }
        }

        let reversalId = null;
        let reversalError = null;
        // Success is tracked SEPARATELY from the id: a reversal that returns
        // no id is still a completed claw-back, and must never render as the
        // needs-review state below.
        let reversalDone = false;
        // Did THIS delivery attempt the money call? Drives duplicate-alert
        // suppression below, never the copy.
        let actedNow = false;
        if (priorReversalId) {
          logger.info('dispute_reversal_already_attributed', {
            disputeId: dispute.id, transferId: decision.transferId, chargeId: charge.id,
            reversalId: priorReversalId, eventType: event.type,
          });
        } else if (decision.reverse) {
          actedNow = true;
          const revParams = { metadata: { disputeId: String(dispute.id), source: 'nbd_dispute_auto_reversal' } };
          if (decision.amountCents != null) revParams.amount = decision.amountCents;
          try {
            const reversal = await stripe.transfers.createReversal(decision.transferId, revParams,
              { idempotencyKey: 'nbd-dispute-rev-' + dispute.id });
            reversalId = (reversal && reversal.id) || null;
            reversalDone = true;
            logger.warn('dispute_transfer_auto_reversed', {
              disputeId: dispute.id, transferId: decision.transferId, chargeId: charge.id,
              amountCents: decision.amountCents, disputeAmountCents: dispute.amount || 0,
              // Deliberate: the reversal recovers the disputed PRINCIPAL only.
              disputeFeeAbsorbedByPlatform: true,
            });
          } catch (revErr) {
            // CODE + truncated message: enough to act on in the alert without
            // pasting an unbounded Stripe string into an email/Slack/activity.
            reversalError = String((revErr && (revErr.code || revErr.type)) || 'error')
              + ': ' + String((revErr && revErr.message) || '').slice(0, 180);
            logger.error('dispute_transfer_reversal_failed', {
              disputeId: dispute.id, transferId: decision.transferId, chargeId: charge.id,
              amountCents: decision.amountCents, disputeAmountCents: dispute.amount || 0,
              err: reversalError,
              // The platform ate this one. Alert fires anyway (below).
              platformOutOfPocketCents: decision.amountCents != null
                ? decision.amountCents : (dispute.amount || 0),
            });
          }
        } else {
          logger.warn('dispute_no_transfer_to_reverse', {
            disputeId: dispute.id, chargeId: String(dispute.charge), reason: decision.reason,
            inquiry: decision.inquiry === true, eventType: event.type,
          });
        }

        // ══ POINT OF NO RETURN ══════════════════════════════════════════
        // Above this line nothing has moved and every await may propagate:
        // the marker is deleted, Stripe retries, and the retry re-derives
        // correctly. BELOW this line the money call has either succeeded or
        // definitively failed, so a throw would delete the marker and hand
        // Stripe a retry that re-runs a COMPLETED reversal against
        // re-derived state — producing an alert that says the opposite of
        // what happened (audit finding 10; the same class of bug #1146 was
        // written to fix). Everything from here to the response is therefore
        // non-fatal: this handler must reach a terminal 200 and never re-run.
        //
        // resolveInvoiceContext resolves leadId/uid/invoiceId for VISIBILITY
        // only and never mutates (see its own comment) — degrading it to
        // {meta:{}, invoice:null} still sends the alert with the dispute id,
        // the amount and the true recovery outcome. A missing meta.userId
        // costs the contractor email; the Slack alert and the structured log
        // still carry everything the owner needs to act.
        let meta = {};
        let invoice = null;
        try {
          ({ meta, invoice } = await resolveInvoiceContext(db, stripe, dispute.payment_intent));
        } catch (ctxErr) {
          logger.warn('dispute_context_resolve_failed', {
            disputeId: dispute.id, chargeId: charge.id, err: ctxErr.message,
          });
        }
        const amount = ((dispute.amount || 0) / 100).toFixed(2);
        const dueBy = (dispute.evidence_details && dispute.evidence_details.due_by)
          ? new Date(dispute.evidence_details.due_by * 1000).toISOString().slice(0, 10)
          : null;
        const disputeUid = meta.userId || (invoice && invoice.createdBy) || null;
        const disputeInvoiceId = meta.invoiceId ? String(meta.invoiceId) : null;

        // SIX states, never the old two. `!decision.reverse` collapsed a
        // genuine platform charge together with "an inquiry took nothing",
        // "the debit has not landed yet", "a redelivery found the transfer
        // already exhausted" and "we could not read the amount" — and told
        // the contractor all five were a platform charge (audit findings 3,
        // 4, 8). recoveredId covers both "reversed on this delivery" and
        // "reversed on an earlier delivery of this same dispute".
        const recoveredId = reversalId || priorReversalId;
        const recovered = reversalDone || !!priorReversalId;
        const noTransfer = !decision.transferId;
        const recoveryState = noTransfer ? 'not_applicable'
          : (recovered ? 'reversed'
            : (reversalError ? 'failed'
              : (decision.reason === 'inquiry_no_funds_withdrawn' ? 'inquiry_no_debit'
                : (decision.reason === 'funds_not_yet_withdrawn' ? 'awaiting_withdrawal'
                  : 'needs_review'))));
        const isInquiry = decision.inquiry === true;
        // The remediation the FAILED copy asks for, rendered as a command
        // that stamps the metadata the win-repay path reads. A dashboard
        // button reversal carries none, and is invisible on a win.
        const manualReversalCmd = 'stripe transfer_reversals create '
          + (decision.transferId || '<transfer_id>')
          + (decision.amountCents != null ? ' --amount ' + decision.amountCents : '')
          + ' -d "metadata[disputeId]=' + dispute.id + '"'
          + ' -d "metadata[source]=nbd_dispute_auto_reversal"';
        const recoveryLine = recoveryState === 'not_applicable'
          ? '\nThis charge was collected on the platform account — nothing was pulled from a payout balance.\n'
          : (recoveryState === 'reversed'
            ? '\nThe disputed amount has been recovered from your Stripe payout balance.\n'
            : (recoveryState === 'failed'
              ? '\nAUTOMATIC RECOVERY FAILED — the disputed amount could NOT be pulled back from your payout'
                + ' balance (' + reversalError + '). NBD Pro is out this money until it is settled by hand;'
                + ' expect a follow-up.\n'
              : (recoveryState === 'inquiry_no_debit'
                ? '\nNothing has been pulled from your payout balance. An inquiry is a request for'
                  + ' information, not a chargeback — the card network has taken no money from anyone. If it'
                  + ' later escalates into a real chargeback you will get a second notice.\n'
                : (recoveryState === 'awaiting_withdrawal'
                  ? '\nNothing has been pulled from your payout balance yet — Stripe has not taken the'
                    + ' disputed amount from NBD Pro either. If Stripe does withdraw it, the disputed amount'
                    + ' will be pulled back from your payout balance and you will get a second notice.\n'
                  : '\nAUTOMATIC RECOVERY WAS NOT POSSIBLE — NBD Pro could not pull the disputed amount back'
                    + ' for this chargeback (' + (decision.reason || 'unknown') + '). Nothing was pulled from'
                    + ' your payout balance for it NOW. Money may have left your payout balance earlier for'
                    + ' this same payment (a refund does that too) — NBD Pro cannot tell the two apart'
                    + ' automatically, so a person is settling this by hand.\n'))));
        // Deliberate phase-3 decision, stated out loud so it is never a
        // surprise on the statement: the reversal recovers the disputed
        // PRINCIPAL. Stripe's per-dispute fee is charged to the platform
        // account and is not part of it. Suppressed for an inquiry — Stripe
        // charges no dispute fee unless one escalates.
        const disputeFeeNote = isInquiry ? ''
          : '\nNote: Stripe charges a separate per-dispute fee. That fee is NOT part of the recovery'
            + ' above — NBD Pro absorbs it.\n';
        // On an ordinary chargeback created and funds_withdrawn arrive
        // seconds apart. created is the primary notice and always alerts;
        // the withdrawal twin stays quiet unless it actually did something —
        // otherwise every chargeback double-emails the contractor. It DOES
        // alert on the escalation case, which is the whole point: that is a
        // real state change (inquiry became a debit) and it moved money.
        const suppressDuplicateAlert = isWithdrawalEvent && !actedNow;
        const headline = isInquiry ? 'Card payment inquiry opened'
          : (isWithdrawalEvent ? 'Chargeback funds withdrawn' : 'Chargeback opened');
        if (suppressDuplicateAlert) {
          logger.info('dispute_funds_withdrawn_no_new_action', {
            disputeId: dispute.id, chargeId: charge.id, recoveryState,
            priorReversalId, reason: decision.reason,
          });
        } else {
          await alertInvoicePaymentEvent(db, {
            uid: disputeUid,
            leadId: (invoice && invoice.leadId) || null,
            invoiceId: disputeInvoiceId,
            source: 'stripe_dispute',
            emailSubject: headline + (recoveryState === 'failed' ? ' — RECOVERY FAILED' : '')
              + ' — $' + amount + ' — NBD Pro',
            emailBody:
              (isInquiry
                ? 'A customer\'s card issuer has opened an INQUIRY on a card payment — a request for'
                  + ' information, not yet a chargeback.\n\n'
                : (isWithdrawalEvent
                  ? 'A disputed card payment has been debited: the card network has taken the money back'
                    + ' while the dispute is decided.\n\n'
                  : 'A customer has disputed a card payment (chargeback).\n\n')) +
              'Invoice: ' + (disputeInvoiceId || 'n/a') + '\n' +
              'Amount:  $' + amount + '\n' +
              'Reason:  ' + (dispute.reason || 'unknown') + '\n' +
              recoveryLine +
              disputeFeeNote +
              (dueBy ? 'Evidence is due to Stripe by ' + dueBy + '.\n' : '') +
              // FIX 2026-07-30: this used to say "Submit your evidence ... in the
              // Stripe dashboard", which asks the contractor to do something they
              // CANNOT. Payments are routed as destination charges on the
              // platform account, so the dispute object lives on the PLATFORM
              // account — an Express dashboard does not surface it and only the
              // platform can file a response.
              '\nEVIDENCE — how this actually works: your card payments are processed through the NBD Pro' +
              ' platform Stripe account, so this dispute lives there, not on your own Stripe account. It' +
              ' will NOT appear in your Stripe Express dashboard and you cannot file the response' +
              ' yourself — NBD Pro submits the evidence to Stripe.\n' +
              'Send your evidence (signed contract, signed completion certificate, photos, texts with the' +
              ' customer) to NBD Pro as soon as you have it — reply to this email. Stripe\'s deadline' +
              (dueBy ? ' (' + dueBy + ')' : '') + ' is hard: if nothing is filed by then the dispute is' +
              ' lost by default.',
            slackText: (isInquiry ? 'ℹ️ ' : '⚠️ ') + headline
              + (recoveryState === 'failed' ? ' — RECOVERY FAILED' : '') + ' ($' + amount + ')',
            slackBlocks: [{
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  (isInquiry ? '*ℹ️ Stripe payment inquiry opened*\n' : '*⚠️ Stripe ' + headline.toLowerCase() + '*\n') +
                  'Amount: *$' + amount + '*\n' +
                  'Dispute: `' + dispute.id + '`\n' +
                  'Status: `' + (dispute.status || 'unknown') + '`\n' +
                  'Invoice: `' + (disputeInvoiceId || 'n/a') + '`\n' +
                  'Company: `' + (meta.companyId || 'n/a') + '`\n' +
                  (recoveryState === 'not_applicable'
                    ? 'Recovery: n/a (platform charge — no transfer to reverse)\n'
                    : (recoveryState === 'reversed'
                      ? 'Recovery: reversed `' + (recoveredId || 'n/a') + '`'
                        + (reversalDone ? '\n' : ' (on an earlier delivery of this event)\n')
                      : (recoveryState === 'failed'
                        ? '*Recovery: FAILED — the platform is currently out $' + amount + '.*\n'
                          + 'Error: `' + reversalError + '`\n'
                          + '➜ Act once the connected account has balance — and STAMP it, or the win path'
                          + ' cannot see it and the contractor is never repaid:\n'
                          + '`' + manualReversalCmd + '`\n'
                          + 'A plain dashboard-button reversal carries no metadata and is invisible to the'
                          + ' automatic repayment. Alternative: invoice the contractor.\n'
                        : (recoveryState === 'inquiry_no_debit'
                          ? 'Recovery: none needed — an inquiry withdraws no funds. Nothing was pulled from `'
                            + (decision.transferId || 'n/a') + '`. If it escalates, the funds_withdrawn event'
                            + ' does the recovery.\n'
                          : (recoveryState === 'awaiting_withdrawal'
                            ? 'Recovery: deferred — Stripe has not withdrawn the funds yet. Recovery runs on'
                              + ' charge.dispute.funds_withdrawn.\n'
                            : '*Recovery: NEEDS REVIEW — nothing could be pulled back (`'
                              + (decision.reason || 'unknown') + '`).*\n'
                              + 'Transfer `' + (decision.transferId || 'n/a') + '` has no reversal carrying this'
                              + ' dispute id, so the platform is out $' + amount + ' unless something else'
                              + ' (a refund) already unwound it.\n'
                              + '➜ Check the transfer in Stripe before taking any manual action.\n'))))) +
                  (isInquiry ? '' : '_Stripe\'s dispute fee is not recovered by the reversal — the platform absorbs it._\n') +
                  'Evidence is filed by the PLATFORM (destination charge) — the contractor cannot.',
              },
            }],
            activity: {
              userId: disputeUid,
              type: 'stripe_dispute_created',
              label: headline + ' ($' + amount + ')'
                + (recoveryState === 'failed' ? ' — automatic recovery FAILED' : '')
                + (recoveryState === 'needs_review' ? ' — recovery NEEDS REVIEW' : ''),
              disputeId: String(dispute.id),
              paymentIntentId: dispute.payment_intent ? String(dispute.payment_intent) : null,
              amountCents: dispute.amount || 0,
              reason: dispute.reason || null,
              disputeStatus: dispute.status ? String(dispute.status) : null,
              recovery: recoveryState,
              // The pure decision's own reason, so the six states above stay
              // greppable in the CRM trail and not only in Cloud Logging.
              recoveryReason: decision.reason || null,
              transferId: decision.transferId || null,
              reversalId: recoveredId || null,
              recoveryError: reversalError || null,
            },
          });
        }

      } else if (event.type === 'charge.dispute.closed') {
        // NEW 2026-07-30 (close-out audit of #1145). charge.dispute.created
        // reverses the contractor's transfer UNCONDITIONALLY — correct while
        // the outcome is unknown — but until today NOTHING handled the
        // outcome. When the platform WINS, Stripe reinstates the funds to the
        // PLATFORM balance and our reversal is never undone: the contractor
        // stays permanently short, with no ledger row anywhere saying why.
        // Recovery was a one-way street. This branch closes it.
        //
        // OPS: the endpoint must have charge.dispute.closed enabled in the
        // Stripe dashboard alongside charge.dispute.created AND
        // charge.dispute.funds_withdrawn (added 2026-07-30, see the runbook
        // note in the created branch), or a win is silently never repaid.
        //
        // Same discipline as the created branch above: the READS may throw
        // (outer catch deletes the marker, Stripe retries, guards below make
        // the re-run a no-op), the MONEY call may NOT — a repayment we cannot
        // make today must never 500 this endpoint into Stripe's auto-disable
        // and take the credit path down with it.
        //
        // The decision stays INLINE rather than moving to
        // stripe-connect-logic.js: unlike decideDisputeReversal it is not pure
        // over objects the caller already holds — proving that THIS dispute is
        // what clawed the money back needs a second Stripe read (the reversal
        // list), and the answer is inseparable from the two idempotency guards
        // wrapped around the transfer it authorises. Splitting it would put
        // half of one money decision in a module that is deliberately
        // dependency-free and money-primitive-free.
        const dispute = event.data.object;
        const status = String(dispute.status || '').toLowerCase();
        const won = status === 'won';
        const charge = await stripe.charges.retrieve(String(dispute.charge), { expand: ['transfer'] });
        const t = charge.transfer;
        const transferId = typeof t === 'string' ? t : String((t && t.id) || '');
        const destination = (t && typeof t === 'object')
          ? (typeof t.destination === 'string' ? t.destination : String((t.destination && t.destination.id) || ''))
          : '';

        // GUARD: repay ONLY what this dispute actually took. A dispute on a
        // platform-account charge (no transfer), or one whose created-branch
        // reversal never happened (no transfer to reverse, or the reversal
        // FAILED — now a survivable state), must be a pure no-op: repaying a
        // contractor who was never debited gifts them the money out of the
        // platform balance. Attribution is by the metadata the created branch
        // stamps, not by transfer.amount_reversed, which also counts
        // reversals from other causes (e.g. a refund).
        // Computed for EVERY terminal status, not just 'won': on a loss it is
        // what makes the alert able to say the debit stands rather than
        // guessing, and it keeps the log honest about what this dispute took.
        //
        // SECOND BUCKET, added 2026-07-30 (#1146 audit findings 7 + 9 + 12).
        // The metadata above has exactly ONE producer: the created branch's
        // own call. When that call fails — balance_insufficient on a
        // daily-payout Express account is the ORDINARY outcome — our own
        // alert tells the owner to reverse the transfer by hand, and a
        // hand-made reversal carries none of our metadata. Attributing only
        // our own stamps therefore made the instructed remediation invisible:
        // a WIN repaid $0 and told the contractor "nothing had been pulled
        // back", which is false, and they stayed out the money after we won.
        // So count unstamped reversals too — in a SEPARATE bucket that never
        // moves money.
        //
        // THE RULE AND ITS LIMITS. Evidence that a reversal belongs to this
        // dispute: it exists on THIS charge's transfer and was created at or
        // after this dispute opened. That is deliberately weak evidence — it
        // cannot distinguish the instructed manual remediation from a
        // refund-driven reversal, or from a second dispute's manual
        // remediation on the same transfer. Auto-repaying on it would gift
        // the platform's refund expense to the contractor, so it NEVER
        // auto-repays; it only forces the copy to stop asserting a zero we
        // cannot verify, and raises a human decision. Reversals created
        // BEFORE this dispute opened are excluded — they provably predate it.
        let reversedCents = 0;
        let unattributedReversedCents = 0;
        const disputeOpenedAt = Number(dispute.created) || 0;
        if (transferId.startsWith('tr_')) {
          const revList = await stripe.transfers.listReversals(transferId, { limit: 100 });
          for (const rev of (revList && revList.data) || []) {
            const rm = (rev && rev.metadata) || {};
            if (String(rm.disputeId || '') === String(dispute.id)
                && String(rm.source || '') === 'nbd_dispute_auto_reversal') {
              reversedCents += Number(rev.amount) || 0;
            } else if (Number(rev.created) >= disputeOpenedAt) {
              unattributedReversedCents += Number(rev.amount) || 0;
            }
          }
        }
        // Free cross-check: the expanded transfer already carries the total.
        // If it is BELOW what we attributed, attribution has drifted (or the
        // charge was re-read mid-flight) and no copy below should be trusted.
        const totalReversedCents = (t && typeof t === 'object') ? (Number(t.amount_reversed) || 0) : 0;
        if (totalReversedCents < reversedCents) {
          logger.error('dispute_reversal_attribution_drift', {
            disputeId: dispute.id, chargeId: charge.id, transferId,
            attributedCents: reversedCents, totalReversedCents,
          });
        }
        if (unattributedReversedCents > 0) {
          logger.error('dispute_unattributed_reversal', {
            disputeId: dispute.id, chargeId: charge.id, transferId, destination: destination || null,
            status, unattributedCents: unattributedReversedCents, attributedCents: reversedCents,
          });
        }
        // CLAMP: never send back more than this dispute took. Non-won statuses
        // move no money at all, so they repay nothing by construction.
        const repayCents = (won && reversedCents > 0) ? reversedCents : 0;
        const shouldRepay = won && repayCents > 0 && destination.startsWith('acct_');
        // Money left this transfer around this dispute that we cannot claim.
        // Never auto-repaid; always escalated to a human.
        const unattributedHold = unattributedReversedCents > 0 && repayCents <= 0;
        const unattributedDollars = (unattributedReversedCents / 100).toFixed(2);

        let repayTransferId = null;
        let repayError = null;
        if (shouldRepay) {
          // Double-pay guard 1 of 2 (the durable one). The dispute-keyed
          // idempotencyKey below only protects while Stripe retains the key
          // (~24h) whereas its retry schedule runs ~3 days — so a retry after
          // a committed-but-unacked repay could pay twice. Our own repayment
          // is findable on the charge's transfer_group. A read: it throws to
          // the outer catch and the retry re-checks, which is what we want.
          if (charge.transfer_group) {
            const priorList = await stripe.transfers.list({
              transfer_group: String(charge.transfer_group), limit: 100,
            });
            for (const tr of (priorList && priorList.data) || []) {
              const tm = (tr && tr.metadata) || {};
              if (String(tm.disputeId || '') === String(dispute.id)
                  && String(tm.source || '') === 'nbd_dispute_won_repay') {
                repayTransferId = String(tr.id);
                break;
              }
            }
          }
          if (repayTransferId) {
            logger.info('dispute_won_repay_already_done', {
              disputeId: dispute.id, chargeId: charge.id, transferId: repayTransferId,
            });
          } else {
            const repayParams = {
              amount: repayCents,
              currency: String((t && t.currency) || charge.currency || 'usd'),
              destination,
              metadata: {
                disputeId: String(dispute.id),
                chargeId: String(charge.id),
                source: 'nbd_dispute_won_repay',
              },
            };
            // Keep the repayment on the original charge's group so guard 1
            // can find it, and so the money reads as one story in Stripe.
            if (charge.transfer_group) repayParams.transfer_group = String(charge.transfer_group);
            try {
              // Double-pay guard 2 of 2: dispute-keyed, so a same-day retry
              // returns the FIRST transfer instead of minting a second.
              const repay = await stripe.transfers.create(repayParams,
                { idempotencyKey: 'nbd-dispute-repay-' + dispute.id });
              repayTransferId = (repay && repay.id) || null;
              logger.warn('dispute_won_transfer_repaid', {
                disputeId: dispute.id, chargeId: charge.id, destination,
                amountCents: repayCents, transferId: repayTransferId,
              });
            } catch (repayErr) {
              // Cross-border/currency mismatch, a rejected or restricted
              // connected account, an insufficient PLATFORM balance — treated
              // exactly like a failed reversal: alert loudly, never 500.
              repayError = String((repayErr && (repayErr.code || repayErr.type)) || 'error')
                + ': ' + String((repayErr && repayErr.message) || '').slice(0, 180);
              logger.error('dispute_won_repay_failed', {
                disputeId: dispute.id, chargeId: charge.id, destination,
                amountCents: repayCents, err: repayError,
                // Owed to the contractor until a human sends it.
                contractorShortCents: repayCents,
              });
            }
          }
        } else if (won && repayCents > 0) {
          // Money was clawed back but there is no acct_ to send it to (the
          // expanded transfer carried no destination). Treated as a FAILED
          // repayment, never as a silent success — the alert must not tell a
          // contractor they were paid back when nothing moved.
          repayError = 'no_destination: the reversed transfer carried no connected account id';
          logger.error('dispute_won_repay_failed', {
            disputeId: dispute.id, chargeId: charge.id, destination: destination || null,
            amountCents: repayCents, err: repayError, contractorShortCents: repayCents,
          });
        }

        logger.warn('dispute_closed', {
          disputeId: dispute.id, chargeId: charge.id, status,
          reversedCents, repayCents, repayTransferId,
          repayFailed: !!repayError,
          // The discriminators the alert copy branches on, kept in the trail
          // so a later reconciliation does not have to re-derive them.
          transferId: transferId || null, destination: destination || null,
          unattributedReversedCents, totalReversedCents,
          // Stripe returns the dispute fee on a win only; on any other
          // terminal status the platform keeps absorbing it.
          disputeFeeAbsorbedByPlatform: !won,
        });

        // ══ POINT OF NO RETURN ══════════════════════════════════════════
        // Same rule as the created branch: the reads above may propagate
        // (they re-derive correctly on a retry — reversal metadata does not
        // mutate and the transfer_group scan is durable), but the repayment
        // below has already moved money or definitively failed. A throw here
        // would delete the marker and re-run the branch, so every remaining
        // step is non-fatal and this handler always reaches a terminal 200.
        let meta = {};
        let invoice = null;
        try {
          ({ meta, invoice } = await resolveInvoiceContext(db, stripe, dispute.payment_intent));
        } catch (ctxErr) {
          logger.warn('dispute_context_resolve_failed', {
            disputeId: dispute.id, chargeId: charge.id, err: ctxErr.message,
          });
        }
        const amount = ((dispute.amount || 0) / 100).toFixed(2);
        const repaid = (repayCents / 100).toFixed(2);
        const closedUid = meta.userId || (invoice && invoice.createdBy) || null;
        const closedInvoiceId = meta.invoiceId ? String(meta.invoiceId) : null;
        const lost = status === 'lost';
        const reversedDollars = (reversedCents / 100).toFixed(2);
        // 'won' | 'lost' | anything else terminal (Stripe also closes early
        // INQUIRIES here as 'warning_closed'). Never label an unknown status
        // as a loss — say what Stripe said.
        const outcomeWord = won ? 'WON' : (lost ? 'lost' : 'closed (' + (status || 'unknown') + ')');
        // A tr_ still attached to the charge means there IS a counterparty,
        // whether or not THIS dispute reversed anything. Without it, a
        // reversal we FAILED to make rendered identically to a genuine
        // platform charge, and the last word contradicted the first one
        // (#1146 audit finding 3).
        const hasTransfer = transferId.startsWith('tr_') && destination.startsWith('acct_');
        const unrecovered = reversedCents === 0 && unattributedReversedCents === 0 && hasTransfer;
        // Won-and-repaid / won-and-repayment-failed / won-with-nothing-taken /
        // won-with-an-unattributable-claw-back / final loss / other terminal
        // status. Every one of them gets an alert; only the first two move
        // money, and no non-won path makes a Stripe money call at all.
        //
        // PREMISE REWRITTEN 2026-07-30 (#1146 audit findings 2 + 6). This
        // block used to carry a KNOWN GAP note: "an INQUIRY that closes
        // 'warning_closed' never debited the platform, yet the created branch
        // has already reversed the contractor's transfer". That is no longer
        // reachable for new disputes — the created branch refuses to reverse
        // a warning_* dispute at all, so an unescalated inquiry now closes
        // with reversedCents 0 and repays nothing because nothing was taken.
        // The warning_closed arm below is KEPT as a live safety net, not as a
        // tripwire: it still fires for any dispute reversed under the old
        // behaviour (shipped before today) and for any future status Stripe
        // adds that we do not classify. Do not delete it.
        const outcomeLine = won
          ? (repayCents <= 0
            ? (unattributedHold
              // Something reversed this transfer around this dispute that we
              // did not stamp — almost certainly the manual remediation our
              // own failure alert instructed. Never claim nothing was taken.
              ? '\n$' + unattributedDollars + ' was pulled back from your payout balance around this'
                + ' chargeback outside NBD Pro\'s automatic process, and it has NOT been returned to you.'
                + ' NBD Pro cannot confirm automatically that it belongs to this chargeback, so a person'
                + ' is confirming what is owed back to you. Expect a follow-up.\n'
              : '\nNothing had been pulled back from your payout balance for this chargeback, so there is'
                + ' nothing to return to you.\n')
            : (repayError
              ? '\nWE COULD NOT RETURN THE MONEY AUTOMATICALLY — $' + repaid + ' was pulled from your'
                + ' payout balance when the chargeback opened and the repayment failed ('
                + repayError + '). You are still short that amount; NBD Pro must send it by hand.'
                + ' Expect a follow-up.\n'
              : '\n$' + repaid + ' — the amount pulled from your payout balance when the chargeback'
                + ' opened — has been sent back to you.\n'))
          : (lost
            ? '\nThis is final: the disputed amount is not coming back'
              + (reversedCents > 0
                ? ' and stays debited from your payout balance.'
                : (unattributedHold
                  ? '. $' + unattributedDollars + ' left your payout balance around this chargeback'
                    + ' outside NBD Pro\'s automatic process — NBD Pro is confirming how this settles and'
                    + ' will follow up.'
                  : (unrecovered
                    ? '. Nothing was pulled from your payout balance for this chargeback — NBD Pro will'
                      + ' follow up about settling it.'
                    : '.')))
              + ' Stripe also charges a separate per-dispute fee on a lost dispute; NBD Pro absorbs'
              + ' that fee.\n'
            : '\nThis closed with status "' + (status || 'unknown') + '" and no money was moved by it.'
              + (reversedCents > 0
                ? ' $' + reversedDollars + ' was pulled from your payout balance when it opened and has'
                  + ' NOT been returned — NBD Pro is reviewing whether it is owed back to you.'
                : (unattributedHold
                  ? ' $' + unattributedDollars + ' left your payout balance around this dispute outside'
                    + ' NBD Pro\'s automatic process and has NOT been returned — NBD Pro is reviewing'
                    + ' whether it is owed back to you.'
                  : ''))
              + '\n');
        await alertInvoicePaymentEvent(db, {
          uid: closedUid,
          leadId: (invoice && invoice.leadId) || null,
          invoiceId: closedInvoiceId,
          source: 'stripe_dispute',
          emailSubject: 'Chargeback ' + outcomeWord + (repayError ? ' — repayment FAILED' : '')
            + (unattributedHold ? ' — REVIEW REQUIRED' : '')
            + ' — $' + amount + ' — NBD Pro',
          emailBody:
            'A card chargeback has closed with status: ' + (status || 'unknown') + '.\n\n' +
            'Invoice: ' + (closedInvoiceId || 'n/a') + '\n' +
            'Amount:  $' + amount + '\n' +
            'Reason:  ' + (dispute.reason || 'unknown') + '\n' +
            outcomeLine +
            '\nThe CRM invoice ledger was not changed by this dispute (recorded payments are'
            + ' unchanged) — adjust records manually if needed.',
          slackText: (won ? '🏆 ' : '💥 ') + 'Chargeback ' + outcomeWord
            + (repayError ? ' — repayment FAILED' : '')
            + (unattributedHold ? ' — REVIEW REQUIRED' : '') + ' ($' + amount + ')',
          slackBlocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                (won ? '*🏆 Stripe chargeback WON*\n' : '*💥 Stripe dispute closed — ' + (status || 'unknown') + '*\n') +
                'Amount: *$' + amount + '*\n' +
                'Dispute: `' + dispute.id + '`\n' +
                'Invoice: `' + (closedInvoiceId || 'n/a') + '`\n' +
                'Company: `' + (meta.companyId || 'n/a') + '`\n' +
                (won
                  ? (repayCents <= 0
                    ? (unattributedHold
                      ? '*➜ HUMAN DECISION REQUIRED: `' + transferId + '` shows $' + unattributedDollars
                        + ' of reversals this dispute\'s handler did not make* (most likely the manual'
                        + ' reversal after a RECOVERY FAILED alert). Nothing was auto-repaid — decide by'
                        + ' hand whether to send it to `' + (destination || 'their connected account')
                        + '`.\n'
                      : 'Repayment: n/a (this dispute never reversed a transfer)\n')
                    : (repayError
                      ? '*Repayment: FAILED — the contractor is still out $' + repaid + '.*\n'
                        + 'Error: `' + repayError + '`\n'
                        + '➜ Act in the Stripe dashboard: send $' + repaid + ' to `'
                        + (destination || 'their connected account') + '` by hand.\n'
                      : 'Repayment: sent $' + repaid + ' → `' + destination + '` (`'
                        + (repayTransferId || 'n/a') + '`)\n'))
                  : (lost
                    ? (reversedCents > 0
                      ? 'The reversal stands — the contractor bears the loss.\n'
                      : (unattributedHold
                        ? '*$' + unattributedDollars + ' was reversed on `' + transferId + '` outside this'
                          + ' handler* — the contractor may already have been debited by hand. Verify'
                          + ' before invoicing them again.\n'
                        : (unrecovered
                          ? '*Nothing was recovered — transfer `' + transferId + '` to `' + destination
                            + '` was never reversed.* The platform is out $' + amount + ' and the'
                            + ' contractor may still hold it.\n'
                            + '➜ Check the transfer\'s remaining reversible amount, then reverse by hand'
                            + ' or invoice the contractor.\n'
                          : 'Nothing was reversed (platform charge) — the platform bears the loss.\n')))
                      + '_Stripe\'s dispute fee is not recovered — the platform absorbs it._\n'
                    : 'No money moved on this event.'
                      + (reversedCents > 0
                        ? ' ➜ $' + reversedDollars + ' is still held back from `' + destination
                          + '` — decide by hand whether it is owed back (an inquiry that closes never'
                          + ' debited us).\n'
                        : (unattributedHold
                          ? ' ➜ $' + unattributedDollars + ' was reversed on `' + transferId + '` outside'
                            + ' this handler and has NOT been returned — decide by hand whether it is'
                            + ' owed back.\n'
                          : '\n')))),
            },
          }],
          activity: {
            userId: closedUid,
            type: 'stripe_dispute_closed',
            label: 'Chargeback ' + outcomeWord + ' ($' + amount + ')'
              + (repayError ? ' — repayment FAILED' : '')
              + (unattributedHold ? ' — REVIEW REQUIRED' : ''),
            disputeId: String(dispute.id),
            paymentIntentId: dispute.payment_intent ? String(dispute.payment_intent) : null,
            amountCents: dispute.amount || 0,
            disputeStatus: status || null,
            reversedCents,
            // The discriminator behind the copy above: money that left this
            // transfer around this dispute that we cannot attribute, and
            // therefore never auto-repay.
            unattributedReversedCents,
            transferId: transferId || null,
            destination: destination || null,
            repaidCents: repayError ? 0 : repayCents,
            repayTransferId: repayError ? null : (repayTransferId || null),
            repayError: repayError || null,
          },
        });

      } else if (event.type === 'charge.refunded') {
        // D3: VISIBILITY ONLY. Stripe fires this on PARTIAL refunds too —
        // charge.refunded is true only once the charge is fully refunded. No
        // invoice/payments[]/amountPaid mutation here: the refund ledger unwind
        // is phase 4, so the alert says so out loud rather than leaving the
        // owner to discover a silently-wrong balance.
        const charge = event.data.object;
        const { meta, invoice } = await resolveInvoiceContext(db, stripe, charge.payment_intent);
        const full = charge.refunded === true;
        const amount = ((charge.amount_refunded || 0) / 100).toFixed(2);
        const refundUid = meta.userId || (invoice && invoice.createdBy) || null;
        const refundInvoiceId = meta.invoiceId ? String(meta.invoiceId) : null;
        logger.warn('charge_refunded', {
          chargeId: charge.id, invoiceId: refundInvoiceId,
          amountRefundedCents: charge.amount_refunded || 0, full,
        });
        await alertInvoicePaymentEvent(db, {
          uid: refundUid,
          leadId: (invoice && invoice.leadId) || null,
          invoiceId: refundInvoiceId,
          source: 'stripe_refund',
          emailSubject: (full ? 'Refund' : 'Partial refund') + ' issued — $' + amount + ' — NBD Pro',
          emailBody:
            'A ' + (full ? 'full' : 'partial') + ' refund was issued on a card payment.\n\n' +
            'Invoice: ' + (refundInvoiceId || 'n/a') + '\n' +
            'Refunded: $' + amount + '\n' +
            'Charge:  ' + charge.id + '\n' +
            '\nIMPORTANT: the CRM invoice ledger was NOT changed — amounts recorded as paid still include this money; adjust records manually if needed.',
          slackText: '↩️ Refund issued ($' + amount + ')',
          slackBlocks: [{
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                '*↩️ Stripe refund issued*\n' +
                'Amount: *$' + amount + '*' + (full ? '' : ' (partial)') + '\n' +
                'Charge: `' + charge.id + '`\n' +
                'Invoice: `' + (refundInvoiceId || 'n/a') + '`\n' +
                'Company: `' + (meta.companyId || 'n/a') + '`\n' +
                'CRM ledger unchanged — adjust manually if needed.',
            },
          }],
          activity: {
            userId: refundUid,
            type: 'stripe_charge_refunded',
            label: (full ? 'Refund' : 'Partial refund') + ' issued ($' + amount + ')',
            chargeId: String(charge.id),
            paymentIntentId: charge.payment_intent ? String(charge.payment_intent) : null,
            amountRefundedCents: charge.amount_refunded || 0,
          },
        });

      } else if (event.type === 'payment_intent.payment_failed') {
        // D3: VISIBILITY ONLY, and only for OUR invoice mints. Once this type
        // is registered Stripe also delivers SUBSCRIPTION-billing PI failures
        // on this endpoint; those belong to stripeWebhook's dunning wing, so
        // ack and skip anything without our invoiceId metadata. The link stays
        // open for a retry — nothing in the CRM changes.
        const pi = event.data.object;
        const meta = pi.metadata || {};
        if (meta.invoiceId) {
          const invSnap = await db.collection('invoices').doc(String(meta.invoiceId)).get();
          const invoice = invSnap.exists ? invSnap.data() : null;
          const amount = ((pi.amount || 0) / 100).toFixed(2);
          // CODES ONLY — last_payment_error.message can echo cardholder detail.
          const lastErr = pi.last_payment_error || {};
          const errorCode = lastErr.decline_code || lastErr.code || 'unknown';
          const failedUid = meta.userId || (invoice && invoice.createdBy) || null;
          logger.warn('invoice_payment_intent_failed', {
            invoiceId: String(meta.invoiceId), paymentIntentId: pi.id, errorCode,
          });
          await alertInvoicePaymentEvent(db, {
            uid: failedUid,
            leadId: (invoice && invoice.leadId) || null,
            invoiceId: String(meta.invoiceId),
            source: 'stripe_payment_failed',
            emailSubject: 'Customer card declined — $' + amount + ' — NBD Pro',
            emailBody:
              'A customer card payment on one of your invoices was declined.\n\n' +
              'Invoice: ' + String(meta.invoiceId) + '\n' +
              'Amount:  $' + amount + '\n' +
              'Reason code: ' + errorCode + '\n' +
              '\nThe payment link is still open — the customer can try again with another card, or you can record check/cash under Mark Paid.',
            slackText: '💳 Customer card declined ($' + amount + ')',
            slackBlocks: [{
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  '*💳 Customer card declined*\n' +
                  'Amount: *$' + amount + '*\n' +
                  'Invoice: `' + String(meta.invoiceId) + '`\n' +
                  'Company: `' + (meta.companyId || 'n/a') + '`\n' +
                  'Code: `' + errorCode + '`',
              },
            }],
            activity: {
              userId: failedUid,
              type: 'stripe_payment_failed',
              label: 'Customer card declined ($' + amount + ')',
              paymentIntentId: String(pi.id),
              errorCode,
              amountCents: pi.amount || 0,
            },
          });
        }
      }

      res.json({ received: true });

    } catch (e) {
      logger.error('invoiceWebhook error', { err: e.message });
      // The idempotency marker stripe_events/{event.id} is written BEFORE the
      // invoice mutation. If that mutation then throws (a transient Firestore
      // blip/contention), returning 500 alone LOSES the payment: Stripe retries
      // the delivery, the retry's create() sees ALREADY_EXISTS and short-
      // circuits as a duplicate doing ZERO work, so the captured money is never
      // credited to the invoice (permanent A/R discrepancy). Delete the marker
      // so the retry re-processes from scratch. Re-processing is safe because
      // the credit is now idempotent AT THE DATA LEVEL: the transaction skips
      // when paymentIntent.id is already in the invoice's paidIntentIds ledger,
      // so a retry after a committed-but-unacked write is a no-op (no double-
      // credit) while a retry after a genuinely-failed write still credits once.
      // Mirrors the sibling stripeWebhook recovery.
      if (event && event.id) {
        try {
          await getFirestore().doc(`stripe_events/${event.id}`).delete();
        } catch (delErr) {
          logger.error('invoiceWebhook marker cleanup failed — event may not retry',
            { eventId: event.id, err: delErr.message });
        }
      }
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

// Test-only export. NON-enumerable on purpose: index.js absorbs this module
// via Object.assign(exports, require('./stripe')), which copies enumerable
// props only — a plain `exports._test` would leak into the deploy surface
// the Firebase CLI enumerates.
Object.defineProperty(exports, '_test', {
  value: { derivePlanAndSeats },
  enumerable: false,
});
