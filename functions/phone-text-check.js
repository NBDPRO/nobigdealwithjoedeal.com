/**
 * functions/phone-text-check.js — "ok to text this customer from my phone?"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE GAP THIS CLOSES (review round 2, R2-3-1 / R2-3-2, Jo approved 2026-10-06)
 *
 * While the business line is not A2P-registered, most texts reach homeowners
 * from the owner's OWN phone: NBDPhoneShare.share (deal links, estimate
 * follow-ups, document links, crew notices), nbd-comms.js's Messages-app
 * fallback, and bot drafts in the Agent inbox. None of those asked the STOP
 * register first — and the browser cannot (sms_opt_outs and sms_dnc are
 * admin-SDK only in firestore.rules). This is the one server answer they all
 * ask now, before Messages opens:
 *
 *   phoneTextAction (onCall, App Check enforced) — { action, ... }
 *
 *     check { phone, leadId?, recipient?: 'homeowner'|'crew'|'number' }
 *         → { ok: true, to } | { ok: false, code, reason }
 *         Any member except a viewer. Reads, in order:
 *           - the lead (tenant check: it must be the caller's company's)
 *           - consent: a lead whose form said NO (tcpaConsent === false)
 *           - the STOP register, both key shapes, and the company's own
 *             Do Not Text list (sms-optout.js isOptedOut — one lookup)
 *           - the company's texting switch (Settings → Texting, OFF = no
 *             texts at all; registration is NOT required here, because a
 *             text from the owner's own phone does not use the business
 *             line's brand)
 *           - texting hours in the HOMEOWNER's local time (sms-send-window.js)
 *         A crew text (recipient 'crew', no lead) checks the register, the
 *         Do Not Text list and the switch only — a sub is not a homeowner.
 *         'number' is the same for a text with no lead behind it.
 *         ANY read error → { ok: false, code: 'unverified' }: the browser
 *         fails CLOSED ("couldn't check — call instead").
 *
 *     sent  { leadId, phone, body, source? } → { ok: true }
 *         The owner confirmed the text went out: one sms_log row (the Comm Log
 *         contract — leadId + uid + date) marked via 'owner_device'.
 *
 *     stop  { leadId, logId? , phone? } → { ok: true, key }
 *         "They replied STOP": the homeowner's STOP landed on the owner's
 *         phone, where nothing could see it. Recorded EXACTLY like an inbound
 *         STOP — the global register (recordOptOut) and the Do Not Text list
 *         of every company holding the number (copyStopToTenantLists, plus
 *         the caller's own list directly, source 'stop_reply'). The number
 *         must be the lead's, or one this lead's sms_log row was sent to.
 *
 * TODO (TWILIO_INBOUND_ENABLED, #2232): once the business line's inbound is
 * live, a STOP reply reaches the CRM by itself. Phone-sent texts should then
 * prefer the business line (NBDComms.sendSMS) over the owner's phone. The
 * flag is reported back on `check` as `businessLine` so the client can make
 * that switch in ONE place; nothing here enables anything.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const OptOut = require('./sms-optout');
const TextingGate = require('./sms-texting-gate');
const SendWindow = require('./sms-send-window');
const Outbox = require('./sms-outbox-guard');
const { isEnabled: twilioLineEnabled } = require('./twilio-line-logic');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// Roles that may read but never act (Jo's decision B, 2026-09-25) plus the
// access-code member role — the sms-dnc.js set.
const READ_ONLY_ROLES = new Set(['viewer', 'member']);
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BODY_MAX = 1600;

/** What the owner is told, per refusal code. */
const REASONS = Object.freeze({
  no_phone: 'No textable phone number for this customer.',
  declined: 'This customer said NO to texts on their form. Call or email instead.',
  opted_out: 'This customer replied STOP — they asked not to be texted. Call or email instead.',
  dnc: 'This number is on your company\'s Do Not Text list. Call or email instead.',
  switched_off: 'Texting is switched off for your company (Settings → Texting). Nothing was sent.',
  unverified: 'Couldn\'t check whether this customer can be texted — nothing was sent. Call them instead, or try again in a moment.',
});

function refusal(code, extra) {
  return Object.assign({ ok: false, code, reason: REASONS[code] || REASONS.unverified }, extra || {});
}

function callerOf(request) {
  const auth = request && request.auth;
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const token = auth.token || {};
  const role = typeof token.role === 'string' ? token.role.trim().toLowerCase() : '';
  return { uid: auth.uid, role, tenant: TextingGate.tenantKeyOf({ companyId: token.companyId, uid: auth.uid }) };
}

/** Is this lead the caller's company's? (agent-mcp.js draftLead's test, plus the rep's own.) */
function leadIsCallers(lead, caller) {
  if (!lead || lead.deleted === true) return false;
  return lead.companyId === caller.tenant || lead.userId === caller.tenant || lead.userId === caller.uid;
}

/**
 * The one decision. Never throws: a read error is a refusal ('unverified').
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {{ phone: string, tenants: string|string[], switchTenant: string,
 *           lead?: object|null, crew?: boolean, nowMs: number }} a
 * @returns {Promise<{ok: true, to: string, key: string} | {ok: false, code: string, reason: string}>}
 */
async function okToText(db, a) {
  const key = OptOut.optOutKey(a.phone);
  if (key.length !== 10) return refusal('no_phone');
  const lead = a.crew ? null : (a.lead || null);
  if (lead && lead.tcpaConsent === false) return refusal('declined');
  let optOut;
  let status;
  try {
    optOut = await OptOut.isOptedOut(db, a.phone, { companyId: a.tenants, timeoutMs: OptOut.READ_TIMEOUT_MS });
    status = await TextingGate.textingStatus(db, a.switchTenant);
  } catch (e) {
    logger.error('phone_text_check_unreadable', { err: e && e.message, code: e && e.code });
    return refusal('unverified');
  }
  if (optOut.optedOut) {
    if (optOut.viaLegacyKey) logger.info('optout.legacy_key_hit', { fn: 'phoneTextAction', key: optOut.key });
    return refusal(optOut.source === 'dnc' ? 'dnc' : 'opted_out');
  }
  // The company's own OFF switch. Not `allowed`: `not_registered` is about
  // the shared business line's brand, and this text goes from a phone.
  if (!status || status.enabled === false) return refusal('switched_off');
  if (lead) {
    const w = SendWindow.checkRecipientWindow(a.nowMs, lead);
    if (!w.ok) return { ok: false, code: 'quiet_hours', reason: SendWindow.quietHoursMessage(w.window) };
  }
  return { ok: true, to: '+1' + key, key };
}

async function readLead(db, leadId) {
  if (typeof leadId !== 'string' || !SAFE_ID_RE.test(leadId)) return null;
  const snap = await db.doc('leads/' + leadId).get();
  return snap.exists ? Object.assign({ id: leadId }, snap.data() || {}) : null;
}

/** The caller's lead, or an HttpsError. A read error is 'unavailable' (fail closed). */
async function callersLead(db, caller, leadId) {
  let lead;
  try { lead = await readLead(db, leadId); } catch (e) {
    logger.error('phone_text_lead_unreadable', { err: e && e.message });
    throw new HttpsError('unavailable', REASONS.unverified);
  }
  if (!leadIsCallers(lead, caller)) throw new HttpsError('not-found', 'That customer is not on your board.');
  return lead;
}

function phoneArg(data) {
  const raw = data && typeof data.phone === 'string' ? data.phone.trim() : '';
  return raw.length > 40 ? '' : raw;
}

async function handle(request) {
  const caller = callerOf(request);
  if (READ_ONLY_ROLES.has(caller.role)) throw new HttpsError('permission-denied', 'Your role is view-only');
  const data = (request && request.data) || {};
  const action = typeof data.action === 'string' ? data.action : '';
  const db = getFirestore();
  // The one clock every send path reads (tests replace it).
  const nowMs = Outbox.nowMs();

  if (action === 'check') {
    // 'crew' (a sub) and 'number' (nbd-comms.js's Messages fallback for a
    // text with no lead, e.g. a door knock): the number's lists only.
    const crew = (data.recipient === 'crew' || data.recipient === 'number') && !data.leadId;
    let lead = null;
    if (!crew) {
      try { lead = await readLead(db, data.leadId); } catch (e) {
        logger.error('phone_text_lead_unreadable', { err: e && e.message });
        return refusal('unverified');
      }
      // A homeowner text names its lead: no lead (or another company's) = no answer.
      if (!leadIsCallers(lead, caller)) return { ok: false, code: 'no_lead', reason: 'That customer is not on your board.' };
    }
    const phone = phoneArg(data) || (lead && lead.phone) || '';
    const out = await okToText(db, {
      phone,
      tenants: [caller.tenant, lead && TextingGate.tenantKeyOfRecord(lead)].filter(Boolean),
      switchTenant: caller.tenant,
      lead, crew, nowMs,
    });
    // TODO(TWILIO_INBOUND_ENABLED): when true, the client should send through
    // the business line instead of the owner's phone. Reported only.
    out.businessLine = twilioLineEnabled(process.env);
    return out;
  }

  if (action === 'sent') {
    const lead = await callersLead(db, caller, data.leadId);
    const phone = phoneArg(data) || lead.phone || '';
    const key = OptOut.optOutKey(phone);
    if (key.length !== 10) throw new HttpsError('invalid-argument', REASONS.no_phone);
    const body = String(data.body == null ? '' : data.body).replace(/\r\n?/g, '\n').trim().slice(0, BODY_MAX);
    const source = typeof data.source === 'string' && /^[a-z0-9_-]{1,40}$/.test(data.source) ? data.source : 'phone_share';
    const ts = FieldValue.serverTimestamp();
    // The Comm Log contract: leadId + uid + date. companyId: the team thread.
    await db.collection('sms_log').add({
      to: '+1' + key, toDigits: key, body, uid: caller.uid, leadId: lead.id,
      date: ts, sentAt: ts, status: 'sent_by_owner', companyId: caller.tenant,
      via: 'owner_device', source,
    });
    return { ok: true };
  }

  if (action === 'stop') {
    const lead = await callersLead(db, caller, data.leadId);
    let phone = phoneArg(data) || lead.phone || '';
    if (typeof data.logId === 'string' && data.logId) {
      if (!SAFE_ID_RE.test(data.logId)) throw new HttpsError('invalid-argument', 'Bad message id');
      const row = await db.doc('sms_log/' + data.logId).get();
      const r = row.exists ? (row.data() || {}) : null;
      if (!r || r.leadId !== lead.id || !(r.uid === caller.uid || (r.companyId && r.companyId === caller.tenant))) {
        throw new HttpsError('not-found', 'That message is not on this customer.');
      }
      phone = r.to || r.toDigits || phone;
    }
    const key = OptOut.optOutKey(phone);
    if (key.length !== 10) throw new HttpsError('invalid-argument', REASONS.no_phone);
    // Only a number this customer is known by: the lead's own, or one this
    // lead was texted at (sms_log). A typed-in stranger's number is refused.
    if (key !== OptOut.optOutKey(lead.phone)) {
      const sent = await db.collection('sms_log').where('leadId', '==', lead.id).where('toDigits', '==', key).limit(5).get();
      const mine = sent.docs.some((d) => { const r = d.data() || {}; return r.uid === caller.uid || (r.companyId && r.companyId === caller.tenant); });
      if (!mine) throw new HttpsError('failed-precondition', 'That number is not this customer\'s.');
    }
    // Exactly what incomingSMS does with an inbound STOP: the register…
    await OptOut.recordOptOut(db, phone, {
      optedOutAt: FieldValue.serverTimestamp(),
      keyword: 'STOP',
      match: 'owner_reported',
      reportedBy: caller.uid,
      reportedCompanyId: caller.tenant,
    });
    // …and every holding company's Do Not Text list (best-effort, never throws),
    // plus the caller's own list directly — a lead without phoneDigits would
    // be missed by the lead scan.
    await OptOut.copyStopToTenantLists(db, phone, {
      serverTimestamp: () => FieldValue.serverTimestamp(),
      onError: (e) => logger.warn('phone_text_stop_copy_failed', { err: e && e.message }),
    });
    await OptOut.addDnc(db, { companyId: caller.tenant, phone, source: 'stop_reply', byUid: caller.uid, note: 'They replied STOP (recorded from the CRM)' },
      () => FieldValue.serverTimestamp()).catch((e) => logger.warn('phone_text_stop_dnc_failed', { err: e && e.message }));
    logger.info('phone_text_stop_recorded', { tenant: caller.tenant, leadId: lead.id });
    return { ok: true, key };
  }

  throw new HttpsError('invalid-argument', 'Unknown action');
}

exports.phoneTextAction = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 20,
    memory: '256MiB', // never below 256MiB: a 128MiB gen2 fails its startup healthcheck
  },
  handle
);

exports.okToText = okToText;
exports.REASONS = REASONS;
exports._test = { handle, okToText, leadIsCallers };
