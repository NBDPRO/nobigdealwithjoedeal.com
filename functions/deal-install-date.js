/**
 * functions/deal-install-date.js — deal room install date → the lead.
 *
 * When a homeowner accepts a Close Board deal they can pick an install date
 * (docs/pro/deal-room.js → submitDealAcceptance → deal_rooms/{id}.
 * scheduledInstallDate). Until 2026-09-29 that date stopped there: the lead's
 * scheduledDate — the field the Schedule view, the .ics feed, the portal and
 * the CREW_SCHEDULED gate all read — never heard of it
 * (documentation/projects/CALENDAR-HUB-PLAN-2026-09-29.md, Phase 0 §2).
 *
 * The rule: fill the lead's scheduledDate ONLY when it is empty. A date Jo
 * typed is his decision and is never overwritten by what a homeowner picked in
 * a form. The check and the write run in one transaction, so a date Jo saves
 * while the acceptance is in flight wins.
 *
 * Only the lead's scheduledDate (+ updatedAt) is written. The deal room is not
 * touched here at all, so the accepted-deal lock in firestore.rules
 * (dealIsClosed / dealAcceptanceIntact, #1862) is not in play.
 *
 * No firebase import: the caller passes its Firestore handle, which is what
 * lets tests/calendar-phase0-2026-09-29.test.js drive this with a fake one.
 */
'use strict';

const SW = require('./schedule-window');

/**
 * Pure decision. Returns the update to write, or null with a reason.
 * @param {object|null} lead     leads/{id} data (null when the doc is missing)
 * @param {string}      ownerUid the deal's owner (from the accept token)
 * @param {*}           dealDate the deal room's scheduledInstallDate
 */
function planLeadInstallDate(lead, ownerUid, dealDate) {
  if (!lead) return { update: null, reason: 'no-lead' };
  if (lead.deleted === true) return { update: null, reason: 'lead-deleted' };
  // The token was minted for this owner's deal; a leadId pointing at someone
  // else's lead is not this deal's job.
  if (!ownerUid || lead.userId !== ownerUid) return { update: null, reason: 'not-owner' };
  const fill = SW.installDateFill(lead.scheduledDate, dealDate);
  if (!fill) {
    return { update: null, reason: SW.installDateFill('', dealDate) ? 'lead-has-date' : 'bad-deal-date' };
  }
  return { update: { scheduledDate: fill }, reason: 'filled' };
}

/**
 * Best-effort: never throws. Resolves to the plan's reason ('filled', …,
 * or 'error').
 * @param {object} db       Firestore (admin) — needs doc() + runTransaction()
 * @param {object} info     { leadId, ownerUid }
 * @param {*}      dealDate the accepted install date
 * @param {object} [deps]   { now: () => Date, logger }
 */
async function fillLeadInstallDate(db, info, dealDate, deps) {
  const d = deps || {};
  const now = d.now || (() => new Date());
  if (!info || !info.leadId || typeof info.leadId !== 'string' || info.leadId.indexOf('/') !== -1) return 'no-lead';
  // Nothing to copy — skip the read entirely.
  if (!SW.installDateFill('', dealDate)) return 'bad-deal-date';
  try {
    const ref = db.doc('leads/' + info.leadId);
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const plan = planLeadInstallDate(snap.exists ? snap.data() : null, info.ownerUid, dealDate);
      if (plan.update) tx.update(ref, Object.assign({}, plan.update, { updatedAt: now() }));
      return plan.reason;
    });
  } catch (e) {
    if (d.logger) d.logger.warn('[deal-install-date] lead fill failed', { leadId: info.leadId, msg: e && e.message });
    return 'error';
  }
}

module.exports = { planLeadInstallDate, fillLeadInstallDate };
