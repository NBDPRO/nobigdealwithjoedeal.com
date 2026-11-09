/**
 * tests/email-tenant-2026-11-06.test.js — CRM audit 2026-11-06, VW-F151 / VW-F152.
 *
 * Three stage-email sentences are NBD's own offer and went to every company's
 * homeowners: estimate_sent_cash (NBD's labor-warranty years, the NBD Pledge,
 * Standard/Preferred/Elite), prequal_sent (the Acorn Finance marketplace) and
 * closed (the $100 referral bonus). Another company now gets the same
 * sentence without NBD's terms; NBD's emails are unchanged.
 * Loads the real email_system.js and builds real stage emails. Zero deps.
 * Run: node tests/email-tenant-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'email_system.js'), 'utf8');

async function build(brand, stage) {
  const win = { _brand: () => brand, _user: { displayName: 'Riley Rep' } };
  win.window = win;
  const sb = { window: win, document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    console: { log() {}, warn() {}, error() {} }, setTimeout, Date, Promise, JSON };
  vm.createContext(sb);
  vm.runInContext(SRC, sb, { filename: 'email_system.js' });
  sb.getLeadData = async () => ({ id: 'L1', firstName: 'Jane', lastName: 'Doe', email: 'jane@example.test', stage, _stageKey: stage, address: '12 Elm St', jobValue: 12000 });
  return win.emailSystem.buildStageEmail('L1');
}
const NBD = null; // no brand = NBD
const OAKS = { legalName: 'Oaks Roofing', contact: { phone: '(513) 555-0100' } };

(async function main() {
  console.log('STAGE EMAILS FOR ANOTHER COMPANY (VW-F151, VW-F152)');
  const nbdCash = await build(NBD, 'estimate_sent_cash');
  const oakCash = await build(OAKS, 'estimate_sent_cash');
  ok('both cash-estimate emails build (positive control)', !!nbdCash && !!oakCash && /Oaks Roofing/.test(oakCash.body), oakCash && oakCash.body.slice(0, 80));
  ok('NBD keeps its offer sentence', /the NBD Pledge/.test(nbdCash.body) && /up to 20 years/.test(nbdCash.body));
  ok('another company gets no NBD Pledge, warranty years or NBD package names', !/NBD Pledge|up to 20 years|Standard, Preferred, and Elite/.test(oakCash.body), oakCash.body);
  const nbdPre = await build(NBD, 'prequal_sent');
  const oakPre = await build(OAKS, 'prequal_sent');
  ok('NBD keeps Acorn Finance', /Acorn Finance/.test(nbdPre.body));
  ok('another company\'s financing email does not name Acorn Finance', !/Acorn Finance/.test(oakPre.body) && /rates and terms you qualify for/.test(oakPre.body));
  const nbdDone = await build(NBD, 'closed');
  const oakDone = await build(OAKS, 'closed');
  ok('NBD keeps the $100 referral bonus', /\$100 referral bonus/.test(nbdDone.body));
  ok('another company\'s thank-you does not promise NBD\'s $100 bonus, but still asks for referrals', !/\$100/.test(oakDone.body) && /appreciate the referral/.test(oakDone.body));
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
