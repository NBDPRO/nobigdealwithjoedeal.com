/**
 * tests/local-date-display-2026-09-29.test.js
 *
 * A bare 'YYYY-MM-DD' (a lead's scheduledDate, a deal's install date) is a
 * LOCAL calendar day. `new Date('2026-10-06')` parses it as UTC midnight, which
 * in Eastern time is the evening of Oct 5 — so three screens printed the
 * install / completion date a day early:
 *   - Close Board deal card        (close-board.js fmtDate)
 *   - Warranty certificate         (customer-bootstrap.module.js)
 *   - Generated documents' "Scheduled" row (document-generator.js toDate)
 * Found by the calendar Phase 0 build (2026-09-29).
 *
 * The real functions are lifted out of the source and run in a child Node
 * process pinned to America/New_York — the bug only exists west of UTC, so a
 * UTC CI runner would pass with it present.
 *
 * Run: node tests/local-date-display-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

// Balanced-brace slice from `start` (the index of a `{`).
function block(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

const close = read('docs/pro/js/close-board.js');
const cs = close.indexOf('function fmtDate(d)');
const closeFn = close.slice(cs, cs + 'function fmtDate(d) '.length) + block(close, close.indexOf('{', cs));

const gen = read('docs/pro/js/document-generator.js');
const gs = gen.indexOf('const toDate = (d) =>');
const genFn = gen.slice(gs, gen.indexOf('{', gs)) + block(gen, gen.indexOf('{', gs)) + ';';

const boot = read('docs/pro/js/customer-bootstrap.module.js');
const bs = boot.indexOf('const _now = new Date();');
const be = boot.indexOf('\n', boot.indexOf('const installDay'));
const bootSnippet = bs > -1 && be > bs ? boot.slice(bs, be) : '';

const probe = `
  'use strict';
  const out = {};
  ${closeFn.replace('function fmtDate', 'function closeFmt')}
  out.close = closeFmt('2026-10-06');
  out.closeTs = closeFmt('2026-10-06T15:00:00Z');
  ${genFn.replace('const toDate', 'const genToDate')}
  out.gen = genToDate('2026-10-06').toDateString();
  out.genNull = genToDate('') === null && genToDate('not a date') === null;
  function cert(lead) { ${bootSnippet}; return installDay; }
  out.cert = cert({ scheduledDate: '2026-10-06' }).toDateString();
  const t = cert({}); const n = new Date();
  out.certToday = t.getFullYear() === n.getFullYear() && t.getMonth() === n.getMonth() && t.getDate() === n.getDate();
  out.naive = new Date('2026-10-06').toDateString();
  process.stdout.write(JSON.stringify(out));
`;

console.log('\nEastern time (America/New_York)');
ok('the certificate snippet was found in the source', !!bootSnippet);
let r = {};
try {
  r = JSON.parse(execFileSync(process.execPath, ['-e', probe], { env: Object.assign({}, process.env, { TZ: 'America/New_York' }) }).toString());
} catch (e) { ok('probe ran', false, e.message.slice(0, 300)); }
ok('control: the naive parse really is a day early in New York (the bug is reproducible here)', r.naive === 'Mon Oct 05 2026', r.naive);
ok('Close Board shows the install date on its own day', r.close === 'Oct 6, 2026', r.close);
ok('Close Board still formats full timestamps', r.closeTs === 'Oct 6, 2026', r.closeTs);
ok('documents\' "Scheduled" row lands on the day itself', r.gen === 'Tue Oct 06 2026', r.gen);
ok('documents: empty and junk still come back null', r.genNull === true);
ok('warranty certificate completion date is the day itself', r.cert === 'Tue Oct 06 2026', r.cert);
ok('warranty with no date falls back to TODAY here, not tomorrow-in-UTC', r.certToday === true);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
