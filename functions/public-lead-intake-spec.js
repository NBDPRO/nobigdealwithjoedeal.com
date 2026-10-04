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

module.exports = { INTAKE_OPTIONAL, INTAKE_MAXLEN, INTAKE_ENUMS, sanitizeIntake };
