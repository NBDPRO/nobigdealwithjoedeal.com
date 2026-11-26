'use strict';
/**
 * review-ask-v2-logic.js — the automatic review ask, v2 (2026-11-26). PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Jo, 2026-11-26: an automatic review-request text after a job is done, for
 * every company on the CRM. v1 (review-ask-auto-logic.js) stays exactly as it
 * is while REVIEW_ASK_V2_ENABLED is anything but the literal 'true'. Under v2:
 *
 *   1. TEXT first, EMAIL otherwise. A text needs stored web-form consent, a
 *      number not on the STOP register, and the company's OWN registered
 *      sender (review-ask-auto.js checks the texting gate; today the shared
 *      A2P number belongs to one tenant only, so every other company is
 *      emailed). No usable text → the email (suppression + CAN-SPAM footer).
 *   2. Every company, opted in through ITS companyProfile/{companyId}:
 *        reviewAsk: { enabled: true, googleReviewUrl: 'https://…', signedBy?: 'Name' }
 *      The link, the company name and the contact lines are read from that
 *      profile. Nothing here names NBD, links NBD's page or dials NBD's phone.
 *   3. "Job marked complete" (Install Done stamped, or the stage history went
 *      through Install Done / Final Photos) as well as paid in full: a job
 *      paid up front and moved straight to Final Payment by the payoff is not
 *      asked until someone marks the install done.
 *   4. ONE ask per job (v1's claim) plus at most ONE reminder, REMINDER_DAYS
 *      after the ask, on the same channel, only while no review is logged.
 *
 * The same words to everyone: no rating first, no "if you were happy",
 * nothing offered (FTC 16 CFR 465, Google's review policy).
 */

const RA = require('./review-ask-auto-logic');
const MCR = require('./missed-call-reply-logic');
const SendWindow = require('./sms-send-window');
const roles = require('./stage-roles');
const { isQuietBackfill } = require('./quiet-backfill');

const FLAG = 'REVIEW_ASK_V2_ENABLED';
const REMINDER_DAYS = 7;
// A reminder more than this late (the sweep was off) is dropped, never sent late.
const REMINDER_GRACE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_TEMPLATE = 'review_ask_reminder_text';

const v2On = (env) => !!env && env[FLAG] === 'true';
const truthy = (v) => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|y|1|on)$/i.test(v.trim()));
const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u.trim()) ? u.trim().slice(0, 500) : '');
// One line of plain text from a profile: no control characters, brackets or quotes.
const line = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>"\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80);
const ms = (t) => {
  if (!t) return 0;
  if (typeof t === 'number') return Number.isFinite(t) ? t : 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.toDate === 'function') return t.toDate().getTime();
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : 0;
};

/** A company's review-ask settings from its companyProfile doc. Never throws. */
function profileSettings(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const ra = p.reviewAsk && typeof p.reviewAsk === 'object' ? p.reviewAsk : {};
  const b = p.brand && typeof p.brand === 'object' ? p.brand : {};
  const c = b.contact && typeof b.contact === 'object' ? b.contact : {};
  const email = line(c.email || p.businessEmail, 254);
  return {
    enabled: ra.enabled === true,
    reviewUrl: httpsUrl(ra.googleReviewUrl),
    companyName: line(b.displayName || b.name || b.legalName || p.businessName || p.companyName, 70),
    signedBy: line(ra.signedBy, 60),
    phone: line(c.phone || p.businessPhone, 30),
    email: RA.validEmail(email) ? email : '',
  };
}

const DONE_KEYS = { install_complete: 1, final_photos: 1 };
/**
 * Was the job marked complete? Its own Install Done / completed stamp, or a
 * stage history that went through Install Done or Final Photos. A job doc
 * judges by its own fields; the lead's fields stand for its ACTIVE job only.
 */
function markedComplete(lead, job, jobId) {
  const l = lead || {};
  const useJob = !!job && !!jobId && l.activeJobId && jobId !== l.activeJobId;
  const rec = useJob ? job : Object.assign({}, l, job || {});
  if (ms(rec.installCompletedAt) || ms(rec.completedAt)) return true;
  if (!useJob && job && (ms(l.installCompletedAt) || ms(l.completedAt))) return true;
  const h = Array.isArray(rec.stageHistory) ? rec.stageHistory : [];
  return h.some((e) => e && DONE_KEYS[String(e.to || '').trim().toLowerCase().replace(/\s+/g, '_')]);
}

/**
 * Who may be asked, before any read beyond the company profile. Mirrors v1's
 * baseEligibility without its NBD-only rule, plus the company's opt-in and
 * "marked complete". → { ok: true } | { ok: false, reason }
 */
function eligibility({ lead, job, jobId, recvMs, nowMs, settings }) {
  const l = lead || {};
  const s = settings || {};
  if (l.deleted === true || l.deletedAt) return { ok: false, reason: 'deleted' };
  if (l.archived === true) return { ok: false, reason: 'archived' };
  if (roles.isLost(l) || (job && roles.isLost(job))) return { ok: false, reason: 'lost' };
  if (isQuietBackfill(l) || (job && isQuietBackfill(job))) return { ok: false, reason: 'quiet_backfill' };
  if (l.reviewRequested === true || (job && ms(job.reviewRequestedAt))) return { ok: false, reason: 'already_requested' };
  if (RA.attempted(l, jobId)) return { ok: false, reason: 'already_attempted' };
  if (truthy(l.doNotContact) || truthy(l.dnc)) return { ok: false, reason: 'do_not_contact' };
  if (!RA.inWindow(recvMs, nowMs)) return { ok: false, reason: recvMs ? 'outside_window' : 'no_received_date' };
  if (!s.enabled) return { ok: false, reason: 'not_opted_in' };
  if (!s.reviewUrl) return { ok: false, reason: 'no_review_url' };
  if (!s.companyName) return { ok: false, reason: 'no_company_name' };
  if (!markedComplete(l, job, jobId)) return { ok: false, reason: 'not_marked_complete' };
  return { ok: true };
}

/** The text pre-flight before any read (the STOP register, declined consent and sender gate are I/O). */
function planText({ env, lead, nowMs, ignoreHours }) {
  if (!env || env[RA.TEXT_FLAG] !== 'true') return { send: false, reason: 'text_flag_disabled' };
  const l = lead || {};
  if (truthy(l.doNotText) || truthy(l.smsOptOut) || truthy(l.smsOptedOut)) return { send: false, reason: 'do_not_text' };
  const d = MCR.digits10(l.phone || l.phoneDigits);
  if (!d) return { send: false, reason: 'no_number' };
  if (!MCR.webFormConsent(l)) return { send: false, reason: 'no_consent' };
  if (!ignoreHours && !SendWindow.withinRecipientWindow(Number(nowMs) || Date.now(), l)) return { send: false, reason: 'quiet_hours' };
  return { send: true, to: '+1' + d };
}

/** The email pre-flight. */
function planEmail({ env, lead }) {
  if (!env || env[RA.EMAIL_FLAG] !== 'true') return { send: false, reason: 'email_flag_disabled' };
  const e = String((lead && lead.email) || '').trim();
  return RA.validEmail(e) ? { send: true, to: e } : { send: false, reason: 'no_email' };
}

/**
 * The one reminder: is it due, and on which channel? Reads only the lead's
 * live fields and whether a review was logged. → { send, channel } | { send: false, reason, final }
 * final: true = close the reminder for good; false = hold for a later run.
 */
function reminderPlan({ env, lead, nowMs, reviewSeen }) {
  const l = lead || {};
  const a = l.reviewAutoAsk && typeof l.reviewAutoAsk === 'object' ? l.reviewAutoAsk : {};
  const due = Number(a.reminderDueMs) || 0;
  const now = Number(nowMs) || Date.now();
  if (!v2On(env)) return { send: false, reason: 'flag_disabled', final: false };
  if (!due || a.status !== 'sent' || (a.reminder && a.reminder.status)) return { send: false, reason: 'not_due', final: true };
  if (now < due) return { send: false, reason: 'not_yet', final: false };
  if (now > due + REMINDER_GRACE_DAYS * DAY_MS) return { send: false, reason: 'expired', final: true };
  if (l.deleted === true || l.deletedAt) return { send: false, reason: 'deleted', final: true };
  if (l.archived === true) return { send: false, reason: 'archived', final: true };
  if (roles.isLost(l)) return { send: false, reason: 'lost', final: true };
  if (truthy(l.doNotContact) || truthy(l.dnc)) return { send: false, reason: 'do_not_contact', final: true };
  if (reviewSeen) return { send: false, reason: 'review_seen', final: true };
  const channel = a.channel === 'text' ? 'text' : 'email';
  if (channel === 'text' && (truthy(l.doNotText) || truthy(l.smsOptOut) || truthy(l.smsOptedOut))) return { send: false, reason: 'do_not_text', final: true };
  return { send: true, channel };
}

// ── The words ───────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const firstNameOf = (lead) => line(String((lead && (lead.firstName || lead.name)) || '').trim().split(/\s+/)[0], 40);
const hiOf = (lead) => { const f = firstNameOf(lead); return f ? 'Hi ' + f : 'Hi'; };
const fromLine = (s) => (s.signedBy ? s.signedBy + ' with ' + s.companyName : s.companyName);
const signOff = (s) => (s.signedBy ? [s.signedBy, s.companyName] : [s.companyName]);
/** "call us at X or reply to this email" — only the ways that exist. */
function contactLine(s, viaEmail) {
  const ways = [];
  if (s.phone) ways.push('call us at ' + s.phone);
  if (viaEmail) ways.push('reply to this email');
  if (!ways.length) return '';
  return "If anything about the job isn't right, " + ways.join(' or ') + '. Either way, your review is welcome.';
}

function textBody(lead, s) {
  return hiOf(lead) + ", it's " + fromLine(s) + '. Thank you for choosing us. '
    + 'Would you leave us a Google review? ' + s.reviewUrl + ' Reply STOP to opt out.';
}
function reminderText(lead, s) {
  return hiOf(lead) + ', ' + s.companyName + ' here with one last note: if you have a minute, a Google review helps your neighbors pick a contractor. '
    + 'If you already left one, thank you. ' + s.reviewUrl + ' Reply STOP to opt out.';
}

const LINK = { link: true };
/** parts: plain strings (escaped), LINK (the review button), or { html, text } (the photo block, already built). */
function emailShell(subject, parts, s, url) {
  const textOf = (p) => (p === LINK ? url : (typeof p === 'string' ? p : String(p.text || '').trim()));
  const htmlOf = (p) => {
    if (p === LINK) {
      return '<p style="text-align:center;margin:22px 0;"><a href="' + esc(url) + '" style="display:inline-block;padding:12px 24px;background:#BD5728;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">Leave a Google review</a></p>'
        + '<p style="font-size:13px;color:#6b7280;">Or paste this link: ' + esc(url) + '</p>';
    }
    return typeof p === 'string' ? '<p>' + esc(p) + '</p>' : String(p.html || '');
  };
  const text = parts.map(textOf).filter(Boolean).join('\n\n') + '\n\nThank you,\n' + signOff(s).join('\n');
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<title>' + esc(subject) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f5f5f5;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;line-height:1.6;">'
    + '<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:28px 24px;">'
    + parts.map(htmlOf).join('')
    + '<p>Thank you,<br>' + signOff(s).map(esc).join('<br>') + '</p>'
    + '</div></body></html>';
  return { subject, html, text };
}

/** The ask email. `photo` = review-ask-photo.js contentFor() shape, optional. */
function emailContent(lead, s, photo) {
  const pb = RA.photoBlock(photo);
  const parts = [hiOf(lead) + ','];
  if (pb.html) parts.push(pb);
  parts.push('Thank you for trusting ' + s.companyName + ' with your project. Would you take a minute to leave us a Google review? '
    + 'Honest feedback, whatever it is, helps your neighbors pick a contractor.');
  parts.push(LINK);
  // "reply to this email" only when a reply reaches the company (s.canReply false = no Reply-To of its own).
  const c = contactLine(s, s.canReply !== false);
  if (c) parts.push(c);
  return emailShell('Would you leave ' + s.companyName + ' a quick Google review?', parts, s, s.reviewUrl);
}

/** The one reminder email. */
function reminderEmail(lead, s) {
  return emailShell('A quick reminder from ' + s.companyName, [
    hiOf(lead) + ',',
    'A short follow-up in case our last note got buried. If you have a minute, a Google review helps your neighbors pick a contractor. '
      + 'Honest feedback, whatever it is, is welcome. If you already left one, thank you.',
    LINK,
    'This is the only reminder we will send.',
  ], s, s.reviewUrl);
}

module.exports = {
  FLAG, REMINDER_DAYS, REMINDER_GRACE_DAYS, REMINDER_TEMPLATE, DAY_MS,
  v2On, profileSettings, markedComplete, eligibility, planText, planEmail, reminderPlan,
  textBody, reminderText, emailContent, reminderEmail,
};
