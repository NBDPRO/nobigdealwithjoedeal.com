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
    welcome: d.welcomeEmailedAt ? 'sent' : (d.welcomeSkipped ? 'not sent: ' + clean(d.welcomeSkipped, 40) : ''),
  };
}

// ── The welcome email (2026-10-16) ─────────────────────────────────────────
// ONE email that delivers what the contractor asked for: the playbook link
// (and the PDF once Docs Studio publishes it). Commercial under CAN-SPAM (it
// also mentions NBD Pro), so it goes through gateCommercialEmail: postal
// address + one-click unsubscribe, and nothing sends without them. There is
// no follow-up sequence: the repo has no consent-gated contractor sequence
// mechanism, so emailConsent is recorded for later and used by nothing yet.
const SITE = 'https://nobigdealwithjoedeal.com';
const PLAYBOOK_URL = SITE + '/pro/playbook';
const PLAYBOOK_PDF_URL = SITE + '/guides/pdf/nbd-pro-playbook.pdf';
const REGISTER_URL = SITE + '/pro/register.html?utm_source=playbook-email&utm_medium=email&utm_campaign=welcome';
const PRICING_URL = SITE + '/pro/pricing';
const WELCOME_SOURCES = ['pro-playbook', 'free-guide'];
const WELCOME_SUBJECT = 'Your copy of the contractor marketing playbook';

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Should this guide lead get the welcome email at all? */
function welcomePlan(lead) {
  const d = lead || {};
  if (!isEmail(d.email)) return { send: false, reason: 'no_email' };
  if (!WELCOME_SOURCES.includes(String(d.source || ''))) return { send: false, reason: 'other_source' };
  if (d.welcomeEmailedAt || d.welcomeClaimedAt) return { send: false, reason: 'already_sent' };
  return { send: true };
}

/**
 * The welcome email body. `firstName` must already be a SAFE greeting word
 * (public-lead-guard.safeGreetingName): nothing a visitor typed is echoed raw.
 */
function welcomeEmail({ firstName, pdfReady }) {
  const hi = firstName ? 'Hi ' + firstName + ',' : 'Hi,';
  const pdfLine = pdfReady ? 'Prefer paper? The printable PDF is here: ' + PLAYBOOK_PDF_URL : '';
  const text = [
    hi,
    '',
    'Here is the playbook you asked for. The whole thing is free to read on one page:',
    PLAYBOOK_URL,
    pdfLine,
    '',
    'If you only do three things this week:',
    '1. Fill in every empty field on your Google Business Profile with real information (chapter 1).',
    '2. Ask your last five finished customers for an honest review. Chapter 7 has a text template with the business name and "Reply STOP to opt out" built in.',
    '3. Write one page on your website that answers the question homeowners ask you most (chapter 6).',
    '',
    'If you want a place to run all of it, NBD Pro is the CRM I built for my own roofing company. There is a free plan, and every price is published:',
    REGISTER_URL,
    'Pricing: ' + PRICING_URL,
    '',
    'Questions? Just reply. I read every one.',
    '',
    'Joe Deal',
    'No Big Deal Home Solutions and NBD Pro',
    '(859) 420-7382',
    '',
    'You are getting this one email because you asked for the playbook at nobigdealwithjoedeal.com.',
  ].join('\n').replace(/\n{3,}/g, '\n\n');
  const p = (s) => '<p style="margin:0 0 14px;">' + s + '</p>';
  const a = (href, label) => '<a href="' + escHtml(href) + '" style="color:#a14a22;font-weight:700;">' + escHtml(label) + '</a>';
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>'
    + '<body style="margin:0;background:#f5f3ef;font-family:Montserrat,\'Segoe UI\',Roboto,Arial,sans-serif;color:#1f2733;line-height:1.6;">'
    + '<div style="max-width:600px;margin:0 auto;background:#ffffff;">'
    + '<div style="background:#12223d;border-bottom:4px solid #bd5728;color:#ffffff;padding:24px 22px;">'
    + '<div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#dd875f;font-weight:700;">NBD Pro · Free playbook</div>'
    + '<div style="font-size:24px;font-weight:800;margin-top:6px;">The Local Marketing Playbook for Contractors</div></div>'
    + '<div style="padding:24px 22px;font-size:15px;">'
    + p(escHtml(hi))
    + p('Here is the playbook you asked for. The whole thing is free to read on one page:')
    + '<p style="margin:0 0 18px;"><a href="' + escHtml(PLAYBOOK_URL) + '" style="display:inline-block;background:#bd5728;color:#ffffff;text-decoration:none;font-weight:800;padding:12px 22px;border-radius:8px;">Read the playbook</a></p>'
    + (pdfReady ? p('Prefer paper? ' + a(PLAYBOOK_PDF_URL, 'Download the printable PDF') + '.') : '')
    + p('<strong>If you only do three things this week:</strong>')
    + '<ol style="margin:0 0 14px;padding-left:20px;">'
    + '<li style="margin-bottom:6px;">Fill in every empty field on your Google Business Profile with real information (chapter 1).</li>'
    + '<li style="margin-bottom:6px;">Ask your last five finished customers for an honest review. Chapter 7 has a text template with the business name and &quot;Reply STOP to opt out&quot; built in.</li>'
    + '<li>Write one page on your website that answers the question homeowners ask you most (chapter 6).</li></ol>'
    + p('If you want a place to run all of it, NBD Pro is the CRM I built for my own roofing company. There is a free plan, and ' + a(PRICING_URL, 'every price is published') + '. ' + a(REGISTER_URL, 'Create a free account') + '.')
    + p('Questions? Just reply. I read every one.')
    + p('Joe Deal<br>No Big Deal Home Solutions and NBD Pro<br><a href="tel:+18594207382" style="color:#1f2733;">(859) 420-7382</a>')
    + '<p style="margin:18px 0 0;font-size:12px;color:#5d6673;">You are getting this one email because you asked for the playbook at nobigdealwithjoedeal.com.</p>'
    + '</div></div></body></html>';
  return { subject: WELCOME_SUBJECT, text, html };
}

module.exports = {
  PLAYBOOK_URL,
  PLAYBOOK_PDF_URL,
  REGISTER_URL,
  WELCOME_SOURCES,
  WELCOME_SUBJECT,
  welcomePlan,
  welcomeEmail,
  EMAIL_CONSENT_VERSION,
  EMAIL_CONSENT_TEXT,
  ALERT_DAILY_CAP,
  ADMIN_PAGE,
  isEmail,
  toIso,
  prospectAlertEmail,
  prospectRow,
};
