'use strict';

/**
 * functions/morning-brief-absorb.js — ONE morning email (2026-10-04).
 *
 * The 6:45 ET morning brief absorbs three emails that used to land separately
 * in the first two hours of Jo's day:
 *   dailyLeadDigest       07:00  new public leads in the last 24h
 *   callCenterSweep       07:15  "you said you'd…" (the 15:15 run is kept)
 *   reviewRequestNudge    08:15  the OWNER's review asks (other tenants keep theirs)
 *
 * The decision is config, not deleted code: each of those functions still
 * runs and asks briefAbsorbs() first. It answers yes only when
 *   - MORNING_BRIEF_ABSORB_ENABLED === 'true'  (functions/.env.nobigdeal-pro), AND
 *   - the brief itself is live (MORNING_BRIEF_ENABLED === 'true'), AND
 *   - the owner has not switched the brief off (users/{owner}.morningBriefEnabled !== false),
 * so a paused or opted-out brief can never swallow an email Jo relies on.
 * Unset the flag and every separate email comes back on its next run.
 */

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

function absorbConfigured(env) {
  const e = env || process.env;
  return e.MORNING_BRIEF_ABSORB_ENABLED === 'true' && e.MORNING_BRIEF_ENABLED === 'true';
}

/**
 * @param {object} db     Firestore
 * @param {object} [env]  defaults to process.env
 * @param {string} [owner]
 * @returns {Promise<boolean>}
 */
async function briefAbsorbs(db, env, owner) {
  const e = env || { MORNING_BRIEF_ABSORB_ENABLED: process.env.MORNING_BRIEF_ABSORB_ENABLED, MORNING_BRIEF_ENABLED: process.env.MORNING_BRIEF_ENABLED };
  if (!absorbConfigured(e)) return false;
  try {
    const snap = await db.collection('users').doc(owner || OWNER).get();
    const u = (snap && snap.exists && snap.data()) || {};
    if (u.morningBriefEnabled === false) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(u.email || ''));
  } catch (_) {
    // Can't tell → keep the separate email (a duplicate beats a lost one).
    return false;
  }
}

module.exports = { absorbConfigured, briefAbsorbs, OWNER };
