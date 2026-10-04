/**
 * tests/gate-before-warranty-writes-2026-09-28.test.js
 *
 * CRM sweep R14 (emulator, 2026-09-28).
 *
 * BUG 1: moveCard (crm-pipeline.js) and progressStage (customer page) run the
 * warranty-claim guard — which WRITES (files a claim / resolves one) — BEFORE
 * the destination's required-field gate. Emulator: moving a Warranty Claim
 * lead back to Closed resolved the claim, then the gate refused the move
 * (Closed needs the warranty-cert + COC dates) — the lead sat in Warranty
 * Claim with no open claim behind it. FIX: gate first, then the guard.
 *
 * BUG 2: the customer page's gate offers "Open full editor", which went to
 * /pro/dashboard?lead=ID — the NEW-ESTIMATE deep link (a blank Estimate
 * Builder). FIX: ?edit=ID.
 *
 * BUG 3: ?edit=ID ran editLead after a fixed 500 ms; before the lead cache
 * loaded, editLead fell through to a BLANK new-lead form (a save = duplicate).
 * FIX: wait for window._leadsLoaded, else open the customer page.
 *
 * Order checks run on the real function bodies (the bug was purely which
 * block runs first). Break-test: against main these go red.
 *
 * Zero deps. Run: node tests/gate-before-warranty-writes-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const PIPE = read('docs/pro/js/crm-pipeline.js');
const CUST = read('docs/pro/js/customer-bootstrap.module.js');
const DASH = read('docs/pro/js/dashboard-bootstrap.module.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function body(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return '';
  const open = src.indexOf('{', start + sig.length - 1);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

console.log('KANBAN moveCard — check before write');
{
  const mc = body(PIPE, 'async function moveCard(id, newStage, opts){');
  const gate = mc.indexOf('window.missingRequiredFields({ ...lead, stage: newStage })');
  const intake = mc.indexOf('window.WarrantyClaim.promptIntake(lead)');
  const resolve = mc.indexOf('window.WarrantyClaim.promptResolution(lead)');
  ok('moveCard found with gate + both warranty writers', mc && gate > 0 && intake > 0 && resolve > 0);
  ok('the required-field gate runs before the warranty claim is filed', gate < intake, gate + ' vs ' + intake);
  ok('…and before a claim is resolved', gate < resolve, gate + ' vs ' + resolve);
}

console.log('CUSTOMER PAGE progressStage — check before write');
{
  const start = CUST.indexOf('window.progressStage = async function()');
  const ps = start >= 0 ? CUST.slice(start, start + 12000) : '';
  const gate = ps.indexOf('_missingRequiredFields({ ...(window._currentLead || {}), stage: nextStage })');
  const intake = ps.indexOf('window.WarrantyClaim.promptIntake(lead)');
  const resolve = ps.indexOf('window.WarrantyClaim.promptResolution(lead)');
  ok('progressStage found with gate + both warranty writers', ps && gate > 0 && intake > 0 && resolve > 0);
  ok('the required-field gate runs before the claim is filed / resolved', gate < intake && gate < resolve, [gate, intake, resolve].join(' / '));
  // 2026-10-03: the gate opens the inline stage-gate sheet instead of leaving
  // the page, so there is no deep link left to get wrong.
  ok('the gate never navigates away (no ?lead= / ?edit= link) — it opens the stage-gate sheet first',
    /sheet\.open\(\{/.test(ps) && !/\/pro\/dashboard\?lead=' \+ window\._customerId; \}/.test(ps)
      && ps.indexOf('sheet.open({') < intake);
}

console.log('DASHBOARD ?edit= deep link');
{
  const i = DASH.indexOf('// ── EDIT LEAD in CRM ──');
  const block = i > 0 ? DASH.slice(i, DASH.indexOf('} else if (', i)) : '';
  ok('waits for the lead cache before editLead', /_leadsLoaded !== true/.test(block) && /editLead\(editId\)/.test(block));
  ok('no fixed-delay editLead', !/setTimeout\(\(\) => \{\s*goTo\('crm'\);\s*editLead\(editId\);/.test(block));
  ok('an unknown lead opens its customer page instead of a blank form', /customer\.html\?id=' \+ encodeURIComponent\(editId\)/.test(block));
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
