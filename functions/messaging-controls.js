/**
 * functions/messaging-controls.js — the ONE kill switch for every customer-facing send
 * ═══════════════════════════════════════════════════════════════════════════
 * (Twilio A2P went Verified 2026-10-19: SMS really delivers now, so "nothing is
 * sent by surprise" has to be a property of the code, not of a pile of flags.)
 *
 *   messaging_controls/global
 *     customerSendsEnabled: boolean  — master. Anything but exactly true = NO customer send.
 *     smsEnabled:           boolean  — customer SMS / MMS (and Bland SMS to a customer).
 *     emailEnabled:         boolean  — customer email.
 *     otpEnabled:           boolean  — verification codes to a phone a visitor typed.
 *     canary:               boolean  — when true every customer SMS / email is
 *                                      REDIRECTED to the owner (never to the customer).
 *
 * FAIL CLOSED: a missing doc, an unreadable doc (error / timeout), or any field
 * that is not exactly `true` means customer sends are OFF. The only things that
 * keep working are INTERNAL alerts to Jo, which have their own switch:
 *
 *   messaging_controls/internal
 *     ownerPhone, ownerEmail:  where internal alerts and canary copies go (config,
 *                              never a constant in a public repo; env
 *                              OWNER_ALERT_PHONE / OWNER_ALERT_EMAIL are a fallback)
 *     internalAlertsEnabled:   boolean, absent = ON (Jo asked to keep his alerts)
 *     rate-limited per hour (INTERNAL_*_PER_HOUR) so a flood of leads cannot
 *     turn his phone into a siren or run up the bill.
 *
 * Both docs are admin-SDK only (firestore.rules). The ONLY writer is the
 * manageMessagingControls callable (messaging-controls-fns.js), which logs
 * every flip to messaging_controls_audit.
 *
 * Reuse, not a fork: sms-texting-gate.js textingStatus() calls
 * channelStatus(db, 'sms') so every existing SMS sender is covered by the same
 * call it already makes; email senders call guardEmail().
 */
'use strict';

const { envCap } = require('./env-number');

const GLOBAL_DOC = 'messaging_controls/global';
const INTERNAL_DOC = 'messaging_controls/internal';
const AUDIT_COLLECTION = 'messaging_controls_audit';
const COUNTER_COLLECTION = 'messaging_controls_counters';

/** Short cache: a flip takes effect within this long, and a busy cron does not read the doc per text. */
const CACHE_MS = 10_000;
const READ_TIMEOUT_MS = 4_000;

const CHANNELS = Object.freeze({ sms: 'smsEnabled', mms: 'smsEnabled', bland_sms: 'smsEnabled', email: 'emailEnabled', otp: 'otpEnabled' });

const REFUSAL = Object.freeze({
  controls_unreadable: 'Customer messaging could not be verified, so nothing was sent.',
  controls_missing: 'Customer messaging is paused (no messaging controls are set). Nothing was sent.',
  customer_sends_off: 'Customer messaging is paused by the owner. Nothing was sent.',
  channel_off: 'This kind of customer message is paused by the owner. Nothing was sent.',
  canary_no_target: 'Test mode (canary) is on but no owner phone or email is configured. Nothing was sent.',
});

let _cache = null;       // { at, controls }
let _ownerCache = null;  // { at, owner }

function _resetCache() { _cache = null; _ownerCache = null; }

function withTimeout(p, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('messaging_controls read timed out')), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const CLOSED = Object.freeze({
  readable: false, exists: false,
  customerSendsEnabled: false, smsEnabled: false, emailEnabled: false, otpEnabled: false, canary: false,
});

/**
 * Read messaging_controls/global. NEVER rejects: an unreadable doc answers the
 * all-off shape with readable:false. Only a successful read is cached.
 */
async function readControls(db, opts) {
  const o = opts || {};
  const nowMs = o.nowMs != null ? o.nowMs : Date.now();
  if (!o.force && _cache && nowMs - _cache.at < CACHE_MS) return _cache.controls;
  try {
    const snap = await withTimeout(db.doc(GLOBAL_DOC).get(), o.timeoutMs || READ_TIMEOUT_MS);
    const d = snap && snap.exists ? (snap.data() || {}) : null;
    const controls = d
      ? {
        readable: true, exists: true,
        customerSendsEnabled: d.customerSendsEnabled === true,
        smsEnabled: d.smsEnabled === true,
        emailEnabled: d.emailEnabled === true,
        otpEnabled: d.otpEnabled === true,
        canary: d.canary === true,
      }
      : Object.assign({}, CLOSED, { readable: true, exists: false });
    _cache = { at: nowMs, controls };
    return controls;
  } catch (e) {
    _cache = null;
    return Object.assign({}, CLOSED, { error: (e && e.message) || 'read failed' });
  }
}

/**
 * May a customer-facing `channel` message go out right now?
 * @returns {Promise<{allowed:boolean, reason:null|string, canary:boolean, message:string|null}>}
 */
async function channelStatus(db, channel, opts) {
  const field = CHANNELS[channel];
  if (!field) return { allowed: false, reason: 'channel_off', canary: false, message: REFUSAL.channel_off };
  const c = await readControls(db, opts);
  let reason = null;
  if (!c.readable) reason = 'controls_unreadable';
  else if (!c.exists) reason = 'controls_missing';
  else if (c.customerSendsEnabled !== true) reason = 'customer_sends_off';
  else if (c[field] !== true) reason = 'channel_off';
  return { allowed: !reason, reason, canary: !reason && c.canary === true, message: reason ? REFUSAL[reason] : null };
}

// ── owner contact (internal alerts + canary target) ──────────────────────

function normPhone(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '';
}
function normEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s) ? s : '';
}

/** @returns {Promise<{phone:string, email:string, internalAlertsEnabled:boolean, readable:boolean}>} */
async function readOwnerContact(db, opts) {
  const o = opts || {};
  const nowMs = o.nowMs != null ? o.nowMs : Date.now();
  if (!o.force && _ownerCache && nowMs - _ownerCache.at < CACHE_MS) return _ownerCache.owner;
  let d = {};
  let readable = true;
  try {
    const snap = await withTimeout(db.doc(INTERNAL_DOC).get(), o.timeoutMs || READ_TIMEOUT_MS);
    d = snap && snap.exists ? (snap.data() || {}) : {};
  } catch (e) {
    readable = false;
  }
  const owner = {
    readable,
    phone: normPhone(d.ownerPhone) || normPhone(process.env.OWNER_ALERT_PHONE),
    email: normEmail(d.ownerEmail) || normEmail(process.env.OWNER_ALERT_EMAIL),
    // Internal alerts stay ON unless the owner turns them off (absent = on).
    internalAlertsEnabled: d.internalAlertsEnabled !== false,
  };
  if (readable) _ownerCache = { at: nowMs, owner };
  return owner;
}

// ── canary: redirect, never reach a customer ─────────────────────────────

/** SMS: { to, body } -> the owner's number with the original recipient in the body. */
function canarySms(owner, to, body) {
  if (!owner || !owner.phone) return null;
  return { to: owner.phone, body: ('[would send to ' + String(to || 'unknown') + '] ' + String(body || '')).slice(0, 1600) };
}

function _list(v) { return Array.isArray(v) ? v.join(', ') : String(v || ''); }
function _escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Email: a Resend message -> a copy addressed ONLY to the owner, original recipients shown. */
function canaryEmail(owner, msg) {
  if (!owner || !owner.email) return null;
  const was = _list(msg.to) + (msg.cc ? ' (cc ' + _list(msg.cc) + ')' : '') + (msg.bcc ? ' (bcc ' + _list(msg.bcc) + ')' : '');
  const banner = '[would send to ' + was + ']';
  const out = Object.assign({}, msg, { to: [owner.email], subject: '[CANARY] ' + String(msg.subject || '') });
  delete out.cc; delete out.bcc;
  delete out.reply_to; delete out.replyTo;
  if (typeof msg.html === 'string' && msg.html) {
    out.html = '<p style="font:14px monospace;background:#fff3cd;padding:8px;margin:0 0 12px">' + _escHtml(banner) + '</p>' + msg.html;
  }
  out.text = banner + '\n\n' + (typeof msg.text === 'string' ? msg.text : '');
  return out;
}

/**
 * The email choke point. Every customer-facing Resend send runs its message
 * through this first.
 * @returns {Promise<{send:boolean, msg:object|null, reason:string|null, canary:boolean}>}
 */
async function guardEmail(db, msg, opts) {
  const st = await channelStatus(db, 'email', opts);
  if (!st.allowed) return { send: false, msg: null, reason: st.reason, canary: false };
  if (!st.canary) return { send: true, msg, reason: null, canary: false };
  const owner = await readOwnerContact(db, opts);
  const redirected = canaryEmail(owner, msg || {});
  if (!redirected) return { send: false, msg: null, reason: 'canary_no_target', canary: true };
  return { send: true, msg: redirected, reason: null, canary: true };
}

/**
 * The SMS choke point for a message about to go to a customer.
 * @returns {Promise<{send:boolean, to:string, body:string, reason:string|null, canary:boolean}>}
 */
async function guardSms(db, to, body, opts) {
  const st = await channelStatus(db, 'sms', opts);
  if (!st.allowed) return { send: false, to, body, reason: st.reason, canary: false };
  if (!st.canary) return { send: true, to, body, reason: null, canary: false };
  const owner = await readOwnerContact(db, opts);
  const r = canarySms(owner, to, body);
  if (!r) return { send: false, to, body, reason: 'canary_no_target', canary: true };
  return { send: true, to: r.to, body: r.body, reason: null, canary: true };
}

// ── internal alerts to Jo: own switch, rate-limited ──────────────────────

const INTERNAL_LIMITS = Object.freeze({ sms: 'INTERNAL_SMS_PER_HOUR', email: 'INTERNAL_EMAIL_PER_HOUR' });
const INTERNAL_DEFAULTS = Object.freeze({ sms: 30, email: 120 });

/**
 * May an internal alert to the owner go out? Never touches the customer
 * switch. Own switch (absent = on) and an hourly cap (a counter read/write
 * error ALLOWS the alert: losing a lead alert is worse than one extra text).
 * @returns {Promise<{allowed:boolean, reason:string|null, phone:string, email:string}>}
 */
async function internalAlertStatus(db, channel, opts) {
  const o = opts || {};
  const owner = await readOwnerContact(db, o);
  const base = { phone: owner.phone, email: owner.email };
  if (!owner.internalAlertsEnabled) return Object.assign({ allowed: false, reason: 'internal_alerts_off' }, base);
  if (channel === 'sms' && !owner.phone) return Object.assign({ allowed: false, reason: 'owner_phone_not_configured' }, base);
  if (channel === 'email' && !owner.email) return Object.assign({ allowed: false, reason: 'owner_email_not_configured' }, base);
  const envName = INTERNAL_LIMITS[channel];
  if (!envName) return Object.assign({ allowed: true, reason: null }, base);
  const cap = envCap(process.env[envName], INTERNAL_DEFAULTS[channel]);
  if (cap === 0) return Object.assign({ allowed: false, reason: 'internal_rate_limited' }, base);
  const nowMs = o.nowMs != null ? o.nowMs : Date.now();
  const hour = new Date(nowMs).toISOString().slice(0, 13).replace(/[-T]/g, '');
  const ref = db.doc(COUNTER_COLLECTION + '/internal_' + channel + '_' + hour);
  try {
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const n = snap.exists ? Number((snap.data() || {}).count) || 0 : 0;
      if (n >= cap) return false;
      tx.set(ref, { count: n + 1, channel, hour, updatedAtMs: nowMs }, { merge: true });
      return true;
    });
    if (!allowed) return Object.assign({ allowed: false, reason: 'internal_rate_limited' }, base);
  } catch (_) { /* counter unreadable: allow */ }
  return Object.assign({ allowed: true, reason: null }, base);
}

module.exports = {
  GLOBAL_DOC, INTERNAL_DOC, AUDIT_COLLECTION, COUNTER_COLLECTION,
  CACHE_MS, READ_TIMEOUT_MS, CHANNELS, REFUSAL,
  readControls, channelStatus, readOwnerContact,
  canarySms, canaryEmail, guardEmail, guardSms,
  internalAlertStatus,
  normPhone, normEmail,
  _resetCache,
};
