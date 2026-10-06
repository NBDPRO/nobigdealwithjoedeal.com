/**
 * tests/no-personal-data-in-repo-2026-10-06.test.js
 *
 * This repository is PUBLIC (it has to be: see
 * documentation/audit/CRM-ADDRESS-INTEGRITY-2026-08-18.md and the 2026-07-30
 * note on why it can't go private). On 2026-10-06 a sweep found real customer
 * phone numbers, emails, names and home addresses in session notes, admin
 * scripts, test fixtures and served code comments, plus Jo's personal cell.
 * They were scrubbed from HEAD (the old values remain in git history; Jo
 * chose not to rewrite it). This guard keeps new ones out.
 *
 * Every tracked text file is scanned for:
 *   1. a formatted North American phone number — (513) 555-0123, 513-555-0123,
 *      513.555.0123, +1 513 555 0123, +15135550123 — that is not fictional
 *      (555 area code or exchange), not toll-free, and not one of the public
 *      business lines below;
 *   2. an email address whose domain is not on the allowlist below (fixture
 *      domains, the company's own, vendor sandboxes), unless the exact address
 *      is listed (Jo's own accounts, which the code uses as owner config).
 *
 * COMMENT-AWARE ON PURPOSE: this scan reads raw file text and does NOT strip
 * comments. Most of the 2026-10-06 hits were in comments (`// (Customer name:
 * 1944 AND 1942 ... Ave)`, an HTML comment in customer.html), and comments in
 * docs/ ship to the public site. A comment is not a hiding place here — the
 * planted-sample checks at the bottom prove a phone or email inside a `//`,
 * `/* *\/` and `<!-- -->` comment each fails the scan.
 *
 * Customer NAMES and street addresses can't be pattern-matched without
 * drowning in false positives; the sweep checked those against the real CRM
 * read-only. Use "Customer A", fake surnames and *.example.com in fixtures.
 *
 * Run: node tests/no-personal-data-in-repo-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// ── allowlists ──────────────────────────────────────────────────────────────
// Public business lines, printed on live sites or published by a government office.
const ALLOWED_PHONES = new Set([
  '8594207382', // No Big Deal Home Solutions — the number on every page of the site
  '5139405589', // NBD's AI receptionist line (Thursday / Bland)
  '9377644855', // NBD's Twilio business line
  '5138275297', // Oaks Roofing & Construction — the tenant's public business line (docs/sites/oaks)
]);
const ALLOWED_PHONE_PREFIXES = [
  '859258', // Lexington-Fayette Urban County Government offices (documentation/runbooks/LEXINGTON-CONTRACTOR-SETUP.md)
];
const TOLL_FREE = new Set(['800', '833', '844', '855', '866', '877', '888']);

// Fixture, company and vendor domains. A new real-world domain fails until it is added here on purpose.
const ALLOWED_EMAIL_DOMAINS = [
  /(^|\.)example\.(com|org|net)$/, /\.(test|invalid|example|localhost)$/,
  /^nobigdealwithjoedeal\.com$/, /^nobigdeal\.pro$/, /^nobigdeals\.com$/, /^nbdpro\.com$/,
  /^oaksrfc\.com$/, /^oaksroofingandconstruction\.com$/, /^oaksroofing\.com$/, /^oaks\.com$/, // the Oaks tenant's business addresses
  /^resend\.dev$/, /(^|\.)gserviceaccount\.com$/, /\.ingest\.us\.sentry\.io$/, /^lexingtonky\.gov$/,
  // throwaway fixture domains used in unit tests
  /^(x|y|e|b|bar|evil|owner|smith|smithroofing|carrier|company|yourcompany|yourdomain|email)\.(com|co|io)$/,
];
// Jo's own accounts (owner config / alert recipients) and generic placeholders at real domains.
const ALLOWED_EMAILS = new Set([
  'jonathandeal459@gmail.com', 'jdeal.tia@gmail.com', 'jdeal.tia+calcomqa@gmail.com', 'jo.deal+x@gmail.com',
  'someone@gmail.com',
]);

// Never scanned: lockfiles, vendored third-party code, binaries, and SVG vector
// art (a run of three path coordinates can read as a phone number).
const SKIP = [/(^|\/)package-lock\.json$/, /^docs\/assets\/vendor\//, /\.min\.(js|css)$/, /\.svg$/i];
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|heic|pdf|woff2?|ttf|otf|eot|mp3|mp4|mov|webm|zip|gz|xlsx|docx|pptx)$/i;

// ── scanner ─────────────────────────────────────────────────────────────────
const PHONE_RE = /(?<![\d#-])(?:\+?1[ .-]?)?(?:\(([2-9]\d{2})\)[ .-]?|([2-9]\d{2})[ .-])([2-9]\d{2})[ .-](\d{4})(?![\d-])|(?<![\d])\+1([2-9]\d{2})([2-9]\d{2})(\d{4})(?!\d)/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;

function phoneAllowed(area, exch, digits) {
  if (area === '555' || exch === '555') return true;
  if (TOLL_FREE.has(area)) return true;
  if (ALLOWED_PHONES.has(digits)) return true;
  return ALLOWED_PHONE_PREFIXES.some((p) => digits.startsWith(p));
}
function emailAllowed(addr, domain) {
  const a = addr.toLowerCase(), d = domain.toLowerCase();
  return ALLOWED_EMAILS.has(a) || ALLOWED_EMAIL_DOMAINS.some((re) => re.test(d));
}
function scanText(text) {
  const hits = [];
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(PHONE_RE)) {
    const area = m[1] || m[2] || m[5], exch = m[3] || m[6], last = m[4] || m[7];
    if (!phoneAllowed(area, exch, area + exch + last)) hits.push({ kind: 'phone', line: lineOf(m.index), value: m[0].trim() });
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!emailAllowed(m[0], m[1])) hits.push({ kind: 'email', line: lineOf(m.index), value: m[0] });
  }
  return hits;
}
const mask = (v) => v.replace(/\d(?=\d{2})/g, '•').replace(/^[^@]{2}[^@]*@/, (s) => s.slice(0, 2) + '…@');

// ── 1. the tree ─────────────────────────────────────────────────────────────
console.log('\n1. no personal phone numbers or emails in any tracked file');
let files = [];
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 28 }).toString('utf8').split('\0').filter(Boolean);
} catch (e) { /* not a git checkout */ }
ok('git ls-files listed the tree (scan is not vacuous)', files.length > 1000, 'got ' + files.length + ' files');
const offenders = [];
let scanned = 0;
for (const f of files) {
  if (SKIP.some((re) => re.test(f)) || BINARY.test(f)) continue;
  let buf; try { buf = fs.readFileSync(path.join(ROOT, f)); } catch (e) { continue; }
  if (buf.includes(0)) continue;
  scanned++;
  for (const h of scanText(buf.toString('utf8'))) offenders.push(f + ':' + h.line + '  ' + h.kind + '  ' + mask(h.value));
}
ok('scanned the text files (' + scanned + ')', scanned > 1000);
ok('no tracked file carries a personal phone number or email', offenders.length === 0,
  offenders.slice(0, 40).join('\n      ') + (offenders.length > 40 ? '\n      … ' + (offenders.length - 40) + ' more' : '') +
  '\n      Remove it (customer data belongs in the CRM or Jo\'s private notes), use a 555 number / @example.com fixture,' +
  '\n      or — for a genuinely public business line — add it to the allowlist in this file with a reason.');
ok('the moved customer data file is not back in the repo', !files.includes('scripts/legacy-address-corrections.json'));

// ── 2. the scanner itself can fail (planted samples, built at runtime so this file stays clean) ──
console.log('\n2. planted samples are caught — including inside comments');
const P = '51' + '3-86' + '7-53' + '09';                 // a non-555 local number
const E = 'jane' + '.doe' + '@' + 'gm' + 'ail.com';       // a personal webmail address
const B = 'owner' + '@' + 'some-real-business.com';       // an un-allowlisted business domain
ok('a phone in a // comment is caught', scanText('const x = 1; // call ' + P + ' tomorrow').length === 1);
ok('a phone in a /* */ comment is caught', scanText('/* customer: ' + P + ' */').length === 1);
ok('a phone in an HTML comment is caught', scanText('<!-- ' + '(' + P.slice(0, 3) + ') ' + P.slice(4) + ' -->').length === 1);
ok('an E.164 phone is caught', scanText("phone: '+1" + P.replace(/-/g, '') + "'").length === 1);
ok('a dotted phone in markdown is caught', scanText('- phone ' + P.replace(/-/g, '.')).length === 1);
ok('a webmail address is caught', scanText('email: ' + E).length === 1);
ok('a webmail address in a // comment is caught', scanText('// emailed ' + E + ' the invoice').length === 1);
ok('an unknown business domain is caught', scanText('<!-- ' + B + ' -->').length === 1);
ok('CONTROL a 555 fixture number passes', scanText("'(513) 555-0142' '+15135550101'").length === 0);
ok('CONTROL the public business line passes', scanText('(859) 420-' + '7382').length === 0);
ok('CONTROL toll-free passes', scanText('1-800-' + '555-0199 and 1-888-' + '867-5309').length === 0);
ok('CONTROL example.com / *.test fixtures pass', scanText('pat@example.com rep@nbd.test x@demo.test').length === 0);
ok('CONTROL a bare 10-digit id or a big int literal is not a phone', scanText('id 5138675309 z-index 2147483647 ts 1700000000000').length === 0);
ok('CONTROL a date or version is not a phone', scanText('2026-10-06 v1.2.3 123-45-6789').length === 0);

// A file planted in the real tree trips the tree scan too (proved by hand when this
// guard was written: an untracked file is invisible to `git ls-files`, so the
// 2026-10-06 check added one and ran `git add -N` — the scan went red, then green).

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
