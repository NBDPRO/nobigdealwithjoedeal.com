/**
 * scripts/add-guide-quick-lead-form.js — lead capture on the homeowner guides
 * (2026-11-25, website review: the 7 guides had no capture at all).
 *
 * Injects the SAME self-configuring quick-lead form the area/service pages use
 * (docs/assets/js/quick-lead-form.js → submitPublicLead, kind "contact", source
 * "page-form:/guides/<slug>") right after each guide's closing "next step"
 * panel. The guide itself stays free to read with no form in front of it; the
 * form sits at the end, for a reader who now wants Joe to look at the house.
 *
 * Outside the generator-owned GUIDE-BODY region (scripts/build-guides.js), so
 * a rebuild of the guide body never touches it.
 *
 * Idempotent: pages already carrying data-nbd-quick-form are skipped.
 * Run: node scripts/add-guide-quick-lead-form.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const GUIDES_DIR = path.join(__dirname, '..', 'docs', 'guides');

// slug → data-service ('' = the form's default "Book a Free Inspection" heading)
const GUIDES = {
  'compare-roofing-quotes-checklist': '',
  'hail-photo-baseline-sheet': '',
  'home-care-warranty-card': '',
  'how-a-roof-works': '',
  'kentucky-ohio-storm-claim-guide': '',
  'roof-financing-explained': '',
  'siding-gutter-buyers-guide': 'Gutters &amp; Siding',
};

const QLF_CSS = '<link rel="stylesheet" href="/assets/css/quick-lead-form.css">';
const QLF_JS = '<script defer src="/assets/js/quick-lead-form.js"></script>';
const NAV_CSS = '<link rel="stylesheet" href="/assets/css/mobile-cta.css">';
const RELATED = '<nav class="g-related"';

let changed = 0, skipped = 0, failed = 0;

for (const [slug, service] of Object.entries(GUIDES)) {
  const file = path.join(GUIDES_DIR, slug + '.html');
  const raw = fs.readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let s = raw.replace(/\r\n/g, '\n');

  if (s.includes('data-nbd-quick-form')) { console.log('  = ' + slug + ' already has the quick form'); skipped++; continue; }
  const at = s.indexOf(RELATED);
  // how-a-roof-works is hand-built (no GUIDE-BODY region); the others must
  // get the form AFTER their generated region, never inside it.
  const generated = s.includes('<!-- GUIDE-BODY:START');
  const end = s.indexOf('<!-- GUIDE-BODY:END ' + slug + ' -->');
  if (at === -1 || (generated && (end === -1 || at < end)) || !s.includes(NAV_CSS) || !s.includes('</body>')) {
    console.error('  ✗ ' + slug + ': anchors not found (g-related after GUIDE-BODY:END, mobile-cta.css, </body>)'); failed++; continue;
  }
  const svc = service ? ' data-service="' + service + '"' : '';
  const block =
    '<!-- QUICK LEAD FORM (2026-11-25): same embed as the area/service pages; posts through submitPublicLead as page-form:/guides/' + slug + ' -->\n' +
    '  <section class="qlf-section" id="quote"><div class="qlf-wrap"><div data-nbd-quick-form' + svc + '></div></div></section>\n  ';
  s = s.slice(0, at) + block + s.slice(at);
  if (!s.includes(QLF_CSS)) s = s.replace(NAV_CSS, NAV_CSS + '\n' + QLF_CSS);
  if (!s.includes(QLF_JS)) s = s.replace('</body>', QLF_JS + '\n</body>');
  fs.writeFileSync(file, eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);
  console.log('  + ' + slug);
  changed++;
}

console.log('\n' + changed + ' changed, ' + skipped + ' skipped, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
