/**
 * stripe-connect.js — Stripe Connect EXPRESS, phase 1: accounts + onboarding.
 *
 * WHY: Stripe served two money flows on ONE platform key — subscriptions
 * (contractors paying us: ours) and invoice payments (a contractor's HOMEOWNER
 * paying the CONTRACTOR: theirs, settling into our balance). #1123 gated the
 * second to the platform tenant. Connect is the real fix: each tenant gets
 * their own connected account, and the mint routes the charge to it.
 *
 * ══ SCOPE — READ BEFORE EXTENDING ══
 * This file creates connected accounts and onboards them. It does NOT move
 * money: no payment links, no charges, no fee or routing parameters. That
 * confinement is enforced by tests/stripe-connect.test.js and is a deliberate
 * boundary, not an accident of phase order — the mint and every money
 * primitive live in functions/stripe.js alone, so there is exactly one file
 * to read when asking "where does the money go".
 *
 * REWRITTEN 2026-07-30 (Connect phase 3). The premise this header carried —
 * "the #1123 platform-only gate stays exactly as it is" and "platform fee:
 * intentionally NOT charged" — was retired by phase 3. The gate is now a
 * three-way predicate in functions/stripe.js (platform tenant mints as
 * before, fee-free; a tenant satisfying mayCollectOnline() plus a live
 * subscription gets a routed charge carrying the platform fee; everyone else
 * is still refused with 403 ONLINE_PAYMENTS_UNAVAILABLE and records payment
 * under Mark Paid). mayCollectOnline() in ../stripe-connect-logic.js was
 * written and tested here precisely so that lift could be a reviewed
 * predicate swap rather than a fresh judgement call — which is what it was.
 *
 * State lives in connectAccounts/{companyId}, which is ADMIN-SDK-ONLY
 * (firestore.rules: allow write: if false). It is deliberately NOT on
 * companyProfile — that doc is browser-writable by any company_admin, who could
 * then forge chargesEnabled:true and self-authorise online collection with no
 * Stripe account behind it, re-opening the #1123 harm. Same reasoning as
 * subscriptions/{uid}: a money entitlement is webhook-written, client-read.
 */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
// Lazy require (2026-08-07) — see stripe.js: ~20 MB SDK off the cold-start
// path of every function; required on first client construction.
let Stripe = null;

const { CORS_ORIGINS, requireTeamAdmin } = require('./_shared');
const { callableRateLimit } = require('../shared');
const L = require('../stripe-connect-logic');

// Same Secret Manager entry as functions/stripe.js — re-declaring the name in
// another module resolves to the same secret (see the note at stripe.js:101).
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
// A DEDICATED signing secret. Stripe issues a distinct whsec per endpoint, and
// this repo already paid for sharing one: both webhooks once verified against
// STRIPE_WEBHOOK_SECRET, so setting it to one endpoint's value broke the other
// forever. No multi-candidate fallback here either — a brand-new endpoint has
// no rotation window, and accepting a platform-signed payload on the Connect
// endpoint would let a replayed platform event reach the account-state writer.
const STRIPE_CONNECT_WEBHOOK_SECRET = defineSecret('STRIPE_CONNECT_WEBHOOK_SECRET');
const { secretValue } = require('../integrations/_shared');

const STRIPE_API_VERSION = '2023-10-16'; // pinned, mirrors stripe.js:33

// Memoized like stripe.js getStripe(); per-tenant work uses per-REQUEST options
// ({ stripeAccount }) rather than a second client.
let _stripeClient = null;
function getStripe() {
  if (_stripeClient) return _stripeClient;
  // trim(): a trailing newline in the Secret Manager value throws
  // ERR_INVALID_CHAR inside the SDK (#774).
  const key = secretValue(STRIPE_SECRET_KEY) || ''; // trimmed; the '__unset__' deploy stub reads as ''
  if (!key) throw new HttpsError('failed-precondition', 'Payments are not configured.');
  Stripe = Stripe || require('stripe');
  _stripeClient = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2, timeout: 20000,
  });
  return _stripeClient;
}

// Absolute apex URLs: the /pro canonical-URL rule is CI-guarded, and
// /pro/settings does NOT exist (Settings is a view inside the dashboard) — a
// portal return there 404'd for every user once already (stripe.js:947).
const APEX = 'https://nobigdealwithjoedeal.com';
const RETURN_URL = APEX + '/pro/dashboard?settings=billing&connect=return';
const REFRESH_URL = APEX + '/pro/dashboard?settings=billing&connect=refresh';

const ACCOUNTS = 'connectAccounts';
const ACCOUNT_INDEX = 'connectAccountIds';

// The caller's tenant. Solo convention is companyId == uid.
function tenantOf(request) {
  const claims = (request.auth && request.auth.token) || {};
  const uid = request.auth && request.auth.uid;
  return claims.companyId || uid || null;
}

function publicState(data) {
  const d = data || {};
  const status = L.describeConnectStatus(d);
  return {
    connected: !!d.accountId,
    status: status.code,
    label: status.label,
    accountId: d.accountId || null,
    livemode: d.livemode === true,
    chargesEnabled: d.chargesEnabled === true,
    payoutsEnabled: d.payoutsEnabled === true,
    detailsSubmitted: d.detailsSubmitted === true,
    disabledReason: d.disabledReason || null,
    requirementsCurrentlyDue: d.requirementsCurrentlyDue || [],
    requirementsPastDue: d.requirementsPastDue || [],
    // Phase 3: REAL capability truth. Same predicate the mint enforces in
    // functions/stripe.js createStripePaymentLink — this is a display MIRROR
    // of that gate, never an authority. allowTestMode comes ONLY from the
    // NBD_CONNECT_ALLOW_TEST_MODE env flag (emulator/QA; never set in prod).
    onlinePaymentsEnabled: L.mayCollectOnline(d, { allowTestMode: L.connectTestModeAllowed(process.env) }),
  };
}

// ── createConnectAccount ────────────────────────────────────────────────────
// Owner only (R3-10, Jo 2026-10-06): this creates a financial account in the
// tenant's name, so — like seat money — it is the owner's call, not any
// company_admin's. Same for the onboarding and Express dashboard links below.
// Idempotent — calling it twice returns the same account.
exports.createConnectAccount = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 60,
    memory: '256MiB',
    secrets: [STRIPE_SECRET_KEY],
  },
  async (request) => {
    const { uid, companyId } = await requireTeamAdmin(request, null, { ownerOnly: true });
    await callableRateLimit(request, 'createConnectAccount', 10, 3_600_000);

    const db = getFirestore();
    const ref = db.doc(`${ACCOUNTS}/${companyId}`);
    const now = Date.now();

    // ── txn 1: claim the right to create, atomically ──
    const decision = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const d = snap.exists ? (snap.data() || {}) : null;
      const verdict = L.decideAccountCreate(d, now);
      if (verdict.action === 'create') {
        tx.set(ref, {
          companyId,
          accountType: 'express',
          status: 'creating',
          claimedAtMs: now,
          createdByUid: uid,
          createdAt: FieldValue.serverTimestamp(),
          source: 'createConnectAccount',
        }, { merge: true });
      }
      return verdict;
    });

    if (decision.action === 'existing') {
      const snap = await ref.get();
      return { created: false, ...publicState(snap.data()) };
    }
    if (decision.action === 'in_flight') {
      throw new HttpsError('aborted', 'Payment setup is already starting — try again in a moment.');
    }
    if (decision.action === 'stale_claim') {
      // Deliberately NOT auto-retried: see decideAccountCreate. A silent retry
      // is the one behaviour that can mint a SECOND account holding real money.
      logger.error('connect_account_claim_stale', { companyId, uid });
      throw new HttpsError('internal', "Payment setup didn't finish. Contact support so we can check Stripe before retrying.");
    }

    // ── create at Stripe ──
    let account;
    try {
      const stripe = getStripe();
      account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: (request.auth.token && request.auth.token.email) || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_type: undefined, // let the contractor declare it in onboarding
        // metadata is the manual-reconciliation lifeline: there is no
        // accounts.search-by-metadata, but the Dashboard can be searched by it.
        metadata: { companyId: String(companyId), firebaseUid: String(uid) },
      }, {
        // Stable forever, companyId-derived. A random key would mint a second
        // account on any retry.
        idempotencyKey: L.accountIdempotencyKey(companyId),
      });
    } catch (e) {
      // Release the claim so the owner can retry rather than being wedged for
      // 5 minutes by a Stripe outage or an un-enabled Connect platform.
      await ref.set({ status: 'failed', claimedAtMs: null, lastError: String(e && e.message || e).slice(0, 300) }, { merge: true })
        .catch(() => {});
      logger.error('connect_account_create_failed', { companyId, err: e && e.message });
      throw new HttpsError('internal', 'Could not start payment setup. Please try again.');
    }

    const derived = L.deriveConnectState(account);

    // ── txn 2: commit the id + the reverse index atomically ──
    await db.runTransaction(async (tx) => {
      const [cur, idxSnap] = await Promise.all([
        tx.get(ref),
        tx.get(db.doc(`${ACCOUNT_INDEX}/${derived.accountId}`)),
      ]);
      const curId = cur.exists ? (cur.data() || {}).accountId : null;
      if (curId && curId !== derived.accountId) {
        // Two accounts now exist for one tenant. Keep the FIRST; a human must
        // reconcile the orphan in Stripe. Never silently switch which account
        // the app trusts — the other one may already hold money.
        logger.error('connect_duplicate_account_detected', { companyId, kept: curId, orphan: derived.accountId });
        throw new Error('duplicate_connect_account');
      }
      if (idxSnap.exists) {
        const owner = (idxSnap.data() || {}).companyId;
        if (owner && owner !== companyId) {
          logger.error('connect_account_index_cross_tenant', { accountId: derived.accountId, owner, attempted: companyId });
          throw new Error('connect_account_cross_tenant');
        }
      } else {
        tx.set(db.doc(`${ACCOUNT_INDEX}/${derived.accountId}`), {
          companyId, createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.set(ref, Object.assign({}, derived, {
        companyId,
        accountType: 'express',
        status: 'ready',
        claimedAtMs: null,
        onboardingCompletedAt: derived.detailsSubmitted ? FieldValue.serverTimestamp() : null,
        updatedAt: FieldValue.serverTimestamp(),
      }), { merge: true });
    });

    logger.info('connect_account_created', { companyId, accountId: derived.accountId, livemode: derived.livemode });
    const snap = await ref.get();
    return { created: true, ...publicState(snap.data()) };
  }
);

// ── createConnectOnboardingLink ─────────────────────────────────────────────
// AccountLinks are SINGLE-USE and short-lived, and they authenticate the
// account holder — so this URL is minted on click, redirected to, and
// discarded. NEVER persist, email, SMS or portal-share it (contrast the
// payment link, which is deliberately stored on the invoice).
exports.createConnectOnboardingLink = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
    secrets: [STRIPE_SECRET_KEY],
  },
  async (request) => {
    const { companyId } = await requireTeamAdmin(request, null, { ownerOnly: true });
    await callableRateLimit(request, 'createConnectOnboardingLink', 30, 3_600_000);

    const db = getFirestore();
    const ref = db.doc(`${ACCOUNTS}/${companyId}`);
    const snap = await ref.get();
    const accountId = snap.exists ? (snap.data() || {}).accountId : null;
    if (!accountId) {
      throw new HttpsError('failed-precondition', 'Create the payments account first.');
    }

    let link;
    try {
      link = await getStripe().accountLinks.create({
        account: accountId,
        refresh_url: REFRESH_URL,
        return_url: RETURN_URL,
        type: 'account_onboarding',
      });
    } catch (e) {
      logger.error('connect_onboarding_link_failed', { companyId, err: e && e.message });
      throw new HttpsError('internal', 'Could not open Stripe onboarding. Please try again.');
    }

    await ref.set({
      onboardingStartedAt: snap.exists && (snap.data() || {}).onboardingStartedAt
        ? (snap.data() || {}).onboardingStartedAt
        : FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});

    return { url: link.url, expiresAt: link.expires_at || null };
  }
);

// ── getConnectStatus ────────────────────────────────────────────────────────
// Any authenticated member of the tenant may READ status (a rep needs to know
// whether online payment is available), but only within their OWN tenant.
// Re-retrieves from Stripe and re-persists, because account.updated can arrive
// after the browser does — reading the stale doc would show "not connected" to
// someone who just finished onboarding.
exports.getConnectStatus = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
    secrets: [STRIPE_SECRET_KEY],
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    const companyId = tenantOf(request);
    if (!companyId) throw new HttpsError('failed-precondition', 'No company on this account yet.');
    await callableRateLimit(request, 'getConnectStatus', 120, 3_600_000);

    const db = getFirestore();
    const ref = db.doc(`${ACCOUNTS}/${companyId}`);
    const snap = await ref.get();
    if (!snap.exists) return { connected: false, status: 'not_started', label: 'Not connected', onlinePaymentsEnabled: false };

    const data = snap.data() || {};
    if (!data.accountId) return publicState(data);

    try {
      const account = await getStripe().accounts.retrieve(data.accountId);
      const derived = L.deriveConnectState(account);
      await ref.set(Object.assign({}, derived, {
        onboardingCompletedAt: derived.detailsSubmitted && !data.onboardingCompletedAt
          ? FieldValue.serverTimestamp()
          : (data.onboardingCompletedAt || null),
        updatedAt: FieldValue.serverTimestamp(),
        source: 'getConnectStatus',
      }), { merge: true });
      return publicState(Object.assign({}, data, derived));
    } catch (e) {
      // A Stripe hiccup must not make a connected tenant look disconnected —
      // fall back to the stored mirror.
      logger.warn('connect_status_retrieve_failed', { companyId, err: e && e.message });
      return publicState(data);
    }
  }
);

// ── createConnectDashboardLink ──────────────────────────────────────────────
// The Express dashboard is the fix-it path for a tenant stuck in verification
// (NOT a fresh onboarding link). Login links require details_submitted.
exports.createConnectDashboardLink = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
    secrets: [STRIPE_SECRET_KEY],
  },
  async (request) => {
    const { companyId } = await requireTeamAdmin(request, null, { ownerOnly: true });
    await callableRateLimit(request, 'createConnectDashboardLink', 30, 3_600_000);

    const db = getFirestore();
    const snap = await db.doc(`${ACCOUNTS}/${companyId}`).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    if (!data.accountId) throw new HttpsError('failed-precondition', 'Create the payments account first.');
    if (data.detailsSubmitted !== true) {
      throw new HttpsError('failed-precondition', 'Finish Stripe onboarding first.');
    }

    try {
      const link = await getStripe().accounts.createLoginLink(data.accountId);
      return { url: link.url };
    } catch (e) {
      logger.error('connect_dashboard_link_failed', { companyId, err: e && e.message });
      throw new HttpsError('internal', 'Could not open the Stripe dashboard. Please try again.');
    }
  }
);

// ── stripeConnectWebhook ────────────────────────────────────────────────────
// Its OWN endpoint with its OWN signing secret. Connected-account events carry
// a top-level event.account; platform events do not.
exports.stripeConnectWebhook = onRequest(
  {
    region: 'us-central1',
    cors: false,
    invoker: 'public',
    maxInstances: 10,
    timeoutSeconds: 30,
    memory: '256MiB',
    secrets: [STRIPE_SECRET_KEY, STRIPE_CONNECT_WEBHOOK_SECRET],
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    // rawBody is REQUIRED — there is no req.body fallback. Verifying a
    // re-serialized body silently fails forever (H-6).
    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      logger.error('connect_webhook_no_raw_body');
      res.status(400).json({ error: 'raw body required' });
      return;
    }
    const sig = req.headers['stripe-signature'];
    if (!sig || typeof sig !== 'string') { res.status(400).json({ error: 'missing signature' }); return; }

    const secret = String(STRIPE_CONNECT_WEBHOOK_SECRET.value() ?? '').trim();
    if (!secret.startsWith('whsec_')) {
      // Fail CLOSED and loudly: an unset secret must never be interpreted as
      // "skip verification".
      logger.error('connect_webhook_secret_missing');
      res.status(500).json({ error: 'webhook not configured' });
      return;
    }

    let event;
    try {
      event = getStripe().webhooks.constructEvent(req.rawBody, sig, secret, 300);
    } catch (e) {
      logger.warn('connect_webhook_bad_signature', { err: e && e.message });
      res.status(400).json({ error: 'invalid signature' });
      return;
    }

    // Platform events do not belong here. 200 so Stripe stops retrying.
    if (!event.account) {
      logger.info('connect_webhook_platform_event_ignored', { type: event.type, id: event.id });
      res.json({ received: true, ignored: true });
      return;
    }

    const db = getFirestore();
    const idxSnap = await db.doc(`${ACCOUNT_INDEX}/${event.account}`).get();
    if (!idxSnap.exists) {
      // A test-mode account we don't own, or a stray endpoint. 200, or Stripe
      // retries for days over something we can never resolve.
      logger.warn('connect_webhook_unknown_account', { account: event.account, type: event.type });
      res.json({ received: true, unknownAccount: true });
      return;
    }
    const companyId = (idxSnap.data() || {}).companyId;
    const ref = db.doc(`${ACCOUNTS}/${companyId}`);

    // Idempotency: shared with the other webhooks (Stripe event ids are unique
    // across platform and connected accounts). create() is atomic, so two
    // concurrent deliveries cannot both pass.
    const eventRef = db.doc(`stripe_events/${event.id}`);
    try {
      await eventRef.create({
        type: event.type, source: 'connectWebhook', account: event.account,
        companyId: companyId || null, receivedAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      if (e && e.code === 6) { res.json({ received: true, duplicate: true }); return; }
      throw e;
    }

    try {
      const snap = await ref.get();
      const stored = snap.exists ? (snap.data() || {}) : null;
      const verdict = L.decideWebhookApply(stored, event);
      if (!verdict.apply) {
        logger.info('connect_webhook_skipped', { companyId, type: event.type, reason: verdict.reason });
        res.json({ received: true, skipped: verdict.reason });
        return;
      }

      if (event.type === 'account.updated') {
        const derived = L.deriveConnectState(event.data && event.data.object);
        await ref.set(Object.assign({}, derived, {
          status: 'ready',
          lastAccountEventAt: verdict.watermark,
          onboardingCompletedAt: derived.detailsSubmitted && !(stored && stored.onboardingCompletedAt)
            ? FieldValue.serverTimestamp()
            : ((stored && stored.onboardingCompletedAt) || null),
          updatedAt: FieldValue.serverTimestamp(),
          source: 'connectWebhook',
        }), { merge: true });
        logger.info('connect_account_updated', {
          companyId, chargesEnabled: derived.chargesEnabled, detailsSubmitted: derived.detailsSubmitted,
        });
      } else if (event.type === 'account.application.deauthorized') {
        // data.object is an Application, not an Account — the acct id is on
        // event.account. Without this the tenant stays "ready" forever after
        // disconnecting.
        await ref.set({
          chargesEnabled: false, payoutsEnabled: false,
          deauthorizedAt: FieldValue.serverTimestamp(),
          lastAccountEventAt: verdict.watermark,
          updatedAt: FieldValue.serverTimestamp(),
          source: 'connectWebhook',
        }, { merge: true });
        logger.info('connect_account_deauthorized', { companyId, account: event.account });
      } else {
        logger.info('connect_webhook_unhandled_type', { type: event.type, companyId });
      }

      res.json({ received: true });
    } catch (e) {
      // Delete the marker FIRST: leaving it makes the retry short-circuit as a
      // duplicate doing zero work, losing the capability flip permanently.
      await eventRef.delete().catch(() => {});
      logger.error('connect_webhook_processing_failed', { companyId, type: event.type, err: e && e.message });
      res.status(500).json({ error: 'processing failed' });
    }
  }
);
