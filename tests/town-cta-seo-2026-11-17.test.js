/**
 * tests/town-cta-seo-2026-11-17.test.js
 *
 * Pins the 2026-11-17 town/service page sweep (scripts/town-cta-seo-2026-11-17.js).
 * Structural checks only (parseTags), so a reflow does not break them:
 *   1. area and service pages book through /inspect: no cal.com button, no
 *      "Email Joe", no "Request Estimate", no /#contact estimate button;
 *   2. the "One free roof a year" announcement slide is gone from the pages
 *      this sweep owns (docs/index.html and docs/blog/ are other lanes);
 *   3. the service hero proof row says "Fully insured" and carries the live
 *      rating hook with "Real Google reviews" as the fallback;
 *   4. hail-damage town pages: headings follow the "Roof Inspection" title, and
 *      Mt. Orab's FAQ no longer promises what an inspection will conclude;
 *   5. every town page: ONE title pattern, its own description, & escaped,
 *      Cincinnati's H1 no longer echoes the homepage "Cincinnati roofer".
 * Run: node tests/town-cta-seo-2026-11-17.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const K = require('./lib/src-kit');
const T = K.suite('TOWN / SERVICE CTA + SEO SWEEP (2026-11-17)');
const { ok, section } = T;

const DOCS = path.join(K.ROOT, 'docs');
function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.html')) out.push(path.relative(K.ROOT, p).split(path.sep).join('/'));
  }
  return out;
}
const doc = (r) => K.parseTags(K.read(r));
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const LEX = new Set(['areas/lexington-ky', 'areas/georgetown-ky', 'areas/richmond-ky', 'areas/winchester-ky', 'areas/nicholasville-ky', 'areas/versailles-ky',
  'services/hail-damage-lexington-ky', 'services/storm-damage-lexington-ky', 'services/roof-replacement-lexington-ky'].map((p) => 'docs/' + p + '.html'));
const LEX_CAL = 'https://cal.com/nobigdeal/roof-inspection-lexington';
// Eight towns keep their 2026-10-07 Search Console titles; six keep that pass's descriptions too
const GSC_TITLE = new Set(['fort-mitchell-ky', 'indian-hill-oh', 'amelia-oh', 'mt-orab-oh', 'loveland-oh', 'montgomery-oh', 'mason-oh', 'cincinnati-oh']);
const GSC_DESC = new Set(['fort-mitchell-ky', 'indian-hill-oh', 'amelia-oh', 'mt-orab-oh', 'loveland-oh', 'montgomery-oh']);
const pages = [...walk(path.join(DOCS, 'areas'), []), ...walk(path.join(DOCS, 'services'), [])];
const docs = new Map(pages.map((r) => [r, doc(r)]));

section('1. one booking path on area and service pages');
{
  const bad = { cal: [], email: [], req: [], contact: [] };
  for (const [r, d] of docs) {
    for (const a of d.$$('a')) {
      const href = a.attr('href') || '';
      const label = squash(a.text);
      if (href.startsWith('https://cal.com/') && !(LEX.has(r) && href === LEX_CAL)) bad.cal.push(r);
      if (/Email Joe/.test(label)) bad.email.push(r);
      if (label === 'Request Estimate') bad.req.push(r);
      if (href === '/#contact' && a.classes.some((c) => c.startsWith('btn-')) && /^(Get My Free Estimate|Request Estimate)/.test(label)) bad.contact.push(r);
    }
  }
  ok(pages.length + ' pages: no cal.com link', bad.cal.length === 0, bad.cal.slice(0, 3).join(', '));
  ok('no "Email Joe" link', bad.email.length === 0, bad.email.slice(0, 3).join(', '));
  ok('no "Request Estimate" button', bad.req.length === 0, bad.req.slice(0, 3).join(', '));
  ok('no /#contact estimate button', bad.contact.length === 0, bad.contact.slice(0, 3).join(', '));
  const lexBad = [...LEX].filter((r) => {
    const a = docs.get(r).$$('.cta-section a, .final-cta a').filter((x) => (x.attr('href') || '') === LEX_CAL);
    return a.length !== 1 || squash(a[0].text) !== 'Book a free inspection' || a[0].attr('target') !== '_blank' || !a[0].attr('rel').includes('noopener');
  });
  ok('the 9 Central KY pages book on the Lexington cal.com event (/inspect cannot route Lexington)', LEX.size === 9 && lexBad.length === 0, lexBad.join(', '));
  const fl = docs.get('docs/areas/florence-ky.html').$$('.cta-section a').map((a) => (a.attr('href') || '') + ' | ' + squash(a.text));
  ok('Florence final CTA is the phone link then /inspect "Book a free inspection"',
    fl.length === 2 && fl[0].startsWith('tel:+18594207382') && fl[1] === '/inspect | Book a free inspection', fl.join(' ;; '));
  const ri = docs.get('docs/services/roof-inspection.html').$$('.final-cta a').map((a) => (a.attr('href') || '') + ' | ' + squash(a.text));
  ok('roof-inspection final CTA is /inspect then the phone link',
    ri.length === 2 && ri[0] === '/inspect | Book a free inspection →' && ri[1].startsWith('tel:+18594207382'), ri.join(' ;; '));
}

section('2. announcement bar: no free-roof slide on the swept pages');
{
  const left = [];
  for (const r of walk(DOCS, [])) {
    if (/^docs\/(blog|pro|admin|sites|dev|assets)\//.test(r) || r === 'docs/index.html') continue;
    if (doc(r).$$('[data-nbd-freeroof-ann]').length) left.push(r);
  }
  ok('no data-nbd-freeroof-ann slide outside index.html and blog/', left.length === 0, left.slice(0, 5).join(', '));
  // The seasonal slide (scripts/seasonal-ann-slide.js) comes and goes; the three standing slides do not.
  const slides = docs.get('docs/areas/florence-ky.html').$$('.ann-bar .ann-slide').filter((s) => !s.has('data-nbd-season-ann'));
  ok('Florence keeps the other three slides, phone slide still linked', slides.length === 3 && !!slides[1].$('a[href="tel:+18594207382"]'));
}

section('3. service hero proof row');
{
  const withProof = [...docs].filter(([, d]) => d.$('ul.svc-proof'));
  const bad = withProof.filter(([, d]) => {
    const items = d.$$('ul.svc-proof li').map((li) => squash(li.text));
    const hook = d.$('ul.svc-proof [data-nbd-gr-rating-wrap][hidden] [data-nbd-gr-rating]');
    const fb = d.$('ul.svc-proof [data-nbd-gr-rating-fallback]');
    return !items.includes('Fully insured') || !hook || !fb || squash(fb.text) !== 'Real Google reviews';
  }).map(([r]) => r);
  ok(withProof.length + ' pages with a proof row all carry "Fully insured" + the live rating hook', withProof.length >= 14 && bad.length === 0, bad.join(', '));
}

section('4. hail-damage town pages');
{
  const hail = pages.filter((r) => /^docs\/services\/hail-damage-[a-z-]+-(oh|ky)\.html$/.test(r));
  const bad = hail.filter((r) => docs.get(r).$$('h2').some((h) => /Insurance Claims|Hail Damage Repair|Hail Damage Claims|Hail Claims|Claims Estimate/.test(squash(h.text)))).map((r) => r);
  ok(hail.length + ' hail-damage town pages: no "Insurance Claims" / "Repair" heading under a "Roof Inspection" title', hail.length >= 26 && bad.length === 0, bad.join(', '));
  const m = docs.get('docs/services/hail-damage-mt-orab-oh.html');
  const faq = m.$$('.faq-a').map((e) => squash(e.text)).join(' ');
  ok('Mt. Orab FAQ no longer says an inspection settles whether a claim is worth pursuing', !faq.includes('definitively'), faq.slice(0, 200));
  ok('Mt. Orab FAQ says what the inspection documents instead', faq.includes('documents what is on your roof, with photos, so you can decide whether to file a claim'));
  const ld = m.$$('script[type="application/ld+json"]').map((s) => s.html).join(' ');
  ok('Mt. Orab FAQPage JSON-LD carries the same reworded answer', ld.includes('so you can decide whether to file a claim') && !ld.includes('definitively'));
}

section('5. town pages: one title pattern, own description, own Cincinnati H1');
{
  const towns = require('../site-src/data/towns.json').towns;
  const seen = new Map();
  const titleBad = [], descBad = [], ampBad = [], dup = [], socialBad = [];
  const meta = (d, k, v) => { const e = d.$('meta[' + k + '="' + v + '"]'); return e ? e.attr('content') : ''; };
  for (const t of towns) {
    const r = 'docs/areas/' + t.slug + '.html';
    const d = docs.get(r);
    const title = squash(d.$('title').text).replace(/&amp;/g, '&');
    const desc = meta(d, 'name', 'description');
    if (!GSC_TITLE.has(t.slug) && (title !== 'Roofing, Siding & Gutters in ' + t.town + ', ' + t.state + ' | NBD' || title.length > 60)) titleBad.push(r + ' => ' + title);
    if (GSC_TITLE.has(t.slug) && !title.startsWith(t.town + ', ' + t.state + ' Roofer | ')) titleBad.push(r + ' lost its GSC title => ' + title);
    if (!d.$('title').html.includes('&amp;') || /&(?!amp;)/.test(d.$('title').html)) ampBad.push(r);
    if (desc.length < 120 || desc.length > 155 || (!GSC_DESC.has(t.slug) && (!desc.includes(t.town + ', ' + t.state) || !desc.includes(String(t.housing.medianYearBuilt))))) descBad.push(r + ' (' + desc.length + ')');
    if (seen.has(desc)) dup.push(r + ' = ' + seen.get(desc)); else seen.set(desc, r);
    const ogt = meta(d, 'property', 'og:title');
    if (ogt !== meta(d, 'name', 'twitter:title') || !ogt.startsWith('Roofing, Siding & Gutters in ' + t.town) ||
      meta(d, 'property', 'og:description') !== desc || meta(d, 'name', 'twitter:description') !== desc) socialBad.push(r);
  }
  ok((towns.length - GSC_TITLE.size) + ' town pages share the title "Roofing, Siding & Gutters in <Town>, <ST> | NBD" (<= 60 chars); the 8 GSC towns keep "<Town>, <ST> Roofer | ..."', titleBad.length === 0, titleBad.slice(0, 3).join(' | '));
  ok('every & in a title is written &amp;', ampBad.length === 0, ampBad.slice(0, 3).join(', '));
  ok('every description is 120-155 chars; the generated ones name their town and Census build year', descBad.length === 0, descBad.slice(0, 3).join(' | '));
  ok('no two town descriptions are the same', dup.length === 0, dup.slice(0, 3).join(' | '));
  ok('og/twitter titles and descriptions agree with the page', socialBad.length === 0, socialBad.slice(0, 3).join(', '));
  const h1 = squash(docs.get('docs/areas/cincinnati-oh.html').$('h1').text);
  ok('Cincinnati area H1 does not repeat the homepage "Cincinnati roofer" wording', h1 !== '' && !h1.toLowerCase().includes('roofer'), h1);
}

section('6. follow-ups: unsourced / outcome wording, breadcrumbs, remaining booking buttons');
{
  const flo = squash(docs.get('docs/areas/florence-ky.html').$('.city-hero-content p').text);
  ok('Florence hero no longer claims "busiest roofing market" or that other contractors won\'t cross the river', !flo.includes('busiest') && !flo.includes('cross the river') && flo.includes('same pricing'), flo);
  const cl = docs.get('docs/services/hail-damage-clarksville-oh.html');
  const clText = cl.$$('.faq-a').map((e) => squash(e.text)).join(' ') + cl.$$('script[type="application/ld+json"]').map((e) => e.html).join(' ');
  ok('Clarksville no longer says "you have a claim right" or "definitively"', !clText.includes('claim right') && !clText.includes('definitively') && clText.includes('so you can decide whether to file a claim'));
  const an = squash(docs.get('docs/services/roof-repair-anderson-township-oh.html').$$('.inc-item').map((e) => e.text).join(' | '));
  ok('Anderson Twp roof-repair scope no longer says it identifies if a claim is worth pursuing', !an.includes('worth pursuing') && an.includes('documents the damage so you can decide whether to file a claim'));
  const hail = pages.filter((r) => /^docs\/services\/hail-damage-[a-z-]+-(oh|ky)\.html$/.test(r) && !r.endsWith('insurance-claim.html'));
  const crumb = hail.filter((r) => { const d = docs.get(r); return d.$$('.breadcrumb span, .breadcrumb a').some((e) => squash(e.text).startsWith('Hail Damage Repair')) || d.$$('script[type="application/ld+json"]').some((e) => e.html.includes('Hail Damage Repair')); });
  ok(hail.length + ' hail town pages: breadcrumbs say "Hail Damage Inspection", not "Repair"', crumb.length === 0, crumb.slice(0, 3).join(', '));
  const ic = docs.get('docs/services/hail-damage-insurance-claim.html').$$('.final-cta a').map((a) => a.attr('href'));
  ok('hail-damage-insurance-claim final CTA books through /inspect, not /book', ic.includes('/inspect') && !ic.includes('/book'), ic.join(', '));
  const cp = docs.get('docs/services/roof-care-plan.html');
  const cpBook = cp.$$('a').filter((a) => squash(a.text) === 'Book a free inspection');
  ok('roof-care-plan "start with an inspection" links are /inspect "Book a free inspection"', cpBook.length === 3 && cpBook.every((a) => a.attr('href') === '/inspect') && !cp.$$('a').some((a) => squash(a.text).startsWith('Start with a free inspection')), String(cpBook.length));
  ok('roof-care-plan keeps its plan sign-up buttons', cp.$$('a[data-careplan-cta]').length >= 2);
}

T.done();
