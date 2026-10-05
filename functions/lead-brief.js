'use strict';

/**
 * functions/lead-brief.js — "Brief me" (2026-10-04).
 *
 * leadBrief (onCall { leadId, refresh? }) → { oneLine, bullets, source,
 * generatedAtMs, cached }. Server-side only: the Anthropic key never leaves
 * the server, the model is pinned (Claude Haiku 4.5), and the facts are read
 * with the Admin SDK under the same audience as the /leads read rule.
 *
 * Cache: lead_briefs/{leadId} (server-only), served for 4 hours; "Refresh"
 * regenerates only when the cached one is older than 10 minutes. Fresh
 * generations are capped per user per day (lead_brief_quota). The AI kill
 * switch, an unverified email or a free plan → the deterministic brief built
 * from the same facts (no AI call), never an error page.
 *
 * The 6:45 morning brief calls getBrief() for each of the day's appointments
 * and prints its oneLine under the appointment.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { secretValue } = require('./integrations/_shared');
const B = require('./lead-brief-logic');
const { owedDollarsOf } = require('./invoice-owed');
const AiSpend = require('./ai-spend');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const DAILY_FRESH_CAP = 60;

/** Default model call: raw /v1/messages (the repo's server pattern). */
async function anthropicCall(req) {
  const key = secretValue(ANTHROPIC_API_KEY);
  if (!key) throw new Error('anthropic-not-configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(40_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('anthropic ' + res.status);
  return data;
}

function docsOf(snap) {
  const out = [];
  if (snap && typeof snap.forEach === 'function') snap.forEach((d) => out.push(Object.assign({ id: d.id }, d.data() || {})));
  return out;
}

/** Everything the brief needs about one lead. Each read fails soft. */
async function gatherFacts({ db, leadId, lead, nowMs, log = logger }) {
  const leadRef = db.collection('leads').doc(leadId);
  const tenant = lead.companyId || lead.userId || null;
  const soft = (p, what) => p.catch((e) => { log.warn('lead_brief_read_failed', { leadId, what, err: e && e.message }); return null; });
  const [act, tasks, ests, invs, photos, appts, subAppts] = await Promise.all([
    soft(leadRef.collection('activity').orderBy('createdAt', 'desc').limit(40).get(), 'activity'),
    soft(leadRef.collection('tasks').limit(100).get(), 'tasks'),
    soft(db.collection('estimates').where('leadId', '==', leadId).limit(20).get(), 'estimates'),
    soft(db.collection('invoices').where('leadId', '==', leadId).limit(30).get(), 'invoices'),
    soft(db.collection('photos').where('leadId', '==', leadId).limit(500).get(), 'photos'),
    soft(db.collection('appointments').where('leadId', '==', leadId).limit(20).get(), 'appointments'),
    soft(leadRef.collection('appointments').limit(20).get(), 'lead-appointments'),
  ]);
  // A doc found by leadId alone must be this tenant's (a lead id can be
  // re-created by another tenant after a hard delete).
  const mine = (d) => !tenant || !d.companyId || d.companyId === tenant || d.userId === tenant;
  return B.buildFacts({
    lead,
    activity: docsOf(act),
    tasks: docsOf(tasks),
    estimates: docsOf(ests).filter(mine),
    invoices: docsOf(invs).filter(mine),
    photoCount: docsOf(photos).filter(mine).filter((p) => p.deleted !== true).length,
    appointments: docsOf(appts).filter(mine).concat(docsOf(subAppts)),
    nowMs,
    owedDollarsOf,
  });
}

/**
 * The brief for one lead: cache → AI → deterministic fallback.
 * @param {object} o { db, leadId, lead, nowMs, force, useAi, callModel, log }
 */
async function getBrief(o) {
  const { db, leadId, lead, nowMs, force = false, useAi = true, log = logger } = o;
  const callModel = o.callModel || anthropicCall;
  const cacheRef = db.collection('lead_briefs').doc(leadId);
  const cacheSnap = await cacheRef.get().catch(() => null);
  const cache = cacheSnap && cacheSnap.exists ? cacheSnap.data() : null;
  if (B.cacheUsable(cache, nowMs, force)) {
    return { oneLine: cache.oneLine, bullets: cache.bullets, source: cache.source || 'ai', generatedAtMs: cache.generatedAtMs, cached: true };
  }
  const facts = await gatherFacts({ db, leadId, lead, nowMs, log });
  let brief = null;
  let source = 'fallback';
  if (useAi) {
    try {
      const req = B.buildRequest(facts);
      const resp = await callModel(req);
      await AiSpend.recordAiSpend(AiSpend.rowFromAnthropic('brief-me', req.model, resp), { db, nowMs, log });
      brief = B.parseBrief(resp);
      if (brief) source = 'ai';
    } catch (e) {
      log.warn('lead_brief_ai_failed', { leadId, err: e && e.message });
    }
  }
  if (!brief) brief = B.fallbackBrief(facts);
  const out = { oneLine: brief.oneLine, bullets: brief.bullets, source, generatedAtMs: nowMs, cached: false };
  // Only an AI brief is cached for hours; a fallback is retried next time.
  if (source === 'ai') {
    await cacheRef.set({
      leadId, oneLine: out.oneLine, bullets: out.bullets, source, generatedAtMs: nowMs, model: B.BRIEF_MODEL,
      companyId: lead.companyId || null, userId: lead.userId || null, updatedAt: FieldValue.serverTimestamp(),
    }).catch((e) => log.warn('lead_brief_cache_write_failed', { leadId, err: e && e.message }));
  }
  return out;
}

/** May this caller spend AI on a brief right now? (verified email + paid plan, kill switch off) */
async function aiAllowed(db, auth) {
  const t = auth.token || {};
  const isAdmin = t.role === 'admin';
  if (!isAdmin && t.email_verified !== true) return false;
  try { if (await require('./integrations/killswitch').isAiDisabled()) return false; } catch (_) { /* fail open to the cap */ }
  if (isAdmin) return true;
  const sub = await db.doc('subscriptions/' + (t.companyId || auth.uid)).get().catch(() => null);
  const s = sub && sub.exists ? sub.data() : null;
  return !!(s && s.plan && s.plan !== 'free' && (s.status === 'active' || s.status === 'trialing'));
}

/** Per-user daily cap on fresh generations (transaction; false = over cap). */
async function takeQuota(db, uid, nowMs) {
  const ref = db.collection('lead_brief_quota').doc(AiSpend.etYmd(nowMs) + '__' + uid);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const n = (s.exists && Number(s.data().n)) || 0;
    if (n >= DAILY_FRESH_CAP) return false;
    tx.set(ref, { n: n + 1, uid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
}

async function briefCallable({ db, auth, data, nowMs, callModel, log = logger }) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const leadId = String((data && data.leadId) || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) throw new HttpsError('invalid-argument', 'Bad lead id.');
  const snap = await db.collection('leads').doc(leadId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Customer not found.');
  const lead = snap.data() || {};
  if (lead.deleted === true || !B.canReadLead(auth, lead)) throw new HttpsError('permission-denied', 'Not your customer.');
  const force = !!(data && data.refresh);
  let useAi = await aiAllowed(db, auth);
  // The cap only counts real generations: peek at the cache first.
  if (useAi) {
    const c = await db.collection('lead_briefs').doc(leadId).get().catch(() => null);
    if (!B.cacheUsable(c && c.exists ? c.data() : null, nowMs, force)) useAi = await takeQuota(db, auth.uid, nowMs).catch(() => false);
  }
  return getBrief({ db, leadId, lead, nowMs, force, useAi, callModel, log });
}

exports.leadBrief = onCall(
  { region: 'us-central1', enforceAppCheck: true, secrets: [ANTHROPIC_API_KEY], memory: '512MiB', timeoutSeconds: 60, maxInstances: 10 },
  (request) => briefCallable({ db: getFirestore(), auth: request.auth, data: request.data, nowMs: Date.now() })
);

exports.getBrief = getBrief;
exports.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
exports._test = { gatherFacts, getBrief, briefCallable, aiAllowed, takeQuota, DAILY_FRESH_CAP };
