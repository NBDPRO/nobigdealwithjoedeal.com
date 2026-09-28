/**
 * invoice-markpaid-stage.test.js — paying an invoice in full may move a lead
 * FORWARD to Contract Signed, never backward.
 *
 * Found in the 2026-09-28 CRM sweep (round 5): markPaid() wrote
 * stage:'contract_signed' on every payoff, so recording the final check on a
 * Closed job dragged it back to Contract Signed — out of won revenue and onto
 * the board as an active contract.
 *
 * Behavioral: runs the real InvoicePipeline.markPaid against a fake Firestore
 * (window.doc/getDoc/updateDoc) and inspects the writes.
 *
 * Run: node tests/invoice-markpaid-stage.test.js
 */
'use strict';

const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const ROLE = { new: 'new', contacted: 'active', inspected: 'active', estimate_submitted: 'active',
  contract_signed: 'active', install_in_progress: 'job', closed: 'won', install_complete: 'won', lost: 'lost' };
const JOB = new Set(['contract_signed', 'job_created', 'install_in_progress']);

function setup(leadStage) {
  const writes = [];
  const docs = {
    'invoices/inv1': { total: 1000, amountPaid: 0, depositAmount: 500, status: 'sent', leadId: 'lead1', payments: [] },
    'leads/lead1': { stage: leadStage },
  };
  global.window = {
    _db: {},
    _leads: [{ id: 'lead1', stage: leadStage }],
    collection: () => ({}),
    doc: (_db, col, id) => ({ path: col + '/' + id }),
    getDoc: async (ref) => ({ exists: () => ref.path in docs, data: () => docs[ref.path] }),
    updateDoc: async (ref, data) => { writes.push({ path: ref.path, data }); },
    stageRole: (k) => ROLE[k] || 'active',
    isJobStage: (k) => JOB.has(k),
  };
  delete require.cache[require.resolve(path.join('..', 'docs', 'pro', 'js', 'invoice-pipeline.js'))];
  const IP = require(path.join('..', 'docs', 'pro', 'js', 'invoice-pipeline.js'));
  return { IP, writes };
}

(async () => {
  console.log('\ninvoice markPaid — lead stage only moves forward\n');

  for (const stage of ['closed', 'install_complete', 'install_in_progress', 'lost']) {
    const { IP, writes } = setup(stage);
    await IP.markPaid('inv1', 1000, 'check');
    const leadWrite = writes.find(w => w.path === 'leads/lead1');
    ok(`a lead at "${stage}" is not moved by a full payment`, !leadWrite,
      leadWrite ? 'wrote ' + JSON.stringify(leadWrite.data) : '');
    ok(`…and the invoice is still marked paid (${stage})`,
      writes.some(w => w.path === 'invoices/inv1' && w.data.status === 'paid'));
  }

  for (const stage of ['new', 'estimate_submitted']) {
    const { IP, writes } = setup(stage);
    await IP.markPaid('inv1', 1000, 'check');
    const leadWrite = writes.find(w => w.path === 'leads/lead1');
    ok(`a lead at "${stage}" advances to contract_signed on full payment`,
      !!leadWrite && leadWrite.data.stage === 'contract_signed');
  }

  {
    const { IP, writes } = setup('new');
    await IP.markPaid('inv1', 400, 'check');
    ok('a partial payment never touches the lead', !writes.some(w => w.path === 'leads/lead1'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
