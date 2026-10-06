/**
 * functions/care-plan-logic.js — pure rules for the Roof Care Plan
 * (NBD's own homeowner membership). No firebase, no Stripe SDK: everything
 * here is a function of its inputs so tests can pin it.
 *
 * The terms are exactly what docs/services/roof-care-plan.html promises
 * (Jo, 2026-10-05): $199 a year OR $19 a month, no lock-in, renews until
 * cancelled, cancel anytime. Design note:
 * documentation/projects/ROOF-CARE-PLAN-2026-10-05.md
 *
 * Money is in cents. The plan is sold on the PLATFORM tenant's own Stripe
 * account (NBD's), never through Connect and never for another tenant.
 */
'use strict';

// ── Terms ────────────────────────────────────────────────────────────────
const PRICES_CENTS = Object.freeze({ year: 19900, month: 1900 });
const INTERVALS = Object.freeze(['year', 'month']);
const CURRENCY = 'usd';

// Every Stripe object this plan creates carries this tag, so it can always be
// told apart from NBD Pro (contractor) billing on the same account — by our
// own webhook, by stripeWebhook (which must ignore it), by the Stripe ledger,
// and by anything else listening (Jo's unmanaged Cloudflare-Worker webhook).
const PRODUCT_TAG = 'roof_care_plan';
// Stripe allows a caller-chosen product id: creation is lazy and idempotent
// (create with this id; "already exists" means it's there).
const STRIPE_PRODUCT_ID = 'nbd_roof_care_plan';
const PRODUCT_NAME = 'NBD Roof Care Plan';

// The renewal / cancellation disclosure shown before payment (page + Stripe
// Checkout) and recorded on the membership with its version.
const DISCLOSURE_VERSION = '2026-10-05';
function disclosureText(interval) {
  const yearly = interval === 'year';
  const price = yearly ? '$199' : '$19';
  const every = yearly ? 'every year' : 'every month';
  return price + ' today, then ' + price + ' ' + every + ' until you cancel — the plan renews automatically. '
    + 'No lock-in: cancel anytime from your billing link or by calling or texting Joe, and you will not be charged again. '
    + 'Your plan stays active through the time you have already paid for.';
}

const PUBLIC_PAGE = 'https://nobigdealwithjoedeal.com/services/roof-care-plan';

// ── The DARK switch ──────────────────────────────────────────────────────
// CARE_PLAN_MODE (functions/.env.nobigdeal-pro):
//   unset / 'off'  — nothing sells. The page keeps "Get My Care Plan" → contact.
//   'test'         — Jo's CRM invite links work, and the page shows checkout
//                    only with ?preview=careplan. For Jo's own real $19 test.
//   'live'         — the page sells to everyone.
// Anything unrecognised is 'off' (fail closed).
function carePlanMode(env) {
  const v = String((env && env.CARE_PLAN_MODE) || '').trim().toLowerCase();
  return v === 'test' || v === 'live' ? v : 'off';
}

// ── Stripe object classification ─────────────────────────────────────────
function metaOf(obj) {
  if (!obj || typeof obj !== 'object') return {};
  if (obj.metadata && obj.metadata.nbdProduct) return obj.metadata;
  // Subscription invoices carry the subscription's metadata here.
  const sd = obj.subscription_details;
  if (sd && sd.metadata && sd.metadata.nbdProduct) return sd.metadata;
  // An invoice line can carry it too (older invoices without subscription_details).
  const lines = obj.lines && Array.isArray(obj.lines.data) ? obj.lines.data : [];
  for (const l of lines) if (l && l.metadata && l.metadata.nbdProduct) return l.metadata;
  return obj.metadata || {};
}
function isCarePlanObject(obj) {
  return metaOf(obj).nbdProduct === PRODUCT_TAG;
}

// Stripe subscription status → membership status.
function membershipStatus(subStatus) {
  switch (String(subStatus || '')) {
    case 'active': case 'trialing': return 'active';
    case 'past_due': case 'unpaid': return 'past_due';
    case 'canceled': return 'cancelled';
    case 'incomplete_expired': return 'expired';
    case 'paused': return 'paused';
    default: return 'pending';   // incomplete, or unknown
  }
}
// The statuses that count as "a member" for every CRM benefit (badge,
// 10% repair discount, storm priority). past_due keeps benefits while Stripe
// retries the card — same posture as the NBD Pro checkout gate.
const MEMBER_STATUSES = Object.freeze(['active', 'past_due']);
function isMemberStatus(s) { return MEMBER_STATUSES.indexOf(String(s || '')) !== -1; }

// ── Public signup validation ─────────────────────────────────────────────
function str(v, max) {
  if (typeof v !== 'string') return '';
  const t = v.replace(/[<>]/g, '').trim();
  return t.length > max ? '' : t;
}
function digits10(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  return d.length === 10 ? d : '';
}
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

/**
 * Validate a checkout request body. Returns { ok:true, data } or
 * { ok:false, error }. `invite` requests carry only interval + consent; the
 * person comes from the membership Jo created.
 */
function validateCheckout(body) {
  const b = body || {};
  const interval = INTERVALS.indexOf(b.interval) !== -1 ? b.interval : null;
  if (!interval) return { ok: false, error: 'Choose yearly or monthly.' };
  if (b.termsAccepted !== true) return { ok: false, error: 'Please confirm the renewal terms.' };
  const invite = typeof b.invite === 'string' && /^[A-Za-z0-9_-]{20,128}$/.test(b.invite) ? b.invite : null;
  if (invite) return { ok: true, data: { interval, invite } };
  const data = {
    interval,
    firstName: str(b.firstName, 100),
    lastName: str(b.lastName, 100),
    email: str(b.email, 200).toLowerCase(),
    phone: str(b.phone, 30),
    address: str(b.address, 300),
    zip: str(b.zip, 10),
    tcpaConsent: b.tcpaConsent === true,
  };
  if (!data.firstName) return { ok: false, error: 'Please enter your first name.' };
  if (!EMAIL_RE.test(data.email)) return { ok: false, error: 'Please enter a valid email.' };
  if (!digits10(data.phone)) return { ok: false, error: 'Please enter a 10-digit phone number.' };
  if (!data.address) return { ok: false, error: 'Please enter the home address for the plan.' };
  if (data.zip && !/^\d{5}$/.test(data.zip)) data.zip = '';
  data.phoneDigits = digits10(data.phone);
  return { ok: true, data };
}

// ── Stripe Checkout session params ───────────────────────────────────────
/**
 * Subscription-mode Checkout with inline price_data on the lazily-created
 * product. NO client_reference_id: stripeWebhook treats a session's
 * client_reference_id as an NBD Pro account uid and would grant a CRM plan.
 */
function checkoutParams(args) {
  const a = args || {};
  const interval = a.interval === 'month' ? 'month' : 'year';
  const meta = {
    nbdProduct: PRODUCT_TAG,
    carePlanId: String(a.carePlanId || ''),
    leadId: String(a.leadId || ''),
    companyId: String(a.companyId || ''),
    interval,
  };
  const base = a.pageUrl || PUBLIC_PAGE;
  const params = {
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{
      quantity: 1,
      price_data: {
        currency: CURRENCY,
        product: a.productId || STRIPE_PRODUCT_ID,
        unit_amount: PRICES_CENTS[interval],
        recurring: { interval },
      },
    }],
    metadata: meta,
    subscription_data: { metadata: meta },
    custom_text: { submit: { message: disclosureText(interval) } },
    success_url: base + '?careplan=joined&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: base + '?careplan=cancelled',
    allow_promotion_codes: false,
    billing_address_collection: 'auto',
  };
  if (a.email && EMAIL_RE.test(String(a.email))) params.customer_email = String(a.email);
  return params;
}

// ── Membership state from a Stripe subscription ──────────────────────────
function isoFromUnix(sec) {
  const n = Number(sec);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null;
}
/**
 * The membership fields a subscription's CURRENT state implies. The webhook
 * always re-fetches the subscription and writes this, so out-of-order or
 * repeated deliveries converge on Stripe's truth.
 */
function stateFromSubscription(sub) {
  const s = sub || {};
  const item = s.items && Array.isArray(s.items.data) ? s.items.data[0] : null;
  const price = item && item.price ? item.price : {};
  const interval = (price.recurring && price.recurring.interval) || (s.metadata && s.metadata.interval) || null;
  const out = {
    status: membershipStatus(s.status),
    stripeStatus: String(s.status || ''),
    stripeSubscriptionId: s.id || null,
    stripeCustomerId: typeof s.customer === 'string' ? s.customer : (s.customer && s.customer.id) || null,
    currentPeriodEnd: isoFromUnix(s.current_period_end),
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
  };
  if (interval === 'year' || interval === 'month') out.interval = interval;
  if (Number.isFinite(Number(price.unit_amount))) out.amountCents = Number(price.unit_amount);
  if (s.status === 'canceled') out.cancelledAt = isoFromUnix(s.canceled_at || s.ended_at) || null;
  return out;
}

/** The small mirror kept on leads/{leadId}.carePlan (server-written only). */
function leadMirror(carePlanId, plan) {
  const p = plan || {};
  return {
    carePlanId: String(carePlanId),
    status: p.status || 'pending',
    member: isMemberStatus(p.status),
    interval: p.interval || null,
    since: p.activatedAt || null,
    renewsAt: p.cancelAtPeriodEnd ? null : (p.currentPeriodEnd || null),
    endsAt: p.cancelAtPeriodEnd ? (p.currentPeriodEnd || null) : null,
  };
}

// ── Yearly inspection reminder ───────────────────────────────────────────
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
/** 0 in the first membership year, 1 in the second, … */
function membershipYearIndex(activatedAtMs, nowMs) {
  const a = Number(activatedAtMs), n = Number(nowMs);
  if (!Number.isFinite(a) || !Number.isFinite(n) || n < a) return 0;
  return Math.floor((n - a) / YEAR_MS);
}
function addYears(ms, years) {
  const d = new Date(ms);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.getTime();
}
/**
 * The inspection task for membership year `yearIndex`. Year 0 is due two
 * weeks after joining (first visit); later years are due on the anniversary.
 * Deterministic id → a webhook retry or a monthly renewal never duplicates it.
 */
function inspectionTask(args) {
  const a = args || {};
  const y = Math.max(0, Math.floor(Number(a.yearIndex) || 0));
  const start = Number(a.activatedAtMs);
  const dueMs = y === 0 ? start + 14 * 24 * 3600 * 1000 : addYears(start, y);
  const due = new Date(dueMs).toISOString().slice(0, 10);
  const title = 'Roof Care Plan — yearly inspection' + (y === 0 ? ' (first visit)' : ' (year ' + (y + 1) + ')');
  return {
    id: 'careplan_' + a.carePlanId + '_y' + (y + 1),
    doc: {
      leadId: String(a.leadId),
      userId: String(a.ownerUid),
      companyId: String(a.companyId),
      title,
      text: title,
      notes: 'Member benefit: full inspection + written condition report with photos; sealant touch-ups and up to 3 shingles (about 30 min) on the visit. Repairs beyond that are quoted at the 10% member discount.',
      dueDate: due,
      priority: 'normal',
      done: false,
      source: 'care_plan',
      createdBy: 'Roof Care Plan',
      carePlanId: String(a.carePlanId),
    },
  };
}

// ── Owner alert (Jo's own inbox — never the homeowner) ───────────────────
function ownerAlertEmail(args) {
  const a = args || {};
  const name = [a.firstName, a.lastName].filter(Boolean).join(' ') || 'A homeowner';
  const price = a.interval === 'month' ? '$19/month' : '$199/year';
  const lines = [
    name + ' just joined the Roof Care Plan (' + price + ').',
    '',
    a.address ? 'Address: ' + a.address : null,
    a.phone ? 'Phone:   ' + a.phone : null,
    a.email ? 'Email:   ' + a.email : null,
    '',
    'A "yearly inspection (first visit)" task is on their card, due in two weeks.',
    'Open the customer in the CRM: https://nobigdealwithjoedeal.com/pro/customer.html?id=' + encodeURIComponent(String(a.leadId || '')),
  ].filter((l) => l !== null);
  return { subject: 'New Roof Care Plan member — ' + name, bodyPlain: lines.join('\n') };
}

module.exports = {
  PRICES_CENTS, INTERVALS, CURRENCY, PRODUCT_TAG, STRIPE_PRODUCT_ID, PRODUCT_NAME,
  DISCLOSURE_VERSION, PUBLIC_PAGE, MEMBER_STATUSES,
  disclosureText, carePlanMode, metaOf, isCarePlanObject, membershipStatus, isMemberStatus,
  validateCheckout, checkoutParams, stateFromSubscription, leadMirror,
  membershipYearIndex, inspectionTask, ownerAlertEmail, digits10,
};
