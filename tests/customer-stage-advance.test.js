/**
 * customer-stage-advance.test.js — the customer page's "Move to Next Stage".
 *
 * History: the kanban's moveCard does five things on every stage change —
 * gates on required fields, writes `stage`, stamps `stageRole`, logs an
 * activity note, and fires the email drip, all inside a Firestore
 * transaction with race guards. progressStage on customer.html originally
 * did exactly one of them (a plain, unguarded `updateDoc` of `stage`) — see
 * git history on this file for the two prior passes that closed the
 * bookkeeping gap (stageRole/note/drip) but deliberately left the gate a
 * non-blocking warning and the write racy, because this page's edit modal
 * was missing several gated fields and there was no shared transaction path
 * to reuse.
 *
 * 2026-09-15 foundation rework closes both of those:
 *   - The write now goes through stage-write.js's commitStageChange() — the
 *     SAME transaction + STAGE_RACE_NOOP/STAGE_RACE_LOST guard moveCard has
 *     always had. A kanban move and a customer-page move racing on the same
 *     lead can no longer silently clobber each other.
 *   - The required-field gate is now a HARD BLOCK, matching the kanban
 *     exactly (Jo's explicit call this session — "unbreakable" over
 *     "warn and hope"). The block's toast offers "Open full editor" as the
 *     escape hatch, since this page's own modal still lacks several gated
 *     fields — see the tripwire assertion at the bottom for what happens
 *     when that stops being true.
 *   - progressStage's own hand-copied PIPELINES/STAGE_LABELS ladder is gone;
 *     both it and the initial button-label render now share one
 *     _nextStageFor() helper that reads the tenant's resolved pipeline
 *     config (resolvePipelineConfig), not a hardcoded default-only copy —
 *     closing a real gap where a custom stage added via Settings > Pipelines
 *     was invisible to this page specifically.
 *   - No more window.location.reload() on a successful move — state updates
 *     in place, the way every other save on this page works.
 *
 * Run: node tests/customer-stage-advance.test.js   (no deps, no DOM)
 */
'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const boot = read('docs/pro/js/customer-bootstrap.module.js');
const customerHtml = read('docs/pro/customer.html');
const dashboardHtml = read('docs/pro/dashboard.html');
const sw = fs.existsSync(path.join(ROOT, 'docs/pro/js/stage-write.js'))
  ? read('docs/pro/js/stage-write.js') : '';

// Scoped slices so an unrelated match elsewhere in a 2000+ line file can't
// make these pass. Strip comments first (per this repo's own convention —
// several fixes here are explained by quoting the defect, which would
// satisfy a naive text-match test on a genuinely-fixed file).
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const nextStageFnStart = boot.indexOf('function _nextStageFor(');
const nextStageFn = nextStageFnStart >= 0 ? boot.slice(nextStageFnStart, nextStageFnStart + 2200) : '';
const progressStart = boot.indexOf('window.progressStage = async function');
// 2026-09-15 (Warranty Claim lane): 6000 -> 7500. The new warranty-claim
// guard block (inserted right after the confirm prompt, before the
// pre-flight checks) pushed the STAGE_RACE_NOOP handling near the function's
// end past the old 6000-char window — the exact "slice too narrow" failure
// mode this repo has hit before (see kanban-filter-unification.test.js's own
// _ACTIVE_JOB_KEYS fix); verified empirically the offset is ~6134 chars, so
// 7500 keeps real margin for the next small addition too.
const progressFn = progressStart >= 0 ? boot.slice(progressStart, progressStart + 7500) : '';
const progressFnNoComments = stripComments(progressFn);

console.log('\ncustomer-stage-advance — parity with the kanban move\n');

ok('progressStage exists', progressStart >= 0);
ok('_nextStageFor exists (the shared next-stage computation)', nextStageFnStart >= 0);
ok('stage-write.js exists', sw.length > 0, 'the shared transactional commit path');

// ── no more private hardcoded pipeline copies ──────────────────────────
ok('progressStage does NOT carry its own hardcoded PIPELINES table',
  !/PIPELINES\s*=\s*\{/.test(progressFn),
  'a fourth hardcoded ladder is how these paths drifted apart in the first place');
ok('progressStage does NOT carry its own hardcoded STAGE_LABELS table',
  !/STAGE_LABELS\s*=\s*\{/.test(progressFn));
ok('progressStage calls the shared _nextStageFor rather than recomputing the ladder',
  /_nextStageFor\(/.test(progressFn));
// 2026-09-28: the track computation moved into _pipelineFor (shared with the
// Project Timeline); _nextStageFor calls it.
const pipelineForStart = boot.indexOf('function _pipelineFor(');
const pipelineForFn = pipelineForStart >= 0 ? boot.slice(pipelineForStart, pipelineForStart + 1500) : '';
ok('_nextStageFor reads the tenant-resolved pipeline config (resolvePipelineConfig), not just built-in defaults',
  /_pipelineFor\(lead\)/.test(nextStageFn) && /_resolvePipelineConfig\(window\._companyProfile/.test(pipelineForFn),
  'without this, a custom stage added via Settings > Pipelines stays invisible to this page');
ok('the canonical stage config is imported (crm-stages.js), not a private hardcoded copy',
  /import\s*\{[^}]*\bstageRole\b[^}]*\}\s*from\s*["']\.\/crm-stages\.js["']/.test(boot));
ok('crm-stages.js exists at the imported path',
  fs.existsSync(path.join(ROOT, 'docs/pro/js/crm-stages.js')),
  'a module script whose import 404s takes the WHOLE page down');
ok('stage-write.js is imported (not dynamically re-implemented per page)',
  /import\s*\{\s*commitStageChange[^}]*\}\s*from\s*["']\.\/stage-write\.js["']/.test(boot));
ok('customer.html loads the bootstrap as a module (so the import is legal)',
  /<script\s+type="module"\s+src="js\/customer-bootstrap\.module\.js/.test(customerHtml));

// ── the write goes through the SHARED transactional path ───────────────
ok('progressStage commits via the shared commitStageChange (not a private updateDoc)',
  /await _commitStageChange\(window\._customerId, nextStage, oldStage/.test(progressFn));
ok('…and progressStage itself no longer calls updateDoc directly for the stage write',
  !/window\.updateDoc\(window\.doc\(window\.db, 'leads', window\._customerId\)/.test(progressFnNoComments),
  'a surviving direct updateDoc means the transaction is being bypassed on this path');
ok('runTransaction is exposed on window (so commitStageChange gets the guard here, not the racy fallback)',
  /window\.runTransaction\s*=\s*runTransaction/.test(boot));
ok('window.stageRole is wired (so stage-write.js stamps stageRole from this page too)',
  /window\.stageRole\s*=\s*_stageRole/.test(boot));
ok('window.stageLabel is wired tenant-aware (so activity notes use the resolved label, not just the raw key)',
  /window\.stageLabel\s*=\s*\(k\)\s*=>/.test(boot) && /_resolvePipelineConfig\(window\._companyProfile/.test(boot));

// stage-write.js itself: the transaction + guards + bookkeeping actually exist
ok('commitStageChange runs inside a Firestore transaction',
  /window\.runTransaction\(window\.db, async \(tx\)/.test(sw));
ok('commitStageChange NOOPs when another tab already landed on the same stage/column',
  /throw new Error\('STAGE_RACE_NOOP'\)/.test(sw));
ok('commitStageChange aborts (does not clobber) when another tab moved to a DIFFERENT stage',
  /throw new Error\('STAGE_RACE_LOST'\)/.test(sw));
ok('commitStageChange stamps stageRole', /stageRole:\s*window\.stageRole\(newStage\)/.test(sw));
ok('commitStageChange writes an activity note', /type:\s*'stage_change'/.test(sw));
ok('commitStageChange fires the email drip', /EmailDrip\.onStageChange\(/.test(sw));
ok('the drip is feature-detected before calling',
  /typeof window\.EmailDrip\.onStageChange === 'function'/.test(sw));

// ── race-loss handling on the customer page ─────────────────────────────
ok('progressStage handles STAGE_RACE_NOOP / STAGE_RACE_LOST distinctly (not a generic failure toast)',
  /e\.message === 'STAGE_RACE_NOOP' \|\| e\.message === 'STAGE_RACE_LOST'/.test(progressFn));
ok('…and does NOT report a race-loss as a write failure to the rep',
  (() => {
    // Scope strictly to the race-condition's OWN if-block — from the
    // condition to its own `return;` — not an arbitrary char window that
    // could spill into the unrelated generic-failure code right after it.
    const condIdx = progressFn.indexOf("e.message === 'STAGE_RACE_NOOP' || e.message === 'STAGE_RACE_LOST'");
    if (condIdx < 0) return false;
    const afterCond = progressFn.slice(condIdx);
    const returnIdx = afterCond.indexOf('return;');
    if (returnIdx < 0) return false;
    const raceBlock = afterCond.slice(0, returnIdx + 'return;'.length);
    return !/Failed to move stage/.test(raceBlock);
  })());

// ── the required-field gate is now a HARD BLOCK ─────────────────────────
ok('missing required fields BLOCK the move (return before the write)',
  (() => {
    const gateIdx = progressFnNoComments.indexOf('_missingRequiredFields(');
    if (gateIdx < 0) return false;
    const gateBlock = progressFnNoComments.slice(gateIdx, gateIdx + 900);
    return /if \(missing\.length\)\s*\{[\s\S]{0,600}return;/.test(gateBlock);
  })(),
  'Jo\'s 2026-09-15 call: hard block, matching the kanban, over the prior non-blocking warning');
ok('the block happens BEFORE _commitStageChange is called (not after a partial write)',
  progressFn.indexOf('_missingRequiredFields(') < progressFn.indexOf('await _commitStageChange('));
ok('the block message NAMES the missing fields by their labels ("Carrier", not "insCarrier"), not just a count',
  /missing\.map\(_requiredFieldLabel\)\.join\(', '\)/.test(progressFn));
ok('the check evaluates the DESTINATION stage, not the current one',
  /_missingRequiredFields\([\s\S]{0,120}?stage:\s*nextStage/.test(progressFn),
  'checking the current stage would block on the wrong requirements');
ok('the block offers an escape hatch to the full editor (this page cannot satisfy every gated field itself)',
  /undoText:\s*['"]Open full editor['"]/.test(progressFn)
  // ?edit= (R14, 2026-09-28) — a bare ?lead= is the NEW-ESTIMATE deep link.
  && /window\.location\.href = ['"]\/pro\/dashboard\?edit=['"] \+ encodeURIComponent\(window\._customerId\)/.test(progressFn),
  'a hard block with no way forward strands the rep worse than the silent advance it replaced');

// ── no reload on the common (successful) path ───────────────────────────
const successPath = progressFn.slice(
  progressFn.indexOf('await _commitStageChange('),
  progressFn.indexOf('} catch (e) {')
);
ok('a successful move does NOT reload the page',
  !/location\.reload\(\)/.test(successPath),
  'every other save on this page updates in place — this was the one action that still full-navigated');
ok('…local stage state is updated in place instead',
  /window\._currentStage = nextStage/.test(successPath));
ok('…the stage-progress button re-renders its own label from the NEW current stage (not stale until next load)',
  /_nextStageFor\(lead\)/.test(successPath));

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
process.exit(0);
