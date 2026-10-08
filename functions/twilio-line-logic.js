/**
 * functions/twilio-line-logic.js — pure decisions for NBD's Twilio line
 * (+1 937 764 4855), 2026-10-06. No firebase imports, so the tests can
 * require() it directly; functions/twilio-line.js does the I/O.
 *
 * What lives here:
 *   - the Twilio request signature (X-Twilio-Signature, HMAC-SHA1) and the
 *     URL candidates it is checked against behind the Hosting rewrite
 *   - the keyword decision (STOP / START / HELP) — delegated to
 *     sms-stop-intent.js, the ONE classifier incomingSMS uses too, so
 *     "Stop.", "please stop texting me", "remove me from your list" are
 *     opt-outs on this line exactly as on the main inbound webhook
 *   - every TwiML body the line ever returns (all of them fixed strings or
 *     built from config; no TwiML ever echoes text a caller sent)
 *   - the Firestore row shapes: sms_log (Comm Log contract: leadId + uid +
 *     date on every row), the lead note, the Agent inbox item for a text
 *     from a number that matches no customer (last 4 digits only), the bell
 *   - the delivery-status ladder for the status callback (idempotent: the
 *     first final answer wins)
 *
 * What does NOT live anywhere in this line: a send. Nothing here or in
 * twilio-line.js calls Twilio's API, sendSMS, smsForLead, or the AI-draft
 * generator. Twilio's Messaging Service answers STOP/HELP itself (Advanced
 * Opt-Out), so the webhook always answers with an EMPTY <Response/>.
 */
'use strict';

const crypto = require('crypto');
const { phoneDigits10 } = require('./phone-utils');
const StopIntent = require('./sms-stop-intent');

// The public origin Twilio is pointed at (Hosting rewrites /api/twilio/*).
const PUBLIC_BASE = 'https://nobigdealwithjoedeal.com';

// Paths, so the docs, firebase.json and the Dial action can't drift apart.
const PATHS = {
  sms: '/api/twilio/sms',
  smsStatus: '/api/twilio/sms-status',
  voice: '/api/twilio/voice',
  voiceStatus: '/api/twilio/voice-status',
};

// Keyword sets: sms-stop-intent.js owns them (no second copy here). STOP
// covers Twilio's default opt-out list (Advanced Opt-Out) so the register
// never misses one Twilio already honoured. START is the CTIA resume set only
// — never "YES". INFO is Twilio's HELP synonym.
const STOP_WORDS = new Set(StopIntent.STOP_KEYWORDS.map((k) => k.replace(/ /g, '')));
const START_WORDS = new Set(StopIntent.START_KEYWORDS);
const HELP_WORDS = new Set(StopIntent.HELP_KEYWORDS);

const BODY_CAP = 1600;          // Twilio's max concatenated SMS length
const PREVIEW_CAP = 140;        // bell / inbox preview
const FINAL_DELIVERY = new Set(['delivered', 'failed', 'undelivered']);

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Exact-string on switch: anything but 'true' is dark. */
function isEnabled(env) {
  return !!env && env.TWILIO_INBOUND_ENABLED === 'true';
}

/** Jo's cell from config (E.164 +1XXXXXXXXXX) or '' when unset/invalid. */
function forwardTo(env) {
  const raw = String((env && env.TWILIO_VOICE_FORWARD_TO) || '').trim();
  return /^\+1\d{10}$/.test(raw) ? raw : '';
}

/** '+18594207382' → '(859) 420-7382' */
function displayPhone(e164) {
  const d = phoneDigits10(e164);
  return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : '';
}

/** '+18594207382' → '8 5 9, 4 2 0, 7 3 8 2' (TTS reads it digit by digit). */
function spokenPhone(e164) {
  const d = phoneDigits10(e164);
  if (d.length !== 10) return '';
  const sp = (s) => s.split('').join(' ');
  return sp(d.slice(0, 3)) + ', ' + sp(d.slice(3, 6)) + ', ' + sp(d.slice(6));
}

function last4(phone) {
  return phoneDigits10(phone).slice(-4);
}

// ── Signature ─────────────────────────────────────────────────────────────
/**
 * Twilio's algorithm: the full URL, then every POST param sorted by name with
 * name+value appended (repeated params: each value, sorted), HMAC-SHA1 with the
 * account auth token, base64.
 */
function computeSignature(authToken, url, params) {
  let data = String(url);
  const p = params && typeof params === 'object' ? params : {};
  for (const key of Object.keys(p).sort()) {
    const v = p[key];
    const vals = Array.isArray(v) ? v.map(String).sort() : [v == null ? '' : String(v)];
    for (const one of vals) data += key + one;
  }
  return crypto.createHmac('sha1', String(authToken)).update(Buffer.from(data, 'utf8')).digest('base64');
}

/**
 * Check a request signature against each candidate URL. Constant-time compare.
 * A missing token, signature or candidate is a refusal, never a pass.
 * @returns {{ok: boolean, url?: string, reason?: string}}
 */
function verifySignature(authToken, signature, urls, params) {
  if (!authToken) return { ok: false, reason: 'no_secret' };
  const sig = String(signature || '');
  if (!sig) return { ok: false, reason: 'no_signature' };
  const got = Buffer.from(sig, 'utf8');
  for (const url of urls || []) {
    if (!url) continue;
    const want = Buffer.from(computeSignature(authToken, url, params), 'utf8');
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return { ok: true, url };
  }
  return { ok: false, reason: 'bad_signature' };
}

/**
 * The URLs Twilio may have signed. Behind the Hosting rewrite the function
 * sees its own run.app/cloudfunctions host, so the public origin (and the
 * forwarded host) are tried too. Accepting several hosts does not weaken the
 * check: every candidate still needs a valid HMAC from the auth token.
 */
function candidateUrls(headers, originalUrl) {
  const h = headers || {};
  const path = String(originalUrl || '/');
  const hosts = [];
  const fwd = String(h['x-forwarded-host'] || '').split(',')[0].trim();
  if (fwd) hosts.push(fwd);
  if (h.host) hosts.push(String(h.host).trim());
  const out = [PUBLIC_BASE + path];
  for (const host of hosts) {
    if (/^[A-Za-z0-9.-]+(:\d+)?$/.test(host)) out.push('https://' + host + path);
  }
  return out.filter((u, i, a) => a.indexOf(u) === i);
}

// ── Inbound SMS ───────────────────────────────────────────────────────────
/**
 * The full classification (sms-stop-intent.js classifyInbound):
 * { intent: 'stop'|'help'|'start'|null, keyword, match: 'keyword'|'phrase'|null }.
 * STOP is read far more loosely than Twilio's Advanced Opt-Out (which only
 * knows whole-message keywords): "please stop texting me" is an opt-out here
 * even though Twilio passes it through — so this register is the ONLY record
 * of it. START and HELP stay whole-message only.
 */
function inboundIntent(body) {
  return StopIntent.classifyInbound(body);
}

/** 'stop' | 'start' | 'help' | null. */
function keywordOf(body) {
  return inboundIntent(body).intent;
}

/** Stored body: control chars out, angle brackets neutralised, capped. */
function cleanBody(body, cap) {
  return String(body == null ? '' : body)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
    .slice(0, cap || BODY_CAP);
}

function isSid(s, prefixes) {
  const v = String(s || '');
  return /^[A-Z]{2}[0-9a-fA-F]{32}$/.test(v) && prefixes.indexOf(v.slice(0, 2)) !== -1;
}

/** Leads that belong to NBD (the line's only tenant), not deleted or test data. */
function nbdLeads(docs, ownerUid) {
  return (docs || []).filter((d) => d && d.data && (d.data.companyId || d.data.userId) === ownerUid
    && d.data.deleted !== true && !d.data.e2eTestData);
}

/**
 * True when the number belongs to ANOTHER tenant's live lead and to no NBD
 * lead. The line is NBD-only, so such a text must not be filed into NBD's
 * inbox, sms_log or unmatched_sms — that would put another company's customer
 * conversation in front of NBD. Routing it to that tenant is a later decision
 * (Jo); for now the body is not stored anywhere.
 */
function heldOnlyByOtherTenant(docs, ownerUid) {
  const live = (docs || []).filter((d) => d && d.data && d.data.deleted !== true && !d.data.e2eTestData);
  return nbdLeads(live, ownerUid).length === 0
    && live.some((d) => { const t = d.data.companyId || d.data.userId; return !!t && t !== ownerUid; });
}

/**
 * The sms_log row for an inbound text. Same fields logSMSToFirestore writes
 * (to, body, uid, leadId, date, sentAt, status, twilioSid, toDigits,
 * companyId) — `to` is the OTHER party, as on every 'received' row — plus
 * direction. Comm Log contract: leadId, uid AND date are always present.
 */
function inboundSmsLogRow({ from, body, uid, leadId, companyId, messageSid, ts }) {
  return {
    to: String(from || ''),
    body: cleanBody(body),
    uid: uid || null,
    leadId: leadId || null,
    date: ts,
    sentAt: ts,
    status: 'received',
    direction: 'inbound',
    twilioSid: messageSid,
    toDigits: phoneDigits10(from) || null,
    companyId: companyId || null,
    source: 'twilio_line',
  };
}

/** Timeline text for the lead note (top-level `notes`, what the customer page shows). */
function smsNoteText(kind, body) {
  if (kind === 'stop') {
    // A whole-message keyword is quoted; a plain-English "please stop texting
    // me" is long, so the note says what it meant instead of a cut-off quote.
    const kw = cleanBody(body, 40).trim();
    return (kw.length <= 20 && StopIntent.classifyInbound(body).match === 'keyword'
      ? '💬 Replied ' + kw.toUpperCase()
      : '💬 Asked to stop texting')
      + ' to the NBD text line — texting is OFF for this number (opt-out recorded).';
  }
  if (kind === 'start') return '💬 Replied ' + cleanBody(body, 20).trim().toUpperCase() + ' to the NBD text line — texting is back ON for this number.';
  if (kind === 'help') return '💬 Replied HELP to the NBD text line (Twilio sent the standard help reply).';
  // R6-3-1: not an opt-out (nothing recorded) — a person decides.
  if (kind === 'possible_stop') {
    return '⚠️ May be asking to stop texting — read this before anyone texts back; if they meant stop, mark the number Do Not Text. '
      + 'Text from customer: ' + cleanBody(body);
  }
  return '💬 Text from customer: ' + cleanBody(body);
}

function leadNote({ leadId, userId, kind, body, messageSid, ts }) {
  return {
    leadId,
    userId: userId || null,
    text: smsNoteText(kind, body),
    type: 'sms',
    direction: 'incoming',
    keyword: kind || null,
    twilioSid: messageSid,
    source: 'twilio_line',
    createdBy: 'NBD text line',
    createdAt: ts,
  };
}

/** Agent inbox item for a text no customer matches. Last 4 digits ONLY. */
function unknownTextInboxItem({ ownerUid, from, body, messageSid, ts, possibleStop }) {
  const l4 = last4(from) || '????';
  const item = {
    companyId: ownerUid,
    bot: 'NBD text line',
    botId: 'twilio_line',
    kind: 'report',
    status: 'pending',
    verified: false,
    leadId: null,
    title: 'Text from an unknown number',
    text: 'A text came in on the NBD line from a number ending in ' + l4
      + ' that does not match any customer:\n\n"' + cleanBody(body, 500) + '"\n\n'
      + 'The full number is under Admin → Inbound texts, where it can be turned into a customer.',
    twilioSid: messageSid,
    source: 'twilio_line',
    createdAt: ts,
  };
  if (possibleStop) {
    item.title = '⚠️ Text from an unknown number — may be asking to stop';
    item.possibleStop = true;
  }
  return item;
}

function bellForText({ ownerUid, userId, lead, leadId, body, from, ts, possibleStop }) {
  if (leadId) {
    const who = lead ? (((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || 'a customer') : 'a customer';
    return {
      userId: userId || ownerUid, companyId: ownerUid,
      type: possibleStop ? 'sms_possible_stop' : 'incoming_sms', priority: 'high', leadId,
      title: possibleStop ? '⚠️ ' + who + ' may be asking you to stop texting' : '💬 Text from ' + who,
      message: cleanBody(body, PREVIEW_CAP),
      read: false, dismissed: false, createdAt: ts,
    };
  }
  return {
    userId: ownerUid, companyId: ownerUid, type: 'agent_inbox', priority: 'normal', leadId: null,
    title: possibleStop ? '⚠️ Text from an unknown number — may be asking to stop' : '💬 Text from an unknown number',
    message: 'From a number ending in ' + (last4(from) || '????') + ' — it is in your Agent inbox.',
    read: false, dismissed: false, createdAt: ts,
  };
}

// ── Status callback ───────────────────────────────────────────────────────
/** Should this callback write to a row that already has `current`? */
function deliveryUpdate(row, messageStatus, errorCode) {
  const s = String(messageStatus || '').toLowerCase();
  if (!FINAL_DELIVERY.has(s)) return null;                         // queued/sent/… → ignore
  if (!row || row.direction === 'inbound' || row.status === 'received') return null;
  if (FINAL_DELIVERY.has(String(row.deliveryStatus || ''))) return null; // first final answer wins
  const code = String(errorCode == null ? '' : errorCode).replace(/[^0-9]/g, '').slice(0, 8);
  return { deliveryStatus: s, deliveryErrorCode: code || null };
}

// ── Voice ─────────────────────────────────────────────────────────────────
function sayHangup(text) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Say>' + xmlEsc(text) + '</Say><Hangup/></Response>';
}

function xmlEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

/** What a caller hears when the line is dark (or misconfigured): call Jo's cell. */
function darkVoiceTwiml(env) {
  const spoken = spokenPhone(forwardTo(env));
  return sayHangup(spoken
    ? 'Thanks for calling No Big Deal Home Solutions. Please call ' + spoken + '. Again, that is ' + spoken + '. Goodbye.'
    : 'Thanks for calling No Big Deal Home Solutions. Please call back later. Goodbye.');
}

const isUsE164 = (s) => /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(String(s || ''));

/**
 * The caller ID Jo's cell shows (Jo, 2026-10-06): the CALLER's own number, so
 * he can see who is calling. Falls back to the Twilio number when the caller's
 * is missing, anonymous/restricted (Twilio sends e.g. "Anonymous" or
 * "+266696687"), or not a valid US number.
 */
function forwardCallerId(from, twilioNumber) {
  if (isUsE164(from)) return String(from);
  return isUsE164(twilioNumber) ? String(twilioNumber) : '';
}

/** Forward to Jo's cell, showing the caller's number as caller ID. No recording. */
function forwardTwiml(env, twilioNumber, from) {
  const to = forwardTo(env);
  const callerId = forwardCallerId(from, twilioNumber);
  if (!to || !callerId) return darkVoiceTwiml(env);
  return '<?xml version="1.0" encoding="UTF-8"?><Response>'
    + '<Dial callerId="' + xmlEsc(callerId) + '" timeout="25" action="' + PATHS.voiceStatus + '" method="POST">'
    + '<Number>' + xmlEsc(to) + '</Number></Dial></Response>';
}

/** Dial action → 'answered' | 'missed'. */
function callOutcome(dialCallStatus) {
  const s = String(dialCallStatus || '').toLowerCase();
  return s === 'completed' || s === 'answered' ? 'answered' : 'missed';
}

function afterDialTwiml(outcome) {
  return outcome === 'answered'
    ? '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>'
    : sayHangup('Sorry we missed your call. Please try again soon. Goodbye.');
}

function fmtDuration(sec) {
  const n = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(n / 60), s = n % 60;
  return m ? m + ' min ' + s + ' s' : s + ' s';
}

function callNote({ leadId, userId, outcome, durationSec, callSid, ts }) {
  return {
    leadId,
    userId: userId || null,
    text: outcome === 'answered'
      ? '📞 Called the NBD line — forwarded to Jo and answered (' + fmtDuration(durationSec) + ').'
      : '📞 Missed call on the NBD line (forwarded to Jo, not answered).',
    type: 'call',
    direction: 'incoming',
    outcome,
    durationSec: Math.max(0, Math.floor(Number(durationSec) || 0)),
    twilioCallSid: callSid,
    source: 'twilio_line',
    createdBy: 'NBD phone line',
    createdAt: ts,
  };
}

function unknownMissedCallInboxItem({ ownerUid, from, callSid, ts }) {
  return {
    companyId: ownerUid,
    bot: 'NBD phone line',
    botId: 'twilio_line',
    kind: 'report',
    status: 'pending',
    verified: false,
    leadId: null,
    title: 'Missed call from an unknown number',
    text: 'A call to the NBD line from a number ending in ' + (last4(from) || '????')
      + ' was forwarded to Jo and not answered. It does not match any customer.',
    twilioCallSid: callSid,
    source: 'twilio_line',
    createdAt: ts,
  };
}

module.exports = {
  PUBLIC_BASE, PATHS, STOP_WORDS, START_WORDS, HELP_WORDS, BODY_CAP, EMPTY_TWIML, FINAL_DELIVERY,
  isEnabled, forwardTo, displayPhone, spokenPhone, last4,
  computeSignature, verifySignature, candidateUrls,
  keywordOf, inboundIntent, cleanBody, isSid, nbdLeads, heldOnlyByOtherTenant,
  inboundSmsLogRow, smsNoteText, leadNote, unknownTextInboxItem, bellForText,
  deliveryUpdate,
  xmlEsc, darkVoiceTwiml, forwardCallerId, forwardTwiml, callOutcome, afterDialTwiml, fmtDuration, callNote,
  unknownMissedCallInboxItem,
};
