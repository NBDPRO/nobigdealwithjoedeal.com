/**
 * tests/customer-pipeline-order-warranty-reasons-2026-09-28.test.js
 *
 * CRM sweep R14 (emulator, 2026-09-28) — customer.html's stage pipeline and
 * the warranty-claim intake.
 *
 * BUG 1: customer-bootstrap _pipelineFor splices the job track in right
 * after Contract Signed. A custom stage the pipeline builder placed after
 * Contract Signed (before Lost) was pushed past the whole job + warranty
 * track, so a Warranty Claim lead was offered "→ Move to <custom production
 * stage>". FIX: insert the job track at the first lost-role stage instead.
 *
 * BUG 2: warranty-claim.js builds the claim "Reason" list from
 * __NBD_CALL_REGISTRY.subTypeOptionsFor, which only the dashboard
 * registered — filing a claim from the customer page offered just
 * "Workmanship". FIX: the customer page registers it too.
 *
 * Runs the REAL _pipelineFor in a vm; checks the registration.
 * Break-test: against main these go red.
 *
 * Zero deps. Run: node tests/customer-pipeline-order-warranty-reasons-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BOOT = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/customer-bootstrap.module.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function extractFn(src, sig) {
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

const JOBS = ['job_created', 'install_in_progress', 'closed', 'warranty_claim'];
const META = { lost: { role: 'lost' }, custom_tearoff: { role: 'job', label: 'Tear-off' } };
function pipelineFor(salesStages) {
  const ctx = vm.createContext({
    window: { _companyProfile: { pipelines: {} } },
    _resolvePipelineConfig: () => ({ views: { insurance: { stages: salesStages }, jobs: { stages: JOBS } }, stageMeta: META }),
    _stageRole: (k) => (k === 'lost' ? 'lost' : 'active'),
  });
  vm.runInContext(extractFn(BOOT, 'function _pipelineFor(') + '\nglobalThis.f = _pipelineFor;', ctx);
  return ctx.f({ jobType: 'insurance' }).pipeline;
}

console.log('CUSTOMER PAGE — pipeline order');
{
  const p = pipelineFor(['new', 'contract_signed', 'custom_tearoff', 'lost']);
  ok('a custom stage placed after Contract Signed stays there (before the job track)',
    p.indexOf('custom_tearoff') === p.indexOf('contract_signed') + 1 && p.indexOf('job_created') === p.indexOf('custom_tearoff') + 1, JSON.stringify(p));
  ok('…so Warranty Claim is not followed by the custom production stage', p[p.indexOf('warranty_claim') + 1] !== 'custom_tearoff', JSON.stringify(p));
  ok('Lost stays last', p[p.length - 1] === 'lost');
}
{
  const p = pipelineFor(['new', 'contract_signed', 'lost']);
  ok('stock pipeline unchanged: job track right after Contract Signed', JSON.stringify(p) === JSON.stringify(['new', 'contract_signed', ...JOBS, 'lost']), JSON.stringify(p));
}

console.log('CUSTOMER PAGE — warranty claim reasons');
ok('imports subTypeOptionsFor from crm-stages.js', /subTypeOptionsFor as _subTypeOptionsFor,\n\} from "\.\/crm-stages\.js";/.test(BOOT));
ok('registers it where warranty-claim.js looks (__NBD_CALL_REGISTRY)', /Object\.assign\(window\.__NBD_CALL_REGISTRY, \{[\s\S]*?subTypeOptionsFor: _subTypeOptionsFor,[\s\S]*?\}\);/.test(BOOT));

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
