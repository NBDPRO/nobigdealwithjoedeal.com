/**
 * Xactimate must be readable by a HUMAN, not just by a crawler.
 *
 * THE DEFECT (2026-09-20)
 * ──────────────────────────────────────────────────────────────────
 * "Xactimate" appeared on docs/index.html exactly once — at line 555, inside
 * the `knowsAbout` array of a JSON-LD block — and ZERO times on
 * docs/services/storm-damage.html, which is the page the homepage's storm card
 * links to and the page whose <title> is "Storm Damage & Insurance Claims".
 *
 * Estimating in the same software the insurer prices the claim in is the single
 * competency that separates this from a roofer who "helps with the claim", and
 * it was legible only to machines. docs/about.html:690 already had it written
 * in Jo's own voice; both surfaces now reuse that wording rather than inventing
 * a new claim.
 *
 * WHAT THIS PINS
 * The word must appear OUTSIDE <script> tags. A regex over raw HTML cannot tell
 * the difference — the original, defective page would have passed one — so this
 * suite strips every <script> block first and searches what is left. That is
 * the whole point of the file.
 *
 * Pure Node, zero deps. Run: node tests/xactimate-human-readable.test.js
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

// Everything a browser renders as text/markup, with script and style bodies
// (JSON-LD included, since it ships as <script type="application/ld+json">)
// removed. Comments go too: this repo quotes the defect verbatim when
// explaining a fix, so a prose mention in a comment would otherwise satisfy
// the very assertion it describes.
function visibleMarkup(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

const PAGES = [
  { file: 'docs/index.html', why: 'the storm card that links to /services/storm-damage' },
  { file: 'docs/services/storm-damage.html', why: 'the insurance-claim page itself' },
  { file: 'docs/about.html', why: 'the original source of the wording — must not regress' },
];

section('Xactimate is readable by a human on every insurance-facing surface');

for (const p of PAGES) {
  const raw = read(p.file);
  const visible = visibleMarkup(raw);
  ok(p.file + ' mentions Xactimate at all', /xactimate/i.test(raw));
  ok(p.file + ' mentions it OUTSIDE <script> — ' + p.why,
    /xactimate/i.test(visible),
    'JSON-LD only is the defect this file exists for: a crawler could read it and a customer could not');
}

section('the wording actually explains what Xactimate IS');

// Naming the product without saying what it is helps nobody. Each page has to
// carry at least one of the explanatory phrases from about.html's version.
const EXPLAINS = /insurance companies use to price claims|same software your insurer|same language as your adjuster|price(s)? the claim in|write my estimates in <strong>Xactimate<\/strong> and can walk you through the line items/i;
for (const p of PAGES) {
  const visible = visibleMarkup(read(p.file));
  ok(p.file + ' explains it, not just names it', EXPLAINS.test(visible),
    'say what the software is or why it matters — a bare product name is jargon');
}

section('no new claim was invented');

{
  // Everything asserted about Xactimate must already have been true on
  // about.html before this change. Guards against a future edit inflating
  // "I estimate in it" into a certification or an exclusivity claim.
  const FORBIDDEN = /xactimate[^.<]{0,60}(certified|certification|licensed|authorized|official|partner|only (roofer|contractor))/i;
  for (const p of PAGES) {
    const visible = visibleMarkup(read(p.file));
    ok(p.file + ' claims no Xactimate certification/exclusivity', !FORBIDDEN.test(visible),
      'Xactimate is software Jo uses — not a credential he holds');
  }
}

section('the machine-readable claim is still there too');

{
  const idx = read('docs/index.html');
  ok('index.html still carries Xactimate in JSON-LD knowsAbout',
    /"Xactimate Estimating"/.test(idx),
    'the human-readable copy ADDS to the structured data, it does not replace it');
}

console.log('\n' + '─'.repeat(30));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
