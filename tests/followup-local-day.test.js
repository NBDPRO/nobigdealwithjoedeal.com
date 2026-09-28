/**
 * followup-local-day.test.js — a follow-up date is a LOCAL calendar day.
 *
 * followUp is stored 'YYYY-MM-DD' (an <input type="date"> value). new Date()
 * parses that as UTC midnight, which in any US time zone is the previous
 * evening — so every follow-up read as due a day early: the pipeline banner,
 * the card badge and the "Overdue Follow-Up" bell notifications
 * (2026-09-28 sweep, R5-12).
 *
 * Behavioral: runs crm-pipeline.js's _followUpDay / _followUpDueText, lifted
 * from source, under TZ=America/New_York.
 *
 * Run: node tests/followup-local-day.test.js
 */
'use strict';

process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'crm-pipeline.js'), 'utf8');
function lift(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return '';
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(lift('_followUpDay') + '\n' + lift('_followUpDueText') + '\nthis.D=_followUpDay; this.T=_followUpDueText;', ctx);

console.log('\nfollow-up dates are local days (TZ=America/New_York)\n');

ok('the helpers exist in crm-pipeline.js', typeof ctx.D === 'function' && typeof ctx.T === 'function');

const d = ctx.D('2026-09-29');
ok("'2026-09-29' is Sep 29 local, not Sep 28 (UTC parse)",
  d.getFullYear() === 2026 && d.getMonth() === 8 && d.getDate() === 29,
  'got ' + d.toString());
ok('…at local midnight', d.getHours() === 0 && d.getMinutes() === 0);
ok('the naive parse this replaced really is a day early here (control)',
  new Date('2026-09-29').getDate() === 28);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (dt) => dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
const today = new Date(); today.setHours(0, 0, 0, 0);
const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
const threeAgo = new Date(today); threeAgo.setDate(today.getDate() - 3);

ok('today reads "Due today"', ctx.T(ymd(today)) === 'Due today', ctx.T(ymd(today)));
ok('tomorrow is not due yet', /^Due [A-Z][a-z]{2} \d{1,2}$/.test(ctx.T(ymd(tomorrow))), ctx.T(ymd(tomorrow)));
ok('three days ago reads "3 days overdue"', ctx.T(ymd(threeAgo)) === '3 days overdue', ctx.T(ymd(threeAgo)));
ok('a full timestamp still parses', !isNaN(ctx.D('2026-09-29T15:00:00Z')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
