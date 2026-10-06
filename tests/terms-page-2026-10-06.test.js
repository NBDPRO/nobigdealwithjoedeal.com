#!/usr/bin/env node
'use strict';
/**
 * /terms — the homeowner Terms & Conditions page carriers review for A2P 10DLC.
 *
 * WHY THIS EXISTS
 * NBD's Twilio A2P 10DLC campaign was REJECTED on 2026-10-06 for "Terms and
 * Conditions issues": the campaign's Terms URL pointed at a section inside the
 * privacy policy (/privacy#sms-terms) and /terms was a 404. Twilio's campaign
 * review error codes (twilio.com/docs/api/errors/30557 … 30563) each name one
 * element a Terms page must carry: business/program name (30557), message
 * frequency (30558), program description (30559), customer support info +
 * HELP (30560), opt-out / STOP (30561), message & data rates (30562) and the
 * carrier liability disclaimer (30563). Each pin below maps to one of those,
 * so deleting or rewording any of them goes red before a resubmission.
 *
 * Text is read with HTML comments stripped and nbd:partial regions removed,
 * so a comment that quotes a phrase, or the shared footer, can neither
 * satisfy a presence pin nor trip an absence pin.
 *
 * Kept separate from docs/pro/terms.html (the NBD Pro SaaS terms) on purpose.
 *
 * Pure-Node, zero-dep. Run: node tests/terms-page-2026-10-06.test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}

const PARTIAL = /<!-- nbd:partial ([\w-]+)[^>]*-->[\s\S]*?<!-- \/nbd:partial \1 -->/g;
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');
// Visible words: tags out, entities decoded, whitespace collapsed.
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&ndash;/g, '–').replace(/&#64;/g, '@').replace(/&#46;/g, '.')
  .replace(/\s+/g, ' ').trim();

console.log('\n/terms — homeowner Terms & Conditions (A2P 10DLC)\n' + '═'.repeat(56));

const FILE = 'docs/terms.html';
ok('T1 docs/terms.html exists (served at /terms via cleanUrls)', fs.existsSync(path.join(ROOT, FILE)));
const raw = fs.existsSync(path.join(ROOT, FILE)) ? read(FILE) : '';
const own = stripComments(raw.replace(PARTIAL, ' '));   // the page's own markup
const text = visible(own);

// The SMS section, by its anchor, up to the next section.
const i = own.indexOf('id="sms-terms"');
const sms = i > 0 ? own.slice(i, own.indexOf('class="terms-section"', i + 20) > 0 ? own.indexOf('class="terms-section"', i + 20) : undefined) : '';
const smsText = visible(sms);

ok('T2 canonical is https://nobigdealwithjoedeal.com/terms', /<link rel="canonical" href="https:\/\/nobigdealwithjoedeal\.com\/terms">/.test(raw));
ok('T3 page is indexable (no robots noindex)', !/<meta name="robots"[^>]*noindex/i.test(raw));
ok('T4 "Last updated: October 6, 2026" line', /Last updated: October 6, 2026/.test(text));
ok('T5 legal name + DBA: No Big Deal Solutions LLC (DBA No Big Deal Home Solutions)', /No Big Deal Solutions LLC,? (\(DBA|doing business as) No Big Deal Home Solutions/.test(text));

console.log('\nSMS / Text Messaging Terms section (#sms-terms)');
ok('S1 section exists with heading "SMS / Text Messaging Terms"', i > 0 && /SMS \/ Text Messaging Terms/.test(smsText));
ok('S2 [30557] program name "No Big Deal Home Solutions text messages"', /No Big Deal Home Solutions text messages/.test(smsText));
// [30559] program description — the campaign's use cases.
const USES = [/appointment confirmations and reminders/i, /estimate and project updates/i, /invoice and payment notices/i,
  /replies to questions/i, /storm-damage inspection reminders[^.]*opted in/i, /storm alerts[^.]*Storm Alerts/i];
const missingUses = USES.filter((re) => !re.test(smsText)).map(String);
ok('S3 [30559] program description lists every campaign use case', missingUses.length === 0, missingUses.join(' | '));
ok('S4 [30558] "Message frequency varies"', /Message frequency varies/.test(smsText));
ok('S5 [30562] "Message and data rates may apply"', /Message and data rates may apply/.test(smsText));
ok('S6 [30561] STOP in bold with "Reply STOP to cancel"', /Reply <strong>STOP<\/strong> to cancel/.test(sms));
ok('S7 [30560] HELP in bold with "Reply HELP for help"', /Reply <strong>HELP<\/strong> for help/.test(sms));
ok('S8 [30560] support phone (859) 420-7382 with a tel: link', /\(859\) 420-7382/.test(smsText) && /href="tel:\+18594207382"/.test(sms));
ok('S9 [30560] support email jd@nobigdealwithjoedeal.com', /jd@nobigdealwithjoedeal\.com/.test(smsText));
ok('S10 [30563] "Carriers are not liable for delayed or undelivered messages"', /Carriers are not liable for delayed or undelivered messages/.test(smsText));
ok('S11 consent is not a condition of purchase', /consent is not a condition of purchase/i.test(smsText));
ok('S12 explains how to opt in (checkbox, never pre-checked)', /How you opt in/.test(smsText) && /consent box/.test(smsText) && /never pre-checked/.test(smsText));
ok('S13 links the Privacy Policy', /<a href="\/privacy[^"]*">Privacy Policy<\/a>/.test(sms));
ok('S14 mobile info not shared with third parties/affiliates for marketing',
  /No mobile information will be shared with third parties or affiliates for marketing or promotional purposes/.test(smsText));

console.log('\nGeneral terms + homeowner honesty rules');
ok('G1 estimates are estimates until a signed contract', /is an estimate only/.test(text) && /written contract signed by you and by us/.test(text));
ok('G2 scheduling section', /Scheduling/.test(text) && /weather/.test(text));
ok('G3 website content is informational', /general information/.test(text));
ok('G4 contact section repeats phone + email', (text.match(/\(859\) 420-7382/g) || []).length >= 2 && (text.match(/jd@nobigdealwithjoedeal\.com/g) || []).length >= 2);
const BANNED = [
  [/\blicensed\b|\blicense\b/i, 'licensed/license (no OH/KY registration number backs it)'],
  [/\bfounded\b|\bsince (19|20)\d\d\b|\bestablished\b/i, 'founding year'],
  [/\b(?:7|seven) years\b(?!\+)/i, 'bare "7 years" (use 7+ years)'],
  [/claimable|claim potential|insurance (will|should) (pay|cover)|guarantee[ds]? (approval|coverage)/i, 'insurance-outcome promise'],
  [/Master Elite|Owens Corning|Hardie (certified|Certified|Preferred)/, 'uncertified credential'],
  [/\$\s?\d/, 'a price'],
  [/lifetime warranty|warranty (of|for) life/i, 'invented warranty'],
];
for (const [re, why] of BANNED) {
  const m = text.match(re);
  ok('H no ' + why, !m, m && m[0]);
}

console.log('\nWiring: sitemap, footers, privacy, separation from /pro/terms');
ok('W1 /terms is in docs/sitemap.xml', /<loc>https:\/\/nobigdealwithjoedeal\.com\/terms<\/loc>/.test(read('docs/sitemap.xml')));
ok('W2 /terms is a CORE_PAGES row in scripts/build-sitemap.js (else the next --write drops it)', /\['terms',\s*'terms\.html'/.test(read('scripts/build-sitemap.js')));
const footerPartials = ['footer-standard', 'footer-extended', 'footer-blog', 'footer-area', 'footer-slim'];
const badPartials = footerPartials.filter((n) => {
  const s = read('site-src/partials/' + n + '.html');
  const p = s.indexOf('data-nbd-privacy="1"'), t = s.indexOf('<a href="/terms" data-nbd-terms="1"');
  // Terms sits immediately after the Privacy link (only a separator between).
  return !(p > 0 && t > p && /^data-nbd-privacy="1"[^>]*>Privacy<\/a>\s*(?:<span[^>]*>·<\/span>|&middot;)\s*$/.test(s.slice(p, t)));
});
ok('W3 every footer partial links Terms right next to Privacy', badPartials.length === 0, badPartials.join(','));
// Every public page that links Privacy in its footer also links Terms.
const orphan = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(DOCS, p).split(path.sep).join('/');
    if (e.isDirectory()) { if (/^(pro|admin|dev|assets|sites)$/.test(rel)) continue; walk(p); }
    else if (e.name.endsWith('.html')) {
      const s = stripComments(fs.readFileSync(p, 'utf8'));
      if (s.includes('data-nbd-privacy="1"') && !s.includes('<a href="/terms" data-nbd-terms="1"')) orphan.push(rel);
    }
  }
})(DOCS);
ok('W4 every page with a footer Privacy link also has the Terms link', orphan.length === 0, orphan.slice(0, 5).join(', '));
ok('W5 /terms itself carries the footer Terms link (footer-extended stamped)', /<!-- nbd:partial footer-extended -->[\s\S]*data-nbd-terms="1"[\s\S]*<!-- \/nbd:partial footer-extended -->/.test(raw));
const priv = stripComments(read('docs/privacy.html'));
const pi = priv.indexOf('id="sms-terms"');
const privSms = pi > 0 ? priv.slice(pi, priv.indexOf('</div>', pi)) : '';
ok('W6 /privacy#sms-terms still exists and now links /terms', pi > 0 && /<a href="\/terms[^"]*"[^>]*>Terms &amp; Conditions<\/a>/.test(privSms));
ok('W7 NBD Pro SaaS terms (docs/pro/terms.html) untouched and not the homeowner page', fs.existsSync(path.join(DOCS, 'pro', 'terms.html')) && !/No Big Deal Home Solutions text messages/.test(read('docs/pro/terms.html')));

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
