'use strict';
/**
 * review-ask-auto.js — the automatic homeowner review ask (2026-10-15).
 *
 * reviewAskAutoSweep, daily 10:00 ET. For each rep, the jobs that are paid in
 * full with their money RECEIVED 3–21 days ago (review-ask-auto-logic.js
 * receivedMs: the payment's date received, never when it was typed), found
 * through the same lanes as the rep nudge (review-request-nudge.js
 * findReviewDueLeads, mode 'auto'), each asked ONCE:
 *
 *   email (REVIEW_ASK_AUTO_EMAIL_ENABLED === 'true'): from jd@, through the
 *     email-suppression gate (an unsubscribed address is skipped and the
 *     footer carries the postal address + a working unsubscribe link and the
 *     one-click headers; no postal address = not sent). With
 *     REVIEW_ASK_EMAIL_PHOTO_ENABLED === 'true' it shows the customer's own
 *     before/after first (review-ask-photo.js: that lead's photos only,
 *     EXIF/GPS stripped, inline cid: images; none found = the same email).
 *   text (REVIEW_ASK_AUTO_TEXT_ENABLED === 'true', DARK until A2P approval):
 *     only a customer with no usable email, with stored web-form texting
 *     consent, 8am–9pm their time, after the STOP / Do Not Text register,
 *     the declined-consent decision (kind 'automated') and the company's
 *     texting switch.
 *
 * One ask per job, ever: a transaction on the lead claims
 * reviewAutoAsk = { jobKey, status: 'sending' } BEFORE the send and refuses
 * when the lead is already reviewRequested or this job was already tried.
 * After a send the lead reads reviewRequested: true, reviewRequestSource:
 * 'auto-email' (or 'auto-text'), and Joe gets the bell + timeline row
 * "Review ask emailed automatically" instead of "send a review request?".
 * A failed send is not retried (the job then goes back to the rep nudge).
 */

const { onSchedule } = require('./integrations/heartbeat');
const { defineSecret } = require('firebase-functions/params');
const { logger: fnLogger } = require('firebase-functions/v2');
const { FieldPath, FieldValue, getFirestore } = require('firebase-admin/firestore');
const RA = require('./review-ask-auto-logic');
const RP = require('./review-ask-photo');
const Suppression = require('./email-suppression');
const MessagingControls = require('./messaging-controls');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const OptOut = require('./sms-optout');
const TextingGate = require('./sms-texting-gate');
const ConsentDeclined = require('./sms-consent-declined');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');

const FROM = 'Joe Deal <jd@nobigdealwithjoedeal.com>';
const REPLY_TO = 'jd@nobigdealwithjoedeal.com';

async function repReviewUrl(db, uid) {
  try {
    const s = await db.collection('users').doc(uid).get();
    return (s.exists && (s.data() || {}).googleReviewUrl) || '';
  } catch (_) { return ''; }
}

/** Claim the job's one ask. → true when this run owns it. */
async function claim(db, leadId, jobId, channel, nowMs) {
  const ref = db.collection('leads').doc(leadId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return false;
    const l = s.data() || {};
    if (l.deleted === true || l.reviewRequested === true || RA.attempted(l, jobId)) return false;
    tx.update(ref, { reviewAutoAsk: { jobKey: RA.jobKey(jobId), jobId: jobId || null, channel, status: 'sending', claimedAtMs: nowMs } });
    return true;
  });
}

async function settle(db, leadId, jobId, channel, status, extra) {
  const patch = { reviewAutoAsk: Object.assign({ jobKey: RA.jobKey(jobId), jobId: jobId || null, channel, status }, extra || {}) };
  await db.collection('leads').doc(leadId).update(patch).catch(() => {});
}

/** Everything that says "asked" after a real send. */
async function recordSent(db, entry, uid, channel, nowMs, FV) {
  const source = channel === 'text' ? RA.TEXT_SOURCE : RA.SOURCE;
  const leadRef = db.collection('leads').doc(entry.id);
  const patch = {
    reviewRequested: true,
    reviewRequestedAt: FV.serverTimestamp(),
    reviewRequestSource: source,
    // The rep nudge's own latch, so it never also asks Joe to ask by hand.
    reviewNudgedAt: FV.serverTimestamp(),
    reviewAutoAsk: { jobKey: RA.jobKey(entry.jobId), jobId: entry.jobId || null, channel, status: 'sent', sentAtMs: nowMs },
  };
  if (entry.jobId) patch.reviewJobCount = FV.increment(1);
  await leadRef.update(patch).catch((e) => fnLogger.warn('review_auto_mark_failed', { leadId: entry.id, err: e && e.message }));
  if (entry.jobId) {
    await leadRef.collection('jobs').doc(entry.jobId).update({ reviewRequestedAt: FV.serverTimestamp(), reviewNudgedAt: FV.serverTimestamp(), reviewRequestSource: source }).catch(() => {});
  }
  const said = channel === 'text' ? 'Review ask texted automatically' : 'Review ask emailed automatically';
  await db.collection('review_requests').add({ leadId: entry.id, userId: uid, method: channel === 'text' ? 'sms' : 'email', source, jobId: entry.jobId || null, sentAt: FV.serverTimestamp(), status: 'sent' }).catch(() => {});
  await leadRef.collection('activity').add({ userId: uid, type: 'review_request_sent', label: said, message: said + ' (paid in full).', source, createdAt: FV.serverTimestamp() }).catch(() => {});
  const name = ((entry.firstName || '') + ' ' + (entry.lastName || '')).trim() || 'Customer';
  const note = { userId: uid, leadId: entry.id, type: 'review_request', title: '⭐ ' + said, message: said + ' to ' + name + '.', source, read: false, dismissed: false, createdAt: FV.serverTimestamp() };
  if (entry.jobId) note.jobId = entry.jobId;
  await db.collection('notifications').add(note).catch(() => {});
}

/**
 * One job's automatic ask. Never throws. deps: { env, nowMs, resend, sendText,
 * FieldValue, logger, repUrl }.
 * → { sent: boolean, channel?, reason }
 */
async function askOne(db, entry, uid, deps) {
  const d = deps || {};
  const log = d.logger || fnLogger;
  const FV = d.FieldValue || FieldValue;
  const nowMs = Number(d.nowMs) || Date.now();
  const args = { env: d.env || process.env, lead: entry, job: entry.job || null, jobId: entry.jobId || null, recvMs: entry.receivedMs, nowMs };
  try {
    // An automation never reaches back: only a job paid in the last 7 days
    // (MessagingControls.MAX_AUTOMATION_AGE_DAYS), however wide the window in
    // review-ask-auto-logic.js is, so switching this on cannot ask the backlog.
    if (d.maxAgeDays != null && !MessagingControls.withinAutomationAge(entry.receivedMs, nowMs, d.maxAgeDays)) return { sent: false, reason: 'too_old' };
    const reviewUrl = RA.reviewUrlFor(entry, d.repUrl);
    const pe = RA.planEmail(args);
    if (pe.send) {
      if (!reviewUrl) return { sent: false, reason: 'no_review_url' };
      if (!d.resend) return { sent: false, reason: 'no_sender' };
      const tenantKey = RA.NBD_OWNER_UID;
      let gate;
      try {
        gate = await Suppression.gateCommercialEmail(db, { companyId: tenantKey, email: pe.to, leadId: entry.id, source: 'review-ask-auto' },
          { timeoutMs: Suppression.READ_TIMEOUT_MS, serverTimestamp: FV.serverTimestamp });
      } catch (e) {
        log.warn('review_auto_suppression_unverified', { leadId: entry.id, err: e && e.message });
        return { sent: false, reason: 'suppression_unverified' };       // retried next run while in window
      }
      if (gate.suppressed) { await settle(db, entry.id, entry.jobId, 'email', 'unsubscribed', { atMs: nowMs }); return { sent: false, reason: 'unsubscribed' }; }
      // No CAN-SPAM postal address: not sent, and the job goes back to the rep
      // nudge (stamped, so the nudge stops waiting for this sweep).
      if (gate.blocked) { await settle(db, entry.id, entry.jobId, 'email', 'blocked_no_postal_address', { atMs: nowMs }); return { sent: false, reason: 'no_postal_address' }; }
      // The customer's own before/after (REVIEW_ASK_EMAIL_PHOTO_ENABLED): this
      // lead's photos only, re-encoded without EXIF/GPS, inline. null = the
      // email exactly as before. Read before the claim so the claim-to-send
      // gap stays short; it never throws and never blocks the ask.
      const photo = RP.photoFlagOn(d.env || process.env)
        ? await RP.photoForEmail(db, entry, { loader: d.photoLoader, bucket: d.bucket, logger: log })
        : null;
      // The owner's customer-send switch BEFORE the once-per-job claim: a paused
      // send must not use up the job's single ask. Retried next run while in window.
      const sw = await MessagingControls.channelStatus(db, 'email');
      if (!sw.allowed) return { sent: false, reason: 'messaging_paused' };
      if (!(await claim(db, entry.id, entry.jobId, 'email', nowMs))) return { sent: false, reason: 'claimed' };
      const c = RA.emailContent(entry, reviewUrl, photo ? photo.content : null);
      const body = Suppression.applyFooter(gate, c.html, c.text);
      let delivered = false;
      try {
        const msg = {
          from: FROM, to: pe.to, reply_to: REPLY_TO, subject: c.subject, html: body.html, text: body.text,
          headers: Object.assign({ 'X-NBD-Campaign': 'review-ask-auto-v1' }, gate.headers), tags: gate.tags,
        };
        if (photo) msg.attachments = photo.attachments;
        const gated = await MessagingControls.guardEmail(db, msg);
        if (!gated.send) throw new Error('messaging_paused:' + gated.reason);
        const r = await d.resend.emails.send(gated.msg);
        if (resendRejected(r)) throw new Error(resendErrorMessage(r));
        delivered = true;
      } catch (e) {
        log.warn('review_auto_email_failed', { leadId: entry.id, err: e && e.message });
        await settle(db, entry.id, entry.jobId, 'email', 'failed', { atMs: nowMs, error: String((e && e.message) || e).slice(0, 200) });
        return { sent: false, reason: 'send_failed' };
      }
      if (delivered && photo) log.info('review_auto_photo', { leadId: entry.id, kind: photo.kind, photoIds: photo.photoIds });
      if (delivered) await recordSent(db, entry, uid, 'email', nowMs, FV);
      return { sent: true, channel: 'email', reason: 'sent' };
    }
    // Not by email: no usable address (or the email flag off). Anything else
    // (lost, deleted, already asked, outside the window...) is final for both.
    if (pe.reason !== 'no_email' && pe.reason !== 'flag_disabled') return { sent: false, reason: pe.reason };

    const pt = RA.planText(args);
    if (!pt.send) return { sent: false, reason: pt.reason === 'flag_disabled' ? pe.reason : pt.reason };
    if (!reviewUrl) return { sent: false, reason: 'no_review_url' };
    if (typeof d.sendText !== 'function') return { sent: false, reason: 'no_sender' };
    const tenantKey = RA.NBD_OWNER_UID;
    // Idempotency per (recipient, template, job): a rerun can never text twice.
    const opt = await OptOut.isOptedOut(db, pt.to, { companyId: tenantKey, timeoutMs: OptOut.READ_TIMEOUT_MS });
    if (opt.optedOut) { await settle(db, entry.id, entry.jobId, 'text', 'opted_out', { atMs: nowMs }); return { sent: false, reason: 'opted_out' }; }
    const cd = await ConsentDeclined.decide(db, {
      phone: pt.to, lead: entry, leadId: entry.id,
      tenants: [tenantKey, entry.companyId, entry.userId].filter(Boolean), kind: 'automated', nowMs, logger: log,
    });
    if (!cd.allowed) return { sent: false, reason: cd.code };
    const status = await TextingGate.textingStatus(db, tenantKey);
    if (!status.allowed) return { sent: false, reason: 'texting_' + status.reason };
    if (!(await claim(db, entry.id, entry.jobId, 'text', nowMs))) return { sent: false, reason: 'claimed' };
    try {
      if (!(await MessagingControls.claimSendOnce(db, pt.to, 'review_ask_text', entry.jobId || entry.id))) {
        return { sent: false, reason: 'duplicate' };
      }
      await d.sendText({ to: pt.to, body: RA.textBody(entry, reviewUrl) });
    } catch (e) {
      log.warn('review_auto_text_failed', { leadId: entry.id, err: e && e.message });
      await settle(db, entry.id, entry.jobId, 'text', 'failed', { atMs: nowMs, error: String((e && e.message) || e).slice(0, 200) });
      return { sent: false, reason: 'send_failed' };
    }
    await recordSent(db, entry, uid, 'text', nowMs, FV);
    return { sent: true, channel: 'text', reason: 'sent' };
  } catch (e) {
    log.warn('review_auto_skipped', { leadId: entry && entry.id, err: e && e.message });
    return { sent: false, reason: 'error' };
  }
}

/** One rep's sweep. → { asked, results } */
async function runForUser(db, uid, deps) {
  const d = Object.assign({}, deps || {});
  const RN = require('./review-request-nudge')._test;
  const due = await RN.findReviewDueLeads(db, uid, { mode: 'auto', env: d.env || process.env, nowMs: d.nowMs });
  if (!due.length) return { asked: 0, results: [] };
  d.repUrl = d.repUrl != null ? d.repUrl : await repReviewUrl(db, uid);
  const results = [];
  let asked = 0;
  for (const entry of due) {
    if (d.maxAsks != null && asked >= d.maxAsks) { results.push({ leadId: entry.id, jobId: entry.jobId || null, sent: false, reason: 'per_run_cap' }); break; }
    const r = await askOne(db, entry, uid, d);
    results.push(Object.assign({ leadId: entry.id, jobId: entry.jobId || null }, r));
    if (r.sent) asked++;
  }
  return { asked, results };
}

async function sendTextTwilio({ to, body }) {
  const { secretValue: sv } = require('./integrations/_shared');
  const sid = sv(TWILIO_ACCOUNT_SID), tok = sv(TWILIO_AUTH_TOKEN), from = sv(TWILIO_PHONE_NUMBER);
  if (!sid || !tok || !from) throw new Error('twilio-not-configured');
  return MessagingControls.guardTwilio(getFirestore(), require('twilio')(sid, tok)).messages.create({ to, from, body });
}

exports.reviewAskAutoSweep = onSchedule(
  {
    schedule: '0 10 * * *', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 540, memory: '512MiB',
    secrets: [RESEND_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
  },
  async () => {
    const db = getFirestore();
    // Each channel needs its env flag AND an explicit messaging_controls/
    // automations entry AND the global switch (2026-10-19, fail closed). The
    // combined answer is written back into the env the planners read, so the
    // pure planning code is unchanged. maxPerRun caps the whole sweep.
    const autoEmail = await MessagingControls.automationStatus(db, 'reviewAskAutoEmail', 'email', process.env.REVIEW_ASK_AUTO_EMAIL_ENABLED === 'true');
    const autoText = await MessagingControls.automationStatus(db, 'reviewAskAutoText', 'sms', process.env.REVIEW_ASK_AUTO_TEXT_ENABLED === 'true');
    const emailOn = autoEmail.enabled;
    const textOn = autoText.enabled;
    if (!emailOn && !textOn) { fnLogger.info('review_auto_disabled', { email: autoEmail.reason, text: autoText.reason }); return; }
    const runEnv = Object.assign({}, process.env, {
      REVIEW_ASK_AUTO_EMAIL_ENABLED: emailOn ? 'true' : 'false',
      REVIEW_ASK_AUTO_TEXT_ENABLED: textOn ? 'true' : 'false',
    });
    const runCap = Math.min(emailOn ? autoEmail.maxPerRun : Infinity, textOn ? autoText.maxPerRun : Infinity);
    const { Resend } = require('resend');
    const resend = emailOn && process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
    // Every rep's book, paginated (the nudge's lesson: a bare limit drops
    // user #501+). Only NBD's customers are ever asked (jd@ speaks for NBD:
    // review-ask-auto-logic.js baseEligibility 'not_nbd').
    const counts = {};
    let asked = 0, cursor = null;
    while (true) {
      let q = db.collection('users').orderBy(FieldPath.documentId()).limit(500);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) break;
      for (const u of snap.docs) {
        if ((u.data() || {}).e2eTestAccount) continue;
        if (asked >= runCap) break;
        try {
          const out = await runForUser(db, u.id, { env: runEnv, resend, sendText: textOn ? sendTextTwilio : null, logger: fnLogger, maxAsks: runCap - asked, maxAgeDays: MessagingControls.MAX_AUTOMATION_AGE_DAYS });
          asked += out.asked;
          for (const r of out.results) counts[r.reason] = (counts[r.reason] || 0) + 1;
        } catch (e) {
          fnLogger.warn('review_auto_user_error', { uid: u.id, err: e && e.message });
          counts.user_error = (counts.user_error || 0) + 1;
        }
      }
      if (snap.size < 500) break;
      cursor = snap.docs[snap.docs.length - 1];
    }
    fnLogger.info('review_auto_complete', { asked, counts });
  }
);

exports._test = { askOne, runForUser, claim, recordSent };
