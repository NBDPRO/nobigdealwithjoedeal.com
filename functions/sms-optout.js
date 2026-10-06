/**
 * NBD — the TCPA opt-out register, with ONE key derivation
 * ═══════════════════════════════════════════════════════════════
 *
 * THE BUG THIS EXISTS TO CLOSE (found 2026-09-04)
 *
 * `sms_opt_outs` was WRITTEN under one key and READ under another, so a
 * homeowner's STOP has never been honoured on any rep- or AI-initiated text:
 *
 *   write (incomingSMS)  String(twilioFrom).replace(/\D/g,'')  → '18595550134'
 *   read  (every sender) String(lead.phone).replace(/\D/g,'')  → '8595550134'
 *
 * Twilio delivers E.164 with the country code; leads store the phone however
 * the rep typed it. The lookup therefore missed on every ordinary send, the
 * register was effectively write-only, and the "You've been unsubscribed"
 * TwiML we send back was not true.
 *
 * phone-utils.js already carries the canonical normaliser for exactly this
 * class of drift, and sms-functions.js already imports it — for lead matching,
 * just not here. Its header says the read side and every write side "MUST
 * share this exact transform — otherwise the stamped key and the looked-up key
 * drift and the match silently fails." That is precisely what happened.
 *
 * WHY THE LEGACY READ EXISTS
 *
 * Every opt-out already in production is stored under the 11-digit key.
 * Normalising the write alone would strand all of them: those homeowners
 * would silently become textable again — the exact harm, inverted, on the
 * exact people who already objected.
 *
 * So the lookup checks the canonical key and, when that misses, the legacy
 * key too. That makes the fix safe in BOTH deploy orderings — code first or
 * backfill first — because no window exists in which an existing opt-out is
 * invisible. `viaLegacyKey` is returned so callers can log it; when that log
 * line stops appearing after the backfill, the legacy read can be deleted.
 *
 * Deliberately NOT a cache. An opt-out is a legal instruction and the read is
 * a single indexed doc get.
 */

'use strict';

const { phoneDigits10 } = require('./phone-utils');

const COLLECTION = 'sms_opt_outs';

/**
 * The INTERNAL per-company Do Not Text list (Jo, 2026-10-05). No paid DNC
 * registry service: a company's own list of numbers it must not text.
 *
 *   sms_dnc/{companyId}__{optOutKey}
 *     { companyId, key, phone, source: 'manual' | 'stop_reply', addedAt,
 *       addedBy, note? }
 *
 * Two ways in: a rep adds a number from the CRM (manageSmsDnc, source
 * 'manual'), and a homeowner's STOP reply is copied onto the list of every
 * company holding that number (incomingSMS, source 'stop_reply') so each
 * company can SEE who stopped it. The global register above stays the
 * enforcement for a STOP: one Twilio number serves every tenant, so a STOP
 * there means stop for everyone.
 *
 * Enforced HERE, inside isOptedOut, so no send path can skip it: every
 * sender already calls isOptedOut, and isOptedOut now refuses to answer
 * (throws, which every caller treats as "do not send") unless it is told
 * whose list to check. Admin-SDK only (firestore.rules: no client access).
 */
const DNC_COLLECTION = 'sms_dnc';

function cleanTenant(c) {
  const v = typeof c === 'string' ? c.trim() : '';
  return (!v || v.indexOf('/') !== -1 || v.length > 128) ? '' : v;
}

/** The DNC doc id for a company + any phone format. '' when either is unusable. */
function dncDocId(companyId, phone) {
  const key = optOutKey(phone);
  const co = cleanTenant(companyId);
  return key && co ? co + '__' + key : '';
}

/** opts.companyId → a clean, de-duplicated list, or null when it is unusable. */
function tenantList(companyId) {
  const raw = Array.isArray(companyId) ? companyId : [companyId];
  const out = [];
  for (const c of raw) {
    const v = cleanTenant(c);
    if (!v) return null;
    if (out.indexOf(v) === -1) out.push(v);
  }
  return out.length ? out : null;
}

/**
 * The canonical document id: last-10 US digits, country code dropped.
 * Byte-identical to the transform lead-write paths stamp as `phoneDigits`.
 * @returns {string} '' when there is no usable phone
 */
function optOutKey(phone) {
  return phoneDigits10(phone);
}

/**
 * The key incomingSMS used to write before 2026-09-04 — a plain digit strip,
 * so an E.164 sender kept its leading country-code 1.
 *
 * Exported for the backfill and the tests, not for new call sites.
 * @returns {string} '' when there is no usable phone
 */
function legacyOptOutKey(phone) {
  return String(phone == null ? '' : phone).replace(/\D/g, '');
}

/**
 * Upper bound (ms) on a lookup made with an options object — see isOptedOut.
 *
 * The HTTP send paths (sendSMS, sendD2DSMS) pass it. docs/pro/js/nbd-comms.js
 * aborts its fetch at 25s and treats the abort like being offline (status 0),
 * which it hands off to the rep's Messages app with the text filled in. A
 * lookup that THROWS was already a 503, but one that HANGS was not: a hung RPC
 * waits on the SDK's per-attempt gRPC deadline (minutes, not seconds), the
 * lookup can make three reads in a row, and the functions' own 30s timeout is
 * also past 25s. The client gave up first and handed off a number whose
 * opt-out status nobody knew. Past this bound the lookup rejects like any
 * other read error, so the caller answers 503 optout_unverified. Keep it well
 * under the client's 25s: a cold start and auth run ahead of the read.
 *
 * Callers pass `{ timeoutMs: OptOut.READ_TIMEOUT_MS }`, which reads the export
 * at call time, so a test can shorten it on its own copy of the module.
 */
const READ_TIMEOUT_MS = 10000;

/**
 * Has this number opted out — of everything (the STOP register), or of this
 * company (its Do Not Text list)?
 *
 * THROWS on a Firestore error rather than returning false. Every caller treats
 * a throw as "do not send" — sendSMS and sendD2DSMS answer 503 {code:
 * 'optout_unverified'} (which the browser client refuses rather than handing
 * off to device Messages) and the AI-draft path catches it into fail('optout_
 * check_error'). Returning false on error would turn a transient blip into a
 * message to someone who said STOP.
 *
 * `opts.companyId` is REQUIRED (2026-10-05): the tenant key (companyId claim,
 * or a solo owner's uid) whose Do Not Text list applies, or an array of them.
 * Missing or unusable, the lookup REJECTS with code 'optout_no_tenant' — a
 * new send path that forgets it fails closed instead of quietly skipping the
 * list.
 *
 * The whole lookup (every read, not each one) is bounded, and it REJECTS with
 * code 'optout_read_timeout' past the bound. A missing or unusable
 * `timeoutMs` falls back to READ_TIMEOUT_MS rather than to no bound, so a
 * typo'd option cannot quietly remove it.
 *
 * @param {FirebaseFirestore.Firestore} db
 * @param {string} phone  any format — E.164, rep-typed, digits
 * @param {{companyId: string|string[], timeoutMs?: number}} opts
 * @returns {Promise<{optedOut: boolean, key: string, viaLegacyKey: boolean,
 *   source: 'register'|'dnc'|null, companyId?: string}>}
 */
async function isOptedOut(db, phone, opts) {
  const tenants = tenantList(opts && opts.companyId);
  if (!tenants) {
    const e = new Error('isOptedOut needs opts.companyId (whose Do Not Text list applies)');
    e.code = 'optout_no_tenant';
    throw e;
  }

  const asked = Number(opts.timeoutMs);
  const ms = Number.isFinite(asked) && asked > 0 ? asked : module.exports.READ_TIMEOUT_MS;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error('opt-out lookup did not answer within ' + ms + 'ms');
      e.code = 'optout_read_timeout';
      reject(e);
    }, ms);
  });
  try {
    return await Promise.race([lookupOptOut(db, phone, tenants), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupOptOut(db, phone, tenants) {
  const key = optOutKey(phone);
  if (!key) return { optedOut: false, key: '', viaLegacyKey: false, source: null };

  const hit = await db.doc(COLLECTION + '/' + key).get();
  if (hit.exists) return { optedOut: true, key, viaLegacyKey: false, source: 'register' };

  // Pre-migration records only.
  //
  // The legacy key is NOT legacyOptOutKey(phone) — that was the first thing
  // tried and it is wrong, because the caller here is a SEND path holding a
  // rep-typed number, whose plain digit-strip is already the 10-digit form.
  // The stranded records were written by incomingSMS from Twilio's E.164, so
  // what is actually sitting in the collection is the canonical key with the
  // US country code still on the front. Derive the candidate from the KEY, not
  // from the input. (Caught by fixture K8.)
  //
  // legacyOptOutKey(phone) is still checked for the case where the caller
  // itself passes an E.164 string, which the AI-draft path does whenever it
  // falls back to `after.incomingPhone`.
  const candidates = ['1' + key, legacyOptOutKey(phone)]
    .filter((k, i, a) => k && k !== key && a.indexOf(k) === i);

  for (const legacy of candidates) {
    const old = await db.doc(COLLECTION + '/' + legacy).get();
    if (old.exists) return { optedOut: true, key: legacy, viaLegacyKey: true, source: 'register' };
  }

  // The company's own Do Not Text list (canonical key only — the list is new,
  // so it has no legacy records).
  for (const companyId of tenants) {
    const dnc = await db.doc(DNC_COLLECTION + '/' + companyId + '__' + key).get();
    if (dnc.exists) return { optedOut: true, key, viaLegacyKey: false, source: 'dnc', companyId };
  }

  return { optedOut: false, key, viaLegacyKey: false, source: null };
}

/**
 * Record an opt-out under the canonical key.
 * @returns {Promise<string>} the key written
 */
async function recordOptOut(db, phone, fields) {
  const key = optOutKey(phone);
  if (!key) return '';
  await db.doc(COLLECTION + '/' + key).set(Object.assign({ phone }, fields || {}));
  return key;
}

/**
 * Clear an opt-out (START / UNSTOP).
 *
 * Deletes BOTH keys. Deleting only the canonical one would leave a
 * pre-migration record behind that `isOptedOut`'s legacy branch still finds,
 * so a homeowner who explicitly asked to resume would stay silently
 * suppressed — the same silent-wrong-answer failure in the other direction.
 *
 * @returns {Promise<string[]>} the keys attempted
 */
async function clearOptOut(db, phone) {
  const key = optOutKey(phone);
  // Same candidate set isOptedOut searches — including the country-code form,
  // which is where every pre-migration record actually lives.
  const keys = [key, key && '1' + key, legacyOptOutKey(phone)]
    .filter((k, i, a) => k && a.indexOf(k) === i);
  await Promise.all(keys.map((k) => db.doc(COLLECTION + '/' + k).delete().catch(() => {})));
  return keys;
}

function isAlreadyExists(err) {
  return !!err && (err.code === 6 || err.code === 'already-exists'
    || /ALREADY_EXISTS|already exists/i.test(String(err.message || '')));
}

/**
 * Put a number on a company's Do Not Text list. Idempotent: an existing entry
 * is left as it is (a manual add never rewrites a STOP-reply entry, and a
 * second add keeps the first add's date).
 * @returns {Promise<{id: string, created: boolean}>} id '' when unusable
 */
async function addDnc(db, entry, serverTimestamp) {
  const e = entry || {};
  const id = dncDocId(e.companyId, e.phone);
  if (!id) return { id: '', created: false };
  const doc = {
    companyId: cleanTenant(e.companyId),
    key: optOutKey(e.phone),
    // Display copy only, never a key; trimmed so a pasted blob cannot grow it.
    phone: String(e.phone).slice(0, 40),
    source: e.source === 'stop_reply' ? 'stop_reply' : 'manual',
    addedAt: serverTimestamp ? serverTimestamp() : new Date(),
    addedBy: e.byUid || null,
  };
  if (e.note) doc.note = String(e.note).slice(0, 200);
  try {
    await db.doc(DNC_COLLECTION + '/' + id).create(doc);
    return { id, created: true };
  } catch (err) {
    if (isAlreadyExists(err)) return { id, created: false };
    throw err;
  }
}

/**
 * Take a number off a company's list. Only 'manual' entries come off this
 * way: a 'stop_reply' entry is the homeowner's own instruction and only their
 * START removes it (clearStopReplyDnc).
 * @returns {Promise<'removed'|'absent'|'stop_reply'>}
 */
async function removeDnc(db, companyId, phone) {
  const id = dncDocId(companyId, phone);
  if (!id) return 'absent';
  const ref = db.doc(DNC_COLLECTION + '/' + id);
  const snap = await ref.get();
  if (!snap.exists) return 'absent';
  if ((snap.data() || {}).source === 'stop_reply') return 'stop_reply';
  await ref.delete();
  return 'removed';
}

/** A company's list, newest first. Bounded; single-field equality query. */
async function listDnc(db, companyId, limit) {
  const co = cleanTenant(companyId);
  if (!co) return [];
  const n = Math.max(1, Math.min(Number(limit) || 500, 1000));
  const snap = await db.collection(DNC_COLLECTION).where('companyId', '==', co).limit(n).get();
  const ms = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis()
    : (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : 0));
  return snap.docs.map((d) => {
    const x = d.data() || {};
    return {
      key: x.key || '', phone: x.phone || '', source: x.source || 'manual',
      addedAtMs: ms(x.addedAt) || null, note: x.note || '',
    };
  }).sort((a, b) => (b.addedAtMs || 0) - (a.addedAtMs || 0));
}

/**
 * START / UNSTOP: the homeowner's own STOP-reply entries go with the register
 * record. Manual entries stay — a company that decided not to text a number
 * keeps that decision.
 * @returns {Promise<number>} entries removed
 */
async function clearStopReplyDnc(db, phone) {
  const key = optOutKey(phone);
  if (!key) return 0;
  const snap = await db.collection(DNC_COLLECTION).where('key', '==', key).limit(50).get();
  const mine = snap.docs.filter((d) => ((d.data() || {}).source) === 'stop_reply');
  await Promise.all(mine.map((d) => d.ref.delete()));
  return mine.length;
}

module.exports = {
  COLLECTION,
  DNC_COLLECTION,
  READ_TIMEOUT_MS,
  dncDocId,
  addDnc,
  removeDnc,
  listDnc,
  clearStopReplyDnc,
  optOutKey,
  legacyOptOutKey,
  isOptedOut,
  recordOptOut,
  clearOptOut,
};
