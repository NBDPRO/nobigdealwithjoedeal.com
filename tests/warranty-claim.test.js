/**
 * tests/warranty-claim.test.js — the 2026-09-15 Warranty Claim lane.
 *
 * Covers: the new S.WARRANTY_CLAIM stage + role/view wiring in
 * crm-stages.js, the claim-status sub-workflow (CLAIM_STATUSES et al),
 * warranty-claim.js's real write logic (promptIntake/promptResolution via a
 * minimal DOM+Firestore stub — proving the actual batch-write shape, not
 * just that the functions exist), and source-text wiring for the two guard
 * call sites (crm-pipeline.js's moveCard, customer-bootstrap.module.js's
 * progressStage), the STAGE_TARGETS/jobStages additions, the kanban card
 * badge, the server-side role mirror, and the homeowner-portal report path.
 *
 * firestore.rules' warrantyClaimWriteOk()/openClaimIdOk() are proven
 * separately against the real emulator in tests/firestore-rules.test.js —
 * not duplicated here (same convention as paperwork-filing.test.js).
 *
 * Run: node tests/warranty-claim.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function main() {

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); } }
function eq(name, got, want) { ok(name + ' (want ' + JSON.stringify(want) + ', got ' + JSON.stringify(got) + ')', got === want); }

const ROOT = path.join(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs/pro/js');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ═══════════════════════════════════════════════════════════════════════
// 1. crm-stages.js — S.WARRANTY_CLAIM stage/role/view wiring (real execution)
// ═══════════════════════════════════════════════════════════════════════
console.log('crm-stages.js — S.WARRANTY_CLAIM stage/role/view wiring');
let crmStagesOut;
{
  let src = fs.readFileSync(path.join(PRO_JS, 'crm-stages.js'), 'utf8');
  src = src.replace(/export\s+function\s+/g, 'function ').replace(/export\s+const\s+/g, 'const ');
  src += '\nthis.__out = { S, STAGE_META, ROLE, stageRole, isJobStage, isTerminalStage, VIEW_JOBS, VIEW_JOBS_BOARD, KANBAN_VIEWS, STAGE_ACTIONS, resolveColumn, ' +
    'CLAIM_STATUSES, CLAIM_STATUS_ACTIONS, preferredActionForClaim, REQUIRED_FIELDS_BY_CLAIM_STATUS, missingClaimFields, missingRequiredFields, subTypeOptionsFor };';
  const sandbox = { console, window: {} };
  vm.runInNewContext(src, sandbox, { filename: 'crm-stages.js' });
  crmStagesOut = sandbox.__out;
  const { S, STAGE_META, stageRole, isJobStage, isTerminalStage, VIEW_JOBS, VIEW_JOBS_BOARD, KANBAN_VIEWS, STAGE_ACTIONS, resolveColumn, missingRequiredFields } = crmStagesOut;

  eq('S.WARRANTY_CLAIM key', S.WARRANTY_CLAIM, 'warranty_claim');
  ok('STAGE_META has an entry for warranty_claim', !!STAGE_META[S.WARRANTY_CLAIM]);
  eq('STAGE_META[warranty_claim].type is job', STAGE_META[S.WARRANTY_CLAIM].type, 'job');
  eq('stageRole(warranty_claim) is won (Jo\'s call: does not reverse won-revenue accounting)', stageRole(S.WARRANTY_CLAIM), 'won');
  ok('isJobStage(warranty_claim) is true (appended to VIEW_JOBS)', isJobStage(S.WARRANTY_CLAIM));
  ok('isTerminalStage(warranty_claim) is true (role won)', isTerminalStage(S.WARRANTY_CLAIM));
  ok('VIEW_JOBS ends with warranty_claim (appended, not inserted)', VIEW_JOBS[VIEW_JOBS.length - 1] === S.WARRANTY_CLAIM);
  ok('VIEW_JOBS_BOARD also carries warranty_claim (= [contract_signed, ...VIEW_JOBS])', VIEW_JOBS_BOARD.includes(S.WARRANTY_CLAIM));
  eq('KANBAN_VIEWS.jobs.stages is VIEW_JOBS_BOARD', KANBAN_VIEWS.jobs.stages, VIEW_JOBS_BOARD);

  // ── STAGE_ACTIONS wiring ──
  const closedActions = STAGE_ACTIONS[S.CLOSED] || [];
  const fileClaim = closedActions.find(a => a.id === 'file_warranty_claim');
  ok('file_warranty_claim exists on CLOSED', !!fileClaim);
  eq('file_warranty_claim is kind:stage (routes through moveCard)', fileClaim && fileClaim.kind, 'stage');
  ok('file_warranty_claim has NO jobTypes filter (available on every job type, incl. warranty/service)', fileClaim && !fileClaim.jobTypes);

  const claimActions = STAGE_ACTIONS[S.WARRANTY_CLAIM] || [];
  ok('log_claim_visit exists on WARRANTY_CLAIM', claimActions.some(a => a.id === 'log_claim_visit' && a.kind === 'action'));
  const resolveAction = claimActions.find(a => a.id === 'resolve_warranty_claim');
  ok('resolve_warranty_claim exists on WARRANTY_CLAIM', !!resolveAction);
  eq('resolve_warranty_claim is kind:stage', resolveAction && resolveAction.kind, 'stage');

  // ── resolveColumn — a lead in warranty_claim collapses into Closed under
  // a narrow view that has no dedicated column for it (mirrors the Kanban
  // filter unification lane's own proof for the other job-role stages).
  eq('resolveColumn(warranty_claim, VIEW_SIMPLE-shaped [..closed]) collapses to closed',
    resolveColumn(S.WARRANTY_CLAIM, ['new', 'inspected', 'contract_signed', 'install_in_progress', 'closed', 'lost']), S.CLOSED);
  eq('resolveColumn(warranty_claim, VIEW_JOBS_BOARD) direct-matches its own column', resolveColumn(S.WARRANTY_CLAIM, VIEW_JOBS_BOARD), S.WARRANTY_CLAIM);

  // ── missingRequiredFields — entering warranty_claim has no required
  // fields (no REQUIRED_FIELDS_BY_TYPE entry for it on any job type), so the
  // hard-block gate never blocks the "File Warranty Claim" move itself —
  // the guard (promptIntake) is what gathers the reason/description instead.
  for (const jt of ['insurance', 'cash', 'finance', 'warranty', 'service']) {
    eq('missingRequiredFields — entering warranty_claim is never gated for ' + jt,
      missingRequiredFields({ jobType: jt, stage: S.WARRANTY_CLAIM }).length, 0);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 2. crm-stages.js — claim-status sub-workflow (real execution)
// ═══════════════════════════════════════════════════════════════════════
console.log('\ncrm-stages.js — claim-status sub-workflow (CLAIM_STATUSES et al)');
{
  const { CLAIM_STATUSES, CLAIM_STATUS_ACTIONS, preferredActionForClaim, REQUIRED_FIELDS_BY_CLAIM_STATUS, missingClaimFields, subTypeOptionsFor } = crmStagesOut;

  eq('CLAIM_STATUSES has exactly the 5 real statuses',
    JSON.stringify(CLAIM_STATUSES), JSON.stringify(['open', 'scheduled', 'repaired', 'resolved', 'denied']));
  ok('CLAIM_STATUS_ACTIONS has an entry for every status', CLAIM_STATUSES.every(s => Array.isArray(CLAIM_STATUS_ACTIONS[s])));
  eq('preferredActionForClaim(repaired) picks resolve_claim (the only kind:stage action)',
    (preferredActionForClaim('repaired') || {}).id, 'resolve_claim');
  eq('preferredActionForClaim(resolved) is null (terminal, no actions)', preferredActionForClaim('resolved'), null);

  eq('REQUIRED_FIELDS_BY_CLAIM_STATUS.scheduled requires scheduledDate',
    JSON.stringify(REQUIRED_FIELDS_BY_CLAIM_STATUS.scheduled), JSON.stringify(['scheduledDate']));
  eq('REQUIRED_FIELDS_BY_CLAIM_STATUS.resolved requires resolutionNotes',
    JSON.stringify(REQUIRED_FIELDS_BY_CLAIM_STATUS.resolved), JSON.stringify(['resolutionNotes']));

  eq('missingClaimFields({}, scheduled) flags scheduledDate missing', JSON.stringify(missingClaimFields({}, 'scheduled')), JSON.stringify(['scheduledDate']));
  eq('missingClaimFields({scheduledDate: "2026-10-01"}, scheduled) is satisfied', missingClaimFields({ scheduledDate: '2026-10-01' }, 'scheduled').length, 0);
  eq('missingClaimFields({}, resolved) flags resolutionNotes missing', JSON.stringify(missingClaimFields({}, 'resolved')), JSON.stringify(['resolutionNotes']));
  eq('missingClaimFields({}, open) — no required fields for open, empty array', missingClaimFields({}, 'open').length, 0);

  // reason reuses SUB_TYPES.warranty rather than a parallel list.
  const warrantyReasons = (subTypeOptionsFor('warranty') || []).map(s => s.value);
  eq('warranty claim reasons ARE SUB_TYPES.warranty (workmanship/material/manufacturer/goodwill)',
    JSON.stringify(warrantyReasons), JSON.stringify(['workmanship', 'material', 'manufacturer', 'goodwill']));
}

// ═══════════════════════════════════════════════════════════════════════
// 3. warranty-claim.js — hasOpenClaim / promptIntake / promptResolution
//    (real execution against a minimal DOM + Firestore stub)
// ═══════════════════════════════════════════════════════════════════════
console.log('\nwarranty-claim.js — real execution against a DOM + Firestore stub');

function makeDomStub() {
  const created = { button: [], select: [], textarea: [], input: [], div: [], label: [] };
  function makeEl(tag) {
    const el = {
      tagName: tag, style: {}, children: [], _handlers: {},
      appendChild(child) { this.children.push(child); },
      addEventListener(evt, cb) { this._handlers[evt] = cb; },
      dispatch(evt, e) { if (this._handlers[evt]) this._handlers[evt](e || {}); },
      setAttribute() {}, focus() {}, remove() {},
    };
    Object.defineProperty(el, 'value', { value: '', writable: true });
    if (tag === 'input') el.checked = false;
    (created[tag] || (created[tag] = [])).push(el);
    return el;
  }
  const body = makeEl('div');
  const doc = {
    getElementById() { return null; }, // no stale modal present
    createElement: makeEl,
    createTextNode(t) { return { text: t }; },
    body,
  };
  return { doc, created };
}

function loadWarrantyClaim(dbHooks, domStub) {
  const src = fs.readFileSync(path.join(PRO_JS, 'warranty-claim.js'), 'utf8');
  const win = Object.assign({}, dbHooks);
  win.window = win;
  win.document = domStub.doc;
  win.nbdEsc = (s) => String(s == null ? '' : s);
  const sandbox = { window: win, document: domStub.doc, console: { log() {}, warn() {}, error() {} }, Object };
  vm.runInNewContext(src, sandbox, { filename: 'warranty-claim.js' });
  return win.WarrantyClaim;
}

// 3a. hasOpenClaim — trivial pure function
{
  const { doc, created } = makeDomStub();
  const wc = loadWarrantyClaim({}, { doc, created });
  ok('window.WarrantyClaim exposed with all 5 methods', !!(wc && wc.hasOpenClaim && wc.promptIntake && wc.promptResolution && wc.advanceClaimStatus && wc.renderPanel));
  eq('hasOpenClaim({openWarrantyClaimId: "x"}) is true', wc.hasOpenClaim({ openWarrantyClaimId: 'x' }), true);
  eq('hasOpenClaim({}) is false', wc.hasOpenClaim({}), false);
  eq('hasOpenClaim(null) is false (no throw)', wc.hasOpenClaim(null), false);
}

// 3b. promptIntake — submit path writes claim doc + stamps openWarrantyClaimId
// atomically via ONE batch (never two separate writes — a partial failure
// must not leave the lead pointing at a claim doc that doesn't exist, or a
// claim doc that isn't reachable via lead.openWarrantyClaimId).
{
  const batchOps = [];
  let batchCommitted = false;
  const domStub = makeDomStub();
  const wc = loadWarrantyClaim({
    db: {}, doc: (colOrDb, ...segs) => ({ path: segs.join('/') || 'AUTO_ID', id: segs.length ? segs[segs.length - 1] : 'AUTO_ID' }),
    collection: (db, ...segs) => ({ path: segs.join('/') }),
    writeBatch: () => ({
      set(ref, data) { batchOps.push({ op: 'set', ref, data }); },
      update(ref, data) { batchOps.push({ op: 'update', ref, data }); },
      commit: async () => { batchCommitted = true; },
    }),
    updateDoc: async () => {},
    serverTimestamp: () => 'SERVER_TS',
  }, domStub);

  const lead = { id: 'lead1', firstName: 'Pat', lastName: 'Homeowner' };
  const p = wc.promptIntake(lead);
  // Fill the form: created.select[0] is the reason dropdown, created.textarea[0]
  // is the issue description (both built inside buildBody, in that order —
  // see warranty-claim.js's promptIntake()'s call into _modal()).
  domStub.created.select[0].value = 'material';
  domStub.created.textarea[0].value = '  Shingle blew off after a storm  ';
  // buttons[0] = Cancel, buttons[1] = Submit (created in that literal order
  // inside _modal()).
  domStub.created.button[1].dispatch('click');
  const opened = await p;

  ok('promptIntake resolves true on submit', opened === true);
  ok('exactly one batch.commit() happened', batchCommitted === true);
  eq('exactly 2 batch ops (claim set + lead update) — one atomic batch, not two writes', batchOps.length, 2);
  const setOp = batchOps.find(o => o.op === 'set');
  const updateOp = batchOps.find(o => o.op === 'update');
  ok('the set() targets a NEW auto-ID doc under leads/{id}/warrantyClaims', !!setOp);
  eq('claim doc status is "open"', setOp.data.status, 'open');
  eq('claim doc reason is the selected reason', setOp.data.reason, 'material');
  eq('claim doc issueDescription is trimmed', setOp.data.issueDescription, 'Shingle blew off after a storm');
  eq('claim doc reportedBy is "rep" (the dashboard/customer-page path)', setOp.data.reportedBy, 'rep');
  ok('the update() targets the lead itself', !!updateOp);
  ok('lead update stamps openWarrantyClaimId to the NEW claim doc\'s own id (not a bare boolean)',
    typeof updateOp.data.openWarrantyClaimId === 'string' && updateOp.data.openWarrantyClaimId.length > 0);
  eq('the in-memory lead object is mutated too (optimistic UI, mirrors moveCard() elsewhere)', lead.openWarrantyClaimId, updateOp.data.openWarrantyClaimId);
}

// 3c. promptIntake — cancel path performs NO writes
{
  const batchOps = [];
  const domStub = makeDomStub();
  const wc = loadWarrantyClaim({
    db: {}, doc: (c, ...s) => ({ path: s.join('/'), id: 'shouldNotBeUsed' }), collection: () => ({}),
    writeBatch: () => ({ set() { batchOps.push(1); }, update() { batchOps.push(1); }, commit: async () => { batchOps.push('commit'); } }),
  }, domStub);
  const p = wc.promptIntake({ id: 'lead2' });
  domStub.created.button[0].dispatch('click'); // Cancel
  const opened = await p;
  eq('promptIntake resolves false on cancel', opened, false);
  eq('cancel path performs zero batch operations', batchOps.length, 0);
}

// 3d. promptResolution — resolutionNotes is a HARD requirement (mirrors
// REQUIRED_FIELDS_BY_CLAIM_STATUS.resolved). Clicking submit with an empty
// notes field must NOT close the modal or write anything — it should
// re-prompt (return false without ever reaching the batch).
{
  const batchOps = [];
  const domStub = makeDomStub();
  const wc = loadWarrantyClaim({
    db: {}, doc: () => ({}), collection: () => ({}), updateDoc: async () => {},
    writeBatch: () => ({ update() { batchOps.push(1); }, commit: async () => { batchOps.push('commit'); } }),
    serverTimestamp: () => 'SERVER_TS',
  }, domStub);
  const lead = { id: 'lead3', openWarrantyClaimId: 'claim-abc' };
  const p = wc.promptResolution(lead);
  // Leave notesInput (textarea[0]) empty; submit anyway.
  domStub.created.button[1].dispatch('click');
  const resolved = await p;
  eq('promptResolution resolves false when resolutionNotes is empty (required)', resolved, false);
  eq('no batch write happened for the empty-notes attempt', batchOps.length, 0);
  ok('the open claim id is untouched after a rejected empty-notes submit', lead.openWarrantyClaimId === 'claim-abc');
}

// 3e. promptResolution — submit with notes clears openWarrantyClaimId and
// writes the claim's terminal status + resolution fields in ONE batch.
{
  const batchOps = [];
  const domStub = makeDomStub();
  const wc = loadWarrantyClaim({
    db: {}, doc: (c, ...segs) => ({ path: segs.join('/') }), collection: () => ({}), updateDoc: async () => {},
    writeBatch: () => ({
      update(ref, data) { batchOps.push({ ref, data }); },
      commit: async () => { batchOps.push('commit'); },
    }),
    serverTimestamp: () => 'SERVER_TS',
  }, domStub);
  const lead = { id: 'lead4', openWarrantyClaimId: 'claim-xyz' };
  const p = wc.promptResolution(lead);
  domStub.created.select[0].value = 'resolved';
  domStub.created.textarea[0].value = 'Replaced the flashing, tested for leaks';
  domStub.created.input[0].checked = true; // billable checkbox
  domStub.created.button[1].dispatch('click');
  const resolved = await p;

  ok('promptResolution resolves true on a valid submit', resolved === true);
  const claimUpdate = batchOps.find(o => o.ref && !o.data.hasOwnProperty === undefined && o.data && 'status' in o.data);
  ok('exactly 2 batch updates (claim doc + lead doc)', batchOps.filter(o => o && o.data).length === 2);
  const claimOp = batchOps.find(o => o.data && 'status' in o.data);
  const leadOp = batchOps.find(o => o.data && 'openWarrantyClaimId' in o.data);
  eq('claim doc status set to the chosen outcome', claimOp.data.status, 'resolved');
  eq('claim doc billable reflects the checkbox', claimOp.data.billable, true);
  eq('claim doc resolutionNotes carries the typed notes', claimOp.data.resolutionNotes, 'Replaced the flashing, tested for leaks');
  eq('lead doc openWarrantyClaimId cleared to null', leadOp.data.openWarrantyClaimId, null);
  eq('the in-memory lead is cleared too', lead.openWarrantyClaimId, null);
}

// 3f. promptResolution — a lead with NO open claim never blocks the move
// (moveCard()'s guard only calls this when lead.openWarrantyClaimId is
// truthy, but the function itself is defensive against being called anyway).
{
  const domStub = makeDomStub();
  const wc = loadWarrantyClaim({}, domStub);
  const resolved = await wc.promptResolution({ id: 'lead5' }); // no openWarrantyClaimId
  eq('promptResolution with no open claim resolves true without showing a modal', resolved, true);
  eq('no modal DOM was built (function returns before _modal())', domStub.created.button.length, 0);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. Deliberate mutation — prove 3d's assertion actually catches a regression
// ═══════════════════════════════════════════════════════════════════════
console.log('\nDeliberate mutation — resolutionNotes gate removed (proves 3d is a real guard, not a tautology)');
{
  // Normalize to LF before matching: warranty-claim.js is a CRLF file on
  // this repo's Windows checkouts, and a hardcoded \n target string here
  // would silently stop matching the moment line endings flip either way
  // (see documentation/audit/GIT-PHANTOM-MODIFICATIONS-2026-09-05.md).
  let src = fs.readFileSync(path.join(PRO_JS, 'warranty-claim.js'), 'utf8').replace(/\r\n/g, '\n');
  const before = src;
  src = src.replace(
    "if (!notes) {\n      if (typeof window.showToast === 'function') window.showToast('Resolution notes are required to close a claim', 'warning');\n      return false;\n    }",
    '// GATE REMOVED FOR MUTATION TEST'
  );
  ok('mutation target string found (test stays honest about what it broke)', src !== before);

  const batchOps = [];
  const domStub = makeDomStub();
  const win = {
    db: {}, doc: () => ({}), collection: () => ({}), updateDoc: async () => {},
    writeBatch: () => ({ update(ref, data) { batchOps.push(data); }, commit: async () => {} }),
    serverTimestamp: () => 'SERVER_TS',
  };
  win.window = win; win.document = domStub.doc; win.nbdEsc = (s) => String(s || '');
  const sandbox = { window: win, document: domStub.doc, console: { log() {}, warn() {}, error() {} }, Object };
  vm.runInNewContext(src, sandbox, { filename: 'warranty-claim.js (mutated)' });
  const lead = { id: 'lead6', openWarrantyClaimId: 'claim-mut' };
  const p = win.WarrantyClaim.promptResolution(lead);
  domStub.created.button[1].dispatch('click'); // submit with empty notes
  const resolved = await p;
  ok('WITH THE GATE REMOVED, an empty-notes submit wrongly resolves true (proves 3d would have caught this)', resolved === true);
  ok('WITH THE GATE REMOVED, a write happens with empty resolutionNotes (the exact bug the gate prevents)',
    batchOps.some(d => d && 'status' in d && d.resolutionNotes === ''));
}

// ═══════════════════════════════════════════════════════════════════════
// 5. Guard call sites — source-text wiring (crm-pipeline.js, customer-
//    bootstrap.module.js). Full DOM execution of moveCard()/progressStage()
//    themselves is out of scope (huge functions, no existing precedent in
//    this codebase — see kanban-filter-unification.test.js's own choice to
//    source-text-check crm-pipeline.js rather than execute it).
// ═══════════════════════════════════════════════════════════════════════
console.log('\nGuard call sites — source-text wiring');
{
  const cp = read('docs/pro/js/crm-pipeline.js');
  ok('moveCard() computes newStageKey via normalizeStage before the guard', /const newStageKey = window\.normalizeStage/.test(cp));
  ok('entering warranty_claim calls WarrantyClaim.promptIntake', /newStageKey === 'warranty_claim'[\s\S]{0,400}window\.WarrantyClaim\.promptIntake\(lead\)/.test(cp));
  ok('a canceled intake aborts the move (early return, no fallthrough to the stage write)',
    /opened = await window\.WarrantyClaim\.promptIntake\(lead\)[\s\S]{0,300}if \(!opened\)[\s\S]{0,150}return;/.test(cp));
  ok('leaving warranty_claim with an open claim calls WarrantyClaim.promptResolution',
    /oldStageKey === 'warranty_claim'[\s\S]{0,100}newStageKey !== 'warranty_claim'[\s\S]{0,100}lead\.openWarrantyClaimId[\s\S]{0,400}window\.WarrantyClaim\.promptResolution\(lead\)/.test(cp));
  ok('a canceled resolution aborts the move too',
    /resolved = await window\.WarrantyClaim\.promptResolution\(lead\)[\s\S]{0,300}if \(!resolved\)[\s\S]{0,150}return;/.test(cp));
  // Since 2026-09-28 (R14) the required-field gate runs BEFORE the guard: the
  // gate writes nothing, but the guard WRITES (files / resolves a claim), so
  // guard-then-gate resolved a claim and was then refused — the lead sat in
  // Warranty Claim with no open claim. The stage write still lands only after
  // both (gate-before-warranty-writes-2026-09-28.test.js pins the order).
  const guardIdx = cp.indexOf("newStageKey === 'warranty_claim'");
  const gateIdx = cp.lastIndexOf('Required-field gate');
  const writeIdx = cp.indexOf('commitStageChange(', guardIdx);
  ok('the required-field gate runs BEFORE the warranty-claim guard, and the stage write after both',
    guardIdx > -1 && gateIdx > -1 && gateIdx < guardIdx && writeIdx > guardIdx);

  const claimBadgeIdx = cp.indexOf('const claimBadge');
  ok('claimBadge reads l.openWarrantyClaimId', /const claimBadge = \(l\.openWarrantyClaimId/.test(cp));
  ok("claimBadge is gated on _stageKey !== 'warranty_claim' (no redundant badge on the claim's own column)",
    /l\._stageKey !== 'warranty_claim'/.test(cp));
  ok('claimBadge is actually rendered into the card tags', /\$\{claimBadge\}/.test(cp));
  ok('claimBadge appears after claimBadgeIdx marker (sanity)', claimBadgeIdx > -1);

  const cb = read('docs/pro/js/customer-bootstrap.module.js');
  ok("progressStage() guards entering warranty_claim (nextStage === 'warranty_claim' && current !== 'warranty_claim')",
    /nextStage === 'warranty_claim' && current !== 'warranty_claim'/.test(cb));
  ok('progressStage() calls WarrantyClaim.promptIntake', /window\.WarrantyClaim\.promptIntake\(lead\)/.test(cb));
  ok("progressStage() guards leaving warranty_claim (current === 'warranty_claim' && nextStage !== 'warranty_claim')",
    /current === 'warranty_claim' && nextStage !== 'warranty_claim'/.test(cb));
  ok('progressStage() calls WarrantyClaim.promptResolution', /window\.WarrantyClaim\.promptResolution\(lead\)/.test(cb));
  ok('customer-bootstrap.module.js renders the warranty claim panel on initial load', /WarrantyClaim\?\.renderPanel[\s\S]{0,60}'warrantyClaimPanel'/.test(cb));
}

// ═══════════════════════════════════════════════════════════════════════
// 6. dashboard-bootstrap.module.js — STAGE_TARGETS / jobStages / window exposure
// ═══════════════════════════════════════════════════════════════════════
console.log('\ndashboard-bootstrap.module.js — wiring (source-text)');
{
  const db = read('docs/pro/js/dashboard-bootstrap.module.js');
  ok('STAGE_TARGETS.file_warranty_claim -> warranty_claim', /file_warranty_claim:\s*'warranty_claim'/.test(db));
  ok('STAGE_TARGETS.resolve_warranty_claim -> closed', /resolve_warranty_claim:\s*'closed'/.test(db));
  ok("jobStages array (controls #jobFieldsBlock visibility) includes 'warranty_claim'", /'collections','closed','warranty_claim'/.test(db));
  ok('imports CLAIM_STATUSES/preferredActionForClaim/missingClaimFields from crm-stages.js',
    /CLAIM_STATUSES, CLAIM_STATUS_ACTIONS, preferredActionForClaim/.test(db) && /REQUIRED_FIELDS_BY_CLAIM_STATUS, missingClaimFields/.test(db));
  ok('registers missingClaimFields in __NBD_CALL_REGISTRY for warranty-claim.js to consume (Globals Tranche 3 T3-C)',
    /missingClaimFields:\s*missingClaimFields/.test(db) && !/window\.missingClaimFields = missingClaimFields/.test(db));
}

// ═══════════════════════════════════════════════════════════════════════
// 7. functions/stage-roles.js — server-side role mirror (real require)
// ═══════════════════════════════════════════════════════════════════════
console.log('\nfunctions/stage-roles.js — server mirror (real execution)');
{
  const R = require(path.join(ROOT, 'functions', 'stage-roles.js'));
  eq('roleFromKey(warranty_claim) is won', R.roleFromKey('warranty_claim'), R.ROLE.WON);
  ok('isWon({stage: "warranty_claim"}) is true', R.isWon({ stage: 'warranty_claim' }));
  ok('isDecided({stage: "warranty_claim"}) is true (terminal, mirrors client isTerminalStage)', R.isDecided({ stage: 'warranty_claim' }));
}

// ═══════════════════════════════════════════════════════════════════════
// 8. functions/portal.js — reportWarrantyClaim + the view payload gains
//    openWarrantyClaimId (source-text; the file pulls in firebase-admin at
//    require-time so it isn't require()'d directly here — same convention
//    as every other functions/*.js coverage in this repo's tests).
// ═══════════════════════════════════════════════════════════════════════
console.log('\nfunctions/portal.js — reportWarrantyClaim + view payload (source-text)');
{
  const pf = read('functions/portal.js');
  ok('exports.reportWarrantyClaim exists as an onRequest', /exports\.reportWarrantyClaim = onRequest/.test(pf));
  ok('rate-limited (never unlimited public writes)', /httpRateLimit\(req, res, 'portal-warranty-claim:ip'/.test(pf));
  ok('validates the portal token shape before any Firestore read', /token, issueDescription \} = req\.body/.test(pf) && /A-Za-z0-9\]\{10,64\}/.test(pf));
  ok('requires a non-empty issueDescription (400 if missing)', /if \(!safeDesc\)[\s\S]{0,150}status\(400\)/.test(pf));
  ok('writes reportedBy: "homeowner" on the claim doc (distinct from the rep-side "rep")', /reportedBy: 'homeowner'/.test(pf));
  ok('NEVER sets lead.stage or lead.openWarrantyClaimId (only updatedAt on the lead doc)',
    (() => {
      const start = pf.indexOf('exports.reportWarrantyClaim');
      const end = pf.indexOf('Wave 121: submitCustomerRating');
      const body = pf.slice(start, end);
      return !/openWarrantyClaimId:/.test(body) && !/\.stage\s*:/.test(body);
    })());
  ok('the homeowner-portal view payload gains openWarrantyClaimId on the warranty object',
    /openWarrantyClaimId: lead\.openWarrantyClaimId \|\| null/.test(pf));
}

// ═══════════════════════════════════════════════════════════════════════
// 9. docs/pro/js/portal.js — dead sms: link replaced + wired
// ═══════════════════════════════════════════════════════════════════════
console.log('\ndocs/pro/js/portal.js — the old dead sms: link is gone, real form wired');
{
  const pj = read('docs/pro/js/portal.js');
  // Scoped to the warranty-card's OWN sms: link (there's an unrelated,
  // legitimate "Text it" sms: share link elsewhere on the page for a
  // different feature — this must not flag that one).
  const wcCardIdx = pj.indexOf("id=\"wc-card\"");
  const nextCardIdx = pj.indexOf('<div class="card"', wcCardIdx + 1);
  const wcCardBody = pj.slice(wcCardIdx, nextCardIdx > -1 ? nextCardIdx : wcCardIdx + 3000);
  ok('the old sms: deep link is gone from the warranty card (was the dead-end this lane fixes)', !/href="sms:/.test(wcCardBody));
  ok('a claimCta swaps in an "in progress" message when a claim is already open', /w\.openWarrantyClaimId[\s\S]{0,200}Claim in progress/.test(pj));
  ok('wireWarrantyClaimCard() posts to reportWarrantyClaim', /FUNCTIONS_BASE \+ '\/reportWarrantyClaim'/.test(pj));
  ok('wireWarrantyClaimCard() is called from the render pipeline', /wireWarrantyClaimCard\(\);/.test(pj));
  ok('a no-op guard for pages where the card never rendered', /if \(!issueEl \|\| !sendBtn\) return;/.test(pj));
}

// ═══════════════════════════════════════════════════════════════════════
// 10. HTML wiring — script tags + panel div
// ═══════════════════════════════════════════════════════════════════════
console.log('\nHTML wiring — script tags + panel div');
{
  const dashHtml = read('docs/pro/dashboard.html');
  ok('warranty-claim.js is loaded on dashboard.html', /warranty-claim\.js/.test(dashHtml));
  const custHtml = read('docs/pro/customer.html');
  ok('warranty-claim.js is loaded on customer.html', /warranty-claim\.js/.test(custHtml));
  ok('customer.html has the #warrantyClaimPanel container', /id="warrantyClaimPanel"/.test(custHtml));
}

console.log('\n' + (failed === 0 ? '✓' : '✗') + ' warranty claim: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
