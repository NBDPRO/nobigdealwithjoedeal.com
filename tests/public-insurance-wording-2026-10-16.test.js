/**
 * tests/public-insurance-wording-2026-10-16.test.js — the public site never
 * says or implies that NBD handles, files, approves or pays a claim.
 *
 * WHY: the vault rulebook (Company/Wording Rules.md, Jo) applies everywhere:
 * never say or imply "we handle / file / manage your claim", "we negotiate
 * with your insurance", "insurance will cover it", "you only pay your
 * deductible", "we'll cover or waive your deductible", "claim approval is a
 * sure thing", "money left on the table". Say instead: "I document the damage
 * and meet the adjuster. The claim stays yours." On a Kentucky insurance job
 * nothing is due at signing (KRS 367.620-.628), and NBD never acts as the
 * homeowner's adjuster or takes the claim to the carrier.
 *
 * Sweeps #2457 and #2462 cleaned most pages; the 2026-10-16 sweep found the
 * rest ("I work with all major insurance carriers", "adjusters from every
 * major carrier", "handle insurance documentation", "makes sure your claim
 * reflects … not just what the adjuster wants to write", "Hail damage is often
 * a covered claim", "the claim gets approved" told as a given, the "probably
 * yes" answer to "my neighbor got a new roof, should I file?", and Kentucky
 * pages where NBD itself sent the supplement to the carrier). This test fails
 * if any banned phrase comes back on ANY public page, so a new page copied
 * from an old one goes red too.
 *
 * PUBLIC TREE = every .html/.js/.json/.txt/.xml under docs/ except the CRM
 * and private trees (pro/, admin/, sites/ (tenant demo sites), dev/) and
 * vendored libraries, plus site-src/partials (the shared nav/footer source).
 * HTML and JS comments are stripped first, so a comment quoting the rule
 * cannot trip it. ALLOW lists the few files that NAME a banned phrase in order
 * to forbid it (AI prompt rules), each with its reason.
 *
 * Run: node tests/public-insurance-wording-2026-10-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const SKIP_DIRS = new Set(['pro', 'admin', 'sites', 'dev', 'vendor', 'node_modules']);
const EXT = /\.(html|js|mjs|json|txt|xml)$/;
const FILES = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p); continue; }
    if (EXT.test(e.name) && !/\.min\.(js|mjs)$/.test(e.name)) FILES.push(p);
  }
})(path.join(ROOT, 'docs'));
(function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else FILES.push(p);
  }
})(path.join(ROOT, 'site-src', 'partials'));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function stripComments(src, file) {
  if (/\.(js|mjs)$/.test(file)) return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');
  return src.replace(/<!--[\s\S]*?-->/g, ' ');
}
// Entities and tags out, whitespace collapsed: a phrase split by markup or
// written with &rsquo; still matches.
function plain(src) {
  return src.replace(/<[^>]+>/g, ' ')
    .replace(/&rsquo;|&#8217;|’/g, "'").replace(/&mdash;|&#8212;/g, '—').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

// [name, regex]. Each is a claim the rulebook forbids, in the forms the site
// has actually used, plus close variants.
const BANNED = [
  ['claim approval promised', /(supports?|full|best chance of) claim approval|claim approval is|best chance of approval/i],
  ['"document and handle" a claim', /document and handle/i],
  ['handles the claim / the insurance', /handles? (it|the claim|your claim|everything|the insurance|your insurance)( process)? for you|handles? (your|the) (insurance|claim)\b|handle insurance documentation|handle the entire (insurance )?claim/i],
  ['point of contact through the claim', /point of contact (through|for) the (entire|whole)? ?claim/i],
  ['NBD files the claim', /\bwe file (it|the claim|your claim)|file (it|the claim|your claim) for you/i],
  ['deals with / negotiates with the insurer', /(deal|deals|dealing) with (your|the) (insurance|insurer|carrier)( company)? for you|negotiat\w* with (your|the) (insurance|insurer|carrier|adjuster)/i],
  ['"insurance approved"', /insurance[- ]approved/i],
  ['deductible covered or waived by NBD', /(we|I)('ll| will)? (waive|cover|absorb|pay) (your|the) deductible|deductible (is |gets )?(covered|waived) by/i],
  ['"all major carriers" / "every major carrier"', /(work|worked|working) with (all|every) (the )?major (insurance )?carriers?|all (the )?major insurance carriers|adjusters from every major carrier/i],
  ['"100% Insurance Help"', /100% insurance/i],
  ['"$0" inspection / out of pocket', /\$0 (inspection|estimate|out[- ]of[- ]pocket|cost|deductible)|\$0 out of pocket/i],
  ['insurance will cover / pay', /insurance (will|should) (cover|pay for) (it|the|your)/i],
  ['"only pay your deductible"', /(only|just) pay (your|the) deductible|won't cost you a (thing|dime|penny)/i],
  ['"money left on the table"', /money left on the table/i],
  ['the claim reflects what the adjuster won\'t write', /what the adjuster wants to write/i],
  ['coverage implied ("often a covered claim")', /\b(often|usually|typically|almost always) a covered claim\b|\b(is|are) (often|usually|almost always) covered by (your )?insurance/i],
  ['"probably yes" to filing because a neighbor did', /in the same (neighborhood|area), probably yes/i],
];
// Files that quote a banned phrase to forbid it — AI prompt rules, not copy.
const ALLOW = {
  'docs/assets/js/roof-score.js': 'AI prompt rule: "Do NOT guarantee … claim approval"',
  'docs/assets/js/inline/4053149b2f.js': 'AI prompt rule: "Do NOT say or imply what insurance will cover or pay …"',
};

// ── 1. Banned phrases, whole public tree ────────────────────────────────
const hits = {};
let scanned = 0;
for (const f of FILES) {
  const r = rel(f);
  const text = plain(stripComments(fs.readFileSync(f, 'utf8'), f));
  scanned++;
  for (const [name, re] of BANNED) {
    const m = text.match(re);
    if (!m) continue;
    if (ALLOW[r]) continue;
    (hits[name] = hits[name] || []).push(r + ': "' + text.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50).trim() + '"');
  }
}
ok('scanned the public tree (' + scanned + ' files)', scanned > 300, String(scanned));
for (const [name] of BANNED) ok('no public page: ' + name, !hits[name], (hits[name] || []).slice(0, 6).join('\n      '));
for (const r of Object.keys(ALLOW)) ok('allow-listed file still exists: ' + r, fs.existsSync(path.join(ROOT, r)));

// ── 2. Kentucky pages: NBD never takes the claim to the carrier ─────────
// KRS 367.628 bars a contractor from representing or negotiating for an
// insured. NBD writes its own updated estimate (a supplement); the homeowner
// sends it. Pages picked by file name (as ky-claims-wording-scan does).
const KY = FILES.filter((f) => /(^|[-/])[a-z-]*-ky(\.html|-|\/)/.test(rel(f)) && /\.html$/.test(f));
ok('found the Kentucky pages (' + KY.length + ')', KY.length >= 20, String(KY.length));
const KY_BANNED = /\bI (send|submit|file) (a|the|your) supplement|\b(will|can|and|then) (send|submit) (a|the) supplement|\bdocument a supplement|supplement documentation/i;
const kyHits = KY.map((f) => {
  const t = plain(stripComments(fs.readFileSync(f, 'utf8'), f));
  const m = t.match(KY_BANNED);
  return m ? rel(f) + ': "' + t.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim() + '"' : null;
}).filter(Boolean);
ok('no Kentucky page has NBD sending the supplement to the carrier', !kyHits.length, kyHits.slice(0, 8).join('\n      '));

// ── 3. The approved wording is there ────────────────────────────────────
{
  const cov = plain(fs.readFileSync(path.join(ROOT, 'docs/services/hail-damage-covington-ky.html'), 'utf8'));
  ok('Covington (KY) hail page: nothing is due at signing on a Kentucky insurance job (KRS 367.626)',
    /On a Kentucky insurance job, nothing is due at signing/.test(cov) && /KRS 367\.626/.test(cov));
  ok('Covington (KY) hail page: the claim stays the homeowner\'s', /The claim stays yours: you file it/.test(cov));
  ok('Covington (KY) hail page: the supplement is for the homeowner to send', /supplement \(my updated estimate\) for you to send your insurer/.test(cov));
  const storm = plain(fs.readFileSync(path.join(ROOT, 'docs/services/storm-damage.html'), 'utf8'));
  ok('storm-damage page: "I meet your adjuster … The claim stays yours." in place of "all major carriers"',
    /I meet your adjuster on the roof, whoever your carrier is\. The claim stays yours\./.test(storm));
}

// ── 4. FAQ JSON-LD still matches the visible FAQ on the pages edited ───
// (faq-schema-sync checks every page; this pins the edited answers.)
{
  const page = fs.readFileSync(path.join(ROOT, 'docs/services/hail-damage-florence-ky.html'), 'utf8');
  const want = "Get the roof looked at first. Your neighbor's claim doesn't decide yours";
  ok('Florence (KY) neighbor FAQ: new answer in JSON-LD and in the visible FAQ', page.split(want).length - 1 === 2);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
