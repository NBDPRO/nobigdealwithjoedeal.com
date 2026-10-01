/**
 * tests/invoice-reminder-2026-10-01.test.js
 *
 * One-tap overdue-invoice reminder (docs/pro/js/invoice-reminder.js), from
 * Jo's idea triage — built Jo's way: the rep sees and edits the message and
 * taps Send; nothing reaches a homeowner on its own. A Kentucky insurance job
 * inside its post-decision window is refused (no payment request yet).
 *
 * Run: node tests/invoice-reminder-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const R = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'invoice-reminder.js'));
const K = require(path.join(__dirname, '..', 'docs', 'pro', 'js', 'ky-insurance-law.js'));
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const NOW = new Date('2026-10-01T15:00:00Z');
const inv = (o) => Object.assign({ nbdInvoiceNumber: 'NBD-500-0042', total: 1450, balanceDue: 1450, dueDate: new Date('2026-09-15T12:00:00Z'), status: 'sent',
  customerName: 'Pat Q', customerPhone: '5135550142', customerEmail: 'pat@example.test', stripePaymentLink: 'https://buy.stripe.com/test_abc' }, o || {});
const ohLead = { firstName: 'Pat', address: '12 Main St, Milford, OH 45150', jobType: 'cash' };
const opts = (o) => Object.assign({ company: 'No Big Deal Home Solutions', repName: 'Joe', now: NOW, holdFn: (l, i, n) => K.payLinkHold(l, i, n) }, o || {});

console.log('\n1. the message');
{
  const r = R.buildReminder(inv(), ohLead, opts());
  ok('greets by first name, names the invoice, balance and due date, signs off', /^Hi Pat, a friendly reminder from No Big Deal Home Solutions: invoice NBD-500-0042 for \$1,450\.00 was due Sep 15\./.test(r.text) && /Thanks, Joe$/.test(r.text), r.text);
  ok('includes the pay link when one exists', /You can pay here: https:\/\/buy\.stripe\.com\/test_abc/.test(r.text));
  ok('no link on the invoice → "reply here" instead of a dangling "pay here:"', !/pay here/.test(R.buildReminder(inv({ stripePaymentLink: '' }), ohLead, opts()).text));
  ok('16 days overdue, allowed, recipients from the invoice', r.daysPastDue === 16 && r.allowed && r.to.phone === '5135550142' && r.to.email === 'pat@example.test');
  ok('uses the balance due, not the total, after a partial payment', /\$400\.00/.test(R.buildReminder(inv({ balanceDue: 400 }), ohLead, opts()).text));
}

console.log('\n2. when it must NOT go');
{
  const kyLead = { firstName: 'Kim', address: '9 Dixie Hwy, Florence, KY 41042', jobType: 'insurance', claimNumber: 'C-1' };
  const held = R.buildReminder(inv(), kyLead, opts());
  ok('a Kentucky insurance job with no carrier decision yet is HELD → not allowed, and no pay link in the text', held.held === true && held.allowed === false && !/stripe/.test(held.text));
  const released = R.buildReminder(inv(), Object.assign({}, kyLead, { carrierDecisionAt: '2026-08-01' }), opts());
  ok('…the same job after its window has run → allowed again', released.held === false && released.allowed === true);
  ok('paid, void or zero balance → not allowed', !R.buildReminder(inv({ status: 'paid' }), ohLead, opts()).allowed
    && !R.buildReminder(inv({ status: 'void' }), ohLead, opts()).allowed && !R.buildReminder(inv({ balanceDue: 0, total: 0 }), ohLead, opts()).allowed);
}

console.log('\n3. no nagging');
{
  const recent = R.buildReminder(inv({ lastReminderAt: new Date('2026-09-30T15:00:00Z'), reminderCount: 2 }), ohLead, opts());
  ok('reminded yesterday → tooSoon (the sheet warns, the rep can still send)', recent.tooSoon === true && recent.reminderCount === 2 && recent.allowed === true);
  ok('reminded 5 days ago → not too soon', R.buildReminder(inv({ lastReminderAt: { seconds: Date.parse('2026-09-26T15:00:00Z') / 1000 } }), ohLead, opts()).tooSoon === false);
}

console.log('\n4. wiring');
{
  const src = read('docs/pro/js/invoice-reminder.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  ok('a held invoice is refused before any sheet opens', /if \(r\.held\) \{ toast\(/.test(src) && src.indexOf('if (r.held)') < src.indexOf("createElement('div')"));
  ok('every value in the sheet is escaped', !/\+ r\.text \+|\+ r\.to\.phone \+|\+ inv\.\w+ \+/.test(src) && /esc\(r\.text\)/.test(src));
  ok('the invoice records a reminder only on a real send (not the mail-app fallback, not an offline queue)',
    /delivered = e\.mode !== 'mailto';/.test(src) && /queued = s\.mode === 'queued'; delivered = !queued;/.test(src) && /if \(delivered\) \{[\s\S]{0,120}lastReminderAt: new Date\(\)/.test(src));
  ok('emails are transactional invoice mail (kind: invoice)', /kind: 'invoice'/.test(src));
  const md = read('docs/pro/js/money-dashboard.js');
  ok('the Collections queue offers Remind (data-action module → NBDInvoiceReminder.open) and shows "reminded Nd ago"',
    /data-target="NBDInvoiceReminder\.open"/.test(md) && /reminded ' \+ \(remDays === 0 \? 'today'/.test(md) && /lastReminderAt: inv\.lastReminderAt \|\| null/.test(md));
  ok('the money bundle loads it before money-dashboard', /'js\/invoice-reminder\.js\?v=\d+',\s*'js\/money-dashboard\.js\?v=\d+'/.test(read('docs/pro/js/script-loader.js')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
