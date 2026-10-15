#!/usr/bin/env node
'use strict';
/**
 * /sms-program — the public proof page for the Twilio A2P 10DLC message flow.
 *
 * WHY THIS EXISTS
 * Twilio rejected NBD's campaign twice for the call to action (error 30909,
 * field MESSAGE_FLOW). The registered brand is No Big Deal Solutions LLC; the
 * site only said "No Big Deal Home Solutions". This page names the LLC and the
 * d/b/a, lists the message types and frequency, shows each of the three opt-in
 * forms with a screenshot of its consent area, and quotes the exact wording.
 * The quotes are only proof if they match the live boxes, so they are pinned
 * here to functions/tcpa-consent.js (which tests/tcpa-consent.test.js T35 pins
 * to each form's label).
 *
 * Pure-Node, zero-dep. Run: node tests/sms-program-page-2026-10-15.test.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const C = require(path.join(ROOT, 'functions', 'tcpa-consent.js'));

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}

const PARTIAL = /<!-- nbd:partial ([\w-]+)[^>]*-->[\s\S]*?<!-- \/nbd:partial \1 -->/g;
const raw = read('docs/sms-program.html');
const own = raw.replace(PARTIAL, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&ndash;/g, '–').replace(/&rsquo;/g, '’').replace(/&ldquo;|&rdquo;/g, '"')
  .replace(/&middot;/g, '·').replace(/&#64;/g, '@').replace(/&#46;/g, '.').replace(/\s+/g, ' ').trim();
const text = visible(own);

console.log('\n/sms-program — A2P message-flow proof page\n' + '═'.repeat(48));

ok('P1 canonical is https://nobigdealwithjoedeal.com/sms-program', /<link rel="canonical" href="https:\/\/nobigdealwithjoedeal\.com\/sms-program">/.test(raw));
ok('P2 indexable (no robots noindex)', !/<meta name="robots"[^>]*noindex/i.test(raw));
ok('P3 program name "No Big Deal Home Solutions Text Messages"', /No Big Deal Home Solutions Text Messages/.test(text));
ok('P4 legal entity + d/b/a, Goshen OH, phone and email', /No Big Deal Solutions LLC , d\/b\/a No Big Deal Home Solutions|No Big Deal Solutions LLC, d\/b\/a No Big Deal Home Solutions/.test(text)
  && /Goshen, OH/.test(text) && /\(859\) 420-7382/.test(text) && /jd@nobigdealwithjoedeal\.com/.test(text));
ok('P5 message types listed', ['Appointment confirmations and reminders', 'Estimate and project updates', 'Invoice and payment notices',
  'Replies to questions you send us', 'Storm alerts'].every((t) => text.includes(t)));
ok('P6 frequency and rates', /Message frequency varies/.test(text) && /2–4 texts per season/.test(text) && /Message and data rates may apply/.test(text));
ok('P7 STOP, HELP and START', /reply STOP/.test(text) && /reply HELP/.test(text) && /reply START/.test(text) && /Carriers are not liable/.test(text));
ok('P8 optional on /inspect and /estimate, required on /storm-alerts', /Consent is optional on \/inspect and \/estimate/.test(text) && /Consent is required on \/storm-alerts/.test(text));
ok('P9 the /privacy no-sharing sentence, verbatim',
  text.includes('No mobile information will be shared with third parties or affiliates for marketing or promotional purposes. Text messaging opt-in data and consent will not be shared with any third parties.'));
ok('P10 links /privacy, /privacy#sms-terms and /terms', ['href="/privacy"', 'href="/privacy#sms-terms"', 'href="/terms"'].every((h) => own.includes(h)));
ok('P11 no "text us first" opt-in path', !/text(ing)? us first/i.test(text));

console.log('\nThe three opt-in forms: link, screenshot, exact wording');
const FORMS = [
  ['inspect', '/inspect', C.INSPECT_CONSENT_VERSION],
  ['estimate', '/estimate', C.ESTIMATE_CONSENT_VERSION],
  ['storm-alerts', '/storm-alerts', C.STORM_ALERTS_CONSENT_VERSION],
];
const blocks = [...own.matchAll(/<div class="sms-form" id="form-([\w-]+)">([\s\S]*?)<\/blockquote>/g)];
ok('F0 exactly the three forms', JSON.stringify(blocks.map((m) => m[1])) === JSON.stringify(FORMS.map((f) => f[0])), blocks.map((m) => m[1]).join(','));
for (const [name, url, version] of FORMS) {
  const m = blocks.find((b) => b[1] === name);
  const block = m ? m[2] : '';
  ok('F1 ' + name + ': links ' + url, block.includes('<a href="' + url + '">'));
  const img = (block.match(/<img [^>]*>/) || [''])[0];
  const src = (img.match(/src="([^"]+)"/) || [])[1] || '';
  const file = path.join(ROOT, 'docs', src);
  ok('F2 ' + name + ': screenshot exists under /assets/images/sms/ and is under 150 KB', /^\/assets\/images\/sms\//.test(src) && fs.existsSync(file) && fs.statSync(file).size < 150 * 1024, src);
  const alt = (img.match(/alt="([^"]*)"/) || [])[1] || '';
  ok('F3 ' + name + ': descriptive alt text naming the consent box', alt.length > 60 && /consent box/.test(alt), alt);
  ok('F4 ' + name + ': width/height set and lazy-loaded', /width="\d+"/.test(img) && /height="\d+"/.test(img) && /loading="lazy"/.test(img));
  const quote = visible((block.match(/<blockquote class="sms-quote">([\s\S]*)$/) || [])[1] || '').replace(/ Privacy Policy · Terms$/, '');
  ok('F5 ' + name + ': quoted wording is word-for-word CONSENT_TEXTS[' + version + ']', quote === C.CONSENT_TEXTS[version], quote);
}

console.log('\nWiring');
ok('W1 /sms-program in docs/sitemap.xml and build-sitemap CORE_PAGES',
  /<loc>https:\/\/nobigdealwithjoedeal\.com\/sms-program<\/loc>/.test(read('docs/sitemap.xml')) && /\['sms-program',\s*'sms-program\.html'/.test(read('scripts/build-sitemap.js')));
const partials = ['footer-standard', 'footer-extended', 'footer-blog', 'footer-area', 'footer-slim'];
const bad = partials.filter((n) => { const s = read('site-src/partials/' + n + '.html'); return !s.includes('<a href="/sms-program">') || !s.includes('No Big Deal Home Solutions is a d/b/a of No Big Deal Solutions LLC.'); });
ok('W2 every footer partial links /sms-program and states the d/b/a', bad.length === 0, bad.join(','));
ok('W3 /terms#sms-terms links /sms-program', /id="sms-terms"[\s\S]*?<a href="\/sms-program">[\s\S]*?class="terms-section"/.test(read('docs/terms.html')));
const priv = read('docs/privacy.html');
const pi = priv.indexOf('id="sms-terms"');
ok('W4 /privacy#sms-terms links /sms-program', pi > 0 && priv.slice(pi, priv.indexOf('</div>', pi)).includes('<a href="/sms-program">'));
ok('W5 no inline <style> or <script> on the page itself (partials aside)', !/<style\b/.test(own) && !/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/.test(own));

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
