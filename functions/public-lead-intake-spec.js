/**
 * public-lead-intake-spec.js — the intake answers a homeowner service request
 * may carry (scheduling choice, best time, insurance claim, how they heard),
 * and the ONE sanitiser both server paths use:
 *
 *   - submitPublicLead (handlers/integrations.js) — answers posted WITH the lead
 *     (the homepage, quick form, /inspect, storm tools);
 *   - updatePublicLeadIntake (public-lead-photos.js) — answers posted AFTER the
 *     lead, from the /estimate thank-you screen (2026-10-03: the funnel's
 *     contact step now asks only first name + phone + consent; the extra
 *     questions moved to "help Joe prepare", saved onto the same lead).
 *
 * Pure: no Firebase imports, so it can be required anywhere (and by tests).
 */
'use strict';

const INTAKE_OPTIONAL = ['scheduling', 'bestTime', 'insuranceClaim', 'howHeard'];
const INTAKE_MAXLEN = { scheduling: 20, bestTime: 60, insuranceClaim: 20, howHeard: 100 };
const INTAKE_ENUMS = {
  scheduling: ['calendar', 'contact_me'],
  insuranceClaim: ['yes', 'no', 'not_sure'],
};

/**
 * body → { field: value } holding only allowlisted, string, length-capped,
 * enum-valid answers with < and > dropped. Anything else is silently dropped
 * (an optional answer must never fail a request).
 */
function sanitizeIntake(body) {
  const b = body || {};
  const out = {};
  for (const k of INTAKE_OPTIONAL) {
    const v = b[k];
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || s.length > INTAKE_MAXLEN[k]) continue;
    if (INTAKE_ENUMS[k] && !INTAKE_ENUMS[k].includes(s)) continue;
    out[k] = s.replace(/[<>]/g, '');
  }
  return out;
}

/**
 * The /inspect thank-you screen (2026-10-06, Jo: "shorter form") also asks the
 * three free-text extras its first screen used to carry: "What happened?",
 * email and a referral code. They are accepted ONLY by updatePublicLeadIntake,
 * ONLY for an inspect_leads grant, under the SAME caps the inspect kind
 * applies at submit (story 1500, email 200, referralCode 32). submitPublicLead
 * is untouched. Anything malformed is silently dropped, like sanitizeIntake.
 */
const FOLLOWUP_EXTRA_MAXLEN = { story: 1500, email: 200, referralCode: 32 };
const FOLLOWUP_EXTRA_COLLECTIONS = ['inspect_leads'];
function sanitizeFollowUpExtras(body) {
  const b = body || {};
  const out = {};
  const str = (k) => (typeof b[k] === 'string' ? b[k].trim() : '');
  const story = str('story');
  if (story && story.length <= FOLLOWUP_EXTRA_MAXLEN.story) out.story = story.replace(/[<>]/g, '');
  const email = str('email');
  if (email && email.length <= FOLLOWUP_EXTRA_MAXLEN.email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) out.email = email;
  // Same normalisation lead-bridge applies to redeemReferralCode.
  const code = str('referralCode').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (code && code.length <= FOLLOWUP_EXTRA_MAXLEN.referralCode) out.referralCode = code;
  return out;
}

module.exports = {
  INTAKE_OPTIONAL, INTAKE_MAXLEN, INTAKE_ENUMS, sanitizeIntake,
  FOLLOWUP_EXTRA_MAXLEN, FOLLOWUP_EXTRA_COLLECTIONS, sanitizeFollowUpExtras,
};
