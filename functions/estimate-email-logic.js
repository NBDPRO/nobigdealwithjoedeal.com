/**
 * functions/estimate-email-logic.js — what the "Email My Estimate" email may
 * say, and whether it may go at all. Pure: no Firebase, no network.
 *
 * Repo sweep 2026-11-17, M3. The email used to carry the visitor-written
 * estimateSummary (up to 2,000 characters), signed by Joe from the NBD domain,
 * to any address the visitor named, so a script could send "your account is
 * past due, pay at <link>" in Joe's voice. Jo's decisions (2026-11-17):
 *   - The server builds the text from a small structured estimate
 *     (sanitizeEmailEstimate): a known service, whole-dollar ranges for known
 *     tiers, a roof size. Labels, links and the phone are NBD's own. Nothing
 *     the visitor typed is emailed except a one-word greeting name
 *     (public-lead-guard safeGreetingName).
 *   - It sends only when the gateway stamped turnstileVerified === true (a
 *     Turnstile check that really ran and passed), and not when the gateway
 *     marked the request over the per-IP limit (estimateEmailIpLimited).
 *   - A request from an old cached page (free text only, no structured
 *     estimate) gets a short email with no numbers.
 *
 * The labels and the financing threshold mirror the /estimate funnel
 * (docs/assets/js/inline/4053149b2f.js SERVICE_LABELS, TIER_LABELS,
 * STORM_NOTE, FIN_MIN_PROJECT) so the email reads like the screen did.
 */
'use strict';

const PLG = require('./public-lead-guard');

const BOOKING_URL = 'https://cal.com/nobigdeal/roof-inspection';
const PHONE_DISPLAY = '(859) 420-7382';
const INSPECT_URL = 'https://nobigdealwithjoedeal.com/inspect';
const FINANCING_URL = 'https://nobigdealwithjoedeal.com/services/financing';

const SERVICE_LABELS = {
  'roof-replacement': 'Roof Replacement',
  'roof-repair': 'Roof Repair',
  'siding-replacement': 'Siding Replacement',
  'siding-repair': 'Siding Repair',
  'gutter-replacement': 'Gutter Replacement',
  'storm-damage': 'Storm Damage',
};
const TIER_ORDER = ['good', 'better', 'best'];
const TIER_LABELS = { good: 'Standard (Architectural)', better: 'Preferred (Architectural)', best: 'Elite (Architectural)' };
const STORM_NOTE = 'If you file and the claim is approved, your deductible is yours to pay — what the claim covers is up to your insurer. Book a free inspection and I\'ll document the damage.';
const FIN_MIN_PROJECT = 3000;
const MAX_DOLLARS = 1000000;
const ROOF_SQFT = { min: 100, max: 20000 };

function _isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

/** {min,max} → whole-dollar range, or null. Numbers only (a string is refused). */
function _range(r) {
  if (!_isPlainObject(r)) return null;
  const lo = r.min, hi = r.max;
  if (typeof lo !== 'number' || typeof hi !== 'number' || !isFinite(lo) || !isFinite(hi)) return null;
  const min = Math.round(lo), max = Math.round(hi);
  if (min < 0 || max <= 0 || min > max || max > MAX_DOLLARS) return null;
  return { min, max };
}

/**
 * The structured estimate the funnel posts as `emailEstimate`, bounded.
 *   { v:1, service, range?:{min,max}, tiers?:{good|better|best:{min,max}}, roofSqft? }
 * → { service, range? , tiers?, roofSqft? } or null. Storm damage keeps no
 * numbers. Unknown services, text "prices" and out-of-range values are refused;
 * unknown tier keys are dropped.
 */
function sanitizeEmailEstimate(raw) {
  if (!_isPlainObject(raw)) return null;
  const service = typeof raw.service === 'string' ? raw.service : '';
  if (!Object.prototype.hasOwnProperty.call(SERVICE_LABELS, service)) return null;
  const out = { service };
  if (service !== 'storm-damage') {
    if (raw.range != null) {
      const r = _range(raw.range);
      if (!r) return null;
      out.range = r;
    } else if (_isPlainObject(raw.tiers)) {
      const tiers = {};
      for (const t of TIER_ORDER) {
        if (raw.tiers[t] == null) continue;
        const r = _range(raw.tiers[t]);
        if (!r) return null;
        tiers[t] = r;
      }
      if (!Object.keys(tiers).length) return null;
      out.tiers = tiers;
    } else {
      return null;
    }
  }
  const sq = raw.roofSqft;
  if (typeof sq === 'number' && isFinite(sq) && sq >= ROOF_SQFT.min && sq <= ROOF_SQFT.max) out.roofSqft = Math.round(sq);
  return out;
}

const _usd = (n) => '$' + Number(n).toLocaleString('en-US');

/**
 * The plain-text estimate block, from NBD's own template only. null/undefined
 * (an old cached page) → the short no-numbers version.
 */
function buildEstimateSummary(est) {
  const lines = [];
  if (!est) {
    lines.push('Your estimate is ready to look at again any time on my site, and I\'m happy to walk you through it.');
  } else if (est.service === 'storm-damage') {
    lines.push(SERVICE_LABELS[est.service] + ': no price range — ' + STORM_NOTE);
    lines.push('Book a free inspection: ' + INSPECT_URL);
  } else if (est.range) {
    lines.push(SERVICE_LABELS[est.service] + ': ' + _usd(est.range.min) + ' - ' + _usd(est.range.max));
  } else if (est.tiers) {
    lines.push(SERVICE_LABELS[est.service] + ':');
    for (const t of TIER_ORDER) {
      if (est.tiers[t]) lines.push(TIER_LABELS[t] + ': ' + _usd(est.tiers[t].min) + ' - ' + _usd(est.tiers[t].max));
    }
  }
  if (est && est.roofSqft) lines.push('', 'Roof size: ~' + Number(est.roofSqft).toLocaleString('en-US') + ' sq ft');
  const finMin = !est ? 0 : est.range ? est.range.min : (est.tiers && est.tiers.better ? est.tiers.better.min : 0);
  if (est && est.service !== 'storm-damage' && finMin >= FIN_MIN_PROJECT) {
    lines.push('', 'A project this size can usually be spread into a monthly payment instead of paid all at once — check real offers with a soft credit pull (no impact to your score): ' + FINANCING_URL);
  }
  lines.push('', 'For your exact price, schedule a free inspection with Joe: ' + BOOKING_URL);
  lines.push('Or call: ' + PHONE_DISPLAY);
  return lines.join('\n');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) { return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email); }

/**
 * Should this estimate_leads doc get the email, and what does it say?
 * → { action:'skip', reason, status? }   status: a marker to leave on the doc
 *   { action:'send', summary, generic, firstName }
 */
function decideEstimateEmail(data, nbdOwnerUid) {
  const d = data || {};
  if (d.type !== 'email_estimate_request') return { action: 'skip', reason: 'not_email_request' };
  if (d.companyId && String(d.companyId) !== String(nbdOwnerUid || '')) return { action: 'skip', reason: 'non_nbd_tenant' };
  if (!isValidEmail(d.email)) return { action: 'skip', reason: 'invalid_email' };
  if (d.turnstileVerified !== true) return { action: 'skip', reason: 'unverified', status: 'unverified' };
  if (d.estimateEmailIpLimited === true) return { action: 'skip', reason: 'throttled_ip', status: 'throttled_ip' };
  const est = sanitizeEmailEstimate(d.emailEstimate);
  return { action: 'send', summary: buildEstimateSummary(est), generic: !est, firstName: PLG.safeGreetingName(d.firstName) };
}

module.exports = {
  sanitizeEmailEstimate, buildEstimateSummary, decideEstimateEmail, isValidEmail,
  SERVICE_LABELS, TIER_LABELS, BOOKING_URL, PHONE_DISPLAY,
};
