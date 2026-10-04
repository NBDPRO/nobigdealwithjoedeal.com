/**
 * invoice-markpaid-stage.test.js — paying an invoice in full may move a lead
 * FORWARD to Contract Signed, never backward.
 *
 * Found in the 2026-09-28 CRM sweep (round 5): markPaid() wrote
 * stage:'contract_signed' on every payoff, so recording the final check on a
 * Closed job dragged it back to Contract Signed — out of won revenue and onto
 * the board as an active contract.
 *
 * Since 2026-10-03 (job spine) markPaid writes no stage at all: the server's
 * invoice trigger moves the lead for every payment method. This suite now
 * pins that the browser stays out of it.
 *
 * Behavioral: runs the real InvoicePipeline.markPaid against a fake Firestore
 * (window.doc/getDoc/updateDoc) and inspects the writes.
 *
 * Run: node tests/invoice-markpaid-stage.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

// Since R14 (2026-09-28) the payoff advance goes through stage-write.js's
// commitStageChange via a dynamic import(). Load BOTH real files: the real
// stage-write.js (exports stripped) is handed to invoice-pipeline.js in place
// of that import, exactly as edit-lead-stage-write-2026-09-28.test.js does.
const IP_SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'invoice-pipeline.js'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'stage-write.js'), 'utf8');

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
    // stage-write.js's plain-write fallback (no runTransaction here) + its note.
    db: {},
    serverTimestamp: () => 'SERVER_TS',
    arrayUnion: (x) => ({ arrayUnion: x }),
    addDoc: async (_c, data) => { writes.push({ path: 'notes/+', data }); },
  };
  const sw = new Function('window', SW_SRC.replace(/^export\s+/gm, '') + '\nreturn { commitStageChange };')(global.window);
  global.__stageWrite = sw;
  const src = IP_SRC.split("import('./stage-write.js')").join('Promise.resolve(global.__stageWrite)');
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'window', 'global', src)(mod, mod.exports, require, global.window, global);
  const IP = mod.exports;
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

  // 2026-10-03 (job spine): the browser writes NO stage on any payoff. The
  // invoice write is enough — the server's invoice trigger
  // (functions/money-paper.js → job-spine.js) moves the lead, the same way
  // for a card payoff and a Mark-Paid check/Zelle/cash payoff (it used to be
  // Contract Signed from here vs Final Payment from the Stripe webhook).
  // tests/job-spine-2026-10-03.test.js covers the server move.
  for (const stage of ['new', 'estimate_submitted', 'contract_signed']) {
    const { IP, writes } = setup(stage);
    await IP.markPaid('inv1', 1000, 'check');
    const leadWrite = writes.find(w => w.path === 'leads/lead1');
    ok(`a lead at "${stage}" is NOT moved from the browser on full payment (the server does it)`, !leadWrite,
      leadWrite ? 'wrote ' + JSON.stringify(leadWrite.data) : '');
    ok(`…no client stage note either (${stage})`, !writes.some(w => w.path === 'notes/+' && /Stage moved/.test(w.data.text)));
    ok(`…and the invoice is marked paid, which is what the server trigger acts on (${stage})`,
      writes.some(w => w.path === 'invoices/inv1' && w.data.status === 'paid'));
  }

  {
    const { IP, writes } = setup('new');
    await IP.markPaid('inv1', 400, 'check');
    ok('a partial payment never touches the lead', !writes.some(w => w.path === 'leads/lead1'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
