/**
 * tests/kanban-filter-unification.test.js — the 2026-09-15 Kanban filter
 * unification lane.
 *
 * THE BUG. The "Jobs" tab (dashboard.html's kview-btn switcher) filtered
 * leads by a hardcoded stage-key Set (crm-pipeline.js), independent of
 * crm-stages.js's own VIEW_JOBS export. contract_signed was never a member,
 * so a lead sitting in Contract Signed — a completely normal steady state
 * per the team's own seed data (functions/seed-demo.js models one resting
 * there 35 days with "materials on order") — was invisible on the one board
 * meant to show "what jobs are in production," while showing fine under
 * every jobType-filtered track view. Confirmed by a live audit workflow,
 * discussed with Jo, and resolved: Contract Signed counts as a job, and a
 * closed/paid job stays visible (no roll-off).
 *
 * At least 9 other files held their OWN independent copy of a job/terminal
 * stage-key list, and had ALREADY drifted out of sync with VIEW_JOBS within
 * hours of the Collections stage being added earlier the same day — proving
 * the duplication itself, not just this one instance, was the real risk.
 *
 * THE FIX. Two canonical exports from crm-stages.js:
 *   - isJobStage(stageKey)   — VIEW_JOBS membership OR contract_signed
 *   - isTerminalStage(stageKey) — role won OR lost
 * plus VIEW_JOBS_BOARD (the Jobs tab's actual column list: contract_signed
 * prepended to VIEW_JOBS), consumed by every migrated file instead of a
 * hand-copied literal.
 *
 * Run: node tests/kanban-filter-unification.test.js (no deps, no DOM)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); } }
function eq(name, got, want) { ok(name + ' (want ' + JSON.stringify(want) + ', got ' + JSON.stringify(got) + ')', got === want); }

const ROOT = path.join(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs/pro/js');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// ═══════════════════════════════════════════════════════════════════════
// 1. crm-stages.js — isJobStage / isTerminalStage / VIEW_JOBS_BOARD
//    (real execution)
// ═══════════════════════════════════════════════════════════════════════
console.log('crm-stages.js — canonical job/terminal classifiers (real execution)');
let S, VIEW_JOBS, VIEW_JOBS_BOARD, KANBAN_VIEWS, isJobStage, isTerminalStage,
    stageOptionsForType, resolveColumn, VIEW_INSURANCE, VIEW_CASH, VIEW_FINANCE,
    stageRole, ROLE;
{
  let src = read('docs/pro/js/crm-stages.js');
  src = src.replace(/export\s+function\s+/g, 'function ').replace(/export\s+const\s+/g, 'const ');
  src += `\nthis.__out = { S, VIEW_JOBS, VIEW_JOBS_BOARD, KANBAN_VIEWS, isJobStage, isTerminalStage,
    stageOptionsForType, resolveColumn, VIEW_INSURANCE, VIEW_CASH, VIEW_FINANCE, stageRole, ROLE };`;
  const sandbox = { console, window: {} };
  vm.runInNewContext(src, sandbox, { filename: 'crm-stages.js' });
  ({ S, VIEW_JOBS, VIEW_JOBS_BOARD, KANBAN_VIEWS, isJobStage, isTerminalStage,
     stageOptionsForType, resolveColumn, VIEW_INSURANCE, VIEW_CASH, VIEW_FINANCE,
     stageRole, ROLE } = sandbox.__out);
}

ok('all exports present', !!(isJobStage && isTerminalStage && VIEW_JOBS_BOARD && VIEW_JOBS));

console.log('\n  isJobStage(): exhaustive classification');
eq('contract_signed IS a job stage (Jo\'s call)', isJobStage(S.CONTRACT_SIGNED), true);
for (const s of VIEW_JOBS) {
  eq(`VIEW_JOBS member "${s}" is a job stage`, isJobStage(s), true);
}
eq('closed stays a job stage (no roll-off — Jo\'s call)', isJobStage(S.CLOSED), true);
eq('collections is a job stage (added same-day, must not need a second manual fix)', isJobStage(S.COLLECTIONS), true);
// Not job stages — every lead-track stage that ISN'T contract_signed.
for (const s of [S.NEW, S.CONTACTED, S.INSPECTED, S.CLAIM_FILED, S.ESTIMATE_SUBMITTED, S.NEGOTIATING, S.LOST]) {
  eq(`"${s}" is NOT a job stage`, isJobStage(s), false);
}
ok('legacy alias "Approved" resolves to contract_signed -> job stage', isJobStage('Approved') === true);
ok('legacy alias "Complete" resolves to closed -> job stage', isJobStage('Complete') === true);
ok('legacy alias "In Progress" resolves to install_in_progress -> job stage', isJobStage('In Progress') === true);

console.log('\n  isTerminalStage(): won or lost');
eq('closed is terminal', isTerminalStage(S.CLOSED), true);
eq('lost is terminal', isTerminalStage(S.LOST), true);
eq('collections is terminal (role won)', isTerminalStage(S.COLLECTIONS), true);
eq('contract_signed is NOT terminal (still active, not job/won)', isTerminalStage(S.CONTRACT_SIGNED), false);
eq('job_created is NOT terminal (role job, in production)', isTerminalStage(S.JOB_CREATED), false);
eq('new is NOT terminal', isTerminalStage(S.NEW), false);

console.log('\n  VIEW_JOBS never gains contract_signed (two OTHER consumers depend on that exact scope)');
ok('VIEW_JOBS does NOT contain contract_signed (unchanged — stageOptionsForType/resolveColumn depend on this)',
  !VIEW_JOBS.includes(S.CONTRACT_SIGNED));
// 2026-09-15 (Warranty Claim lane): 12 -> 13, warranty_claim APPENDED at the
// end (a job-role stage that comes after closed). Appending — not
// inserting — is why only this literal moved: neither consumer above cares
// about VIEW_JOBS's member ORDER, only its contract_signed-exclusion and
// membership-test semantics, both still intact.
eq('VIEW_JOBS still has exactly 13 members', VIEW_JOBS.length, 13);

console.log('\n  VIEW_JOBS_BOARD — the Jobs tab\'s real column list');
eq('VIEW_JOBS_BOARD = [contract_signed, ...VIEW_JOBS] (14 members)', VIEW_JOBS_BOARD.length, 14);
eq('VIEW_JOBS_BOARD[0] is contract_signed (its own leading column)', VIEW_JOBS_BOARD[0], S.CONTRACT_SIGNED);
ok('VIEW_JOBS_BOARD is VIEW_JOBS with exactly one prepended member',
  JSON.stringify(VIEW_JOBS_BOARD.slice(1)) === JSON.stringify(VIEW_JOBS));
eq('KANBAN_VIEWS.jobs.stages IS VIEW_JOBS_BOARD (not the old VIEW_JOBS)', KANBAN_VIEWS.jobs.stages, VIEW_JOBS_BOARD);

console.log('\n  Regression: stageOptionsForType() must NOT gain a duplicate contract_signed entry');
// VIEW_INSURANCE/CASH/FINANCE each already contain contract_signed as their
// own native member; stageOptionsForType splices VIEW_JOBS in right after
// it. If VIEW_JOBS_BOARD had been used there instead (or if VIEW_JOBS itself
// had gained contract_signed), the dropdown would show it twice.
for (const jt of ['insurance', 'cash', 'finance']) {
  const opts = stageOptionsForType(jt);
  const csCount = opts.filter(o => o.value === S.CONTRACT_SIGNED).length;
  eq(`${jt}: exactly ONE "contract_signed" option in the stage dropdown`, csCount, 1);
}
ok('warranty/service stageOptionsForType are untouched (appendJobs=false, no VIEW_JOBS splice at all)',
  !stageOptionsForType('warranty').some(o => o.value === S.JOB_CREATED)
  && !stageOptionsForType('service').some(o => o.value === S.JOB_CREATED));

console.log('\n  Regression: resolveColumn() places contract_signed correctly under the Jobs board now');
eq('resolveColumn(contract_signed, VIEW_JOBS_BOARD) direct-matches its own column (not the old viewStages[0] fallback accident)',
  resolveColumn(S.CONTRACT_SIGNED, VIEW_JOBS_BOARD), S.CONTRACT_SIGNED);
eq('resolveColumn(job_created, VIEW_JOBS_BOARD) still direct-matches (untouched behavior)',
  resolveColumn(S.JOB_CREATED, VIEW_JOBS_BOARD), S.JOB_CREATED);
eq('resolveColumn(contract_signed, VIEW_INSURANCE) still lands on its own native column (per-track boards unaffected)',
  resolveColumn(S.CONTRACT_SIGNED, VIEW_INSURANCE), S.CONTRACT_SIGNED);
// Narrower views WITHOUT their own contract_signed column (e.g. a
// hypothetical custom view) should still collapse a job-stage lead
// sensibly — resolveColumn's own VIEW_JOBS.includes() branch is untouched.
eq('resolveColumn(job_created, VIEW_SIMPLE) still collapses to Installing (untouched job-stage collapse logic)',
  resolveColumn(S.JOB_CREATED, KANBAN_VIEWS.simple.stages), 'install_in_progress');

// ═══════════════════════════════════════════════════════════════════════
// 2. dashboard-bootstrap.module.js — import + window exposure + tenant-aware
//    re-binding (source-text — ES module with heavy Firebase-SDK
//    dependencies, real execution impractical for the value added)
// ═══════════════════════════════════════════════════════════════════════
console.log('\ndashboard-bootstrap.module.js — wiring (source-text)');
{
  const src = read('docs/pro/js/dashboard-bootstrap.module.js');
  ok('imports isJobStage/isTerminalStage/VIEW_JOBS_BOARD from crm-stages.js',
    /isJobStage, isTerminalStage, ROLE, resolvePipelineConfig/.test(src)
    && /VIEW_JOBS, VIEW_JOBS_BOARD/.test(src));
  ok('exposes window.isJobStage / window.isTerminalStage (built-in default)',
    /window\.isJobStage = isJobStage;/.test(src) && /window\.isTerminalStage = isTerminalStage;/.test(src));
  ok('re-binds BOTH to tenant-resolved roleOf() inside applyPipelineConfig (mirrors the existing isWonStage/isLostStage precedent)',
    /window\.isJobStage = \(k\) => k === S\.CONTRACT_SIGNED \|\| resolved\.roleOf\(k\) === ROLE\.JOB \|\| resolved\.roleOf\(k\) === ROLE\.WON;/.test(src)
    && /window\.isTerminalStage = \(k\) => resolved\.roleOf\(k\) === ROLE\.WON \|\| resolved\.roleOf\(k\) === ROLE\.LOST;/.test(src));
}
console.log('\ncustomer-bootstrap.module.js — wiring (source-text)');
{
  const src = read('docs/pro/js/customer-bootstrap.module.js');
  ok('imports isJobStage/isTerminalStage from crm-stages.js',
    /isJobStage as _isJobStage, isTerminalStage as _isTerminalStage/.test(src));
  ok('exposes window.isJobStage / window.isTerminalStage',
    /window\.isJobStage = _isJobStage;/.test(src) && /window\.isTerminalStage = _isTerminalStage;/.test(src));
  // 2026-09-28: both now call window.stageLabel — this module's own
  // tenant-aware wrapper over _stageLabel (custom stages keep their label
  // instead of normalizing to "New Lead"). Still no hand-copied map.
  ok('the customerStage badge calls the stageLabel resolver (no more hand-copied STAGE_LABELS map missing \'collections\')',
    /stageBadge\.textContent = window\.stageLabel\(stage\) \|\| stage;/.test(src)
    && /window\.stageLabel = \(k\) => \{[\s\S]{0,200}?_stageLabel\(k\)/.test(src));
  ok('the background-revalidate refresher ALSO calls the same resolver (both call sites reach one function, not a bridge object)',
    /stageEl\.textContent = window\.stageLabel\(fresh\.stage\) \|\| fresh\.stage;/.test(src));
  ok('the old window.__STAGE_LABELS bridge object is gone entirely (both call sites now reach module-scope _stageLabel directly — only a historical comment mentioning it may remain)',
    !/window\.__STAGE_LABELS\s*(=|\[)/.test(src));
}

// ═══════════════════════════════════════════════════════════════════════
// 3. crm-pipeline.js — the actual bug's fix, all 3 sites (source-text — a
//    plain script deeply entangled with live DOM/window.* state; real
//    execution of renderLeads() would need extensive mocking for little
//    extra confidence over asserting the exact code shape)
// ═══════════════════════════════════════════════════════════════════════
console.log('\ncrm-pipeline.js — the reported bug\'s actual fix (source-text)');
{
  const src = read('docs/pro/js/crm-pipeline.js');
  ok('the old hand-copied _jobStageSet is GONE (both copies)', !/_jobStageSet/.test(src));
  ok('the Jobs-tab COUNT BADGE now calls window.isJobStage',
    /if \(window\.isJobStage && window\.isJobStage\(sk\)\) counts\.jobs\+\+;/.test(src));
  ok('the Jobs-tab FILTER (the actual reported bug) now calls window.isJobStage',
    /return window\.isJobStage && window\.isJobStage\(sk\);/.test(src));
  ok('the old hand-copied _closedKeys revenue list is GONE',
    !/const _closedKeys = /.test(src));
  ok('the closed-revenue stat calc now calls window.isJobStage (contract_signed onward = converted/closed money, same definition the revenue math already used before this fix)',
    /const isClosed = \(window\.isJobStage && window\.isJobStage\(sk\)\) \|\| role === 'won' \|\| role === 'job';/.test(src));
}

// ═══════════════════════════════════════════════════════════════════════
// 4. ask-joe-proactive.js — _isTerminal simplified, _ACTIVE_JOB_KEYS gets a
//    role-aware safety net WITHOUT redefining its narrower "in production"
//    meaning (source-text)
// ═══════════════════════════════════════════════════════════════════════
console.log('\nask-joe-proactive.js — wiring (source-text)');
{
  const src = read('docs/pro/js/ask-joe-proactive.js');
  ok('_TERMINAL_STAGE_KEYS is now JUST the un-mappable legacy alias (\'won\' has no LEGACY_MAP entry) — not a duplicate of the canonical set',
    /const _TERMINAL_STAGE_KEYS = new Set\(\['won'\]\);/.test(src));
  ok('_isTerminal calls window.isTerminalStage', /window\.isTerminalStage === 'function' && window\.isTerminalStage\(k\)/.test(src));
  const activeJobsStart = src.indexOf('const activeJobs = leads.filter');
  const activeJobsFn = activeJobsStart >= 0 ? src.slice(activeJobsStart, activeJobsStart + 1000) : '';
  ok('activeJobs found _ACTIVE_JOB_KEYS filter block', activeJobsStart >= 0);
  ok('_ACTIVE_JOB_KEYS keeps its ORIGINAL narrower membership (does NOT call window.isJobStage, which would wrongly include final_payment/collections/closed as "active production")',
    !/window\.isJobStage/.test(activeJobsFn));
  ok('_ACTIVE_JOB_KEYS gains a role===\'job\' safety net (closes the one list in the drift table with ZERO prior fallback) — deliberately role JOB only, not WON, so it can\'t silently start counting closed/collections leads as "active"',
    /window\.stageRole\(k\) === 'job'/.test(activeJobsFn));
}

// ═══════════════════════════════════════════════════════════════════════
// 5. bottleneck-widget.js — SKIP_STAGES simplified to just 'new', cosmetic
//    labels delegate to window.stageLabel (source-text)
// ═══════════════════════════════════════════════════════════════════════
console.log('\nbottleneck-widget.js — wiring (source-text)');
{
  const src = read('docs/pro/js/bottleneck-widget.js');
  ok('SKIP_STAGES is now JUST [\'new\'] — the terminal keys were pure redundant duplication of the role fallback that already existed right below them',
    /const SKIP_STAGES = new Set\(\[\s*'new',/.test(src) && !/'closed', 'lost'/.test(src.slice(src.indexOf('SKIP_STAGES'), src.indexOf('SKIP_STAGES') + 400)));
  ok('the label lookup now prefers window.stageLabel over the local (incomplete, stops at final_photos) STAGE_LABELS map',
    /\(typeof window\.stageLabel === 'function' && window\.stageLabel\(stage\)\)\s*\n\s*\|\| STAGE_LABELS\[stage\]/.test(src));
}

// ═══════════════════════════════════════════════════════════════════════
// 6. document-generator.js — cosmetic label delegates to window.stageLabel
//    (source-text)
// ═══════════════════════════════════════════════════════════════════════
console.log('\ndocument-generator.js — wiring (source-text)');
{
  const src = read('docs/pro/js/document-generator.js');
  ok('_stageLabelFor prefers window.stageLabel over the local (incomplete) STAGE_LABELS map',
    /const _stageLabelFor = \(k\) => \(typeof window\.stageLabel === 'function' && window\.stageLabel\(k\)\) \|\| STAGE_LABELS\[k\] \|\| k;/.test(src));
  ok('the customer-report Stage row uses _stageLabelFor, not the raw local map', /_stageLabelFor\(customer\.stage\)/.test(src));
}

// ═══════════════════════════════════════════════════════════════════════
// 7. money-dashboard.js / analytics-kpi.js — deliberately self-contained
//    files, literal patched directly (not restructured) — source-text
// ═══════════════════════════════════════════════════════════════════════
console.log('\nmoney-dashboard.js / analytics-kpi.js — literal patched (source-text, deliberately NOT restructured)');
{
  const mdSrc = read('docs/pro/js/money-dashboard.js');
  ok('money-dashboard.js WON_STAGES now includes \'collections\'', /'deductible_collected', 'collections', 'warranty_claim', 'Complete'/.test(mdSrc));
  const akSrc = read('docs/pro/js/analytics-kpi.js');
  ok('analytics-kpi.js WON_STAGES now includes \'collections\'', /'deductible_collected', 'collections', 'warranty_claim', 'Complete'/.test(akSrc));
  // 2026-09-15 (Warranty Claim lane): same two self-contained literals gain
  // 'warranty_claim' the same day, for the same reason 'collections' did.
  ok('money-dashboard.js WON_STAGES now includes \'warranty_claim\'', /'collections', 'warranty_claim'/.test(mdSrc));
  ok('analytics-kpi.js WON_STAGES now includes \'warranty_claim\'', /'collections', 'warranty_claim'/.test(akSrc));
}

console.log('\n' + (failed === 0 ? '✓' : '✗') + ' kanban filter unification: ' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
