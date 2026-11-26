'use strict';
/**
 * review-ask-v2.js — the automatic review ask, v2: the sends (2026-11-26).
 *
 * Called by reviewAskAutoSweep (review-ask-auto.js) only when
 * REVIEW_ASK_V2_ENABLED === 'true'; the rules and the words are in
 * review-ask-v2-logic.js. Flag off: nothing here runs and v1 is unchanged.
 *
 *   askOneV2      one job's ask: TEXT first (consent, STOP register, declined
 *                 consent, the company's OWN registered sender, the SMS switch),
 *                 EMAIL otherwise (suppression, the company's postal address,
 *                 its name as From and its business email as Reply-To). v1's
 *                 once-per-job claim precedes either send.
 *   runReminders  the one reminder, REMINDER_DAYS after a v2 ask, same channel.
 *                 Every check is re-read at send time; its own claim
 *                 (reviewAutoAsk.reminder) and, for a text, its own send-once key.
 */

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
const { senderFor } = require('./tenant-ops-logic');

// v1's claim / settle / recordSent and its NBD sender, read at call time (review-ask-auto.js requires this file).
const A = () => require('./review-ask-auto')._test;
// Another company's email goes from the platform's verified address under that
// company's name and replies to its own business email (tenant-ops-logic senderFor).
const PLATFORM_FROM = 'NBD Pro <noreply@nobigdealwithjoedeal.com>';

const tenantOf = (rec) => String((rec && (rec.companyId || rec.userId)) || '');

/** companyProfile/{key} (raw doc, {} when absent) and its zone, cached per run in d.profiles. null = unreadable. */
async function companyFor(db, key, d) {
  if (!d.profiles) d.profiles = new Map();
  if (!d.profiles.has(key)) {
    d.profiles.set(key, (async () => {
      if (!key || key.indexOf('/') !== -1) return null;
      try {
        const s = await db.doc('companyProfile/' + key).get();
        const raw = s.exists ? (s.data() || {}) : {};
        const zone = await SendWindow.readCompanyZone(db, key).catch(() => null);
        return { raw, zone };
      } catch (_) { return null; }
    })());
  }
  return d.profiles.get(key);
}

/**
 * May this customer be texted by THIS company right now? Every read a text
 * needs, before any claim. → { ok: true, to } | { ok: false, reason, final }
 * final: the customer said no (STOP, declined) — the reminder closes for good.
 * The texting gate must say the shared A2P number is this company's own
 * registered sender (isNbd today): registered === true alone does not give a
 * company its own number, so every other company is emailed instead.
 */
async function textReady(db, lead, tenantKey, d, nowMs, log) {
  const pt = V2.planText({ env: d.env || process.env, lead, nowMs, ignoreHours: !!d.sendWindow });
  if (!pt.send) return { ok: false, reason: pt.reason, final: pt.reason === 'do_not_text' };
  if (typeof d.sendText !== 'function') return { ok: false, reason: 'no_sender', final: false };
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
  if (!gate.isNbd) return { ok: false, reason: 'no_own_sender', final: false };
  const sw = await MessagingControls.channelStatus(db, 'sms');
  if (!sw.allowed) return { ok: false, reason: 'messaging_paused', final: false };
  if (sw.canary) return { ok: false, reason: 'canary', final: false };
  return { ok: true, to: pt.to };
}

/**
 * The email's suppression gate + sender for this company. → { ok: true, to, gate, from, replyTo } | { ok: false, reason, final }
 */
async function emailReady(db, lead, tenantKey, raw, d, log) {
  const FV = d.FieldValue || FieldValue;
  const pe = V2.planEmail({ env: d.env || process.env, lead });
  if (!pe.send) return { ok: false, reason: pe.reason, final: false };
  if (!d.resend) return { ok: false, reason: 'no_sender', final: false };
  let gate;
  try {
    gate = await Suppression.gateCommercialEmail(db, { companyId: tenantKey, email: pe.to, leadId: lead.id, source: 'review-ask-auto' },
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
  const isNbdKey = tenantKey === RA.NBD_OWNER_UID;
  const s = senderFor(tenantKey, raw, isNbdKey ? A().FROM : PLATFORM_FROM);
  return { ok: true, to: pe.to, gate, from: s.from, replyTo: s.replyTo || (isNbdKey ? A().REPLY_TO : null) };
}

async function sendEmail(db, d, ready, content, campaign, attachments) {
  const body = Suppression.applyFooter(ready.gate, content.html, content.text);
  const msg = {
    from: ready.from, to: ready.to, subject: content.subject, html: body.html, text: body.text,
    headers: Object.assign({ 'X-NBD-Campaign': campaign }, ready.gate.headers), tags: ready.gate.tags,
  };
  if (ready.replyTo) msg.reply_to = ready.replyTo;
  if (attachments) msg.attachments = attachments;
  const gated = await MessagingControls.guardEmail(db, msg);
  if (!gated.send) throw new Error('messaging_paused:' + gated.reason);
  if (gated.canary) throw new Error('canary_redirect');
  const r = await d.resend.emails.send(gated.msg);
  if (resendRejected(r)) throw new Error(resendErrorMessage(r));
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
    const tenantKey = tenantOf(entry);
    const co = await companyFor(db, tenantKey, d);
    if (!co) return { sent: false, reason: 'profile_unreadable' };
    const settings = V2.profileSettings(co.raw);
    const el = V2.eligibility({ lead: entry, job: entry.job || null, jobId: entry.jobId || null, recvMs: entry.receivedMs, nowMs, settings });
    if (!el.ok) return { sent: false, reason: el.reason };
    const win = typeof d.sendWindow === 'function' ? d.sendWindow(entry, nowMs) : SendWindow.check(nowMs, entry, co.zone);
    if (!win.ok) return { sent: false, reason: 'outside_send_window' };
    const reminderDueMs = nowMs + V2.REMINDER_DAYS * V2.DAY_MS;

    // 1. The text, when every check passes.
    const tr = await textReady(db, entry, tenantKey, d, nowMs, log);
    if (tr.ok) {
      if (!(await A().claim(db, entry.id, entry.jobId, 'text', nowMs))) return { sent: false, reason: 'claimed' };
      try {
        if (!(await MessagingControls.claimSendOnce(db, tr.to, 'review_ask_text', entry.jobId || entry.id))) return { sent: false, reason: 'duplicate' };
        await d.sendText({ to: tr.to, body: V2.textBody(entry, settings), recipient: entry, companyProfile: co.zone || null, nowMs });
      } catch (e) {
        log.warn('review_auto_text_failed', { leadId: entry.id, err: e && e.message });
        await A().settle(db, entry.id, entry.jobId, 'text', 'failed', { atMs: nowMs, error: String((e && e.message) || e).slice(0, 200) });
        return { sent: false, reason: 'send_failed' };
      }
      await A().recordSent(db, entry, uid, 'text', nowMs, FV, { reminderDueMs, v2: true });
      return { sent: true, channel: 'text', reason: 'sent' };
    }

    // 2. Otherwise the email.
    const er = await emailReady(db, entry, tenantKey, co.raw, d, log);
    if (!er.ok) {
      if (er.reason === 'no_email' || er.reason === 'email_flag_disabled') return { sent: false, reason: 'no_channel', text: tr.reason };
      if (er.final) await A().settle(db, entry.id, entry.jobId, 'email', er.reason === 'unsubscribed' ? 'unsubscribed' : 'blocked_no_postal_address', { atMs: nowMs });
      return { sent: false, reason: er.reason };
    }
    const photo = RP.photoFlagOn(env) ? await RP.photoForEmail(db, entry, { loader: d.photoLoader, bucket: d.bucket, logger: log }) : null;
    if (!(await A().claim(db, entry.id, entry.jobId, 'email', nowMs))) return { sent: false, reason: 'claimed' };
    try {
      const content = V2.emailContent(entry, Object.assign({}, settings, { canReply: !!er.replyTo }), photo ? photo.content : null);
      await sendEmail(db, d, er, content, 'review-ask-auto-v2', photo ? photo.attachments : null);
    } catch (e) {
      log.warn('review_auto_email_failed', { leadId: entry.id, err: e && e.message });
      if (e && e.message === 'canary_redirect') {
        await db.collection('leads').doc(entry.id).update({ reviewAutoAsk: FV.delete() }).catch(() => {});
        return { sent: false, reason: 'canary' };
      }
      await A().settle(db, entry.id, entry.jobId, 'email', 'failed', { atMs: nowMs, error: String((e && e.message) || e).slice(0, 200) });
      return { sent: false, reason: 'send_failed' };
    }
    await A().recordSent(db, entry, uid, 'email', nowMs, FV, { reminderDueMs, v2: true });
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
 * Every check is re-read now (STOP, declined consent, unsubscribe, paid in
 * full, marked complete, the company's opt-in): nothing is taken from the
 * sweep that sent the ask. → { reminded, results }
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
  for (const doc of snap.docs) {
    const lead = Object.assign({ id: doc.id }, doc.data() || {});
    const a = lead.reviewAutoAsk || {};
    const out = (reason, sent) => { results.push({ leadId: lead.id, sent: !!sent, reason }); };
    try {
      if (d.maxAsks != null && reminded >= d.maxAsks) { out('per_run_cap'); break; }
      const tenantKey = tenantOf(lead);
      let reviewSeen = false;
      try {
        const rl = await db.doc('review_log/' + lead.id).get();
        const r = rl.exists ? (rl.data() || {}) : {};
        reviewSeen = r.reviewSeen === true && (!r.companyId || r.companyId === tenantKey);
      } catch (_) { out('review_log_unreadable'); continue; }
      const plan = V2.reminderPlan({ env, lead, nowMs, reviewSeen });
      if (!plan.send) { if (plan.final) await closeReminder(db, lead.id, 'skipped', { reason: plan.reason }, nowMs); out(plan.reason); continue; }
      const co = await companyFor(db, tenantKey, d);
      if (!co) { out('profile_unreadable'); continue; }
      const settings = V2.profileSettings(co.raw);
      const missing = !settings.enabled ? 'not_opted_in' : !settings.reviewUrl ? 'no_review_url' : !settings.companyName ? 'no_company_name' : '';
      if (missing) { await closeReminder(db, lead.id, 'skipped', { reason: missing }, nowMs); out(missing); continue; }
      // Still paid in full and still marked complete (a refund, a reopened balance or a walked-back stage ends it).
      const jobId = a.jobId || null;
      let job = null;
      if (jobId) { try { const js = await db.collection('leads').doc(lead.id).collection('jobs').doc(jobId).get(); job = js.exists ? js.data() : null; } catch (_) { job = null; } }
      const useJob = jobId && job && lead.activeJobId && jobId !== lead.activeJobId;
      const rec = useJob ? Object.assign({}, job, { companyId: lead.companyId, userId: lead.userId }) : lead;
      const paid = await RN.paidAnchor(db, rec, lead.id, jobId);
      if (!paid) { await closeReminder(db, lead.id, 'skipped', { reason: 'not_paid' }, nowMs); out('not_paid'); continue; }
      if (!V2.markedComplete(lead, job, jobId)) { await closeReminder(db, lead.id, 'skipped', { reason: 'not_marked_complete' }, nowMs); out('not_marked_complete'); continue; }
      const win = typeof d.sendWindow === 'function' ? d.sendWindow(lead, nowMs) : SendWindow.check(nowMs, lead, co.zone);
      if (!win.ok) { out('outside_send_window'); continue; }

      if (plan.channel === 'text') {
        const tr = await textReady(db, lead, tenantKey, d, nowMs, log);
        if (!tr.ok) { if (tr.final) await closeReminder(db, lead.id, 'skipped', { reason: tr.reason }, nowMs); out(tr.reason); continue; }
        if (!(await claimReminder(db, lead.id, nowMs))) { out('claimed'); continue; }
        try {
          if (!(await MessagingControls.claimSendOnce(db, tr.to, V2.REMINDER_TEMPLATE, a.jobKey || lead.id))) { out('duplicate'); continue; }
          await d.sendText({ to: tr.to, body: V2.reminderText(lead, settings), recipient: lead, companyProfile: co.zone || null, nowMs });
        } catch (e) {
          log.warn('review_reminder_text_failed', { leadId: lead.id, err: e && e.message });
          await closeReminder(db, lead.id, 'failed', { error: String((e && e.message) || e).slice(0, 200) }, nowMs);
          out('send_failed'); continue;
        }
      } else {
        const er = await emailReady(db, lead, tenantKey, co.raw, d, log);
        if (!er.ok) { if (er.final) await closeReminder(db, lead.id, 'skipped', { reason: er.reason }, nowMs); out(er.reason); continue; }
        if (!(await claimReminder(db, lead.id, nowMs))) { out('claimed'); continue; }
        try {
          await sendEmail(db, d, er, V2.reminderEmail(lead, settings), 'review-ask-reminder-v2', null);
        } catch (e) {
          log.warn('review_reminder_email_failed', { leadId: lead.id, err: e && e.message });
          if (e && e.message === 'canary_redirect') {
            // Nothing went out: the reminder is still owed.
            const ref = db.collection('leads').doc(lead.id);
            await ref.update({ reviewAutoAsk: Object.assign({}, a) }).catch(() => {});
            out('canary'); continue;
          }
          await closeReminder(db, lead.id, 'failed', { error: String((e && e.message) || e).slice(0, 200) }, nowMs);
          out('send_failed'); continue;
        }
      }
      await closeReminder(db, lead.id, 'sent', { channel: plan.channel }, nowMs);
      const said = plan.channel === 'text' ? 'Review reminder texted automatically' : 'Review reminder emailed automatically';
      const source = plan.channel === 'text' ? 'auto-text-reminder' : 'auto-email-reminder';
      await db.collection('review_requests').add({ leadId: lead.id, userId: lead.userId || null, method: plan.channel === 'text' ? 'sms' : 'email', source, jobId, sentAt: FV.serverTimestamp(), status: 'sent' }).catch(() => {});
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

module.exports = { askOneV2, runReminders, textReady, emailReady, PLATFORM_FROM };
