#!/usr/bin/env node
/**
 * tests/claim-cleanups-2026-10-16.test.js — four public claims the guide
 * work turned up, each checked and fixed on 2026-10-16. Fails if any of them
 * comes back.
 *
 *   A. Monthly payments (Reg Z / TILA). /services/financing and /estimate
 *      printed "$218–$299/mo" style figures. In an ad, a payment amount needs
 *      the APR beside it; the CRM rule (PR #2475) is that NBD prints no rate
 *      or APR because the lender sets rate, APR and term after approval. The
 *      two can't both hold on a public page, so the amounts are gone: no
 *      payment figure, no APR, no estimator. The financing link stays.
 *   B. "Elite · Lifetime Designer" on /estimate. Not a manufacturer product
 *      line (GAF's designer shingles are Camelot II, Grand Sequoia, Slateline
 *      and Woodland; "Lifetime" is warranty marketing), and NBD's Elite
 *      package is GAF Timberline UHDZ, an architectural shingle. Now the
 *      package name: "Elite · Architectural".
 *   C. /pro "$10M+ in claims experience": no source anyone can check. Removed.
 *   D. CRM login "12-Chapter Masterclass": not a product NBD sells. The panel
 *      now links the free NBD Pro playbook (/pro/playbook).
 *
 * Run: node tests/claim-cleanups-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
// What a visitor (or a crawler reading JSON-LD) can see: no HTML comments, no CSS.
const visible = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 300) : '')); failed++; }
}
const firstMatch = (s, re) => { const m = re.exec(s); return m ? s.slice(Math.max(0, m.index - 60), m.index + 80) : ''; };

// A payment figure: "$218/mo", "$218–$299 a month", "$— per month", "/mo".
const PAYMENT = /\/mo\b|(\$[\d,]+|\$&#8212;|\$—)[^<.]{0,40}\b(a|per) month|per month with financing/i;
// A rate: "APR", or a percentage with decimals ("11.49%").
const RATE = /\bAPR\b|\b\d{1,2}\.\d{1,2}\s*(%|&#37;|percent)/i;

console.log('A. no monthly payment amounts or rates on the public money pages');
const fin = read('docs/services/financing.html');
const est = read('docs/estimate.html');
const wizard = read('docs/assets/js/inline/4053149b2f.js');
for (const [name, html] of [['/services/financing', fin], ['/estimate', est]]) {
  const v = visible(html);
  ok(name + ': no monthly payment figure', !PAYMENT.test(v), firstMatch(v, PAYMENT));
  ok(name + ': no APR or rate', !RATE.test(v), firstMatch(v, RATE));
}
ok('/services/financing: no payment estimator (markup, script or file)',
  !/id="fe-amount"|fe-pay|financing-estimator\.js/.test(fin) && !fs.existsSync(path.join(ROOT, 'docs/assets/js/financing-estimator.js')));
ok('/services/financing: still links the Acorn soft-pull check', fin.includes('https://www.acornfinance.com/pre-qualify/?d=QU6WZ'));
ok('/services/financing: says the lender sets rate, term and payment', /lender sets (your|the) rate, term and payment/.test(visible(fin)));
ok('/estimate: no monthly line in the results card', !/resultMonthly/.test(est));
ok('/estimate: the financing link stays (hidden for storm claims and sub-$3k by the wizard)',
  /<div class="result-financing" id="resultFinancing" hidden>\s*<a class="rm-link" href="\/services\/financing">/.test(est));
ok('estimate wizard: computes no payment (no APR constants, no amortization)',
  !/0\.1149|0\.1999|finPay|resultMonthlyFigs/.test(wizard) && /function renderFinancingLink\(min\)/.test(wizard));
ok('estimate wizard: hides the link for storm claims and projects under $3,000',
  /wrap\.hidden = funnelData\.service === 'storm-damage' \|\| !min \|\| min < FIN_MIN_PROJECT;/.test(wizard) && /const FIN_MIN_PROJECT = 3000;/.test(wizard));
ok('estimate wizard cache-bust: loader ?v=5 on the page, wizard ?v=6 in the loader',
  est.includes('/assets/js/estimate-wizard-loader.js?v=5') && read('docs/assets/js/estimate-wizard-loader.js').includes("/assets/js/inline/4053149b2f.js?v=6"));

console.log('B. Elite is a package name, not an invented product line');
ok('/estimate: no "Lifetime Designer" (page or wizard)', !/lifetime designer/i.test(est) && !/lifetime designer/i.test(wizard));
ok('/estimate: the Elite tab reads "Elite · Architectural"', est.includes('<button class="tier-tab" data-tier="best">Elite &#183; Architectural</button>'));
ok('estimate wizard: Elite label is "Elite (Architectural)"', wizard.includes("best: 'Elite (Architectural)'"));

console.log('C. /pro: no unverifiable claims-volume figure');
const pro = read('docs/pro/index.html');
ok('/pro: no "$10M+" and no "claims experience"', !/\$10M|10 million|claims experience/i.test(pro), firstMatch(pro, /\$10M|claims experience/i));
ok('/pro: the proof row still shows the checkable figures', /<strong>7 years<\/strong>/.test(pro) && /<strong>Every price<\/strong>/.test(pro));
ok('/pro: landing.css cache-busted for the 4-up proof row', pro.includes('/pro/css/landing.css?v=3') && /\.pl-proof-row \{ display: grid; grid-template-columns: repeat\(4, 1fr\); \}/.test(read('docs/pro/css/landing.css')));

console.log('D. CRM login: the free playbook, not a Masterclass');
const login = read('docs/pro/login.html');
ok('/pro/login: no "Masterclass"', !/masterclass/i.test(visible(login)), firstMatch(login, /masterclass/i));
ok('/pro/login: links the Free NBD Pro playbook at /pro/playbook', /<a href="\/pro\/playbook"[^>]*>Free NBD Pro playbook<\/a>/.test(login));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
