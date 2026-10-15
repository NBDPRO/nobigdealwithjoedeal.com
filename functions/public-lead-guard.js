/**
 * functions/public-lead-guard.js — flood + repeat guards for submitPublicLead
 * (public intake hardening, 2026-10-15).
 *
 * Why: NBD's OWN public leads skip every alert cap in lead-alert.js (the
 * tenant ceilings only apply to other companies), and submitPublicLead's only
 * gate is 20/min per IP. A script rotating IPs could page Joe's phone, inbox
 * and devices hundreds of times a day, and every lead also fires the homeowner
 * ack email to whatever address was typed.
 *
 * What this decides, per lead, BEFORE it is stored (the lead is ALWAYS stored):
 *   1. Repeat: the same 10-digit phone already sent an alert-eligible lead to
 *      the same company in the last 24h → { duplicateLead: true,
 *      alertSuppressed: 'duplicate' }. The bridge carries duplicateLead onto
 *      the CRM lead (public-measure skips it), lead-alert skips the alert.
 *   2. Volume: more than PUBLIC_LEAD_ALERT_DAILY_CAP (default 75) alert-
 *      eligible leads for one company in 24h → the FIRST lead over the line
 *      carries leadVolumeNotice: true (lead-alert sends ONE "lead volume
 *      unusually high today" alert with it); every later one carries
 *      alertSuppressed: 'volume' (no SMS / email / push / homeowner ack).
 *
 * "Alert-eligible" = what lead-alert.js would page on: not a guide download,
 * not an /estimate follow-up event doc, not a list-only storm signup. Those
 * neither count nor register a phone, so a homeowner who first joins the storm
 * list and later reports real damage is still alerted.
 *
 * Buckets live in the existing admin-only `_rate_limits_ip` limiter
 * (rate-limit.js), keyed per company, so a flood aimed at one tenant can never
 * silence another (or NBD). A limiter outage fails OPEN: the lead is not
 * marked, and lead-alert behaves exactly as before.
 *
 * Pure apart from the injected limiter, so tests drive it directly.
 */
'use strict';

const L = require('./lead-bridge-logic');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_ALERT_CAP = 75;

function dailyAlertCap(env) {
  const n = Number((env || {}).PUBLIC_LEAD_ALERT_DAILY_CAP);
  return Number.isFinite(n) && n >= 1 && n <= 100000 ? Math.floor(n) : DEFAULT_DAILY_ALERT_CAP;
}

// Same transform as phone-utils.phoneDigits10, but only a full 10-digit result
// counts — a partial number must not collide with other partial numbers.
function dedupeDigits(phone) {
  const d = String(phone == null ? '' : phone).replace(/\D/g, '').replace(/^1/, '');
  return d.length === 10 ? d : '';
}

/** Would lead-alert.js page on this lead? Mirrors its alertPlan gates. */
function isAlertEligible(collection, data) {
  const d = data || {};
  if (collection === 'guide_leads') return false;
  if (L.isFollowUpEvent(collection, d)) return false;
  if (collection === 'storm_alert_subscribers') {
    return L.HIGH_INTENT_STORM_CONCERNS.includes(String(d.concern || '').toLowerCase());
  }
  return true;
}

// A greeting name safe to put in an email to an address someone TYPED: one
// word of letters (plus ' and -), at most 24 chars, else ''. Anything else a
// visitor types (links, sentences, markup) is never echoed (H1, 2026-10-15).
function safeGreetingName(raw) {
  const w = String(raw == null ? '' : raw).trim().split(/\s+/)[0] || '';
  return /^[A-Za-zÀ-ɏ][A-Za-zÀ-ɏ'-]{0,23}$/.test(w) ? w : '';
}

async function tryBucket(enforce, ns, key, limit) {
  try {
    await enforce(ns, key, limit, DAY_MS);
    return 'allowed';
  } catch (e) {
    if (e && e.rateLimited) return 'limited';
    return 'error';
  }
}

/**
 * @param {{collection:string, data:object, enforce:Function, env?:object, log?:object}} args
 * @returns {Promise<object>} fields to merge onto the lead (possibly {})
 */
async function classifyPublicLead(args) {
  const { collection, data, enforce } = args || {};
  const log = (args && args.log) || { warn() {}, info() {} };
  if (typeof enforce !== 'function' || !isAlertEligible(collection, data)) return {};
  const tenant = String((data && data.companyId) || 'nbd');

  const digits = dedupeDigits(data && data.phone);
  if (digits) {
    const r = await tryBucket(enforce, 'publicLead:phone24h', tenant + '|' + digits, 1);
    if (r === 'limited') {
      log.info('submitPublicLead: repeat phone within 24h — stored, alerts skipped', { collection });
      return { duplicateLead: true, alertSuppressed: 'duplicate' };
    }
    if (r === 'error') log.warn('submitPublicLead: dedupe check unavailable — continuing', { collection });
  }

  const cap = dailyAlertCap(args && args.env);
  const v = await tryBucket(enforce, 'publicLead:alertDay', tenant, cap);
  if (v !== 'limited') {
    if (v === 'error') log.warn('submitPublicLead: daily volume check unavailable — continuing', { collection });
    return {};
  }
  // Over the line. Exactly one lead per window carries the notice.
  const n = await tryBucket(enforce, 'publicLead:alertDayNotice', tenant, 1);
  if (n === 'allowed') {
    log.warn('submitPublicLead: daily lead volume over the alert cap — one notice, then alerts pause', { collection, cap });
    return { leadVolumeNotice: true };
  }
  if (n === 'error') return {};   // fail open: alert as before
  return { alertSuppressed: 'volume' };
}

module.exports = {
  classifyPublicLead, isAlertEligible, safeGreetingName, dedupeDigits, dailyAlertCap,
  DEFAULT_DAILY_ALERT_CAP, DAY_MS,
};
