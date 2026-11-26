/**
 * scripts/add-guide-email-copy.js — the "Email me a copy" box on the
 * homeowner guides (2026-11-26; second half of the 2026-11-25 guides capture
 * work, after the quick lead form).
 *
 * Injects, right after each guide's generated GUIDE-BODY region (so
 * scripts/build-guides.js never touches it), a small dark panel with an email
 * field and the optional storm-tips box. docs/assets/js/guide-email-copy.js
 * runs it; the section ships `hidden` and the script reveals it, so a reader
 * without JavaScript sees only the guide and its Download button.
 *
 * Only the guides with a published PDF get it: the slug list matches
 * functions/guide-copy-logic.js GUIDES (tests/guide-email-copy-2026-11-26.test.js
 * keeps the two in step). /guides/how-a-roof-works has no PDF and no box.
 *
 * Idempotent: pages already carrying data-guide-copy are skipped.
 * Run: node scripts/add-guide-email-copy.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const GUIDES_DIR = path.join(__dirname, '..', 'docs', 'guides');
const SLUGS = [
  'compare-roofing-quotes-checklist',
  'hail-photo-baseline-sheet',
  'home-care-warranty-card',
  'kentucky-ohio-storm-claim-guide',
  'roof-financing-explained',
  'siding-gutter-buyers-guide',
];

// The checkbox wording. Changing it means a new STORM_TIPS_CONSENT_VERSION in
// functions/guide-copy-logic.js, so a stored yes keeps saying what it agreed to.
const CONSENT_TEXT = 'Also email me storm-season tips from Joe now and then. Unsubscribe any time.';

const SUBMIT_JS = '<script defer src="/assets/js/public-lead-submit.js"></script>';
const COPY_JS = '<script defer src="/assets/js/guide-email-copy.js?v=1"></script>';

function block(slug) {
  return [
    '<!-- EMAIL ME A COPY (2026-11-26): posts through submitPublicLead as guide_copy; functions/guide-copy-email.js sends the PDF -->',
    '  <section class="g-panel" aria-labelledby="g-copy-title" data-guide-copy="' + slug + '" hidden>',
    '    <h2 id="g-copy-title">Email me a copy</h2>',
    '    <p>Get the printable PDF of this guide in your inbox. One email with the file, nothing else unless you tick the box.</p>',
    '    <form class="g-form" id="guideCopyForm" novalidate>',
    '      <div><label for="gcEmail">Your email</label><input type="email" id="gcEmail" name="email" autocomplete="email" required maxlength="200"></div>',
    '      <label class="g-consent" for="gcConsent"><input type="checkbox" id="gcConsent" name="emailConsent" value="yes"> <span>' + CONSENT_TEXT + '</span></label>',
    '      <div class="g-hp" aria-hidden="true"><label for="gcHp">Leave this empty</label><input type="text" id="gcHp" name="nbd_hp" tabindex="-1" autocomplete="off"></div>',
    '      <button type="submit" class="g-btn g-btn-primary">Email me the PDF</button>',
    '      <p class="g-form-note">See the <a href="/privacy">privacy policy</a>.</p>',
    '      <p class="g-form-msg" id="guideCopyMsg" role="status" aria-live="polite" hidden></p>',
    '    </form>',
    '  </section>',
    '  ',
  ].join('\n');
}

module.exports = { SLUGS, CONSENT_TEXT, block };

function main() {
  let changed = 0, skipped = 0, failed = 0;

  for (const slug of SLUGS) {
    const file = path.join(GUIDES_DIR, slug + '.html');
    const raw = fs.readFileSync(file, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    let s = raw.replace(/\r\n/g, '\n');

    if (s.includes('data-guide-copy=')) { console.log('  = ' + slug + ' already has the email box'); skipped++; continue; }
    const endMark = '<!-- GUIDE-BODY:END ' + slug + ' -->\n';
    const at = s.indexOf(endMark);
    if (at === -1 || !s.includes('</body>') || !s.includes('data-pdf-href="/guides/pdf/' + slug + '.pdf"')) {
      console.error('  ✗ ' + slug + ': anchors not found (GUIDE-BODY:END, </body>, its PDF slot)'); failed++; continue;
    }
    const insertAt = at + endMark.length;
    // Keep the indentation the next line already had.
    s = s.slice(0, insertAt) + '  ' + block(slug) + s.slice(insertAt).replace(/^ {2}/, '');
    if (!s.includes(SUBMIT_JS)) s = s.replace('</body>', SUBMIT_JS + '\n</body>');
    s = s.replace('</body>', COPY_JS + '\n</body>');
    fs.writeFileSync(file, eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s);
    console.log('  + ' + slug);
    changed++;
  }

  console.log('\n' + changed + ' changed, ' + skipped + ' skipped, ' + failed + ' failed');
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main());
