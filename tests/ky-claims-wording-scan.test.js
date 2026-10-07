/**
 * tests/ky-claims-wording-scan.test.js — no "claims specialist" copy in the CRM.
 *
 * KRS 367.628(1)(a) (2026 Ky. Acts ch. 54, SB 153) bars a contractor from
 * representing or negotiating for an insured on a claim and from holding
 * itself out as an insurance / claims specialist or expert; Ohio limits
 * claim negotiation for pay to licensed public adjusters. The CRM said it on
 * every server PDF ("Insurance Restoration Specialists"), on proposals
 * ("Insurance Specialists — We handle the entire insurance claim process")
 * and in texts and emails. Allowed, and what the copy now says instead: the
 * contractor's own estimate and documentation, meeting the adjuster after the
 * homeowner files; the homeowner manages the claim.
 *
 * This scan fails on any of these phrases in docs/pro/ or functions/ source
 * (the CRM, its documents, its email/SMS templates), COMMENTS STRIPPED first
 * so a comment explaining the rule never satisfies — or trips — it:
 *   /claims? (specialist|expert)/i
 *   /insurance (restoration )?specialist/i
 *   /handle the entire (insurance )?claim/i
 *
 * The public site's Kentucky pages are scanned too (R5-9-1): every page under
 * docs/ outside docs/pro whose file name ends "-ky" or carries "-ky-" (town
 * pages under areas/, service pages, Our Work). Eight of them promised claim
 * outcomes or advocacy in body text AND FAQ JSON-LD. The JSON-LD blocks are
 * part of the scanned text; only comments are stripped. Extra phrases there:
 *   underpaid / underpay / "harder to underpay", undervalued, "getting them corrected",
 *   "recoverable" (except "recoverable depreciation", a policy term),
 *   "denied claims", "fully paid claim", "supplement the claim".
 * Ohio pages are not scanned for these: there "I send a supplement (my
 * updated estimate)" is allowed and the Ohio copy is reviewed on its own.
 * KY pages are picked by FILE NAME, not content: every page carries the shared
 * schema block naming Kentucky towns, so a content test would pull in every
 * Ohio page. Each KY page's JSON-LD must also parse, and each FAQPage answer
 * must equal the visible FAQ answer for the same question.
 *
 * INTERNAL_ONLY lists rep-training content that is not customer paper. It is
 * listed by name with a reason, so growing it is a reviewed decision.
 *
 * Run: node tests/ky-claims-wording-scan.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const BANNED = [
  /claims? (specialist|expert)/i,
  /insurance (restoration )?specialist/i,
  /handle the entire (insurance )?claim/i,
];

// Rep-facing training / persona content — not a document, email, SMS or page
// a homeowner receives. Empty since 2026-09-27: the sales trainer
// (docs/pro/js/sales-training-engine.js) was listed here while it coached the
// "insurance restoration specialist" / "we handle the entire claims process"
// pitch; its lines were rewritten to the allowed framing and it is scanned
// like everything else, because what a rep is trained to say is what the
// homeowner hears at the door.
const INTERNAL_ONLY = new Set([]);

const SCAN_DIRS = ['docs/pro', 'functions'];

// Kentucky pages of the public site (docs/ minus docs/pro, scanned above).
const KY_PAGE = /(^|-)ky(-[^/]*)?\.html$/i;
const SITE_BANNED = [
  /under-?pa(id|y|ying|yment)/i,
  /undervalu(e|ed|es|ing)/i,
  /(get|gets|getting|got) (them|it|the (claim|estimate|scope)) corrected/i,
  /\brecoverable\b(?! depreciation)/i,
  /denied claims?/i,
  /fully[- ]paid claim/i,
  /supplement the claim/i,
];
const EXT = /\.(js|mjs|html|hbs|json)$/i;

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (EXT.test(ent.name)) out.push(p);
  }
  return out;
}

// Comments out: /* */, // (not inside a URL's "://"), <!-- -->, {{!-- --}}.
// Block comments keep their line breaks so reported line numbers stay true.
function stripComments(src) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return String(src)
    .replace(/\{\{!--[\s\S]*?--\}\}/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

function scanSource(src, banned) {
  const res = banned || BANNED;
  const hits = [];
  const lines = stripComments(src).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const re of res) {
      const m = line.match(re);
      if (m) hits.push({ line: i + 1, match: m[0], text: line.trim().slice(0, 140) });
    }
  });
  return hits;
}

console.log('\nky-claims-wording-scan\n');

// The scan can fail: each banned phrase is caught in code, and a comment
// carrying it is not.
ok('self-test: catches "Insurance Restoration Specialists" in a string', scanSource("brandTag: 'Insurance Restoration Specialists · X'").length === 1);
ok('self-test: catches "claims expert"', scanSource('<p>Your local claims expert</p>').length === 1);
ok('self-test: catches "handle the entire insurance claim"', scanSource("desc: 'We handle the entire insurance claim process'").length === 1);
ok('self-test: a // comment naming the phrase does not count', scanSource("// was 'Insurance Specialists'\nconst a = 1;").length === 0);
ok('self-test: a URL is not mistaken for a comment', scanSource("u = 'https://x.test'; t = 'claims specialist';").length === 1);

const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), []));
ok('scan covers the CRM and functions (> 200 files)', files.length > 200, 'files=' + files.length);
ok('the sales trainer is scanned, not exempt',
  files.some((f) => path.relative(ROOT, f).split(path.sep).join('/') === 'docs/pro/js/sales-training-engine.js')
    && !INTERNAL_ONLY.has('docs/pro/js/sales-training-engine.js'));
const found = [];
for (const abs of files) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (INTERNAL_ONLY.has(rel)) continue;
  for (const h of scanSource(fs.readFileSync(abs, 'utf8'))) found.push(rel + ':' + h.line + '  "' + h.match + '"  ' + h.text);
}
ok('no "claims specialist / insurance specialist / handle the entire claim" copy in docs/pro or functions',
  found.length === 0, found.join('\n      '));
for (const rel of INTERNAL_ONLY) ok('INTERNAL_ONLY entry still exists: ' + rel, fs.existsSync(path.join(ROOT, rel)));

// ── Public site: Kentucky pages ────────────────────────────────────────────
const SITE_ALL = [...BANNED, ...SITE_BANNED];
ok('self-test: catches "harder to underpay"', scanSource('<p>makes claims faster and harder to underpay.</p>', SITE_ALL).length === 1);
ok('self-test: catches "getting them corrected"', scanSource('I have experience getting them corrected on Kentucky claims.', SITE_ALL).length === 1);
ok('self-test: catches "denied claims are recoverable" in JSON-LD', scanSource('{"text": "underpaid and denied claims are recoverable in many cases."}', SITE_ALL).length === 3);
ok('self-test: "recoverable depreciation" is a policy term, not a promise', scanSource('<p>you give up any recoverable depreciation</p>', SITE_ALL).length === 0);
ok('self-test: an HTML comment naming the phrase does not count', scanSource('<!-- was: underpaid claims -->\n<p>ok</p>', SITE_ALL).length === 0);
ok('self-test: KY_PAGE matches -ky pages, not Ohio',
  KY_PAGE.test('storm-damage-covington-ky.html') && KY_PAGE.test('newport-ky-siding-top-course-2026.html')
  && !KY_PAGE.test('storm-damage-milford-oh.html') && !KY_PAGE.test('hail-damage-batavia-oh.html') && !KY_PAGE.test('kyle.html'));

function walkSite(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (path.relative(ROOT, p).split(path.sep).join('/') !== 'docs/pro') walkSite(p, out); }
    else if (KY_PAGE.test(ent.name)) out.push(p);
  }
  return out;
}
const kyPages = walkSite(path.join(ROOT, 'docs'), []);
const kyRel = kyPages.map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
ok('site scan covers the KY town + service pages (>= 35)', kyPages.length >= 35, 'kyPages=' + kyPages.length);
for (const must of ['docs/areas/covington-ky.html', 'docs/services/storm-damage-covington-ky.html', 'docs/services/hail-damage-lexington-ky.html']) {
  ok('site scan includes ' + must, kyRel.includes(must));
}
ok('site scan excludes docs/pro and Ohio pages', !kyRel.some((r) => r.startsWith('docs/pro/') || /-oh(-|\.html$)/.test(r)));

const decode = (t) => String(t == null ? '' : t)
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
  .replace(/&rsquo;|&lsquo;|&#39;|&#x27;|’/g, "'").replace(/&ldquo;|&rdquo;|&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const siteFound = [];
const ldBad = [];
const faqDrift = [];
let faqPairs = 0;
for (const abs of kyPages) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  const src = fs.readFileSync(abs, 'utf8');
  for (const h of scanSource(src, SITE_ALL)) siteFound.push(rel + ':' + h.line + '  "' + h.match + '"  ' + h.text);
  const visible = new Map();
  const qa = /<div class="faq-q">([\s\S]*?)<\/div>\s*<div class="faq-a">([\s\S]*?)<\/div>/g;
  const bare = stripComments(src);
  let m;
  while ((m = qa.exec(bare))) visible.set(decode(m[1].replace(/<span class="faq-arrow">[\s\S]*?<\/span>/, '')), decode(m[2]));
  const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  while ((m = ldRe.exec(bare))) {
    let doc;
    try { doc = JSON.parse(m[1]); } catch (e) { ldBad.push(rel + ': ' + e.message); continue; }
    for (const node of [].concat(doc['@graph'] || doc)) {
      if (!node || node['@type'] !== 'FAQPage') continue;
      for (const q of node.mainEntity || []) {
        const name = decode(q.name);
        if (!visible.has(name)) continue;
        faqPairs++;
        const ans = decode(q.acceptedAnswer && q.acceptedAnswer.text);
        if (ans !== visible.get(name)) faqDrift.push(rel + ': "' + name.slice(0, 60) + '"\n        ld:      ' + ans.slice(0, 160) + '\n        visible: ' + visible.get(name).slice(0, 160));
      }
    }
  }
}
ok('KY pages: no claim-outcome / advocacy wording (underpaid, corrected, recoverable, denied claims, fully paid claim, supplement the claim) in body or JSON-LD',
  siteFound.length === 0, siteFound.join('\n      '));
ok('KY pages: every JSON-LD block parses', ldBad.length === 0, ldBad.join('\n      '));
ok('KY pages: FAQ JSON-LD / visible FAQ pairs were found (> 50)', faqPairs > 50, 'pairs=' + faqPairs);
ok('KY pages: FAQ JSON-LD answers match the visible FAQ answers', faqDrift.length === 0, faqDrift.join('\n      '));

console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
