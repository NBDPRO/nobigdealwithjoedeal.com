'use strict';
/**
 * review-ask-health.js — the review ask's carrier and complaint health, per
 * company, with an automatic pause (plan G3, slice S3, 2026-11-26). DARK.
 * The rules and thresholds are in review-ask-health-logic.js.
 *
 *   recordTextSend / confirmTextSend / abandonTextSend
 *       every review text gets a server-only review_ask_sends row under an
 *       opaque 32-hex id BEFORE the send. Its statusCallback points to
 *       /api/review-ask/status?s=<id>; the heartbeat waits for its callback.
 *   reviewAskTextStatus  POST /api/review-ask/status?s=<id>
 *       1. looks the send up (company + sender come from the stored row, never
 *          from the request); 2. verifies X-Twilio-Signature with THAT
 *          sender's token (NBD's today; a company subaccount has none yet, so
 *          it fails closed) and the AccountSid / MessageSid against the row;
 *          3. only then writes: one transaction per (send, status) counts a
 *          listed error code once and clears the heartbeat.
 *   noteStop        a STOP from a number review-texted in the last 14 days
 *                   (incomingSMS and the Twilio line, after the register write)
 *   noteEmailEvent  a Resend complaint / permanent bounce on review-ask mail
 *                   (resend-webhook.js, after the suppression record)
 *   noteEmailSend   the review-email denominator
 *   textHealthOk    the text pre-flight: refuses when this handler is dark,
 *                   the company is paused, or a text has had no callback for
 *                   an hour (fails closed on any unreadable doc)
 *
 * A pause sets review_ask_tenants/{companyId}.paused (ramp back to 1), writes
 * review_ask_audit, and calls notifyOwner (severity alert, key
 * review_ask_pause_<companyId>, its own 'review_ask' bucket). The alert names
 * the company by id only. Only a platform admin clears it
 * (manageReviewAskTenant unpause); every collection here is server-only.
 * One company's signals only ever pause that company.
 *
 * Off unless REVIEW_ASK_HEALTH_ENABLED === 'true'. Off: the endpoint answers
 * 200 and writes nothing, the counters write nothing, and textHealthOk says
 * no, so no review text goes out at all (v2 falls back to the email).
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger: fnLogger } = require('firebase-functions/v2');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const HL = require('./review-ask-health-logic');
const TL = require('./twilio-line-logic');
const RA = require('./review-ask-auto-logic');

const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
// The owner-alert text on a pause (owner-notify.js reads all three).
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');
const C = HL.C;
const NBD = () => RA.NBD_OWNER_UID;
const { secretValue: sv } = require('./integrations/_shared');

const fv = (o) => (o && o.FieldValue) || FieldValue;
const envOf = (o) => (o && o.env) || process.env;
const nowOf = (o) => (o && Number(o.nowMs)) || Date.now();
const logOf = (o) => (o && o.logger) || fnLogger;
const healthRef = (db, companyId, nowMs) => db.collection(C.health).doc(HL.healthId(companyId, HL.dayKey(nowMs)));

// ── the send row + heartbeat ────────────────────────────────────────────

/** Before a review text: its row and heartbeat entry. → { id, statusCallback }. Throws (no text) when it cannot. */
async function recordTextSend(db, a) {
  const o = a || {};
  if (!HL.flagOn(envOf(o))) throw new Error('health_dark');
  const companyId = String(o.companyId || '');
  if (!companyId) throw new Error('no_company');
  const FV = fv(o);
  const nowMs = nowOf(o);
  const id = HL.newSendId();
  await db.collection(C.sends).doc(id).create({
    kind: 'text_health', channel: 'text', companyId, sender: o.sender === 'nbd' ? 'nbd' : 'subaccount',
    subaccountSid: o.subaccountSid || null, leadId: o.leadId || null, jobId: o.jobId || null, toHash: o.toHash || null,
    template: o.template || null, sentAtMs: nowMs, callbacks: 0, outcome: 'sending', triggeredBy: 'system:reviewAskAutoSweep',
  });
  const hbRef = db.collection(C.heartbeat).doc(companyId);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(hbRef);
    if (!s.exists) { tx.set(hbRef, { companyId, pending: { [id]: nowMs } }); return; }
    const patch = { ['pending.' + id]: nowMs };
    for (const k of HL.stalePending((s.data() || {}).pending, nowMs)) patch['pending.' + k] = FV.delete();
    tx.update(hbRef, patch);
  });
  return { id, statusCallback: HL.statusCallbackUrl(id) };
}

/** Twilio took the text: its SID on the row, one more text in today's denominator. */
async function confirmTextSend(db, id, companyId, messageSid, nowMs, o) {
  const FV = fv(o);
  // The denominator first: a failed row update never drops a sent text from the rates.
  await healthRef(db, companyId, nowMs).set({ companyId, ymd: HL.dayKey(nowMs), textSends: FV.increment(1), updatedAtMs: nowMs }, { merge: true });
  await db.collection(C.sends).doc(id).update({ outcome: 'sent', messageSid: TL.isSid(messageSid, ['SM', 'MM']) ? messageSid : null });
}

/** Twilio refused it (nothing went out): the heartbeat stops waiting for it. */
async function abandonTextSend(db, id, companyId, o) {
  const FV = fv(o);
  await db.collection(C.sends).doc(id).update({ outcome: 'not_sent' }).catch(() => {});
  const hbRef = db.collection(C.heartbeat).doc(companyId);
  const s = await hbRef.get();
  if (s.exists) await hbRef.update({ ['pending.' + id]: FV.delete() });
}

/** The text pre-flight. → { ok: true } | { ok: false, reason } (fails closed). */
async function textHealthOk(db, companyId, o) {
  if (!HL.flagOn(envOf(o))) return { ok: false, reason: 'health_dark' };
  const nowMs = nowOf(o);
  let t, hb;
  try {
    const [ts, hs] = await Promise.all([db.collection(C.tenants).doc(companyId).get(), db.collection(C.heartbeat).doc(companyId).get()]);
    t = ts.exists ? (ts.data() || {}) : {};
    hb = hs.exists ? (hs.data() || {}) : {};
  } catch (e) { return { ok: false, reason: 'health_unverified' }; }
  if (t.paused === true) return { ok: false, reason: 'paused' };
  // A text with no callback for an hour: the callback path is broken. Pause (one alert, a
  // platform admin clears it with unpause, which also clears the heartbeat) and refuse.
  if (HL.heartbeatMissing(hb.pending, nowMs) >= HL.HEARTBEAT.MAX_MISSING) {
    await pauseFor(db, companyId, 'callbacks_missing', null, o).catch((e) => logOf(o).error('review_ask_health_pause_failed', { companyId, err: e && e.message }));
    return { ok: false, reason: 'callbacks_missing' };
  }
  // The counters themselves, so a threshold crossed while the pause write failed still stops the text.
  let w;
  try { w = await windowTotals(db, companyId, nowMs, t); } catch (e) { return { ok: false, reason: 'health_unverified' }; }
  if (w.reason) {
    await pauseFor(db, companyId, w.reason, w.totals, o).catch((e) => logOf(o).error('review_ask_health_pause_failed', { companyId, err: e && e.message }));
    return { ok: false, reason: 'paused' };
  }
  return { ok: true };
}

// ── counting and the pause ──────────────────────────────────────────────

/** Count one signal once (markId is the idempotency key). → true when this call counted it. */
async function count(db, companyId, markId, field, nowMs, o) {
  const FV = fv(o);
  const markRef = db.collection(C.counted).doc(markId);
  const hRef = healthRef(db, companyId, nowMs);
  return db.runTransaction(async (tx) => {
    const m = await tx.get(markRef);
    if (m.exists) return false;
    tx.set(markRef, { companyId, field, atMs: nowMs });
    tx.set(hRef, { companyId, ymd: HL.dayKey(nowMs), [field]: FV.increment(1), updatedAtMs: nowMs }, { merge: true });
    return true;
  });
}

/** Read the company's window; pause it when a threshold is passed. → { paused, reason? } */
/**
 * The company's rolling-window totals and the pause reason ('' = healthy). Signals from before a
 * platform admin's last unpause do not count (days before it are skipped; that day's counts at the
 * unpause are subtracted), so an unpause is not undone by the very signals already reviewed.
 */
async function windowTotals(db, companyId, nowMs, tenant) {
  let t = tenant;
  if (t === undefined) { const s = await db.collection(C.tenants).doc(companyId).get(); t = s.exists ? (s.data() || {}) : {}; }
  const days = HL.windowDays(nowMs);
  const docs = await Promise.all(days.map((k) => db.collection(C.health).doc(HL.healthId(companyId, k)).get()));
  const totals = HL.sumWindow(HL.sinceClear(days, docs.map((s) => (s.exists ? s.data() : null)), t || {}));
  return { totals, reason: HL.evaluate(totals) };
}

/** Read the company's window; pause it when a threshold is passed. → { paused, reason? } */
async function maybePause(db, companyId, o) {
  const w = await windowTotals(db, companyId, nowOf(o));
  if (!w.reason) return { paused: false };
  return pauseFor(db, companyId, w.reason, w.totals, o);
}

/** Pause one company (once): the flag, the audit row, one owner alert. → { paused, already?, reason } */
async function pauseFor(db, companyId, reason, totals, o) {
  const FV = fv(o);
  const nowMs = nowOf(o);
  const tRef = db.collection(C.tenants).doc(companyId);
  const did = await db.runTransaction(async (tx) => {
    const s = await tx.get(tRef);
    if (s.exists && (s.data() || {}).paused === true) return false;
    tx.set(tRef, { companyId, paused: true, pausedReason: 'health_' + reason, pausedAtMs: nowMs, pausedBy: HL.PAUSED_BY, rampStage: 1, updatedAtMs: nowMs, updatedBy: HL.PAUSED_BY }, { merge: true });
    return true;
  });
  if (!did) return { paused: false, already: true, reason };
  await db.collection(C.audit).add({ companyId, by: HL.PAUSED_BY, action: 'auto_pause', reason, totals: totals || null, at: FV.serverTimestamp() })
    .catch((e) => logOf(o).warn('review_ask_health_audit_failed', { companyId, err: e && e.message }));
  const al = HL.pauseAlert(companyId, reason);
  const notify = (o && o.notify) || require('./owner-notify').notifyOwner;
  try {
    await notify(db, { title: al.title, body: al.body, severity: 'alert', key: 'review_ask_pause_' + companyId, bucket: 'review_ask', type: 'review_ask_pause', clickUrl: '/pro/dashboard.html', idPrefix: 'review-ask-pause-', nowMs });
  } catch (e) { logOf(o).error('review_ask_health_alert_failed', { companyId, err: e && e.message }); }
  logOf(o).warn('review_ask_health_paused', { companyId, reason });
  return { paused: true, reason };
}

/**
 * A STOP from a number this company review-texted in the last 14 days, sent TO the line that asked
 * (NBD: o.toNbdLine === true). One STOP per asked phone per ask, however many times it is sent.
 * Never throws, and gives up after STOP_HOOK_MS so the caller's STOP reply is never held up.
 */
const STOP_HOOK_MS = 3000;
async function noteStop(db, a) {
  const o = a || {};
  let timer;
  const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ counted: false, reason: 'timeout' }), Number(o.timeoutMs) || STOP_HOOK_MS); });
  try { return await Promise.race([noteStopNow(db, o), limit]); } finally { clearTimeout(timer); }
}
async function noteStopNow(db, o) {
  try {
    if (!HL.flagOn(envOf(o))) return { counted: false, reason: 'dark' };
    const sid = String(o.messageSid || '');
    if (!TL.isSid(sid, ['SM', 'MM'])) return { counted: false, reason: 'no_sid' };
    const nowMs = nowOf(o);
    const key = require('./review-ask-v2').phoneKey(o.from);
    const s = await db.collection(C.phones).doc(key).get();
    const p = s.exists ? (s.data() || {}) : null;
    const last = p ? Number(p.lastAskMs) || 0 : 0;
    if (!p || !p.companyId || !last || nowMs - last > HL.STOP_ATTRIBUTION_DAYS * HL.DAY_MS) return { counted: false, reason: 'not_review_asked' };
    // NBD's review texts go out on NBD's own line: a STOP to any other number (a company's) is not NBD's.
    if (String(p.companyId) === NBD() && o.toNbdLine !== true) return { counted: false, reason: 'other_line' };
    const counted = await count(db, String(p.companyId), 'stop_' + key + '_' + last, 'stops', nowMs, o);
    await maybePause(db, String(p.companyId), o);   // a replay re-checks too (a pause lost to an error)
    return { counted };
  } catch (e) {
    logOf(o).error('review_ask_health_stop_failed', { err: e && e.message });
    return { counted: false, reason: 'error' };
  }
}

/** A Resend complaint / permanent bounce (source from resend-webhook.js) on review-ask mail. Never throws. */
async function noteEmailEvent(db, a) {
  const o = a || {};
  try {
    if (!HL.flagOn(envOf(o))) return { counted: false, reason: 'dark' };
    const field = o.source === 'complaint' ? 'complaints' : (o.source === 'bounce' ? 'bounces' : '');
    const tok = o.tok || {};
    const eventId = String(o.eventId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 100);
    if (!field || !eventId || !tok.companyId) return { counted: false, reason: 'not_counted' };
    if (!HL.REVIEW_EMAIL_SOURCES.includes(tok.source)) return { counted: false, reason: 'not_review_mail' };
    const nowMs = nowOf(o);
    const companyId = String(tok.companyId);
    const counted = await count(db, companyId, 'resend_' + eventId, field, nowMs, o);
    await maybePause(db, companyId, o);   // a replay re-checks too (a pause lost to an error)
    return { counted };
  } catch (e) {
    logOf(o).error('review_ask_health_email_event_failed', { err: e && e.message });
    return { counted: false, reason: 'error' };
  }
}

/** One review email sent (the bounce-rate denominator). Never throws. */
async function noteEmailSend(db, companyId, o) {
  try {
    if (!HL.flagOn(envOf(o)) || !companyId) return;
    const nowMs = nowOf(o);
    await healthRef(db, String(companyId), nowMs).set({ companyId: String(companyId), ymd: HL.dayKey(nowMs), emailSends: fv(o).increment(1), updatedAtMs: nowMs }, { merge: true });
  } catch (e) { logOf(o).warn('review_ask_health_email_send_failed', { err: e && e.message }); }
}

// ── the status callback ─────────────────────────────────────────────────

function sendXml(res, status) {
  res.set('Content-Type', 'text/xml');
  res.set('Cache-Control', 'no-store');
  res.status(status).send(TL.EMPTY_TWIML);
}

/** The token and AccountSid that may sign this send's callbacks, or null (fails closed). */
function signerFor(send, deps) {
  if (send.sender === 'nbd' && send.companyId === NBD()) {
    const token = deps.nbdAuthToken !== undefined ? deps.nbdAuthToken : sv(TWILIO_AUTH_TOKEN);
    const accountSid = deps.nbdAccountSid !== undefined ? deps.nbdAccountSid : sv(TWILIO_ACCOUNT_SID);
    return token && accountSid ? { token, accountSid } : null;
  }
  // A company subaccount: its own token from Secret Manager arrives with S4/S5. Until then: no signer.
  return null;
}

async function handleStatus(req, res, deps) {
  const d = deps || {};
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!HL.flagOn(envOf(d))) { sendXml(res, 200); return; }
  const id = String((req.query && req.query.s) || '');
  if (!HL.isSendId(id)) { res.status(400).json({ error: 'bad id' }); return; }
  // No signature at all: refused before any read (a flood of unsigned posts costs no Firestore read).
  if (!(req.headers || {})['x-twilio-signature']) { res.status(403).json({ error: 'signature verification failed' }); return; }
  const db = d.db || getFirestore();
  // 1. The send first: the company and the sender come from the stored row.
  const sendRef = db.collection(C.sends).doc(id);
  const snap = await sendRef.get();
  if (!snap.exists) { res.status(404).json({ error: 'unknown' }); return; }
  const send = snap.data() || {};
  // 2. That sender's signature, AccountSid and MessageSid. Nothing is written before this passes.
  const signer = signerFor(send, d);
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  if (!signer) { logOf(d).warn('review_ask_status_no_signer', { sender: send.sender || null }); res.status(403).json({ error: 'signature verification failed' }); return; }
  const v = TL.verifySignature(signer.token, (req.headers || {})['x-twilio-signature'], TL.candidateUrls(req.headers, req.originalUrl || req.url), params);
  if (!v.ok) { logOf(d).warn('review_ask_status_signature_refused', { reason: v.reason }); res.status(403).json({ error: 'signature verification failed' }); return; }
  if (String(params.AccountSid || '') !== signer.accountSid) { res.status(403).json({ error: 'account mismatch' }); return; }
  const sid = String(params.MessageSid || params.SmsSid || '');
  if (!TL.isSid(sid, ['SM', 'MM']) || (send.messageSid && send.messageSid !== sid)) { res.status(403).json({ error: 'message mismatch' }); return; }
  const status = HL.cleanStatus(params.MessageStatus || params.SmsStatus);
  if (!status) { sendXml(res, 200); return; }
  // 3. Count once per (send, status), clear the heartbeat.
  const FV = fv(d);
  const nowMs = nowOf(d);
  const companyId = String(send.companyId || '');
  const field = HL.countField(status, params.ErrorCode);
  const markRef = db.collection(C.counted).doc(id + '_' + status);
  const hbRef = db.collection(C.heartbeat).doc(companyId);
  const hRef = healthRef(db, companyId, nowMs);
  const code = String(params.ErrorCode == null ? '' : params.ErrorCode).replace(/\D/g, '').slice(0, 8) || null;
  const fresh = await db.runTransaction(async (tx) => {
    const m = await tx.get(markRef);
    const hb = await tx.get(hbRef);
    if (m.exists) return false;
    tx.set(markRef, { companyId, sendId: id, status, code, field: field || null, atMs: nowMs });
    tx.update(sendRef, { callbacks: FV.increment(1), lastStatus: status, lastErrorCode: code, lastCallbackMs: nowMs, messageSid: sid });
    if (hb.exists && ((hb.data() || {}).pending || {})[id] !== undefined) tx.update(hbRef, { ['pending.' + id]: FV.delete() });
    if (field) tx.set(hRef, { companyId, ymd: HL.dayKey(nowMs), [field]: FV.increment(1), updatedAtMs: nowMs }, { merge: true });
    return true;
  });
  // A replay (Twilio retried after a 500) re-checks too, so a pause lost to an error is not lost for good.
  if (field) await maybePause(db, companyId, d);
  if (!fresh) logOf(d).info('review_ask_status_replay', { status });
  sendXml(res, 200);
}

const OPTS = { cors: false, secrets: [TWILIO_AUTH_TOKEN, TWILIO_ACCOUNT_SID, TWILIO_PHONE_NUMBER], maxInstances: 5, timeoutSeconds: 15, memory: '256MiB' };

exports.reviewAskTextStatus = onRequest(OPTS, async (req, res) => {
  try { await handleStatus(req, res); } catch (e) {
    fnLogger.error('review_ask_status_failed', { err: e && e.message });
    // Every write is idempotent. Twilio may not retry a status callback; a lost one leaves the
    // heartbeat waiting, which pauses the company and alerts (textHealthOk).
    if (!res.headersSent) res.status(500).json({ error: 'webhook failed' });
  }
});

/**
 * What a platform admin's unpause also clears (review-ask-tenant.js handleManage): the heartbeat's
 * pending texts, and a baseline so the signals already reviewed do not re-pause at once.
 * → the patch to merge into review_ask_tenants/{companyId}.
 */
async function clearForUnpause(db, companyId, nowMs, o) {
  const hbRef = db.collection(C.heartbeat).doc(companyId);
  const hb = await hbRef.get();
  if (hb.exists) await hbRef.update({ pending: {}, clearedAtMs: nowMs, clearedBy: (o && o.by) || null });
  const today = await db.collection(C.health).doc(HL.healthId(companyId, HL.dayKey(nowMs))).get();
  return { healthClearedAtMs: nowMs, healthBaseline: HL.sumWindow([today.exists ? today.data() : null]) };
}

module.exports = Object.assign(exports, {
  recordTextSend, confirmTextSend, abandonTextSend, textHealthOk, count, maybePause, pauseFor, windowTotals, clearForUnpause, STOP_HOOK_MS,
  noteStop, noteEmailEvent, noteEmailSend, handleStatus, signerFor,
});
