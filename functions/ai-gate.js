/**
 * functions/ai-gate.js — who may spend NBD's AI keys (2026-11-14).
 *
 * Every AI call in NBD Pro is billed to NBD's own Anthropic / Groq /
 * Replicate keys. Joe's rule (2026-11-14): free accounts get NO AI. Every AI
 * feature needs a paid plan AND a confirmed email. Exempt:
 *   - the platform admin (role 'admin'), and
 *   - the platform tenant (NBD's own uid / company, NBD_OWNER_UID), which
 *     may have no Stripe subscription, so Joe can't lock himself out.
 * Every other tenant follows the plan rule; there is no per-tenant exception.
 *
 * 2026-11-25 (roadmap step 12): claudeProxy, adminAI, leadBrief, callBrief
 * and coachLine carried their own copies of this rule; they now call the one
 * gate, aiGate(), which is the plan check AND the daily spend breaker (see
 * the breaker block below). Every server AI entry point calls aiGate (or its
 * callable adapter assertAiEntitled) before spending.
 *
 *   aiGate(db, opts)                 → the gate; see its doc comment
 *   aiEntitlement(db, claims, uid)   → { ok: true } | { ok: false, reason }
 *     claims: a decoded ID token / request.auth.token (role, companyId,
 *     email_verified). reason: 'unverified' | 'plan' | 'plan_check_failed'.
 *   aiEntitlementForUid(db, uid, { getUser }) → same, for triggers that only
 *     know the uploader's uid: claims come from the Auth record.
 *   assertAiEntitled(db, auth)       → throws HttpsError for onCall handlers.
 *
 * A failed plan read fails CLOSED (no AI), never open.
 */
'use strict';

const PLATFORM_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

const MESSAGES = {
  unverified: 'Confirm your email address to use AI features.',
  plan: 'AI features are part of the paid plans. Upgrade to use them.',
  plan_check_failed: 'Could not check your plan. Try again shortly.',
  // The spend breaker (below).
  platform_cap: 'AI paused until tomorrow (daily limit).',
  company_cap: 'AI paused until tomorrow (daily limit).',
  public_cap: 'AI paused until tomorrow (daily limit).',
  paused: 'AI is paused right now. Try again later.',
};

function isPaidSubscription(s, nowMs) {
  if (!(s && s.plan && s.plan !== 'free' && (s.status === 'active' || s.status === 'trialing'))) return false;
  // An access-code trial past its trialEndsAt is free (billing.js reads it
  // the same way; nothing ever downgrades the doc itself).
  if (s.source === 'access_code' && s.trialEndsAt && typeof s.trialEndsAt.toMillis === 'function'
    && s.trialEndsAt.toMillis() < (nowMs || Date.now())) return false;
  return true;
}

// The tenant's own plan doc decides (2026-11-25, roadmap step 12): a paid
// plan → its plan name keys the per-company spend cap; platformTenant: true
// (set by hand on the platform's own subscriptions doc; no writer sets it,
// and client writes to subscriptions are refused by the rules) → the
// platform tenant, exempt from the paid-plan rule, capped at the platform cap.
function planVerdict(sub, billingId) {
  if (sub && sub.platformTenant === true) return { ok: true, exempt: 'platform_tenant', companyId: billingId, capKey: 'platform' };
  return isPaidSubscription(sub) ? { ok: true, companyId: billingId, capKey: String(sub.plan) } : { ok: false, reason: 'plan' };
}

async function readPlan(db, billingId) {
  let snap;
  try {
    snap = await db.doc('subscriptions/' + billingId).get();
  } catch (_) {
    return { ok: false, reason: 'plan_check_failed' }; // fail CLOSED: no plan, no AI
  }
  return planVerdict(snap && snap.exists ? snap.data() : null, billingId);
}

// The platform tenant's own plan doc decides first (platformTenant: true, or
// a paid plan). PLATFORM_UID stays only as the transitional fallback until
// that doc carries platformTenant: true: a missing doc, or a failed read,
// still lets the platform run (before 2026-11-25 it read no plan at all), so
// Joe can't lock himself out. Every other tenant fails closed on a failed read.
async function platformTenantPlan(db, billingId) {
  const v = await readPlan(db, billingId);
  if (v.ok) return v;
  return { ok: true, exempt: 'platform_tenant', companyId: billingId, capKey: 'platform' };
}

async function aiEntitlement(db, claims, uid) {
  const t = claims || {};
  const id = uid || t.uid || t.user_id || '';
  // companyId: the company this caller's AI is billed and metered to.
  if (t.role === 'admin') return { ok: true, exempt: 'platform_admin', companyId: t.companyId || id, capKey: 'platform' };
  if (id === PLATFORM_UID || t.companyId === PLATFORM_UID) return platformTenantPlan(db, t.companyId || id);
  if (t.email_verified !== true) return { ok: false, reason: 'unverified' };
  const billingId = t.companyId || id;
  if (!billingId) return { ok: false, reason: 'plan' };
  return readPlan(db, billingId);
}

// Unattended pipelines that run FOR a tenant with no signed-in caller (the
// call-center notes, Thursday's extraction, the text inbox): that tenant's
// own plan, no email check (there is no person). Fails closed like the rest.
async function tenantEntitlement(db, companyId) {
  const id = String(companyId || '');
  if (!id || id.includes('/')) return { ok: false, reason: 'plan' };
  if (id === PLATFORM_UID) return platformTenantPlan(db, id);
  return readPlan(db, id);
}

// Triggers (Storage / Firestore) have no ID token: read the uploader's Auth
// record, as callBriefAuto does. A failed lookup fails closed.
async function aiEntitlementForUid(db, uid, opts) {
  if (!uid) return { ok: false, reason: 'plan' };
  const getUser = (opts && opts.getUser) || ((u) => require('firebase-admin/auth').getAuth().getUser(u));
  let rec;
  try {
    rec = await getUser(uid);
  } catch (_) {
    return { ok: false, reason: 'plan_check_failed' };
  }
  if (rec && rec.disabled === true) return { ok: false, reason: 'plan' }; // a deactivated account spends nothing
  const c = (rec && rec.customClaims) || {};
  // A rep whose Auth record has no companyId claim (stale claims) still
  // belongs to the company on users/{uid}.companyId, which only the server
  // writes (firestore.rules users block): the same lookup the pipelines'
  // budget uses, so a paying tenant's rep isn't told to upgrade.
  let companyId = c.companyId;
  if (!companyId) {
    try {
      const u = await db.doc('users/' + uid).get();
      companyId = (u && u.exists && u.data() && u.data().companyId) || undefined;
    } catch (_) {
      return { ok: false, reason: 'plan_check_failed' };
    }
  }
  return aiEntitlement(db, { role: c.role, companyId, email_verified: !!(rec && rec.emailVerified) }, uid);
}

// ═══════════════════════════════════════════════════════════════════════
// The spend breaker (2026-11-25, roadmap step 12; audit §3.2).
//
// Before this, a bug or an abuse loop could spend without limit: the only
// stops were per-feature quotas and a human flipping the kill switch.
//
// Caps come from real spend (Joe's rule). Measured read-only on 2026-11-22
// from ai_spend_daily, the last 31 days: $1.82 in total, $0.06/day on
// average, busiest day $0.46 (2026-11-07, a smart-followup burst of 328
// calls), next busiest $0.29. Joe chose platform cap = 3 x the busiest day.
// $1.38 could trip on a legitimately busy day, so the $5 floor is kept next
// to it; the ACTIVE cap is one config value (platformDailyUsd below) that
// defaults to the formula. Money is integer micro-dollars, as in ai-spend.js.
//
// Per-company caps: no per-company spend existed before this change
// (ai_spend_daily is platform-wide; ai_spend_daily_co starts now), so they
// are PROPORTIONAL DEFAULTS: each plan's monthly list price over the top
// self-serve plan's (Growth $299) times the active platform cap, never below
// the busiest measured day ($0.46, so a burst like NBD's 2026-11-07 one does
// not trip a Starter tenant) and never above HALF the platform cap, for every
// plan and the platform tenant too, so no one company's loop can pause every
// other tenant on its own. Once ai_spend_daily_co has history, re-derive
// them the same way (3 x a company's busiest day) and set perPlanDailyUsd.
//
// Public endpoints (publicVisualizerAI, publicFunnelAI) are anonymous, so
// their spend is its OWN bucket: read from the features.<feature> counters
// on the same ai_spend_daily doc (no extra read), held to publicDailyUsd
// (default half the platform cap), and left OUT of the total the platform
// cap is compared with, so anonymous traffic can never pause paying tenants.
// The platform cap is therefore a cap on tenant spend; the most the platform
// can spend in a day is platformDailyUsd + publicDailyUsd.
//
// Config: feature_flags/global.aiSpendLimits (read through the kill
// switch's existing 60-second cached flag read, so the limits cost no new
// read):  { platformDailyUsd: 1.38, publicDailyUsd: 0.69,
//           perPlanDailyUsd: { team: 0.5, ... }, stopAll: false }
//   stopAll: true → every gated AI call is refused, unattended pipelines
//   included (aiDisabled deliberately leaves those running).
//
// Failure modes (the security part, deliberately asymmetric):
//   - the PLAN check fails CLOSED: an unreadable plan means no AI (the
//     platform tenant alone keeps its uid fallback, platformTenantPlan);
//   - the LIMITS read fails OPEN (the code defaults);
//   - the spend-total reads also fail OPEN, keeping the last-known total
//     (0 on a cold instance). This goes beyond "fail open only for the
//     limits read": a Firestore blip on a counter must not take every AI
//     feature down. It is never silent: each failed read is logged
//     (ai_spend_breaker_read_failed), once per counter per cache window.
// Cost: the two spend docs (platform day, company day) are cached per
// instance for SPEND_TTL_MS, so a busy instance reads each about twice a
// minute, not once per call. The cache can lag by that TTL: a burst can
// overshoot a cap by up to 30 seconds of spend per instance.
// ═══════════════════════════════════════════════════════════════════════

const SPEND_MEASURED = Object.freeze({
  measuredOn: '2026-11-22', windowDays: 31, totalMicros: 1820000, avgDayMicros: 60000,
  busiestDay: '2026-11-07', busiestDayMicros: 460000, nextBusiestDayMicros: 290000,
});
const CAP_MULTIPLE = 3;
function capFromBusiestDay(busiestDayMicros, multiple) {
  return Math.round(Math.max(0, Number(busiestDayMicros) || 0) * (Number(multiple) || CAP_MULTIPLE));
}
const FORMULA_PLATFORM_DAILY_MICROS = capFromBusiestDay(SPEND_MEASURED.busiestDayMicros, CAP_MULTIPLE); // $1.38
const ALT_FLOOR_PLATFORM_DAILY_MICROS = 5000000; // $5.00
// Monthly list prices (docs/pro/js/billing-gate.js PLANS) → share of the cap.
const PLAN_PRICE = { starter: 99, foundation: 99, team: 149, growth: 299, professional: 299 };
const FULL_SHARE_PLANS = new Set(['platform', 'enterprise']);
const TOP_PRICE = 299;
const COMPANY_MAX_SHARE = 0.5; // no company's default cap is above half the platform cap
const PUBLIC_SHARE = 0.5; // the public endpoints' default cap, of the platform cap
// The anonymous features (handlers/ai.js recordAiSpend feature names).
const PUBLIC_FEATURES = ['public-visualizer', 'public-funnel'];
const SPEND_TTL_MS = 30000;

function usdToMicros(v) {
  const n = Number(v);
  return (typeof v === 'number' || typeof v === 'string') && Number.isFinite(n) && n > 0 ? Math.round(n * 1e6) : null;
}

/** feature_flags/global.aiSpendLimits → { platformMicros, perPlanMicros, stopAll }. Bad values fall back to the defaults. */
function resolveLimits(cfg) {
  const c = (cfg && typeof cfg === 'object') ? cfg : {};
  const perPlanMicros = {};
  const pp = (c.perPlanDailyUsd && typeof c.perPlanDailyUsd === 'object') ? c.perPlanDailyUsd : {};
  for (const k of Object.keys(pp)) { const m = usdToMicros(pp[k]); if (m !== null) perPlanMicros[k] = m; }
  const platformMicros = usdToMicros(c.platformDailyUsd) || FORMULA_PLATFORM_DAILY_MICROS;
  const publicMicros = usdToMicros(c.publicDailyUsd) || Math.floor(platformMicros * PUBLIC_SHARE);
  return { platformMicros, publicMicros, perPlanMicros, stopAll: c.stopAll === true };
}

/**
 * The daily cap for one company on plan `capKey`. An explicit
 * perPlanDailyUsd value wins (up to the platform cap); a default is the
 * plan's price share, at least the busiest measured day, at most half the
 * platform cap.
 */
function companyCapMicros(limits, capKey) {
  const key = String(capKey || '');
  const p = limits.platformMicros;
  if (Object.prototype.hasOwnProperty.call(limits.perPlanMicros, key)) return Math.min(limits.perPlanMicros[key], p);
  const price = Object.prototype.hasOwnProperty.call(PLAN_PRICE, key) ? PLAN_PRICE[key] : PLAN_PRICE.starter; // unknown paid plan → the smallest share
  const share = FULL_SHARE_PLANS.has(key) ? p : Math.floor(p * price / TOP_PRICE);
  return Math.min(Math.floor(p * COMPANY_MAX_SHARE), Math.max(SPEND_MEASURED.busiestDayMicros, share));
}

function etYmd(ms) { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
const safeId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 128 && !id.includes('/');

// Per-instance cache of the two spend counters, per Firestore handle.
let _spendCache = new WeakMap();
let _alerted = new Set();
function _resetBreakerCache() { _spendCache = new WeakMap(); _alerted = new Set(); }

/** One spend counter doc → { micros, publicMicros } (cached per instance for SPEND_TTL_MS). */
async function spent(db, path, nowMs) {
  let m = _spendCache.get(db);
  if (!m) { m = new Map(); _spendCache.set(db, m); }
  const hit = m.get(path);
  if (hit && nowMs - hit.at < SPEND_TTL_MS && nowMs >= hit.at) return hit.v;
  let v = hit ? hit.v : { micros: 0, publicMicros: 0 };
  try {
    const snap = await db.doc(path).get();
    const d = (snap && snap.exists && snap.data()) || {};
    const f = (d.features && typeof d.features === 'object') ? d.features : {};
    v = {
      micros: Number(d.usdMicros) || 0,
      publicMicros: PUBLIC_FEATURES.reduce((n, k) => n + (Number(f[k] && f[k].usdMicros) || 0), 0),
    };
  } catch (e) {
    // Fail OPEN: keep the last-known total (or 0). Logged, never silent; the
    // entry below is re-cached, so this logs once per counter per TTL.
    try { console.warn('ai_spend_breaker_read_failed', { path, err: e && e.message }); } catch (_) { /* ignore */ }
  }
  m.set(path, { at: nowMs, v });
  return v;
}

const fmtUsd = (micros) => '$' + ((Number(micros) || 0) / 1e6).toFixed(2);

// Platform-operator alert, the same recipient and queue health-digest.js and
// backup-freshness.js use today. The ONE place the breaker emails from; the
// owner text goes through notifyOwner via relayBreakerAlerts (cronDeadman).
const ALERT_RECIPIENT = 'jd@nobigdealwithjoedeal.com';
async function sendBreakerAlert(db, a) {
  const who = { company: 'company (' + a.companyId + ', plan ' + a.capKey + ')', public: 'public endpoints (visualizer, funnel)' }[a.cap] || 'platform';
  const what = {
    company: 'That company\'s AI features are paused until midnight ET.',
    public: 'The public website AI (visualizer, funnel) is paused until midnight ET; tenants are not affected.',
  }[a.cap] || 'Every AI feature is paused until midnight ET.';
  const field = { company: 'perPlanDailyUsd.' + a.capKey, public: 'publicDailyUsd' }[a.cap] || 'platformDailyUsd';
  const lines = [
    'The AI spend breaker tripped: the ' + who + ' daily cap of '
      + fmtUsd(a.capMicros) + ' was reached on ' + a.day + ' (spent so far ' + fmtUsd(a.spentMicros) + ').',
    what,
    'Last feature refused: ' + (a.feature || 'unknown') + '.',
    '',
    'To raise it: feature_flags/global.aiSpendLimits.' + field + ' (dollars).',
    'Formula default ' + fmtUsd(FORMULA_PLATFORM_DAILY_MICROS) + ' (3 x the busiest measured day); the alternative floor is ' + fmtUsd(ALT_FLOOR_PLATFORM_DAILY_MICROS) + '.',
  ];
  const { FieldValue } = require('firebase-admin/firestore');
  await db.collection('email_queue').add({
    to: ALERT_RECIPIENT,
    subject: 'AI paused: ' + ({ company: 'a company', public: 'the public endpoints' }[a.cap] || 'the platform') + ' hit the daily AI spend cap (' + a.day + ')',
    bodyHtml: '<pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px">' + lines.join('\n').replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>',
    bodyPlain: lines.join('\n'),
    kind: 'ai_spend_breaker_alert',
    status: 'pending', // without it the worker never claims the row
    createdAt: FieldValue.serverTimestamp(),
  });
}

/**
 * One alert per day per cap: an in-memory guard, then a Firestore create()
 * claim across instances. A failed SEND releases both (the claim doc is
 * deleted, best effort), so the next refusal retries: the day's one alert
 * is spent only once it is queued. Never throws.
 */
async function alertOnce(db, a, deps) {
  const key = a.day + '__' + (a.cap === 'company' ? 'co__' + a.companyId : a.cap);
  if (_alerted.has(key)) return;
  _alerted.add(key);
  const claim = db.doc('ai_spend_alerts/' + key);
  let claimed = false;
  try {
    await claim.create({ day: a.day, cap: a.cap, companyId: a.companyId || null, capKey: a.capKey || null, feature: a.feature || null, capMicros: a.capMicros, spentMicros: a.spentMicros, atMs: a.nowMs });
    claimed = true;
  } catch (e) {
    if (e && (e.code === 6 || /ALREADY_EXISTS|already exists/i.test(String(e.message)))) return; // another instance sent it
    // Any other claim failure: better a duplicate alert than a silent breaker.
  }
  try {
    await ((deps && deps.sendAlert) || sendBreakerAlert)(db, a);
  } catch (e) {
    try { console.warn('ai_spend_alert_failed', { key, err: e && e.message }); } catch (_) { /* ignore */ }
    _alerted.delete(key);
    if (claimed) { try { await claim.delete(); } catch (_) { /* a stuck claim: logged above */ } }
  }
}

/**
 * The owner text for a tripped breaker (roadmap step 13 follow-up). The AI
 * entry points that trip the breaker hold no Twilio secrets, so they only
 * write the claim doc and queue the email above. cronDeadman (every 30 min,
 * owns the SMS secrets and the daytime / overnight-summary rule) calls this:
 * each claim of today or yesterday (ET) not yet relayed goes through
 * notifyOwner once, as an 'alert' (bell + push + one text). A failed notify
 * leaves the claim unrelayed, so the next run retries. Never throws.
 * deps: { notify(msg) -> Promise, nowMs, limit? }.
 * Returns { relayed, failed, error? }.
 */
async function relayBreakerAlerts(db, deps) {
  const out = { relayed: 0, failed: 0 };
  try {
    const nowMs = Number(deps && deps.nowMs) || Date.now();
    const days = [etYmd(nowMs), etYmd(nowMs - 24 * 3600000)];
    const snaps = await Promise.all(days.map((d) => db.collection('ai_spend_alerts').where('day', '==', d).get()));
    const docs = [];
    snaps.forEach((s) => s.forEach((d) => { const v = d.data() || {}; if (v.relayedAtMs == null) docs.push({ ref: d.ref, id: d.id, v }); }));
    for (const { ref, id, v } of docs.slice(0, (deps && deps.limit) || 10)) {
      const who = { company: 'one company (' + (v.capKey || 'plan unknown') + ')', public: 'the public website AI' }[v.cap] || 'all AI features';
      const msg = {
        title: 'AI spend cap hit: ' + who + ' paused',
        body: 'The AI spend breaker paused ' + who + ' for ' + v.day + ' (cap ' + fmtUsd(v.capMicros) + ', spent ' + fmtUsd(v.spentMicros) + '). It resets at midnight ET. The email has how to raise it.',
        severity: 'alert', key: 'ai-spend:' + id, type: 'ai_spend_breaker', clickUrl: '/pro/dashboard.html', idPrefix: 'ai-spend-',
      };
      try {
        await deps.notify(msg);
        out.relayed++;
        try { await ref.update({ relayedAtMs: nowMs }); } catch (_) { /* notifyOwner's own key dedupe stops a second text today */ }
      } catch (e) {
        out.failed++;
        try { console.warn('ai_spend_alert_relay_failed', { id, err: e && e.message }); } catch (_) { /* ignore */ }
      }
    }
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 200);
  }
  return out;
}

function refusal(reason) {
  const code = reason === 'plan_check_failed' || reason === 'paused' ? 'unavailable'
    : (reason === 'platform_cap' || reason === 'company_cap' || reason === 'public_cap' ? 'resource-exhausted' : 'permission-denied');
  const status = code === 'unavailable' ? 503 : (code === 'resource-exhausted' ? 429 : 403);
  return { ok: false, reason, message: MESSAGES[reason] || MESSAGES.plan, code, status };
}

/**
 * THE AI gate: every server AI entry point calls this before spending.
 *   opts (one caller shape):
 *     auth: { uid, token }    a signed-in caller (callable request.auth, or
 *                             { uid: decoded.uid, token: decoded })
 *     forUid: uid             a trigger acting for a user (Auth record)
 *     companyId: id           an unattended pipeline for a tenant (that
 *                             tenant's own plan)
 *     publicCaller: true      an unauthenticated public endpoint (no plan;
 *                             the public cap, and the platform cap)
 *   feature, nowMs, deps: { getFlags, getUser, sendAlert } (tests)
 * → { ok: true, companyId, capKey } | { ok: false, reason, message, code, status }
 */
async function aiGate(db, opts) {
  const o = opts || {};
  const deps = o.deps || {};
  const nowMs = Number(o.nowMs) || Date.now();

  // 1. Limits: fail OPEN (defaults) on any read error.
  let limits;
  try {
    const getFlags = deps.getFlags || require('./integrations/killswitch').getFlags;
    limits = resolveLimits(((await getFlags()) || {}).aiSpendLimits);
  } catch (_) {
    limits = resolveLimits(null);
  }
  if (limits.stopAll) return refusal('paused');

  // 2. Plan: fail CLOSED.
  let ent;
  if (o.publicCaller === true) ent = { ok: true, companyId: null, capKey: null };
  else if (o.forUid) ent = await aiEntitlementForUid(db, o.forUid, { getUser: deps.getUser });
  else if (o.auth) ent = await aiEntitlement(db, o.auth.token, o.auth.uid);
  else if (o.companyId) ent = await tenantEntitlement(db, o.companyId);
  else ent = { ok: false, reason: 'plan' };
  if (!ent.ok) return refusal(ent.reason);

  // 3. The breaker: the platform cap (tenant spend: the day's total less the
  // anonymous public spend), then the public cap or this company's cap.
  const day = etYmd(nowMs);
  const base = { day, nowMs, feature: o.feature || null };
  const pd = await spent(db, 'ai_spend_daily/' + day, nowMs);
  const tenantSpent = Math.max(0, pd.micros - pd.publicMicros);
  if (tenantSpent >= limits.platformMicros) {
    await alertOnce(db, Object.assign({ cap: 'platform', capMicros: limits.platformMicros, spentMicros: tenantSpent }, base), deps);
    return refusal('platform_cap');
  }
  if (o.publicCaller === true) {
    if (pd.publicMicros >= limits.publicMicros) {
      await alertOnce(db, Object.assign({ cap: 'public', capMicros: limits.publicMicros, spentMicros: pd.publicMicros }, base), deps);
      return refusal('public_cap');
    }
    return { ok: true, companyId: null, capKey: null };
  }
  if (ent.capKey && safeId(ent.companyId)) {
    const cap = companyCapMicros(limits, ent.capKey);
    const coSpent = (await spent(db, 'ai_spend_daily_co/' + day + '__' + ent.companyId, nowMs)).micros;
    if (coSpent >= cap) {
      await alertOnce(db, Object.assign({ cap: 'company', companyId: ent.companyId, capKey: ent.capKey, capMicros: cap, spentMicros: coSpent }, base), deps);
      return refusal('company_cap');
    }
  }
  return { ok: true, companyId: ent.companyId || null, capKey: ent.capKey || null, exempt: ent.exempt };
}

/** The callable adapter of aiGate: throws HttpsError on any refusal. */
async function assertAiEntitled(db, auth, opts) {
  const { HttpsError } = require('firebase-functions/v2/https');
  const r = await aiGate(db, Object.assign({}, opts || {}, { auth: auth || {} }));
  if (r.ok) return r;
  throw new HttpsError(r.code, r.message);
}

module.exports = {
  aiGate, aiEntitlement, aiEntitlementForUid, tenantEntitlement, assertAiEntitled, isPaidSubscription, MESSAGES, PLATFORM_UID,
  resolveLimits, companyCapMicros, capFromBusiestDay, sendBreakerAlert, relayBreakerAlerts, refusal,
  SPEND_MEASURED, FORMULA_PLATFORM_DAILY_MICROS, ALT_FLOOR_PLATFORM_DAILY_MICROS, SPEND_TTL_MS,
  _resetBreakerCache,
};
