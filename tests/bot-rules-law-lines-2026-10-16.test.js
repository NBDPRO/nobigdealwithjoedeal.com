/**
 * Bot rules (rules_reference + the draft wording guard) carry the law lines
 * the 2026-10-16 legal cross-check verified from primary sources:
 *
 *   KRS 367.628(1)(a)2 (2026 Ky. Acts ch. 54 sec. 4): a contractor shall not
 *     "Represent or market the contractor ... as: a. A claims specialist or
 *     expert; b. An insurance specialist or expert; or c. Having any
 *     affiliation with an insurer or an insurer's agent."
 *   KRS 367.379 (2026 Ky. Acts ch. 54 sec. 9): under an Attorney General order
 *     after a declared emergency, "a contractor shall not solicit business in
 *     person within the designated area for ninety (90) days after the state
 *     of emergency was declared without prior approval of the property owner."
 *   ORC 4722.01(C) / 4722.04: the 10% down-payment cap, contracts "exceeding"
 *     $25,000.
 *   ORC 1345.22(B): no services during the Ohio 3-day window; 16 CFR 429.1(e)
 *     / ORC 1345.23(D)(2): tell the buyer orally.
 *   47 CFR 64.1200(c)(1), (a)(2), (a)(10); 15 U.S.C. 7704(a)(5);
 *   16 CFR 465.2 / 465.4 / 465.7; 12 CFR 1026.24(d).
 *
 * Before: rules_reference had no Ohio cap, no 90-day rule, no texting /
 * review / financing law, and never_say lacked the specialist / affiliation
 * ban; the draft guard let "our insurance claim specialist" through.
 */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'functions', 'agent-mcp-logic.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? ' — ' + String(extra).slice(0, 240) : '')); }
}

const nbd = L.rulesReference();
const tenant = L.rulesReferenceFor({ isNbd: false, profile: { companyName: 'Acme Roofing' } });

console.log('\n1. Law lines, each with its primary source');
const WANT = {
  ohio_down_payment: [/OVER \$25,000/, /4722\.01\(C\)/, /4722\.04/, /10%/],
  cancellation: [/third business day/, /16 CFR 429\.1/, /1345\.22\(B\)/, /out loud/, /367\.622/, /367\.626/],
  kentucky_declared_emergency: [/KRS 367\.379/, /90 days/, /Attorney General/, /in person/, /register/, /owner asks|owner's prior approval/],
  texting: [/Reply STOP to opt out\./, /64\.1200\(c\)\(1\)/, /8 a\.m\./, /9 p\.m\./, /prior express written consent/, /64\.1200\(a\)\(10\)/],
  email: [/postal address/, /unsubscribe/, /7704\(a\)\(5\)/],
  reviews: [/465\.4/, /465\.2/, /every customer/],
  financing: [/1026\.24\(d\)/, /APR/],
};
for (const [ref, label] of [[nbd, 'NBD'], [tenant, 'tenant']]) {
  for (const k of Object.keys(WANT)) {
    const line = ref.law && ref.law[k];
    ok(label + ' law.' + k + ' present with its citations', typeof line === 'string' && WANT[k].every((re) => re.test(line)), line);
  }
}
ok('NBD deposit block names the Ohio cap (over $25,000)', /OVER \$25,000/.test(nbd.deposit.ohio_over_25000 || ''));
ok('no rule says "$25,000 or more"', !/25,000 or more/i.test(JSON.stringify(nbd) + JSON.stringify(tenant)));

console.log('\n2. Kentucky never_say: the specialist / expert / insurer-affiliation ban');
for (const [ref, label] of [[nbd, 'NBD'], [tenant, 'tenant']]) {
  const ns = ref.kentucky_insurance_jobs.never_say.join(' | ');
  ok(label + ': claims specialist / expert', /claims specialist/.test(ns) && /claims expert/.test(ns), ns);
  ok(label + ': insurance specialist / expert', /insurance specialist/.test(ns) && /insurance expert/.test(ns), ns);
  ok(label + ': affiliation with an insurer', /affiliated with/.test(ns), ns);
  ok(label + ': the old three lines kept', /we handle your claim/.test(ns) && /negotiate/.test(ns) && /adjuster/.test(ns));
}

console.log('\n3. The draft wording guard');
const BAD = ['Joe is our insurance claim specialist.', 'Our insurance experts will walk you through it.', 'He is a claims expert.',
  'We are approved by State Farm.', 'Preferred by your insurance company.', 'We are affiliated with your insurer.'];
const GOOD = ["I'm not an insurance specialist; the claim stays yours.", 'I document the damage and meet the adjuster; the claim stays yours.',
  'Storm damage specialist? No, just a roofer who shows up.', 'Whether insurance covers it depends on your policy and the damage.'];
BAD.forEach((s) => ok('flags: ' + s, !!L.claimWordingProblem(s)));
GOOD.forEach((s) => ok('allows: ' + s, !L.claimWordingProblem(s), L.claimWordingProblem(s)));
ok('a flagged title cites KRS 367.628(1)(a)2', /367\.628\(1\)\(a\)2/.test(L.claimWordingProblem(BAD[0]) || ''));
ok('the old claim-handling check still fires', /never handle, negotiate or manage/.test(L.claimWordingProblem('We will handle your insurance claim.') || ''));
ok('the NBD reference passes the guard itself (never_say aside)', !L.claimWordingProblem(JSON.stringify(nbd).replace(/never_say[^\]]*\]/, '')));
ok('the tenant reference passes the guard itself (never_say aside)', !L.claimWordingProblem(JSON.stringify(tenant).replace(/never_say[^\]]*\]/, '')));

console.log('\n' + (fail ? 'FAILED' : 'OK') + ' -- ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
