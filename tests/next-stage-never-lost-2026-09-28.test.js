/**
 * tests/next-stage-never-lost-2026-09-28.test.js
 *
 * CRM sweep R14 (emulator, 2026-09-28) — "next stage" must never mean Lost.
 *
 * THE BUG: Lost sorts last in every pipeline view, and both "advance" controls
 * took whatever key came next:
 *  - the kanban card ▶ arrow (crm-pipeline.js): the last working column's
 *    card read "→ Lost" — on the stock Insurance board that is Contract
 *    Signed; after adding a custom stage it was the custom stage's card;
 *  - customer.html "→ Move to Next Stage" (customer-bootstrap _nextStageFor):
 *    a lead on a custom stage added after Lost offered "→ Move to Lost".
 * One tap toward losing a job, labelled as progress.
 *
 * THE FIX: both skip lost-role stages; nothing after → no next control.
 *
 * Runs the REAL _nextStageFor and the REAL kanban next-arrow block, lifted
 * out of their files into a vm. Break-test: against main these go red.
 *
 * Zero deps. Run: node tests/next-stage-never-lost-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const BOOT = read('docs/pro/js/customer-bootstrap.module.js');
const PIPE = read('docs/pro/js/crm-pipeline.js');

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

const ROLE = { new: 'new', contacted: 'active', contract_signed: 'active', custom_tearoff: 'job', lost: 'lost', closed: 'won' };
const stageRole = (k) => ROLE[k] || 'active';

console.log('CUSTOMER PAGE — _nextStageFor');
{
  const fn = extractFn(BOOT, 'function _nextStageFor(');
  ok('_nextStageFor found', !!fn);
  const pipeline = ['new', 'contacted', 'contract_signed', 'lost', 'custom_tearoff'];
  const meta = { custom_tearoff: { label: 'Tear-off', role: 'job' }, lost: { label: 'Lost', role: 'lost' }, contract_signed: { label: 'Contract Signed' } };
  const ctx = vm.createContext({
    window: { stageRole },
    _pipelineFor: () => ({ pipeline, resolved: { stageMeta: meta } }),
    _stageLabel: (k) => k,
  });
  vm.runInContext(fn + '\nglobalThis.f = _nextStageFor;', ctx);
  const n1 = ctx.f({ stage: 'contract_signed' });
  ok('Contract Signed → the custom stage, skipping the Lost that sits between', n1 && n1.nextStage === 'custom_tearoff', JSON.stringify(n1 && n1.nextStage));
  const n2 = ctx.f({ stage: 'custom_tearoff' });
  ok('the last working stage has NO next (was "→ Move to Lost")', n2 === null, JSON.stringify(n2 && n2.nextStage));
  const n3 = ctx.f({ stage: 'new' });
  ok('ordinary progression is unchanged (New → Contacted)', n3 && n3.nextStage === 'contacted');
}

console.log('KANBAN CARD — ▶ arrow');
{
  const start = PIPE.indexOf('  const stageIdx = _keys.indexOf(_sk);');
  const end = PIPE.indexOf('  const prevLabel', start);
  const block = start > 0 && end > start ? PIPE.slice(start, end) : '';
  ok('next-arrow block found', !!block);
  const run = (keys, sk) => {
    const ctx = vm.createContext({ window: { stageRole }, _keys: keys, _sk: sk });
    vm.runInContext(block + '\nglobalThis.r = { prevS, nextS };', ctx);
    return ctx.r;
  };
  const stock = ['new', 'contacted', 'contract_signed', 'lost'];
  ok('stock board: Contract Signed has NO ▶ (was "→ Lost")', run(stock, 'contract_signed').nextS === null, JSON.stringify(run(stock, 'contract_signed')));
  const custom = ['new', 'contacted', 'contract_signed', 'custom_tearoff', 'lost'];
  ok('custom stage last before Lost: no ▶', run(custom, 'custom_tearoff').nextS === null);
  ok('Contract Signed → the custom stage', run(custom, 'contract_signed').nextS === 'custom_tearoff');
  ok('◀ from Lost still steps back (un-losing stays one tap)', run(stock, 'lost').prevS === 'contract_signed');
}

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
