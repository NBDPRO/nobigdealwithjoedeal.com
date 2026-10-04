/**
 * lead-cap-logic.js — pure rules for the SERVER-SIDE lead cap (2026-10-04,
 * tenant-ready). No Firestore, no clock of its own: lead-cap.js wires it to
 * the trigger, tests/lead-cap-2026-10-04.test.js drives it directly.
 *
 * WHY: the plan's monthly lead cap lived only in billing-gate.js (the
 * browser). Any client that skipped it — an old cached page, devtools, a
 * script — could add unlimited leads, and the usage counter only moved when
 * the browser chose to call trackUsage.
 *
 * NOW:
 *   1. firestore.rules requires every CLIENT lead create (except NBD's own
 *      company and platform admins) to carry `meter`: 'manual' | 'import' |
 *      'sample'. Server-created leads (web form, referrals, SMS) never carry
 *      it and are never metered — same as before.
 *   2. The meterLeadCreate trigger (lead-cap.js) counts each metered lead on
 *      subscriptions/{companyId}:
 *        import → importAllowanceUsed while under IMPORT_ALLOWANCE (a one-time
 *                 onboarding allowance — bringing your book over does not eat
 *                 the monthly cap), then the monthly counter
 *        sample → sampleAllowanceUsed while under SAMPLE_ALLOWANCE (Load
 *                 Sample Data no longer eats Free's 10), then monthly
 *        manual → usage.leads (monthly; rolls over by calendar month, UTC)
 *      and, when the monthly counter reaches the plan cap, writes
 *      leadCap = { plan, blockedUntil: <start of next month> }.
 *   3. firestore.rules refuse a metered create while leadCap.plan equals the
 *      company's current plan and request.time < blockedUntil — except an
 *      import/sample still inside its allowance. An upgrade changes `plan`,
 *      which reopens creates at once; a new month passes blockedUntil.
 *   4. A cancelled subscription's 30-day read-only grace (readOnlyUntil,
 *      stripe.js) refuses every metered create until it ends.
 *
 * The cap is the plan's (billing.js PLAN_LIMITS — the server source of truth).
 */
'use strict';

// Kept equal to firestore.rules leadMeterOk() (tests pin the numbers).
const IMPORT_ALLOWANCE = 1000;
const SAMPLE_ALLOWANCE = 20;
const METERS = Object.freeze(['manual', 'import', 'sample']);

// Same access-code trial expiry billing.js trackUsage applies at read time.
function effectivePlan(sub, nowMs) {
  const d = sub || {};
  let plan = (typeof d.plan === 'string' && d.plan) ? d.plan : 'free';
  const te = d.trialEndsAt;
  const teMs = te && typeof te.toMillis === 'function' ? te.toMillis()
    : (te instanceof Date ? te.getTime() : null);
  if (d.source === 'access_code' && teMs != null && teMs < nowMs) plan = 'free';
  return plan;
}

function monthKey(date) { return date.toISOString().slice(0, 7); }
function startOfNextMonthUtc(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

/**
 * meterPatch(sub, meter, now, limits) → { patch, counted, blocked }
 *   sub     current subscriptions/{companyId} data (or null)
 *   meter   'manual' | 'import' | 'sample'
 *   now     Date
 *   limits  PLAN_LIMITS map (billing.js)
 * patch is a merge-write object for the subscription doc. counted is which
 * counter moved ('import' | 'sample' | 'monthly').
 */
function meterPatch(sub, meter, now, limits) {
  const d = sub || {};
  const plan = effectivePlan(d, now.getTime());
  const lim = (limits && (limits[plan] || limits.free)) || { leads: 10 };
  const cap = lim.leads;
  const patch = {};
  let counted = 'monthly';

  const importUsed = Number(d.importAllowanceUsed) || 0;
  const sampleUsed = Number(d.sampleAllowanceUsed) || 0;
  if (meter === 'import' && importUsed < IMPORT_ALLOWANCE) {
    patch.importAllowanceUsed = importUsed + 1;
    counted = 'import';
  } else if (meter === 'sample' && sampleUsed < SAMPLE_ALLOWANCE) {
    patch.sampleAllowanceUsed = sampleUsed + 1;
    counted = 'sample';
  }

  // Monthly counter (rollover mirrors billing.js trackUsage).
  const usage = (d.usage && typeof d.usage === 'object') ? d.usage : {};
  const nowMonth = monthKey(now);
  const cycleMonth = (typeof usage.cycleStart === 'string') ? usage.cycleStart.slice(0, 7) : null;
  const rolled = cycleMonth !== null && cycleMonth !== nowMonth;
  let leads = rolled ? 0 : (Number(usage.leads) || 0);
  if (counted === 'monthly') leads += 1;
  const usagePatch = { leads };
  if (rolled) { usagePatch.reports = 0; usagePatch.aiCalls = 0; }
  if (rolled || !cycleMonth) usagePatch.cycleStart = now.toISOString();
  patch.usage = usagePatch;

  // The block flag: at (or past) the cap for this plan, until next month.
  let blocked = false;
  if (cap !== Infinity && typeof cap === 'number' && leads >= cap) {
    patch.leadCap = { plan, blockedUntil: startOfNextMonthUtc(now), cap, at: now.toISOString() };
    blocked = true;
  } else {
    patch.leadCap = null;
  }
  return { patch, counted, blocked, plan };
}

module.exports = {
  IMPORT_ALLOWANCE,
  SAMPLE_ALLOWANCE,
  METERS,
  effectivePlan,
  meterPatch,
  startOfNextMonthUtc,
};
