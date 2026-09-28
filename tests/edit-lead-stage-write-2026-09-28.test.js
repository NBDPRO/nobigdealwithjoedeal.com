/**
 * tests/edit-lead-stage-write-2026-09-28.test.js
 *
 * THE BUG: the Edit Lead modal's saveLead() (docs/pro/js/crm-leads.js) spread
 * `stage` straight into updateDoc. stage-write.js commitStageChange — "the ONE
 * safe way to change a lead's stage", used by the kanban and the customer
 * page — was bypassed, so a stage changed in the modal:
 *   - never reset stageStartedAt (days-in-stage, the bottleneck widget and the
 *     server's dormant-lead nudge read the lead's CREATION time),
 *   - never appended stageHistory or the "Stage moved to …" timeline note,
 *   - skipped the email drip and the stage-entry task,
 *   - ignored the destination's required fields: on the emulator an insurance
 *     lead went New → Closed with no warranty cert or COC filed.
 *
 * THE FIX: on an EDIT whose stage differs from the stored lead, saveLead
 * (1) refuses when the destination's required fields are missing (not for a
 * move to Lost — same exemption as the kanban), (2) saves every other field
 * WITHOUT stage/stageRole, then (3) moves the stage via commitStageChange.
 * Same-stage edits and new leads are unchanged (no gate, stage in payload).
 *
 * Runs the REAL crm-leads.js saveLead and the REAL stage-write.js
 * commitStageChange in one vm context. The only rewrite is crm-leads.js's
 * dynamic `import('./stage-write.js')`, pointed at that in-context copy (a vm
 * script has no module loader). Break-test: against main, the stage-change
 * cases go red.
 *
 * Zero deps. Run: node tests/edit-lead-stage-write-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const LEADS_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/crm-leads.js'), 'utf8');
const STAGE_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/stage-write.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function assert(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// opts: { editId, stored (the lead in window._leads), formStage, missing (array
// returned by missingRequiredFields), roleOf }
async function run(opts) {
  const el = (v) => ({ value: v, checked: false, style: {}, textContent: '', focus() {}, scrollIntoView() {}, addEventListener() {} });
  const fields = {
    lFname: el('Jane'), lAddr: el('1 Main St'), lEditId: el(opts.editId || ''),
    lStage: el(opts.formStage), lJobType: el('insurance'),
  };
  const shared = {};
  const document = {
    getElementById: (id) => fields[id] || shared[id] || (shared[id] = el('')),
    querySelector: (sel) => (sel === '#leadModal .msave' ? (shared.__btn = shared.__btn || { disabled: false, textContent: 'Save' }) : null),
    addEventListener() {}, dispatchEvent() {},
  };
  const rec = { saved: [], txUpdates: [], notes: [], toasts: [] };
  const roleOf = opts.roleOf || ((s) => (s === 'lost' ? 'lost' : 'active'));
  const win = {
    db: {}, updateDoc: async (ref, p) => { rec.txUpdates.push({ ref, p, plain: true }); },
    deleteDoc() {}, getDoc() {}, getDocs() {}, where() {}, orderBy() {}, query() {},
    doc: (db, col, id) => col + '/' + id,
    collection: (db, name) => name,
    addDoc: async (col, data) => { rec.notes.push(Object.assign({ col }, data)); return { id: 'n1' }; },
    serverTimestamp: () => 'SERVER_TS',
    arrayUnion: (x) => ({ arrayUnion: x }),
    runTransaction: async (db, fn) => fn({
      get: async () => ({ exists: () => true, data: () => ({ stage: opts.stored ? opts.stored.stage : undefined }) }),
      update: (ref, p) => { rec.txUpdates.push({ ref, p }); },
    }),
    stageRole: roleOf,
    normalizeStage: (s) => s,
    missingRequiredFields: () => (opts.missing || []),
    requiredFieldLabel: (f) => ({ warrantyCertFiledAt: 'Warranty Cert Filed', cocFiledAt: 'COC Filed' }[f] || f),
    _leads: opts.stored ? [opts.stored] : [],
    _currentUser: { email: 'rep@example.com' },
    _saveLead: async (data) => { rec.saved.push(data); return data.id || 'new-id'; },
  };
  const sandbox = {
    window: win, document, console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, CustomEvent: function () {},
    showToast: (m, k) => rec.toasts.push(k + ':' + m),
  };
  vm.createContext(sandbox);
  // The real stage-write.js, exports stripped, as an in-context object.
  vm.runInContext(STAGE_SRC.replace(/^export\s+/gm, '') + '\nglobalThis.__stageWrite = { commitStageChange };', sandbox, { filename: 'stage-write.js' });
  const leadsSrc = LEADS_SRC.split("import('./stage-write.js')").join('Promise.resolve(globalThis.__stageWrite)');
  vm.runInContext(leadsSrc, sandbox, { filename: 'crm-leads.js' });
  await sandbox.saveLead();
  rec.err = (shared.mErr && shared.mErr.textContent) || '';
  return rec;
}

(async () => {
  console.log('EDIT LEAD — a stage change goes through commitStageChange');

  {
    const r = await run({ editId: 'lead-1', stored: { id: 'lead-1', stage: 'new', jobType: 'insurance' }, formStage: 'contacted' });
    const tx = r.txUpdates[0] && r.txUpdates[0].p;
    assert('the other fields are saved', r.saved.length === 1 && r.saved[0].firstName === 'Jane');
    assert('…WITHOUT stage / stageRole in that write', r.saved[0] && !('stage' in r.saved[0]) && !('stageRole' in r.saved[0]));
    assert('the stage moves via the transaction to "contacted"', !!tx && tx.stage === 'contacted');
    assert('stageStartedAt is reset', !!tx && tx.stageStartedAt === 'SERVER_TS');
    assert('stageHistory gets new → contacted by the rep', !!tx && tx.stageHistory && tx.stageHistory.arrayUnion
      && tx.stageHistory.arrayUnion.from === 'new' && tx.stageHistory.arrayUnion.to === 'contacted' && tx.stageHistory.arrayUnion.user === 'rep@example.com');
    assert('a "Stage moved to" timeline note is written', r.notes.some((n) => n.col === 'notes' && n.type === 'stage_change'));
  }

  console.log('EDIT LEAD — the destination\'s required fields gate a stage change');
  {
    const r = await run({ editId: 'lead-1', stored: { id: 'lead-1', stage: 'new', jobType: 'insurance' }, formStage: 'closed', missing: ['warrantyCertFiledAt', 'cocFiledAt'] });
    assert('nothing is written', r.saved.length === 0 && r.txUpdates.length === 0);
    assert('the rep is told which fields, by label', /fill in: Warranty Cert Filed, COC Filed/.test(r.err), r.err);
  }
  {
    const r = await run({ editId: 'lead-1', stored: { id: 'lead-1', stage: 'contacted', jobType: 'insurance' }, formStage: 'lost', missing: ['whatever'] });
    const tx = r.txUpdates[0] && r.txUpdates[0].p;
    assert('a move to Lost is NOT gated (kanban exemption)', r.saved.length === 1 && !!tx && tx.stage === 'lost');
    assert('…and is recorded as a lost move (closedAt)', !!tx && tx.closedAt === 'SERVER_TS');
  }

  console.log('EDIT LEAD — unchanged paths');
  {
    const r = await run({ editId: 'lead-1', stored: { id: 'lead-1', stage: 'closed', jobType: 'insurance' }, formStage: 'closed', missing: ['warrantyCertFiledAt'] });
    assert('same-stage edit on a lead missing fields still saves (no gate)', r.saved.length === 1 && r.err === '');
    assert('…with stage in the payload and no stage transaction', r.saved[0].stage === 'closed' && r.txUpdates.length === 0);
  }
  {
    const r = await run({ editId: '', stored: null, formStage: 'new' });
    assert('a new lead saves its stage directly, no stage transaction', r.saved.length === 1 && r.saved[0].stage === 'new' && r.txUpdates.length === 0);
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
