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
const TextingGate = require('./sms-texting-gate');

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
 *
 * LIFTED, NOT DELETED (Jo, 2026-10-07). When a homeowner who asked a company
 * not to text them later says texting is OK, the owner or a company_admin
 * lifts the company's OWN entry from the CRM with a required reason
 * (liftDnc). The doc stays, marked
 *     { lifted: true, liftedAt, liftedBy, liftedRole, liftReason }
 * and every lift / reinstate is appended to `history` (the audit trail:
 * who, when, why, what the entry was). A lifted entry blocks nothing. A new
 * STOP or manual add on the same number reinstates it (addDnc).
 *
 * Liftable (liftEligibility): a 'manual' entry, or a 'stop_reply' entry the
 * company recorded itself from its own phone (stopLine 'owner_phone' with
 * stopCompanyId = this company; or, before R6-3-5, OWNER_STOP_NOTE). NEVER a
 * STOP the homeowner texted to NBD's Twilio number (stopLine 'twilio', or an
 * unattributed older stop_reply): the carrier holds that one too, and only
 * their START reply lifts it (CTIA / TCPA).
 */
const DNC_COLLECTION = 'sms_dnc';

/**
 * WHO WAS TOLD STOP (review R6-3-5, 2026-10-07). A START re-subscribes the
 * homeowner to the sender they texted START to (CTIA) — never to a different
 * company that was told STOP somewhere else. So every stop_reply entry says
 * which sender received the STOP:
 *
 *   'twilio'       NBD's Twilio number (incomingSMS / twilio-line.js). The
 *                  number is shared by every tenant's sends, so its STOP goes
 *                  in the global register and is copied to every company
 *                  holding the number; a START to the same number lifts it.
 *   'owner_phone'  "They replied STOP" — the STOP reached a company owner's
 *                  OWN phone (phone-text-check.js `stop`). It is that
 *                  company's STOP only (stopCompanyId), never the register;
 *                  a START to NBD's number lifts it only when that company is
 *                  NBD (the number's owner, liftStopOnLine lineCompanyId).
 *
 * Entries written before this have no stopLine; liftStopOnLine reads the
 * CRM note / the register to tell them apart, and keeps (and flags) any it
 * cannot attribute.
 */
const STOP_LINE_TWILIO = 'twilio';
const STOP_LINE_OWNER_PHONE = 'owner_phone';
// phone-text-check.js's note on the reporting company's own entry, which is
// how a pre-R6-3-5 owner-reported entry is recognised.
const OWNER_STOP_NOTE = 'They replied STOP (recorded from the CRM)';

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
    // A lifted entry is history, not a block (liftDnc) — strictly `true`, so
    // a malformed flag never un-blocks anyone.
    if (dnc.exists && (dnc.data() || {}).lifted !== true) {
      // dncSource: 'stop_reply' = the homeowner's own STOP (a caller may say
      // "they replied STOP" rather than "on your Do Not Text list").
      const dncSource = ((dnc.data() || {}).source) === 'stop_reply' ? 'stop_reply' : 'manual';
      return { optedOut: true, key, viaLegacyKey: false, source: 'dnc', companyId, dncSource };
    }
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
  // Which sender the STOP was given to (R6-3-5) — only on a stop_reply entry.
  const ownerStop = doc.source === 'stop_reply' && e.stopLine === STOP_LINE_OWNER_PHONE;
  if (doc.source === 'stop_reply') {
    doc.stopLine = ownerStop ? STOP_LINE_OWNER_PHONE : STOP_LINE_TWILIO;
    if (ownerStop) doc.stopCompanyId = cleanTenant(e.stopCompanyId) || doc.companyId;
  }
  if (e.note) doc.note = String(e.note).slice(0, 200);
  const ref = db.doc(DNC_COLLECTION + '/' + id);
  try {
    await ref.create(doc);
    return { id, created: true };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    // The entry is there but LIFTED (liftDnc): a new STOP or a new "don't
    // text them" puts it back in force. The doc is rewritten as this new
    // entry; its history (the earlier lift) is kept and the reinstatement
    // appended. In a transaction, so a lift landing at the same moment can't
    // leave the number un-blocked.
    const reinstated = await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const x = cur.exists ? (cur.data() || {}) : null;
      if (!x || x.lifted !== true) return false;
      tx.set(ref, Object.assign({}, doc, {
        lifted: false,
        history: appendHistory(x.history, {
          action: 'reinstated', atMs: Date.now(), byUid: doc.addedBy,
          source: doc.source, stopLine: doc.stopLine || null,
        }),
      }));
      return true;
    });
    if (reinstated) return { id, created: false, reinstated: true };
    // A STOP told to this company's own phone outranks whatever entry is
    // there already (a manual add, or a copy of a business-line STOP that a
    // START on that line would lift): it becomes the company's own STOP, which
    // only the company's own sender can lift. Date and adder are kept.
    if (ownerStop) {
      const cur = await ref.get();
      const x = cur.exists ? (cur.data() || {}) : {};
      if (!(x.source === 'stop_reply' && x.stopLine === STOP_LINE_OWNER_PHONE)) {
        const up = { source: 'stop_reply', stopLine: STOP_LINE_OWNER_PHONE, stopCompanyId: doc.stopCompanyId };
        if (doc.note) up.note = doc.note;
        await ref.update(up);
        return { id, created: false, upgraded: true };
      }
    }
    return { id, created: false };
  }
}

const HISTORY_MAX = 50;
/** history + one event, oldest dropped past HISTORY_MAX (a doc stays small). */
function appendHistory(prev, ev) {
  const list = Array.isArray(prev) ? prev.slice() : [];
  list.push(ev);
  return list.slice(-HISTORY_MAX);
}

/**
 * May `companyId` lift this entry from the CRM? (Jo, 2026-10-07)
 *
 *   ok      a 'manual' entry, or a STOP the company recorded itself from its
 *           own phone (owner_phone, stopCompanyId = companyId; pre-R6-3-5:
 *           OWNER_STOP_NOTE with no stopLine).
 *   reason  'stop_reply_line'  the homeowner texted STOP to NBD's Twilio
 *                              number (or an older STOP nobody can attribute):
 *                              only their START reply lifts it.
 *           'other_company'    not this company's entry.
 *           'lifted'           already lifted.
 *
 * @returns {{ok: boolean, reason: string|null}}
 */
function liftEligibility(entry, companyId) {
  const x = entry || {};
  const co = cleanTenant(companyId);
  if (!co || cleanTenant(x.companyId) !== co) return { ok: false, reason: 'other_company' };
  if (x.lifted === true) return { ok: false, reason: 'lifted' };
  if (x.source !== 'stop_reply') return { ok: true, reason: null };
  if (x.stopLine === STOP_LINE_OWNER_PHONE) {
    return (cleanTenant(x.stopCompanyId) || co) === co
      ? { ok: true, reason: null } : { ok: false, reason: 'other_company' };
  }
  if (!x.stopLine && x.note === OWNER_STOP_NOTE) return { ok: true, reason: null };
  return { ok: false, reason: 'stop_reply_line' };
}

/**
 * Lift a company's own Do Not Text entry: the homeowner said texting is OK
 * again (Jo, 2026-10-07). The caller has already checked the role (owner /
 * company_admin — sms-dnc.js). The entry is MARKED lifted, never deleted,
 * with the reason, who and when, and the event appended to `history`.
 *
 * In a transaction: eligibility is decided on the doc as it is at write time,
 * so a STOP that lands meanwhile is never overwritten by a lift.
 *
 * @param {{companyId: string, phone: string, byUid: string, role?: string,
 *   reason: string, serverTimestamp?: Function}} args
 * @returns {Promise<{result: 'lifted'|'absent'|'not_liftable', why?: string}>}
 */
async function liftDnc(db, args) {
  const a = args || {};
  const id = dncDocId(a.companyId, a.phone);
  const reason = String(a.reason == null ? '' : a.reason).trim().slice(0, 300);
  if (!id) return { result: 'absent' };
  if (!reason) throw new Error('liftDnc needs a reason');
  const ref = db.doc(DNC_COLLECTION + '/' + id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { result: 'absent' };
    const x = snap.data() || {};
    const elig = liftEligibility(x, a.companyId);
    if (!elig.ok) return { result: 'not_liftable', why: elig.reason };
    const role = String(a.role || '').slice(0, 40) || 'owner';
    tx.update(ref, {
      lifted: true,
      liftedAt: a.serverTimestamp ? a.serverTimestamp() : new Date(),
      liftedBy: a.byUid || null,
      liftedRole: role,
      liftReason: reason,
      history: appendHistory(x.history, {
        action: 'lifted', atMs: Date.now(), byUid: a.byUid || null, role, reason,
        source: x.source || 'manual', stopLine: x.stopLine || null,
      }),
    });
    return { result: 'lifted' };
  });
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
    const elig = liftEligibility(x, co);
    const lifted = x.lifted === true;
    return {
      key: x.key || '', phone: x.phone || '', source: x.source || 'manual',
      addedAtMs: ms(x.addedAt) || null, note: x.note || '',
      // 'owner_phone' | 'twilio' | null — how the CRM words a STOP entry.
      stopLine: x.stopLine || (x.source === 'stop_reply' && x.note === OWNER_STOP_NOTE ? STOP_LINE_OWNER_PHONE : null),
      // Whether the owner / a company_admin may lift it, and if not, why.
      liftable: elig.ok, liftBlock: elig.ok ? null : elig.reason,
      lifted,
      liftedAtMs: lifted ? (ms(x.liftedAt) || null) : null,
      liftReason: lifted ? String(x.liftReason || '') : '',
    };
  }).sort((a, b) => (b.addedAtMs || 0) - (a.addedAtMs || 0));
}

/**
 * Every stop_reply entry for a number, for every company. NOT what an inbound
 * START uses any more: that is liftStopOnLine (R6-3-5), which keeps another
 * company's owner-phone STOP. Manual entries stay — a company that decided
 * not to text a number keeps that decision.
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

/**
 * A homeowner's STOP, copied onto the Do Not Text list of each company that
 * has a lead with this number ('stop_reply'), so each company SEES who stopped
 * it — the global register (recordOptOut) is what enforces it. Shared by every
 * inbound STOP path: incomingSMS (sms-functions.js) and NBD's Twilio line
 * (twilio-line.js). Bounded (10 leads); NEVER throws — a failure here must
 * never undo the opt-out or block the confirmation. Errors go to opts.onError.
 *
 * @param {{serverTimestamp?: Function, onError?: Function}} [opts]
 * @returns {Promise<string[]>} the tenant keys the STOP was copied to
 */
async function copyStopToTenantLists(db, phone, opts) {
  const o = opts || {};
  const fail = (e) => { try { if (o.onError) o.onError(e); } catch (_) { /* never throw */ } };
  const key = optOutKey(phone);
  if (!key) return [];
  try {
    const snap = await db.collection('leads').where('phoneDigits', '==', key).limit(10).get();
    const tenants = [...new Set(snap.docs.map((d) => TextingGate.tenantKeyOfRecord(d.data() || {})).filter(Boolean))];
    await Promise.all(tenants.map((companyId) => addDnc(db, {
      companyId, phone, source: 'stop_reply', stopLine: STOP_LINE_TWILIO,
    }, o.serverTimestamp).catch(fail)));
    return tenants;
  } catch (e) {
    fail(e);
    return [];
  }
}

/**
 * START / UNSTOP to NBD's Twilio number (incomingSMS, twilio-line.js) —
 * review R6-3-5, 2026-10-07. Lifts only what THAT number was told:
 *
 *   - the register docs, both key shapes (the clearOptOut set): the number's
 *     own STOP list;
 *   - stop_reply Do Not Text entries from its STOPs (stopLine 'twilio');
 *   - an 'owner_phone' entry only when its company is the number's owner
 *     (opts.lineCompanyId — NBD), since that is the same sender.
 *
 * Never lifted: a company's manual entries, and another company's
 * owner_phone STOP — company A's "They replied STOP" stays when the homeowner
 * texts START to NBD's number. A pre-R6-3-5 entry it cannot attribute is
 * KEPT, not guessed at, and flagged: `startSeenAt` / `startSeenLine` on the
 * doc and its path in `kept` (the callers log it).
 *
 * A pre-R6-3-5 owner-reported REGISTER doc (match 'owner_reported') was one
 * company's STOP written into the global register. It moves to that
 * company's own list (owner_phone) and leaves the register: the reporting
 * company is still held, the number's other companies no longer are. With no
 * usable reportedCompanyId it is kept and flagged.
 *
 * Throws on a Firestore error (the callers catch and log; a START that does
 * not land leaves the homeowner suppressed, never texted).
 *
 * @param {{line?: string, lineCompanyId?: string, serverTimestamp?: Function}} [opts]
 * @returns {Promise<{cleared: string[], kept: string[]}>} doc paths
 */
async function liftStopOnLine(db, phone, opts) {
  const o = opts || {};
  const line = String(o.line || STOP_LINE_TWILIO).slice(0, 40);
  const lineCo = cleanTenant(o.lineCompanyId);
  const key = optOutKey(phone);
  const out = { cleared: [], kept: [] };
  if (!key) return out;
  const flag = () => ({ startSeenAt: o.serverTimestamp ? o.serverTimestamp() : new Date(), startSeenLine: line });
  const keep = async (ref) => {
    out.kept.push(ref.path);
    // The flag is a note on the record; failing to write it changes nothing.
    await ref.update(flag()).catch(() => {});
  };
  const clear = async (ref) => { await ref.delete(); out.cleared.push(ref.path); };

  // 1. The register.
  const regKeys = [key, '1' + key, legacyOptOutKey(phone)].filter((k, i, a) => k && a.indexOf(k) === i);
  let ownerRegister = false;
  for (const k of regKeys) {
    const ref = db.doc(COLLECTION + '/' + k);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const r = snap.data() || {};
    if (r.match !== 'owner_reported') { await clear(ref); continue; }
    ownerRegister = true;
    const co = cleanTenant(r.reportedCompanyId);
    if (!co) { await keep(ref); continue; }
    if (co !== lineCo) {
      // Keep the reporting company held — on its own list — before the
      // register doc goes.
      await addDnc(db, {
        companyId: co, phone, source: 'stop_reply', stopLine: STOP_LINE_OWNER_PHONE, stopCompanyId: co,
        byUid: r.reportedBy || null, note: OWNER_STOP_NOTE,
      }, o.serverTimestamp);
    }
    await clear(ref);
  }

  // 2. The Do Not Text entries for the number.
  const snap = await db.collection(DNC_COLLECTION).where('key', '==', key).limit(50).get();
  for (const d of snap.docs) {
    const x = d.data() || {};
    if (x.source !== 'stop_reply') continue; // a company's own decision stays
    // Already lifted from the CRM (liftDnc): it blocks nothing, and deleting
    // it would throw away its audit history.
    if (x.lifted === true) continue;
    let stopLine = x.stopLine;
    let stopCo = cleanTenant(x.stopCompanyId);
    if (!stopLine) {
      // Written before R6-3-5.
      if (x.note === OWNER_STOP_NOTE) { stopLine = STOP_LINE_OWNER_PHONE; stopCo = cleanTenant(x.companyId); }
      else if (ownerRegister) { await keep(d.ref); continue; } // a copy of an owner report, or of a line STOP: can't tell
      else stopLine = STOP_LINE_TWILIO;
    }
    if (stopLine === STOP_LINE_OWNER_PHONE) {
      if (lineCo && stopCo === lineCo) await clear(d.ref);
      else await keep(d.ref);
      continue;
    }
    await clear(d.ref);
  }
  return out;
}

module.exports = {
  COLLECTION,
  DNC_COLLECTION,
  STOP_LINE_TWILIO,
  STOP_LINE_OWNER_PHONE,
  OWNER_STOP_NOTE,
  liftStopOnLine,
  READ_TIMEOUT_MS,
  dncDocId,
  addDnc,
  liftDnc,
  liftEligibility,
  listDnc,
  clearStopReplyDnc,
  copyStopToTenantLists,
  optOutKey,
  legacyOptOutKey,
  isOptedOut,
  recordOptOut,
  clearOptOut,
};
