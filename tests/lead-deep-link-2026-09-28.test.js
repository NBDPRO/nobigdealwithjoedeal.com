/**
 * tests/lead-deep-link-2026-09-28.test.js
 *
 * CRM sweep R13 (emulator, 2026-09-28) — "open this lead" deep links.
 *
 * THE BUG: the notification bell (notif-bell.js) and task reminders (tasks.js)
 * link to /pro/dashboard.html?tab=crm&lead=ID; push notifications
 * (firebase-messaging-sw.js, functions/push-functions.js) to
 * ?tab=leads&leadId=ID. dashboard-bootstrap never read `tab`, so the bell's
 * links fell into the NEW-ESTIMATE branch (a bare ?lead= is the "new estimate
 * for this lead" link): tapping "New referral" opened a blank Estimate Builder.
 * Push links matched no branch and landed on Home.
 *
 * THE FIX: leadDeepLinkId(params) recognises both shapes; its branch runs
 * BEFORE the new-estimate branch and opens the lead's card (customer page
 * when the lead is not in this rep's cache).
 *
 * Runs the REAL leadDeepLinkId lifted out of the module into a vm, and pins
 * the branch order. Break-test: against main the helper is absent.
 *
 * Zero deps. Run: node tests/lead-deep-link-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) return '';
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const fnSrc = extractFn(SRC, 'leadDeepLinkId');
ok('leadDeepLinkId exists in dashboard-bootstrap.module.js', !!fnSrc);
const ctx = vm.createContext({ URLSearchParams });
if (fnSrc) vm.runInContext(fnSrc + '\nglobalThis.f = leadDeepLinkId;', ctx);
const f = (qs) => (ctx.f ? ctx.f(new URLSearchParams(qs)) : undefined);

console.log('LEAD DEEP LINKS');
ok('bell / tasks shape ?tab=crm&lead=ID → ID', f('?tab=crm&lead=L1') === 'L1');
ok('push shape ?tab=leads&leadId=ID → ID', f('?tab=leads&leadId=L2') === 'L2');
ok('bare ?lead=ID stays the new-estimate link (null)', f('?lead=L3') === null);
ok('an ?est= link is never a lead open', f('?tab=crm&lead=L4&est=E1') === null);
ok('?tab=crm with no id → null', f('?tab=crm') === null);
ok('another tab with a lead id → null', f('?tab=estimates&lead=L5') === null);

// Branch order: the lead-open branch must be tested before the new-estimate
// branch, or ?tab=crm&lead= still opens a blank estimate.
const iOpen = SRC.indexOf('} else if (leadDeepLinkId(urlParams)) {');
const iNewEst = SRC.indexOf('} else if (estParam || leadParam) {');
ok('the lead-open branch precedes the new-estimate branch', iOpen > 0 && iNewEst > iOpen, iOpen + ' / ' + iNewEst);
const branch = iOpen > 0 ? SRC.slice(iOpen, iNewEst) : '';
ok('…it opens the card when the lead is cached', /openCardDetailModal\(_openId\)/.test(branch));
ok('…and falls back to the customer page otherwise', /customer\.html\?id=' \+ encodeURIComponent\(_openId\)/.test(branch));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
