/**
 * functions/pro-prospects-logic.js — pure rules for NBD Pro prospects: the
 * contractors who ask for the free playbook on /sites/free-guide (2026-10-16).
 *
 * A guide download is a CONTRACTOR asking about NBD Pro, never a homeowner
 * asking for roof work, so it stays out of the homeowner pipeline on purpose
 * (lead-bridge-logic.js never bridges guide_leads; tests/lead-bridge.test.js
 * pins that). It follows the pattern NBD Pro signups already use instead:
 *   - an alert email to Jo through email_queue (like onCompanyCreated's
 *     signup alert, tenant-ops.js), and
 *   - a row on the platform admin page /admin/tenants.html, next to the
 *     companies list, read through an admin-only callable.
 *
 * Nothing here is ever sent to the contractor (the welcome email that
 * delivers the playbook is a separate, CAN-SPAM-gated send). No firebase.
 */
'use strict';

// What the form's optional checkbox says, versioned so a stored consent can
// always be matched to the exact words the contractor agreed to.
const EMAIL_CONSENT_VERSION = 'pro-guide-email-2026-10-16';
const EMAIL_CONSENT_TEXT =
  'Also email me occasional NBD Pro tips from Joe (a few emails at most). Unsubscribe any time.';

// Alerts to Jo per rolling 24h before the rest are stored quietly (a script
// rotating IPs must not page his inbox hundreds of times a day). The prospect
// is ALWAYS stored and always listed on the admin page.
const ALERT_DAILY_CAP = 40;

const ADMIN_PAGE = 'https://nobigdealwithjoedeal.com/admin/tenants.html#prospects';

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, max || 200);
}

function isEmail(e) {
  return typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function toIso(ts) {
  if (!ts) return null;
  try {
    if (typeof ts.toDate === 'function') return ts.toDate().toISOString();
    if (typeof ts._seconds === 'number') return new Date(ts._seconds * 1000).toISOString();
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch (_) { return null; }
}

/** The alert email to Jo (plain text, internal mail). */
function prospectAlertEmail(lead, leadId) {
  const d = lead || {};
  const name = clean(d.name, 80) || '(no name)';
  const utm = ['utm_source', 'utm_medium', 'utm_campaign']
    .map((k) => (d[k] ? k.replace('utm_', '') + '=' + clean(d[k], 80) : ''))
    .filter(Boolean).join(', ');
  return {
    subject: 'New NBD Pro prospect: ' + name,
    bodyPlain: [
      name + ' asked for the free NBD Pro playbook.',
      '',
      'Email: ' + (clean(d.email, 200) || '(none)'),
      'Tips emails OK: ' + (d.emailConsent === true ? 'yes' : 'no (send the playbook only)'),
      'Page: ' + (clean(d.source, 80) || 'free-guide'),
      utm ? 'Campaign: ' + utm : null,
      'Record: guide_leads/' + leadId,
      '',
      'This is a contractor (NBD Pro prospect), not a homeowner lead, so it is not in your pipeline.',
      'All prospects: ' + ADMIN_PAGE,
    ].filter((l) => l !== null).join('\n'),
  };
}

/** One row for the admin page. Only what Jo needs to follow up. */
function prospectRow(id, lead) {
  const d = lead || {};
  return {
    id: String(id),
    name: clean(d.name, 120),
    email: clean(d.email, 200),
    source: clean(d.source, 80),
    emailConsent: d.emailConsent === true,
    utmSource: clean(d.utm_source, 80),
    utmCampaign: clean(d.utm_campaign, 80),
    createdAt: toIso(d.createdAt),
    alerted: !!d.prospectAlertedAt,
  };
}

module.exports = {
  EMAIL_CONSENT_VERSION,
  EMAIL_CONSENT_TEXT,
  ALERT_DAILY_CAP,
  ADMIN_PAGE,
  isEmail,
  toIso,
  prospectAlertEmail,
  prospectRow,
};
