'use strict';
/**
 * owner-notify.js — the ONE "tell the platform owner" path for system
 * failures (2026-11-22 move out of lead-alert-watchdog.js; 2026-11-25 roadmap
 * step 13, audit BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22 §2.8 / §3.7 / §3.9).
 *
 *   notifyOwner(db, { title, body, severity, key })
 *     severity 'info'     -> bell entry + push (as before)
 *     severity 'alert'    -> the same, plus ONE short text to the owner's phone
 *     severity 'critical' -> the same as alert, but texted at any hour
 *
 * The text (Joe, 2026-11-25: "a few a day max"):
 *  - goes through the internal-alert guard (MessagingControls
 *    internalAlertStatus: the owner's own switch, the owner phone from the
 *    messaging controls config, an hourly cap). The customer kill switch and
 *    the canary are for customer sends and do not hold this text; the owner's
 *    internal-alert switch does. No phone configured = bell only, logged.
 *  - at most OWNER_ALERT_SMS_PER_DAY texts per ET day (default 4); the same
 *    key is texted once a day. Over the cap: bell only, plus ONE "more alerts
 *    in the app" text.
 *  - quiet hours are cron-deadman.js's (07:00-21:00 ET at once): an 'alert'
 *    outside them is queued and flushOwnerQueue() sends ONE summary text on
 *    its first call at or after 07:00 (cronDeadman calls it every run, dry
 *    run included). 'critical' (a dead call / text pipeline) is texted at any
 *    hour. A queue entry lives QUEUE_TTL_MS: a flush that could not send
 *    never silences a key for good, and in the daytime a queued key is texted
 *    at once (and leaves the queue) instead of counting as a duplicate.
 *  - order: the owner's switch / phone and the Twilio config are checked
 *    first (a held text books nothing), then the day ledger, and only a text
 *    that will really go spends the hourly internal allowance.
 *  - bookkeeping on system/ownerNotify. A failed bookkeeping read texts only
 *    a critical alert (fewer texts, never a flood).
 *
 * The bell row and the push behave as before: the bell write rejects, a push
 * failure resolves { pushed: false }. A text failure never rejects.
 * Internal only: never a customer.
 */
const { logger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');
const LA = require('./lead-alert')._internal;
const MessagingControls = require('./messaging-controls');
const { envCap } = require('./env-number');

const STATE_DOC = 'system/ownerNotify';
const DEFAULT_SMS_PER_DAY = 4;
const SEVERITIES = ['info', 'alert', 'critical'];
const MAX_QUEUE = 20;
const MAX_KEYS = 200;
/** An overnight entry no flush could send is dropped after this long. */
const QUEUE_TTL_MS = 24 * 3600000;

/** The Twilio secrets a function that may text the owner must declare. */
const SMS_SECRETS = (LA.SECRETS || []).filter((s) => /^TWILIO_/.test(String(s && s.name)));

/** Test seams: twilio(sid, token) -> client, logger. */
const _overrides = {};
const log = () => _overrides.logger || logger;
const secretVal = (n) => { const v = String(process.env[n] || '').trim(); return v && v !== '__unset__' ? v : ''; };
const smsPerDay = () => envCap(process.env.OWNER_ALERT_SMS_PER_DAY, DEFAULT_SMS_PER_DAY);
const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
/** cron-deadman.js owns the daytime window (lazy: it requires this module from its handler). */
const isDaytime = (ms) => require('./cron-deadman').isDaytime(ms);
/** Plain, short text: no emoji (a text with one costs 2-3x the segments). */
const plain = (s) => String(s == null ? '' : s).replace(/[^\x20-\x7E\n]/g, '').replace(/\s+/g, ' ').trim();

// ── the pure day ledger ─────────────────────────────────────────────────────

function roll(state, nowMs) {
  const s = state && typeof state === 'object' ? state : {};
  const ymd = etYmd(nowMs);
  const queue = (Array.isArray(s.queue) ? s.queue.slice(0, MAX_QUEUE) : [])
    .filter((q) => q && Number(q.atMs) > nowMs - QUEUE_TTL_MS);
  if (s.ymd !== ymd) return { ymd, sent: 0, keys: [], overflowSent: false, queue };
  return { ymd, sent: Number(s.sent) || 0, keys: Array.isArray(s.keys) ? s.keys.slice(-MAX_KEYS) : [], overflowSent: s.overflowSent === true, queue };
}

/** Spend one text of today's allowance: 'send', then one 'overflow', then 'capped'. */
function spend(s, cap) {
  if (cap <= 0) return 'capped';
  if (s.sent < cap) { s.sent++; return 'send'; }
  if (!s.overflowSent) { s.overflowSent = true; s.sent++; return 'overflow'; }
  return 'capped';
}

/** One alert: { state, action: 'send' | 'overflow' | 'capped' | 'dup' | 'queued' }. */
function decide(state, req, nowMs, cap, daytime) {
  const s = roll(state, nowMs);
  if (s.keys.includes(req.key)) return { state: s, action: 'dup' };
  const qi = s.queue.findIndex((q) => q.key === req.key);
  if (req.severity !== 'critical' && !daytime) {
    if (qi >= 0) return { state: s, action: 'dup' };
    s.queue.push({ key: req.key, title: plain(req.title).slice(0, 80), atMs: nowMs });
    s.queue = s.queue.slice(-MAX_QUEUE);
    return { state: s, action: 'queued' };
  }
  // Texted now, so the morning summary must not repeat it.
  if (qi >= 0) s.queue.splice(qi, 1);
  s.keys.push(req.key);
  s.keys = s.keys.slice(-MAX_KEYS);
  return { state: s, action: spend(s, cap) };
}

/** The morning flush: { state, action: 'none' | 'summary' | 'overflow' | 'capped', items }. */
function decideFlush(state, nowMs, cap, daytime) {
  const s = roll(state, nowMs);
  if (!daytime || !s.queue.length) return { state: s, action: 'none', items: [] };
  const items = s.queue;
  s.queue = [];
  for (const q of items) if (!s.keys.includes(q.key)) s.keys.push(q.key);
  s.keys = s.keys.slice(-MAX_KEYS);
  const a = spend(s, cap);
  return { state: s, action: a === 'send' ? 'summary' : a, items };
}

function smsText(kind, ctx) {
  const tail = ' Details in the CRM bell.';
  if (kind === 'overflow') return 'More system alerts today (texts are capped at ' + ctx.cap + ' a day). Open the CRM bell for the details.';
  if (kind === 'summary') {
    const n = ctx.items.length;
    return ('Overnight: ' + n + ' system alert' + (n === 1 ? '' : 's') + ': ' + ctx.items.map((q) => q.title).join('; ')).slice(0, 220) + '.' + tail;
  }
  const first = plain(require('./integrations/heartbeat').redactText(String(ctx.body || '').split('\n')[0]));
  const head = (ctx.severity === 'critical' ? 'URGENT: ' : 'Alert: ') + plain(ctx.title);
  return (head + (first ? ' - ' + first : '')).slice(0, 200) + tail;
}

// ── sending ─────────────────────────────────────────────────────────────────

/** Before the ledger, nothing spent: null when a text could go, else a 'skipped:<reason>' string. */
async function preflight(db, key, nowMs) {
  const owner = await MessagingControls.readOwnerContact(db, { nowMs });
  const reason = !owner.internalAlertsEnabled ? 'internal_alerts_off' : (!owner.phone ? 'owner_phone_not_configured' : null);
  if (reason) {
    log().warn('[ownerNotify] text held, bell only', { key, reason });
    return 'skipped:' + reason;
  }
  if (!secretVal('TWILIO_ACCOUNT_SID') || !secretVal('TWILIO_AUTH_TOKEN') || !secretVal('TWILIO_PHONE_NUMBER')) {
    log().warn('[ownerNotify] Twilio not configured for this function, bell only', { key });
    return 'skipped:twilio_not_configured';
  }
  return null;
}

/** The full guard (spends the hourly internal allowance): { ok, to } or a 'skipped:<reason>' string. */
async function smsTarget(db, key, nowMs) {
  const ia = await MessagingControls.internalAlertStatus(db, 'sms', { key: 'owner-notify/' + key, bucket: 'ops', nowMs });
  if (!ia.allowed) {
    log().warn('[ownerNotify] text held, bell only', { key, reason: ia.reason });
    return 'skipped:' + ia.reason;
  }
  return { ok: true, to: ia.phone };
}

async function twilioSend(to, body) {
  const make = _overrides.twilio || ((sid, tok) => require('twilio')(sid, tok));
  const client = make(secretVal('TWILIO_ACCOUNT_SID'), secretVal('TWILIO_AUTH_TOKEN'));
  // Internal alert to the platform owner (internalAlertStatus above), never a customer.
  const m = await client.messages.create({ to, from: secretVal('TWILIO_PHONE_NUMBER'), body });
  return (m && m.sid) || null;
}

/** Run one ledger transaction; null when the ledger cannot be read or written. */
async function ledger(db, fn) {
  try {
    const ref = db.doc(STATE_DOC);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const r = fn(snap && snap.exists ? (snap.data() || {}) : {});
      tx.set(ref, r.state);
      return r;
    });
  } catch (e) {
    log().warn('[ownerNotify] text ledger unavailable', { err: e && e.message });
    return null;
  }
}

async function textOwner(db, req, nowMs) {
  const held = await preflight(db, req.key, nowMs);
  if (held) return held;
  const cap = smsPerDay();
  const daytime = isDaytime(nowMs);
  const r = await ledger(db, (st) => decide(st, req, nowMs, cap, daytime));
  const action = r ? r.action : (req.severity === 'critical' ? 'send' : 'failed:ledger');
  if (action !== 'send' && action !== 'overflow') return action;
  const target = await smsTarget(db, req.key, nowMs);
  if (typeof target === 'string') return target;
  try {
    await twilioSend(target.to, smsText(action, Object.assign({ cap }, req)));
    return action === 'send' ? 'sent' : 'sent_overflow';
  } catch (e) {
    log().error('[ownerNotify] text failed', { key: req.key, err: String(e && e.message || e).slice(0, 200) });
    return 'failed:send';
  }
}

/**
 * msg: { title, body, severity, key, type?, clickUrl?, idPrefix?, nowMs? }.
 * Resolves { pushed, sms } — sms: 'none' (info), 'sent', 'sent_overflow',
 * 'queued', 'dup', 'capped', 'skipped:<reason>' or 'failed:<step>'.
 */
async function notifyOwner(db, msg) {
  const m = msg || {};
  const title = String(m.title || '');
  const body = String(m.body == null ? '' : m.body);
  const severity = SEVERITIES.includes(m.severity) ? m.severity : 'info';
  const key = String(m.key || title).slice(0, 200);
  const nowMs = Number.isFinite(m.nowMs) ? m.nowMs : Date.now();
  const type = m.type || 'call_watch';
  const clickUrl = m.clickUrl || '/pro/dashboard.html#/calls';
  await db.collection('notifications').add({
    userId: LA.NBD_OWNER_UID, type, title, message: body, priority: 'high', severity,
    clickUrl, read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
  });
  // The bell row is written either way; the caller learns whether a device
  // got the push (no token, FCM down) so it can fail its own run.
  let pushed = false;
  try {
    const r = await require('./push-functions').sendCustomNotification(LA.NBD_OWNER_UID, title, body.slice(0, 180), { type, clickUrl, notificationId: (m.idPrefix || 'pipeline-deadman-') + nowMs });
    pushed = !!(r && r.sent > 0);
  } catch (e) {
    log().warn('[ownerNotify] push failed', { err: e && e.message });
  }
  let sms = 'none';
  if (severity !== 'info') {
    try { sms = await textOwner(db, { title, body, severity, key }, nowMs); }
    catch (e) { sms = 'failed:guard'; log().error('[ownerNotify] text step failed', { key, err: e && e.message }); }
    log().info('[ownerNotify] text', { key, severity, sms });
  }
  return { pushed, sms };
}

/** ONE summary text of the alerts queued overnight, on the first call at or after 07:00 ET. */
async function flushOwnerQueue(db, opts) {
  const nowMs = opts && Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const daytime = isDaytime(nowMs);
  if (!daytime) return { sms: 'none' };
  const cap = smsPerDay();
  // Peek first: no guard read, no ledger write on the usual empty morning.
  try {
    const snap = await db.doc(STATE_DOC).get();
    const q = snap && snap.exists ? ((snap.data() || {}).queue || []) : [];
    if (!q.some((e) => e && Number(e.atMs) > nowMs - QUEUE_TTL_MS)) return { sms: 'none' };
  } catch (e) { return { sms: 'failed:ledger' }; }
  const skey = 'overnight-summary-' + etYmd(nowMs);
  const held = await preflight(db, skey, nowMs);
  if (held) return { sms: held };
  const r = await ledger(db, (st) => decideFlush(st, nowMs, cap, daytime));
  if (!r) return { sms: 'failed:ledger' };
  if (r.action !== 'summary' && r.action !== 'overflow') return { sms: r.action };
  const target = await smsTarget(db, skey, nowMs);
  if (typeof target === 'string') return { sms: target };
  try {
    await twilioSend(target.to, smsText(r.action, { cap, items: r.items }));
    return { sms: 'sent', items: r.items.length };
  } catch (e) {
    log().error('[ownerNotify] summary text failed', { err: String(e && e.message || e).slice(0, 200) });
    return { sms: 'failed:send' };
  }
}

module.exports = { notifyOwner, flushOwnerQueue, SMS_SECRETS, STATE_DOC, DEFAULT_SMS_PER_DAY, QUEUE_TTL_MS, _overrides, _test: { decide, decideFlush, smsText, roll } };
