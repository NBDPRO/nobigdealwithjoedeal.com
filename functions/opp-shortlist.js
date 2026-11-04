'use strict';
/**
 * opp-shortlist.js — oppShortlistFile: the Thumbtack Opportunities watcher files
 * what it saw (2026-11-04, flag thumbtackOpportunities, ships dark).
 *
 * The watcher (a person pasting an item, or a later read of Jo's own signed-in
 * page) sends plain item objects; this callable scores them with the pure logic
 * (opp-shortlist-logic.js, rules from opp-rules.js plus the owner's opp_rules/_default
 * override) and files ONE `opp_seen` record per Opportunity. It is read-only toward
 * Thumbtack and the rest of the CRM: it contacts nobody, reads nothing from Thumbtack,
 * drafts nothing and sends nothing. Its only write is the opp_seen record.
 *
 *   input   { items: [ item, ... ] }   1 to 25 items; see opp-shortlist-logic.js for the shape.
 *           Only the listed item fields are read; everything else is dropped.
 *   output  { ok:true, status:'done'|'not_allowed', code?, message?, counts, inWatcherHours,
 *             results:[{ index, oppId, status:'filed'|'already_seen'|'write_failed', decision,
 *                        score, reason, reasons, flags, tradeLabel, zone, miles }] }
 *   throws  unauthenticated, permission-denied (not the owner; viewer / anonymous),
 *           invalid-argument (no items, too many, not an array), resource-exhausted (rate limit),
 *           unavailable (a settings read failed: fail closed).
 *
 * Who: OWNER ONLY (opp-access.js ownerOf). App Check enforced like its neighbours.
 * Flag off, or killSwitch in opp_rules/_default: answers not_allowed and files nothing.
 *
 * What is stored (opp_seen/{companyId}_{oppId}, written with create(), so the first sighting
 * wins and a re-scan answers 'already_seen'): the decision, the score, our own reasons, fixed
 * trade and tag vocabulary, a validated 5 digit ZIP, a letters-only city, the miles to the
 * nearer base, pros already in, photo count. NO name, phone, address, link or free text from
 * the Opportunity is stored or returned: a stranger's words only ever pick a tag from our own list.
 * expireAt is 90 days out; the delete job that honours it is not built in this PR.
 *
 * Logs counts only.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { enforceRateLimit } = require('./integrations/upstash-ratelimit');
const Access = require('./opp-access');
const L = require('./opp-shortlist-logic');

const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app'];
const CALLS_PER_HOUR = 30;
const MAX_ITEMS = 25;
const RETAIN_MS = 90 * 24 * 3600000;
const db = () => getFirestore();

const MESSAGES = Object.freeze({
  done: 'Filed. Nothing was sent and nothing was read from Thumbtack.',
  feature_off: Access.MESSAGES.feature_off,
  kill_switch: Access.MESSAGES.kill_switch,
});

const ITEM_KEYS = ['oppId', 'category', 'city', 'state', 'zip', 'lat', 'lng', 'distanceMiles', 'milesByBase', 'postedAgeMin', 'prosAlready', 'photos', 'description', 'ownerOccupied', 'vacant', 'outOfState'];

/** Only the known item fields, as own properties of a fresh object. */
function pickItem(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of ITEM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) out[k] = raw[k];
  }
  if (out.milesByBase && typeof out.milesByBase === 'object') {
    const m = out.milesByBase;
    out.milesByBase = { goshen: Object.prototype.hasOwnProperty.call(m, 'goshen') ? m.goshen : undefined, cincinnati: Object.prototype.hasOwnProperty.call(m, 'cincinnati') ? m.cincinnati : undefined };
  } else delete out.milesByBase;
  return out;
}

const zipOf = (v) => (typeof v === 'string' && /^\d{5}$/.test(v.trim()) ? v.trim() : null);
const cityOf = (v) => (typeof v === 'string' && /^[A-Za-z][A-Za-z .'-]{0,59}$/.test(v.trim()) ? v.trim() : null);

/** The opp_seen document for one scored result. Nothing from the Opportunity's own words is copied in. */
function seenDoc(r, item, c, nowMs) {
  return {
    companyId: c.company, filedBy: c.uid, oppId: r.oppId,
    seenAt: FieldValue.serverTimestamp(), expireAt: new Date(nowMs + RETAIN_MS),
    postedAgeMin: r.ageMin, category: r.tradeLabel || 'Other', tradeKey: r.tradeKey || 'other',
    zip: zipOf(item.zip), city: cityOf(item.city),
    milesNearestBase: r.miles, baseUsed: r.baseUsed, zone: r.zone,
    prosAlready: r.pros, photos: r.photos,
    summary: r.tags.join(', ').slice(0, 200),
    score: r.score, decision: r.decision,
    reasons: r.reasons.slice(0, 8).map((s) => String(s).slice(0, 200)),
    flags: r.flags.slice(0, 8), rulesVersion: r.rulesVersion,
  };
}

async function oppShortlistFile(request) {
  const c = Access.ownerOf(request);
  const data = request.data || {};
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > MAX_ITEMS) {
    throw new HttpsError('invalid-argument', 'items must be a list of 1 to ' + MAX_ITEMS + ' opportunities.');
  }
  const g = await Access.gate(db(), c);
  if (!g.ok) {
    logger.info('[oppShortlistFile] skipped', { why: g.code });
    return { ok: true, status: 'not_allowed', code: g.code, message: g.message };
  }
  try {
    await enforceRateLimit('callable:oppShortlistFile:uid', c.uid, CALLS_PER_HOUR, 60 * 60000);
  } catch (e) {
    if (e && e.rateLimited) throw new HttpsError('resource-exhausted', 'Too many calls this hour. Try again later.');
    throw e;
  }

  const now = Date.now();
  const items = data.items.map(pickItem);
  for (const it of items) it.oppId = L.oppIdFor(it, now);
  const sl = L.shortlist(items, { rules: g.rules });

  const results = [];
  for (const r of sl.results) {
    const item = items[r.index];
    const docId = L.docIdFor(c.company, r.oppId);
    let status = 'filed';
    if (!docId) status = 'write_failed';
    else {
      try {
        await db().doc('opp_seen/' + docId).create(seenDoc(r, item, c, now));
      } catch (e) {
        if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) status = 'already_seen';
        else { status = 'write_failed'; logger.warn('[oppShortlistFile] write failed', { msg: e && e.message }); }
      }
    }
    results.push({
      index: r.index, oppId: r.oppId, status, decision: r.decision, score: r.score, reason: r.reason, reasons: r.reasons.slice(0, 8),
      flags: r.flags, tradeLabel: r.tradeLabel, zone: r.zone, miles: r.miles,
    });
  }
  logger.info('[oppShortlistFile] done', { show: sl.counts.SHOW, hold: sl.counts.HOLD, skip: sl.counts.SKIP, n: results.length });
  return { ok: true, status: 'done', message: MESSAGES.done, counts: sl.counts, inWatcherHours: L.inWatcherHours(now, g.rules), results };
}

exports.oppShortlistFile = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 30, memory: '256MiB' },
  require('./tenant-guard').wrapCallable(oppShortlistFile)
);
exports._internal = { oppShortlistFile, pickItem, seenDoc, MESSAGES, ITEM_KEYS };
