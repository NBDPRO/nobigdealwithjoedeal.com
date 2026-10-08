/**
 * tests/widgets-no-fabricated-data.test.js — dashboard widgets must not invent
 * data.
 *
 * Two widgets rendered hardcoded numbers as if they were the tenant's:
 *
 *   team-leaderboard  "Joe Deal $48.5k / 12 deals", "Mike S. $32.1k",
 *                     "Sarah K. $27.8k" — comment: "Pull from leaderboard data
 *                     or simulate".
 *   material-watch    "OC Duration $98/sq +2%", "GAF Timberline $102/sq -1%",
 *                     "Synthetic Felt $67/roll", "Drip Edge 10ft $4.50/pc" —
 *                     comment: "Simulated price data — in production would
 *                     fetch from supplier API". There is no supplier API.
 *
 * Both are opt-in from an UNGATED picker, and a brand-new tenant staring at an
 * empty dashboard is precisely who browses the widget gallery for something to
 * fill it. He adds a leaderboard and finds a stranger named Joe Deal topping
 * HIS board.
 *
 * material-watch was the dangerous one: specific, authoritative-looking, and
 * directly ACTIONABLE. A roofer pricing a job off "$98/sq" for a shingle he
 * hasn't quoted loses real money on a real roof. It was removed rather than
 * given an empty state — a price watch that never has data is a permanently
 * broken tile. No widget beats a lying one.
 *
 * Zero deps.  Run: node tests/widgets-no-fabricated-data.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/widgets.js'), 'utf8');
const decomment = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const CODE = decomment(SRC);

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('WIDGETS — no invented numbers on a tenant dashboard');

// ── 1. The fabricated values are gone ─────────────────────────────────
{
  for (const lie of ['Mike S.', 'Sarah K.', '48500', '32100', '27800']) {
    ok(`no fabricated leaderboard value: ${lie}`, !CODE.includes(lie));
  }
  for (const lie of ['OC Duration', 'GAF Timberline', 'Synthetic Felt', 'Drip Edge',
                     '$98/sq', '$102/sq', '$67/roll', '$4.50/pc']) {
    ok(`no fabricated material price: ${lie}`, !CODE.includes(lie));
  }
  // The generic tell — a widget that admits it's making data up.
  ok('no widget still says it simulates data',
    !/or simulate|Simulated price/i.test(CODE));
}

// ── 2. The leaderboard reads REAL leads ───────────────────────────────
{
  const w = CODE.slice(CODE.indexOf("{id:'team-leaderboard'"), CODE.indexOf("{id:'quick-add-lead'"));
  ok('team-leaderboard still exists', w.length > 0);
  ok('it aggregates from window._leads', /window\._leads \|\| \[\]/.test(w));
  ok('it excludes soft-deleted leads', /!l\.deleted/.test(w));
  ok('it counts won by stage ROLE, not a hardcoded name list',
    /role === 'won' \|\| role === 'job'/.test(w),
    'a name list misses custom pipelines');
  // Through the ONE money reader since review R2 (2026-10-06): '$45,000' is 45000.
  ok('it sums the canonical money field (jobValue)', /_wgMoney\(l\.jobValue\)/.test(w));
  ok('it shows an honest empty state with no closed jobs',
    /No closed jobs yet/.test(w));
  ok('it never invents a person for an unnamed rep',
    /'Teammate'/.test(w) && !/Joe Deal/.test(w));
  // The name now comes from lead data / the signed-in user — an innerHTML sink
  // that previously only ever held constants.
  ok('the rep name is escaped before innerHTML', /\$\{esc\(r\.name\)\}/.test(w),
    'repName is user-supplied; this template did not escape when it held constants');
}

// ── 3. material-watch is gone, cleanly ────────────────────────────────
{
  ok('material-watch is no longer a registered widget',
    !/\{id:'material-watch'/.test(CODE));
  ok('its stale nav-map entry is gone too',
    !/'material-watch':/.test(CODE));
  // A saved dashboard may still list the id — that must degrade, not throw.
  ok('an unknown saved widget id is skipped, not rendered',
    /const w = WIDGETS\.find\(x => x\.id === id\);\s*if\(!w\) return;/.test(CODE),
    'existing users may have material-watch saved in their layout');
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
