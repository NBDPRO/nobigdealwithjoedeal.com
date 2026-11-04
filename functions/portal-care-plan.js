/**
 * functions/portal-care-plan.js — the Roof Care Plan on the homeowner portal
 * (2026-11-04, documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md
 * Phase 6). Pure: getHomeownerPortalView hands in the lead, the tracker step
 * and the mode.
 *
 * Jo's decision: test first, live only after the attorney review. So:
 *   - A MEMBER always sees their plan (leads/{id}.carePlan is the server's
 *     own mirror of the Stripe subscription, care-plan.js leadMirror; a
 *     member exists only through a real checkout, test or live).
 *   - The OFFER shows only when CARE_PLAN_MODE is 'live' (care-plan-logic.js
 *     carePlanMode: unset/unknown = off, fail closed), only on NBD's own
 *     jobs (it is NBD's product), and only once the work is done — the
 *     walkthrough step or later — never as an ask while the job is open.
 *     The portal never sells: it links to the public plan page, which runs
 *     the existing checkout and its own mode gate.
 */
'use strict';

const OFFER_STEPS = new Set(['walkthrough', 'payment', 'warranty', 'review']);

const toMs = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis()
  : (t instanceof Date ? t.getTime() : (Number.isFinite(Number(t)) && t !== null && t !== '' ? Number(t) : NaN)));

/**
 * → { kind: 'member', interval, renewsAtMs, endsAtMs }
 *   | { kind: 'offer', url, yearCents, monthCents } | null
 */
function carePlanCard(lead, currentKey, opts) {
  const o = opts || {};
  const cp = lead && lead.carePlan && typeof lead.carePlan === 'object' ? lead.carePlan : null;
  if (cp && cp.member === true) {
    const r = toMs(cp.renewsAt), e = toMs(cp.endsAt);
    return {
      kind: 'member',
      interval: cp.interval === 'month' || cp.interval === 'year' ? cp.interval : null,
      renewsAtMs: Number.isFinite(r) ? r : null,
      endsAtMs: Number.isFinite(e) ? e : null,
    };
  }
  if (o.mode !== 'live' || o.isNbd !== true || !OFFER_STEPS.has(String(currentKey || ''))) return null;
  return { kind: 'offer', url: String(o.pageUrl || '') + '?from=portal', yearCents: o.prices.year, monthCents: o.prices.month };
}

module.exports = { carePlanCard, OFFER_STEPS };
