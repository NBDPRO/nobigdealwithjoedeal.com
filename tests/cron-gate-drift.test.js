/**
 * tests/cron-gate-drift.test.js — the cron-gate registry can't fall out of
 * sync with the code it describes.
 *
 * functions/cron-gates.js is the one place that lists every feature-gate env
 * var a scheduled function checks before it does real work (health-digest.js's
 * "Cron Gates" table reads it, so ops can see at a glance which of the twelve
 * are on). A hand-copied second list anywhere else is exactly how one of these
 * silently drifts: a new cron ships with its own gate and never gets added
 * here, or a rename leaves a stale entry that no code reads any more — either
 * way the table quietly stops telling the truth. This scans the real
 * functions/ tree for every `process.env.X_ENABLED` / `process.env.X_DISABLED`
 * read and asserts the set matches the registry exactly, in both directions.
 *
 * health-digest.js imports firebase-functions/firebase-admin at module scope,
 * so it can't be require()d in a worktree with no functions/node_modules
 * (same constraint as tests/health-digest-render-pdf-signal.test.js) — the
 * rendering function under test is lifted out of the source and run in a vm,
 * with the real cron-gates.js (zero deps) required directly and injected in.
 *
 * Zero deps beyond cron-gates.js itself. Run: node tests/cron-gate-drift.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FN_DIR = path.join(ROOT, 'functions');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; fails.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

const { CRON_GATES, gateStatus } = require(path.join(FN_DIR, 'cron-gates.js'));

// ── Walk functions/ for every process.env.X_ENABLED / X_DISABLED read ──────
function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
}
const files = [];
walk(FN_DIR, files);

const foundNames = new Set();
const foundInFile = new Map(); // name -> Set<relative file path>
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /process\.env\.([A-Z_]+_(?:ENABLED|DISABLED))/g;
  let m;
  while ((m = re.exec(src))) {
    foundNames.add(m[1]);
    const rel = path.relative(FN_DIR, f);
    if (!foundInFile.has(m[1])) foundInFile.set(m[1], new Set());
    foundInFile.get(m[1]).add(rel);
  }
}

console.log('\nCRON GATE REGISTRY — functions/cron-gates.js vs. the real code\n');

const registryNames = new Set(CRON_GATES.map((g) => g.name));

const missingFromRegistry = [...foundNames].filter((n) => !registryNames.has(n));
ok('every gate the code actually checks is registered in cron-gates.js',
  missingFromRegistry.length === 0, JSON.stringify(missingFromRegistry));

const staleInRegistry = [...registryNames].filter((n) => !foundNames.has(n));
ok('every registered gate is actually checked by some function (no stale entries)',
  staleInRegistry.length === 0, JSON.stringify(staleInRegistry));

// 14 → 15 on 2026-09-30: JOBS_MIRROR_ENABLED (multi-job phase 1, ships off).
// 15 → 16 on 2026-10-01: MORNING_BRIEF_ENABLED (06:45 owner brief, ships off).
// 22 (2026-10-02): + AGENT_MCP_DISABLED, the Grok Bot team's CRM connection.
// 23 (2026-10-02): + CALL_WATCH_ENABLED, the every-2-hours call check.
// 24 since 2026-10-04: ESIGN_REMINDERS_DISABLED (esign-reminders.js).
ok('the registry has exactly 26 gates (update this pin deliberately if that changes)',
  CRON_GATES.length === 26, String(CRON_GATES.length));

for (const g of CRON_GATES) {
  const files2 = foundInFile.get(g.name);
  ok(`${g.name} is actually read in ${g.file}`,
    !!files2 && files2.has(g.file), files2 ? JSON.stringify([...files2]) : '(not found anywhere)');
}

// ── gateStatus() polarity handling ──────────────────────────────────────
console.log('\ngateStatus() — polarity');
{
  const enabledOff = gateStatus({}).find((g) => g.name === 'HEALTH_DIGEST_ENABLED');
  ok('an "enabled"-polarity gate defaults OFF when unset', enabledOff.on === false);
  const enabledOn = gateStatus({ HEALTH_DIGEST_ENABLED: 'true' }).find((g) => g.name === 'HEALTH_DIGEST_ENABLED');
  ok('...and ON when set to the literal string "true"', enabledOn.on === true);
  const enabledJunk = gateStatus({ HEALTH_DIGEST_ENABLED: 'yes' }).find((g) => g.name === 'HEALTH_DIGEST_ENABLED');
  ok('...but NOT on any other truthy-looking value (no silent typo-enable)', enabledJunk.on === false);

  const disabledOn = gateStatus({}).find((g) => g.name === 'MONTHLY_OVERHEAD_ALERT_DISABLED');
  ok('a "disabled"-polarity gate defaults ON (runs) when unset', disabledOn.on === true);
  const disabledOff = gateStatus({ MONTHLY_OVERHEAD_ALERT_DISABLED: 'true' }).find((g) => g.name === 'MONTHLY_OVERHEAD_ALERT_DISABLED');
  ok('...and OFF (skips) when set to the literal string "true"', disabledOff.on === false);
}

// ── health-digest.js's table actually renders what gateStatus() reports ──
console.log('\nhealth-digest.js renderCronGatesSection() — reflects live env, not a hardcoded table');
{
  const SRC = fs.readFileSync(path.join(FN_DIR, 'health-digest.js'), 'utf8');
  function extractFn(src, name) {
    const decl = src.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
    const start = src.indexOf(decl);
    if (start === -1) throw new Error(`extractFn: ${name} not found in health-digest.js`);
    const open = src.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    if (depth !== 0) throw new Error(`extractFn: unbalanced braces reading ${name}`);
    return src.slice(start, i);
  }

  ok('health-digest.js imports gateStatus from ./cron-gates (one source of truth, not a copy)',
    /require\(['"]\.\/cron-gates['"]\)/.test(SRC));

  const sandbox = { console, Object, Array, String, Number, Math, Date, Promise, Error, gateStatus };
  vm.createContext(sandbox);
  vm.runInContext(
    ['escHtml', 'renderCronGatesSection'].map((n) => extractFn(SRC, n)).join('\n') +
    '\nglobalThis.API = { renderCronGatesSection };',
    sandbox
  );
  const { renderCronGatesSection } = sandbox.API;

  function rowFor(html, name) {
    const m = new RegExp(name + '[\\s\\S]*?</tr>').exec(html);
    return m ? m[0] : '';
  }

  sandbox.process = { env: { HEALTH_DIGEST_ENABLED: 'true' } };
  const html = renderCronGatesSection();

  ok('all 12 gate names appear in the rendered table',
    CRON_GATES.every((g) => html.includes(g.name)));
  ok('the one gate turned on in this env renders ON',
    />ON</.test(rowFor(html, 'HEALTH_DIGEST_ENABLED')), rowFor(html, 'HEALTH_DIGEST_ENABLED'));
  ok('a gate NOT set in this env renders off, not ON',
    />off</.test(rowFor(html, 'REVIEW_NUDGE_ENABLED')));
  ok('the disabled-polarity gate with nothing set renders ON (it defaults to running)',
    />ON</.test(rowFor(html, 'MONTHLY_OVERHEAD_ALERT_DISABLED')));

  sandbox.process = { env: { MONTHLY_OVERHEAD_ALERT_DISABLED: 'true' } };
  const html2 = renderCronGatesSection();
  ok('...and flips to off once that env var is actually set — this reads live state, not a cached snapshot',
    />off</.test(rowFor(html2, 'MONTHLY_OVERHEAD_ALERT_DISABLED')));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFAILED:'); for (const f of fails) console.log('  - ' + f); process.exit(1); }
