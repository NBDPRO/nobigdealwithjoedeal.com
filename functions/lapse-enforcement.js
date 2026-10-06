/**
 * lapse-enforcement.js — pause team seats after a subscription lapses.
 *
 * Product decision (gauntlet batch 2, 2026-07-16): "grace period then
 * eventual pause or deactivation (make reactivation possible — we can't
 * delete on nonpayment)."
 *
 * Lifecycle:
 *   1. customer.subscription.deleted (stripe.js) stamps
 *      subscriptions/{companyId} { status:'cancelled', cancelledAt,
 *      lapseEnforced:false }. Nothing else changes — the whole team keeps
 *      working through the grace period.
 *   2. This daily cron finds cancelled subs whose cancelledAt is older
 *      than LAPSE_GRACE_DAYS and PAUSES the tenant's non-owner seats:
 *      Auth account disabled + tokens revoked + member doc flipped to
 *      'deactivated' with deactivatedReason:'lapse'. The OWNER is never
 *      touched — they keep their (now free-tier) CRM and all data.
 *   3. Reactivation: checkout.session.completed (stripe.js) re-enables
 *      every member this cron paused (deactivatedReason ping-pongs back
 *      to active) and clears lapseEnforced. Owner-deactivated members
 *      stay off — only lapse pauses are auto-reversed.
 *
 * NOTHING is ever deleted here: data, leads, docs, and accounts all
 * survive indefinitely; a lapsed tenant can come back months later.
 */

'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
// PLAN_LIMITS is the server source of truth for seat caps (billing.js).
const { _test: { PLAN_LIMITS } } = require('./billing');
const { revokeMemberAccessTokens } = require('./member-offboarding');

const LAPSE_GRACE_DAYS = 14;

// Invited-rep seats a plan grants (besides the owner). Mirrors
// invites.js seatLimitForPlan (reps<=1 => solo => 0 invite seats;
// Infinity stays Infinity). Kept local to avoid pulling invites.js
// (Resend/secrets) into this scheduled module.
function seatLimitForPlan(plan) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  if (limits.reps === Infinity) return Infinity;
  return limits.reps <= 1 ? 0 : limits.reps;
}

// Pause one lapsed tenant's non-owner seats. Exported for the test rig.
async function enforceLapseForCompany(db, subDoc) {
  const companyId = subDoc.id;
  const membersSnap = await db.collection(`companies/${companyId}/members`).get();
  const active = membersSnap.docs.filter((m) => (m.data() || {}).status === 'active');

  let paused = 0;
  for (const m of active) {
    const md = m.data() || {};
    if (!md.uid) continue; // never-claimed rows have no account to pause
    try {
      await getAuth().updateUser(md.uid, { disabled: true });
      await getAuth().revokeRefreshTokens(md.uid);
      await m.ref.set({
        status: 'deactivated',
        active: false,
        deactivatedAt: FieldValue.serverTimestamp(),
        deactivatedBy: 'lapse-cron',
        deactivatedReason: 'lapse',
      }, { merge: true });
      paused++;
      // R3-1 (2026-10-06): a paused seat's bot keys + calendar feed links go
      // off too. Own catch, so a failure here never counts as a failed pause;
      // crmMcp and getCalendarFeed also refuse a disabled person on every call.
      try {
        await revokeMemberAccessTokens(db, md.uid, 'lapse');
      } catch (e) {
        logger.warn('lapse.revoke_tokens_failed', { companyId, member: m.id, err: e.message });
      }
    } catch (e) {
      // One bad member must not block the rest (or the whole scan).
      logger.warn('lapse.pause_member_failed', { companyId, member: m.id, err: e.message });
    }
  }

  await subDoc.ref.set({
    lapseEnforced: true,
    lapseEnforcedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  logger.info('lapse.enforced', { companyId, paused, totalActive: active.length });
  return paused;
}

exports.enforceLapsedSeats = onSchedule(
  {
    region: 'us-central1',
    schedule: 'every day 09:00',
    timeZone: 'America/New_York',
    timeoutSeconds: 300,
    memory: '256MiB',
    maxInstances: 1,
  },
  async () => {
    const db = getFirestore();
    const cutoff = new Date(Date.now() - LAPSE_GRACE_DAYS * 24 * 3600 * 1000);

    // status=='cancelled' + past-grace + not yet enforced. lapseEnforced is
    // only stamped (false) by the deleted-webhook from batch 2 onward, so
    // '== false' also naturally skips legacy cancelled docs from before
    // this feature existed — those tenants were never promised a pause.
    const lapsed = await db.collection('subscriptions')
      .where('status', '==', 'cancelled')
      .where('lapseEnforced', '==', false)
      .where('cancelledAt', '<=', cutoff)
      .get();

    if (lapsed.empty) {
      logger.info('lapse.scan_clean', { cutoff: cutoff.toISOString() });
      return;
    }

    let companies = 0;
    let seats = 0;
    for (const subDoc of lapsed.docs) {
      companies++;
      seats += await enforceLapseForCompany(db, subDoc);
    }
    logger.info('lapse.scan_done', { companies, seats });
  }
);

// Reactivation helper — called from stripe.js checkout.session.completed:
// re-enable every member the lapse cron paused (and ONLY those; members an
// owner deactivated on purpose stay off).
async function reactivateLapsedSeats(db, companyId, plan, purchasedSeats) {
  const pausedSnap = await db.collection(`companies/${companyId}/members`)
    .where('deactivatedReason', '==', 'lapse')
    .get();

  // Downgrade-on-return cap: a tenant that lapsed on Growth (5 seats) and comes
  // back on Starter (0 invite seats) must NOT have all its reps restored over
  // the new plan's cap — seat caps are otherwise only enforced at invite time,
  // so an uncapped restore is billing under-enforcement. Restore up to
  // seatLimitForPlan(plan), oldest-activated first (most-tenured reps keep their
  // seat); leave the overflow paused as 'lapse' so a later upgrade brings them
  // back automatically. Same-plan or upgrade returns restore everyone (cap >=
  // paused count). `plan` omitted (legacy 2-arg callers / test rig) => Infinity
  // cap => restore all, preserving the pre-cap behavior exactly.
  // purchasedSeats (Route 1 per-seat add-ons, passed by the checkout webhook
  // from the sub doc it just wrote) widens the cap by the seats still being
  // paid for; omitted/invalid => 0, byte-identical to pre-seat behavior.
  const extraSeats = Math.max(0, Number(purchasedSeats) || 0);
  const cap = plan == null ? Infinity : seatLimitForPlan(plan) + extraSeats;
  const paused = pausedSnap.docs
    .filter((m) => (m.data() || {}).uid)
    .sort((a, b) => {
      // oldest activatedAt first; members missing the stamp sort last.
      const at = a.data().activatedAt;
      const bt = b.data().activatedAt;
      const am = at && typeof at.toMillis === 'function' ? at.toMillis() : Infinity;
      const bm = bt && typeof bt.toMillis === 'function' ? bt.toMillis() : Infinity;
      return am - bm;
    });

  let restored = 0;
  for (const m of paused) {
    if (restored >= cap) break; // over the new plan's seat cap — leave paused
    const md = m.data() || {};
    try {
      await getAuth().updateUser(md.uid, { disabled: false });
      await m.ref.set({
        status: 'active',
        active: true,
        deactivatedAt: null,
        deactivatedBy: null,
        deactivatedReason: null,
        reactivatedAt: FieldValue.serverTimestamp(),
        reactivatedBy: 'lapse-recovery',
      }, { merge: true });
      restored++;
    } catch (e) {
      logger.warn('lapse.reactivate_member_failed', { companyId, member: m.id, err: e.message });
    }
  }
  const heldBack = paused.length - restored;
  if (restored) logger.info('lapse.reactivated', { companyId, restored });
  if (heldBack > 0) {
    logger.info('lapse.restore_capped', {
      companyId, plan: plan || null, restored, heldBack,
      cap: cap === Infinity ? 'inf' : cap,
    });
  }
  return restored;
}

exports.reactivateLapsedSeats = reactivateLapsedSeats;
exports._test = { LAPSE_GRACE_DAYS, enforceLapseForCompany, reactivateLapsedSeats };
