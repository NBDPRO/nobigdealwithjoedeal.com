/**
 * tests/call-brief-buttons-2026-11-09.test.js — Call to Close P0 step 6: the
 * "Draft from this call" buttons on the two call cards and the demo fakes.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §3.1, §7.
 *
 *   1. the gate (briefGate in customer-calls.js and call-center-view.js, the
 *      same rule as functions/call-brief-logic.js humanFiledProblem +
 *      canActOnCall): noted business call a PERSON filed with no alternates →
 *      "Draft"; auto-matched / alternates → "Confirm the customer first";
 *      short, personal, spam, not noted, viewer, sales rep who does not own
 *      the call → nothing
 *   2. the buttons: rendered only for those, lazy-load the sheet on tap,
 *      Confirm goes through the existing file action (attach)
 *   3. the demo: callBrief / callBriefDecide are CANNED with the
 *      noPhoneInSample answer, so nothing leaves the browser
 *
 * Run: node tests/call-brief-buttons-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const L = require(path.join(ROOT, 'functions', 'call-brief-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}

function gateFrom(file) {
  const src = read(file);
  const m = /function briefGate\(c\) \{[\s\S]*?\n  \}\n/.exec(src);
  if (!m) return null;
  return (claims, uid, c) => {
    const ctx = vm.createContext({ window: { _userClaims: claims, auth: { currentUser: { uid } } } });
    vm.runInContext('function claims() { return window._userClaims || {}; }\nfunction isViewer() { return claims().role === "viewer"; }\n' + m[0] + '\nthis.__r = briefGate(' + JSON.stringify(c) + ');', ctx);
    return ctx.__r;
  };
}

const BASE = { userId: 'jo', companyId: 'co1', status: 'noted', callType: 'customer', leadId: 'L1', attachedBy: 'jo', alternateLeadIds: [], transcript: 'We had a hail storm last Tuesday and the roof leaks.' };
const OWNER = [{}, 'jo'];
const CASES = [
  ['human-filed, noted, no alternates (owner)', OWNER, {}, 'draft'],
  ['moved by a person', OWNER, { attachedBy: null, movedBy: 'jo' }, 'draft'],
  ['company_admin of the same company', [{ role: 'company_admin', companyId: 'co1' }, 'ca'], {}, 'draft'],
  ['manager of the same company', [{ role: 'manager', companyId: 'co1' }, 'mg'], {}, 'draft'],
  ['platform admin', [{ role: 'admin' }, 'adm'], {}, 'draft'],
  ['auto-matched by number (no attachedBy / movedBy)', OWNER, { attachedBy: null }, 'confirm'],
  ['alternates on the number', OWNER, { alternateLeadIds: ['L2'] }, 'confirm'],
  ['short call', OWNER, { status: 'short' }, ''],
  ['personal call', OWNER, { status: 'personal', callType: 'personal' }, ''],
  ['spam', OWNER, { callType: 'spam' }, ''],
  ['not noted yet', OWNER, { status: 'stored' }, ''],
  ['no transcript', OWNER, { transcript: '' }, ''],
  ['viewer', [{ role: 'viewer', companyId: 'co1' }, 'v'], {}, ''],
  ['viewer who owns the call', [{ role: 'viewer', companyId: 'co1' }, 'jo'], {}, ''],
  ['sales rep who does not own the call', [{ role: 'sales_rep', companyId: 'co1' }, 'rep'], {}, ''],
  ['company_admin of another company', [{ role: 'company_admin', companyId: 'co2' }, 'c2'], {}, ''],
];

console.log('\n1. The gate, on both cards, agrees with the server');
for (const file of ['docs/pro/js/customer-calls.js', 'docs/pro/js/call-center-view.js']) {
  const gate = gateFrom(file);
  ok(file + ' has briefGate', typeof gate === 'function');
  if (!gate) continue;
  for (const [name, [claims, uid], over, want] of CASES) {
    const c = Object.assign({}, BASE, over);
    const got = gate(claims, uid, c);
    ok(file.split('/').pop() + ': ' + name + ' → ' + (want || 'nothing'), got === want, got);
    // The server's own answer for the same call (the card must never offer a
    // Draft the server refuses, nor hide one it allows).
    if (want === 'draft') ok('  …the server agrees (allowed)', L.humanFiledProblem(c) === '' && L.canActOnCall({ uid, token: claims }, c));
  }
}
{
  const gate = gateFrom('docs/pro/js/customer-calls.js');
  if (gate) ok('customer page: a call matched only by number (no leadId) → confirm', gate({}, 'jo', Object.assign({}, BASE, { leadId: null, attachedBy: null })) === 'confirm');
}

console.log('\n2. The buttons');
{
  const cc = read('docs/pro/js/customer-calls.js');
  ok('customer page: "Draft from this call" button on a draft-gated card', /briefGate\(c\)/.test(cc) && /data-calls-act="pc-brief"/.test(cc) && /Draft from this call/.test(cc));
  ok('customer page: "Confirm the customer first" on an auto-matched card', /data-calls-act="pc-confirm"/.test(cc) && /Confirm the customer first/.test(cc));
  ok('customer page: Confirm files the call on this customer through callCenterAction attach', /action: 'attach', leadId: window\._customerId/.test(cc));
  ok('customer page: the sheet lazy-loads on tap (ScriptLoader.load of call-brief-ui.js), page "customer"', /ScriptLoader\.load\('\/pro\/js\/call-brief-ui\.js\?v=2'\)/.test(cc) && /page: 'customer'/.test(cc));
  // The P1 sheet (follow-up message, objections) is a new call-brief-ui.js:
  // its loaders moved to ?v=2, so the files that name it are re-fetched too.
  ok('customer.html re-fetches customer-calls.js (v=10+), which names call-brief-ui.js?v=2', /js\/customer-calls\.js\?v=(\d+)/.test(read('docs/pro/customer.html')) && Number(read('docs/pro/customer.html').match(/js\/customer-calls\.js\?v=(\d+)/)[1]) >= 10);
  const cv = read('docs/pro/js/call-center-view.js');
  ok('Call Center: "Draft from this call" button', /briefGate\(c\)/.test(cv) && /data-cc="brief"/.test(cv) && /Draft from this call/.test(cv));
  ok('Call Center: Confirm opens the existing attach picker (the file action)', /Confirm the customer first/.test(cv) && /data-cc="attachopen" data-id="' \+ esc\(c\.id\) \+ '">Confirm the customer first/.test(cv));
  ok('Call Center: the sheet lazy-loads on tap, page "calls"', /ScriptLoader\.load\('\/pro\/js\/call-brief-ui\.js\?v=2'\)/.test(cv) && /page: 'calls'/.test(cv));
  for (const [f, src] of [['customer-calls.js', cc], ['call-center-view.js', cv]]) {
    const added = src.split('\n').filter((l) => /brief/i.test(l)).join('\n');
    ok(f + ': no inline style or handler in the new lines', !/style=|\son[a-z]+=/.test(added));
  }
}

console.log('\n3. The demo');
{
  const demo = read('docs/pro/demo-sdk/firebase-functions.js');
  ok('callBrief is CANNED with the no-phone answer', /callBrief: \(\) => \{ throw noPhoneInSample\('callBrief'\); \}/.test(demo));
  ok('callBriefDecide is CANNED with the no-phone answer', /callBriefDecide: \(\) => \{ throw noPhoneInSample\('callBriefDecide'\); \}/.test(demo));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
