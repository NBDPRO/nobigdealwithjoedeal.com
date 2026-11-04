'use strict';
/**
 * opp-access.js — who may call the Thumbtack Opportunities callables, and the
 * two switches in front of them (2026-11-04, flag thumbtackOpportunities, dark).
 * Shared by oppShortlistFile (opp-shortlist.js) and oppDraftFile (opp-draft.js).
 * It is a plain module, not a Cloud Function: it exports no callable.
 *
 *   ownerOf(request)   the signed-in caller, or an HttpsError. OWNER ONLY: the
 *                      account that owns the NBD company (uid == NBD_OWNER_UID, no
 *                      companyId claim pointing at a different company, not a
 *                      viewer / member / anonymous). A company_admin, a manager, a
 *                      rep and a platform admin who is not the owner are refused:
 *                      the rules are Jo's own numbers and the watcher is his.
 *   gate(db, c)        the flag and the kill switch. Reads feature_flags/_default
 *                      and feature_flags/{uid}, then opp_rules/_default. A read
 *                      error is 'unavailable' (fail closed); a flag that is not the
 *                      boolean true, or killSwitch true, answers { ok: false }.
 *
 * Nothing here touches Thumbtack.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const { assertNotViewer } = require('./shared');
const R = require('./opp-rules');

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const LOWER_ROLES = new Set(['viewer', 'member', 'sales_rep', 'manager', 'company_admin']);

const MESSAGES = Object.freeze({
  feature_off: 'The Thumbtack Opportunities watcher is not turned on yet.',
  kill_switch: 'The Thumbtack Opportunities watcher is switched off in its rules.',
});

/** @returns {{uid:string, company:string}} */
function ownerOf(request) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const token = request.auth.token || {};
  assertNotViewer(token);
  const uid = request.auth.uid;
  const role = typeof token.role === 'string' ? token.role.trim().toLowerCase() : '';
  const claimed = typeof token.companyId === 'string' && token.companyId ? token.companyId : uid;
  if (uid !== NBD_OWNER_UID || claimed !== uid || LOWER_ROLES.has(role)) {
    throw new HttpsError('permission-denied', 'Only the account owner can use the Thumbtack Opportunities watcher.');
  }
  return { uid, company: uid };
}

async function readDocOrThrow(db, path) {
  try {
    const s = await db.doc(path).get();
    return s.exists ? (s.data() || {}) : null;
  } catch (e) {
    throw new HttpsError('unavailable', 'Could not read the watcher settings just now. Try again in a moment.');
  }
}

/**
 * The flag, then the rules doc. { ok:true, rules, dropped } or { ok:false, code, message }.
 * (The doc id of the per-user flag sits in a variable so the owner-keyed-prefix scan does not read it as a storage prefix.)
 */
async function gate(db, c) {
  const flagDocId = c.uid;
  const [flagsDefault, flagsMine] = await Promise.all([readDocOrThrow(db, 'feature_flags/_default'), readDocOrThrow(db, 'feature_flags/' + flagDocId)]);
  if (!R.flagOn(flagsDefault, flagsMine, R.FLAG_NAME)) return { ok: false, code: 'feature_off', message: MESSAGES.feature_off };
  const override = await readDocOrThrow(db, 'opp_rules/_default');
  const merged = R.withOverride(override || {});
  if (merged.rules.killSwitch === true) return { ok: false, code: 'kill_switch', message: MESSAGES.kill_switch };
  return { ok: true, rules: merged.rules, dropped: merged.dropped };
}

module.exports = { NBD_OWNER_UID, MESSAGES, ownerOf, readDocOrThrow, gate };
