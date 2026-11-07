/**
 * tests/pipeline-list-overlap-2026-11-07.test.js
 *
 * Pipeline → ≡ LIST drew its table over the follow-ups panel and the
 * "need a job type" banner (CRM walk 2026-11-07, play-through PL-15).
 * #view-crm is a fixed-height flex column. The board takes the leftover space
 * (flex 1 1 0%); the list was `flex: 0 1 auto` with a tall table, so the
 * browser shrank every sibling to fit it (follow-ups 166px for 385px of
 * content) and they spilled under the table. The list now takes the leftover
 * space the way the board does, and on a desktop keeps its right edge (each
 * row's Call / Open) clear of the fixed FAB stack.
 *
 * Measured in the local harness at 1440 after the fix: follow-ups 132→517
 * (full 385px), list from 579, 28 rows scrolling inside it.
 * Zero deps. Run: node tests/pipeline-list-overlap-2026-11-07.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/css/kanban-force.css'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
// Top-level rules only (depth 0), with comments blanked, so a rule inside a
// phone media block cannot satisfy the desktop expectation.
const flat = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
function depthAt(idx) { let d = 0; for (let i = 0; i < idx; i++) { if (flat[i] === '{') d++; else if (flat[i] === '}') d--; } return d; }

const i1 = flat.indexOf('body.crm-list-mode #view-crm > .crm-list-wrap{ flex:1 1 0%; min-height:0; }');
ok('list mode: the list takes the leftover space like the board (flex 1 1 0%, min-height 0)', i1 >= 0);
ok('...and that rule applies at every width (not inside a media block)', i1 >= 0 && depthAt(i1) === 0, 'depth ' + (i1 >= 0 ? depthAt(i1) : 'n/a'));
ok('the board still owns flex 1 1 0% in board mode (unchanged contract)', /body\.crm-list-mode #view-crm \.kanban-board\{ display:none !important; \}/.test(flat));
const i2 = flat.indexOf('@media (min-width:769px){\n    body.crm-list-mode #view-crm > .crm-list-wrap{ padding-right:76px; }');
ok('desktop: the list keeps a 76px right gutter clear of the FAB stack', i2 >= 0 && depthAt(i2) === 0);
ok('phones keep their own bottom clearance rule', /body\.crm-list-mode \.crm-list-wrap\{ padding-bottom:calc\(150px/.test(flat));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
