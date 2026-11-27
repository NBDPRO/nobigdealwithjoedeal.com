/**
 * guide-copy-logic.js — pure rules for "Email me this guide" on the homeowner
 * guides (2026-11-26). No Firebase imports, so tests load it directly.
 *
 * A homeowner reading /guides/<slug> leaves an email; submitPublicLead writes
 * guide_copy_requests/{id} ({ email, guide, source, emailConsent? }). Then:
 *   - guide-copy-email.js emails ONE copy, with the guide's typeset PDF
 *     (docs/guides/pdf/<slug>.pdf, published since #2509) attached;
 *   - lead-bridge.js files a cold CRM lead "Website — Guide copy" (no alert).
 *
 * The guide is chosen from GUIDES below by slug. Nothing the visitor typed is
 * echoed into the email: the title, link and attachment all come from this
 * table, and an unknown slug sends nothing (the gateway refuses it first).
 *
 * The optional "also email me storm tips" box records consent. The storm-tips
 * email (storm-tips-email.js, 2026-11-26) reads it, dark until Joe turns it on.
 */
'use strict';

const SITE = 'https://nobigdealwithjoedeal.com';
const PHONE_DISPLAY = '(859) 420-7382';
const PHONE_TEL = 'tel:+18594207382';
const REPLY_TO = 'jd@nobigdealwithjoedeal.com';

// The wording the checkbox shows, versioned so a stored yes says what it agreed to.
const STORM_TIPS_CONSENT_VERSION = 'guide-storm-tips-2026-11-26';

// The homeowner guides that have a published PDF. /guides/how-a-roof-works has
// none, so it is not offered. The NBD Pro playbook is a different list (guide_leads).
const GUIDES = {
  'compare-roofing-quotes-checklist': { title: 'Compare Roofing Quotes', file: 'NBD-Compare-Roofing-Quotes.pdf' },
  'hail-photo-baseline-sheet':        { title: 'Pre-Storm Photo Baseline', file: 'NBD-Pre-Storm-Photo-Baseline.pdf' },
  'home-care-warranty-card':          { title: 'Home Care & Warranty Card', file: 'NBD-Home-Care-Warranty-Card.pdf' },
  'kentucky-ohio-storm-claim-guide':  { title: 'Storm Claim Guide (KY & OH)', file: 'NBD-Storm-Claim-Guide-KY-OH.pdf' },
  'roof-financing-explained':         { title: 'Roof Financing Explained', file: 'NBD-Roof-Financing-Explained.pdf' },
  'siding-gutter-buyers-guide':       { title: "Siding & Gutter Buyer's Guide", file: 'NBD-Siding-Gutter-Buyers-Guide.pdf' },
};
const GUIDE_SLUGS = Object.keys(GUIDES);

function isGuideSlug(s) {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(GUIDES, s);
}

// Same shape check the other typed-address senders use (storm-report-email.js).
function isValidEmail(e) {
  return typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function guideUrl(slug) { return SITE + '/guides/' + slug; }
function pdfUrl(slug) { return SITE + '/guides/pdf/' + slug + '.pdf'; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// One copy per guide per inbox per rolling 24h (AR.capRecipients key below).
const GUIDE_COPY_RECIPIENT_DAILY_CAP = 3;

function subjectFor(slug) {
  return 'Your copy: ' + GUIDES[slug].title + ' — No Big Deal Home Solutions';
}

// Resend attachment by URL: Resend fetches the published PDF itself, so the
// function never holds the file. The URL is built from the slug table only.
function attachmentFor(slug) {
  return { filename: GUIDES[slug].file, path: pdfUrl(slug) };
}

// Branded HTML, same frame as the storm-report email (orange header, navy
// footer, Joe's first-person voice). No visitor text in it at all.
function emailHtml({ slug, postalAddress }) {
  const g = GUIDES[slug];
  const title = esc(g.title);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Barlow','Segoe UI',Roboto,'Helvetica Neue',sans-serif; line-height:1.6; color:#333; background:#f5f5f5; margin:0; }
    .container { max-width:600px; margin:0 auto; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,.1); }
    .header { background:linear-gradient(135deg,#BD5728 0%,#a14a22 100%); color:#fff; padding:30px 20px; text-align:center; }
    .header h1 { margin:0; font-size:24px; font-weight:700; letter-spacing:.5px; }
    .header p { margin:6px 0 0; font-size:14px; opacity:.92; }
    .content { padding:30px 24px; color:#333; }
    .cta-button { display:inline-block; background:#BD5728; color:#fff !important; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:700; font-size:17px; margin:18px 0; }
    .muted { color:#666; font-size:14px; }
    .footer { background:#1a3057; color:#fff; padding:20px; text-align:center; font-size:12px; }
    .footer a { color:#e8a06a; text-decoration:none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${title}</h1>
      <p>No Big Deal Home Solutions</p>
    </div>
    <div class="content">
      <p>Hi there,</p>
      <p>Here's the printable copy of <strong>${title}</strong> you asked for. It's attached to this email as a PDF.</p>
      <p>You can also read it any time on the website: <a href="${guideUrl(slug)}" style="color:#BD5728; font-weight:600;">${title} &rarr;</a></p>
      <p>If something in it doesn't match what you're seeing on your house, I'm happy to come take a look. The inspection is free.</p>
      <p style="text-align:center;">
        <a class="cta-button" href="${SITE}/inspect">Book a free inspection</a>
      </p>
      <p class="muted" style="text-align:center;">Or call or text me at <a href="${PHONE_TEL}" style="color:#BD5728;">${PHONE_DISPLAY}</a>, or just reply to this email.</p>
      <p style="margin-top:22px;">&mdash; Joe<br><span class="muted">No Big Deal Home Solutions</span></p>
    </div>
    <div class="footer">
      <p>No Big Deal Home Solutions &nbsp;|&nbsp; ${PHONE_DISPLAY} &nbsp;|&nbsp; ${REPLY_TO}</p>
      <p><a href="${SITE}">nobigdealwithjoedeal.com</a></p>${postalAddress ? `
      <p>${esc(postalAddress)}</p>` : ''}
      <p>You're getting this one email because you asked for a copy of this guide on our website.</p>
    </div>
  </div>
</body>
</html>`;
}

// The CRM card's note line for a bridged request (lead-bridge-logic.js).
function crmNoteLines(data) {
  const d = data || {};
  const out = [];
  if (isGuideSlug(d.guide)) out.push('Asked for a copy of the "' + GUIDES[d.guide].title + '" guide by email');
  else out.push('Asked for a guide copy by email');
  out.push('Storm tips email OK: ' + (d.emailConsent === true ? 'yes' : 'no'));
  out.push('Email only, no phone. Cold lead: no alert was sent.');
  return out;
}

module.exports = {
  SITE, REPLY_TO, GUIDES, GUIDE_SLUGS, STORM_TIPS_CONSENT_VERSION, GUIDE_COPY_RECIPIENT_DAILY_CAP,
  isGuideSlug, isValidEmail, guideUrl, pdfUrl, subjectFor, attachmentFor, emailHtml, crmNoteLines,
};
