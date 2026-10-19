'use strict';
/**
 * missed-call-autotext.js — the automatic missed-call text (2026-10-15).
 * SHIPS DARK: MISSED_CALL_AUTOTEXT_ENABLED must be the literal 'true'
 * (functions/.env.nobigdeal-pro), and Jo flips it only after the Twilio A2P
 * campaign is approved.
 *
 *   maybeAutoTextMissedCall({ db, call, nowMs, env, send, tenantKey, logger })
 *
 * Called by callCenterIngest (call-center.js) right after a missed inbound
 * call is filed. Order, every step fail-closed (an unreadable answer = no text):
 *   1. planAutoText (missed-call-reply-logic.js): flag, a fresh missed call,
 *      a customer on file whose stored web-form consent covers this number,
 *      no do-not-contact flag, 8am-9pm in the homeowner's local time
 *   2. the STOP register + the company's Do Not Text list (sms-optout.js),
 *      then the declined-consent decision (sms-consent-declined.js, kind
 *      'automated': a "no" on ANY of this tenant's forms for this number wins
 *      unless a later stamped "yes" supersedes it; no inbound exemption)
 *   3. the company's texting master switch (sms-texting-gate.js)
 *   4. THE CLAIM: missed_call_autotext/{tenant}__{digits10}, one transaction:
 *      refuses inside 24 h of the last auto-text to this number, else stamps
 *      lastSentAtMs BEFORE Twilio is called. A send that fails after its claim
 *      is not retried (the storm-text trade-off: a duplicate text is a TCPA
 *      complaint; Jo still has the one-tap draft).
 *   5. send, then stamp autoText on the call doc and a timeline row on the lead.
 * Never throws: the ingest's real work already succeeded.
 */

const R = require('./missed-call-reply-logic');
const OptOut = require('./sms-optout');
const TextingGate = require('./sms-texting-gate');
const ConsentDeclined = require('./sms-consent-declined');
const MessagingControls = require('./messaging-controls');

const CLAIMS = 'missed_call_autotext';

async function maybeAutoTextMissedCall(args) {
  const a = args || {};
  const log = a.logger || console;
  const db = a.db;
  const call = a.call || {};
  const nowMs = Number(a.nowMs) || Date.now();
  const env = a.env || process.env;
  const done = (reason, extra) => Object.assign({ sent: false, reason }, extra || {});
  try {
    // Cheap refusals first: flag off / not a missed call cost no read at all.
    const pre = R.planAutoText({ env, call, lead: call.leadId ? {} : null, nowMs });
    if (!pre.send && ['flag_disabled', 'not_missed', 'stale', 'no_number', 'no_lead'].indexOf(pre.reason) !== -1) return done(pre.reason);

    const ls = await db.doc('leads/' + call.leadId).get();
    const lead = ls.exists ? (ls.data() || {}) : null;
    const plan = R.planAutoText({ env, call, lead, nowMs });
    if (!plan.send) return done(plan.reason);

    const tenantKey = String(a.tenantKey || TextingGate.tenantKeyOfRecord(lead) || TextingGate.NBD_OWNER_UID);
    const opt = await OptOut.isOptedOut(db, plan.to, { companyId: tenantKey, timeoutMs: OptOut.READ_TIMEOUT_MS });
    if (opt.optedOut) return done('opted_out');
    const cd = await ConsentDeclined.decide(db, {
      phone: plan.to, lead, leadId: call.leadId,
      tenants: [tenantKey, lead.companyId, lead.userId].filter(Boolean),
      kind: 'automated', nowMs, logger: log,
    });
    if (!cd.allowed) return done(cd.code);
    const status = await TextingGate.textingStatus(db, tenantKey);
    if (!status.allowed) return done('texting_' + status.reason);

    const id = R.claimId(tenantKey, plan.to);
    if (!id) return done('no_number');
    const ref = db.collection(CLAIMS).doc(id);
    const claimed = await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const prev = s.exists ? (s.data() || {}) : {};
      if (!R.cooldownClear(prev.lastSentAtMs, nowMs)) return false;
      tx.set(ref, { companyId: tenantKey, lastSentAtMs: nowMs, callId: call.id || null, leadId: call.leadId }, { merge: true });
      return true;
    });
    if (!claimed) return done('cooldown');

    if (typeof a.send !== 'function') return done('no_sender');
    // Idempotency per (recipient, template, call): a re-ingest of the same
    // call can never text twice. An unverifiable marker is no send.
    if (!(await MessagingControls.claimSendOnce(db, plan.to, 'missed_call_autotext', call.id || ('lead:' + call.leadId)))) return done('duplicate');
    let sid = null;
    try {
      const msg = await a.send({ to: plan.to, body: plan.body });
      sid = (msg && msg.sid) || null;
    } catch (e) {
      log.warn('missed_call_autotext_send_failed', { callId: call.id, err: e && e.message });
      if (call.id) await db.collection('phone_calls').doc(call.id).set({ autoText: { failedAtMs: nowMs, error: String((e && e.message) || e).slice(0, 200) } }, { merge: true }).catch(() => {});
      return done('send_failed');
    }
    if (call.id) await db.collection('phone_calls').doc(call.id).set({ autoText: { sentAtMs: nowMs, sid, body: plan.body } }, { merge: true }).catch(() => {});
    await db.collection('leads').doc(call.leadId).collection('activity').doc('autotext-' + (call.id || nowMs)).set({
      userId: lead.userId || tenantKey,
      type: 'sms_auto_missed_call',
      label: 'Missed-call text sent automatically',
      message: plan.body,
      createdAtMs: nowMs,
    }).catch(() => {});
    log.info('missed_call_autotext_sent', { callId: call.id, sid });
    return { sent: true, reason: 'sent', sid };
  } catch (e) {
    log.warn('missed_call_autotext_skipped', { callId: call.id, err: e && e.message });
    return done('error');
  }
}

module.exports = { maybeAutoTextMissedCall, CLAIMS };
