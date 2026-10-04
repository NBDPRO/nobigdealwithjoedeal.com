/**
 * functions/storm-sms-guard.js — the ONE path a storm text to a homeowner takes
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two crons text storm_alert_subscribers:
 *   - checkStormAlerts (sms-functions.js) — NWS Severe/Extreme alerts
 *   - stormWatch       (storm-watch.js)   — NWS Local Storm Reports via IEM
 *
 * Before 2026-10-03 each kept its own bookkeeping and BOTH could double-text
 * (documentation in the PR "fix(functions): storm SMS can never double-send"):
 *
 *   1. checkStormAlerts sent first and wrote its dedup row second, in one try.
 *      A failed write — or the function being killed between the two (its 120s
 *      timeout could not fit its own 250-text cap at 1.1s/text) — left no row,
 *      and the next 30-minute run texted the same homeowner again.
 *   2. NWS re-issues an updated warning (CON/EXT/upgrade) under a NEW alert id,
 *      so (alertId, subscriberId) dedup alone re-texted on every update.
 *   3. stormWatch stamped its 24h cooldown AFTER the send, with the write
 *      swallowed (.catch(() => {})), and checkStormAlerts never read or wrote
 *      that stamp at all — one storm could text a person from both jobs.
 *   4. Neither consulted the TCPA opt-out register (sms_opt_outs).
 *
 * So every storm text now goes: quiet hours → opt-out register → CLAIM →
 * send → stamp, and each run first reads the master switch
 * (integrations/stormAlerts.enabled — absent = on).
 *
 * THE CLAIM is one Firestore transaction on the subscriber doc that
 *   - refuses if the subscriber is gone / inactive,
 *   - refuses if lastStormTextAt is inside STORM_TEXT_COOLDOWN_H (the ONE
 *     cooldown both crons share — same field, same constant),
 *   - creates the per-(alert, subscriber) claim doc (create semantics: it
 *     fails if the doc already exists, so a second run can never claim it),
 *   - stamps lastStormTextAt.
 * All of that commits BEFORE Twilio is called. Once claimed, nothing that
 * happens after the send (a failed write, a timeout kill) can make a later run
 * send again. The trade-off is deliberate, and the same one funnel-recovery.js
 * makes: a send that fails after its claim is NOT retried. A missed storm text
 * is a lost lead; a duplicate is a TCPA complaint.
 *
 * Pure module: firebase-admin is only required lazily for defaults, so tests
 * drive it with a fake Firestore.
 */

'use strict';

const crypto = require('crypto');
const OptOut = require('./sms-optout');
const { SEND_WINDOW } = require('./sms-outbox-guard');

/** One storm text per subscriber per this many hours — across BOTH crons.
 *  Covers NWS re-issuing an updated warning under a new alert id, and a
 *  person in range of both an NWS warning and a Local Storm Report. 24h is
 *  the promise stormWatch already made ("at most one storm text per
 *  subscriber per 24h"); the signup page promises "usually 2-4 times per
 *  season". */
const STORM_TEXT_COOLDOWN_H = 24;

const SUBSCRIBERS = 'storm_alert_subscribers';
/** Page size for the active-subscriber scan (documentId cursor paging). */
const SUBSCRIBER_PAGE_SIZE = 500;
/** Runaway guard: 400 pages × 500 = 200k subscribers. Hitting it is logged. */
const MAX_SUBSCRIBER_PAGES = 400;

/** TCPA quiet hours: storm texts only go out from START (inclusive) to END
 *  (exclusive) in the recipient's local time. Out-of-window texts are SKIPPED
 *  (not queued) and counted in the run log. The hours are the CRM's own send
 *  window (sms-outbox-guard.js SEND_WINDOW, 08:00–21:00, Jo 2026-09-18) — one
 *  definition, not a second copy that can drift. */
const STORM_QUIET_HOURS = Object.freeze({ startHour: SEND_WINDOW.startHour, endHour: SEND_WINDOW.endHour });
/** Recipient time zone when the subscriber doc carries no `tz`. */
const STORM_DEFAULT_TZ = SEND_WINDOW.timeZone;   // 'America/New_York'

/** Master on/off switch doc. `enabled: false` stops every storm text from
 *  both crons; an ABSENT doc / field means enabled (pre-switch behaviour). */
const STORM_SWITCH_DOC = 'integrations/stormAlerts';

function localHour(nowMs, tz) {
  const fmt = (zone) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(nowMs)).find((p) => p.type === 'hour').value;
  let h;
  try { h = fmt(tz || STORM_DEFAULT_TZ); } catch (_) { h = fmt(STORM_DEFAULT_TZ); }  // bad tz string → default
  return Number(h) % 24;
}

/** Is `nowMs` inside the allowed sending window for a recipient in `tz`? */
function withinStormSendWindow(nowMs, tz) {
  const h = localHour(nowMs, tz);
  return h >= STORM_QUIET_HOURS.startHour && h < STORM_QUIET_HOURS.endHour;
}

/**
 * Read the master switch. true unless integrations/stormAlerts.enabled is
 * exactly false. A read ERROR answers false (fail closed): a switch nobody
 * can read is not permission to text homeowners — the run is skipped and
 * logged, and the next 30-minute tick tries again.
 */
async function stormAlertsEnabled(db, logger) {
  try {
    const snap = await db.doc(STORM_SWITCH_DOC).get();
    const d = snap.exists ? (snap.data() || {}) : {};
    return d.enabled !== false;
  } catch (e) {
    if (logger) logger.error('storm_alerts_switch_unreadable', { err: e && e.message });
    return false;
  }
}

function serverTimestampDefault() {
  return require('firebase-admin/firestore').FieldValue.serverTimestamp();
}
function documentIdDefault() {
  return require('firebase-admin/firestore').FieldPath.documentId();
}

/** Deterministic, path-safe doc id for a (key, subscriber) pair. NWS alert ids
 *  can be URLs (contain '/'), so the raw id is never used as a doc id. */
function claimDocId(key, subscriberId) {
  const raw = subscriberId == null ? String(key) : String(key) + '::' + String(subscriberId);
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

function toMillis(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  return 0;
}

/** Is this subscriber inside the shared storm-text cooldown? */
function inStormCooldown(sub, nowMs, cooldownH) {
  const h = cooldownH == null ? STORM_TEXT_COOLDOWN_H : cooldownH;
  const last = toMillis(sub && sub.lastStormTextAt);
  return last > 0 && last > nowMs - h * 3600_000;
}

/**
 * Every active subscriber, paged by documentId so no silent cap drops anyone
 * (stormWatch's old .limit(1000) did, unordered). Returns QueryDocumentSnapshots.
 */
async function loadActiveSubscribers(db, opts) {
  const o = opts || {};
  const pageSize = o.pageSize || SUBSCRIBER_PAGE_SIZE;
  const maxPages = o.maxPages || MAX_SUBSCRIBER_PAGES;
  const docIdField = o.documentId || documentIdDefault();
  const out = [];
  let last = null;
  for (let page = 0; page < maxPages; page++) {
    let q = db.collection(SUBSCRIBERS).where('active', '==', true).orderBy(docIdField);
    if (last) q = q.startAfter(last);
    const snap = await q.limit(pageSize).get();
    out.push(...snap.docs);
    if (snap.docs.length < pageSize) return out;
    last = snap.docs[snap.docs.length - 1];
  }
  if (o.logger) o.logger.error('storm_subscribers_page_cap_hit', { pages: maxPages, loaded: out.length });
  return out;
}

function isAlreadyExists(e) {
  return !!e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS|already exists/i.test(String(e.message || '')));
}

/**
 * The claim transaction (see header). Resolves { claimed: true } or
 * { claimed: false, reason: 'inactive' | 'cooldown' | 'already_claimed' }.
 * Rejects on a Firestore error — the caller must then NOT send.
 */
async function claimStormText(db, args) {
  const { subscriberRef, claimRef, claimData, source, eventKey } = args;
  const nowMs = args.nowMs != null ? args.nowMs : Date.now();
  const serverTimestamp = args.serverTimestamp || serverTimestampDefault;
  let verdict = { claimed: true };
  await db.runTransaction(async (tx) => {
    verdict = { claimed: true };
    const subSnap = await tx.get(subscriberRef);
    const claimSnap = claimRef ? await tx.get(claimRef) : null;
    const sub = subSnap.exists ? (subSnap.data() || {}) : null;
    if (!sub || sub.active !== true) { verdict = { claimed: false, reason: 'inactive' }; return; }
    if (inStormCooldown(sub, nowMs, args.cooldownH)) { verdict = { claimed: false, reason: 'cooldown' }; return; }
    if (claimSnap && claimSnap.exists) { verdict = { claimed: false, reason: 'already_claimed' }; return; }
    if (claimRef) {
      tx.create(claimRef, Object.assign({}, claimData || {}, {
        status: 'claimed', source: source || null, claimedAt: serverTimestamp(),
      }));
    }
    tx.update(subscriberRef, {
      lastStormTextAt: serverTimestamp(),
      lastStormTextSource: source || null,
      lastStormEventKey: eventKey || null,
    });
  }).catch((e) => {
    if (isAlreadyExists(e)) { verdict = { claimed: false, reason: 'already_claimed' }; return; }
    throw e;
  });
  return verdict;
}

/**
 * opt-out register → claim → send → stamp, for ONE subscriber.
 *
 * args: { db, subscriberRef, phone, claimRef?, claimData?, source, eventKey,
 *         send: async () => twilioResult, logger, nowMs?, serverTimestamp?,
 *         optOutTimeoutMs? }
 * Resolves { status } — 'sent' | 'opted_out' | 'optout_unverified' |
 * 'inactive' | 'cooldown' | 'already_claimed' | 'claim_failed' |
 * 'send_failed' (with .error). Never throws.
 */
async function sendGuardedStormText(args) {
  const { db, subscriberRef, phone, claimRef, source, logger } = args;
  const serverTimestamp = args.serverTimestamp || serverTimestampDefault;
  const log = logger || { info() {}, warn() {}, error() {} };
  const subId = subscriberRef && subscriberRef.id;

  // 0) TCPA quiet hours in the recipient's local time. Skipped, not queued;
  // nothing is claimed, so the person is not put into cooldown.
  if (!withinStormSendWindow(args.nowMs != null ? args.nowMs : Date.now(), args.tz)) {
    return { status: 'quiet_hours' };
  }

  // 1) TCPA register — the same OptOut.isOptedOut the CRM's sendSMS uses. An unreadable register is not a clean one: no send.
  let opt;
  try {
    opt = await OptOut.isOptedOut(db, phone, { timeoutMs: args.optOutTimeoutMs || OptOut.READ_TIMEOUT_MS });
  } catch (e) {
    log.error('storm_sms_optout_unverified', { source, sub: subId, err: e && e.message });
    return { status: 'optout_unverified' };
  }
  if (opt.optedOut) {
    log.info('storm_sms_opted_out', { source, sub: subId, viaLegacyKey: opt.viaLegacyKey });
    return { status: 'opted_out' };
  }

  // 2) Claim — durable BEFORE the send.
  let claim;
  try {
    claim = await claimStormText(db, {
      subscriberRef, claimRef, claimData: args.claimData, source,
      eventKey: args.eventKey, nowMs: args.nowMs, serverTimestamp, cooldownH: args.cooldownH,
    });
  } catch (e) {
    log.error('storm_sms_claim_failed', { source, sub: subId, err: e && e.message });
    return { status: 'claim_failed' };
  }
  if (!claim.claimed) return { status: claim.reason };

  // 3) Send.
  let result;
  try {
    result = await args.send();
  } catch (e) {
    log.warn('storm_sms_send_failed', { source, sub: subId, err: e && e.message, code: e && e.code });
    // The claim stays: a failure AFTER the claim is never retried (a Twilio
    // timeout can still have delivered). The stamp is bookkeeping only.
    if (claimRef) {
      await claimRef.update({ status: 'failed', error: String((e && e.message) || 'unknown').slice(0, 300) })
        .catch((w) => log.error('storm_sms_fail_stamp_failed', { source, sub: subId, err: w && w.message }));
    }
    return { status: 'send_failed', error: e };
  }

  // 4) Stamp. Failure here is a bookkeeping gap only — the claim already
  // excludes this subscriber from every later run.
  if (claimRef) {
    await claimRef.update({ status: 'sent', sentConfirmedAt: serverTimestamp(), twilioSid: (result && result.sid) || null })
      .catch((w) => log.error('storm_sms_sent_stamp_failed', { source, sub: subId, err: w && w.message }));
  }
  return { status: 'sent' };
}

/**
 * Create-once marker: true for the first caller with this key, false for
 * every later one (Firestore create() conflict). Rejects on other errors.
 */
async function reserveOnce(db, collection, key, data, serverTimestamp) {
  const ts = serverTimestamp || serverTimestampDefault;
  const ref = db.collection(collection).doc(claimDocId(key));
  try {
    await ref.create(Object.assign({}, data || {}, { key: String(key), reservedAt: ts() }));
    return true;
  } catch (e) {
    if (isAlreadyExists(e)) return false;
    throw e;
  }
}

module.exports = {
  STORM_TEXT_COOLDOWN_H,
  STORM_QUIET_HOURS,
  STORM_DEFAULT_TZ,
  STORM_SWITCH_DOC,
  withinStormSendWindow,
  stormAlertsEnabled,
  SUBSCRIBER_PAGE_SIZE,
  MAX_SUBSCRIBER_PAGES,
  claimDocId,
  inStormCooldown,
  loadActiveSubscribers,
  claimStormText,
  sendGuardedStormText,
  reserveOnce,
  isAlreadyExists,
};
