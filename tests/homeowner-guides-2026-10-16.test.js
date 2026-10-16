#!/usr/bin/env node
/**
 * tests/homeowner-guides-2026-10-16.test.js — the free homeowner guides under
 * /guides/<slug> (site-docs revamp, 2026-10-16 onward).
 *
 * Every guide registered in scripts/build-guides.js with a docs/guides page:
 *   A. page == its Markdown (generator drift) and its schema == its Markdown
 *   B. the page: indexable + canonical, Article (#joe) + BreadcrumbList, FAQ /
 *      HowTo when the guide names those chapters, site chrome from partials,
 *      no inline script, PDF slot with no href until the PDF exists, a clear
 *      /inspect CTA and the main line
 *   C. the words: the compliance phrases each guide must carry, and none of
 *      the Wording Rules' banned phrases (claim handling, coverage promises,
 *      deductible help, "licensed", lifetime warranties, rate quotes, star
 *      ratings or review counts)
 *   D. wiring: sitemap, a card on /free-tools, and the links from the pages
 *      the audit named
 *
 * Add a guide: register it in build-guides.js, then add its REQUIRED entry
 * and its LINKED_FROM pages below.
 *
 * Run: node tests/homeowner-guides-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const B = require(path.join(ROOT, 'scripts/build-guides.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

// Phrases each guide must carry, word for word (Wording Rules, the vault's
// Facts & Credentials, and the primary sources checked 2026-10-16).
const REQUIRED = {
  'kentucky-ohio-storm-claim-guide': [
    'The claim stays yours, and what it pays is between you and your insurer.',
    'Whether insurance covers it depends on your policy and the damage.',
    "I don't speak for you to your insurance company, and I'm not a public adjuster.",
    "A contractor can't represent you on your claim or act as your adjuster.",
    'KRS 367.620 to 367.628',
    'midnight of the fifth business day',
    'nothing is due at signing',
    "can't give you anything worth more than $100",
    'midnight of the third business day',
    'over $25,000',
    'down payment to 10% before work begins',
    'check your contract or ask us',
    'An emergency tarp or repair goes on its own invoice.',
    'that\'s $150',
    'UL 2218 Class 4',
    'a promise, not a warranty term',
    'not legal advice',
  ],
  'hail-photo-baseline-sheet': [
    'Stay on the ground for all of it.',
    'Whether insurance covers it depends on your policy and the damage.',
    'Date: ____',
  ],
  'compare-roofing-quotes-checklist': [
    '| Written labor warranty | 5 years | 10 years | 20 years |',
    '| Transfers when you sell | No | Once, within 30 days of the sale | Fully |',
    "It doesn't cover workmanship; that's what the written labor warranty is for.",
    'UL 2218 Class 4',
    'Are you fully insured?',
    "I'll write a full report for $150",
    'a promise, not a warranty term',
    "In Kentucky, a contractor can't require payment until the cancellation window after that decision has passed.",
  ],
  'home-care-warranty-card': [
    '| Written labor warranty | 5 years | 10 years | 20 years |',
    '| Transferable when you sell | No | Once, within 30 days of the sale | Fully |',
    '| Siding labor warranty | 5 years | 10 years | 20 years |',
    '| Gutter system | 5 years |',
    '| Gutter guards only | 2 years |',
    "| Repairs | 1 year, when it's written on your invoice |",
    "It doesn't cover workmanship: that's what our written labor warranty is for.",
    'a promise, not a warranty term',
    '**$100 referral credit**',
    'limits what a contractor may give an insured homeowner on an insurance job to $100 in value',
    'nothing is ever offered in exchange for a review',
    'Stay on the ground',
    'Whether insurance covers it depends on your policy and the damage.',
  ],
  'roof-financing-explained': [
    "I'm a roofer, not a lender",
    "it doesn't affect your credit score",
    'Rates and terms depend on your credit and on the lender you pick.',
    "That's why I won't quote you a rate or a monthly payment",
    'your estimated payment',
    'My price is the same however you pay.',
    'The deductible is always yours to pay',
    'Whether insurance covers it depends on your policy and the damage.',
    'nothing is due at signing',
    'Acorn Finance',
  ],
  'siding-gutter-buyers-guide': [
    "We're a James Hardie Alliance member",
    '| Siding replacement | 5 years | 10 years | 20 years |',
    '| Gutter system | 5 years |',
    '| Gutter guards only | 2 years |',
    "| Repairs | 1 year, when it's written on your invoice |",
    'Are you fully insured?',
    'A promise, not a warranty term',
    'Your written estimate is the real number for your house.',
  ],
};

// Pages that must link each guide (the audit's "lives on" list).
const LINKED_FROM = {
  'kentucky-ohio-storm-claim-guide': ['docs/services/storm-damage.html', 'docs/services/hail-damage-insurance-claim.html', 'docs/storm-report.html', 'docs/storm-check.html', 'docs/blog/hail-season-prep-checklist.html', 'docs/free-tools/index.html'],
  'hail-photo-baseline-sheet': ['docs/blog/hail-season-prep-checklist.html', 'docs/services/storm-damage.html', 'docs/free-tools/index.html'],
  'compare-roofing-quotes-checklist': ['docs/services/roof-replacement.html', 'docs/estimate.html', 'docs/blog/how-to-choose-a-roofer-after-a-storm.html', 'docs/free-tools/index.html'],
  // The CRM's Job done hand-off card (docs/pro/js/review-handoff.js) is
  // multi-tenant and pinned to a single "Open review page" link, so the card
  // is not linked from there yet (noted for Jo in the PR).
  'home-care-warranty-card': ['docs/review.html', 'docs/services/roof-care-plan.html', 'docs/free-tools/index.html'],
  'roof-financing-explained': ['docs/services/financing.html', 'docs/blog/how-roof-financing-actually-works.html', 'docs/guides/compare-roofing-quotes-checklist.html', 'docs/free-tools/index.html'],
  'siding-gutter-buyers-guide': ['docs/services/siding-replacement.html', 'docs/services/gutter-replacement.html', 'docs/free-tools/index.html'],
};

// Wording Rules: never said or implied anywhere in a homeowner guide.
const BANNED = [
  [/\bwe(?:'ll| will)? (handle|file|manage|negotiate) (your|the) claim/i, 'we handle/file/negotiate your claim'],
  [/\b(I|we)(?:'ll| will)? (negotiate|fight|argue) with (your|the) (insurance|insurer|adjuster)/i, 'we negotiate with the insurer'],
  [/insurance (will|is going to) (cover|pay for) (it|the whole|everything)|covers the rest/i, 'coverage promise'],
  [/you only pay (your|the) deductible|won'?t cost you a (thing|dime|penny)/i, 'deductible-only promise'],
  [/(we|I)(?:'ll| will| can)? (cover|waive|absorb|pay) your deductible/i, 'deductible help (as an offer)'],
  [/best chance of approval|guaranteed approval|money left on the table/i, 'approval promise'],
  [/assignment of benefits|direction to pay/i, 'AOB / DTP'],
  [/lifetime (warranty|workmanship|pledge)/i, 'lifetime warranty'],
  [/\b(we are|we're|NBD is|I'm|I am|fully) licensed\b|licensed and insured/i, '"licensed" (say fully insured)'],
  [/Master Elite/i, 'Master Elite'],
  [/Hardie[- ]certified|certified by (James )?Hardie|certified by American Operator/i, 'membership called a certification'],
  [/\b\d+(\.\d+)?\s?% APR|\bAPR of\b|\binterest rate of\b|\$\d[\d,]*(\.\d\d)?\s?(\/|per |a )mo(nth)?\b/i, 'a rate, APR or payment amount (TILA trigger)'],
  [/\b[45](\.\d)?[- ]?star\b|\b\d{2,}\+? (five-star |5-star )?reviews\b/i, 'hard-coded rating or review count'],
  [/storm chasers? (are|is) /i, ''],
].filter(([, l]) => l);

const guides = B.GUIDES.filter((g) => g.page.startsWith('docs/guides/'));

(async () => {
  ok('homeowner guides are registered', guides.length >= 2, guides.map((g) => g.slug).join(','));
  for (const g of guides) {
    console.log('\n' + g.slug);
    const md = read('site-src/guides/' + g.slug + '.md');
    const page = read(g.page);
    const meta = B.splitFrontMatter(md).meta;
    const body = B.splitFrontMatter(md).body;

    // A. drift
    const sch = B.schema(md);
    const stamped = B.stampRegion(B.stamp(page, g.slug, B.render(md).html), 'SCHEMA', g.slug, sch, !sch).replace(/\r\n/g, '\n');
    ok('page matches its Markdown (node scripts/build-guides.js)', stamped === page);
    ok('front matter: slug, URL, audience, compliance notes', meta.slug === g.slug && meta.url === 'https://nobigdealwithjoedeal.com/guides/' + g.slug && !!meta.audience && /\ncompliance:\n\s+- /.test(md.split('\n---')[0]));

    // B. the page
    ok('indexable with its canonical', /<meta name="robots" content="index,follow">/.test(page) && page.includes('<link rel="canonical" href="https://nobigdealwithjoedeal.com/guides/' + g.slug + '">'));
    const ld = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => { try { return JSON.parse(m[1]); } catch (e) { return { bad: m[1].slice(0, 80) }; } });
    ok('every JSON-LD block parses', ld.every((x) => !x.bad));
    const art = ld.find((x) => x['@type'] === 'Article');
    ok('Article: author is the site-wide #joe, free, dated', art && art.author && art.author['@id'] === 'https://nobigdealwithjoedeal.com/#joe' && art.isAccessibleForFree === true && /^2026-/.test(art.datePublished));
    ok('BreadcrumbList via /free-tools', ld.some((x) => x['@type'] === 'BreadcrumbList' && JSON.stringify(x).includes('/free-tools')));
    if (meta.faq_chapter) {
      const faq = ld.find((x) => x['@type'] === 'FAQPage');
      const qs = (body.split('# ' + meta.faq_chapter)[1] || '').split(/\n# /)[0].match(/^## /gm) || [];
      ok('FAQPage mirrors every question in "' + meta.faq_chapter + '"', faq && faq.mainEntity.length === qs.length && qs.length >= 3, faq && faq.mainEntity.length + ' vs ' + qs.length);
    }
    if (meta.howto_chapter) {
      const how = ld.find((x) => x['@type'] === 'HowTo');
      ok('HowTo mirrors the steps in "' + meta.howto_chapter + '"', how && how.step.length >= 4 && how.step.every((s) => s.text));
    }
    for (const part of ['nav-tool', 'mobile-nav-standard', 'footer-slim', 'mobile-cta', 'schema-entity']) {
      ok('site chrome from the ' + part + ' partial', new RegExp('<!-- nbd:partial ' + part + '\\b').test(page));
    }
    const scripts = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    ok('no inline script', scripts.every((m) => /application\/ld\+json/.test(m[1]) || m[2].trim() === ''));
    ok('no on*= handlers', !/\son[a-z]+=\s*"/i.test(page));
    const mainHtml = page.slice(page.indexOf('<main'), page.indexOf('</main>'));
    ok('no inline style attributes in the guide itself', !/\sstyle="/.test(mainHtml));
    ok('guide CSS and the PDF-slot script are cache-busted', /nbd-guide\.css\?v=\d+/.test(page) && /guide-pdf-slot\.js\?v=\d+/.test(page));
    ok('PDF slot: no href until the PDF exists, "coming soon" meanwhile', page.includes('data-pdf-slot data-pdf-href="/guides/pdf/' + g.slug + '.pdf" hidden>') && /data-pdf-soon>Printable PDF coming soon/.test(page) && !/\shref="\/guides\/pdf\//.test(page));
    ok('a clear CTA to book the free inspection', (mainHtml.match(/href="\/inspect"/g) || []).length >= 2);
    ok('the main line is tappable', mainHtml.includes('href="tel:+18594207382"'));

    // C. the words
    for (const phrase of (REQUIRED[g.slug] || [])) ok('says: ' + phrase.slice(0, 70), md.includes(phrase), phrase);
    ok('has a REQUIRED phrase list in this test', (REQUIRED[g.slug] || []).length > 0);
    for (const [re, label] of BANNED) {
      const hit = body.match(re);
      ok('never says: ' + label, !hit, hit && hit[0]);
    }

    // D. wiring
    ok('listed in sitemap.xml', read('docs/sitemap.xml').includes('<loc>https://nobigdealwithjoedeal.com/guides/' + g.slug + '</loc>'));
    for (const from of (LINKED_FROM[g.slug] || [])) ok('linked from ' + from, read(from).includes('href="/guides/' + g.slug + '"'));
    ok('has a LINKED_FROM list in this test', (LINKED_FROM[g.slug] || []).length > 0);
  }

  console.log('\nthe hub');
  {
    const ft = read('docs/free-tools/index.html');
    const cards = [...ft.matchAll(/<a href="\/guides\/([a-z0-9-]+)" class="tool-card">/g)].map((m) => m[1]);
    ok('/free-tools has a "Free guides & checklists" row', /<h2 class="guides-head" id="guides-h">Free guides &amp; checklists<\/h2>/.test(ft));
    ok('one /free-tools card per guide page', guides.every((g) => cards.includes(g.slug)) && cards.every((c) => guides.some((g) => g.slug === c)), cards.join(','));
    const fb = JSON.parse(read('firebase.json'));
    const r = (fb.hosting.redirects || []).find((x) => x.source === '/guides');
    ok('/guides 301s to the hub', r && r.type === 301 && r.destination === '/free-tools');
    const slot = read('docs/assets/js/guide-pdf-slot.js');
    ok('the PDF slot sets the href only after a same-origin 200 application/pdf', /getAttribute\('data-pdf-href'\)/.test(slot) && /res\.ok && type\.indexOf\('application\/pdf'\) !== -1\) reveal\(link, href\)/.test(slot) && /link\.setAttribute\('href', href\)/.test(slot));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
