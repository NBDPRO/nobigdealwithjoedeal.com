/**
 * Public-site wording vs primary law (legal cross-check, 2026-10-16).
 *
 * 1. Credit advertising — Reg Z 12 CFR 1026.24(d)(1)-(2): an ad that states
 *    "the amount of any payment" or "the number of payments or period of
 *    repayment" must also state the down payment, "the terms of repayment"
 *    and "the 'annual percentage rate,' using that term". PR #2510 removed
 *    the payment figures from /services/financing and /estimate; this guard
 *    fails if a financed $/month figure comes back on a public page without
 *    the APR in the same paragraph.
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

console.log('\n1. Reg Z 1026.24(d): no financed $/month figure without its APR');

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
console.log('\n4. Credentials: GAF Certified #1162011, no stale "application in progress" line');
{
  const walk = (d, out) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    const p = d + '/' + e.name; if (e.isDirectory()) { if (p !== 'docs/pro' && !/vendor/.test(p)) walk(p, out); } else if (/\.html$/.test(e.name)) out.push(p); } return out; };
  const stale = walk('docs', []).filter((p) => /application in progress|certification (is )?pending|GAF (certification )?(pending|in progress)/i.test(read(p)));
  ok('no public page says a credential is "in progress" / "pending"', stale.length === 0, stale.join(', '));
  ok('field-notes footer names the GAF certification', /GAF Certified Contractor #1162011/.test(read('docs/blog/field-notes-joes-notebook-goes-public.html')));
}
ok('storm-check.js: no "files the claim" note left to copy', !/files the claim/i.test(read('docs/assets/js/storm-check.js')));

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' -- ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
