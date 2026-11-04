/**
 * tests/portal-care-plan-2026-11-04.test.js
 *
 * Customer portal Phase 6 (documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md):
 * the Roof Care Plan on the homeowner portal. Jo: test first, live only
 * after the attorney review.
 *
 *   1. functions/portal-care-plan.js (pure): a member always sees their
 *      plan; the offer only in CARE_PLAN_MODE=live (unset / test / junk = no
 *      offer), only on NBD's own jobs, only once the work is done.
 *   2. Wiring: the view reads the mode through care-plan-logic.js (fail
 *      closed) and never breaks on it; the portal links to the public page
 *      and never runs a checkout itself; the perks shown match the page.
 *
 * Run: node tests/portal-care-plan-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const PC = require(path.join(ROOT, 'functions/portal-care-plan.js'));
const CPL = require(path.join(ROOT, 'functions/care-plan-logic.js'));
const base = { pageUrl: CPL.PUBLIC_PAGE, prices: CPL.PRICES_CENTS, isNbd: true };
const live = Object.assign({}, base, { mode: 'live' });

console.log('\n1. carePlanCard');
const member = { carePlan: { member: true, interval: 'year', renewsAt: { toMillis: () => 1800000000000 }, endsAt: null } };
const m = PC.carePlanCard(member, 'build', Object.assign({}, base, { mode: 'off' }));
ok('a member sees their plan even with the mode off, mid-job', m && m.kind === 'member' && m.interval === 'year' && m.renewsAtMs === 1800000000000 && m.endsAtMs === null);
ok('a cancelling member shows the end date', PC.carePlanCard({ carePlan: { member: true, endsAt: 1800000000000 } }, 'review', base).endsAtMs === 1800000000000);
ok('not a member: no offer while the job is open, even live', ['inspection', 'estimate', 'signed', 'scheduled', 'build'].every((k) => PC.carePlanCard({}, k, live) === null));
const off = PC.carePlanCard({}, 'review', live);
ok('live + NBD + work done → the offer, linking the public page', off && off.kind === 'offer' && off.url === CPL.PUBLIC_PAGE + '?from=portal' && off.yearCents === 19900 && off.monthCents === 1900);
ok('every done step offers', ['walkthrough', 'payment', 'warranty', 'review'].every((k) => (PC.carePlanCard({}, k, live) || {}).kind === 'offer'));
ok('TEST mode → no offer (test is Jo\'s own preview, not homeowners)', PC.carePlanCard({}, 'review', Object.assign({}, base, { mode: 'test' })) === null);
ok('mode off / missing → no offer', PC.carePlanCard({}, 'review', Object.assign({}, base, { mode: 'off' })) === null && PC.carePlanCard({}, 'review', base) === null);
ok('a tenant\'s job → no offer (NBD\'s product)', PC.carePlanCard({}, 'review', Object.assign({}, live, { isNbd: false })) === null);
ok('a lapsed member (member:false) on a done job gets the offer, not a member card', (PC.carePlanCard({ carePlan: { member: false, status: 'canceled' } }, 'review', live) || {}).kind === 'offer');
ok('the mode helper fails closed on junk', CPL.carePlanMode({ CARE_PLAN_MODE: 'LIVE ' }) === 'live' && CPL.carePlanMode({ CARE_PLAN_MODE: 'yes' }) === 'off' && CPL.carePlanMode({}) === 'off');

console.log('\n2. wiring');
const fn = stripComments(read('functions/portal.js'));
ok('the view reads the mode via care-plan-logic.js from the env', /mode: CPL\.carePlanMode\(process\.env\)/.test(fn));
ok('NBD decided by the tenant key', /isNbd: require\('\.\/zelle-contact'\)\.isNbdCompany\(tenantKey \? String\(tenantKey\) : ''\)/.test(fn));
ok('a failure never breaks the portal', /let _carePlan = null;\s*try \{[\s\S]{0,500}\} catch \(e\) \{\s*logger\.warn\('portal care plan card failed'/.test(fn));
ok('the view sends carePlan', /carePlan: _carePlan,/.test(fn));
const pjs = stripComments(read('docs/pro/js/portal.js'));
const offerBlock = pjs.slice(pjs.indexOf("data-care-plan=\"offer\""), pjs.indexOf("data-care-plan=\"offer\"") + 1200);
ok('the offer links out (new tab, metric) — no checkout in the portal', /data-metric="care_plan" href="' \+ esc\(safeUrl\(cpc\.url\)\) \+ '" target="_blank" rel="noopener"/.test(pjs)
  && !/care-plan-checkout|carePlanPublic|stripe/i.test(offerBlock));
const page = read('docs/services/roof-care-plan.html');
ok('every perk shown is on the public page', ['Priority scheduling after storms', '10% off repairs', 'up to 3 shingles', 'roof inspection every year'].every((p) => page.indexOf(p) !== -1 && pjs.indexOf(p) !== -1));
ok('no "warranty" or insurance wording on the card', !/warrant|insurance|claim/i.test(pjs.slice(pjs.indexOf('── Roof Care Plan (Phase 6'), pjs.indexOf('── Keep it on your phone'))));
ok('care_plan metric allowlisted', /'care_plan'\]\);/.test(read('functions/customer-audit.js')));
ok('portal.js cache-buster bumped (v>=24)', Number((read('docs/pro/portal.html').match(/js\/portal\.js\?v=(\d+)/) || [])[1]) >= 24);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
