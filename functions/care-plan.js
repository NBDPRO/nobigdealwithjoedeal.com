/**
 * functions/care-plan.js — the Roof Care Plan (NBD's own homeowner
 * membership): checkout, Stripe webhook, and the CRM's invite/portal actions.
 *
 * SHIPS DARK. Nothing sells until CARE_PLAN_MODE is set (care-plan-logic.js
 * carePlanMode): 'test' = Jo's CRM invite links + the page with
 * ?preview=careplan; 'live' = the public page. The webhook also answers 503
 * until STRIPE_CAREPLAN_WEBHOOK_SECRET holds a real whsec_ value (the deploy
 * stubs it '__unset__'). Design note:
 * documentation/projects/ROOF-CARE-PLAN-2026-10-05.md
 *
 * Exports (all gen2, 256MiB):
 *   carePlanPublic   onRequest — PUBLIC. GET → { mode, prices }. POST
 *                    { action:'checkout' } mints a Stripe Checkout session
 *                    (subscription mode, inline price_data); POST
 *                    { action:'portal', sessionId } → Stripe Customer Portal
 *                    (cancel anytime). Turnstile + per-IP limit + honeypot —
 *                    no App Check (onRequest can't enforce it).
 *   carePlanWebhook  onRequest — Stripe signature (own endpoint + secret),
 *                    idempotent on careplan_events/{eventId}; only objects
 *                    tagged metadata.nbdProduct === 'roof_care_plan'.
 *   carePlanAdmin    onCall (App Check) — platform owner / its company_admin:
 *                    'status', 'invite' (a reusable link Jo sends himself),
 *                    'portal' (a member's billing link).
 *
 * Tenancy: the plan is the PLATFORM tenant's product (companyId =
 * NBD_OWNER_UID), sold on the platform's own Stripe account. Every lead it
 * reads or writes is checked to be in that company; other tenants are
 * refused, never served.
 *
 * Writes (admin SDK; clients cannot write any of these — firestore.rules):
 *   careplans/{id}                   the membership
 *   careplan_events/{eventId}        webhook idempotency marker
 *   careplan_config/stripe           lazily-created portal configuration id
 *   leads/{id}.carePlan              small mirror for badges / discount / storm order
 *   leads/{id}/tasks/careplan_{id}_y{n}  the yearly inspection reminder
 *   email_queue/careplan-joined-{id} ONE alert to Jo when a member joins
 * Nothing is ever sent to the homeowner from here — Stripe's own receipt is
 * the only mail they get.
 */
'use strict';

const crypto = require('crypto');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const C = require('./care-plan-logic');
const { CORS_ORIGINS } = require('./handlers/_shared');
const { secretValue, SECRETS: INT_SECRETS } = require('./integrations/_shared');

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
// Its own endpoint and signing secret (Stripe issues one per endpoint), so the
// care plan never shares stripeWebhook's / invoiceWebhook's idempotency or
// failure modes. Unset → 503 (dark).
const STRIPE_CAREPLAN_WEBHOOK_SECRET = defineSecret('STRIPE_CAREPLAN_WEBHOOK_SECRET');

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const OWNER_ALERT_FALLBACK = 'jd@nobigdealwithjoedeal.com';
const API_VERSION = '2023-10-16';
const COL = 'careplans';
const INVITE_TTL_MS = 30 * 24 * 3600 * 1000;

let _stripe = null;
function stripeClient() {
  if (_stripe) return _stripe;
  const key = secretValue(STRIPE_SECRET_KEY);
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  const Stripe = require('stripe');
  _stripe = new Stripe(key, { apiVersion: API_VERSION, maxNetworkRetries: 2, timeout: 20000 });
  return _stripe;
}

const mode = () => C.carePlanMode(process.env);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isAlreadyExists = (e) => !!(e && (e.code === 6 || /already exists/i.test(String(e.message || ''))));
async function createIfAbsent(ref, data) {
  try { await ref.create(data); return true; } catch (e) { if (isAlreadyExists(e)) return false; throw e; }
}

// ── Stripe catalog: lazy + idempotent ────────────────────────────────────
let _productReady = false;
async function ensureProduct(stripe) {
  if (_productReady) return C.STRIPE_PRODUCT_ID;
  try {
    await stripe.products.create({ id: C.STRIPE_PRODUCT_ID, name: C.PRODUCT_NAME,
      description: 'Yearly roof inspection with a written condition report, small touch-ups on the visit, priority after storms, 10% off repairs.',
      metadata: { nbdProduct: C.PRODUCT_TAG } });
  } catch (e) {
    if (!(e && (e.code === 'resource_already_exists' || /already exists/i.test(String(e.message || ''))))) throw e;
  }
  _productReady = true;
  return C.STRIPE_PRODUCT_ID;
}

async function ensurePortalConfig(db, stripe) {
  const ref = db.collection('careplan_config').doc('stripe');
  const snap = await ref.get();
  const id = snap.exists && snap.data() && snap.data().portalConfigId;
  if (id) return id;
  const cfg = await stripe.billingPortal.configurations.create({
    business_profile: { headline: 'NBD Roof Care Plan — manage your card or cancel anytime',
      privacy_policy_url: 'https://nobigdealwithjoedeal.com/privacy' },
    features: {
      // No lock-in: cancel is always one click. At period end, so the member
      // keeps what they already paid for and is never charged again.
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
    },
    metadata: { nbdProduct: C.PRODUCT_TAG },
  });
  await ref.set({ portalConfigId: cfg.id, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  return cfg.id;
}

// ── Leads: link by email / phone, or create one like submitPublicLead ────
function liveFirst(snap) {
  const docs = (snap && snap.docs) || [];
  return docs.find((d) => (d.data() || {}).deleted !== true) || null;
}
async function findOrCreateLead(db, data, carePlanId) {
  const leads = db.collection('leads');
  let hit = null;
  if (data.email) hit = liveFirst(await leads.where('companyId', '==', OWNER).where('email', '==', data.email).limit(5).get());
  if (!hit && data.phoneDigits) hit = liveFirst(await leads.where('companyId', '==', OWNER).where('phoneDigits', '==', data.phoneDigits).limit(5).get());
  if (hit) return { leadId: hit.id, lead: hit.data() || {}, created: false };

  const LB = require('./lead-bridge-logic');
  const doc = LB.mapPublicLeadToLead({
    collection: COL, sourceId: carePlanId, ownerUid: OWNER, companyId: OWNER,
    data: { firstName: data.firstName, lastName: data.lastName, phone: data.phone, email: data.email,
      address: [data.address, data.zip].filter(Boolean).join(' '), source: 'roof-care-plan' },
  });
  doc.source = 'Website — Roof Care Plan';
  doc.publicLeadKind = 'care_plan';
  doc.notes = 'Signed up online for the Roof Care Plan (' + (data.interval === 'month' ? '$19/month' : '$199/year') + '). Membership starts once payment goes through.';
  doc.createdAt = FieldValue.serverTimestamp();
  doc.stageStartedAt = FieldValue.serverTimestamp();
  const ref = leads.doc(COL + '__' + carePlanId);
  const { createLeadWithCustomerId } = require('./customer-id-mint');
  try {
    await createLeadWithCustomerId(db, ref, doc, { nbdOwnerUid: OWNER });
  } catch (e) { if (!isAlreadyExists(e)) throw e; }
  return { leadId: ref.id, lead: doc, created: true };
}

async function memberPlanFor(db, leadId) {
  const snap = await db.collection(COL).where('leadId', '==', leadId).limit(20).get();
  const docs = snap.docs.map((d) => ({ id: d.id, data: d.data() || {} })).filter((d) => d.data.companyId === OWNER);
  return {
    member: docs.find((d) => C.isMemberStatus(d.data.status)) || null,
    pending: docs.find((d) => d.data.status === 'pending') || null,
  };
}

// ── checkout ─────────────────────────────────────────────────────────────
/** Core of carePlanPublic { action:'checkout' }. Returns { status, body }. */
async function handleCheckout(db, stripe, body, currentMode) {
  if (currentMode === 'off') return { status: 404, body: { error: 'not_available' } };
  const v = C.validateCheckout(body);
  if (!v.ok) return { status: 400, body: { error: v.error } };
  const d = v.data;

  let carePlanId, leadId, lead, source, isNew = false;
  if (d.invite) {
    const snap = await db.collection(COL).where('inviteTokenHash', '==', sha256(d.invite)).limit(1).get();
    const doc = snap.docs[0];
    const plan = doc ? (doc.data() || {}) : null;
    if (!plan || plan.companyId !== OWNER) return { status: 404, body: { error: 'This link is no longer valid. Call or text Joe at (859) 420-7382.' } };
    if (C.isMemberStatus(plan.status)) return { status: 409, body: { error: 'already_member' } };
    if (Number(plan.inviteExpiresAtMs) && Number(plan.inviteExpiresAtMs) < Date.now()) {
      return { status: 410, body: { error: 'This link has expired. Call or text Joe at (859) 420-7382 for a new one.' } };
    }
    const leadSnap = await db.collection('leads').doc(String(plan.leadId)).get();
    lead = leadSnap.exists ? (leadSnap.data() || {}) : null;
    if (!lead || lead.companyId !== OWNER || lead.deleted === true) return { status: 404, body: { error: 'This link is no longer valid. Call or text Joe at (859) 420-7382.' } };
    carePlanId = doc.id; leadId = leadSnap.id; source = 'crm_invite';
  } else {
    // Direct signup: the public page, live — or Jo's preview while in test.
    if (currentMode !== 'live' && body.preview !== true) return { status: 404, body: { error: 'not_available' } };
    carePlanId = db.collection(COL).doc().id;
    const found = await findOrCreateLead(db, d, carePlanId);
    leadId = found.leadId; lead = found.lead; source = 'website';
    const existing = await memberPlanFor(db, leadId);
    if (existing.member) return { status: 409, body: { error: 'already_member' } };
    if (existing.pending) carePlanId = existing.pending.id;
    else isNew = true;
  }

  const email = d.email || lead.email || '';
  const ref = db.collection(COL).doc(carePlanId);
  const record = {
    companyId: OWNER,
    leadId,
    userId: lead.userId || OWNER,
    status: 'pending',
    interval: d.interval,
    amountCents: C.PRICES_CENTS[d.interval],
    currency: C.CURRENCY,
    disclosureVersion: C.DISCLOSURE_VERSION,
    disclosureText: C.disclosureText(d.interval),
    termsAcceptedAt: FieldValue.serverTimestamp(),
    memberName: [d.firstName || lead.firstName, d.lastName || lead.lastName].filter(Boolean).join(' '),
    memberEmail: email,
    memberPhone: d.phone || lead.phone || '',
    memberAddress: d.address || lead.address || '',
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (isNew) { record.source = source; record.createdAt = FieldValue.serverTimestamp(); }
  // Written BEFORE the session exists, so the webhook can always find it.
  await ref.set(record, { merge: true });

  const productId = await ensureProduct(stripe);
  const session = await stripe.checkout.sessions.create(C.checkoutParams({
    carePlanId, leadId, companyId: OWNER, interval: d.interval, email, productId,
  }));
  await ref.set({ stripeCheckoutSessionId: session.id, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  logger.info('carePlan.checkout_session', { carePlanId, leadId, interval: d.interval, via: source || 'existing' });
  return { status: 200, body: { url: session.url } };
}

// ── portal (cancel anytime) ──────────────────────────────────────────────
async function portalForCustomer(db, stripe, customer) {
  const configuration = await ensurePortalConfig(db, stripe);
  const ps = await stripe.billingPortal.sessions.create({ customer, configuration, return_url: C.PUBLIC_PAGE });
  return ps.url;
}
/** Core of carePlanPublic { action:'portal', sessionId }. The Checkout session id
 *  from the success redirect is the member's bearer proof (unguessable). */
async function handlePortal(db, stripe, body) {
  const sid = body && typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(sid)) return { status: 400, body: { error: 'Invalid link' } };
  let session;
  try { session = await stripe.checkout.sessions.retrieve(sid); } catch (e) { return { status: 404, body: { error: 'Not found' } }; }
  if (!C.isCarePlanObject(session) || (session.metadata || {}).companyId !== OWNER || !session.customer) {
    return { status: 404, body: { error: 'Not found' } };
  }
  const customer = typeof session.customer === 'string' ? session.customer : session.customer.id;
  return { status: 200, body: { url: await portalForCustomer(db, stripe, customer) } };
}

// ── webhook ──────────────────────────────────────────────────────────────
const EVENTS = new Set([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed',
]);

async function ownerEmail(db) {
  try {
    const u = await db.collection('users').doc(OWNER).get();
    const e = u.exists && u.data() && u.data().email;
    if (e && /@/.test(e)) return e;
  } catch (_) { /* fall through */ }
  return OWNER_ALERT_FALLBACK;
}

/**
 * Apply one Stripe event. Always re-reads the subscription, so the stored
 * state is Stripe's CURRENT state whatever order events arrive in.
 * Returns a small summary (for logs + tests).
 */
async function handleEvent(db, stripe, event, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!event || !EVENTS.has(event.type) || event.account) return { skipped: 'type' };
  const obj = (event.data && event.data.object) || {};
  let subId = null;
  let tagged = C.isCarePlanObject(obj);
  if (event.type.startsWith('checkout.session')) subId = obj.subscription || null;
  else if (event.type.startsWith('customer.subscription')) subId = obj.id;
  else subId = obj.subscription || null;
  if (!tagged && !subId) return { skipped: 'not_care_plan' };
  if (!subId) return { skipped: 'no_subscription' };   // e.g. an unpaid session — the subscription events follow
  const sub = await stripe.subscriptions.retrieve(typeof subId === 'string' ? subId : subId.id, { expand: ['items.data.price'] });
  if (!C.isCarePlanObject(sub)) return { skipped: 'not_care_plan' };   // NBD Pro billing etc. — not ours
  const meta = sub.metadata || {};
  if (meta.companyId !== OWNER || !meta.carePlanId) {
    logger.error('carePlan.webhook_foreign_metadata', { eventId: event.id, companyId: meta.companyId || null });
    return { skipped: 'foreign' };
  }
  const ref = db.collection(COL).doc(String(meta.carePlanId));
  const snap = await ref.get();
  const prior = snap.exists ? (snap.data() || {}) : null;
  if (!prior || prior.companyId !== OWNER || (meta.leadId && prior.leadId !== meta.leadId)) {
    logger.error('carePlan.webhook_plan_mismatch', { eventId: event.id, carePlanId: meta.carePlanId, found: !!prior });
    return { skipped: 'plan_mismatch' };
  }

  const state = C.stateFromSubscription(sub);
  const patch = Object.assign({}, state, {
    lastStripeEventId: event.id, lastStripeEventType: event.type, updatedAt: FieldValue.serverTimestamp(),
  });
  if (!patch.cancelledAt) delete patch.cancelledAt;
  if (event.type === 'invoice.paid') { patch.lastPaidAt = new Date(now).toISOString(); patch.lastInvoiceId = obj.id || null; }
  if (event.type === 'invoice.payment_failed') patch.lastPaymentFailedAt = new Date(now).toISOString();
  const becameMember = C.isMemberStatus(state.status) && !prior.activatedAtMs;
  if (becameMember) {
    patch.activatedAtMs = now;
    patch.activatedAt = new Date(now).toISOString();
    // The invite link has done its job.
    patch.inviteTokenHash = FieldValue.delete();
  }
  await ref.set(patch, { merge: true });

  const merged = Object.assign({}, prior, state, becameMember ? { activatedAtMs: now, activatedAt: patch.activatedAt } : {});
  const leadRef = db.collection('leads').doc(String(prior.leadId));
  const leadSnap = await leadRef.get();
  const lead = leadSnap.exists ? (leadSnap.data() || {}) : null;
  const out = { carePlanId: ref.id, status: state.status, becameMember, task: null, alerted: false };
  if (!lead || lead.companyId !== OWNER) {
    logger.warn('carePlan.webhook_lead_missing', { carePlanId: ref.id, leadId: prior.leadId });
    return out;
  }
  await leadRef.update({ carePlan: C.leadMirror(ref.id, merged), updatedAt: FieldValue.serverTimestamp() });

  if (C.isMemberStatus(state.status) && merged.activatedAtMs) {
    const t = C.inspectionTask({
      carePlanId: ref.id, leadId: leadRef.id, ownerUid: lead.userId || OWNER, companyId: OWNER,
      activatedAtMs: merged.activatedAtMs, yearIndex: C.membershipYearIndex(merged.activatedAtMs, now),
    });
    if (await createIfAbsent(leadRef.collection('tasks').doc(t.id), Object.assign(t.doc, { createdAt: FieldValue.serverTimestamp() }))) out.task = t.id;
  }
  if (becameMember) {
    const msg = C.ownerAlertEmail({ firstName: lead.firstName, lastName: lead.lastName, address: lead.address,
      phone: lead.phone, email: lead.email || prior.memberEmail, interval: merged.interval, leadId: leadRef.id });
    out.alerted = await createIfAbsent(db.collection('email_queue').doc('careplan-joined-' + ref.id), {
      to: await ownerEmail(db), subject: msg.subject, bodyPlain: msg.bodyPlain,
      status: 'pending', source: 'care_plan_joined', companyId: OWNER, createdAt: FieldValue.serverTimestamp(),
    });
  }
  return out;
}

// ── CRM actions ──────────────────────────────────────────────────────────
// The platform owner (Jo), the owner's company_admin, or a platform admin —
// the admin test is passed in at the call site (FUNCTIONS_INDEX drift guard).
function requireOwner(request, isPlatformAdmin) {
  const a = request.auth;
  if (!a || !a.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const t = a.token || {};
  if (a.uid === OWNER || isPlatformAdmin(t)) return;
  if (t.companyId === OWNER && t.role === 'company_admin') return;
  throw new HttpsError('permission-denied', 'The Roof Care Plan is managed by the account owner.');
}

async function handleAdmin(db, stripe, data, currentMode, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const action = data && data.action;
  if (action === 'status') return { mode: currentMode, prices: C.PRICES_CENTS };
  if (action === 'invite') {
    if (currentMode === 'off') throw new HttpsError('failed-precondition', 'The Roof Care Plan is not turned on yet.');
    const leadId = typeof data.leadId === 'string' ? data.leadId : '';
    if (!leadId || leadId.length > 200) throw new HttpsError('invalid-argument', 'leadId required');
    const leadSnap = await db.collection('leads').doc(leadId).get();
    const lead = leadSnap.exists ? (leadSnap.data() || {}) : null;
    if (!lead || lead.companyId !== OWNER || lead.deleted === true) throw new HttpsError('not-found', 'Customer not found');
    const existing = await memberPlanFor(db, leadId);
    if (existing.member) throw new HttpsError('already-exists', 'This customer is already a Roof Care Plan member.');
    const token = crypto.randomBytes(24).toString('base64url');
    const ref = existing.pending ? db.collection(COL).doc(existing.pending.id) : db.collection(COL).doc();
    const rec = {
      companyId: OWNER, leadId, userId: lead.userId || OWNER, status: 'pending',
      inviteTokenHash: sha256(token), inviteCreatedAtMs: now, inviteExpiresAtMs: now + INVITE_TTL_MS,
      memberName: [lead.firstName, lead.lastName].filter(Boolean).join(' '),
      memberEmail: lead.email || '', memberPhone: lead.phone || '', memberAddress: lead.address || '',
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (!existing.pending) { rec.source = 'crm_invite'; rec.createdAt = FieldValue.serverTimestamp(); }
    await ref.set(rec, { merge: true });
    // Not sent from here — Jo sends it himself (text / email buttons in the CRM).
    return { carePlanId: ref.id, url: C.PUBLIC_PAGE + '?invite=' + token, expiresAtMs: rec.inviteExpiresAtMs,
      name: rec.memberName, email: rec.memberEmail, phone: rec.memberPhone };
  }
  if (action === 'portal') {
    const id = typeof data.carePlanId === 'string' ? data.carePlanId : '';
    const snap = id ? await db.collection(COL).doc(id).get() : null;
    const plan = snap && snap.exists ? (snap.data() || {}) : null;
    if (!plan || plan.companyId !== OWNER) throw new HttpsError('not-found', 'Membership not found');
    if (!plan.stripeCustomerId) throw new HttpsError('failed-precondition', 'This membership has no billing account yet.');
    return { url: await portalForCustomer(db, stripe, plan.stripeCustomerId) };
  }
  throw new HttpsError('invalid-argument', 'Unknown action');
}

// ── Function wrappers ────────────────────────────────────────────────────
function rateLimitKey(req) {
  const { clientIp } = require('./integrations/upstash-ratelimit');
  const ip = String(clientIp(req) || '');
  return ip.indexOf(':') === -1 ? ip : ip.split(':').slice(0, 4).join(':') + '::/64';
}

exports.carePlanPublic = onRequest(
  {
    cors: CORS_ORIGINS,
    invoker: 'public',
    secrets: [STRIPE_SECRET_KEY, INT_SECRETS.TURNSTILE_SECRET],
    maxInstances: 10,
    concurrency: 40,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method === 'GET') {
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ mode: mode(), prices: C.PRICES_CENTS });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const { enforceRateLimit, httpRateLimit } = require('./integrations/upstash-ratelimit');
    try {
      await enforceRateLimit('carePlan:ip', rateLimitKey(req), 10, 600_000);
    } catch (e) {
      if (e && e.rateLimited) { res.set('Retry-After', '600'); res.status(429).json({ error: 'Too many tries — call or text Joe at (859) 420-7382.' }); return; }
      if (!(await httpRateLimit(req, res, 'carePlan:ip', 10, 600_000))) return;
    }
    const body = req.body || {};
    if (['nbd_hp', 'website'].some((k) => body[k] != null && String(body[k]).length > 0)) {
      res.status(200).json({ ok: true });   // honeypot: pretend success, do nothing
      return;
    }
    try {
      const db = getFirestore();
      let out;
      if (body.action === 'portal') {
        out = await handlePortal(db, stripeClient(), body);
      } else if (body.action === 'checkout') {
        const { verifyTurnstile } = require('./integrations/turnstile');
        const { clientIp } = require('./integrations/upstash-ratelimit');
        const ts = await verifyTurnstile(body.turnstileToken || '', clientIp(req));
        if (!ts.ok) { res.status(403).json({ error: 'Verification failed — please try again.' }); return; }
        out = await handleCheckout(db, stripeClient(), body, mode());
      } else {
        out = { status: 400, body: { error: 'Invalid request' } };
      }
      res.status(out.status).json(out.body);
    } catch (e) {
      logger.error('carePlanPublic error', { action: body.action, err: e.message });
      res.status(500).json({ error: 'Something went wrong — call or text Joe at (859) 420-7382.' });
    }
  }
);

exports.carePlanWebhook = onRequest(
  {
    cors: false,
    invoker: 'public',   // Stripe calls unauthenticated — security is the signature
    secrets: [STRIPE_SECRET_KEY, STRIPE_CAREPLAN_WEBHOOK_SECRET],
    maxInstances: 5,
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const whsec = secretValue(STRIPE_CAREPLAN_WEBHOOK_SECRET);
    if (!whsec || !whsec.startsWith('whsec_')) {
      logger.error('carePlanWebhook: STRIPE_CAREPLAN_WEBHOOK_SECRET not set — rejecting');
      res.status(503).json({ error: 'Webhook not configured' });
      return;
    }
    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) { res.status(400).json({ error: 'Invalid request body' }); return; }
    const sig = req.headers['stripe-signature'];
    if (typeof sig !== 'string' || !sig) { res.status(400).json({ error: 'Missing Stripe signature' }); return; }
    const stripe = stripeClient();
    let event;
    try { event = stripe.webhooks.constructEvent(req.rawBody, sig, whsec, 300); } catch (e) {
      logger.error('carePlanWebhook signature verification failed', { err: e.message });
      res.status(400).json({ error: 'Webhook signature verification failed' });
      return;
    }
    const db = getFirestore();
    const marker = db.collection('careplan_events').doc(event.id);
    if (!(await createIfAbsent(marker, { type: event.type, processedAt: FieldValue.serverTimestamp() }))) {
      res.json({ received: true, duplicate: true });
      return;
    }
    try {
      const out = await handleEvent(db, stripe, event);
      logger.info('carePlanWebhook', Object.assign({ eventId: event.id, type: event.type }, out));
      res.json({ received: true });
    } catch (e) {
      logger.error('carePlanWebhook processing error', { eventId: event.id, err: e.message });
      // Let Stripe's retry re-process: drop the marker (every write is a re-derivable merge).
      await marker.delete().catch(() => {});
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

exports.carePlanAdmin = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, secrets: [STRIPE_SECRET_KEY], timeoutSeconds: 30, memory: '256MiB' },
  async (request) => {
    requireOwner(request, (t) => t.role === 'admin');
    const data = request.data || {};
    const db = getFirestore();
    const out = await handleAdmin(db, data.action === 'portal' ? stripeClient() : null, data, mode());
    logger.info('carePlanAdmin', { action: data.action, uid: request.auth.uid });
    return out;
  }
);

// Test seam (non-function export; not deployed).
exports._internal = {
  handleCheckout, handlePortal, handleEvent, handleAdmin, findOrCreateLead, requireOwner, sha256,
  setStripe: (s) => { _stripe = s; },
  reset: () => { _productReady = false; },
};
