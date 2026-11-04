/**
 * tests/meta-description-cuts-2026-10-26.test.js — search snippets and share
 * cards are never cut off mid-word.
 *
 * copy-003 (2026-10-26 overnight pass): build-projects.mjs built every case
 * study's meta / og / twitter description with a bare .slice(0, 155), so 46 of
 * 48 pages ended mid-word ("...down to the decking and l"); two town pages and
 * services/financing carried a twitter:title cut the same way ("...No Big Deal
 * Home Sol"), and five blog posts a twitter:description cut at ~200 characters.
 *
 * Run: node tests/meta-description-cuts-2026-10-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
const read = (rel) => fs.readFileSync(path.join(DOCS, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const one = (re, src) => { const m = src.match(re); return m ? m[1] : null; };
const metaOf = (rel) => {
  const src = read(rel);
  const head = src.slice(0, src.indexOf('</head>'));
  return {
    desc: one(/<meta name="description" content="([^"]*)"/, head),
    ogd: one(/<meta property="og:description" content="([^"]*)"/, head),
    twd: one(/<meta name="twitter:description" content="([^"]*)"/, head),
    ogt: one(/<meta property="og:title" content="([^"]*)"/, head),
    twt: one(/<meta name="twitter:title" content="([^"]*)"/, head),
  };
};
const dec = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const summarise = (rows) => rows.length + ' fail, e.g. ' + rows.slice(0, 3).join(' | ');

console.log('\n1. Case-study descriptions end on a sentence or a whole word');
const manifest = JSON.parse(read('assets/data/projects.json'));
const LABEL = "Joe's work before No Big Deal: ";
const pages = fs.readdirSync(path.join(DOCS, 'our-work')).filter((f) => f.endsWith('.html'));
ok('every live project has a detail page to check', pages.length >= 40 && manifest.projects.filter((p) => p.published !== false).length >= pages.length - 2, pages.length + ' pages');
const bad = { len: [], end: [], prefix: [], word: [], cards: [] };
for (const f of pages) {
  const slug = f.replace(/\.html$/, '');
  const m = metaOf('our-work/' + f);
  const d = dec(m.desc || '');
  const p = manifest.projects.find((x) => x.slug === slug);
  if (d.length > 155) bad.len.push(slug + ' ' + d.length);
  if (!/[.!?…]$/.test(d)) bad.end.push(slug + ' …' + d.slice(-24));
  if (m.desc !== m.ogd || m.desc !== m.twd) bad.cards.push(slug);
  if (p) {
    const core = d.replace(/…$/, '');
    const src = [p.description, LABEL + p.description].map((s) => s.replace(/\s+/g, ' ').trim()).find((s) => s.startsWith(core));
    if (!src) bad.prefix.push(slug);
    // a trimmed description stops at a space (or at punctuation trimmed off before the ellipsis), never inside a word
    else if (d.endsWith('…') && !/^[\s,;:–—-]$/.test(src[core.length] || ' ')) bad.word.push(slug + ' …' + core.slice(-20));
  }
}
ok('no description is longer than 155 characters', bad.len.length === 0, summarise(bad.len));
ok('every description ends on a full stop, ? ! or an ellipsis, not mid-word', bad.end.length === 0, summarise(bad.end));
ok('an ellipsis only ever follows a whole word', bad.word.length === 0, summarise(bad.word));
ok('what is shown is the start of the project text, so the trim adds no wording', bad.prefix.length === 0, summarise(bad.prefix));
ok('meta, og and twitter descriptions agree', bad.cards.length === 0, summarise(bad.cards));

console.log('\n2. Share-card titles and descriptions are not cut-off copies of the og values');
const same = (rel, k1, k2) => { const m = metaOf(rel); return m[k1] !== null && m[k1] === m[k2]; };
for (const rel of ['areas/anderson-township-oh.html', 'areas/fort-mitchell-ky.html', 'services/financing.html']) {
  ok(rel + ': twitter:title is the whole og:title', same(rel, 'twt', 'ogt'), metaOf(rel).twt);
}
for (const slug of ['can-i-keep-insurance-check-not-fix-roof', 'cincinnati-hail-season-2026', 'does-homeowner-insurance-cover-hail-damage-ohio', 'how-much-does-roof-cost-cincinnati-2026', 'what-to-expect-roof-insurance-adjuster-visit']) {
  ok('blog/' + slug + ': twitter:description is the whole og:description', same('blog/' + slug + '.html', 'twd', 'ogd'), metaOf('blog/' + slug + '.html').twd);
}
// Sweep: a twitter value that is a strict prefix of its og value and stops inside a word is a hard cut.
// (estimate.html is exempt here: its twitter:title fix ships with the estimate-wizard PR.)
const SKIP_DIRS = ['pro', 'admin', 'dev', 'sites', 'assets', 'tools'];
const cut = [];
let swept = 0;
(function walk(dir, rel) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!(rel === '' && SKIP_DIRS.includes(e.name))) walk(path.join(dir, e.name), r); continue; }
    if (!e.name.endsWith('.html') || r === 'estimate.html') continue;
    const m = metaOf(r);
    if (m.ogt === null && m.ogd === null) continue;
    swept++;
    for (const [tw, og, label] of [[m.twt, m.ogt, 'title'], [m.twd, m.ogd, 'description']]) {
      if (tw && og && tw !== og && og.startsWith(tw) && /\w/.test(tw.slice(-1)) && /\w/.test(og[tw.length] || '')) cut.push(r + ' (' + label + ')');
    }
  }
})(DOCS, '');
ok('the sweep reaches the pages that carry share cards', swept > 250, swept + ' pages');
ok('no twitter title or description is a mid-word cut of the og one', cut.length === 0, summarise(cut));

console.log('\n3. /free-tools tells the truth about the printable PDFs (copy-007)');
{
  const src = read('free-tools/index.html');
  const intro = dec(one(/<p class="guides-intro">([^<]*)<\/p>/, src) || '');
  const slugs = [...src.matchAll(/<a href="\/guides\/([a-z0-9-]+)" class="tool-card">/g)].map((m) => m[1]);
  const withPdf = slugs.filter((s) => fs.existsSync(path.join(DOCS, 'guides', 'pdf', s + '.pdf')));
  const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight'];
  ok('the guides list reaches the guide cards', slugs.length >= 7, slugs.length + ' cards');
  ok('the intro no longer promises a PDF "on the way" or that each one has one', !/on the way|each one has|every one has/i.test(intro), intro);
  ok('the intro says how many of the listed guides have a PDF (' + withPdf.length + ' of ' + slugs.length + ')', intro.includes(WORDS[withPdf.length] + ' of these'), intro);
  ok('a guide without a PDF (How a Roof Works) is not counted', slugs.length > withPdf.length && !withPdf.includes('how-a-roof-works'), slugs.length + ' guides, ' + withPdf.length + ' PDFs');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
