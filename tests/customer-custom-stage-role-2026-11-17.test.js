/**
 * tests/customer-custom-stage-role-2026-11-17.test.js
 *
 * Repo sweep 2026-11-17, M2: customer.html set window.stageRole to the STATIC
 * crm-stages.js stageRole. That one runs normalizeStage, which only knows
 * built-in keys, so a tenant's custom stage (Settings > Pipelines, e.g.
 * "Paid Out" with role won) read as role 'new'. The customer page offers that
 * stage as the next step (_nextStageFor resolves the tenant pipeline), and
 * stage-write.js commitStageChange then saved stageRole:'new', stamped no
 * closedAt, carried no soldTier, and asked no lost reason for a custom lost
 * stage. The kanban (dashboard-bootstrap applyPipelineConfig) was right.
 *
 * Now crm-stages.js exports liveRoleHelpers(getPipelines): stageRole and the
 * won / lost / job / terminal tests read the tenant's pipeline config at call
 * time, and customer-bootstrap.module.js puts them on window.
 *
 * Run: node tests/customer-custom-stage-role-2026-11-17.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra !== undefined ? '\n      ' + extra : '')); }
}
const ROOT = path.join(__dirname, '..');

(async () => {
  console.log('\nM2: the customer page classifies a tenant\'s custom stages by their own role\n');
  globalThis.window = globalThis.window || {};
  const M = await import(pathToFileURL(path.join(ROOT, 'docs', 'pro', 'js', 'crm-stages.js')).href);

  ok('crm-stages.js exports liveRoleHelpers', typeof M.liveRoleHelpers === 'function');
  if (typeof M.liveRoleHelpers === 'function') {
    let pipelines = { stages: {
      custom_paid: { role: 'won', label: 'Paid Out' },
      custom_ghosted: { role: 'lost', label: 'Ghosted' },
      custom_prep: { role: 'job', label: 'Site Prep' },
    } };
    const H = M.liveRoleHelpers(() => pipelines);
    ok('a custom won stage is won (the static stageRole says new)', H.stageRole('custom_paid') === 'won' && M.stageRole('custom_paid') === 'new',
      H.stageRole('custom_paid') + ' / static ' + M.stageRole('custom_paid'));
    ok('…isWonStage and isTerminalStage agree', H.isWonStage('custom_paid') === true && H.isTerminalStage('custom_paid') === true);
    ok('a custom lost stage is lost and terminal', H.stageRole('custom_ghosted') === 'lost' && H.isLostStage('custom_ghosted') === true && H.isTerminalStage('custom_ghosted') === true);
    ok('a custom job stage is a job stage, not terminal', H.isJobStage('custom_prep') === true && H.isTerminalStage('custom_prep') === false);
    ok('a role override on a built-in stage is honoured', (() => {
      pipelines = { stages: { negotiating: { role: 'lost' } } };
      return H.stageRole('negotiating') === 'lost';
    })(), H.stageRole('negotiating'));
    ok('the config is read at call time (a profile that loads later counts)', (() => {
      pipelines = null;
      const before = H.stageRole('custom_paid');
      pipelines = { stages: { custom_paid: { role: 'won', label: 'Paid Out' } } };
      return before !== 'won' && H.stageRole('custom_paid') === 'won';
    })());

    // No config: identical to the static helpers for every built-in key and alias.
    pipelines = null;
    const keys = Object.keys(M.STAGE_META || {}).concat(['', null, 'closed won', 'Approved', 'In Progress', 'lost', 'won', 'nonsense_key']);
    const diff = keys.filter((k) => H.stageRole(k) !== M.stageRole(k)
      || H.isJobStage(k) !== M.isJobStage(k) || H.isTerminalStage(k) !== M.isTerminalStage(k)
      || H.isWonStage(k) !== M.isWonStage(k) || H.isLostStage(k) !== M.isLostStage(k));
    ok('with no tenant config every built-in key classifies exactly as before (' + keys.length + ' keys)', diff.length === 0, diff.join(', '));
    ok('a getter that throws falls back to the built-in defaults, never throws itself', (() => {
      const B = M.liveRoleHelpers(() => { throw new Error('profile not loaded'); });
      try { return B.stageRole('closed') === M.stageRole('closed'); } catch (_) { return false; }
    })());
  }

  // The customer page wires them onto window (stage-write.js reads window.stageRole).
  const src = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'customer-bootstrap.module.js'), 'utf8').replace(/\r\n/g, '\n');
  ok('customer-bootstrap no longer puts the static stageRole on window', !/window\.stageRole\s*=\s*_stageRole\s*;/.test(src));
  ok('…it builds the live helpers from the company profile\'s pipelines',
    /liveRoleHelpers\(\s*\(\)\s*=>\s*window\._companyProfile\s*&&\s*window\._companyProfile\.pipelines\s*\)/.test(src));
  ['stageRole', 'isWonStage', 'isLostStage', 'isJobStage', 'isTerminalStage'].forEach((fn) => {
    ok('…window.' + fn + ' comes from them', new RegExp('window\\.' + fn + '\\s*=\\s*_liveRoles\\.' + fn + '\\s*;').test(src));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
