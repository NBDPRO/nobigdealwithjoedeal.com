/**
 * health-shortcut.js — Apple Health weight into the Daily Success tracker via
 * an iPhone Shortcut (research idea #9, 2026-10-20). DARK until Jo turns it on.
 *
 *   healthShortcutManage (onCall)    the tracker's settings card: status /
 *                                    create (also rotates) / off. The key is
 *                                    returned ONCE, in the create response.
 *   healthShortcutIngest (onRequest) the Shortcut's POST. Authorization:
 *                                    Bearer <key>, JSON {date, weightLbs,
 *                                    sleepHours?}. NOT a browser endpoint:
 *                                    no CORS, POST only.
 *
 * Threat model (a short version; the long one is in
 * documentation/runbooks/HEALTH-SHORTCUT.md):
 *   - Guessing a key: 256 random bits, SHA-256 at rest, per-IP limit first.
 *   - A leaked key: it can only set one user's weight for dates in a 400-day
 *     window; capped at 10/hour and 50/day, and one tap of Rotate or Turn off
 *     kills it at once (the lookup doc is deleted, not flagged).
 *   - A database leak: only hashes are stored, in collections the rules deny
 *     to every client (health_shortcut_keys, health_shortcut_state).
 *   - Log leaks: nothing logs a token, a header or a body; only uid prefix,
 *     status and date.
 *   - Clobbering Jo's own data: only data['bm-wt'] (+ the hw marker) is merged;
 *     a weight he typed is never overwritten and a deleted day is never
 *     resurrected (health-shortcut-logic.js decidePageWrite).
 *
 * Gates, in order: POST only -> kill switch (HEALTH_SHORTCUT_DISABLED=true) ->
 * system/healthShortcut {enabled:true, allowedUids?:[...]} (Jo flips it in the
 * Firebase console; absent = off = 404, the endpoint is inert and writes
 * nothing, not even a limiter doc) -> per-IP limit -> size and content-type ->
 * key -> per-key limit -> body -> per-user daily cap (well-formed readings
 * only) -> write. Turn off works even while the flag is off.
 *
 * Sleep: the day page has no sleep-hours field today (l-sleep is a checkbox),
 * so v1 validates sleepHours and discards it. The response says so.
 */
'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { httpRateLimit, enforceRateLimit } = require('./integrations/upstash-ratelimit');
const { callableRateLimit } = require('./shared');
const L = require('./health-shortcut-logic');

const KEYS = 'health_shortcut_keys';     // doc id = SHA-256 hex of the key -> { uid, createdAt }
const STATE = 'health_shortcut_state';   // doc id = uid -> { keyHash, enabled, last* }
const FLAG_DOC = 'system/healthShortcut';
const ENDPOINT_URL = 'https://us-central1-nobigdeal-pro.cloudfunctions.net/healthShortcutIngest';

const IP_LIMIT = 20, IP_WINDOW = 10 * 60_000;
const KEY_LIMIT = 10, KEY_WINDOW = 60 * 60_000;
const DAY_WINDOW = 24 * 60 * 60_000;

const realDeps = () => ({
  db: getFirestore(),
  httpRateLimit,
  enforceRateLimit,
  logger,
  now: () => Date.now(),
  // Read here (not passed as a bag of env) so cron-gate-drift sees the literal name.
  killed: () => process.env.HEALTH_SHORTCUT_DISABLED === 'true',
});

// The flag doc: { enabled:true, allowedUids?:[uid,...] }. With allowedUids set,
// only those accounts may create a key or write a reading (flag-wide otherwise).
async function readFlag(d) {
  if (d.killed()) return null;
  try {
    const s = await d.db.doc(FLAG_DOC).get();
    const x = s.exists ? s.data() : null;
    return x && x.enabled === true ? x : null;
  } catch (e) { return null; }   // fail closed
}
const permits = (flag, uid) => !!flag && (!Array.isArray(flag.allowedUids) || flag.allowedUids.length === 0 || flag.allowedUids.includes(uid));

// ── the Shortcut's POST ───────────────────────────────────────────────────
function makeIngest(getDeps) {
  return async function ingest(req, res) {
    const d = getDeps();
    const send = (code, body) => {
      res.set('Cache-Control', 'no-store');
      res.status(code).json(body);
    };

    if (req.method !== 'POST') { res.set('Allow', 'POST'); send(405, { error: 'method_not_allowed' }); return; }
    if (d.killed()) { send(404, { error: 'not_found' }); return; }
    // Flag BEFORE the limiter: while dark nothing is written, not even a limiter doc.
    const flag = await readFlag(d);
    if (!flag) { send(404, { error: 'not_found' }); return; }
    if (!(await d.httpRateLimit(req, res, 'healthshortcut:ip', IP_LIMIT, IP_WINDOW))) return;

    // Size and type come before the body is looked at.
    const raw = req.rawBody;
    const len = Number(req.headers && req.headers['content-length']);
    if ((isFinite(len) && len > L.MAX_BODY_BYTES) || (raw && raw.length > L.MAX_BODY_BYTES)) { send(400, { error: 'bad_request' }); return; }
    if (!/^application\/json\b/i.test(String((req.headers && req.headers['content-type']) || ''))) { send(400, { error: 'bad_request' }); return; }

    const token = L.parseBearer(req.headers && req.headers.authorization);
    if (!token) { send(401, { error: 'unauthorized' }); return; }
    const hash = L.hashToken(token);

    let keyDoc;
    try { keyDoc = await d.db.doc(KEYS + '/' + hash).get(); }
    catch (e) { d.logger.error('healthShortcut: key read failed'); send(503, { error: 'unavailable' }); return; }
    const key = keyDoc.exists ? keyDoc.data() : null;
    if (!key || !L.safeEqualHex(key.hash, hash) || typeof key.uid !== 'string' || !key.uid) { send(401, { error: 'unauthorized' }); return; }
    const uid = key.uid;
    const tag = uid.slice(0, 6);
    if (!permits(flag, uid)) { send(401, { error: 'unauthorized' }); return; }

    try {
      await d.enforceRateLimit('healthshortcut:key', hash, KEY_LIMIT, KEY_WINDOW);
    } catch (e) {
      if (e && e.rateLimited) {
        d.logger.warn('healthShortcut: rate limited', { uid: tag });
        res.set('Retry-After', String(Math.ceil((e.retryAfterMs || KEY_WINDOW) / 1000)));
        send(429, { error: 'too_many_requests' });
        return;
      }
      d.logger.error('healthShortcut: limiter failed', { uid: tag });
      send(503, { error: 'unavailable' });
      return;
    }

    const now = d.now();
    const v = L.validateBody(req.body, now);
    if (!v.ok) { d.logger.info('healthShortcut: rejected', { uid: tag, status: 400 }); send(400, { error: 'bad_request' }); return; }

    // The daily cap counts only well-formed readings, so a leaked key cannot
    // burn the owner's day with junk bodies (the per-key hourly cap covers those).
    try {
      await d.enforceRateLimit('healthshortcut:day', uid, L.DAILY_CAP, DAY_WINDOW);
    } catch (e) {
      if (e && e.rateLimited) {
        d.logger.warn('healthShortcut: daily cap', { uid: tag });
        res.set('Retry-After', String(Math.ceil((e.retryAfterMs || DAY_WINDOW) / 1000)));
        send(429, { error: 'too_many_requests' });
        return;
      }
      d.logger.error('healthShortcut: limiter failed', { uid: tag });
      send(503, { error: 'unavailable' });
      return;
    }

    let result;
    try {
      result = await d.db.runTransaction(async (tx) => {
        const stRef = d.db.doc(STATE + '/' + uid);
        const st = await tx.get(stRef);
        const sd = st.exists ? st.data() : null;
        // Rotation or Turn off between the key lookup and here: the state doc
        // names the ONE live key, so a stale lookup cannot write.
        if (!sd || sd.enabled !== true || !L.safeEqualHex(sd.keyHash, hash)) return { revoked: true };
        const q = await tx.get(d.db.collection('users/' + uid + '/ds_pages').where('dk', '==', v.date));
        const pages = [];
        q.forEach((p) => pages.push({ id: p.id, data: p.data() }));
        const decision = L.decidePageWrite(pages, v.weightStr);
        let outcome = decision.action === 'skip' ? decision.reason : 'written';
        if (decision.action === 'create') {
          const page = L.newPageShape(uid, v.date, v.weightStr, now);
          tx.set(d.db.doc('users/' + uid + '/ds_pages/' + String(page.id)), Object.assign({}, page, { _updatedAt: FieldValue.serverTimestamp() }));
        } else if (decision.action === 'update') {
          // Merge ONLY the weight, its marker and the change stamp: every other
          // field on the page (food, workouts, notes) is left exactly as it is.
          tx.set(d.db.doc('users/' + uid + '/ds_pages/' + decision.id), {
            data: { 'bm-wt': v.weightStr }, hw: { wt: v.weightStr, at: now }, mt: now, _uid: uid, _updatedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        }
        tx.set(stRef, { lastAt: now, lastDate: v.date, lastWeightLbs: v.weightLbs, lastResult: outcome }, { merge: true });
        return { outcome };
      });
    } catch (e) {
      d.logger.error('healthShortcut: write failed', { uid: tag });
      send(503, { error: 'unavailable' });
      return;
    }
    if (result.revoked) { send(401, { error: 'unauthorized' }); return; }
    d.logger.info('healthShortcut: ok', { uid: tag, status: 200, date: v.date, result: result.outcome });
    send(200, { ok: true, result: result.outcome, sleepStored: false });
  };
}

// ── the settings card's calls ─────────────────────────────────────────────
async function manageCore(d, uid, action) {
  const flag = await readFlag(d);
  const on = permits(flag, uid);
  const stRef = d.db.doc(STATE + '/' + uid);
  const view = (sd) => ({
    available: true,
    enabled: !!(sd && sd.enabled === true && sd.keyHash),
    createdAt: (sd && sd.createdAt) || null,
    lastAt: (sd && sd.lastAt) || null,
    lastDate: (sd && sd.lastDate) || null,
    lastWeightLbs: sd && typeof sd.lastWeightLbs === 'number' ? sd.lastWeightLbs : null,
    lastResult: (sd && sd.lastResult) || null,
    endpoint: ENDPOINT_URL,
  });
  const snapshot = async () => { const s = await stRef.get(); return s.exists ? s.data() : null; };

  if (action === 'status') {
    if (!on) return { available: false, enabled: false };
    return view(await snapshot());
  }
  // Turn off always works, even with the flag off or the kill switch on: a key
  // leaked during an incident must be revocable during the incident.
  if (!on && action !== 'off') throw Object.assign(new Error('off'), { code: 'failed-precondition' });

  if (action === 'create') {
    const token = L.mintToken();
    const hash = L.hashToken(token);
    const now = d.now();
    await d.db.runTransaction(async (tx) => {
      const cur = await tx.get(stRef);
      const old = cur.exists ? cur.data() : null;
      if (old && L.isHashHex(old.keyHash)) tx.delete(d.db.doc(KEYS + '/' + old.keyHash));   // rotating: the old key dies in the same commit
      tx.set(d.db.doc(KEYS + '/' + hash), { uid, hash, createdAt: now });
      tx.set(stRef, { keyHash: hash, enabled: true, createdAt: now, lastAt: null, lastDate: null, lastWeightLbs: null, lastResult: null });
    });
    return Object.assign(view(await snapshot()), { token });
  }
  if (action === 'off') {
    await d.db.runTransaction(async (tx) => {
      const cur = await tx.get(stRef);
      const old = cur.exists ? cur.data() : null;
      if (old && L.isHashHex(old.keyHash)) tx.delete(d.db.doc(KEYS + '/' + old.keyHash));
      tx.set(stRef, { keyHash: FieldValue.delete(), enabled: false }, { merge: true });
    });
    return view(await snapshot());
  }
  throw Object.assign(new Error('bad action'), { code: 'invalid-argument' });
}

exports.healthShortcutIngest = onRequest(
  { region: 'us-central1', maxInstances: 5, timeoutSeconds: 15, memory: '256MiB' },
  makeIngest(realDeps)
);

const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app'];

exports.healthShortcutManage = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    const action = String((request.data && request.data.action) || '');
    await callableRateLimit(request, 'healthShortcutManage', 20, 60 * 60_000);
    try {
      return await manageCore(realDeps(), uid, action);
    } catch (e) {
      if (e && e.code === 'failed-precondition') throw new HttpsError('failed-precondition', 'The Health Shortcut is not turned on yet.');
      if (e && e.code === 'invalid-argument') throw new HttpsError('invalid-argument', 'Unknown action');
      logger.error('[healthShortcutManage] failed', { uid: uid.slice(0, 6), err: e && e.message });
      throw new HttpsError('internal', 'Could not update the Shortcut key. Try again.');
    }
  }
);

// Test seams (not Cloud Functions: no __endpoint, so the function map skips them).
exports._makeIngest = makeIngest;
exports._manageCore = manageCore;
exports._FLAG_DOC = FLAG_DOC;
