'use strict';
/**
 * review-ask-v2-logic.js — the automatic review ask, v2: text first + one
 * reminder (2026-11-26). PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Jo, 2026-11-26: "Text first + reminder", NBD only, off by default; the
 * multi-company ask is a separate, guarded PR. v1 (review-ask-auto-logic.js)
 * stays exactly as it is while REVIEW_ASK_V2_ENABLED is anything but 'true'.
 *
 * Under v2, for NBD's own customers only (the same paid-in-full trigger and
 * 3-21 day window as v1):
 *   1. TEXT first when every text check passes (stored web-form consent, the
 *      STOP register, declined consent, the texting gate, the SMS switch, and
 *      this number not asked in the last PHONE_WINDOW_DAYS), the EMAIL otherwise.
 *   2. ONE reminder REMINDER_DAYS after the ask, same channel, every check
 *      re-read, only while no review is logged.
 *
 * NBD's A2P registration is never put at risk (Jo, 2026-11-26):
 *   - only a lead whose companyId is NBD's is ever texted (isNbd, by key);
 *   - every text is one of two fixed templates, checked by smsContentOk()
 *     before the send: the link only on an allowlisted Google review shape,
 *     no other URL, "Reply STOP to opt out." always present, <= 320 chars;
 *   - no ask or reminder during an open warranty claim, and never with money
 *     owed (paid in full is re-checked before the reminder).
 * The same words to everyone: no rating first, no condition, nothing offered.
 */

const RA = require('./review-ask-auto-logic');
const MCR = require('./missed-call-reply-logic');
const SendWindow = require('./sms-send-window');
const roles = require('./stage-roles');

const FLAG = 'REVIEW_ASK_V2_ENABLED';
const REMINDER_DAYS = 7;
// A reminder more than this late (the sweep was off) is dropped, never sent late.
const REMINDER_GRACE_DAYS = 7;
// One review ask per phone number in this window, whatever the job or lead.
const PHONE_WINDOW_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_TEMPLATE = 'review_ask_reminder_text';
const STOP_LINE = 'Reply STOP to opt out.';
const SMS_MAX = 320;

const v2On = (env) => !!env && env[FLAG] === 'true';
const truthy = (v) => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|y|1|on)$/i.test(v.trim()));

// The only review links a text may carry: Google's own review pages.
const GOOGLE_REVIEW_URL = [
  /^https:\/\/g\.page\/r\/[A-Za-z0-9_-]{6,64}\/review$/,
  /^https:\/\/search\.google\.com\/local\/writereview\?placeid=[A-Za-z0-9_-]{10,200}$/,
];
const isGoogleReviewUrl = (u) => typeof u === 'string' && GOOGLE_REVIEW_URL.some((re) => re.test(u));
/** The link for a v2 ask: the rep's saved link when it is a Google review page, else NBD's. */
const reviewUrlFor = (repUrl) => (isGoogleReviewUrl(String(repUrl || '').trim()) ? String(repUrl).trim() : RA.NBD_REVIEW_URL);

/** An open warranty claim (or a warranty / service stage): no ask, no reminder. */
function openClaim(rec) {
  const r = rec || {};
  if (r.openWarrantyClaimId) return true;
  const key = String(r._stageKey || r.stage || '').trim().toLowerCase().replace(/\s+/g, '_');
  return /^(warranty|service)_/.test(key);
}

/**
 * Who may be asked: v1's rules (NBD only, paid-in-full window, one ask per
 * job, DNC, lost, archived, quiet backfill) plus no open warranty claim.
 */
function eligibility(args) {
  const b = RA.baseEligibility(args);
  if (!b.ok) return b;
  if (openClaim(args.lead) || openClaim(args.job)) return { ok: false, reason: 'open_claim' };
  return { ok: true };
}

/** The text pre-flight before any read. Unlike v1 it does not need "no email": the text comes first. */
function planText({ env, lead, nowMs, ignoreHours }) {
  if (!env || env[RA.TEXT_FLAG] !== 'true') return { send: false, reason: 'text_flag_disabled' };
  const l = lead || {};
  if (!RA.isNbd(l)) return { send: false, reason: 'not_nbd' };       // NBD's number texts NBD's customers only
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
 * The one reminder: due, and on which channel? → { send, channel } | { send: false, reason, final }
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
  if (!RA.isNbd(l)) return { send: false, reason: 'not_nbd', final: true };
  if (l.deleted === true || l.deletedAt) return { send: false, reason: 'deleted', final: true };
  if (l.archived === true) return { send: false, reason: 'archived', final: true };
  if (roles.isLost(l)) return { send: false, reason: 'lost', final: true };
  if (truthy(l.doNotContact) || truthy(l.dnc)) return { send: false, reason: 'do_not_contact', final: true };
  if (openClaim(l)) return { send: false, reason: 'open_claim', final: true };
  if (reviewSeen) return { send: false, reason: 'review_seen', final: true };
  const channel = a.channel === 'text' ? 'text' : 'email';
  if (channel === 'text' && (truthy(l.doNotText) || truthy(l.smsOptOut) || truthy(l.smsOptedOut))) return { send: false, reason: 'do_not_text', final: true };
  return { send: true, channel };
}

// ── The words (fixed templates; nothing a user types reaches a text) ──────
const firstNameOf = (lead) => String((lead && (lead.firstName || lead.name)) || '').trim().split(/\s+/)[0].replace(/[^A-Za-zÀ-ɏ' -]/g, '').slice(0, 40);
const hi = (lead) => { const f = firstNameOf(lead); return f ? 'Hi ' + f : 'Hi'; };

/** The ask text: v1's live words (review-ask-auto-logic.js textBody). */
function textBody(lead, url) { return RA.textBody({ firstName: firstNameOf(lead) }, url); }

function reminderText(lead, url) {
  return hi(lead) + ", it's Joe with No Big Deal Home Solutions with one last note: if you have a minute, a Google review helps your neighbors pick a contractor. "
    + 'If you already left one, thank you. ' + url + ' ' + STOP_LINE;
}

/**
 * Every text is checked before it goes out: one URL and it is a Google review
 * page, the STOP line at the end, one or two segments. → '' when fine, else the reason.
 */
function smsContentOk(body, url) {
  const b = String(body || '');
  if (!b || b.length > SMS_MAX) return 'length';
  if (!isGoogleReviewUrl(url)) return 'link_not_allowed';
  const urls = b.match(/https?:\/\/\S+/gi) || [];
  if (urls.length !== 1 || urls[0] !== url) return 'link_not_allowed';
  if (!b.endsWith(STOP_LINE)) return 'no_stop_line';
  return '';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** The one reminder email (the ask email is v1's emailContent, unchanged). */
function reminderEmail(lead, url) {
  const subject = 'A quick reminder from No Big Deal Home Solutions';
  const lines = [
    'A short follow-up in case my last note got buried. If you have a minute, a Google review helps your neighbors pick a contractor. '
      + 'Honest feedback, whatever it is, is welcome. If you already left one, thank you.',
  ];
  const text = hi(lead) + ',\n\n' + lines[0] + '\n\n' + url + '\n\nThis is the only reminder I will send.\n\nThank you,\nJoe Deal\nNo Big Deal Home Solutions';
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<title>' + esc(subject) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f5f5f5;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;line-height:1.6;">'
    + '<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:28px 24px;">'
    + '<p>' + esc(hi(lead)) + ',</p><p>' + esc(lines[0]) + '</p>'
    + '<p style="text-align:center;margin:22px 0;"><a href="' + esc(url) + '" style="display:inline-block;padding:12px 24px;background:#BD5728;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">Leave a Google review</a></p>'
    + '<p style="font-size:13px;color:#6b7280;">Or paste this link: ' + esc(url) + '</p>'
    + '<p>This is the only reminder I will send.</p>'
    + '<p>Thank you,<br>Joe Deal<br>No Big Deal Home Solutions</p>'
    + '</div></body></html>';
  return { subject, html, text };
}

module.exports = {
  FLAG, REMINDER_DAYS, REMINDER_GRACE_DAYS, PHONE_WINDOW_DAYS, REMINDER_TEMPLATE, DAY_MS, STOP_LINE,
  v2On, isGoogleReviewUrl, reviewUrlFor, openClaim, eligibility, planText, planEmail, reminderPlan,
  textBody, reminderText, smsContentOk, reminderEmail,
};
