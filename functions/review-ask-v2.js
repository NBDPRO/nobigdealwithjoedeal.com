'use strict';
/**
 * review-ask-v2.js — the automatic review ask, v2: the sends (2026-11-26).
 *
 * Called by reviewAskAutoSweep (review-ask-auto.js) only when
 * REVIEW_ASK_V2_ENABLED === 'true'; the rules and the words are in
 * review-ask-v2-logic.js. Flag off: nothing here runs and v1 is unchanged.
 * NBD's own customers only (v1's baseEligibility 'not_nbd', re-checked by
 * companyId before every text).
 *
 *   askOneV2      one job's ask: TEXT first (consent, STOP register, declined
 *                 consent, the texting gate, the SMS switch, one ask per phone
 *                 number per PHONE_WINDOW_DAYS), EMAIL otherwise (v1's email,
 *                 suppression + CAN-SPAM footer). v1's once-per-job claim
 *                 precedes either send.
 *   runReminders  the one reminder, REMINDER_DAYS after a v2 ask, same channel.
 *                 Every check re-read at send time (incl. still paid in full);
 *                 its own claim (reviewAutoAsk.reminder) and send-once key.
 *
 * Every text body passes V2.smsContentOk (Google review link only, the STOP
 * line, <= 320 chars) right before the send; a body that fails is not sent.
 * Every send writes a review_requests row with triggeredBy.
 */

const crypto = require('crypto');
const { logger: fnLogger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');
const RA = require('./review-ask-auto-logic');
const V2 = require('./review-ask-v2-logic');
const RP = require('./review-ask-photo');
const Suppression = require('./email-suppression');
const MessagingControls = require('./messaging-controls');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const OptOut = require('./sms-optout');
const TextingGate = require('./sms-texting-gate');
const ConsentDeclined = require('./sms-consent-declined');
const SendWindow = require('./send-window');

// v1's claim / settle / recordSent and NBD's sender, read at call time (review-ask-auto.js requires this file).
const A = () => require('./review-ask-auto')._test;
const TRIGGERED_BY = 'system:reviewAskAutoSweep';
// One doc per phone number (hashed): the last review ask to it, from any lead or job. Admin SDK only.
const PHONE_COLLECTION = 'review_ask_phones';

const phoneKey = (to) => crypto.createHash('sha256').update('review_ask|' + String(to).replace(/\D/g, '').slice(-10)).digest('hex').slice(0, 40);

/** Was this number asked for a review (any lead, any job) in the last PHONE_WINDOW_DAYS? Read-only. */
async function phoneRecentlyAsked(db, to, nowMs) {
  const s = await db.collection(PHONE_COLLECTION).doc(phoneKey(to)).get();
  const last = s.exists ? Number((s.data() || {}).lastAskMs) || 0 : 0;
  return last > 0 && nowMs - last < V2.PHONE_WINDOW_DAYS * V2.DAY_MS;
}

/** Claim the number's one ask for the window. → true when this run owns it. */
async function claimPhone(db, to, leadId, nowMs) {
  const ref = db.collection(PHONE_COLLECTION).doc(phoneKey(to));
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const last = s.exists ? Number((s.data() || {}).lastAskMs) || 0 : 0;
    if (last > 0 && nowMs - last < V2.PHONE_WINDOW_DAYS * V2.DAY_MS) return false;
    tx.set(ref, { lastAskMs: nowMs, leadId, companyId: RA.NBD_OWNER_UID });
    return true;
  });
}

/**
 * May this NBD customer be texted right now? Every read a text needs, before
 * any claim. → { ok: true, to } | { ok: false, reason, final }
 * final: the customer said no (STOP, declined) — a reminder closes for good.
 */
async function textReady(db, lead, d, nowMs, log, opts) {
  const pt = V2.planText({ env: d.env || process.env, lead, nowMs, ignoreHours: !!d.sendWindow });
  if (!pt.send) return { ok: false, reason: pt.reason, final: pt.reason === 'do_not_text' || pt.reason === 'not_nbd' };
  if (typeof d.sendText !== 'function') return { ok: false, reason: 'no_sender', final: false };
  const tenantKey = RA.NBD_OWNER_UID;
  try {
    const opt = await OptOut.isOptedOut(db, pt.to, { companyId: tenantKey, timeoutMs: OptOut.READ_TIMEOUT_MS });
    if (opt.optedOut) return { ok: false, reason: 'opted_out', final: true };
  } catch (e) { return { ok: false, reason: 'optout_unverified', final: false }; }
  const cd = await ConsentDeclined.decide(db, {
    phone: pt.to, lead, leadId: lead.id, tenants: [tenantKey, lead.companyId, lead.userId].filter(Boolean), kind: 'automated', nowMs, logger: log,
  });
  if (!cd.allowed) return { ok: false, reason: cd.code, final: true };
  let gate;
  try { gate = await TextingGate.textingStatus(db, tenantKey); } catch (_) { return { ok: false, reason: 'texting_unverified', final: false }; }
  if (!gate.allowed) return { ok: false, reason: 'texting_' + gate.reason, final: false };
  if (!(opts && opts.reminder)) {
    try { if (await phoneRecentlyAsked(db, pt.to, nowMs)) return { ok: false, reason: 'phone_recently_asked', final: false }; }
    catch (_) { return { ok: false, reason: 'phone_unverified', final: false }; }
  }
  const sw = await MessagingControls.channelStatus(db, 'sms');
  if (!sw.allowed) return { ok: false, reason: 'messaging_paused', final: false };
  if (sw.canary) return { ok: false, reason: 'canary', final: false };
  return { ok: true, to: pt.to };
}

/** The email's suppression gate (NBD's register and postal address). → { ok: true, to, gate } | { ok: false, reason, final } */
async function emailReady(db, lead, d, log) {
  const FV = d.FieldValue || FieldValue;
  const pe = V2.planEmail({ env: d.env || process.env, lead });
  if (!pe.send) return { ok: false, reason: pe.reason, final: false };
  if (!d.resend) return { ok: false, reason: 'no_sender', final: false };
  let gate;
  try {
    gate = await Suppression.gateCommercialEmail(db, { companyId: RA.NBD_OWNER_UID, email: pe.to, leadId: lead.id, source: 'review-ask-auto' },
      { timeoutMs: Suppression.READ_TIMEOUT_MS, serverTimestamp: FV.serverTimestamp });
  } catch (e) {
    log.warn('review_auto_suppression_unverified', { leadId: lead.id, err: e && e.message });
    return { ok: false, reason: 'suppression_unverified', final: false };
  }
  if (gate.suppressed) return { ok: false, reason: 'unsubscribed', final: true };
  if (gate.blocked) return { ok: false, reason: 'no_postal_address', final: true };
  const sw = await MessagingControls.channelStatus(db, 'email');
  if (!sw.allowed) return { ok: false, reason: 'messaging_paused', final: false };
  if (sw.canary) return { ok: false, reason: 'canary', final: false };
  return { ok: true, to: pe.to, gate };
}

async function sendEmail(db, d, ready, content, campaign, attachments) {
  const body = Suppression.applyFooter(ready.gate, content.html, content.text);
  const msg = {
    from: A().FROM, to: ready.to, reply_to: A().REPLY_TO, subject: content.subject, html: body.html, text: body.text,
    headers: Object.assign({ 'X-NBD-Campaign': campaign }, ready.gate.headers), tags: ready.gate.tags,
  };
  if (attachments) msg.attachments = attachments;
  const gated = await MessagingControls.guardEmail(db, msg);
  if (!gated.send) throw new Error('messaging_paused:' + gated.reason);
  if (gated.canary) throw new Error('canary_redirect');
  const r = await d.resend.emails.send(gated.msg);
  if (resendRejected(r)) throw new Error(resendErrorMessage(r));
}

/** The text, checked once more: NBD's customer by companyId, a fixed template that passes smsContentOk. */
async function sendCheckedText(d, lead, to, body, url, nowMs) {
  if (!RA.isNbd(lead)) throw new Error('not_nbd');
  const bad = V2.smsContentOk(body, url);
  if (bad) throw new Error('sms_content_' + bad);
  await d.sendText({ to, body, recipient: lead, companyProfile: d.companyProfile || null, nowMs });
}

/**
 * One job's v2 ask: text first, email otherwise. Never throws.
 * → { sent: boolean, channel?, reason }
 */
async function askOneV2(db, entry, uid, deps) {
  const d = deps || {};
  const log = d.logger || fnLogger;
  const FV = d.FieldValue || FieldValue;
  const nowMs = Number(d.nowMs) || Date.now();
  const env = d.env || process.env;
  try {
    if (d.maxAgeDays != null && !MessagingControls.withinAutomationAge(entry.receivedMs, nowMs, d.maxAgeDays)) return { sent: false, reason: 'too_old' };
    const el = V2.eligibility({ lead: entry, job: entry.job || null, jobId: entry.jobId || null, recvMs: entry.receivedMs, nowMs });
    if (!el.ok) return { sent: false, reason: el.reason };
    const win = typeof d.sendWindow === 'function' ? d.sendWindow(entry, nowMs) : SendWindow.check(nowMs, entry, d.companyProfile || null);
    if (!win.ok) return { sent: false, reason: 'outside_send_window' };
    const url = V2.reviewUrlFor(d.repUrl);
    const reminderDueMs = nowMs + V2.REMINDER_DAYS * V2.DAY_MS;
    const audit = { triggeredBy: TRIGGERED_BY, v2: true };

    // 1. The text, when every check passes.
    const tr = await textReady(db, entry, d, nowMs, log);
    if (tr.ok) {
      if (!(await A().claim(db, entry.id, entry.jobId, 'text', nowMs))) return { sent: false, reason: 'claimed' };
      try {
        if (!(await claimPhone(db, tr.to, entry.id, nowMs))) throw new Error('phone_recently_asked');
        if (!(await MessagingControls.claimSendOnce(db, tr.to, 'review_ask_text', entry.jobId || entry.id))) throw new Error('duplicate');
        await sendCheckedText(d, entry, tr.to, V2.textBody(entry, url), url, nowMs);
      } catch (e) {
        log.warn('review_auto_text_failed', { leadId: entry.id, err: e && e.message });
        await A().settle(db, entry.id, entry.jobId, 'text', 'failed', { atMs: nowMs, error: String((e && e.message) || e).slice(0, 200) });
        return { sent: false, reason: 'send_failed' };
      }
      await A().recordSent(db, entry, uid, 'text', nowMs, FV, { reminderDueMs, v2: true }, audit);
      return { sent: true, channel: 'text', reason: 'sent' };
    }

    // 2. Otherwise v1's email.
    const er = await emailReady(db, entry, d, log);
    if (!er.ok) {
      if (er.reason === 'no_email' || er.reason === 'email_flag_disabled') return { sent: false, reason: 'no_channel', text: tr.reason };
      if (er.final) await A().settle(db, entry.id, entry.jobId, 'email', er.reason === 'unsubscribed' ? 'unsubscribed' : 'blocked_no_postal_address', { atMs: nowMs });
      return { sent: false, reason: er.reason };
    }
    const photo = RP.photoFlagOn(env) ? await RP.photoForEmail(db, entry, { loader: d.photoLoader, bucket: d.bucket, logger: log }) : null;
    if (!(await A().claim(db, entry.id, entry.jobId, 'email', nowMs))) return { sent: false, reason: 'claimed' };
    try {
      await sendEmail(db, d, er, RA.emailContent(entry, url, photo ? photo.content : null), 'review-ask-auto-v2', photo ? photo.attachments : null);
    } catch (e) {
      log.warn('review_auto_email_failed', { leadId: entry.id, err: e && e.message });
      if (e && e.message === 'canary_redirect') {
        await db.collection('leads').doc(entry.id).update({ reviewAutoAsk: FV.delete() }).catch(() => {});
        return { sent: false, reason: 'canary' };
      }
      await A().settle(db, entry.id, entry.jobId, 'email', 'failed', { atMs: nowMs, error: String((e && e.message) || e).slice(0, 200) });
      return { sent: false, reason: 'send_failed' };
    }
    await A().recordSent(db, entry, uid, 'email', nowMs, FV, { reminderDueMs, v2: true }, audit);
    return { sent: true, channel: 'email', reason: 'sent' };
  } catch (e) {
    log.warn('review_auto_skipped', { leadId: entry && entry.id, err: e && e.message });
    return { sent: false, reason: 'error' };
  }
}

/** Close the reminder for good (sent / skipped / failed): reminderDueMs is removed so it is never read again. */
async function closeReminder(db, leadId, status, extra, nowMs) {
  const ref = db.collection('leads').doc(leadId);
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return;
    const a = Object.assign({}, (s.data() || {}).reviewAutoAsk || {});
    delete a.reminderDueMs;
    a.reminder = Object.assign({ status, atMs: nowMs }, extra || {});
    tx.update(ref, { reviewAutoAsk: a });
  }).catch(() => {});
}

/** Claim the one reminder. → true when this run owns it. */
async function claimReminder(db, leadId, nowMs) {
  const ref = db.collection('leads').doc(leadId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return false;
    const a = Object.assign({}, (s.data() || {}).reviewAutoAsk || {});
    if (!a.reminderDueMs || a.status !== 'sent' || (a.reminder && a.reminder.status)) return false;
    delete a.reminderDueMs;
    a.reminder = { status: 'sending', atMs: nowMs };
    tx.update(ref, { reviewAutoAsk: a });
    return true;
  });
}

/**
 * The one reminder per v2 ask, REMINDER_DAYS after it, on the same channel.
 * Every check is re-read now: nothing is taken from the sweep that asked.
 * → { reminded, results }
 */
async function runReminders(db, deps) {
  const d = Object.assign({}, deps || {});
  const log = d.logger || fnLogger;
  const FV = d.FieldValue || FieldValue;
  const nowMs = Number(d.nowMs) || Date.now();
  const env = d.env || process.env;
  const results = [];
  let reminded = 0;
  if (!V2.v2On(env)) return { reminded, results };
  const RN = require('./review-request-nudge')._test;
  const snap = await db.collection('leads').where('reviewAutoAsk.reminderDueMs', '<=', nowMs).limit(200).get();
  const repUrls = new Map();
  for (const doc of snap.docs) {
    const lead = Object.assign({ id: doc.id }, doc.data() || {});
    const a = lead.reviewAutoAsk || {};
    const out = (reason, sent) => { results.push({ leadId: lead.id, sent: !!sent, reason }); };
    try {
      if (d.maxAsks != null && reminded >= d.maxAsks) { out('per_run_cap'); break; }
      let reviewSeen = false;
      try {
        const rl = await db.doc('review_log/' + lead.id).get();
        const r = rl.exists ? (rl.data() || {}) : {};
        reviewSeen = r.reviewSeen === true;
      } catch (_) { out('review_log_unreadable'); continue; }
      const plan = V2.reminderPlan({ env, lead, nowMs, reviewSeen });
      if (!plan.send) { if (plan.final) await closeReminder(db, lead.id, 'skipped', { reason: plan.reason }, nowMs); out(plan.reason); continue; }
      // Still paid in full (a refund or a reopened balance ends it) and no open claim on the job.
      const jobId = a.jobId || null;
      let job = null;
      if (jobId) { try { const js = await db.collection('leads').doc(lead.id).collection('jobs').doc(jobId).get(); job = js.exists ? js.data() : null; } catch (_) { job = null; } }
      if (V2.openClaim(job)) { await closeReminder(db, lead.id, 'skipped', { reason: 'open_claim' }, nowMs); out('open_claim'); continue; }
      const useJob = jobId && job && lead.activeJobId && jobId !== lead.activeJobId;
      const rec = useJob ? Object.assign({}, job, { companyId: lead.companyId, userId: lead.userId }) : lead;
      const paid = await RN.paidAnchor(db, rec, lead.id, jobId);
      if (!paid) { await closeReminder(db, lead.id, 'skipped', { reason: 'not_paid' }, nowMs); out('not_paid'); continue; }
      const win = typeof d.sendWindow === 'function' ? d.sendWindow(lead, nowMs) : SendWindow.check(nowMs, lead, d.companyProfile || null);
      if (!win.ok) { out('outside_send_window'); continue; }
      const uid = String(lead.userId || '');
      if (d.repUrl == null && !repUrls.has(uid)) {
        let u = '';
        try { const s = await db.collection('users').doc(uid).get(); u = (s.exists && (s.data() || {}).googleReviewUrl) || ''; } catch (_) { u = ''; }
        repUrls.set(uid, u);
      }
      const url = V2.reviewUrlFor(d.repUrl != null ? d.repUrl : repUrls.get(uid));

      if (plan.channel === 'text') {
        const tr = await textReady(db, lead, d, nowMs, log, { reminder: true });
        if (!tr.ok) { if (tr.final) await closeReminder(db, lead.id, 'skipped', { reason: tr.reason }, nowMs); out(tr.reason); continue; }
        if (!(await claimReminder(db, lead.id, nowMs))) { out('claimed'); continue; }
        try {
          if (!(await MessagingControls.claimSendOnce(db, tr.to, V2.REMINDER_TEMPLATE, a.jobKey || lead.id))) throw new Error('duplicate');
          await sendCheckedText(d, lead, tr.to, V2.reminderText(lead, url), url, nowMs);
        } catch (e) {
          log.warn('review_reminder_text_failed', { leadId: lead.id, err: e && e.message });
          await closeReminder(db, lead.id, 'failed', { error: String((e && e.message) || e).slice(0, 200) }, nowMs);
          out('send_failed'); continue;
        }
      } else {
        const er = await emailReady(db, lead, d, log);
        if (!er.ok) { if (er.final) await closeReminder(db, lead.id, 'skipped', { reason: er.reason }, nowMs); out(er.reason); continue; }
        if (!(await claimReminder(db, lead.id, nowMs))) { out('claimed'); continue; }
        try {
          await sendEmail(db, d, er, V2.reminderEmail(lead, url), 'review-ask-reminder-v2', null);
        } catch (e) {
          log.warn('review_reminder_email_failed', { leadId: lead.id, err: e && e.message });
          if (e && e.message === 'canary_redirect') {
            // Nothing went out: the reminder is still owed.
            await db.collection('leads').doc(lead.id).update({ reviewAutoAsk: Object.assign({}, a) }).catch(() => {});
            out('canary'); continue;
          }
          await closeReminder(db, lead.id, 'failed', { error: String((e && e.message) || e).slice(0, 200) }, nowMs);
          out('send_failed'); continue;
        }
      }
      await closeReminder(db, lead.id, 'sent', { channel: plan.channel }, nowMs);
      const said = plan.channel === 'text' ? 'Review reminder texted automatically' : 'Review reminder emailed automatically';
      const source = plan.channel === 'text' ? 'auto-text-reminder' : 'auto-email-reminder';
      await db.collection('review_requests').add({ leadId: lead.id, userId: lead.userId || null, method: plan.channel === 'text' ? 'sms' : 'email', source, jobId, sentAt: FV.serverTimestamp(), status: 'sent', triggeredBy: TRIGGERED_BY, v2: true }).catch(() => {});
      await db.collection('leads').doc(lead.id).collection('activity').add({ userId: lead.userId || null, type: 'review_request_sent', label: said, message: said + ' (the one reminder).', source, createdAt: FV.serverTimestamp() }).catch(() => {});
      reminded++;
      out('sent', true);
    } catch (e) {
      log.warn('review_reminder_skipped', { leadId: lead.id, err: e && e.message });
      out('error');
    }
  }
  return { reminded, results };
}

module.exports = { askOneV2, runReminders, textReady, emailReady, phoneKey, PHONE_COLLECTION, TRIGGERED_BY };
