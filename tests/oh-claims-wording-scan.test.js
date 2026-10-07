/**
 * tests/oh-claims-wording-scan.test.js — no claim-outcome promises or claim
 * advocacy on the public site's Ohio and general pages.
 *
 * Sibling of tests/ky-claims-wording-scan.test.js, which scans only the
 * Kentucky pages (picked by file name). Jo's insurance rule is the same in
 * Ohio and Kentucky: no claim-outcome promises, and never say Joe handles or
 * negotiates the claim. Allowed: Joe inspects, photographs, documents, writes
 * the estimate, meets the adjuster, and sends a supplement (his updated
 * estimate) if the adjuster's scope misses damage; the homeowner files and
 * owns the claim, and what it pays is up to the insurer.
 *
 * The 2026-10-06 sweep found the KY-banned phrases on ~30 Ohio service pages,
 * blog posts and /about, in body text AND FAQ JSON-LD ("underpaid and denied
 * claims are recoverable", "ensuring you're not underpaid", "Avg underpayment
 * on first adjuster offer", "Supplement filing when the initial estimate is
 * undervalued", "Many initially denied claims get approved on re-inspection").
 *
 * SCANNED: every .html under docs/ outside docs/pro (Ohio, general and the KY
 * pages too, so one page can never fall between the two tests), plus the blog
 * excerpt sources that are copied verbatim into the blog index and RSS feed
 * (docs/assets/js/inline/c00f1acac9.js POSTS, docs/feed.xml) and docs/llms.txt.
 * HTML comments are stripped first so a comment quoting an old phrase neither
 * trips nor satisfies the scan; JSON-LD stays in the scanned text. Phrases:
 *   underpaid / underpay / underpayment, undervalued / undervalues,
 *   "get them corrected", "recoverable" (except "recoverable depreciation",
 *   a policy term), "denied claim(s)", "fully paid claim", "supplement the
 *   claim", "I/we/Joe handle(s)/negotiate(s) ... claim", "handle/negotiate
 *   your/the claim", "claims specialist/expert", "insurance specialist".
 * Every FAQPage answer in a page's JSON-LD must equal the visible FAQ answer
 * for the same question, on every page whose FAQ markup the parser can pair.
 *
 * Run: node tests/oh-claims-wording-scan.test.js
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
  /under-?pa(id|y|ys|ying|yment)/i,
  /undervalu(e|ed|es|ing)/i,
  /(get|gets|getting|got) (them|it|the (claim|estimate|scope)) corrected/i,
  /\brecoverable\b(?! depreciation)/i,
  /denied claims?/i,
  /fully[- ]paid claim/i,
  /supplement the claim/i,
  /\b(I|we|Joe)( will| can|'ll| also)? (handle|handles|negotiate|negotiates)\b[^.<"]{0,40}\bclaims?\b/i,
  /\b(handl(e|es|ing)|negotiat(e|es|ing)) (the|your|their) (insurance |entire )?claim/i,
];

// Blog excerpt sources (copied into blog/index.html and feed.xml) and the
// AI-assistant brief.
const EXTRA = ['docs/assets/js/inline/c00f1acac9.js', 'docs/feed.xml', 'docs/llms.txt'];

const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

function stripComments(src) {
  return String(src).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function scanSource(src) {
  const hits = [];
  stripComments(src).split(/\r?\n/).forEach((line, i) => {
    for (const re of BANNED) {
      const m = line.match(re);
      if (m) hits.push({ line: i + 1, match: m[0], text: line.trim().slice(Math.max(0, line.trim().indexOf(m[0]) - 60), line.trim().indexOf(m[0]) + 100) });
    }
  });
  return hits;
}

console.log('\noh-claims-wording-scan\n');

// The scan can fail: each phrase family is caught, a comment is not, and the
// allowed wording passes.
ok('self-test: catches "underpaid and denied claims are recoverable" in JSON-LD',
  scanSource('{"text": "underpaid and denied claims are recoverable in many cases."}').length === 3);
ok('self-test: catches "ensuring you\'re not underpaid"', scanSource("<p>The goal is ensuring you're not underpaid.</p>").length === 1);
ok('self-test: catches "Avg underpayment"', scanSource('<div class="stat-label">Avg underpayment on first adjuster offer</div>').length === 1);
ok('self-test: catches "initial scope is undervalued"', scanSource('Supplement documentation if the initial scope is undervalued').length === 1);
ok('self-test: catches "adjuster underpays my claim"', scanSource('Can Joe help if the adjuster underpays my Wilmington hail claim?').length === 1);
ok('self-test: catches "I can supplement the claim"', scanSource('I can supplement the claim with the missed line items.').length === 1);
ok('self-test: catches "Many initially denied claims get approved"', scanSource('Many initially denied claims get approved on re-inspection.').length === 1);
ok('self-test: catches "I handle your insurance claim"', scanSource('<p>I handle your insurance claim from start to finish.</p>').length >= 1);
ok('self-test: catches "we negotiate the claim"', scanSource('<p>We negotiate the claim with your carrier.</p>').length >= 1);
ok('self-test: catches "get them corrected"', scanSource('I have experience getting them corrected.').length === 1);
ok('self-test: "recoverable depreciation" is a policy term, not a promise', scanSource('<p>release the recoverable depreciation</p>').length === 0);
ok('self-test: the allowed supplement wording passes',
  scanSource("<p>If the adjuster's scope misses damage, I send a supplement (my updated estimate). You file and own the claim, and what it pays is up to your insurer.</p>").length === 0);
ok('self-test: "a public adjuster to negotiate on your behalf" (not Joe) passes', scanSource('hire a public adjuster to negotiate on your behalf').length === 0);
ok('self-test: an HTML comment naming the phrase does not count', scanSource('<!-- was: underpaid claims -->\n<p>ok</p>').length === 0);

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (rel(p) !== 'docs/pro') walk(p, out); }
    else if (/\.html$/i.test(ent.name)) out.push(p);
  }
  return out;
}
const pages = walk(path.join(ROOT, 'docs'), []);
const pageRel = pages.map(rel);
ok('scan covers the public site (> 250 pages)', pages.length > 250, 'pages=' + pages.length);
for (const must of ['docs/services/hail-damage-mt-orab-oh.html', 'docs/blog/cincinnati-hail-season-2026.html', 'docs/about.html',
  'docs/services/storm-damage.html', 'docs/services/hail-damage-insurance-claim.html', 'docs/services/storm-damage-covington-ky.html']) {
  ok('scan includes ' + must, pageRel.includes(must));
}
ok('scan excludes docs/pro', !pageRel.some((r) => r.startsWith('docs/pro/')));
for (const e of EXTRA) ok('extra source exists: ' + e, fs.existsSync(path.join(ROOT, e)));

const found = [];
for (const abs of [...pages, ...EXTRA.map((e) => path.join(ROOT, e))]) {
  for (const h of scanSource(fs.readFileSync(abs, 'utf8'))) found.push(rel(abs) + ':' + h.line + '  "' + h.match + '"  ' + h.text);
}
ok('public pages: no claim-outcome / advocacy wording in body or JSON-LD (' + found.length + ' hits)',
  found.length === 0, found.join('\n      '));

// FAQ JSON-LD answers stay identical to the visible answers.
const decode = (t) => String(t == null ? '' : t)
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
  .replace(/&rsquo;|&lsquo;|&#39;|&#x27;|’/g, "'").replace(/&ldquo;|&rdquo;|&quot;/g, '"')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const ldBad = [];
const faqDrift = [];
let faqPairs = 0;
for (const abs of pages) {
  const r = rel(abs);
  const bare = stripComments(fs.readFileSync(abs, 'utf8'));
  const visible = new Map();
  const qa = /<div class="faq-q">([\s\S]*?)<\/div>\s*<div class="faq-a">([\s\S]*?)<\/div>/g;
  let m;
  // A trailing "Read about X →" link row is navigation, not answer text: the
  // JSON-LD may match the answer with or without it.
  const noTail = (h) => h.replace(/(\s*<a\b[^>]*>[\s\S]*?<\/a>)+\s*(<\/p>)?\s*$/, '$2');
  while ((m = qa.exec(bare))) visible.set(decode(m[1].replace(/<span class="faq-arrow">[\s\S]*?<\/span>/, '')), [decode(m[2]), decode(noTail(m[2]))]);
  if (!visible.size) continue;
  const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  while ((m = ldRe.exec(bare))) {
    let doc;
    try { doc = JSON.parse(m[1]); } catch (e) { ldBad.push(r + ': ' + e.message); continue; }
    for (const node of [].concat(doc['@graph'] || doc)) {
      if (!node || node['@type'] !== 'FAQPage') continue;
      for (const q of node.mainEntity || []) {
        const name = decode(q.name);
        if (!visible.has(name)) continue;
        faqPairs++;
        const ans = decode(q.acceptedAnswer && q.acceptedAnswer.text);
        const [full, noLinks] = visible.get(name);
        if (ans !== full && ans !== noLinks) faqDrift.push(r + ': "' + name.slice(0, 60) + '"\n        ld:      ' + ans.slice(0, 160) + '\n        visible: ' + full.slice(0, 160));
      }
    }
  }
}
ok('FAQ pages: every JSON-LD block parses', ldBad.length === 0, ldBad.join('\n      '));
ok('FAQ pages: JSON-LD / visible FAQ pairs were found (> 300)', faqPairs > 300, 'pairs=' + faqPairs);
ok('FAQ pages: JSON-LD answers match the visible FAQ answers', faqDrift.length === 0, faqDrift.join('\n      '));

console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
