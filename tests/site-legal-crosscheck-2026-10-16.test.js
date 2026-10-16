/**
 * Public-site wording vs primary law (legal cross-check, 2026-10-16).
 *
 * 1. Credit advertising — Reg Z 12 CFR 1026.24(d)(1)-(2): an ad that states
 *    "the amount of any payment" or "the number of payments or period of
 *    repayment" must also state "the amount or percentage of the
 *    downpayment", "the terms of repayment" and "the 'annual percentage
 *    rate,' using that term". The financing hero stated $218–$299 a month
 *    over 10 years with no APR in the sentence; the footnotes gave no down
 *    payment.
 * 2. Review asks — 16 CFR 465 / FTC: ask everyone, not only happy customers.
 *    /review asked "Had a Great Experience? If Joe and the crew took care of
 *    you, we'd love a quick review."
 * 3. Kentucky KRS 367.628(1)(a)1 — never represent the insured on the claim;
 *    llms.txt said Joe "submits a supplement" (the KY pages say he writes it
 *    for the homeowner to send).
 *
 * Each check fails if the old wording comes back.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&rsquo;|&#8217;/g, '’')
  .replace(/&ndash;|&#8211;/g, '–').replace(/&mdash;|&#8212;/g, '—').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

console.log('\n1. Reg Z 1026.24(d): a stated payment carries APR, repayment terms and the down payment');
const fin = read('docs/services/financing.html');
const hero = (/<p class="hero-sub">([\s\S]*?)<\/p>/.exec(fin) || [])[1] || '';
const heroT = text(hero);
ok('financing hero: states the monthly payment', /\$218–\$299 a month/.test(heroT), heroT);
ok('financing hero: the same sentence names the APR range ("APR")', /11\.49%–19\.99% APR/.test(heroT), heroT);
ok('financing hero: repayment terms (120 monthly payments)', /120 monthly payments/.test(heroT), heroT);
ok('financing hero: the down payment (nothing down)', /nothing down/.test(heroT), heroT);
const disc = text((/<p class="oc-disc">([\s\S]*?)<\/p>/.exec(fin) || [])[1] || '');
ok('financing footnote: APR, 120 monthly payments and no down payment', /APR/.test(disc) && /120 monthly payments/.test(disc) && /no down payment/.test(disc), disc);
const est = text((/<div class="rm-disc">([\s\S]*?)<\/div>/.exec(read('docs/estimate.html')) || [])[1] || '');
ok('/estimate monthly footnote: APR, 120 monthly payments and no down payment', /APR/.test(est) && /120 monthly payments/.test(est) && /no down payment/.test(est), est);

// Any public paragraph that pairs financing words with a $/month figure
// must say "APR" in the same paragraph or point to a footnote (*).
const PUB = ['docs/index.html', 'docs/estimate.html', 'docs/services/financing.html', 'docs/services/roof-replacement.html',
  'docs/guides/roof-financing-explained.html', 'docs/blog/how-roof-financing-actually-works.html', 'docs/blog/roof-financing-cincinnati-explained.html'];
for (const f of PUB) {
  if (!fs.existsSync(path.join(ROOT, f))) continue;
  const paras = read(f).match(/<(p|li|div)[^>]*>[^<]*(?:<(?!\/?(?:p|li|div)\b)[^>]*>[^<]*)*<\/\1>/g) || [];
  const bad = paras.map(text).filter((t) => /financ|loan|lender/i.test(t) && /\$\d[\d,]*(?:\s*–\s*\$\d[\d,]*)?\s*(?:a month|per month|\/mo)/i.test(t) && !/APR|\*/.test(t));
  ok(f + ': no financed $/month figure without APR or a footnote', bad.length === 0, bad[0] && bad[0].slice(0, 160));
}

console.log('\n2. Review asks go to everyone (no "if you were happy" gate)');
const rev = read('docs/review.html');
const cta = text((/<section class="review-cta">([\s\S]*?)<\/section>/.exec(rev) || [])[1] || '');
ok('/review CTA exists', /Leave a Google Review/.test(cta), cta.slice(0, 120));
ok('/review CTA is not conditional on a good experience', !/had a great experience\?|took care of you|if you were happy|if you loved/i.test(cta), cta.slice(0, 200));
ok('/review CTA says honest reviews of any kind are welcome, nothing offered', /good or bad/i.test(cta) && /nothing is ever offered/i.test(cta), cta.slice(0, 200));

console.log('\n3. KRS 367.628(1)(a)1: the homeowner sends the supplement');
const llms = read('docs/llms.txt');
ok('llms.txt: no "submits a supplement"', !/submits? (a|the) supplement/i.test(llms));
ok('llms.txt: the supplement is for the homeowner to send', /supplement \(his updated estimate for his own work\) for the homeowner to send to their insurer/.test(llms));
ok('storm-check.js: no "files the claim" note left to copy', !/files the claim/i.test(read('docs/assets/js/storm-check.js')));

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' -- ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
