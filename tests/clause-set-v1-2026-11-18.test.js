/**
 * clause-set-v1-2026-11-18.test.js — phase 2 of the template/liability overhaul: the clause set
 * printed on the contract-class signing paths, behind the per-user flag docClauseSetV1 (default OFF).
 * See documentation/projects/CLAUSE-SET-V1-2026-11-18.md.
 *
 *   A. flag OFF is byte-identical to today (golden hashes recorded from origin/main before any
 *      renderer changed: client contract / proposal / work authorization HTML, the server e-sign PDF)
 *   ...later sections are added with each step.
 *
 * Run: node tests/clause-set-v1-2026-11-18.test.js   (needs functions/node_modules for pdf-lib)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const H = require('./helpers/clause-v1-harness');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  section('A. flag OFF is byte-identical to the render recorded before phase 2');
  {
    const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'clause-set-v1-golden.json'), 'utf8'));
    const now = await H.goldens();
    ok('the golden fixture covers six contract variants, two proposals, two work authorizations and three PDFs',
      Object.keys(golden).length === 13, String(Object.keys(golden).length));
    Object.keys(golden).forEach((k) => ok('flag off: ' + k + ' is byte-identical to origin/main', now[k] === golden[k], String(now[k]).slice(0, 12) + ' vs ' + String(golden[k]).slice(0, 12)));
    // A flag that is explicitly false, or absent, is the same as off.
    const envOff = H.docs({ flags: { docClauseSetV1: false } });
    ok('flag explicitly false: contract unchanged', H.sha(H.render(envOff, 'renderContract', H.VARIANTS.ky_cash)) === golden['contract.ky_cash']);
    // The other flag alone changes nothing in the rendered text either.
    const envEv = H.docs({ flags: { docEvidenceFoundation: true } });
    ok('docEvidenceFoundation on, docClauseSetV1 off: contract unchanged', H.sha(H.render(envEv, 'renderContract', H.VARIANTS.oh_cash)) === golden['contract.oh_cash']);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
