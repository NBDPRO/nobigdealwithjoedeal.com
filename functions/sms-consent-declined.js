/**
 * functions/sms-consent-declined.js — "this person said NO to texts on a form"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Audit finding C-7 (documentation/audit/HANDLE-AND-OPTOUT-CONTROLS-2026-10-13.md,
 * Jo decided option A on 2026-10-13). A lead whose form said NO to texting
 * (`tcpaConsent === false`) used to be honoured by exactly two readers — the
 * device hand-off check (phone-text-check.js) and the bot-draft tool
 * (agent-mcp-logic.js). The live CRM send (sendSMS / sendQueuedSMS) and the
 * approved-AI-reply trigger ignored it: the harness got HTTP 200 and a Twilio
 * call for a declined lead.
 *
 * THE POLICY (this file is its one definition)
 *
 *   A number whose consent was DECLINED is not texted by the server, unless
 *   the number has itself texted this company within DECLINED_REPLY_WINDOW_DAYS
 *   — a customer-initiated conversation is the basis for a reply.
 *
 *   - STOP / Do Not Text always wins and is checked by the caller first.
 *   - AUTOMATED / commercial sends (kind 'automated': review asks, referral
 *     codes, win-back, sequences) get NO inbound exemption. A customer texting
 *     us is a basis for answering them, not for a campaign.
 *   - An inbound that is itself STOP-like, a possible STOP, or a bare HELP
 *     does not open the window, and neither does one that predates the lead.
 *   - Inbound evidence is REAL inbound rows, matched on the canonical 10
 *     digits, inside the same tenant: sms_log 'received' rows (the business
 *     line / Twilio webhook) and phone_texts inbound rows (Jo's phone backup).
 *     Never a lead flag, never another tenant's thread.
 *   - Another lead in the same tenant carrying an explicit `tcpaConsent ===
 *     true` for the same number supersedes the decline (they said yes on a
 *     later form).
 *   - Unknown is not consent: any read error, or a full page of rows with no
 *     inbound among them, REFUSES with its own reason code.
 *
 * The decision is pure data + one bounded read; every server send path asks
 * it (tests/sms-consent-declined-2026-10-13.test.js lists them and fails when
 * a new Twilio send appears that is not on the ledger).
 */
'use strict';

const OptOut = require('./sms-optout');
const StopIntent = require('./sms-stop-intent');

/**
 * N. Seven days from the most recent qualifying inbound, rolling (each new
 * inbound restarts it).
 *
 * Why 7: no primary source sets a number of days for answering a consumer's
 * own text — Twilio's policy lets you "respond in an exchange" and treats the
 * inbound as consent for THAT exchange only, the CTIA language is "responds
 * quickly", and the one hard time figure in 47 CFR 64.1200 is the 5-minute
 * opt-out confirmation. A reply window is therefore a judgement. A roofing
 * conversation (scheduling an inspection, sending the estimate they asked
 * for) realistically spans several days, so 72 hours is too tight to be
 * usable; 14 and 30 days begin to look like the 3-month inquiry / 18-month
 * transaction established-business-relationship windows, which govern
 * telemarketing calls and are NOT a consent basis for texts. Counsel may
 * move it; it is one constant.
 */
const DECLINED_REPLY_WINDOW_DAYS = 7;
const DECLINED_REPLY_WINDOW_MS = DECLINED_REPLY_WINDOW_DAYS * 24 * 3600 * 1000;

/** Rows read per source. A full page with no inbound in it is "unknown" → refuse. */
const SCAN_LIMIT = 100;

/** Bound on the whole decision (the client aborts at 25 s; stay well under). */
const READ_TIMEOUT_MS = 8000;

/** Machine-readable refusal codes (also the ai_drafts failureReason / sms_log failureReason). */
const CODES = Object.freeze({
  DECLINED: 'consent_declined',
  UNVERIFIED: 'consent_check_unverified',
});

/**
 * `source` labels the CRM client sends with a text that are campaigns, not
 * conversation. The server cannot authenticate a label (a hand-built request
 * could omit it), which is why the inbound window is also required for every
 * other send: the label can only make this policy STRICTER, never looser.
 */
const AUTOMATED_SOURCES = Object.freeze([
  'review_request', 'referral_code', 'winback', 'storm_alert', 'lead_ack', 'sequence', 'drip', 'campaign',
  // Sales nudges the customer did not ask for (labels the CRM client really
  // sends: estimate-followups.js, smart-followup.js, the D2D follow-up).
  'estimate_followup', 'smart-followup-sms', 'd2d-followup-sms',
]);

const SOURCE_RE = /^[a-z0-9_-]{1,40}$/;

/** Normalise a client-supplied source label ('' when unusable). */
function cleanSource(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return SOURCE_RE.test(s) ? s : '';
}

/** 'automated' for a campaign label, else 'reply' (a person-initiated send). */
function kindForSource(source) {
  return AUTOMATED_SOURCES.indexOf(cleanSource(source)) !== -1 ? 'automated' : 'reply';
}

/** Strictly the explicit decline. Absent / null / 'false' is NOT a decline (nor consent). */
function isDeclined(lead) {
  return !!lead && lead.tcpaConsent === false;
}

/** What the rep is told. Plain words, with the manual alternative. */
function refusalMessage(code) {
  if (code === CODES.UNVERIFIED) {
    return 'Couldn\'t check whether this customer may be texted — nothing was sent. Call them instead, or try again in a moment.';
  }
  return 'Consent declined — texting blocked unless they text first. They left the texting box unchecked on their form. Call or email them instead.';
}

function toMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return null; } }
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  return null;
}

function tenantList(t) {
  const arr = Array.isArray(t) ? t : [t];
  const out = [];
  for (const x of arr) {
    const s = typeof x === 'string' ? x.trim() : '';
    if (s && out.indexOf(s) === -1) out.push(s);
  }
  return out;
}

/**
 * Does this inbound text open (or extend) a reply window? Not a STOP, not a
 * possible STOP, not a bare HELP. An empty body (an MMS photo) counts: a
 * photo from the homeowner is a message to us.
 */
function countsAsConversation(body) {
  const intent = StopIntent.classifyInbound(String(body == null ? '' : body)).intent;
  return intent !== 'stop' && intent !== 'possible_stop' && intent !== 'help';
}

/** The newest qualifying inbound, in ms, among rows of ONE source ({atMs, body}). */
function newestQualifying(rows, sinceMs, nowMs) {
  let best = null;
  for (const r of rows) {
    if (!r || typeof r.atMs !== 'number') continue;
    if (r.atMs < sinceMs || r.atMs > nowMs + 60 * 1000) continue;
    if (!countsAsConversation(r.body)) continue;
    if (best == null || r.atMs > best) best = r.atMs;
  }
  return best;
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('consent check did not answer within ' + ms + 'ms');
      e.code = 'consent_read_timeout';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function inboundFromSmsLog(db, key, tenants, sinceMs) {
  const since = new Date(sinceMs);
  const fields = ['companyId', 'uid'];
  const queries = [];
  for (const t of tenants) {
    for (const f of fields) {
      queries.push(db.collection('sms_log')
        .where('toDigits', '==', key)
        .where(f, '==', t)
        .where('date', '>', since)
        .orderBy('date', 'desc')
        .limit(SCAN_LIMIT)
        .get());
    }
  }
  const snaps = await Promise.all(queries);
  const rows = [];
  let truncated = false;
  for (const s of snaps) {
    if (s.docs.length >= SCAN_LIMIT) truncated = true;
    for (const d of s.docs) {
      const r = d.data() || {};
      if (r.status !== 'received') continue;
      rows.push({ atMs: toMillis(r.date), body: r.body });
    }
  }
  return { rows, truncated };
}

async function inboundFromPhoneTexts(db, key, tenants, sinceMs) {
  const queries = tenants.map((t) => db.collection('phone_texts')
    .where('phoneDigits', '==', key)
    .where('companyId', '==', t)
    .where('sentAtMs', '>=', sinceMs)
    .orderBy('sentAtMs', 'desc')
    .limit(SCAN_LIMIT)
    .get());
  const snaps = await Promise.all(queries);
  const rows = [];
  let truncated = false;
  for (const s of snaps) {
    if (s.docs.length >= SCAN_LIMIT) truncated = true;
    for (const d of s.docs) {
      const r = d.data() || {};
      if (r.direction !== 'inbound') continue;
      // A group text is not a one-to-one conversation with this number.
      if (r.group === true) continue;
      rows.push({ atMs: typeof r.sentAtMs === 'number' ? r.sentAtMs : null, body: r.body });
    }
  }
  return { rows, truncated };
}

function leadKey(lead) {
  if (!lead) return '';
  if (typeof lead.phoneDigits === 'string' && lead.phoneDigits) return OptOut.optOutKey(lead.phoneDigits);
  return OptOut.optOutKey(lead.phone || '');
}

function inTenant(lead, tenants) {
  return tenants.indexOf(lead.companyId) !== -1 || tenants.indexOf(lead.userId) !== -1;
}

/** Leads read per (tenant, field) before the page counts as "might be incomplete". */
const LEAD_SCAN_LIMIT = 25;

/**
 * Every lead of THIS tenant that carries this number: the one the caller
 * passed (when its number matches) plus a bounded lookup on the stamped
 * phoneDigits. Number-level on purpose: the decline belongs to the person's
 * number, so a request with no leadId, or a duplicate card, cannot sidestep it.
 *
 * The lookup is scoped to the tenant IN the query (companyId / userId), not
 * filtered afterwards: an unscoped page shared with other tenants' leads for
 * the same number could push this tenant's declined lead off it and read as
 * "not declined". A full page is unknown, not clean.
 */
async function leadsForNumber(db, key, tenants, passed, passedId) {
  const byId = new Map();
  if (passed && !passed.deleted && leadKey(passed) === key && inTenant(passed, tenants)) {
    byId.set(passedId || '(passed)', passed);
  }
  const queries = [];
  for (const t of tenants) {
    for (const f of ['companyId', 'userId']) {
      queries.push(db.collection('leads').where('phoneDigits', '==', key).where(f, '==', t).limit(LEAD_SCAN_LIMIT).get());
    }
  }
  const snaps = await Promise.all(queries);
  let truncated = false;
  for (const s of snaps) {
    if (s.docs.length >= LEAD_SCAN_LIMIT) truncated = true;
    for (const d of s.docs) {
      const l = d.data() || {};
      if (l.deleted === true || !inTenant(l, tenants)) continue;
      byId.set(d.id, l);
    }
  }
  return { leads: [...byId.values()], truncated };
}

/**
 * Does a LATER, server-stamped yes supersede these declines? A yes counts only
 * when it carries the server's own consent timestamp (tcpaConsentAt - stamped
 * by submitPublicLead, never by the browser) and that timestamp is newer than
 * the newest decline. An old yes followed by a newer no is the person's
 * latest word being no; an unstamped true (hand-typed, imported, spoofed on
 * a public form without a record) is not evidence.
 */
function supersedingYes(leads, declined) {
  const declineAt = declined.map((l) => toMillis(l.createdAt));
  if (declineAt.some((x) => x == null)) return false; // unknown decline time: never assume the yes is newer
  const newestDecline = Math.max.apply(null, declineAt);
  return leads.some((l) => {
    if (l.tcpaConsent !== true) return false;
    const at = toMillis(l.tcpaConsentAt);
    return at != null && at > newestDecline;
  });
}

/**
 * THE decision.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {object} a
 * @param {string}        a.phone    any format
 * @param {object|null}   [a.lead]   the lead the request named (a candidate; used only
 *                                   when its own number is this number and it is this tenant's)
 * @param {string}        [a.leadId] that lead's id
 * @param {string|string[]} a.tenants the caller's tenant key(s) — inbound is read inside these only
 * @param {'reply'|'automated'} [a.kind='reply']
 * @param {number}        a.nowMs
 * @param {{error: Function}} [a.logger]
 * @returns {Promise<{allowed: true, reason: string}
 *   | {allowed: false, code: string, reason: string, message: string}>}
 *   Never throws: a read error is a refusal with CODES.UNVERIFIED.
 */
async function decide(db, a) {
  const o = a || {};
  const key = OptOut.optOutKey(o.phone);
  // No usable number: nothing to text, nothing for this policy to say.
  if (!key) return { allowed: true, reason: 'no_number' };
  const tenants = tenantList(o.tenants);
  const refuse = (code) => ({ allowed: false, code, reason: code, message: refusalMessage(code) });
  if (!tenants.length) return refuse(CODES.UNVERIFIED);
  const nowMs = typeof o.nowMs === 'number' ? o.nowMs : Date.now();

  try {
    return await withDeadline((async () => {
      const found = await leadsForNumber(db, key, tenants, o.lead, o.leadId);
      const leads = found.leads;
      const declined = leads.filter(isDeclined);
      if (!declined.length) {
        // A full page might hide a declined lead past it: unknown, not clean.
        if (found.truncated) return refuse(CODES.UNVERIFIED);
        return { allowed: true, reason: 'not_declined' };
      }
      // A LATER, server-stamped yes on another form for the same number is consent.
      if (supersedingYes(leads, declined)) {
        return { allowed: true, reason: 'consent_on_other_record' };
      }
      // A campaign is never opened by an inbound.
      if (o.kind === 'automated') return refuse(CODES.DECLINED);

      // Window floor: N days back, and never before the (oldest declined) lead existed.
      let since = nowMs - DECLINED_REPLY_WINDOW_MS;
      const createdMs = declined.map((l) => toMillis(l.createdAt)).filter((x) => x != null);
      const created = createdMs.length === declined.length ? Math.min.apply(null, createdMs) : null;
      if (created != null && created > since) since = created;

      const log = await inboundFromSmsLog(db, key, tenants, since);
      if (newestQualifying(log.rows, since, nowMs) != null) {
        return { allowed: true, reason: 'inbound_recent' };
      }
      const texts = await inboundFromPhoneTexts(db, key, tenants, since);
      if (newestQualifying(texts.rows, since, nowMs) != null) {
        return { allowed: true, reason: 'inbound_recent' };
      }
      // A full page with no qualifying inbound may hide one beyond it.
      if (log.truncated || texts.truncated) return refuse(CODES.UNVERIFIED);
      return refuse(CODES.DECLINED);
    })(), READ_TIMEOUT_MS);
  } catch (e) {
    // Fail CLOSED, and say why: a refusal nobody can explain is a bug report.
    if (o.logger && typeof o.logger.error === 'function') {
      o.logger.error('consent_declined_check_unreadable', { err: e && e.message, code: e && e.code });
    }
    return refuse(CODES.UNVERIFIED);
  }
}

module.exports = {
  DECLINED_REPLY_WINDOW_DAYS,
  DECLINED_REPLY_WINDOW_MS,
  SCAN_LIMIT,
  READ_TIMEOUT_MS,
  CODES,
  AUTOMATED_SOURCES,
  LEAD_SCAN_LIMIT,
  cleanSource,
  kindForSource,
  isDeclined,
  refusalMessage,
  countsAsConversation,
  decide,
};
