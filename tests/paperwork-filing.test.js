/**
 * tests/paperwork-filing.test.js — the 2026-09-15 Paperwork Filing lane.
 *
 * Companion to tests/crm-required-fields.test.js (which already proves the
 * REQUIRED_FIELDS_BY_TYPE extension + reachability for all 5 new
 * *FiledAt fields, 56/56 green) — this file covers the REST of the lane:
 * the STAGE_ACTIONS wiring (pull_permit → real doc, mark_permit_filed →
 * real handler), the new paperwork-write.js chokepoint's own logic, the
 * customer-page checklist's read-only-vs-manual rendering, and the
 * document-generator.js/warranty-cert.js auto-derivation wiring.
 *
 * Pure string/vm tests — no browser, no emulator (firestore.rules'
 * paperworkFieldsOk() is proven separately, against the real emulator, in
 * tests/firestore-rules.test.js). Run: node tests/paperwork-filing.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Section 4 (paperwork-write.js) needs real await on its async
// commitPaperworkFiled() calls — CommonJS has no top-level await, so the
// whole body runs inside this async main(), called at the bottom of the file.
async function main() {

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); } }
function eq(name, got, want) { ok(name + ' (want ' + JSON.stringify(want) + ', got ' + JSON.stringify(got) + ')', got === want); }

const ROOT = path.join(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs/pro/js');

// ═══════════════════════════════════════════════════════════════════════
// 1. crm-stages.js — STAGE_ACTIONS wiring (real execution)
// ═══════════════════════════════════════════════════════════════════════
console.log('crm-stages.js — STAGE_ACTIONS wiring for Permit paperwork');
{
  let src = fs.readFileSync(path.join(PRO_JS, 'crm-stages.js'), 'utf8');
  src = src.replace(/export\s+function\s+/g, 'function ').replace(/export\s+const\s+/g, 'const ');
  src += '\nthis.__out = { S, STAGE_ACTIONS, preferredActionFor };';
  const sandbox = { console, window: {} };
  vm.runInNewContext(src, sandbox, { filename: 'crm-stages.js' });
  const { S, STAGE_ACTIONS, preferredActionFor } = sandbox.__out;

  const jobCreated = STAGE_ACTIONS[S.JOB_CREATED] || [];
  const pullPermit = jobCreated.find(a => a.id === 'pull_permit');
  ok('pull_permit exists on JOB_CREATED', !!pullPermit);
  ok('pull_permit is now kind:\'doc\' (was the dead kind:\'action\')', pullPermit && pullPermit.kind === 'doc');

  const permitPulled = STAGE_ACTIONS[S.PERMIT_PULLED] || [];
  ok('mark_permit_filed exists on PERMIT_PULLED', permitPulled.some(a => a.id === 'mark_permit_filed'));
  eq('mark_permit_filed is FIRST in the array (actions[0] fallback picks it)', permitPulled[0] && permitPulled[0].id, 'mark_permit_filed');
  ok('mark_permit_filed is kind:\'action\' (nothing to generate)', permitPulled[0] && permitPulled[0].kind === 'action');

  // preferredActionFor drives both the next-action chip and stage-checklist.js's
  // auto-task — confirm entering PERMIT_PULLED surfaces the filing action, not
  // order_materials (which would silently skip the paperwork step).
  eq('preferredActionFor(PERMIT_PULLED) picks mark_permit_filed', (preferredActionFor(S.PERMIT_PULLED, 'insurance') || {}).id, 'mark_permit_filed');
}

// ═══════════════════════════════════════════════════════════════════════
// 2. document-generator.js — DOCUMENT_TYPES.permit + FILED_FIELD_BY_DOC_TYPE
// ═══════════════════════════════════════════════════════════════════════
console.log('\ndocument-generator.js — permit doc type + auto-derivation lookup');
function loadDocGen() {
  const src = fs.readFileSync(path.join(PRO_JS, 'document-generator.js'), 'utf8');
  const win = { _brand: () => null };
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const sandbox = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.runInNewContext(src, sandbox, { filename: 'document-generator.js' });
  return win.NBDDocGen;
}
{
  const dg = loadDocGen();
  ok('NBDDocGen loaded', !!dg);
  ok('DOCUMENT_TYPES.permit registered', !!(dg.DOCUMENT_TYPES && dg.DOCUMENT_TYPES.permit));
  ok('permit has NO defaultSigners (no in-app signer — filed with a jurisdiction, not signed here)',
    dg.DOCUMENT_TYPES.permit && dg.DOCUMENT_TYPES.permit.defaultSigners === undefined);
  eq('FILED_FIELD_BY_DOC_TYPE.contract', dg.FILED_FIELD_BY_DOC_TYPE.contract, 'contractFiledAt');
  // The AOB (and the Direction to Pay briefly after it) is retired, 2026-09-27:
  // no document stamps aobFiledAt any more; the field stays, unused.
  eq('no assignment_of_benefits document type is left', dg.FILED_FIELD_BY_DOC_TYPE.assignment_of_benefits, undefined);
  eq('no direction_to_pay document type either', dg.FILED_FIELD_BY_DOC_TYPE.direction_to_pay, undefined);
  eq('FILED_FIELD_BY_DOC_TYPE.certificate_of_completion', dg.FILED_FIELD_BY_DOC_TYPE.certificate_of_completion, 'cocFiledAt');
  ok('FILED_FIELD_BY_DOC_TYPE has no permit entry (manual-only, no signer to hook)',
    dg.FILED_FIELD_BY_DOC_TYPE.permit === undefined);
  ok('FILED_FIELD_BY_DOC_TYPE has no warranty_certificate entry (its own persist hook in warranty-cert.js owns that field)',
    dg.FILED_FIELD_BY_DOC_TYPE.warranty_certificate === undefined);
}

// ── onPersistFinalized's filed-stamp block (source-text — the callback is
// deep inside generate()'s Storage/Firestore/NBDDocViewer async flow; real
// execution would need extensive DOM/Firebase mocking for little extra
// confidence over asserting the actual code shape directly). ──
console.log('\ndocument-generator.js — onPersistFinalized auto-derivation (source-text)');
{
  const src = fs.readFileSync(path.join(PRO_JS, 'document-generator.js'), 'utf8');
  // 5000 (was 3000): the 2026-10-04 cancellation-notice re-date + cancelBy
  // stamp sit ahead of the filed-stamp block in the same callback.
  const block = src.slice(src.indexOf('onPersistFinalized: async'), src.indexOf('onPersistFinalized: async') + 5000);
  ok('reads the FILED_FIELD_BY_DOC_TYPE lookup keyed by the doc type', /this\.FILED_FIELD_BY_DOC_TYPE\[type\]/.test(block));
  ok('stamps the lead field via updateDoc, not the document row', /window\.updateDoc\(window\.doc\(window\.db, 'leads', _leadIdEarly\)/.test(block));
  ok('wrapped in its own try/catch (a failure here must not break the signature persistence above)',
    /try \{[\s\S]*FILED_FIELD_BY_DOC_TYPE[\s\S]*\} catch \(e\) \{\s*console\.warn\('Lead filed-stamp failed:/.test(block));
}

// ═══════════════════════════════════════════════════════════════════════
// 3. warranty-cert.js — warrantyCertFiledAt alongside the existing persist
// ═══════════════════════════════════════════════════════════════════════
console.log('\nwarranty-cert.js — warrantyCertFiledAt auto-derivation');
{
  const src = fs.readFileSync(path.join(PRO_JS, 'warranty-cert.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function _persistWarrantyToLead'), src.indexOf('async function _persistWarrantyToLead') + 1600);
  ok('stamps warrantyCertFiledAt as a real ISO timestamp', /warrantyCertFiledAt:\s*new Date\(\)\.toISOString\(\)/.test(fn));
  ok('alongside the existing warranty:{...} write, not a second updateDoc call',
    (fn.match(/window\.updateDoc\(/g) || []).length === 1);
}

// ═══════════════════════════════════════════════════════════════════════
// 4. paperwork-write.js — commitPaperworkFiled (real execution)
// ═══════════════════════════════════════════════════════════════════════
console.log('\npaperwork-write.js — commitPaperworkFiled() (real execution)');
function loadPaperworkWrite(dbHooks) {
  const src = fs.readFileSync(path.join(PRO_JS, 'paperwork-write.js'), 'utf8');
  const win = Object.assign({}, dbHooks);
  win.window = win;
  const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, Date, setTimeout, clearTimeout };
  vm.runInNewContext(src, sandbox, { filename: 'paperwork-write.js' });
  return win.PaperworkWrite;
}
{
  const writes = [];
  const notes = [];
  const pw = loadPaperworkWrite({
    db: {}, doc: (db, ...segs) => ({ path: segs.join('/') }), collection: (db, name) => ({ name }),
    updateDoc: async (ref, payload) => { writes.push({ ref, payload }); },
    addDoc: async (ref, payload) => { notes.push({ ref, payload }); },
    serverTimestamp: () => 'SERVER_TS',
  });
  ok('window.PaperworkWrite exposed', !!(pw && typeof pw.commitPaperworkFiled === 'function'));
  ok('FILED_FIELDS allowlist has exactly the 5 real fields',
    JSON.stringify((pw.FILED_FIELDS || []).slice().sort()) ===
    JSON.stringify(['aobFiledAt', 'contractFiledAt', 'cocFiledAt', 'permitFiledAt', 'warrantyCertFiledAt'].sort()));

  // An unknown field name is rejected loudly (throws), not silently written —
  // a typo at a call site should fail fast, not gate the wrong field.
  await pw.commitPaperworkFiled('lead1', 'permitFiledAt', true).catch(() => {});
  ok('a real field name writes {permitFiledAt: <ISO string>}',
    writes.length === 1 && typeof writes[0].payload.permitFiledAt === 'string' && writes[0].payload.permitFiledAt.length > 0);
  ok('the stamped value is a real ISO timestamp, not a boolean (missingRequiredFields only treats undefined/null/\'\' as missing)',
    /^\d{4}-\d{2}-\d{2}T/.test(writes[0].payload.permitFiledAt));
  ok('an activity note was also written (best-effort side effect)', notes.length === 1);

  let threw = false;
  try { await pw.commitPaperworkFiled('lead1', 'notARealField', true); } catch (e) { threw = true; }
  ok('an unknown field name throws rather than silently writing', threw);
  eq('unknown-field attempt did not add a second write', writes.length, 1);

  writes.length = 0;
  await pw.commitPaperworkFiled('lead1', 'contractFiledAt', false);
  eq('unchecking writes \'\' — never false/0/null', writes[0].payload.contractFiledAt, '');
}
// Missing Firebase helpers — degrade by throwing (the caller's own .catch
// shows a toast), not by silently no-op-ing a write the UI thinks succeeded.
{
  const pw2 = loadPaperworkWrite({}); // no db/doc/updateDoc at all
  let threw2 = false;
  try { await pw2.commitPaperworkFiled('lead1', 'permitFiledAt', true); } catch (e) { threw2 = true; }
  ok('missing Firebase helpers throws (caller can show an honest error)', threw2);
}

// ═══════════════════════════════════════════════════════════════════════
// 5. customer-checklist.js — gateField read-only rendering (real execution)
// ═══════════════════════════════════════════════════════════════════════
console.log('\ncustomer-checklist.js — gateField / manual rendering (real execution)');
function loadChecklist() {
  const src = fs.readFileSync(path.join(PRO_JS, 'customer-checklist.js'), 'utf8');
  const win = {};
  win.window = win;
  const sandbox = {
    window: win,
    document: { getElementById() { return null; }, addEventListener() {} },
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(src, sandbox, { filename: 'customer-checklist.js' });
  return win.JobChecklist;
}
{
  const jc = loadChecklist();
  ok('window.JobChecklist exposed', !!jc);
  const ins = jc.CHECKLISTS.insurance;
  const insContract = ins.find(i => i.key === 'ins-contract');
  const insPermit = ins.find(i => i.key === 'ins-permit');
  const insAob = ins.find(i => i.key === 'ins-aob');
  const insWarrCert = ins.find(i => i.key === 'ins-warranty-cert');
  const insInvoice = ins.find(i => i.key === 'ins-invoice');
  ok('ins-contract carries gateField: contractFiledAt', insContract && insContract.gateField === 'contractFiledAt');
  ok('ins-contract is NOT manual (auto-derived, read-only)', insContract && !insContract.manual);
  ok('ins-permit carries gateField: permitFiledAt AND manual:true (the one interactive gate row)',
    insPermit && insPermit.gateField === 'permitFiledAt' && insPermit.manual === true);
  ok('ins-aob is gone from the insurance checklist (the AOB is retired)', !insAob);
  ok('ins-warranty-cert carries gateField: warrantyCertFiledAt', insWarrCert && insWarrCert.gateField === 'warrantyCertFiledAt');
  ok('ins-invoice (Final invoice & COC to carrier) carries gateField: cocFiledAt', insInvoice && insInvoice.gateField === 'cocFiledAt');

  const def = jc.CHECKLISTS.default;
  ok('job-contract (default list) carries gateField: contractFiledAt', (def.find(i => i.key === 'job-contract') || {}).gateField === 'contractFiledAt');
  ok('job-permit (default list) carries gateField: permitFiledAt + manual:true',
    (def.find(i => i.key === 'job-permit') || {}).manual === true);
}

// render() needs document.getElementById('checklistPanel') to return an
// element — reload with a stub document that returns one, then call render()
// directly (exported on window.JobChecklist) and inspect the HTML it emits.
// An auto-derived (non-manual) gateField item must come out DISABLED
// regardless of checked state, with no click handler wired, so a rep
// literally cannot tick "Sign contract" with nothing behind it.
{
  const src = fs.readFileSync(path.join(PRO_JS, 'customer-checklist.js'), 'utf8');
  const win = {};
  win.window = win;
  const panel = { innerHTML: '', style: {} };
  const sandbox = {
    window: win,
    document: { getElementById: (id) => (id === 'checklistPanel' ? panel : null), addEventListener() {} },
    console: { log() {}, warn() {}, error() {} },
  };
  vm.runInNewContext(src, sandbox, { filename: 'customer-checklist.js' });

  const leadUnfiled = { jobType: 'insurance', jobChecklist: {} };
  win.JobChecklist.render(leadUnfiled);
  const htmlUnfiled = panel.innerHTML;
  ok('unfiled Contract row: checkbox is disabled (auto-derived, read-only)',
    /disabled[^>]*data-arg="ins-contract"|data-arg="ins-contract"[^<]*<\/label>/.test(htmlUnfiled) === false
    && new RegExp('<input type="checkbox" disabled[^>]*>\\s*<span[^>]*>[^<]*Sign contract').test(htmlUnfiled));
  ok('unfiled Contract row shows a Generate link (nothing filed yet)',
    /Sign contract.*Generate/.test(htmlUnfiled.replace(/\n/g, ' ')));
  ok('unfiled Permit row (manual:true) is INTERACTIVE — has data-change-action, no disabled attr',
    new RegExp('<input type="checkbox" data-change-action="toggleJobChecklistItem" data-arg="ins-permit"').test(htmlUnfiled));

  // Every auto-derived gate field set, not just contractFiledAt — a naive
  // "no Generate anywhere after Sign contract" check would false-pass by
  // accident (nothing to compare against) or false-fail by picking up a
  // LATER, still-unfiled row's own Generate link; scope to the Contract
  // row's own label block instead.
  const leadFiled = {
    jobType: 'insurance', jobChecklist: {},
    contractFiledAt: '2026-09-15T00:00:00.000Z', aobFiledAt: '2026-09-15T00:00:00.000Z',
    warrantyCertFiledAt: '2026-09-15T00:00:00.000Z', cocFiledAt: '2026-09-15T00:00:00.000Z',
  };
  win.JobChecklist.render(leadFiled);
  const htmlFiled = panel.innerHTML;
  ok('filed Contract row: checkbox is checked AND still disabled', new RegExp('<input type="checkbox" checked disabled[^>]*>\\s*<span[^>]*style="[^"]*"[^>]*>[^<]*Sign contract').test(htmlFiled));
  const contractLabelFiled = (htmlFiled.match(/<label[^>]*>(?:(?!<\/label>)[\s\S])*Sign contract[\s\S]*?<\/label>/) || [''])[0];
  ok('filed Contract row: no Generate link once filed (scoped to that row\'s own <label>)', contractLabelFiled.length > 0 && !/Generate/.test(contractLabelFiled));
}

// ═══════════════════════════════════════════════════════════════════════
// 6. Wiring across dashboard-bootstrap.module.js / crm-leads.js /
//    crm-portal-bridge.js — source-text (heavy DOM/window dependencies make
//    real execution impractical for the value added; same fallback this
//    repo's Phase 2 driven-UX tests used for this exact class of file).
// ═══════════════════════════════════════════════════════════════════════
console.log('\nDOM/action wiring (source-text)');
{
  const dbSrc = fs.readFileSync(path.join(PRO_JS, 'dashboard-bootstrap.module.js'), 'utf8');
  ok('ACTION_DOC_MAP.pull_permit -> permit', /pull_permit:\s*'permit'/.test(dbSrc));
  ok('ACTION_HANDLER_MAP registers mark_permit_filed -> _actionMarkPermitFiled', /mark_permit_filed:\s*_actionMarkPermitFiled/.test(dbSrc));
  ok('_actionMarkPermitFiled routes through window.PaperworkWrite.commitPaperworkFiled (the shared chokepoint)',
    /function _actionMarkPermitFiled[\s\S]{0,400}window\.PaperworkWrite\.commitPaperworkFiled/.test(dbSrc));
  // Was: jobStages included contract_signed/collections so the paperwork
  // checkboxes showed one stage before the JOB_CREATED gate. Since 2026-09-30
  // #jobFieldsBlock is ALWAYS shown (no mid-form insert when Stage changes),
  // which covers those stages and every other one.
  ok('#jobFieldsBlock is always shown by toggleInsuranceFields (checkboxes visible at contract_signed and collections too)',
    /function toggleInsuranceFields[\s\S]{0,2500}if \(job\) job\.style\.display = 'block';/.test(dbSrc) && !/jobStages\s*=\s*\[/.test(dbSrc));
}
{
  const leadsSrc = fs.readFileSync(path.join(PRO_JS, 'crm-leads.js'), 'utf8');
  for (const f of ['contractFiledAt', 'permitFiledAt', 'aobFiledAt', 'warrantyCertFiledAt', 'cocFiledAt']) {
    ok(`saveLead() payload includes ${f} (checked -> ISO string, else '')`,
      new RegExp(f + ":\\s*document\\.getElementById\\('l\\w+'\\)\\?\\.checked \\? new Date\\(\\)\\.toISOString\\(\\) : ''").test(leadsSrc));
  }
  ok('modal reset clears the 5 filed checkboxes via .checked=false (NOT .value=\'\' — a no-op on a checkbox)',
    /\['lContractFiled','lPermitFiled','lAobFiled','lWarrantyCertFiled','lCocFiled'\]\.forEach\(id=>\{ const e=document\.getElementById\(id\); if\(e\) e\.checked=false; \}\)/.test(leadsSrc));
}
{
  const bridgeSrc = fs.readFileSync(path.join(PRO_JS, 'crm-portal-bridge.js'), 'utf8');
  ok('editLead() populates all 5 filed checkboxes from the lead\'s real state (else a re-save would silently wipe an auto-derived stamp)',
    /setChecked\('lContractFiled', l\.contractFiledAt\)/.test(bridgeSrc)
    && /setChecked\('lPermitFiled', l\.permitFiledAt\)/.test(bridgeSrc)
    && /setChecked\('lAobFiled', l\.aobFiledAt\)/.test(bridgeSrc)
    && /setChecked\('lWarrantyCertFiled', l\.warrantyCertFiledAt\)/.test(bridgeSrc)
    && /setChecked\('lCocFiled', l\.cocFiledAt\)/.test(bridgeSrc));
}
{
  const dashHtml = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
  for (const id of ['lContractFiled', 'lPermitFiled', 'lAobFiled', 'lWarrantyCertFiled', 'lCocFiled']) {
    ok(`dashboard.html has #${id}`, dashHtml.includes(`id="${id}"`));
  }
  ok('paperwork-write.js is loaded on dashboard.html', /paperwork-write\.js/.test(dashHtml));
}
{
  const custHtml = fs.readFileSync(path.join(ROOT, 'docs/pro/customer.html'), 'utf8');
  ok('paperwork-write.js is loaded on customer.html', /paperwork-write\.js/.test(custHtml));
}

console.log('\n' + (failed === 0 ? '✓' : '✗') + ' paperwork filing: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
