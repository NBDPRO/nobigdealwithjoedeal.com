/**
 * functions/storm-confirm.js — double opt-in for Storm Alert texts (2026-10-19)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * /storm-alerts takes ANY typed phone number, so a stranger could sign
 * someone else up. A subscriber with tcpaConsent only is NOT enough any more:
 * storm-sms-guard.js claimStormText refuses (reason 'not_confirmed') until the
 * subscriber has REPLIED YES to a confirmation text we sent them.
 *
 *   sendPendingConfirmations — one confirmation text per new subscriber.
 *       DARK: needs env STORM_CONFIRM_TEXT_ENABLED === 'true' AND
 *       messaging_controls/automations.stormConfirmText === true AND the
 *       global SMS switch (the caller checks; see storm-watch.js). At most
 *       maxPerRun per run, only subscribers who signed up in the last 7 days,
 *       only inside texting hours, STOP register first, one per subscriber
 *       ever (claimed BEFORE the send, never retried), idempotent per phone.
 *   confirmFromReply — incomingSMS calls this for a bare YES/Y: it confirms
 *       ONLY a subscriber we actually asked (smsConfirmRequestedAt + the
 *       phone we texted). A YES from anyone else is not swallowed.
 *
 * Fields on storm_alert_subscribers: smsConfirmRequestedAt, smsConfirmPhone,
 * smsConfirmedAt (all server-written).
 */
'use strict';

const StormGuard = require('./storm-sms-guard');
const MessagingControls = require('./messaging-controls');
const OptOut = require('./sms-optout');
const SendWindow = require('./sms-send-window');
const { formatPhone } = require('./phone-utils');

const SUBSCRIBERS = 'storm_alert_subscribers';
const MAX_AGE_DAYS = 7;
/** A YES confirms only within this long of the confirmation text. */
const CONFIRM_WINDOW_MS = 48 * 3600 * 1000;

/** Close to registered sample message 3; Jo/counsel to confirm the wording. */
function confirmBody() {
  return 'No Big Deal Home Solutions: Reply YES to confirm you want Storm Alert texts for your zip (2-4 per season). Msg & data rates may apply. Reply HELP for help, STOP to opt out.';
}

function confirmedReply() {
  return "No Big Deal Home Solutions: You're confirmed for Storm Alerts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
}

/** A bare YES (or Y), any case, with trailing punctuation. Nothing longer. */
function isYes(body) {
  return /^\s*(yes|y)[\s.!]*$/i.test(String(body == null ? '' : body));
}

function isConfirmed(sub) {
  return StormGuard.isDoubleOptedIn(sub);
}

function createdMs(sub) {
  const c = sub && sub.createdAt;
  if (!c) return 0;
  if (typeof c.toMillis === 'function') return c.toMillis();
  if (c instanceof Date) return c.getTime();
  return Number(c) || 0;
}

/**
 * args: { db, nowMs, send(to, body) -> twilio result, logger, maxPerRun,
 *         serverTimestamp, optOutTimeoutMs? }
 * Returns { requested, skipped: {reason: n} }. Never throws.
 */
async function sendPendingConfirmations(args) {
  const { db, send, logger } = args;
  const nowMs = args.nowMs != null ? args.nowMs : Date.now();
  const maxPerRun = args.maxPerRun != null ? args.maxPerRun : MessagingControls.DEFAULT_MAX_PER_RUN;
  const log = logger || { info() {}, warn() {}, error() {} };
  const out = { requested: 0, skipped: {} };
  const skip = (r) => { out.skipped[r] = (out.skipped[r] || 0) + 1; };
  // NBD's company texting switch (sms_settings, plus the global customer switch inside it) stops this too.
  // An unreadable switch is a no (fail closed).
  try {
    const TG = require('./sms-texting-gate');
    const st = await TG.textingStatus(db, args.companyId || TG.NBD_OWNER_UID);
    if (!st.allowed) { skip('texting_' + st.reason); log.info('storm_confirm_texting_off', { reason: st.reason }); return out; }
  } catch (e) {
    skip('texting_switch_unreadable');
    log.error('storm_confirm_texting_switch_unreadable', { err: e && e.message });
    return out;
  }
  let docs;
  try {
    docs = await StormGuard.loadActiveSubscribers(db, { logger: log });
  } catch (e) {
    log.error('storm_confirm_load_failed', { err: e && e.message });
    return out;
  }
  for (const doc of docs) {
    if (out.requested >= maxPerRun) { skip('per_run_cap'); break; }
    const sub = doc.data() || {};
    if (sub.tcpaConsent !== true) { skip('no_consent'); continue; }
    if (sub.smsConfirmRequestedAt || isConfirmed(sub)) { skip('already_asked'); continue; }
    const created = createdMs(sub);
    if (!created || nowMs - created > MAX_AGE_DAYS * 86_400_000) { skip('too_old'); continue; }
    const to = formatPhone(sub.phone);
    if (!to) { skip('bad_phone'); continue; }
    if (!SendWindow.withinRecipientWindow(nowMs, { zip: sub.zip, state: sub.state, tz: sub.tz })) { skip('quiet_hours'); continue; }
    try {
      const opt = await OptOut.isOptedOut(db, to, { companyId: args.companyId || require('./sms-texting-gate').NBD_OWNER_UID, timeoutMs: args.optOutTimeoutMs || OptOut.READ_TIMEOUT_MS });
      if (opt.optedOut) { skip('opted_out'); continue; }
    } catch (e) { skip('optout_unverified'); continue; }
    // Claim BEFORE the send (never retried), then a per-phone dedupe marker.
    let claimed = false;
    try {
      claimed = await db.runTransaction(async (tx) => {
        const snap = await tx.get(doc.ref);
        const cur = snap.exists ? (snap.data() || {}) : null;
        if (!cur || cur.active !== true || cur.smsConfirmRequestedAt) return false;
        tx.update(doc.ref, { smsConfirmRequestedAt: (args.serverTimestamp || (() => nowMs))(), smsConfirmPhone: to });
        return true;
      });
    } catch (e) { skip('claim_failed'); continue; }
    if (!claimed) { skip('already_asked'); continue; }
    try {
      if (!(await MessagingControls.claimSendOnce(db, to, 'storm_confirm', 'subscriber'))) { skip('duplicate'); continue; }
      await send(to, confirmBody());
      out.requested++;
    } catch (e) {
      log.warn('storm_confirm_send_failed', { sub: doc.id, err: e && e.message });
      skip('send_failed');
    }
  }
  log.info('storm_confirm_done', out);
  return out;
}

/**
 * A YES from `fromE164`: confirm every active subscriber we texted at that
 * number. Returns how many were confirmed (0 = this YES was not ours).
 */
async function confirmFromReply(db, fromE164, opts) {
  const o = opts || {};
  const ts = o.serverTimestamp || (() => Date.now());
  const nowMs = o.nowMs != null ? o.nowMs : Date.now();
  const snap = await db.collection(SUBSCRIBERS).where('smsConfirmPhone', '==', fromE164).get();
  let n = 0;
  for (const d of snap.docs) {
    const s = d.data() || {};
    if (s.active !== true || !s.smsConfirmRequestedAt || isConfirmed(s)) continue;
    // The request must be recent: a YES weeks later is a reply to something else.
    const askedMs = createdMs({ createdAt: s.smsConfirmRequestedAt });
    if (!askedMs || nowMs - askedMs > CONFIRM_WINDOW_MS || askedMs > nowMs + 60_000) continue;
    // ...and the confirmation must still be the LAST thing we texted this number: if a rep (or an
    // approved AI reply) texted them since, a bare "yes" answers THAT message, not ours.
    // An unreadable log is a no (fail closed).
    let newer;
    try { newer = await outboundSince(db, fromE164, askedMs); } catch (e) { continue; }
    if (newer) continue;
    await d.ref.update({ smsConfirmedAt: ts() });
    n++;
  }
  return n;
}

/** Any text WE sent this number after sinceMs (sms_log rows that are not inbound). */
async function outboundSince(db, e164, sinceMs) {
  const key = String(e164 || '').replace(/\D/g, '').slice(-10);
  if (key.length !== 10) return true;
  const snap = await db.collection('sms_log').where('toDigits', '==', key).limit(50).get();
  for (const d of snap.docs) {
    const r = d.data() || {};
    if (r.status === 'received' || r.direction === 'inbound') continue;
    const at = createdMs({ createdAt: r.date });
    if (!at || at > sinceMs) return true;
  }
  return false;
}

module.exports = { confirmBody, confirmedReply, isYes, isConfirmed, sendPendingConfirmations, confirmFromReply, MAX_AGE_DAYS };
