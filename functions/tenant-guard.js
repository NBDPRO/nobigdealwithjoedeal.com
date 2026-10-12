/**
 * functions/tenant-guard.js — the one place that decides whether a token with
 * NO companyId claim may fall back to "my own uid is my company".
 *
 * Why (owner hand-off, 2026-10-12): `claims.companyId || uid` is computed at
 * ~30 call sites and has always meant "a solo operator's company is keyed by
 * their uid". After transferCompanyOwnership the company keeps its id, so a
 * FORMER owner whose claims were stripped (removed, still enabled, or
 * re-enabled by hand) would fall through every one of those fallbacks as the
 * owner of a company that belongs to someone else. This guard refuses that
 * shape at the entry points instead of patching 30 fallbacks one by one:
 *
 *   ghost = token has no companyId claim, is not a platform admin, and
 *           companies/{uid} exists naming a DIFFERENT ownerId.
 *
 * A real solo owner (no company doc, or a doc naming them) is never a ghost.
 * One cached Firestore read per uid per 30 s, only for claim-less tokens.
 * Fails OPEN on a read error (a solo owner must not be locked out by an
 * outage; the rules, requireTeamAdmin and the removal-time disable are the
 * other layers).
 */
'use strict';

const TTL_MS = 30000;
const cache = new Map();

const GHOST_MESSAGE = 'This account no longer belongs to a company. Sign in with a new account, or ask the company owner to invite you.';

function _db(db) {
  if (db) return db;
  return require('firebase-admin/firestore').getFirestore();
}

/** Pure: does this claim set have the shape that falls back to the uid key? */
function claimlessShape(claims) {
  const c = claims || {};
  return !c.companyId && c.role !== 'admin';
}

async function isGhost(uid, claims, db) {
  if (!uid || typeof uid !== 'string' || !claimlessShape(claims)) return false;
  const now = Date.now();
  const hit = cache.get(uid);
  if (hit && now - hit.at < TTL_MS) return hit.ghost;
  let ghost = false;
  try {
    const snap = await _db(db).collection('companies').doc(uid).get();
    const ownerId = snap.exists ? ((snap.data() || {}).ownerId || null) : null;
    ghost = !!ownerId && ownerId !== uid;
  } catch (e) {
    return false; // fail open, see header
  }
  cache.set(uid, { at: now, ghost });
  if (cache.size > 2000) cache.clear();
  return ghost;
}

/** onCall: throw permission-denied for a ghost. */
async function assertNotGhost(request, db) {
  const a = request && request.auth;
  if (!a || !a.uid) return;
  if (await isGhost(a.uid, a.token || {}, db)) {
    const { HttpsError } = require('firebase-functions/v2/https');
    throw new HttpsError('permission-denied', GHOST_MESSAGE);
  }
}

/** onRequest: returns { status, body } for a ghost, else null. `decoded` is the ID token. */
async function ghostRefusal(decoded, db) {
  if (!decoded) return null;
  if (await isGhost(decoded.uid, decoded, db)) return { status: 403, body: { error: GHOST_MESSAGE, code: 'no-company' } };
  return null;
}

/** Wrap an onCall handler so a ghost is refused before it runs. */
function wrapCallable(fn) {
  return async function guarded(request) {
    await assertNotGhost(request);
    return fn(request);
  };
}

function _resetCache() { cache.clear(); }

module.exports = { isGhost, assertNotGhost, ghostRefusal, wrapCallable, claimlessShape, GHOST_MESSAGE, _resetCache };
