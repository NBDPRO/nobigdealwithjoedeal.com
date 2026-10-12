/**
 * tests/layout-focus-2026-10-11.test.js — L03 Focus Mode (D4): the ranking
 * and the "Why now" rule table (pure, require()'d), plus the contract the E2E
 * can't see.
 *
 *   1. ranking: soon-appointment > promised > overdue task > urgent call >
 *      missed call > texted > task due today > opened estimate > stalled
 *      follow-up (most late first) > quiet estimate; a person appears once
 *   2. why-now wording per rule, and the drafted text per rule: plain, no
 *      insurance / claim / price / outcome words; passes the claim-wording filter
 *   3. nothing is sent (Text is an sms: link with the draft; the rep presses
 *      Send); Done only writes through NBDTasks.setDone and the button label
 *      says "Next" when nothing was written
 *   4. css is scoped, tokens-only, and glass only behind the My Skin class
 *
 * Run: node tests/layout-focus-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const F = require(path.join(ROOT, 'docs/pro/js/layouts/focus.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const CW = require(path.join(ROOT, 'docs/pro/js/claim-wording-filter.js'));
const SRC = read('docs/pro/js/layouts/focus.js');
const NOW = Date.UTC(2026, 9, 12, 15, 0, 0);

const plan = {
  appointments: [
    { key: 'appt:late', leadId: 'A2', name: 'Far Away', sortMs: NOW + 8 * 3600000, timeLabel: '11 PM' },
    { key: 'appt:soon', leadId: 'A1', name: 'Soon Sam', sortMs: NOW + 40 * 60000, timeLabel: '3:40 PM', address: '1 Elm St' },
  ],
  promised: [
    { key: 'lead:P2', leadId: 'P2', name: 'Task Tia', tasks: [{ id: 't', text: 'Send photos' }], overdue: false, promises: [] },
    { key: 'lead:P1', leadId: 'P1', name: 'Promise Pat', tasks: [], overdue: false, promises: ['Call back with a time Thursday'] },
    { key: 'lead:P3', leadId: 'P3', name: 'Late Lou', tasks: [{ id: 'u', text: 'Drop off sample' }], overdue: true, promises: [] },
  ],
  calls: [
    { key: 'c:text', leadId: 'C3', name: 'Text Tom', text: true, latestMs: NOW - 3600000, summary: 'Can you come Friday?', count: 1 },
    { key: 'c:miss', leadId: 'C2', name: 'Missed Mia', missed: true, latestMs: NOW - 2 * 3600000, count: 3 },
    { key: 'c:urg', leadId: 'C1', name: 'Urgent Uma', urgent: true, summary: 'Water coming in', count: 1 },
  ],
  estimates: [
    { key: 'est:q', leadId: 'E2', name: 'Quiet Quinn', daysOut: 9, opened: false },
    { key: 'est:o', leadId: 'E1', name: 'Opened Olly', daysOut: 3, opened: true, openedLabel: 'twice today' },
  ],
  stalled: [
    { key: 'fu:1', leadId: 'S1', name: 'Slow Stu', daysLate: 2 },
    { key: 'fu:2', leadId: 'S2', name: 'Slower Sid', daysLate: 11 },
  ],
};

console.log('\n1. ranking');
{
  const q = F.buildQueue(plan, NOW);
  const order = q.map((r) => r.key).join(' ');
  ok('the whole plan is ranked in the stated order',
    order === 'appt:soon lead:P1 lead:P3 c:urg c:miss c:text lead:P2 est:o fu:2 fu:1 est:q appt:late',
    order);
  ok('a far-off appointment ranks last, not first', q[q.length - 1].key === 'appt:late');
  const dup = F.buildQueue({ calls: [{ key: 'a', leadId: 'X', name: 'X', missed: true }], stalled: [{ key: 'b', leadId: 'X', name: 'X', daysLate: 4 }] }, NOW);
  ok('a person appears once even if two sections name them', dup.length === 1 && dup[0].key === 'a');
  ok('an empty / missing plan is an empty queue', F.buildQueue(null, NOW).length === 0 && F.buildQueue({}, NOW).length === 0);
  ok('the ranking never mutates the plan rows', plan.calls[0].rank === undefined && plan.stalled[0].why === undefined);
}

console.log('\n2. why now + drafts');
{
  const q = F.buildQueue(plan, NOW);
  const by = (k) => q.filter((r) => r.key === k)[0];
  ok('promised quotes what was promised', by('lead:P1').why === 'You promised: Call back with a time Thursday');
  ok('overdue task', by('lead:P3').why === 'Overdue: Drop off sample');
  ok('urgent call carries its summary', by('c:urg').why === 'Marked urgent: Water coming in');
  ok('missed call says how long and how many tries', by('c:miss').why === 'Missed call · 2 hours ago · 3 tries');
  ok('a text says when and what', by('c:text').why === 'Texted you 1 hour ago: Can you come Friday?');
  ok('opened estimate', by('est:o').why === 'Opened your estimate twice today');
  ok('stalled follow-up by days late', by('fu:2').why === 'Follow-up was due 11 days ago' && F.whyNow({ kind: 'stalled', daysLate: 0 }, NOW) === 'Follow-up is due today');
  ok('quiet estimate is stated as a fact, not a prediction', by('est:q').why === 'Estimate went out 9 days ago; no answer yet');
  ok('appointment shows its time and address', by('appt:soon').why === 'Appointment 3:40 PM · 1 Elm St');
  ok('unknown rows get a safe default', F.whyNow({ kind: 'mystery' }, NOW) === 'On your list today');
  ok('long summaries are clipped', F.whyNow({ kind: 'call', urgent: true, summary: 'x'.repeat(300) }, NOW).length < 120);

  const drafts = q.map((r) => F.draftFor(r, NOW));
  ok('every draft is a short greeting by first name', drafts.every((d) => /^Hi \w+, /.test(d) && d.length < 140), drafts.join(' | '));
  ok('no draft mentions insurance, claims, price, cost, deductible or outcomes',
    drafts.every((d) => !/\b(insur\w*|claim\w*|adjuster|deductible|price|cost|\$\d|free|guarantee\w*|approved|covered)\b/i.test(d)));
  ok('every why-now line and draft passes the claim-wording filter',
    q.every((r) => CW.scanText(r.why).length === 0) && drafts.every((d) => CW.scanText(d).length === 0));
  ok('control: the filter can fail on a claim-handling draft', CW.scanText('Hi Pat, we will handle your insurance claim for you.').length > 0);
  ok('a nameless lead gets a greeting without a stray comma', /^Hi, /.test(F.draftFor({ kind: 'stalled', name: '' }, NOW)));
}

console.log('\n3. nothing is sent');
{
  const code = strip(SRC);
  ok('Text is an sms: link carrying the draft; no send call', /K\.smsUrl/.test(code) && /body=/.test(code)
    && !/\b(sendSms|sendText|sendEmail|NBDSmsOutbox|callable\()/.test(code));
  ok('Done writes only through NBDTasks.setDone, and only for a promised (task-backed) row', /T\.setDone\(r\.leadId, t\.id\)/.test(code) && /r\.kind === 'promised' && r\.tasks/.test(code));
  ok('other rows are set aside locally and the button says "Next"', /doneLbl = r\.kind === 'promised' \? 'Done · Next' : 'Next'/.test(code) && /It was not changed in the CRM|were not changed in the CRM/.test(SRC));
  ok('snooze is the CRM\'s own modal', /LeadSnooze\.prompt/.test(code));
  ok('the queue comes from NBDToday.compute (no second data load, no cost fields)', /NBDToday\.compute/.test(code) && !/\b(cost|margin|markup)\w*/i.test(code));
  ok('keys ignore inputs and modifier combos', /tag === 'INPUT'/.test(code) && /ev\.metaKey \|\| ev\.ctrlKey \|\| ev\.altKey/.test(code));
}

console.log('\n4. registration + css');
{
  const d = R.get('focus');
  ok('registered for every surface with lazy assets + kit', d && d.surfaces.length === 3 && d.script === 'js/layouts/focus.js' && d.css === 'css/layouts/focus.css' && d.needs.script[0] === 'js/layouts/kit.js');
  ok('assets exist on disk', fs.existsSync(path.join(ROOT, 'docs/pro', d.script)) && fs.existsSync(path.join(ROOT, 'docs/pro', d.css)));
  ok('a rep on any screen who chose it gets it', ['phone', 'tablet', 'desktop'].every((s) => R.resolve({ surface: s, user: { byDevice: { [s]: 'focus' } } }).id === 'focus'));
  const css = strip(read('docs/pro/css/layouts/focus.css'));
  const sels = css.split('}').map((r) => r.split('{')[0].trim()).filter(Boolean).filter((s) => !/^@media/.test(s));
  ok('every rule is scoped under html[data-layout="focus"]', sels.every((s) => /^html\[data-layout="focus"\]/.test(s)), sels.filter((s) => !/^html\[data-layout="focus"\]/.test(s)).join(' | '));
  ok('no hard-coded colours except white-on-accent and shadows', !/#[0-9a-f]{3,8}\b/i.test(css.replace(/var\(--accent-fg,\s*#fff\)/g, '')));
  ok('glass is only behind the My Skin wallpaper class', (css.match(/backdrop-filter/g) || []).length === 2 && /my-skin-wallpaper \.fo-card\s*\{[^}]*backdrop-filter/.test(css));
  ok('actions are tap-sized by token', /min-height:\s*calc\(var\(--tap\)/.test(css));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
