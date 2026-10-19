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
const AUTOMATIONS_DOC = 'messaging_controls/automations';
const DEDUPE_COLLECTION = 'messaging_dedupe';
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

function _resetCache() { _cache = null; _ownerCache = null; _autoCache = null; }

function withTimeout(p, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('messaging_controls read timed out')), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const CLOSED = Object.freeze({
  readable: false, exists: false,
  customerSendsEnabled: false, smsEnabled: false, emailEnabled: false, otpEnabled: false, canary: true, legalCopiesEnabled: true,
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
        // Narrow switch for LEGAL/transactional copies (a signed document the signer must receive). Defaults ON; only an explicit false stops them.
        legalCopiesEnabled: d.legalCopiesEnabled !== false,
        // FAIL SAFE: live only when canary is the boolean false. Absent, 'true', 1, null... = canary ON
        // (redirect to the owner, or nothing if no owner contact), so a typo never means live sends.
        canary: d.canary !== false,
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
  delete out.cc; delete out.bcc; delete out.tags;   // tags attribute bounces/unsubscribes to the REAL customer: never on the owner's copy
  delete out.reply_to; delete out.replyTo;
  delete out.headers;   // List-Unsubscribe / one-click carry the REAL customer's token: never on the owner's copy
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
  // A signed copy of a document the signer just executed is a LEGAL/transactional copy, not a campaign:
  // it ignores the customer pause and the canary, and has its own narrow switch (legalCopiesEnabled, default ON).
  if (opts && opts.legal === true) {
    const c = await readControls(db, opts);
    if (c.legalCopiesEnabled !== false) return { send: true, msg, reason: null, canary: false, legal: true };
  }
  const st = await channelStatus(db, 'email', opts);
  if (!st.allowed) return { send: false, msg: null, reason: st.reason, canary: false };
  if (!st.canary) return { send: true, msg, reason: null, canary: false };
  const owner = await readOwnerContact(db, opts);
  const redirected = canaryEmail(owner, msg || {});
  if (!redirected) return { send: false, msg: null, reason: 'canary_no_target', canary: true };
  return { send: true, msg: redirected, reason: null, canary: true };
}

/**
 * Wrap a Resend client so its `emails.send(msg)` passes the kill switch and
 * canary first: `MessagingControls.guardResend(db, resend).emails.send(msg)`.
 * A paused send RESOLVES the way Resend resolves an API rejection
 * ({ data: null, error }), so every caller's existing resendRejected() branch
 * treats it as "not sent" without new control flow. The call site still reads
 * `.emails.send(`, which the SEND_PATHS registry (email-suppression.js) scans.
 */
function guardResend(db, resend, opts) {
  return {
    emails: {
      send: async (msg) => {
        const g = await guardEmail(db, msg, opts);
        if (!g.send) return { data: null, error: { name: 'messaging_paused', message: 'messaging_paused:' + g.reason, statusCode: 403 } };
        const r = await resend.emails.send(g.msg);
        // A canary redirect went to the OWNER, not the customer: flag it so a caller that counts "emailed"
        // (reminders, one-shot stamps) does not treat it as a real send.
        return g.canary && r && typeof r === 'object' ? Object.assign({}, r, { canary: true }) : r;
      },
    },
  };
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

// ── automations: every AUTOMATED customer send needs its own explicit entry ──
//
//   messaging_controls/automations
//     leadAckSms, leadAckEmail, leadFollowupEmail, reviewAskAutoText,
//     reviewAskAutoEmail, missedCallAutotext, stormText, stormNwsText,
//     funnelRecoveryEmail, twilioInbound: boolean — exactly true or OFF
//     maxPerRun: number — most automated customer messages ONE sweep may send
//                (absent = 5; 0 = none). So switching one on can never flood.
//
// An env flag alone is no longer enough (and neither is this doc alone): the
// sender needs BOTH, plus the global channel switch. Absent doc = all OFF.
const AUTOMATION_KEYS = Object.freeze([
  'leadAckSms', 'leadAckEmail', 'leadFollowupEmail', 'reviewAskAutoText', 'reviewAskAutoEmail',
  'missedCallAutotext', 'stormText', 'stormNwsText', 'funnelRecoveryEmail', 'twilioInbound',
  'a2pServerTexts', 'stormConfirmText',
]);
const DEFAULT_MAX_PER_RUN = 5;
/** A backlog item older than this is never sent by an automation (the first sweep after enabling cannot reach back). */
const MAX_AUTOMATION_AGE_DAYS = 7;

const MAX_MAX_PER_RUN = 500;   // hard ceiling on a hand-edited value (the callable only allows 0-50)
let _autoCache = null;

/** Absent -> 5. A present value must be a whole number 0-500; anything else (null, false, 'abc', negative, 3.5, 99) -> 0 (fewer, never more). */
function cleanMaxPerRun(v) {
  if (v === undefined) return DEFAULT_MAX_PER_RUN;
  return Number.isInteger(v) && v >= 0 && v <= MAX_MAX_PER_RUN ? v : 0;
}

async function readAutomations(db, opts) {
  const o = opts || {};
  const nowMs = o.nowMs != null ? o.nowMs : Date.now();
  if (!o.force && _autoCache && nowMs - _autoCache.at < CACHE_MS) return _autoCache.value;
  try {
    const snap = await withTimeout(db.doc(AUTOMATIONS_DOC).get(), o.timeoutMs || READ_TIMEOUT_MS);
    const d = snap && snap.exists ? (snap.data() || {}) : null;
    const flags = {};
    for (const k of AUTOMATION_KEYS) flags[k] = !!d && d[k] === true;
    const value = { readable: true, exists: !!d, flags, maxPerRun: d ? cleanMaxPerRun(d.maxPerRun) : DEFAULT_MAX_PER_RUN };
    _autoCache = { at: nowMs, value };
    return value;
  } catch (e) {
    _autoCache = null;
    const flags = {};
    for (const k of AUTOMATION_KEYS) flags[k] = false;
    return { readable: false, exists: false, flags, maxPerRun: 0, error: (e && e.message) || 'read failed' };
  }
}

/**
 * May this AUTOMATION send to customers at all right now?
 *   envOn: the existing env flag already evaluated by the caller (=== 'true').
 *   channel: 'sms' | 'email'.
 * @returns {Promise<{enabled:boolean, reason:null|string, maxPerRun:number, canary:boolean}>}
 */
async function automationStatus(db, key, channel, envOn, opts) {
  const none = (reason) => ({ enabled: false, reason, maxPerRun: 0, canary: false });
  if (AUTOMATION_KEYS.indexOf(key) === -1) return none('unknown_automation');
  if (envOn !== true) return none('env_flag_off');
  const ch = await channelStatus(db, channel, opts);
  if (!ch.allowed) return none(ch.reason);
  const a = await readAutomations(db, opts);
  if (!a.readable) return none('automations_unreadable');
  if (a.flags[key] !== true) return none('automation_off');
  return { enabled: true, reason: null, maxPerRun: a.maxPerRun, canary: ch.canary };
}

/**
 * integrations/sms.a2pApproved only switches the CRM from "send from my phone"
 * to "send from the server" when the owner ALSO has a2pServerTexts on here and
 * the global SMS switch is open. a2pDoc: the integrations/sms data (or null).
 */
async function a2pServerTextsAllowed(db, a2pDoc, opts) {
  if (!a2pDoc || a2pDoc.a2pApproved !== true) return false;
  return (await automationStatus(db, 'a2pServerTexts', 'sms', true, opts)).enabled;
}

/** true when ms is within MAX_AUTOMATION_AGE_DAYS before nowMs (and not in the future by more than a day). */
function withinAutomationAge(ms, nowMs, days) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return false;
  const age = (nowMs != null ? nowMs : Date.now()) - t;
  return age <= (days || MAX_AUTOMATION_AGE_DAYS) * 86_400_000 && age >= -86_400_000;
}

/**
 * Idempotency per (recipient, template, job): create-once marker. true for the
 * FIRST caller, false for every retry (Firestore create conflict). REJECTS on
 * any other error (caller: do not send — an unverifiable dedupe is not a green light).
 */
async function claimSendOnce(db, recipient, template, jobKey, opts) {
  const crypto = require('crypto');
  // A phone is keyed by its last 10 digits, so '(859) 555-0134' and '+18595550134' are one recipient.
  const digits = String(recipient || '').replace(/\D/g, '');
  const who = digits.length >= 10 ? digits.slice(-10) : (digits || String(recipient || '').toLowerCase());
  const raw = [who, String(template || ''), String(jobKey || '')].join('|');
  const id = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
  const ref = db.collection(DEDUPE_COLLECTION).doc(id);
  try {
    await ref.create({ template: String(template || ''), jobKey: String(jobKey || ''), at: (opts && opts.nowMs) || Date.now() });
    return true;
  } catch (e) {
    if (e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS|already exists/i.test(String(e.message || '')))) return false;
    throw e;
  }
}

/**
 * Wrap a Twilio client so EVERY customer text it creates passes the kill
 * switch and the canary at the moment of sending (defence in depth: the
 * send paths also ask textingStatus earlier, but a flip landing between the
 * early check and the send, or a path nobody remembered, still stops here).
 * A refused send throws an error with status 403 / code 'messaging_paused'
 * (a definite "did not go" for the outbox claim logic). Only messages.create
 * is guarded; messages.list passes through (read-only).
 */
function guardTwilio(db, client, opts) {
  return {
    messages: {
      create: async (msg) => {
        const g = await guardSms(db, msg && msg.to, msg && msg.body, opts);
        if (!g.send) {
          const e = new Error('messaging_paused:' + g.reason);
          e.code = 'messaging_paused';
          e.status = 403;
          e.messagingPaused = true;
          e.reason = g.reason;
          throw e;
        }
        return client.messages.create(Object.assign({}, msg, { to: g.to, body: g.body }));
      },
      list: (...a) => client.messages.list(...a),
    },
  };
}

// ── internal alerts to Jo: own switch, rate-limited ──────────────────────

const INTERNAL_LIMITS = Object.freeze({ sms: 'INTERNAL_SMS_PER_HOUR', email: 'INTERNAL_EMAIL_PER_HOUR' });
const INTERNAL_DEFAULTS = Object.freeze({ sms: 30, email: 120 });
const DEFAULT_PER_SOURCE = 3;   // alerts one source (address) may cause per hour inside a bucket

/** One alert "source": an IPv4 address as is, an IPv6 address collapsed to its /64. */
function sourceKey(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'unknown') return '';
  if (s.indexOf(':') === -1) return s;
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/.test(s)) return s.slice(7);
  const halves = s.split('::');
  if (halves.length > 2) return s;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? new Array(Math.max(0, 8 - head.length - tail.length)).fill('0') : [];
  const groups = head.concat(fill, tail).map((g) => g.replace(/^0+(?=.)/, ''));
  return groups.slice(0, 4).join(':') + '::/64';
}

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
  // opts.bucket gives a source its own allowance: a flood of fake public-form leads ('lead') cannot use up the
  // hour's cap for storm or call alerts (and the reverse).
  const bucket = o.bucket ? '_' + String(o.bucket).replace(/[^a-z0-9]/gi, '').slice(0, 12) : '';
  const ref = db.doc(COUNTER_COLLECTION + '/internal_' + channel + bucket + '_' + hour);
  try {
    // Cap by DISTINCT subject (a lead id), not by attempts, in ONE transaction: a repeat of an alert that was
    // already let through this hour is free (a retry / watchdog re-send cannot eat the allowance), while a lead
    // that was DENIED by the cap leaves no marker, so its retry is denied again (the flood cap holds).
    const seenRef = o.key
      ? db.doc(COUNTER_COLLECTION + '/seen_' + channel + bucket + '_' + hour + '_' + require('crypto').createHash('sha256').update(String(o.key)).digest('hex').slice(0, 24))
      : null;
    // Per-SOURCE pre-cap (opts.source, e.g. the submitter's address): one source can take only a few slots of the
    // bucket per hour, so a flood from one address cannot use up the allowance that real leads from other
    // addresses need. A source-limited alert does NOT spend the bucket count.
    //  - An IPv6 address is collapsed to its /64 (one household / one attacker's whole range is ONE source).
    //  - The first alert from a source may use the whole bucket; a source's 2nd+ alert only while the bucket is
    //    under two-thirds full, so a real lead from a new source always finds headroom behind a many-address flood.
    //  - INTERNAL_PER_SOURCE_PER_HOUR=0 DISABLES the per-source cap (it never blocks every sourced alert).
    const skey = o.source ? sourceKey(o.source) : '';
    const srcCap = skey ? envCap(process.env.INTERNAL_PER_SOURCE_PER_HOUR, DEFAULT_PER_SOURCE) : 0;
    const srcOn = !!skey && srcCap > 0;
    const srcRef = srcOn
      ? db.doc(COUNTER_COLLECTION + '/src_' + channel + bucket + '_' + hour + '_' + require('crypto').createHash('sha256').update(skey).digest('hex').slice(0, 24))
      : null;
    const allowed = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const seen = seenRef ? await tx.get(seenRef) : null;
      const srcSnap = srcRef ? await tx.get(srcRef) : null;
      if (seen && seen.exists) return 'ok';
      const sn = srcSnap && srcSnap.exists ? Number((srcSnap.data() || {}).count) || 0 : 0;
      const n = snap.exists ? Number((snap.data() || {}).count) || 0 : 0;
      if (srcRef && sn >= srcCap) return 'source';
      if (srcRef && sn >= 1 && n >= Math.floor(cap * 2 / 3)) return 'source';
      if (n >= cap) return 'rate';
      if (srcRef) tx.set(srcRef, { count: sn + 1, channel, hour, updatedAtMs: nowMs, expireAt: new Date(nowMs + 3 * 3600_000) }, { merge: true });
      tx.set(ref, { count: n + 1, channel, hour, updatedAtMs: nowMs, expireAt: new Date(nowMs + 3 * 3600_000) }, { merge: true });
      if (seenRef) tx.set(seenRef, { at: nowMs, channel, hour, expireAt: new Date(nowMs + 3 * 3600_000) });
      return 'ok';
    });
    // A distinct reason keeps a source-limited alert visible (alert_outbox 'skipped:internal_source_limited').
    if (allowed === 'source') return Object.assign({ allowed: false, reason: 'internal_source_limited' }, base);
    if (allowed !== 'ok') return Object.assign({ allowed: false, reason: 'internal_rate_limited' }, base);
  } catch (_) { /* counter unreadable: allow */ }
  return Object.assign({ allowed: true, reason: null }, base);
}

module.exports = {
  GLOBAL_DOC, INTERNAL_DOC, AUDIT_COLLECTION, COUNTER_COLLECTION,
  CACHE_MS, READ_TIMEOUT_MS, CHANNELS, REFUSAL,
  readControls, channelStatus, readOwnerContact,
  cleanMaxPerRun, canarySms, canaryEmail, guardEmail, guardSms, guardTwilio, guardResend,
  internalAlertStatus, sourceKey,
  AUTOMATIONS_DOC, DEDUPE_COLLECTION, AUTOMATION_KEYS, DEFAULT_MAX_PER_RUN, MAX_AUTOMATION_AGE_DAYS,
  readAutomations, automationStatus, a2pServerTextsAllowed, withinAutomationAge, claimSendOnce,
  normPhone, normEmail,
  _resetCache,
};
