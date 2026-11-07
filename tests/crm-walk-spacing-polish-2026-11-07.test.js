/**
 * tests/crm-walk-spacing-polish-2026-11-07.test.js
 *
 * Three spacing / sizing fixes from the 2026-11-07 CRM layout walk, each
 * measured in the local harness before and after:
 *  1. Pipeline at phone width: the search box was 33px tall beside the 44px
 *     "All Types" filter on the same row (centres 6px apart). Now 44px; same
 *     row, so the header gets no taller (phone-pipeline.spec.js pipeline#7).
 *  2. Schedule → Calendar at phone width: the ~300px toolbar squeezed the
 *     title beside the arrows ("Nov 2 –" / "2026") and dropped Today under
 *     them. The title now has its own row; the buttons share the next.
 *  3. Focus layout Home: the stops strip touched the pill row, the Start
 *     button sat on the left edge (align-self in a block parent) and touched
 *     the Cash strip. The column now has one 12px rhythm and the queue centres
 *     its button.
 * Zero deps. Run: node tests/crm-walk-spacing-polish-2026-11-07.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function blockOf(css, at) {
  // the text of the @media block that contains index `at`
  let d = 0, start = -1;
  for (let i = at; i >= 0; i--) { if (css[i] === '}') d++; else if (css[i] === '{') { if (d === 0) { start = css.lastIndexOf('@media', i); break; } d--; } }
  return start >= 0 ? css.slice(start, css.indexOf('{', start)) : '';
}

const app = read('docs/pro/css/dashboard-app.css');
const i = app.indexOf('#crmSearch.crm-hdr-input{ min-height:44px!important; }');
ok('1. phone pipeline search is 44px tall', i >= 0);
ok('1. ...only on phones (inside the max-width:768px block)', i >= 0 && /max-width:\s*768px/.test(blockOf(app, i)), blockOf(app, i));

const sc = read('docs/pro/css/schedule-calendar.css');
const j = sc.indexOf('.sc2-host .ec-toolbar { flex-wrap: wrap;');
ok('2. calendar toolbar wraps on phones', j >= 0 && /max-width:\s*600px/.test(blockOf(sc, j)));
ok('2. the title takes its own full row first', /\.sc2-host \.ec-toolbar > \.ec-center \{ order: -1; flex: 1 1 100%; text-align: center; \}/.test(sc));
ok('2. the buttons stay on one line', /\.sc2-host \.ec-toolbar > \.ec-start,\n\s*\.sc2-host \.ec-toolbar > \.ec-start \.ec-button-group \{ flex-wrap: nowrap; white-space: nowrap; \}/.test(sc));

const fo = read('docs/pro/css/layouts/focus.css');
ok('3. Focus column has one 12px gap between blocks', /html\[data-layout="focus"\] \.fo-wrap \{[^}]*display: flex; flex-direction: column;[^}]*gap: 12px;/.test(fo));
ok('3. the queue is a centred column so Start sits under the count', /html\[data-layout="focus"\] \.fo-queue \{ display: flex; flex-direction: column; align-items: center; \}/.test(fo));
ok('3. the queue\'s lines still span the column', /html\[data-layout="focus"\] \.fo-queue \.fo-lines \{ align-self: stretch; \}/.test(fo));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
