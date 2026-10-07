/**
 * functions/twilio-line.js — NBD's Twilio number (+1 937 764 4855) wired into
 * the CRM, 2026-10-06. SHIPS DARK.
 * ═══════════════════════════════════════════════════════════════
 *
 *   twilioSmsWebhook      POST /api/twilio/sms           inbound text
 *   twilioSmsStatus       POST /api/twilio/sms-status    delivery callback
 *   twilioVoiceWebhook    POST /api/twilio/voice         inbound call
 *   twilioVoiceDialStatus POST /api/twilio/voice-status  <Dial action>
 *
 * ── DARK SWITCH ──────────────────────────────────────────────────────
 * TWILIO_INBOUND_ENABLED (functions/.env.nobigdeal-pro). Anything but the
 * literal 'true' is dark: every endpoint answers 200 with fixed TwiML and
 * reads/writes NOTHING. Dark voice does not forward — it says "Please call
 * <Jo's cell>" and hangs up. Flip it only after the A2P campaign is approved
 * (runbook: documentation/runbooks/TWILIO-LINE-GO-LIVE.md).
 *
 * ── TRUST ────────────────────────────────────────────────────────────
 * No App Check (Twilio can't present one). Every live request must carry a
 * valid X-Twilio-Signature made with TWILIO_AUTH_TOKEN (Secret Manager). A
 * missing or stub secret FAILS CLOSED (503 for SMS/status; voice plays the
 * call-Jo message and forwards nothing), a bad signature is 403. Nothing is
 * read or written before the signature passes.
 *
 * ── WHAT IT NEVER DOES ───────────────────────────────────────────────
 * Send. No Twilio API call, no sendSMS / smsForLead / AI-draft path, no TwiML
 * <Message>. Twilio's Messaging Service answers STOP/HELP itself (Advanced
 * Opt-Out); the webhook only records them. No call recording, no AI.
 *
 * ── TENANT ───────────────────────────────────────────────────────────
 * This number is NBD's, so a sender is matched only against NBD's leads
 * (companyId — or a solo lead's userId — equal to NBD_OWNER_UID), by
 * phoneDigits (the last-10 key every lead write stamps) with the exact-phone
 * fallback incomingSMS uses. Ties go through pickLeadForInbound.
 *
 * A text from a number that only ANOTHER tenant's lead holds is not NBD's
 * conversation: its body is filed nowhere (no sms_log, inbox, unmatched_sms
 * or bell) — the claim is written and "unmatched for NBD" is logged. A STOP
 * from it is still honoured (the register is global; each tenant holding the
 * number gets the stop_reply Do Not Text entry). Routing such texts to their
 * tenant is a later decision for Jo (multi-tenant use of this number).
 *
 * ── STOP / START ─────────────────────────────────────────────────────
 * The same decision incomingSMS makes (sms-stop-intent.js): "Stop.",
 * REVOKE, and plain-English revocations ("please stop texting me") are
 * opt-outs. Twilio's Advanced Opt-Out only knows whole keywords, so for a
 * phrase this register is the ONLY record. A STOP is also copied to the Do
 * Not Text list of each company holding the number, and START / UNSTOP
 * clears both the register and those stop_reply entries (a company's own
 * manual entries stay) — sms-optout.js owns all of it.
 *
 * ── IDEMPOTENCY ──────────────────────────────────────────────────────
 * Twilio retries on a timeout or 5xx. Each inbound text claims
 * sms_inbound_seen/{MessageSid} (the collection incomingSMS already uses);
 * each call claims twilio_call_seen/{CallSid}. The claim is created in the
 * SAME batch as every row it guards, and every row has a deterministic id, so
 * a retry either writes everything once or finds the claim and writes nothing.
 * The opt-out register write (OptOut.recordOptOut / clearOptOut — the one
 * module that owns its keys) runs just before that batch and is itself
 * idempotent.
 *
 * Pure decisions + row shapes: twilio-line-logic.js.
 */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { secretValue } = require('./integrations/_shared');
const { phoneDigits10 } = require('./phone-utils');
const { pickLeadForInbound } = require('./inbound-sms-route-logic');
const OptOut = require('./sms-optout');
const { NBD_OWNER_UID } = require('./tenant-ops-logic');
const L = require('./twilio-line-logic');

// defineSecret is idempotent by name — the same secret sms-functions.js uses.
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');

const enabled = () => process.env.TWILIO_INBOUND_ENABLED === 'true';
const MATCH_LIMIT = 10;

function sendXml(res, status, xml) {
  res.set('Content-Type', 'text/xml');
  res.set('Cache-Control', 'no-store');
  res.status(status).send(xml);
}

/**
 * Signature gate. Returns true when the request may proceed; otherwise it has
 * already answered (503 no secret, 403 bad signature) — or, for voice, played
 * the call-Jo message, so a caller is never left on an error tone.
 */
function gate(req, res, deps, fn, voiceFallback) {
  const token = deps.authToken !== undefined ? deps.authToken : secretValue(TWILIO_AUTH_TOKEN);
  const params = req.body && typeof req.body === 'object' ? req.body : {};
  const v = L.verifySignature(token, (req.headers || {})['x-twilio-signature'],
    L.candidateUrls(req.headers, req.originalUrl || req.url), params);
  if (v.ok) return true;
  if (v.reason === 'no_secret') {
    logger.error('[twilioLine] TWILIO_AUTH_TOKEN missing or stub — refusing', { fn });
    if (voiceFallback) sendXml(res, 200, voiceFallback);
    else res.status(503).json({ error: 'not configured' });
    return false;
  }
  logger.warn('[twilioLine] signature refused', { fn, reason: v.reason });
  res.status(403).json({ error: 'signature verification failed' });
  return false;
}

/** Every lead for this number (phoneDigits match + exact-phone fallback), any tenant. */
async function leadCandidates(db, from) {
  const digits = phoneDigits10(from);
  if (!digits) return [];
  const [a, b] = await Promise.all([
    db.collection('leads').where('phoneDigits', '==', digits).limit(MATCH_LIMIT).get(),
    db.collection('leads').where('phone', '==', String(from)).limit(MATCH_LIMIT).get(),
  ]);
  const byId = new Map();
  for (const d of [...a.docs, ...b.docs]) if (!byId.has(d.id)) byId.set(d.id, { id: d.id, data: d.data() || {} });
  return [...byId.values()];
}

/** NBD leads for this number. */
async function nbdCandidates(db, from) {
  return L.nbdLeads(await leadCandidates(db, from), NBD_OWNER_UID);
}

function routeOf(cands) {
  const ms = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis()
    : (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : (Date.parse(v) || null)));
  const route = pickLeadForInbound(cands.map((c) => ({
    id: c.id, companyId: c.data.companyId || null, userId: c.data.userId || null,
    lastContactedAt: ms(c.data.lastContactedAt), createdAt: ms(c.data.createdAt),
  })), { now: Date.now() });
  return route.decision === 'route' ? cands.find((c) => c.id === route.leadId) || null : null;
}

async function claimed(db, path) {
  return (await db.doc(path).get()).exists;
}

function isAlreadyExists(e) {
  return !!e && (e.code === 6 || /already exists/i.test(String(e.message || '')));
}

// ── Inbound SMS ───────────────────────────────────────────────────────────
async function handleSms(req, res, deps) {
  deps = deps || {};
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!enabled()) { sendXml(res, 200, L.EMPTY_TWIML); return; }
  if (!gate(req, res, deps, 'twilioSmsWebhook')) return;

  const body = req.body || {};
  const sid = String(body.MessageSid || body.SmsSid || '');
  const from = String(body.From || '');
  if (!L.isSid(sid, ['SM', 'MM'])) { res.status(400).json({ error: 'bad MessageSid' }); return; }
  const digits = phoneDigits10(from);
  if (!digits || !/^\+?1?\d{10}$/.test(from.replace(/[^\d+]/g, ''))) {
    // Short code / non-US sender: nothing to match, nothing to store.
    logger.info('[twilioLine] sms from a non-US/short sender ignored', { sid });
    sendXml(res, 200, L.EMPTY_TWIML);
    return;
  }

  const db = deps.db || getFirestore();
  const claimPath = 'sms_inbound_seen/' + sid;
  if (await claimed(db, claimPath)) { sendXml(res, 200, L.EMPTY_TWIML); return; }

  const text = String(body.Body == null ? '' : body.Body);
  const intent = L.inboundIntent(text);
  const kind = intent.intent;
  const all = await leadCandidates(db, from);
  const cands = L.nbdLeads(all, NBD_OWNER_UID);
  const lead = routeOf(cands);
  const ts = FieldValue.serverTimestamp();

  // The register first (idempotent, owned by sms-optout.js — canonical key;
  // START clears canonical AND legacy keys). Twilio has already applied a
  // whole keyword at the Messaging Service, but NOT a phrase ("please stop
  // texting me"): for that, this record is the only one.
  if (kind === 'stop') {
    await OptOut.recordOptOut(db, from, { optedOutAt: ts, keyword: intent.keyword, match: intent.match, twilioSid: sid, source: 'twilio_line' });
    // Each company holding the number sees it on its Do Not Text list.
    // Never throws; a failure never undoes the opt-out above.
    await OptOut.copyStopToTenantLists(db, from, {
      serverTimestamp: () => FieldValue.serverTimestamp(),
      onError: (e) => logger.error('[twilioLine] dnc_stop_reply_copy_failed', { sid, err: e && e.message }),
    });
  } else if (kind === 'start') {
    await OptOut.clearOptOut(db, from);
    // ...and the stop_reply Do Not Text entries (manual entries stay).
    try { await OptOut.clearStopReplyDnc(db, from); }
    catch (e) { logger.error('[twilioLine] dnc_stop_reply_clear_failed', { sid, err: e && e.message }); }
  }

  const batch = db.batch();
  batch.create(db.doc(claimPath), { fromLast4: L.last4(from), source: 'twilio_line', kind: kind || 'text', at: ts });

  // Another tenant's customer, not NBD's: file nothing but the claim.
  if (L.heldOnlyByOtherTenant(all, NBD_OWNER_UID)) {
    try { await batch.commit(); } catch (e) { if (!isAlreadyExists(e)) throw e; }
    logger.info('[twilioLine] sms unmatched for NBD (number held by another tenant) — body not filed', { sid, kind: kind || 'text' });
    sendXml(res, 200, L.EMPTY_TWIML);
    return;
  }

  const uid = lead ? (lead.data.userId || NBD_OWNER_UID) : NBD_OWNER_UID;
  const companyId = lead ? (lead.data.companyId || lead.data.userId || NBD_OWNER_UID) : NBD_OWNER_UID;
  batch.create(db.doc('sms_log/in_' + sid), L.inboundSmsLogRow({
    from, body: text, uid, leadId: lead ? lead.id : null, companyId, messageSid: sid, ts,
  }));

  if (lead) {
    batch.create(db.doc('notes/twsms_' + sid), L.leadNote({ leadId: lead.id, userId: uid, kind, body: text, messageSid: sid, ts }));
    batch.update(db.doc('leads/' + lead.id), { lastContactedAt: ts });
  }
  // The opt-out flag goes on EVERY NBD lead holding this number, not just the
  // routed one — the opt-out belongs to the phone.
  if (kind === 'stop' || kind === 'start') {
    for (const c of cands) {
      batch.update(db.doc('leads/' + c.id), kind === 'stop'
        ? { smsOptedOut: true, smsOptOutAt: ts, smsOptOutSource: 'inbound_keyword' }
        : { smsOptedOut: false, smsOptInAt: ts });
    }
  }
  // R6-3-1 (2026-10-07): a 'possible_stop' ("thanks but stop") is filed like
  // any text — note, bell, unknown-number inbox — but the note and the bell
  // say it may be a STOP, so a person reads it before anyone texts back. (This
  // line never drafts an AI reply, so there is no draft to suppress here.)
  if (!kind || kind === 'possible_stop') {
    if (!lead) {
      // Unknown number: the Agent inbox shows the last 4 only; the full
      // number goes to the admin-only unmatched_sms triage (Admin → Inbound
      // texts), the same row incomingSMS files, so convertUnmatchedSms works.
      batch.create(db.doc('agent_inbox/twsms_' + sid), L.unknownTextInboxItem({ ownerUid: NBD_OWNER_UID, from, body: text, messageSid: sid, ts, possibleStop: kind === 'possible_stop' }));
      const unmatched = { from, body: L.cleanBody(text), twilioSid: sid, receivedAt: ts, source: 'twilio_line' };
      if (kind === 'possible_stop') unmatched.possibleStop = true;
      batch.create(db.doc('unmatched_sms/tw_' + sid), unmatched);
    }
    batch.create(db.doc('notifications/twsms_' + sid), L.bellForText({
      ownerUid: NBD_OWNER_UID, userId: uid, lead: lead && lead.data, leadId: lead ? lead.id : null, body: text, from, ts,
      possibleStop: kind === 'possible_stop',
    }));
  }

  try {
    await batch.commit();
  } catch (e) {
    if (isAlreadyExists(e)) { sendXml(res, 200, L.EMPTY_TWIML); return; } // a concurrent retry won
    throw e;
  }
  logger.info('[twilioLine] sms filed', { sid, matched: !!lead, kind: kind || 'text' });
  sendXml(res, 200, L.EMPTY_TWIML);
}

// ── Delivery status callback ──────────────────────────────────────────────
async function handleSmsStatus(req, res, deps) {
  deps = deps || {};
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!enabled()) { sendXml(res, 200, L.EMPTY_TWIML); return; }
  if (!gate(req, res, deps, 'twilioSmsStatus')) return;

  const body = req.body || {};
  const sid = String(body.MessageSid || body.SmsSid || '');
  const status = String(body.MessageStatus || body.SmsStatus || '').toLowerCase();
  if (!L.isSid(sid, ['SM', 'MM'])) { res.status(400).json({ error: 'bad MessageSid' }); return; }
  if (!L.FINAL_DELIVERY.has(status)) { sendXml(res, 200, L.EMPTY_TWIML); return; }

  const db = deps.db || getFirestore();
  const snap = await db.collection('sms_log').where('twilioSid', '==', sid).limit(5).get();
  let updated = 0;
  for (const d of snap.docs) {
    const patch = L.deliveryUpdate(d.data(), status, body.ErrorCode);
    if (!patch) continue;
    await d.ref.update(Object.assign(patch, { deliveryAt: FieldValue.serverTimestamp() }));
    updated++;
  }
  logger.info('[twilioLine] delivery status', { sid, status, rows: snap.docs.length, updated });
  sendXml(res, 200, L.EMPTY_TWIML);
}

// ── Voice ─────────────────────────────────────────────────────────────────
async function handleVoice(req, res, deps) {
  deps = deps || {};
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const dark = L.darkVoiceTwiml(process.env);
  if (!enabled()) { sendXml(res, 200, dark); return; }
  if (!gate(req, res, deps, 'twilioVoiceWebhook', dark)) return;
  // Caller ID on Jo's cell = the caller's own number (`From`); `To` (ours —
  // the request is signed) is the fallback for an anonymous/invalid caller.
  const b = req.body || {};
  sendXml(res, 200, L.forwardTwiml(process.env, String(b.To || ''), String(b.From || '')));
}

async function handleVoiceDialStatus(req, res, deps) {
  deps = deps || {};
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const hangup = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
  if (!enabled()) { sendXml(res, 200, hangup); return; }
  if (!gate(req, res, deps, 'twilioVoiceDialStatus', hangup)) return;

  const body = req.body || {};
  const callSid = String(body.CallSid || '');
  const from = String(body.From || '');
  const outcome = L.callOutcome(body.DialCallStatus);
  if (!L.isSid(callSid, ['CA'])) { res.status(400).json({ error: 'bad CallSid' }); return; }

  const db = deps.db || getFirestore();
  const claimPath = 'twilio_call_seen/' + callSid;
  if (!phoneDigits10(from) || await claimed(db, claimPath)) { sendXml(res, 200, L.afterDialTwiml(outcome)); return; }

  const lead = routeOf(await nbdCandidates(db, from));
  const ts = FieldValue.serverTimestamp();
  const batch = db.batch();
  batch.create(db.doc(claimPath), { fromLast4: L.last4(from), outcome, source: 'twilio_line', at: ts });
  if (lead) {
    const uid = lead.data.userId || NBD_OWNER_UID;
    batch.create(db.doc('notes/twcall_' + callSid), L.callNote({
      leadId: lead.id, userId: uid, outcome, durationSec: body.DialCallDuration, callSid, ts,
    }));
    if (outcome === 'answered') batch.update(db.doc('leads/' + lead.id), { lastContactedAt: ts });
    else {
      const who = ((lead.data.firstName || '') + ' ' + (lead.data.lastName || '')).trim() || 'a customer';
      batch.create(db.doc('notifications/twcall_' + callSid), {
        userId: uid, companyId: NBD_OWNER_UID, type: 'missed_call', priority: 'high', leadId: lead.id,
        title: '📞 Missed call from ' + who, message: 'Called the NBD line; the forward to your cell was not answered.',
        read: false, dismissed: false, createdAt: ts,
      });
    }
  } else if (outcome === 'missed') {
    batch.create(db.doc('agent_inbox/twcall_' + callSid), L.unknownMissedCallInboxItem({ ownerUid: NBD_OWNER_UID, from, callSid, ts }));
  }
  try {
    await batch.commit();
  } catch (e) {
    if (!isAlreadyExists(e)) throw e;
  }
  logger.info('[twilioLine] call filed', { callSid, matched: !!lead, outcome });
  sendXml(res, 200, L.afterDialTwiml(outcome));
}

// A failure answers 500 so Twilio retries (every write is idempotent) — except
// on the voice paths, where a caller must never hear an error tone: there it
// plays fixed TwiML instead (the call-Jo message / a hang-up).
function wrap(fn, name, voiceFallback) {
  return async (req, res) => {
    try { await fn(req, res); } catch (e) {
      logger.error('[twilioLine] ' + name + ' failed', { err: e && e.message });
      if (res.headersSent) return;
      if (voiceFallback) sendXml(res, 200, voiceFallback());
      else res.status(500).json({ error: 'webhook failed' });
    }
  };
}

const OPTS = { cors: false, secrets: [TWILIO_AUTH_TOKEN], maxInstances: 5, timeoutSeconds: 15, memory: '256MiB' };

exports.twilioSmsWebhook = onRequest(OPTS, wrap(handleSms, 'twilioSmsWebhook'));
exports.twilioSmsStatus = onRequest(OPTS, wrap(handleSmsStatus, 'twilioSmsStatus'));
exports.twilioVoiceWebhook = onRequest(OPTS, wrap(handleVoice, 'twilioVoiceWebhook', () => L.darkVoiceTwiml(process.env)));
exports.twilioVoiceDialStatus = onRequest(OPTS, wrap(handleVoiceDialStatus, 'twilioVoiceDialStatus', () => L.afterDialTwiml('answered')));

// Test seam (not re-exported by index.js).
exports._internal = { handleSms, handleSmsStatus, handleVoice, handleVoiceDialStatus, wrap };
