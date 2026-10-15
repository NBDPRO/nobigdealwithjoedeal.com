'use strict';
/**
 * missed-call-reply-logic.js — speed-to-lead on a missed call (2026-10-15).
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Jo is on a roof when the phone rings. Two answers, both pure here:
 *
 *   1. THE DRAFT (live now). Every missed inbound call (the Call Center's own
 *      rule, call-watch-logic.js isMissedCall: an inbound, non-text call under
 *      15 seconds) gets a ready-to-send reply: `replyDraft` on the
 *      phone_calls doc = { body, smsHref, createdAtMs, kind: 'manual' }.
 *      smsHref is an `sms:` deep link with the body prefilled, so Jo sends it
 *      from HIS OWN phone in one tap: from the missed-call bell row, the
 *      callWatch push ("Text back" button) and the Call Center card. Nothing
 *      is sent by the server on this path. A personal text Jo types and sends
 *      himself needs no STOP line.
 *
 *   2. THE AUTO-TEXT (dark until Twilio A2P is approved).
 *      MISSED_CALL_AUTOTEXT_ENABLED — anything but the literal 'true' is off.
 *      planAutoText() is the pre-flight; missed-call-autotext.js adds the
 *      checks that need a read (STOP register + Do Not Text list, the
 *      company's texting switch, one auto-text per number per 24 h) and
 *      sends from the registered Twilio number. It ONLY ever texts a caller
 *      who is a customer on file with a stored web-form consent record
 *      (tcpaConsent === true AND a consent version id the public forms stamp,
 *      tcpa-consent.js CONSENT_TEXTS) — never a cold caller, never a number
 *      someone typed into the CRM by hand — inside 8am-9pm in the
 *      homeowner's local time (sms-send-window.js), and only for a call that
 *      is still fresh (a backfilled call from last week is not a missed call
 *      worth texting about).
 */

const C = require('./tcpa-consent');
const SendWindow = require('./sms-send-window');

// Kept GSM-7 (no em dash, no curly quotes) so each body is ONE segment.
// tests/missed-call-reply-2026-10-15.test.js pins both under 160 characters.
const REPLY_BODY = "Hi, it's Joe with No Big Deal Home Solutions. Sorry I missed your call, I'm on a roof. "
  + 'What can I help with? Free inspection: nobigdealwithjoedeal.com/inspect';
// The automated text goes from the A2P number, so it carries the opt-out.
const AUTO_BODY = "Hi, it's Joe with No Big Deal Home Solutions. Sorry I missed your call, I'm on a roof. "
  + 'What can I help with? Reply STOP to opt out.';

const FLAG = 'MISSED_CALL_AUTOTEXT_ENABLED';
const HOUR = 3600000;
const AUTOTEXT_FRESH_MS = 3 * HOUR;       // ingest runs every 30 min; Cube ACR uploads lag
const AUTOTEXT_COOLDOWN_MS = 24 * HOUR;   // one auto-text per number per 24 h

/** Mirror of call-watch-logic.js isMissedCall (that module requires this one's callers). */
const isMissedCall = (c) => !!c && c.channel !== 'text' && c.status === 'short' && c.direction === 'inbound';

const digits10 = (v) => {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 10) return d;
  if (d.length === 11 && d[0] === '1') return d.slice(1);
  return '';
};

/** sms:+1XXXXXXXXXX?body=… ('' when the number is not a 10-digit US number). */
function smsHref(phone, body) {
  const d = digits10(phone);
  if (!d) return '';
  return 'sms:+1' + d + '?body=' + encodeURIComponent(String(body == null ? REPLY_BODY : body));
}

// What a page may put in an href: our own shape only, nothing else
// (encodeURIComponent never emits a quote, angle bracket or space).
const SMS_HREF_RE = /^sms:\+1[0-9]{10}\?body=[A-Za-z0-9%._~!*'()-]{1,600}$/;
const isSafeSmsHref = (h) => typeof h === 'string' && SMS_HREF_RE.test(h);

/** The reply draft for a call doc, or null when it is not a missed call with a number. */
function replyDraftFor(call, nowMs) {
  if (!isMissedCall(call)) return null;
  const href = smsHref(call.phoneDigits, REPLY_BODY);
  if (!href) return null;
  return { kind: 'manual', body: REPLY_BODY, smsHref: href, createdAtMs: Number(nowMs) || Date.now() };
}

/** The draft's link, when a stored doc carries a valid one. */
function draftHref(call) {
  const d = call && call.replyDraft;
  return d && isSafeSmsHref(d.smsHref) ? d.smsHref : '';
}

const flagOn = (v) => v === true || (typeof v === 'string' && /^(true|yes|y|1|on)$/i.test(v.trim()));

/** A consent record a PUBLIC FORM wrote (lead-bridge copies tcpaConsentText from the form). */
function webFormConsent(lead) {
  if (!C.hasWrittenConsent(lead)) return false;
  const v = lead.tcpaConsentText;
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(C.CONSENT_TEXTS, v);
}

/**
 * The pre-flight for an automatic text. Pure.
 * → { send: true, to, body } | { send: false, reason }
 * reason ∈ flag_disabled | not_missed | stale | no_number | no_lead | deleted |
 *          number_mismatch | no_consent | do_not_contact | quiet_hours
 */
function planAutoText({ env, call, lead, nowMs }) {
  const e = env || {};
  if (e[FLAG] !== 'true') return { send: false, reason: 'flag_disabled' };
  if (!isMissedCall(call)) return { send: false, reason: 'not_missed' };
  const t = Number(nowMs) || Date.now();
  const at = Number(call.startedAtMs) || 0;
  if (!at || at < t - AUTOTEXT_FRESH_MS || at > t + 5 * 60000) return { send: false, reason: 'stale' };
  const d = digits10(call.phoneDigits);
  if (!d) return { send: false, reason: 'no_number' };
  if (!call.leadId || !lead) return { send: false, reason: 'no_lead' };
  if (lead.deleted === true || lead.deletedAt) return { send: false, reason: 'deleted' };
  // The consent is the LEAD's; it covers the number that lead gave us.
  const leadNums = [lead.phone, lead.phoneNumber, lead.altPhone, lead.phoneDigits].map(digits10).filter(Boolean);
  if (leadNums.indexOf(d) === -1) return { send: false, reason: 'number_mismatch' };
  if (!webFormConsent(lead)) return { send: false, reason: 'no_consent' };
  if (flagOn(lead.doNotContact) || flagOn(lead.dnc) || flagOn(lead.doNotText) || flagOn(lead.smsOptOut)) {
    return { send: false, reason: 'do_not_contact' };
  }
  if (!SendWindow.withinRecipientWindow(t, lead)) return { send: false, reason: 'quiet_hours' };
  return { send: true, to: '+1' + d, body: AUTO_BODY };
}

/** One auto-text per number per 24 h: may this number be texted, given its last stamp? */
function cooldownClear(lastSentAtMs, nowMs) {
  const last = Number(lastSentAtMs) || 0;
  return !last || (Number(nowMs) || Date.now()) - last >= AUTOTEXT_COOLDOWN_MS;
}

/** missed_call_autotext/{tenant}__{digits10} — the 24 h claim doc. */
function claimId(tenantKey, phone) {
  const t = String(tenantKey || '').replace(/[^A-Za-z0-9_-]/g, '');
  const d = digits10(phone);
  return t && d ? t + '__' + d : '';
}

module.exports = {
  FLAG, REPLY_BODY, AUTO_BODY, AUTOTEXT_FRESH_MS, AUTOTEXT_COOLDOWN_MS,
  isMissedCall, digits10, smsHref, isSafeSmsHref, replyDraftFor, draftHref,
  webFormConsent, planAutoText, cooldownClear, claimId,
};
