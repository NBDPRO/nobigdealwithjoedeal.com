/**
 * NBD — server-side rules for texts sent from the OFFLINE OUTBOX
 * ═══════════════════════════════════════════════════════════════
 *
 * docs/pro/js/sms-outbox.js holds a text the rep wrote while the app could not
 * reach sendSMS, and replays it later with `queued: true`. By then the world
 * may have moved: the homeowner texted back, a teammate already texted them,
 * the lead was deleted or moved stage, or it is 10pm. A queued text is only
 * sent if none of that happened — otherwise sendSMS answers
 * 409 { code: 'held', reason } and the text waits for the rep in the
 * "Pending texts" tray. Live (non-queued) sends never reach this module.
 *
 * Pure: no Firebase, no clock of its own except `nowMs`, which the handler
 * reads through module.exports at call time so a test can pin the clock (the
 * same idiom tests use for OptOut.READ_TIMEOUT_MS).
 *
 * Queued texts are POSTed to their OWN endpoint, sendQueuedSMS (same handler
 * as sendSMS, with `queued` forced on). A deploy that has not shipped this
 * code has no such endpoint, so a new page talking to an old fleet gets a
 * 404 / CORS failure and keeps the text queued — instead of an old sendSMS
 * that ignores `queued` and sends it as a live text with none of the checks
 * below (see functions/sms-functions.js exports.sendQueuedSMS).
 *
 * Order for a queued send (functions/sms-functions.js handleSendSMS):
 *   auth → 'to' validation → opt-out register (unchanged, still first)
 *   → per-uid queued-gate limiter (503 outbox_throttled)
 *   → shape validation (400) → idempotency peek (200 duplicate / 409 in_flight)
 *   → superseded originals (an edit: 409 in_flight / recent_outbound)
 *   → quiet hours → stale → lead gone (409 lead_gone, before any sms_log read)
 *   → competing activity in the caller's tenant → lead changed
 *   → paid gate / limiters → transactional idempotency claim → Twilio.
 * A PEEK ({ peek: true }, validatePeekFields) stops after the claim reads and
 * never reaches the opt-out register or Twilio.
 *
 * The claim is not only a queued-send thing: a LIVE send that carries a
 * clientMsgId (nbd-comms.js mints one before the attempt, and the outbox
 * reuses it if the attempt dies with status 0) claims it too, so the replay
 * of a live send that actually reached Twilio answers "duplicate" or
 * "in_flight" instead of texting the homeowner a second time.
 */

'use strict';

const { phoneDigits10 } = require('./phone-utils');

// Approved defaults (Jo, 2026-09-18). Change them here and nowhere else — the
// browser outbox has its own copy of STALE_MS for the pre-send check, and
// tests/sms-outbox-server.test.js pins that the two agree.
const STALE_MS = 15 * 60 * 1000;          // auto-send only if younger than this
const SEND_WINDOW = Object.freeze({
  timeZone: 'America/New_York',
  startHour: 8,                           // 08:00 inclusive
  endHour: 21,                            // 21:00 exclusive (20:59 sends, 21:00 holds)
});

// queuedAt is the DEVICE clock and sms_log.date is the SERVER clock. Looking
// back this much further than the queue time means a text that went out just
// after the rep queued theirs is not hidden by a little clock noise. The cost
// is the occasional hold of a text the rep sent themselves in the minute
// before they went offline — a hold is a tap, a missed competitor is a
// double text to a homeowner.
const ACTIVITY_SKEW_MS = 60 * 1000;

// A queued text is anything younger than a week; older is a stale device.
const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// How far in the future a bare queuedAt (no queuedAgeMs) may be before it is a
// 400. Deliberately NOT larger than ACTIVITY_SKEW_MS: a device clock that ran
// minutes fast used to be accepted here while the activity lookback covered
// only 60s of it, so a homeowner reply in the gap never held the text. The
// client sends queuedAgeMs (see effectiveQueuedAt), which makes the device's
// clock offset irrelevant; this bound only matters without it.
const FUTURE_SKEW_MS = ACTIVITY_SKEW_MS;

// sms_client_ids claim docs carry `expireAt` = claim time + this, and a
// Firestore TTL policy on that field (firestore.indexes.json fieldOverrides)
// deletes them. A claim only has to outlive the last replay that could carry
// its id, and validateQueuedFields refuses a queuedAt older than
// MAX_QUEUE_AGE_MS — so one day past that is enough, and nothing (uid,
// recipient key) is kept forever.
const CLAIM_TTL_MS = MAX_QUEUE_AGE_MS + 24 * 60 * 60 * 1000;

// An edit supersedes the text(s) it replaces. At most this many ids are
// checked — an edit of an edit of an edit is already an odd day.
const MAX_SUPERSEDES = 5;

// Bounded scan of sms_log for one recipient. Hitting the limit without finding
// a competitor is treated as a competitor (see evaluateActivityRows).
const ACTIVITY_SCAN_LIMIT = 25;

// Queued requests (sends AND peeks) per uid per hour, counted before any
// outbox read. The gate answers questions about a number's recent activity,
// so it must not be a free, unmetered query endpoint. Its own bucket: a held
// text must not burn the rep's SMS budget (sendSMS:uid / sendSMS:to), and the
// refusal is a 503 'outbox_throttled' — never a 429, which the client would
// read as a handoff verdict.
const QUEUED_GATE_LIMIT = 300;
const QUEUED_GATE_WINDOW_MS = 60 * 60 * 1000;

// Upper bound on each read a queued send makes (idempotency, activity, lead).
// Nothing hands a queued send off, but an unbounded read would run into the
// function's own 30s timeout and answer with the framework's plain-text 500.
// sms-functions.js reads it through module.exports at call time, so a test
// can shorten it.
const READ_TIMEOUT_MS = 10000;

// crypto.randomUUID() is 36 chars; allow other opaque ids of sane length. The
// id becomes part of a Firestore doc id, so no '/' and nothing exotic.
const CLIENT_MSG_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

const HOLD_REASONS = Object.freeze([
  'quiet_hours', 'stale', 'recent_outbound', 'recent_inbound',
  'lead_gone', 'lead_changed', 'in_flight',
]);

// The ONLY holds an explicit "Send anyway" (overrideActivity: true) may skip.
// Opt-out is not a hold at all (403, checked before this module runs), and
// quiet hours, a deleted lead and an in-flight duplicate are never overridable.
const ACTIVITY_OVERRIDABLE = Object.freeze(['recent_outbound', 'recent_inbound', 'lead_changed']);

const HOLD_MESSAGES = Object.freeze({
  quiet_hours: 'Held: outside 8am–9pm Eastern. It can go after 8am.',
  stale: 'Held: this text was queued more than 15 minutes ago. Review it before it goes.',
  recent_outbound: 'Held: someone already texted this number after you queued this.',
  recent_inbound: 'Held: the homeowner texted since you queued this. Read their message first.',
  lead_gone: 'Held: this lead was deleted or is no longer yours.',
  lead_changed: 'Held: this lead changed stage after you queued this.',
  in_flight: 'Held: this text is being sent, or may already have gone out. Check the conversation before sending again.',
});

function nowMs() {
  return Date.now();
}

/** ms since epoch from a Firestore Timestamp, a Date, or a number; else null. */
function toMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v.toMillis === 'function') {
    const n = v.toMillis();
    return Number.isFinite(n) ? n : null;
  }
  if (v instanceof Date) {
    const n = v.getTime();
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 0–23: the wall-clock hour in SEND_WINDOW.timeZone at `ms`. */
function hourInSendZone(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SEND_WINDOW.timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const h = parts.find((p) => p.type === 'hour');
  // `% 24`: some ICU builds render midnight as "24" even with h23.
  return h ? Number(h.value) % 24 : NaN;
}

/** True inside [08:00, 21:00) America/New_York. DST is the zone's problem, not ours. */
function isWithinSendWindow(ms) {
  const h = hourInSendZone(ms);
  if (!Number.isFinite(h)) return false;   // cannot tell → do not send
  return h >= SEND_WINDOW.startHour && h < SEND_WINDOW.endHour;
}

/**
 * When the text was really written, on the SERVER's clock.
 *
 * queuedAt is the device's Date.now() when the rep wrote the text; a phone
 * whose clock runs ten minutes fast sends a queuedAt ten minutes late, and
 * both the 15-minute rule and the "anything since?" lookback then start ten
 * minutes too late. queuedAgeMs is the same device's Date.now() minus that
 * createdAt at send time — a difference of two readings of one clock, so a
 * constant offset cancels out — and `now - queuedAgeMs` places the moment on
 * the server's clock. The EARLIER of the two is used: an older text is held
 * sooner and looks further back, never the other way round.
 *
 * Only for the stale rule and the activity window. The own-earlier-queued
 * rule compares RAW queuedAt values (one device, one clock, exact order — an
 * edit's original must compare equal, not jitter by network latency).
 */
function effectiveQueuedAt(queuedAt, queuedAgeMs, now) {
  if (typeof queuedAgeMs !== 'number' || !Number.isFinite(queuedAgeMs)) return queuedAt;
  return Math.min(queuedAt, now - Math.max(0, queuedAgeMs));
}

/** The optional queuedAgeMs field: undefined when absent, NaN when malformed. */
function readQueuedAge(b) {
  if (b.queuedAgeMs == null) return undefined;
  const v = b.queuedAgeMs;
  // A device clock stepped backwards between queue and send reads as a small
  // negative age: treat it as "just now" (the queuedAt side of the min still
  // applies). Anything else that is not a finite number is refused.
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.max(0, v) : NaN;
}

/**
 * The extra fields a queued send must carry, validated. Returns
 * { ok: true, clientMsgId, queuedAt, queuedAgeMs, effectiveQueuedAt,
 *   leadStageAtQueue, supersedes, overrideStale, overrideActivity }
 * or { ok: false, error }.
 */
function validateQueuedFields(body, now) {
  const b = body || {};
  const clientMsgId = typeof b.clientMsgId === 'string' ? b.clientMsgId : '';
  if (!CLIENT_MSG_ID_RE.test(clientMsgId)) {
    return { ok: false, error: 'Queued text is missing a valid clientMsgId' };
  }
  const queuedAt = b.queuedAt;
  if (typeof queuedAt !== 'number' || !Number.isFinite(queuedAt)) {
    return { ok: false, error: 'Queued text is missing queuedAt' };
  }
  const queuedAgeMs = readQueuedAge(b);
  if (Number.isNaN(queuedAgeMs)) {
    return { ok: false, error: 'queuedAgeMs must be a number' };
  }
  // With queuedAgeMs the device clock's offset does not matter (see
  // effectiveQueuedAt), so a fast clock is not a malformed request. Without
  // it, queuedAt is all there is, and it may run at most ACTIVITY_SKEW_MS
  // ahead — the lookback covers exactly that much.
  if (queuedAgeMs === undefined && queuedAt > now + FUTURE_SKEW_MS) {
    return { ok: false, error: 'queuedAt is in the future' };
  }
  const effective = effectiveQueuedAt(queuedAt, queuedAgeMs, now);
  if (effective < now - MAX_QUEUE_AGE_MS) {
    return { ok: false, error: 'queuedAt is more than 7 days old' };
  }
  let leadStageAtQueue = null;
  if (b.leadStageAtQueue != null && b.leadStageAtQueue !== '') {
    if (typeof b.leadStageAtQueue !== 'string' || b.leadStageAtQueue.length > 120) {
      return { ok: false, error: 'leadStageAtQueue must be a short string' };
    }
    leadStageAtQueue = b.leadStageAtQueue;
  }
  const sup = readSupersedes(b, clientMsgId);
  if (!sup.ok) return sup;
  return {
    ok: true,
    clientMsgId,
    queuedAt,
    queuedAgeMs: queuedAgeMs === undefined ? null : queuedAgeMs,
    effectiveQueuedAt: effective,
    leadStageAtQueue,
    supersedes: sup.supersedes,
    // Strict === true: a truthy string must not be an override.
    overrideStale: b.overrideStale === true,
    overrideActivity: b.overrideActivity === true,
  };
}

// An edited text names the ids it replaces (the original, and any earlier
// edit). Each must be a well-formed id that is not this text's own.
function readSupersedes(b, clientMsgId) {
  if (b.supersedes == null) return { ok: true, supersedes: [] };
  if (!Array.isArray(b.supersedes) || b.supersedes.length > MAX_SUPERSEDES
    || !b.supersedes.every((id) => typeof id === 'string' && CLIENT_MSG_ID_RE.test(id) && id !== clientMsgId)) {
    return { ok: false, error: 'supersedes must be a short list of earlier clientMsgIds' };
  }
  return { ok: true, supersedes: b.supersedes.filter((id, i, a) => a.indexOf(id) === i) };
}

/**
 * A PEEK ({ peek: true }): "did this id — or one it replaces — reach Twilio?"
 * The tray's "Check again" and the flush's re-ask about a text whose last
 * answer was lost. A peek NEVER sends: it reads claims and answers duplicate /
 * in_flight / recent_outbound, or 'not_claimed' (nothing of it reached
 * Twilio), so it needs neither the number nor the message.
 * Returns { ok: true, clientMsgId, supersedes } or { ok: false, error }.
 */
function validatePeekFields(body) {
  const b = body || {};
  const clientMsgId = typeof b.clientMsgId === 'string' ? b.clientMsgId : '';
  if (!CLIENT_MSG_ID_RE.test(clientMsgId)) {
    return { ok: false, error: 'Peek is missing a valid clientMsgId' };
  }
  const sup = readSupersedes(b, clientMsgId);
  if (!sup.ok) return sup;
  return { ok: true, clientMsgId, supersedes: sup.supersedes };
}

function isStale(queuedAt, now) {
  return now - queuedAt >= STALE_MS;
}

/** Lower bound for the sms_log scan (server clock), see ACTIVITY_SKEW_MS. */
function activitySince(queuedAt) {
  return queuedAt - ACTIVITY_SKEW_MS;
}

/**
 * WHOSE sms_log rows the activity check may look at: the caller's tenant.
 * sms_log holds every tenant's texts (one shared Twilio number), and the check
 * used to scan them all by phone key — so another company's conversation with
 * the same homeowner held this rep's text ("the homeowner texted since…"
 * about a thread they cannot see), and the answer (recent_* vs lead_gone)
 * told a caller whether ANYONE on the platform had texted a number since a
 * chosen time.
 *   company rep  → rows whose companyId is the caller's company claim
 *                  (teammates' sends stamp it; inbound rows stamp the matched
 *                  lead's companyId; the AI-draft path stamps the draft's)
 *   solo rep     → rows whose uid is the caller (their own sends, and inbound
 *                  rows routed to their leads, which carry uid = lead.userId)
 * @returns {{ field: 'companyId'|'uid', value: string }}
 */
function activityScope(decoded) {
  const d = decoded || {};
  if (typeof d.companyId === 'string' && d.companyId) return { field: 'companyId', value: d.companyId };
  return { field: 'uid', value: String(d.uid || '') };
}

/** The lead's canonical phone key: the stamped phoneDigits, else derived. */
function leadPhoneKey(lead) {
  if (!lead) return '';
  if (typeof lead.phoneDigits === 'string' && lead.phoneDigits) return lead.phoneDigits;
  return phoneDigits10(lead.phone || '');
}

/**
 * Did anything happen on this number since the text was queued?
 *
 * `rows` are sms_log documents for the recipient's canonical key (toDigits).
 * Inbound rows (status 'received') store the SENDER in `to`, so the same key
 * finds both directions. Not competition:
 *   - failed sends (nothing reached the homeowner) — but NOT a failure whose
 *     outcome is unknown (`deliveryUnknown`: the connection to Twilio broke
 *     after the request left, so the homeowner may well have it);
 *   - this same text (its own clientMsgId);
 *   - the same rep's EARLIER queued texts (queued strictly before this one)
 *     — the outbox flushes per recipient in order, so those are this text's
 *     predecessors in a sequence the rep wrote, not someone else's message.
 *     Strictly: an EDIT keeps its original's queuedAt, so an original that
 *     already went out has the same queuedAt as the edit and must count.
 * Everything else — any other rep, any live send, the AI-draft path — is.
 * (Within the caller's tenant: the rows are already scoped, activityScope.)
 *
 * ctx: { uid, queuedAt (raw device value — the own-earlier rule), clientMsgId,
 *        effectiveQueuedAt (server-clock estimate — the window), truncated }
 *
 * @returns {'recent_inbound'|'recent_outbound'|null} inbound wins: a reply
 *          from the homeowner is the stronger reason to stop and read.
 */
function evaluateActivityRows(rows, ctx) {
  const list = Array.isArray(rows) ? rows : [];
  const since = activitySince(typeof ctx.effectiveQueuedAt === 'number' ? ctx.effectiveQueuedAt : ctx.queuedAt);
  let outbound = false;
  let inbound = false;
  for (const r of list) {
    if (!r) continue;
    const at = toMillis(r.date);
    // A row with no usable date cannot be placed before the queue time, so it
    // counts. The query already filtered on date; this re-check keeps the
    // rule self-contained.
    if (at != null && at <= since) continue;
    if (r.status === 'failed' && r.deliveryUnknown !== true) continue;
    if (r.clientMsgId && r.clientMsgId === ctx.clientMsgId) continue;
    const ownEarlierQueued = r.queued === true
      && r.uid === ctx.uid
      && typeof r.queuedAt === 'number'
      && r.queuedAt < ctx.queuedAt;
    if (ownEarlierQueued) continue;
    if (r.status === 'received') inbound = true;
    else outbound = true;
  }
  if (inbound) return 'recent_inbound';
  if (outbound) return 'recent_outbound';
  // A full page with nothing competing in it may still have a competitor
  // just past it. Unknown is not clean.
  if (ctx.truncated) return 'recent_outbound';
  return null;
}

/**
 * The lead half of the activity check.
 * @param {object|null} lead  the lead document's data, or null when it does not exist
 * @returns {'lead_gone'|'lead_changed'|null}
 */
function evaluateLead(lead, ctx) {
  if (!lead || lead.deleted === true) return 'lead_gone';
  // Mirror the lead READ rule closely enough not to become an oracle: a lead
  // the caller could not open reads exactly like a deleted one.
  const role = ctx.role || '';
  const mine = lead.userId === ctx.uid;
  const sameCompany = !!ctx.companyId && lead.companyId === ctx.companyId;
  if (!mine && !sameCompany && role !== 'admin') return 'lead_gone';
  if (ctx.leadStageAtQueue && String(lead.stage == null ? '' : lead.stage) !== ctx.leadStageAtQueue) {
    return 'lead_changed';
  }
  return null;
}

function isActivityOverridable(reason) {
  return ACTIVITY_OVERRIDABLE.indexOf(reason) !== -1;
}

function holdMessage(reason) {
  return HOLD_MESSAGES[reason] || 'Held: review this text before it goes.';
}

/** Doc id in sms_client_ids — per sender, so one rep cannot squat another's ids. */
function claimDocId(uid, clientMsgId) {
  return String(uid) + '_' + String(clientMsgId);
}

/** The Date a claim doc made at `nowMs` may be TTL-deleted (see CLAIM_TTL_MS). */
function claimExpireAt(nowMs) {
  return new Date(nowMs + CLAIM_TTL_MS);
}

/**
 * An edit names the text(s) it replaces. What their claims say about sending
 * the edit now:
 *   - a claim that is not 'sent' ('claimed' / 'unknown'): the original may be
 *     on its way or may already be on the homeowner's phone → 'in_flight'
 *     (never overridable — check the thread first);
 *   - a 'sent' claim: the original already went → 'recent_outbound', the
 *     same "someone already texted this number" the rep can answer with
 *     "Send anyway" (a correction is a legitimate second text);
 *   - no claim: the original never reached Twilio → null.
 * @param {Array<object|null>} claims  claim doc data per superseded id, null when absent
 */
function supersededVerdict(claims) {
  const list = (Array.isArray(claims) ? claims : []).filter(Boolean);
  if (list.some((c) => c.status !== 'sent')) return 'in_flight';
  if (list.length) return 'recent_outbound';
  return null;
}

/**
 * Did Twilio DEFINITELY not take the text? Only a Twilio REST answer with an
 * HTTP 4xx status says so (bad number, 21610 unsubscribed, auth, 429) — the
 * request was read and refused. A socket error (ECONNRESET, a timeout), a
 * Twilio 5xx or an error with no HTTP status at all may have come AFTER
 * Twilio accepted the message, so the claim must not be released for it.
 */
function isDefiniteProviderRejection(e) {
  if (!e) return false;
  const s = Number(e.status);
  if (Number.isFinite(s) && s >= 400 && s < 500) return true;
  return Number(e.code) === 21610;
}

/** Canonical last-10 key; identical to OptOut.optOutKey and lead.phoneDigits. */
function recipientKey(phone) {
  return phoneDigits10(phone);
}

module.exports = {
  STALE_MS,
  SEND_WINDOW,
  MAX_QUEUE_AGE_MS,
  FUTURE_SKEW_MS,
  CLAIM_TTL_MS,
  MAX_SUPERSEDES,
  ACTIVITY_SKEW_MS,
  ACTIVITY_SCAN_LIMIT,
  QUEUED_GATE_LIMIT,
  QUEUED_GATE_WINDOW_MS,
  READ_TIMEOUT_MS,
  CLIENT_MSG_ID_RE,
  HOLD_REASONS,
  ACTIVITY_OVERRIDABLE,
  nowMs,
  toMillis,
  hourInSendZone,
  isWithinSendWindow,
  effectiveQueuedAt,
  validateQueuedFields,
  validatePeekFields,
  isStale,
  activitySince,
  activityScope,
  leadPhoneKey,
  evaluateActivityRows,
  evaluateLead,
  isActivityOverridable,
  holdMessage,
  claimDocId,
  claimExpireAt,
  supersededVerdict,
  isDefiniteProviderRejection,
  recipientKey,
};
