/**
 * The site must not deny subcontracting.
 *
 * WHY (2026-09-20)
 * ──────────────────────────────────────────────────────────────────
 * 124 service pages carried the badge "I don't subcontract", styled identically
 * to "Licensed & insured" two slots to its right — so a homeowner read it as a
 * verified fact of the same class. Jo subcontracts: he runs the company himself
 * with no salespeople, and brings in established trade crews (roofing
 * residential + commercial, gutters, siding, interior/drywall) who are
 * independent subcontractors, not employees.
 *
 * The site also contradicted itself in public. docs/partners.html openly
 * recruits those crews — "Crews & Subcontractors", and a JSON-LD FAQPage entry
 * "How are subcontractor crews paid?" — on an indexed page, in structured data,
 * on the same domain. And docs/blog/how-to-choose-a-roofer-after-a-storm.html
 * coaches homeowners to ask "Who is actually on my roof — your crew or a sub?"
 * A homeowner following NBD's own advice caught NBD.
 *
 * WHAT THIS PINS
 * ──────────────
 * 1. No denial phrasing anywhere in customer-facing docs/.
 * 2. The replacement badge is on all 124 service pages, and the GENERATOR emits
 *    it too — otherwise the next stamped page reintroduces the old sentence.
 * 3. partners.html's honest Crews & Subcontractors track SURVIVES. This is the
 *    guard that matters most on a mechanical fix pass: seven reviewers flagged
 *    that section as a "contradiction" and every one was rejected on
 *    verification, because it is the correct half. The foreseeable accident is
 *    someone "resolving" the contradiction by deleting the only honest public
 *    statement while the denials stay live. If that happens, this fails.
 * 4. llms.txt answers "Who does the work?" with the crews named. That file
 *    exists to be quoted verbatim by AI assistants and is advertised twice in
 *    robots.txt; before this it mentioned crews zero times in 165 lines, so an
 *    assistant asked "does Joe subcontract?" answered "no, solo operator".
 *
 * Pure Node, zero deps. Run: node tests/subcontracting-honesty.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
function ok(label, cond, hint) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (hint ? '\n      ' + hint : '')); }
}
function section(t) { console.log('\n' + t); }

// Walk docs/ for customer-facing text. docs/sites/oaks/** is a DIFFERENT
// company's microsite (noindex + Disallow'd) — their copy, not Jo's.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (rel.startsWith('docs/sites/oaks')) continue;
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(html|txt)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const PAGES = walk('docs');

// Comments are stripped: the corrected pages EXPLAIN what was removed and so
// legitimately contain the very phrases they must no longer claim.
const visibleOf = (s) => s.replace(/<!--[\s\S]*?-->/g, '');

section(`no denial of subcontracting anywhere in docs/ (${PAGES.length} files scanned)`);

const DENIALS = [
  "I don't subcontract",
  'not a subcontractor',
  'no subcontractors',
  'No subcontracted',
  'no subcontracted',
  'rotating crew of subs',
];
for (const phrase of DENIALS) {
  const hits = PAGES.filter((p) => visibleOf(read(p)).includes(phrase));
  ok(`no page says ${JSON.stringify(phrase)}`, hits.length === 0,
    hits.length ? 'found in: ' + hits.slice(0, 4).join(', ') + (hits.length > 4 ? ` (+${hits.length - 4} more)` : '') : '');
}

section('the replacement badge shipped everywhere, including the generator');

const BADGE = 'You deal with me, start to finish';
const servicePages = PAGES.filter((p) => /^docs\/services\/[^/]+\.html$/.test(p));
const withBadge = servicePages.filter((p) => read(p).includes(BADGE));
// 2026-11-26: 98, after the GSC content merge folded the 26 hail-damage-<town> pages into their storm twins.
// 2026-11-28: 100, with roof-repair-lexington-ky and roof-inspection-lexington-ky.
ok(`all 100 stamped service pages carry the badge (found ${withBadge.length})`, withBadge.length === 100);
ok('the generator emits the new badge too',
  read('scripts/add-transparency-strip-services.js').includes(BADGE),
  'if the generator still emits the old sentence, the next stamped page reintroduces it');
ok('...and no longer emits the old one',
  !read('scripts/add-transparency-strip-services.js').includes("I don't subcontract"));

section('partners.html keeps telling the truth — do NOT "fix" the honest half');

const partners = read('docs/partners.html');
ok('the Crews & Subcontractors heading survives', /Crews\s*&amp;\s*Subcontractors/.test(partners),
  'this is the correct half of the contradiction — deleting it leaves the denials as the only story');
ok('the "crews I can call" statement survives', partners.includes('crews I can call'));
ok('the JSON-LD "How are subcontractor crews paid?" entry survives',
  partners.includes('How are subcontractor crews paid?'),
  'machine-readable honesty — an AI assistant reads this');
ok('crews are still told certificates are required',
  /workers.{0,3} comp certificates|Certificates of insurance/i.test(partners));

section('llms.txt answers the crew question, because assistants quote it verbatim');

const llms = read('docs/llms.txt');
const whoDoes = llms.slice(llms.indexOf('**Who does the work?**'));
ok('the "Who does the work?" section exists', llms.includes('**Who does the work?**'));
ok('...and it names the crews', /crew/i.test(whoDoes.slice(0, 900)),
  'before 2026-09-20 this file mentioned crews zero times in 165 lines');
ok('...and says they are subcontractors, not employees',
  /subcontractor/i.test(whoDoes.slice(0, 900)) && /not employees/i.test(whoDoes.slice(0, 900)));
ok('...and still credits Joe with being on every job',
  /on site for every job|supervises every installation/i.test(whoDoes.slice(0, 900)));
ok('the file no longer opens with an unqualified "Solo owner-operated"',
  !llms.includes('**Solo owner-operated:**'));

section('true statements were left alone');

ok('the blog still tells homeowners to ask who is on the roof',
  read('docs/blog/how-to-choose-a-roofer-after-a-storm.html').includes("Subcontracting isn't automatically bad"),
  'this is the model for the honest framing — it must not be sanitised');
ok('area pages still say Joe supervises the crew',
  read('docs/areas/amelia-oh.html').includes('supervises the crew'));
ok('the internal bookkeeping still classifies subs correctly',
  read('docs/pro/js/expense-config.js').includes('is1099'),
  'correct accounting for a business that pays subs — never a marketing claim');

console.log('\n' + '─'.repeat(30));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
