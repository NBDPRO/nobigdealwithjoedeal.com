/**
 * tests/prospects-followup-age-2026-11-08.test.js — CRM audit 2026-11-06, VW-F02.
 *
 * Prospects lit '⏰ Due' only the day AFTER a follow-up was due (it compared
 * against the follow-up day's 23:59:59) and never said how late it was, while
 * the pipeline's 'N Follow-ups Due' banner already counted a due-today one.
 * Now isFollowUpDue is the local-day rule (today or earlier, as the pipeline
 * card chip uses) and the chips print 'Due today' / 'N day(s) overdue'.
 * Zero deps. Run: node tests/prospects-followup-age-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');
function block(src, start) {
  const s = src.indexOf(start);
  if (s < 0) return '';
  const indent = start.match(/^\s*/)[0];
  const e = src.indexOf('\n' + indent + '}\n', s);
  return e < 0 ? '' : src.slice(s, e + indent.length + 3);
}

// Fixed local "now": 2026-11-08 10:00 local, whatever the TZ.
const NOW = new Date(2026, 10, 8, 10, 0).getTime();
class FixedDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
function ymd(offsetDays) {
  const d = new Date(NOW); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offsetDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const prospects = read('prospects.js');
const pipeline = read('crm-pipeline.js');
const fns = ['  function isFollowUpDue(lead) {', '  function followUpDaysLate(lead) {', '  function followUpDueText(lead) {']
  .map(s => block(prospects, s));
const pipeDay = block(pipeline, 'function _followUpDay(');

function sandbox(withShared) {
  const sb = { Date: FixedDate, Math, isNaN, String, window: {} };
  vm.createContext(sb);
  vm.runInContext(pipeDay + '\n' + (withShared ? 'window.nbdFollowUpDay = _followUpDay;\n' : '') +
    fns.join('\n') + '\nglobalThis.__due = typeof isFollowUpDue === "function" ? isFollowUpDue : null;' +
    '\nglobalThis.__late = typeof followUpDaysLate === "function" ? followUpDaysLate : null;' +
    '\nglobalThis.__text = typeof followUpDueText === "function" ? followUpDueText : null;' +
    '\nglobalThis.__pipeDay = _followUpDay;', sb);
  return sb;
}

console.log('PROSPECT FOLLOW-UP DUE (VW-F02)');
ok('isFollowUpDue found (positive control)', fns[0].length > 40);
ok('_followUpDay lifted from crm-pipeline.js (positive control)', pipeDay.length > 40);
ok('followUpDaysLate exists in prospects.js', fns[1].length > 40);
ok('followUpDueText exists in prospects.js', fns[2].length > 40);

for (const withShared of [true, false]) {
  const label = withShared ? ' (shared nbdFollowUpDay)' : ' (local fallback)';
  let sb;
  try { sb = sandbox(withShared); } catch (e) { ok('sandbox runs' + label, false, e.message); continue; }
  const due = (v) => sb.__due({ followUp: v });
  ok('a follow-up due TODAY is due' + label, due(ymd(0)) === true, String(due(ymd(0))));
  ok('yesterday is due' + label, due(ymd(-1)) === true);
  ok('tomorrow is not due' + label, due(ymd(1)) === false);
  ok('blank / missing / garbage stays not due' + label,
    due('') === false && due(undefined) === false && due('garbage') === false, [due(''), due(undefined), due('garbage')].join(','));
  const start = new FixedDate(); start.setHours(0, 0, 0, 0);
  let parity = true;
  for (let o = -3; o <= 3; o++) {
    const v = ymd(o);
    if (due(v) !== (sb.__pipeDay(v) <= start)) parity = false;
  }
  ok('matches the pipeline card rule for -3..+3 days' + label, parity);
  if (sb.__late && sb.__text) {
    ok('daysLate: null for blank/garbage, 0 today, 3 three days late' + label,
      sb.__late({ followUp: '' }) === null && sb.__late({ followUp: 'garbage' }) === null &&
      sb.__late({ followUp: ymd(0) }) === 0 && sb.__late({ followUp: ymd(-3) }) === 3);
    ok('text: Due today / 1 day overdue / 3 days overdue' + label,
      sb.__text({ followUp: ymd(0) }) === 'Due today' && sb.__text({ followUp: ymd(-1) }) === '1 day overdue' &&
      sb.__text({ followUp: ymd(-3) }) === '3 days overdue',
      [sb.__text({ followUp: ymd(0) }), sb.__text({ followUp: ymd(-1) }), sb.__text({ followUp: ymd(-3) })].join(' | '));
  } else {
    ok('daysLate / text helpers callable' + label, false);
  }
}

console.log('PROSPECT FOLLOW-UP CHIPS (VW-F02 source pins)');
{
  const card = block(prospects, '  function renderCard(p) {');
  const row = block(prospects, '  function renderRow(p) {');
  ok('renderCard / renderRow found (positive control)', card.length > 200 && row.length > 200);
  ok('card chip no longer prints a bare "⏰ Due"', !card.includes('⏰ Due</span>'));
  ok('row chip no longer prints a bare "⏰ Follow-up due"', !row.includes('⏰ Follow-up due</span>'));
  ok('card and row print followUpDueText', /followUpDueText\(p\)/.test(card) && /followUpDueText\(p\)/.test(row));
  ok('the "Follow-up due" filter still uses isFollowUpDue', /list\s*=\s*list\.filter\(isFollowUpDue\)/.test(prospects));
  ok('nav badge title says due, not overdue', /follow-up' \+ \(overdue === 1 \? '' : 's'\) \+ ' due'/.test(prospects) &&
    !/follow-up' \+ \(overdue === 1 \? '' : 's'\) \+ ' overdue'/.test(prospects));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
