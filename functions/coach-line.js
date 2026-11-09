'use strict';

/**
 * functions/coach-line.js — coachLine, the NBD OS Coach's AI focus line
 * (2026-11-09, NBD OS P2; design: documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5.2).
 *
 * coachLine (onCall { rules: [{ id, evidence }] }) → { line: string|null, cached, reason? }.
 * One short sentence of focus for the day, written by Claude Haiku 4.5 from the
 * counted evidence the rules Coach already shows (coach-line-logic.js keeps only
 * known rule ids and whole-number counts; the prompt is built here, never from
 * client text). The line is post-checked: a digit or number word the evidence
 * doesn't hold → no line (reason 'checked'), never a made-up number.
 *
 * Gates, in order: signed in (and not a ghost, App Check enforced), the company
 * opted in (companyProfile/{companyId}.coachAiEnabled === true, OFF by default;
 * an owner or company_admin turns it on from the OS home's team controls),
 * facts to talk about, AI allowed (verified email, paid plan, AI kill switch
 * feature_flags/global.aiDisabled and its own coachLineDisabled off; checked
 * BEFORE the cache, so a switch flipped mid-day pulls back today's line), today's
 * cached line (coach_lines/{uid}_{ET day}, served without a model call), then the
 * caps: 3 fresh lines per user and 60 per company per ET day (coach_line_quota,
 * one transaction). Every no is { line: null, reason }, never an error page.
 * Only a checked AI line is cached; a failed or rejected one may be retried
 * until the cap. Spend is recorded as feature 'coach-line'.
 * coach_lines and coach_line_quota are Admin-SDK only (firestore.rules).
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { secretValue } = require('./integrations/_shared');
const L = require('./coach-line-logic');
const AiSpend = require('./ai-spend');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const USER_DAILY_CAP = 3;
const COMPANY_DAILY_CAP = 60;

/** Default model call: raw /v1/messages (the repo's server pattern, as lead-brief.js). */
async function anthropicCall(req) {
  const key = secretValue(ANTHROPIC_API_KEY);
  if (!key) throw new Error('anthropic-not-configured');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('anthropic ' + res.status);
  return data;
}

function companyOf(auth) { return String((auth.token && auth.token.companyId) || auth.uid); }

/** The company's opt-in: companyProfile/{companyId}.coachAiEnabled === true (missing or a failed read is off). */
async function optedIn(db, companyId) {
  const s = await db.collection('companyProfile').doc(companyId).get().catch(() => null);
  return !!(s && s.exists && (s.data() || {}).coachAiEnabled === true);
}

/** May this caller spend AI on a line right now? (lead-brief.js aiAllowed, plus this feature's own switch) */
async function aiAllowed(db, auth) {
  const t = auth.token || {};
  const isAdmin = t.role === 'admin';
  if (!isAdmin && t.email_verified !== true) return false;
  try {
    const K = require('./integrations/killswitch');
    if (await K.isAiDisabled()) return false;
    if (typeof K.isCoachLineDisabled === 'function' && await K.isCoachLineDisabled()) return false;
  } catch (_) { /* fail open to the caps, as the other AI callables do */ }
  if (isAdmin) return true;
  const sub = await db.doc('subscriptions/' + (t.companyId || auth.uid)).get().catch(() => null);
  const s = sub && sub.exists ? sub.data() : null;
  return !!(s && s.plan && s.plan !== 'free' && (s.status === 'active' || s.status === 'trialing'));
}

// Quota day counters expire a week after the write (Firestore TTL on
// expireAt, firestore.indexes.json; Call to Close P2, 2026-11-09).
const QUOTA_TTL_MS = 7 * 86400000;
/** Per-user and per-company daily caps on fresh lines, in one transaction (false = over a cap). */
async function takeQuota(db, uid, companyId, nowMs) {
  const ymd = AiSpend.etYmd(nowMs);
  const uRef = db.collection('coach_line_quota').doc(ymd + '__u__' + uid);
  const cRef = db.collection('coach_line_quota').doc(ymd + '__c__' + companyId);
  return db.runTransaction(async (tx) => {
    const [u, c] = [await tx.get(uRef), await tx.get(cRef)];
    const nu = (u.exists && Number(u.data().n)) || 0;
    const nc = (c.exists && Number(c.data().n)) || 0;
    if (nu >= USER_DAILY_CAP || nc >= COMPANY_DAILY_CAP) return false;
    const expireAt = new Date(Number(nowMs) + QUOTA_TTL_MS);
    tx.set(uRef, { n: nu + 1, uid, day: ymd, updatedAt: FieldValue.serverTimestamp(), expireAt }, { merge: true });
    tx.set(cRef, { n: nc + 1, companyId, day: ymd, updatedAt: FieldValue.serverTimestamp(), expireAt }, { merge: true });
    return true;
  });
}

async function coachLineCallable({ db, auth, data, nowMs, callModel, log = logger }) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const companyId = companyOf(auth);
  if (!(await optedIn(db, companyId))) return { line: null, cached: false, reason: 'off' };
  const facts = L.cleanFacts(data);
  if (!facts) return { line: null, cached: false, reason: 'no-facts' };
  // the AI gate before the cache: a kill switch flipped mid-day pulls back a line already written today
  if (!(await aiAllowed(db, auth))) return { line: null, cached: false, reason: 'unavailable' };
  const ymd = AiSpend.etYmd(nowMs);
  const cacheRef = db.collection('coach_lines').doc(auth.uid + '_' + ymd);
  const c = await cacheRef.get().catch(() => null);
  const hit = c && c.exists ? c.data() : null;
  if (hit && typeof hit.line === 'string' && hit.line) return { line: hit.line, cached: true, generatedAtMs: hit.generatedAtMs || null };
  if (!(await takeQuota(db, auth.uid, companyId, nowMs).catch(() => false))) return { line: null, cached: false, reason: 'cap' };
  const req = L.buildRequest(facts);
  let resp;
  try {
    resp = await (callModel || anthropicCall)(req);
  } catch (e) {
    log.warn('coach_line_ai_failed', { uid: auth.uid, err: e && e.message });
    return { line: null, cached: false, reason: 'model' };
  }
  await AiSpend.recordAiSpend(AiSpend.rowFromAnthropic('coach-line', req.model, resp), { db, nowMs, log });
  const line = L.parseLine(resp);
  const check = L.checkLine(line, facts);
  if (!line || !check.ok) {
    log.info('coach_line_rejected', { uid: auth.uid, parsed: !!line, bad: check.bad.map(String).slice(0, 5) });
    return { line: null, cached: false, reason: 'checked' };
  }
  await cacheRef.set({
    uid: auth.uid, companyId, day: ymd, line, rules: facts.rules.map((r) => r.id), model: L.MODEL,
    generatedAtMs: nowMs, updatedAt: FieldValue.serverTimestamp(),
  }).catch((e) => log.warn('coach_line_cache_write_failed', { uid: auth.uid, err: e && e.message }));
  return { line, cached: false, generatedAtMs: nowMs };
}

exports.coachLine = onCall(
  { region: 'us-central1', enforceAppCheck: true, secrets: [ANTHROPIC_API_KEY], memory: '256MiB', timeoutSeconds: 30, maxInstances: 10 },
  async (request) => {
    await require('./tenant-guard').assertNotGhost(request);
    return coachLineCallable({ db: getFirestore(), auth: request.auth, data: request.data, nowMs: Date.now() });
  }
);

exports._test = { coachLineCallable, aiAllowed, takeQuota, optedIn, USER_DAILY_CAP, COMPANY_DAILY_CAP };
