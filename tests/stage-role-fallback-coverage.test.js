/**
 * stage-role-fallback-coverage.test.js — custom-stage visibility across the
 * proactive/reporting surfaces that classify leads by a hardcoded stage-key
 * list instead of the persisted `stageRole`.
 *
 * Context: the freeform-pipeline system (crm-stages.js) lets a tenant add a
 * custom stage via Settings > Pipelines, tagged with one of the 5 semantic
 * roles (new/active/job/won/lost). Most classifiers in this codebase already
 * check the persisted role FIRST and fall back to a hardcoded key map only
 * for legacy/un-stamped leads (functions/stage-roles.js is the canonical
 * server-side version; money-dashboard.js, analytics-kpi.js, leaderboard.js,
 * and functions/portal.js's progressKeyFor all follow this pattern — the
 * last one fixed 2026-09-08 after a real customer-facing 409 caused by
 * exactly this class of gap).
 *
 * Four surfaces did NOT follow the pattern, found during the 2026-09-15 CRM
 * stage-progression foundation work: functions/weekly-digest.js,
 * functions/dormant-leads.js, docs/pro/js/ask-joe-proactive.js, and
 * docs/pro/js/bottleneck-widget.js each had a plain hardcoded Set with no
 * role fallback. Consequence: a lead sitting on a tenant's custom "won"/
 * "lost" stage was invisible to the Monday digest's won/lost counts, kept
 * getting flagged as dormant every Wednesday, kept nudging the rep via Ask
 * Joe, and kept surfacing as a false "bottleneck" — every one of them a
 * proactive-nudge surface, i.e. exactly what erodes trust in a "driven" CRM.
 *
 * This suite has two halves:
 *   1. A REAL execution test against functions/stage-roles.js itself (a
 *      plain, side-effect-free CommonJS module — safe to require directly,
 *      unlike weekly-digest.js/dormant-leads.js which call defineSecret/
 *      onSchedule at module load and are covered by source-text assertions
 *      instead, matching this repo's existing convention for those files —
 *      see tests/cron-heartbeat.test.js) — proving the mechanism all four
 *      fixes lean on actually resolves a custom stageRole correctly.
 *   2. Source-text assertions that each of the four files actually wired
 *      that mechanism in, at the right call site, with the field mask (where
 *      relevant) that lets it see the data it needs.
 *
 * Run: node tests/stage-role-fallback-coverage.test.js   (no deps, no DOM)
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

console.log('\nstage-role-fallback-coverage — custom stages stay visible to proactive surfaces\n');

// ── 1. The mechanism itself, executed for real ──────────────────────────
console.log('functions/stage-roles.js (real execution, not source-text)');
{
  const stageRoles = require(path.join(ROOT, 'functions/stage-roles.js'));

  const customWon = { stage: 'custom_collections_closed', stageRole: 'won' };
  const customLost = { stage: 'custom_disqualified', stageRole: 'lost' };
  const legacyBuiltinWon = { stage: 'closed' }; // no stageRole — legacy fallback path
  const legacyBuiltinLost = { stage: 'Lost' };
  const active = { stage: 'contacted' };

  ok('a custom stage with a persisted stageRole="won" resolves to WON',
    stageRoles.roleFor(customWon) === stageRoles.ROLE.WON && stageRoles.isWon(customWon) === true,
    'this IS the scenario the whole fix is for — a stage the built-in key map has never heard of');
  ok('a custom stage with a persisted stageRole="lost" resolves to LOST',
    stageRoles.roleFor(customLost) === stageRoles.ROLE.LOST && stageRoles.isLost(customLost) === true);
  ok('both custom cases are "decided" (terminal)',
    stageRoles.isDecided(customWon) === true && stageRoles.isDecided(customLost) === true);
  ok('a legacy lead with no stageRole still resolves via the built-in key map (fallback intact)',
    stageRoles.isWon(legacyBuiltinWon) === true && stageRoles.isLost(legacyBuiltinLost) === true,
    'the fallback must not have been broken while adding the custom-stage path');
  ok('an ordinary active-stage lead is neither won, lost, nor decided',
    stageRoles.isWon(active) === false && stageRoles.isLost(active) === false && stageRoles.isDecided(active) === false);
  ok('the persisted role WINS over a conflicting stage key (custom-stage-safe by design)',
    stageRoles.roleFor({ stage: 'closed', stageRole: 'active' }) === stageRoles.ROLE.ACTIVE,
    'this is the documented precedence in stage-roles.js itself — a mis-migrated stage string must not override a real persisted role');
}

// ── 2. weekly-digest.js ──────────────────────────────────────────────────
console.log('\nfunctions/weekly-digest.js');
{
  const src = read('functions/weekly-digest.js');
  ok('requires stage-roles.js', /require\(['"]\.\/stage-roles['"]\)/.test(src));
  ok('defines a hardcoded-fast-path + role-fallback won check',
    /function _isWonLead\(l\)/.test(src) && /stageRoles\.roleFor\(l\) === stageRoles\.ROLE\.WON/.test(src));
  ok('defines a hardcoded-fast-path + role-fallback lost check',
    /function _isLostLead\(l\)/.test(src) && /stageRoles\.roleFor\(l\) === stageRoles\.ROLE\.LOST/.test(src));
  ok('defines a hardcoded-fast-path + role-fallback terminal check',
    /function _isTerminalLead\(l\)/.test(src)
    && /role === stageRoles\.ROLE\.WON \|\| role === stageRoles\.ROLE\.LOST/.test(src));
  ok('the weekly won/lost counts use the fallback-aware helpers (not the raw Sets directly)',
    /touchedThisWeek\.filter\(_isWonLead\)/.test(src) && /touchedThisWeek\.filter\(_isLostLead\)/.test(src));
  ok('the active-pipeline-value scan uses the fallback-aware terminal check',
    // (r = a job record since review R2-2-7, 2026-10-06 — every open job counts)
    /if \(_isTerminalLead\(r\)\) continue;/.test(src) && /for \(const r of jobRecords\(pipeLeads, jobsByLead\)\)/.test(src));
  ok('…and its query field mask actually SELECTS stageRole (an orderBy/select field absence is invisibility)',
    /\.select\(['"]stage['"],\s*['"]stageRole['"],/.test(src),
    'without stageRole in the projection, l.stageRole is always undefined and the fallback silently never fires — the exact bug class logged in this vault before');
}

// ── 3. dormant-leads.js ──────────────────────────────────────────────────
console.log('\nfunctions/dormant-leads.js');
{
  const src = read('functions/dormant-leads.js');
  ok('requires stage-roles.js', /require\(['"]\.\/stage-roles['"]\)/.test(src));
  ok('defines a hardcoded-fast-path + role-fallback terminal check',
    /function _isTerminalLead\(lead\)/.test(src)
    && /role === stageRoles\.ROLE\.WON \|\| role === stageRoles\.ROLE\.LOST/.test(src));
  ok('the dormant scan uses the fallback-aware helper (not the raw Set directly)',
    /if \(_isTerminalLead\(lead\)\) continue;/.test(src));
  ok('the dormant query reads the FULL document (no field mask to worry about)',
    !/\.select\(/.test(src.slice(src.indexOf("db.collection('leads')"), src.indexOf("db.collection('leads')") + 800)),
    'if this ever gains a .select() projection, stageRole must be added to it or the fallback silently breaks — see the weekly-digest.js case this suite also guards');
}

// ── 4. ask-joe-proactive.js ───────────────────────────────────────────────
console.log('\ndocs/pro/js/ask-joe-proactive.js');
{
  const src = read('docs/pro/js/ask-joe-proactive.js');
  const fnStart = src.indexOf('function _isTerminal(lead)');
  const fn = fnStart >= 0 ? src.slice(fnStart, fnStart + 500) : '';
  ok('_isTerminal exists', fnStart >= 0);
  // 2026-09-15 (Kanban filter unification): this used to inline
  // `window.stageRole(k)` + a 'won'/'lost' check; now calls the canonical
  // window.isTerminalStage (crm-stages.js), which IS that exact check —
  // same behavior, one fewer place it can drift from its sibling classifiers.
  ok('falls back to window.isTerminalStage for a stage the hardcoded set doesn\'t recognize',
    /typeof window\.isTerminalStage === 'function' && window\.isTerminalStage\(k\)/.test(fn));
  ok('the hardcoded fast-path check still runs first (preserved, not replaced)',
    /_TERMINAL_STAGE_KEYS\.has\(k\)/.test(fn));
}

// ── 5. bottleneck-widget.js ───────────────────────────────────────────────
console.log('\ndocs/pro/js/bottleneck-widget.js');
{
  const src = read('docs/pro/js/bottleneck-widget.js');
  const computeStart = src.indexOf('function compute(leads)');
  const computeFn = computeStart >= 0 ? src.slice(computeStart, computeStart + 900) : '';
  ok('compute() exists', computeStart >= 0);
  ok('the SKIP_STAGES fast-path check still runs first (preserves the deliberate \'new\'-stage exclusion, unrelated to won/lost)',
    /SKIP_STAGES\.has\(sk\)/.test(computeFn));
  // 2026-09-15 (Kanban filter unification): this used to inline
  // `window.stageRole(sk)` + a 'won'/'lost' check; now calls the canonical
  // window.isTerminalStage (crm-stages.js) — same behavior, one fewer place
  // it can drift from its sibling classifiers (this file's own hardcoded
  // terminal-key Set was removed entirely, not just supplemented, since
  // every one of its entries already resolved correctly through this
  // fallback alone).
  ok('falls back to window.isTerminalStage for a stage the hardcoded set doesn\'t recognize',
    /typeof window\.isTerminalStage === 'function' && window\.isTerminalStage\(sk\)/.test(computeFn));
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed) { console.log('\n  failures:'); for (const f of fails) console.log('    - ' + f); process.exit(1); }
process.exit(0);
